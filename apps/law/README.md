# Stigmer Law

Case management for law firms, built on [Stigmer](https://github.com/stigmer/stigmer)
— a TypeScript system of record with WhatsApp Ops layered on top. Cases,
tasks, notes, documents, and hearing reminders in a real web app; the
firm's staff work it over WhatsApp.

Stigmer Law is a vertical product **built on** the Stigmer platform, not
an edition of the platform itself (that's [`stigmer`](https://github.com/stigmer/stigmer)
and [`stigmer-cloud`](https://github.com/stigmer/stigmer-cloud)).

Every firm runs its own physically isolated instance. Onboarding a firm is
configuration only — manifests, secrets, and channel bindings live
**outside this repository**; the codebase contains zero customer-specific
strings by design (a code edit during onboarding means the design failed
its own test).

Built on the repo's commons packages: `@stigmer/resource-api`
(proto-first resource pipeline: validate → load → authorize → duplicate
check → build state → persist → publish — every resource rides the
pipeline; none bypasses it) and `@stigmer/identity` (the shared User
resource, credential storage, and the authenticator chain — DD-005).

## Layout

| Path | Contents |
|---|---|
| `proto/` | Proto contracts (source of truth; TypeScript types are generated). Package convention: `stigmer.law.<resource>.v1` (the domain, never the customer segment or the brand). The envelope (`stigmer/resourceapi/*`) and identity (`stigmer/identity/*`) contracts resolve in-workspace through the root `buf.yaml` |
| `backend/` | Connect-RPC backend: resource definitions on the commons pipeline, the app's Postgres migrations (composed after `@stigmer/identity`'s as ordered migration sources), the MCP channel entrance (`src/mcp/`), acceptance tests |
| `deploy/infra-charts/` | The reusable per-firm infrastructure chart (`stigmer-law-firm-stack`, DD-004) — one install provisions a firm's namespace, Postgres, document bucket, AND the running app; its README is the firm onboarding runbook (T06) |
| `deploy/stigmer/` | Generic Stigmer manifest templates for the firm's WhatsApp assistant (agent, MCP registration, environment, channel — T05); per-firm concretions live in the private ops repo |

## Development

Requires Node 22 and Docker (for integration tests). Everything builds
from the repo root:

```bash
nvm use
npm ci
npm run codegen     # protos -> src/gen everywhere (committed; CI checks drift)
npm run typecheck
npm test            # integration tests boot real Postgres via Testcontainers
npm run build
```

To run the backend locally: `npm run dev -w @law/backend` with
`AUTH_EPHEMERAL_KEYS=true` and an `AUTH_OPERATOR_KEY_SHA256` (plus the
database/object-store variables — see `backend/src/config.ts`, which
names everything it needs when something is missing). The database
accepts exactly one of two forms: `DATABASE_URL` (the dev/test form —
one string) or the discrete `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/
`PGPASSWORD` set (the deployment form — Planton config references
resolve only as whole values, so a URL cannot be composed in a
manifest). `PGSSLMODE=require` encrypts without certificate
verification (the deployed operator rejects unencrypted clients and
self-signs its certs); the default is `disable` for local plaintext.

## Authentication and the first user (DD-005)

Identity is email/password: bcrypt-verified `Login` mints a ~1h RS256
access token plus a 7-day rolling refresh cookie (rotated one-time-use;
a replayed refresh token revokes every session of the affected user).
`SetPassword` is the offboarding lever — it also revokes the target
user's sessions.

A fresh firm deployment has zero users, so provisioning bootstraps with
the **operator key** (`opk_…`), a per-firm credential from config — not a
user row (nothing phishable):

1. Generate the firm's secrets once:
   `node scripts/generate-auth-secrets.mjs` (from the repo root). Seed
   `AUTH_JWT_PRIVATE_KEY` and `AUTH_OPERATOR_KEY_SHA256` through the
   firm's config-manager artifacts in the private ops repo
   (`_ops/planton/clients/<domain>/<client>/` in stigmer-cloud — the
   DD-004 per-firm model). The raw operator key stays with the operator.
2. Create the first user and set their password with the operator key:

```bash
buf curl --schema . -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"spec":{"email":"partner@firm.example"}}' \
  https://<backend>/stigmer.identity.user.v1.UserService/Create

buf curl --schema . -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"email":"partner@firm.example","password":"<initial password>"}' \
  https://<backend>/stigmer.identity.user.v1.UserService/SetPassword
```

3. That user signs into the web app and works normally; further accounts
   are created the same way (no self-registration; password reset is an
   operator action — T01 owner decision 1).

## The WhatsApp assistant (T05, DD-008)

The backend runs a second listener — the **MCP channel entrance**
(`backend/src/mcp/`, default port 8081, cluster-internal only in
deployment) — serving seven tools to the firm's agent on the Stigmer
platform: `my_open_tasks`, `find_tasks`, `get_case`,
`upcoming_hearings`, `firm_overview`, `update_task_status`,
`add_case_note`.

The arrangement that matters: the agent platform verifies the WhatsApp
sender with Meta and asserts the number in headers (never through the
model); the entrance verifies its shared secret in constant time, then
resolves the number to a firm member by exact E.164 match
(`@stigmer/identity`'s channel resolver — a user's `phone` is their
binding), and the tool runs **as that member through the same resource
pipelines the web app uses**. One policy module governs every surface;
there is no tool-permission table to drift. The trust model — whoever
holds the shared secret can assert any member's identity — is DD-008,
pinned by a test, and the reason the listener gets no public exposure.

Dev loop: `npx tsx src/e2e/serve.ts` (from `backend/`) boots the real
server pair with fictional seed data and prints a ready-to-paste smoke
command; `scripts/mcp-smoke.ts` drives any MCP entrance (local or
deployed) read-only, the way a deploy is accepted.

## License

[AGPL-3.0](LICENSE). The platform ([Stigmer](https://github.com/stigmer/stigmer))
and this repo's commons packages (`@stigmer/resource-api`,
`@stigmer/identity` under `packages/`) are Apache-2.0; the vertical app
is copyleft by choice.
