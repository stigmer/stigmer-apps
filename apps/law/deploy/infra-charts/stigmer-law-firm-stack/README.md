# Stigmer Law Firm Stack

The infrastructure chart for the law vertical (`apps/law`). Each law firm
is a single-tenant deployment, so this is a **reusable per-firm template**:
the firm slug is a parameter, and every firm is an *install* of this one
chart — never a copy of it. Onboarding firm #2 is one new values file,
three seeded secrets, and one install command (the runbook below).

## What it provisions

One install brings up a complete firm:

| Template | Resource | Purpose |
|---|---|---|
| `templates/namespace.yaml` | `KubernetesNamespace` | The firm's namespace (`{org}-{env}-law-{firm}`) — isolation is physical, offboarding is a single-namespace teardown |
| `templates/postgres.yaml` | `KubernetesPostgres` | The firm's system of record (database `law`, role `law_app`), alone in the firm's namespace, no public endpoint |
| `templates/r2-bucket-documents.yaml` | `CloudflareR2Bucket` | The firm's private document bucket (`{org}-law-{firm}-documents-{env}`), consumed as plain S3 via the `OBJECT_STORE_*` env contract |
| `templates/deployment.yaml` | `KubernetesDeployment` | The backend + same-origin web app on one public hostname (probes on `/healthz`), plus the MCP channel entrance on a second, **cluster-internal-only** port (T05, DD-008) |

The MCP entrance is deliberately not public: the agent platform's
sandboxes share the firm's cluster, so the tool surface is reached at
`http://{org}-{env}-law-{firm}-backend.{org}-{env}-law-{firm}.svc.cluster.local:8081/mcp`
and a shared-secret boundary never faces the internet. That URL is what
the firm's Stigmer `McpServer` manifest points at
(`apps/law/deploy/stigmer/`).

## The release model (T06 topology)

The Service Hub service `law-backend` (private ops repo) **builds and
pushes** `ghcr.io/stigmer/stigmer-apps/law-backend:<git-sha>` on every
merge to main — and deploys nothing. A firm runs exactly the tag pinned
as `image_tag` in its values file; releasing is bumping that pin and
re-installing, and rolling back is pointing it at the previous tag and
re-installing. Nothing untested ever auto-deploys to a firm, and the
commit serving each firm is recorded in the private ops repo's history.

Corollary, and it is load-bearing: **a routine release changes
`image_tag` and nothing else.** Every install re-evaluates all four
resources; unchanged parameters are no-ops, but a careless edit to a
Postgres parameter can replace the cluster — with the firm's data in it.
Treat any non-tag parameter change as its own deliberate, reviewed act.

## The secret contract

The deployment references exactly three config-manager secrets per firm
(env-scoped, slugs contracted by `templates/deployment.yaml`); the
platform validates the references at apply time, so all three must be
**applied before the install**:

| Slug | Format | Contents / source |
|---|---|---|
| `stigmer-law-<firm>-r2-credentials` | key_value | `access-key-id`, `secret-access-key` — a Cloudflare R2 API token scoped to only this firm's bucket (dashboard-created; revoking it offboards one firm) |
| `stigmer-law-<firm>-postgres-credentials` | string | The `law_app` password. Exists only AFTER the first install provisions Postgres: copy it from the operator-generated Kubernetes secret `law-app.db-{org}-{env}-law-{firm}-postgres.credentials.postgresql.acid.zalan.do` (the operator hyphenates the role name in the secret's name) |
| `stigmer-law-<firm>-auth-keys` | key_value | `jwt-private-key`, `operator-key-sha256`, `mcp-shared-secret` — from `node scripts/generate-auth-secrets.mjs` (repo root); the raw `opk_` key stays with the operator, and the MCP secret ALSO goes into the firm's Stigmer environment (the agent platform presents it on tool calls — DD-008: whoever holds it can assert any lawyer's identity) |

Everything non-secret (bucket name, R2 endpoint, Postgres endpoint,
database, user) is **derived inside the templates** from the same
expressions that render the resources — deliberately never duplicated
into config-manager, where a copy could drift.

## Onboarding a firm (the runbook)

All firm-named artifacts live in the private ops repo under
`stigmer-cloud _ops/planton/clients/law/<client>/` (DD-A10 — this repo
is public and carries no customer strings). Zero code changes; if a
step below ever requires one, the design has failed its own test.

1. **Values file** (`infra-project/prod.yaml` in the client's folder):
   every param in `values.yaml` — chart defaults are NOT merged at
   install, so every param needs an entry (verified against a live
   pipeline failure). Firm-specific: `firm`, `hostname`, `image_tag`.
2. **Auth keys**: run `node scripts/generate-auth-secrets.mjs`, apply +
   seed `stigmer-law-<firm>-auth-keys`.
3. **R2 token**: create the bucket-scoped token in the Cloudflare
   dashboard (the bucket must exist — see step 4's two-pass note),
   apply + seed `stigmer-law-<firm>-r2-credentials`.
4. **Install** (from the client's folder; never concurrently with
   another Planton infra pipeline — shared Pulumi state backends):

   ```bash
   planton chart install stigmer-prod-law-<firm> \
     <stigmer-apps>/apps/law/deploy/infra-charts/stigmer-law-firm-stack \
     --env prod --values infra-project/prod.yaml
   ```

   The FIRST install of a firm is two-pass by construction: Postgres
   must exist before its generated password can be copied into
   `stigmer-law-<firm>-postgres-credentials`, so the app comes up only
   on the second pass (re-run after seeding).
5. **First user**: bootstrap with the operator key over the live
   hostname (`apps/law/README.md`, "Authentication and the first user").

## Gate before real case data

- **Backups do not exist yet.** The live Postgres operator has no
  declarative backup path; a firm must not enter a single real case
  until a backup story does. Demo data is reseedable — real case files
  are not.

## Publish

```bash
# From this directory (publishes to the stigmer org's chart registry):
planton chart publish
```
