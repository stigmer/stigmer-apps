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

Two seams completed by the first vertical's agent surface (T05):

- **The invoker**: every declared operation — not just create/update —
  is reachable on `DefinedResource.invoke` as a typed, transport-free
  async function taking an explicit `CallerPrincipal`. In-process
  surfaces (event handlers, an app's MCP entrance) pass a *principal*,
  never a materialised credential — a credential can leak; a principal
  passed in-process cannot.
- **The filter vocabulary**: `ListQuery.filter` values are a CLOSED
  union — equality, set membership, range, absent — AND-only, with
  deliberately no negation and no OR (the port doc in
  `src/store/store.ts` records why, including the parents' NULL
  footgun). Consumers expose NAMED predicates on their wire contracts
  and compile them to this vocabulary; a caller-facing field+operator
  grammar is the drift this design exists to prevent.

## Entry points

| Import | Contents |
|---|---|
| `@stigmer/resource-api` | Pipeline, operations, store port, error contract |
| `@stigmer/resource-api/postgres` | Postgres store adapter and plain-SQL migration runner |

## Install

```bash
npm install @stigmer/resource-api
```

The envelope proto ships in the package (`proto/`) and is published to the
Buf Schema Registry as `buf.build/stigmer/resourceapi`; a consumer's own
protos declare it as a buf dependency and import
`stigmer/resourceapi/v1/resource.proto` — nothing is vendored.

## Status

`0.x` — the API is a contract with every consumer, but breaking changes
still land as minor versions; pin an exact version. Every `@stigmer/*`
commons package publishes in lockstep from one `v*` tag (the repo README's
"Releasing"), so a release's `@stigmer/identity` depends on exactly that
release's `@stigmer/resource-api`.
