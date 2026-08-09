# Stigmer Law Firm Stack

The infrastructure chart for the law vertical (`apps/law`). Each law firm
is a single-tenant deployment, so this is a **reusable per-firm template**:
the firm slug is a parameter, and every firm is an *install* of this one
chart — never a copy of it. Onboarding firm #2 is one new values file plus
one install command.

## What it provisions

| Template | Resource | Purpose |
|---|---|---|
| `templates/r2-bucket-documents.yaml` | `CloudflareR2Bucket` | The firm's private document bucket (`{org}-law-{firm}-documents-{env}`), consumed by the backend as plain S3 via the `OBJECT_STORE_*` env contract |

T06 grows this chart with the rest of a firm's deployment (per-firm
Postgres, namespace as needed). It deliberately stays separate from the
platform's `stigmer-infrastructure-stack` so app operations never fan a
pipeline across platform resources.

## Where the pieces live

The chart is generic and carries **no customer strings** — the
customer-data guard (`scripts/check-customer-data.mjs`) enforces that in
CI across this whole public repo (DD-A10). Everything that names a client
lives in the private ops repo, under stigmer-cloud
`_ops/planton/clients/law/<client>/`:

- values: `infra-project/prod.yaml`
- runtime config: `config-manager/variables/`
- credentials: `config-manager/secrets/`
  (a Cloudflare R2 API token scoped to only that firm's bucket; values
  gitignored under `.secret-values/`)

The same rule applies at T06: per-client Kustomize overlays reference
firm-named config slugs, so they live under the client's folder; only the
firm-neutral base lives here.

## Publish and install

```bash
# From this directory (publishes to the stigmer org's chart registry):
planton chart publish

# From the client's folder in the private ops repo (see its README there
# for the exact command):
cd <stigmer-cloud>/_ops/planton/clients/law/<client>
planton chart install stigmer-prod-law-<firm> \
  <stigmer-apps>/apps/law/deploy/infra-charts/stigmer-law-firm-stack \
  --env prod --values infra-project/prod.yaml
```

Do not run an install while another Planton infra pipeline is running —
all charts share Pulumi state backends (same rule as the platform's
`isc-infrastructure-stack`).
