# @stigmer/resource-api

Proto-first resource API pipeline for TypeScript backends — the third
edition of a design proven twice in production:

- Java: `stigmer-cloud/backend/libs/java/grpc/grpc-request`
- Go: `stigmer/backend/libs/go/grpc/request/pipeline`

A resource API built on this package gets, per operation (create / update /
get / list / custom), a composed chain of steps — validate, load, authorize,
duplicate-check, build new state (defaults, audit, version), persist,
publish — so that every resource behaves identically and none bypasses the
pipeline.

This TypeScript edition deliberately restores two capabilities the Go
edition dropped (authorize and publish) and improves on both parents with a
typed request context and a compile-time operation declaration
(`defineResource`), where an operation absent from the declaration answers
`UNIMPLEMENTED` by construction.

## Entry points

| Import | Contents |
|---|---|
| `@stigmer/resource-api` | Pipeline, operations, store port, error contract |
| `@stigmer/resource-api/postgres` | Postgres store adapter and plain-SQL migration runner |

## Status

`0.x` — the API is being shaped against its first consumer and may change
without notice. Not yet published to npm; consume via the sibling checkout
(see the repo README).
