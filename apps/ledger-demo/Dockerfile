# Acme Books, the integrator demo: the page, Acme's server and its ledger MCP server, one Node process.
# Built from this folder (the build context is apps/ledger-demo); the base image is the public ECR copy
# of Docker's official Node image, as Stigmer's own web console uses, so a build never meets Docker
# Hub's pull limits.

# Build stage: every dependency, then the page.
FROM public.ecr.aws/docker/library/node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.node.json tsconfig.web.json vite.config.ts ./
COPY fixtures ./fixtures
COPY server ./server
COPY web ./web
RUN npm run build

# Run stage: only the server's dependencies, the built page, and the server's source, which tsx runs
# as it is (no second compile to keep in step).
FROM public.ecr.aws/docker/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY fixtures ./fixtures
COPY server ./server
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "server/main.ts"]
