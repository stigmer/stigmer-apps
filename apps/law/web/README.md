# Stigmer Law — Web App

The firm's daily working surface: sign in, see what needs attention today,
manage cases and tasks, attach notes and documents, act on notifications.
A React 19 + Vite single-page app, served in production BY THE BACKEND
from the same origin (T04b D1) — one service per firm, no CORS, and the
refresh cookie's `SameSite=Strict` holds by construction.

## Architecture in one paragraph

Generated Connect clients (`src/gen`, committed, drift-checked in CI) are
the only data model; TanStack Query is the fetching layer; the session
kit (`src/session`) owns the access token in memory and serializes
refresh rotations across tabs through the Web Locks API — one-time-use
refresh tokens treat concurrent rotation as theft, so this is
correctness, not optimization. The document byte routes are the one
sanctioned raw-fetch (`src/api/files.ts`). All styling flows from the
token file (`src/styles/app.css`); there is deliberately no web-commons
package until a second vertical's web app exists (dont-do #7).

## Develop

The fastest loop uses the E2E backend — the real server, containerized
Postgres, seeded fictional users (see `e2e/fixtures.ts` for credentials):

```sh
# terminal 1 — full backend on :8799 (needs Docker)
npx tsx ../backend/src/e2e/serve.ts

# terminal 2 — Vite dev server, proxying API paths to it
DEV_BACKEND_URL=http://localhost:8799 npm run dev
```

Against a hand-run backend (`npm run dev -w @law/backend`), omit
`DEV_BACKEND_URL` (defaults to `http://localhost:8080`).

## Test

```sh
npm test              # Vitest: session kit, interceptor, files client, screens
npm run test:e2e      # Playwright: the working-day flows against the real backend
npm run typecheck
```

The E2E suite includes the two-tab session test (the theft-alarm
regression), the FR-PERF-001 envelope (2s lists / 3s mutations), and an
axe-core accessibility gate (serious/critical violations fail).

## Build

`npm run build` emits `dist/`; the backend's build copies it to
`dist/public`, and the server serves it with an SPA fallback (see
`../backend/src/web/static-routes.ts`). Codegen runs from the repo root
only (`npm run codegen`).
