# lawfirm-assistant

Case management for law firms — a TypeScript system of record with WhatsApp
Ops layered on top. Customer zero is onboarded by configuration only; the
codebase contains zero customer-specific strings by design (a code edit
during onboarding means the design failed its own test).

Built on [`@stigmer/resource-api`](https://github.com/stigmer/ts-commons)
(proto-first resource pipeline: validate → load → authorize → duplicate
check → build state → persist → publish). Every resource rides the
pipeline; none bypasses it.

## Layout

| Path | Contents |
|---|---|
| `proto/` | Proto contracts (source of truth; TypeScript types are generated) |
| `backend/` | Connect-RPC backend: services, Postgres migrations, integration tests |

## Development

Requires Node 22, Docker (for integration tests), and the sibling checkout
of [`stigmer/ts-commons`](https://github.com/stigmer/ts-commons) at
`../ts-commons` (the deterministic `~/scm/github.com/stigmer/` layout) —
`@stigmer/resource-api` is consumed via a `file:` link until it is
published to npm.

```bash
# once: build the commons the backend links against
cd ../ts-commons && npm ci && npm run build && cd -

nvm use
npm ci
npm run codegen     # proto -> backend/src/gen (committed; CI checks drift)
npm run typecheck
npm test            # integration tests boot real Postgres via Testcontainers
npm run build
```

## Quality bar

Tests ship with features — every record-model rule in the MVP scope
contract is a testable acceptance statement. Errors are UX: messages name
the resource and the offending value. Comments carry rationale, not
narration.
