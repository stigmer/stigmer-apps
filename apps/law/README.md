# Stigmer Law

Law-practice management built on [Stigmer](https://github.com/stigmer/stigmer)
— a TypeScript system of record with a WhatsApp assistant layered on
top. The model follows how an Indian litigation practice actually runs:
**matters moving through an appearance/adjournment cycle**, with people
and money attached. Clients, cases (keyed by the firm's own file
number), the hearing diary (append-only appearances with recorded
outcomes that auto-schedule the next date), deadlines with escalating
reminders, a partner-only fee ledger, tasks, notes, documents, an audit
trail, and firm-hierarchy authorization (managing partner → partner →
associate → junior → clerk → office staff) enforced fail-closed by one
policy module at every entrance.

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

3. Give the user a FIRM PROFILE — since the rebuild, a User with no
   `FirmMember` is refused everywhere (fail-closed): the profile carries
   the role the authorization matrix reads. The first profile is
   operator-created (the managing partner then manages the rest
   in-product):

```bash
buf curl --schema . -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"spec":{"userId":"user_…","role":"FIRM_ROLE_MANAGING_PARTNER"}}' \
  https://<backend>/stigmer.law.firmmember.v1.FirmMemberService/Create
```

4. That user signs into the web app and works normally; further accounts
   are created the same way (no self-registration; password reset is an
   operator action — T01 owner decision 1). Offboarding is
   `FirmMember.Update` with `active: false` (locks the member out on
   their next request and revokes their sessions) plus `SetPassword`.

Profile corrections (name, email, phone — the WhatsApp binding) are
operator actions too, via `Update`. It is a **full spec replacement**
(read-modify-write: send every field back; an omitted `phone` clears the
member's WhatsApp binding), targeted by `metadata.id`:

```bash
buf curl --schema . -H "Authorization: Bearer $OPERATOR_KEY" \
  -d '{"metadata":{"id":"user_…"},"spec":{"email":"partner@firm.example","name":"A. Partner","phone":"+91123456"}}' \
  https://<backend>/stigmer.identity.user.v1.UserService/Update
```

Update is deliberately operator-only, same tier as Create/SetPassword:
`spec.phone` decides which verified WhatsApp sender resolves to the user
(DD-008), so profile self-service would be an impersonation lever.

## The WhatsApp assistant (T05, DD-008)

The backend runs a second listener — the **MCP channel entrance**
(`backend/src/mcp/`, default port 8081, cluster-internal only in
deployment) — serving the journey verbs to the firm's agent on the
Stigmer platform: `my_day`, `my_deadlines`, `find_tasks`, `case_story`,
`upcoming_hearings`, `record_hearing_outcome`, `firm_overview`,
`update_task_status`, `add_case_note`, and the partner-gated
`outstanding_balances`.

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
