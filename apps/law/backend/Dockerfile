# The law backend image: build the workspace in one stage, run the
# esbuild bundle in a bare node stage. The runtime image carries the
# backend's dist/ — bundle, migrations, and the web app's SPA build at
# public/ (T04b D1) — and no node_modules (see backend/build.mjs for why
# the bundle, not tsc output).
#
# BUILD CONTEXT IS THE REPO ROOT (CI's image job builds
# `-f apps/law/backend/Dockerfile` from the root). The context must span
# the npm workspace: `npm ci` needs every workspace manifest, and the
# bundle inlines @stigmer/resource-api and @stigmer/identity from source.
#
# Base is the ECR mirror, not docker.io, to stay clear of Docker Hub
# rate limits in CI (same choice as the other Stigmer images).
FROM public.ecr.aws/docker/library/node:22-alpine AS build

WORKDIR /app

# The web workspace depends on @playwright/test, whose install step
# downloads a browser by default. The image never runs E2E, so skip the
# download — without this the dependency layer grows by a Chromium.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Manifests first so the dependency layer caches across source changes.
# npm ci needs EVERY workspace manifest (the lockfile spans the whole
# workspace).
COPY package.json package-lock.json ./
COPY packages/resource-api/package.json packages/resource-api/
COPY packages/identity/package.json packages/identity/
COPY apps/law/backend/package.json apps/law/backend/
COPY apps/law/web/package.json apps/law/web/
RUN npm ci

# Sources, copied per-workspace so a chart or proto-only change does not
# bust this layer. Codegen output is committed (DD-A3), so no buf here.
COPY tsconfig.base.json ./
COPY packages/resource-api/ packages/resource-api/
COPY packages/identity/ packages/identity/
COPY apps/law/web/ apps/law/web/
COPY apps/law/backend/ apps/law/backend/

# The root build order is load-bearing: commons before identity before
# web before backend — workspace links point at dist/, and the backend's
# build.mjs copies the web build to dist/public and both migration
# sources to dist/migrations (the layout main.ts detects in the image).
RUN npm run build

FROM public.ecr.aws/docker/library/node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/stigmer/stigmer-apps"
LABEL org.opencontainers.image.vendor="Stigmer"
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app/apps/law/backend/dist/ /app/

# Run as the non-root user shipped with the node:alpine base.
USER node

# Default HTTP port (overridable via PORT).
EXPOSE 8080

# Health check for container orchestrators outside Kubernetes; in the
# cluster the chart's probes are authoritative. /healthz answers before
# auth and never touches the database (server.ts).
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

# Exec-form node, never an npm wrapper: Kubernetes delivers SIGTERM to
# PID 1, graceful shutdown hangs off the SIGTERM handler in main.ts,
# and npm does not forward signals to its child.
CMD ["node", "/app/main.js"]
