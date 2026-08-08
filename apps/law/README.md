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
| `backend/` | Connect-RPC backend: resource definitions on the commons pipeline, the app's Postgres migrations (composed after `@stigmer/identity`'s as ordered migration sources), acceptance tests |
| `deploy/infra-charts/` | The reusable per-firm infrastructure chart (`stigmer-law-firm-stack`, DD-004) |

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
names everything it needs when something is missing).

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
   firm's config-manager artifacts (`clients/<domain>/<client>/`, the
   DD-004 model). The raw operator key stays with the operator.
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

## License

[AGPL-3.0](LICENSE). The platform ([Stigmer](https://github.com/stigmer/stigmer))
and this repo's commons packages (`@stigmer/resource-api`,
`@stigmer/identity` under `packages/`) are Apache-2.0; the vertical app
is copyleft by choice.
