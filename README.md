# Stigmer Apps

Vertical business applications built on the Stigmer platform, plus the
shared TypeScript commons they stand on. One repository, many verticals —
the Odoo model: adding a domain app is a folder under `apps/`, never a new
repo, and everything reusable lives in `packages/` so vertical #2 starts
from the commons instead of from scratch.

## Apps

| App | Product | Domain | License |
|-----|---------|--------|---------|
| [`apps/law`](apps/law) | **Stigmer Law** — case management for law practices (cases, tasks, notes, documents, hearing reminders), with WhatsApp Ops layered on top | `stigmer.law.*` / `law.stigmer.ai/v1` | AGPL-3.0-only |

Products are named after the platform (Stigmer Law, Stigmer Gym, ...) —
the Frappe-style naming architecture (project DD-002). The brand never
enters the wire contract: proto packages and apiVersions are domain-shaped
(`stigmer.<domain>.<resource>.v1` ↔ `<domain>.stigmer.ai/v1`) and survive
any rebrand.

## Packages (the commons)

| Package | Purpose | License |
|---------|---------|---------|
| [`@stigmer/resource-api`](packages/resource-api) | Proto-first resource API pipeline: common envelope, per-operation step chains (create / update / get / list / custom), store port with Postgres adapter, error contract. The TypeScript sibling of the Java commons (`stigmer-cloud/backend/libs/java`) and the Go commons (`stigmer/backend/libs/go`). | Apache-2.0 |
| [`@stigmer/identity`](packages/identity) | Shared identity for the verticals: the User resource, authenticator chain (password / RS256 bearer / operator key), dual-transport caller resolver, credential + rotating-refresh stores, AuthService, login rate limiter. | Apache-2.0 |

Commons are business-agnostic by contract: nothing in `packages/` may know
about any particular product or customer. The placement test for every new
piece of code: **"would vertical #2 need this?"** Yes → `packages/`;
no → the app that owns it. See `.cursor/rules/stigmer-apps-architecture.mdc`
for the full architecture rules and `LICENSE.md` for the licensing map.

## Development

```bash
nvm use            # Node 22
npm ci
npm run build      # commons first, then apps — @law/backend resolves
                   # @stigmer/resource-api's compiled dist via the workspace
npm run typecheck
npm test           # integration tests need a running Docker daemon
                   # (Testcontainers: Postgres, MinIO)
npm run codegen    # regenerate committed proto stubs (run from the root;
                   # CI fails on drift)
```

Protos live in one buf workspace (root `buf.yaml`). The envelope module is
published to the BSR as `buf.build/stigmer/resourceapi` for external
consumers; inside this repo, apps resolve it in-workspace — one definition,
nothing vendored, nothing pinned between siblings.

## Quality bar

- Tests ship with features; integration tests run against real
  infrastructure (Testcontainers), never mocks of Postgres.
- Every commons package's test suite must run standalone — a library that
  can only be tested through a consuming product is a design failure.
- Comments carry rationale, not narration: they record *why* an ordering,
  divergence, or constraint exists, citing the precedent or issue that
  motivated it.
- No customer data, anywhere: this repo is public, so customer-specific
  strings are a CI failure on every path, enforced by
  `scripts/check-customer-data.mjs`. Test fixtures are fictional by
  construction.

## Operating model

This repo carries the code; per-client deployment configuration and the
project operating records (plans, checkpoints, design decisions,
changelogs) live in a private ops repo. What lives here:

- `_roles/` — role prompts (architect, backend, web, UX, tester, docs)
  that set the quality bar for each discipline.
- `.cursor/rules/` — process rules (commit, verify, PR) and the
  architecture rule for this repo.
