# ts-commons

TypeScript backend commons for Stigmer products — the TypeScript sibling of
the Java commons (`stigmer-cloud/backend/libs/java`) and the Go commons
(`stigmer/backend/libs/go`). Libraries here are business-agnostic by
contract: nothing in this repo may know about any particular product or
customer.

## Packages

| Package | Purpose |
|---|---|
| [`@stigmer/resource-api`](packages/resource-api) | Proto-first resource API pipeline: common envelope, per-operation step chains (create / update / get / list / custom), store port with Postgres adapter, error contract. |

## Consuming

Until packages are published to npm, consumers link the sibling checkout
(the deterministic `~/scm/github.com/stigmer/` layout):

```jsonc
// consumer package.json
"dependencies": {
  "@stigmer/resource-api": "file:../../ts-commons/packages/resource-api"
}
```

Packages export compiled output (`dist/`), so run `npm run build` here after
pulling changes. Publishing to npm begins once the `resource-api` surface
stabilizes against its first consumer.

## Development

```bash
nvm use          # Node 22
npm ci
npm run typecheck
npm test         # integration tests need a running Docker daemon
npm run build
```

## Quality bar

- Tests ship with features; integration tests run against real
  infrastructure (Testcontainers), never mocks of Postgres.
- Every library's test suite must run standalone — a library that can only
  be tested through a consuming product is a design failure.
- Comments carry rationale, not narration: they record *why* an ordering,
  divergence, or constraint exists, citing the parent-commons precedent or
  issue that motivated it.
