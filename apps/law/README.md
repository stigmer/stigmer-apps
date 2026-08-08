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

Built on [`@stigmer/resource-api`](https://github.com/stigmer/ts-commons)
(proto-first resource pipeline: validate → load → authorize → duplicate
check → build state → persist → publish). Every resource rides the
pipeline; none bypasses it.

## Layout

| Path | Contents |
|---|---|
| `proto/` | Proto contracts (source of truth; TypeScript types are generated). Package convention: `stigmer.law.<resource>.v1` (the domain, never the customer segment or the brand). The `@stigmer/resource-api` envelope is a BSR dependency ([`buf.build/stigmer/resourceapi`](https://buf.build/stigmer/resourceapi), pinned in `buf.lock`) — one definition in ts-commons, no vendored copies |
| `backend/` | Connect-RPC backend: resource definitions on the commons pipeline, per-resource Postgres migrations, acceptance tests |

## Development

Requires Node 22, Docker (for integration tests), and the sibling checkout
of [`stigmer/ts-commons`](https://github.com/stigmer/ts-commons) at
`../ts-commons` — `@stigmer/resource-api` is consumed via a `file:` link
until it is published to npm.

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

## License

[AGPL-3.0](LICENSE). The platform ([Stigmer](https://github.com/stigmer/stigmer))
and the commons ([`@stigmer/resource-api`](https://github.com/stigmer/ts-commons))
are Apache-2.0; the vertical app is copyleft by choice.
