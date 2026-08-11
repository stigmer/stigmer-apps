# @stigmer/authorization

Shared FGA authorization machinery for Stigmer vertical apps: an
OpenFGA-backed engine, an idempotent store/model bootstrap, and a
set-diff tuple reconciler. Apache-2.0, business-agnostic by contract —
authorization models and policy decisions live in each app.

## What this package is (and is not)

- **It answers relationship questions.** `AuthorizationEngine.check`
  ("does this user hold this relation on this object?") and
  `listObjects` ("which objects of this type does the user hold this
  relation to?").
- **It does not decide which question to ask.** Each app has exactly
  one policy module (the repo's DD-A5 rule); that module maps its
  operations to checks and remains the single readable definition of
  "what may this person do". A generic operation→relation mapping layer
  is deliberately absent — it is the recorded extraction seam for when
  a second vertical proves its shape.
- **Tuples are a projection, never a source of truth.** The consuming
  app's rows stay authoritative; `reconcileTuples` makes the engine
  equal an app-computed desired set (boot + scheduled), and the app
  keeps tuples current synchronously in its own write path between
  reconciles.

## Usage

```ts
import { bootstrapAuthorization, reconcileTuples, ref } from "@stigmer/authorization";

const { engine } = await bootstrapAuthorization({
  connection: { apiUrl: process.env.FGA_API_URL!, apiToken: process.env.FGA_API_TOKEN },
  storeName: "myapp",
  modelDsl: readFileSync("authz/model.fga", "utf8"),
});

// Boot-time (and scheduled) reconcile from the app's own rows:
await reconcileTuples(engine, computeDesiredTuples(rows));

// In the policy module:
const allowed = await engine.check({ user: ref("user", userId), relation: "can_view", object: ref("case", caseId) });
```

Bootstrap is idempotent: the store is found by name before it is
created, and the model is rewritten only when the DSL's transformed
form differs from the latest stored model. Nobody hand-manages store or
model ids per deployment.

## Security

Every deployment runs OpenFGA with preshared-key authentication —
engine endpoints share cluster networks with untrusted workloads. The
test harness (`@stigmer/authorization/testing`, an OpenFGA
testcontainer) runs with the key enabled for the same reason: tests
exercise the authenticated path.

## Testing

`npm test` runs the integration suite against a real OpenFGA container
(Docker required — the repo-wide rule: real infrastructure, no mocks).
