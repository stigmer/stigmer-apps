# @stigmer/identity

Shared identity for Stigmer vertical apps: the `User` resource, credential
storage, token issuing/verification, and a pluggable authenticator chain.
Apache-2.0, like every commons package.

This package answers **"who is calling"** — never "what may they do".
Authorization stays in each app's policy module (one policy, N enforcement
points); this package produces the `CallerPrincipal` that policy consumes.

The design record is DD-005 in the first consumer's project folder: own
the authentication seam, ship the smallest correct issuer behind it
(bcrypt password → locally-signed RS256 tokens), keep "bring your own
identity provider" one authenticator away.

## The pieces

| Piece | What it is |
|---|---|
| `Authenticator` + `composeAuthenticators` | The seam. Each authenticator claims or passes on a presented bearer credential; first claim wins. |
| `bearerTokenAuthenticator` | Verifies locally-signed RS256 access tokens (the ones Login mints). |
| `operatorKeyAuthenticator` | The per-deployment `opk_` operator credential — how a fresh deployment with zero users bootstraps its first one. Not a user row: there is no phishable admin account. |
| `createCallerResolver` | Binds the chain to both transports: Connect handlers (`fromConnect`, for `defineResource`'s `caller` seam) and plain-HTTP byte routes (`fromHttp`). |
| `createAccessTokenIssuer` / `loadSigningKeys` | RS256, `kid` = RFC 7638 thumbprint, verify-only previous key for rotation. Production loads configured keys and fails fast; dev/tests use `generateEphemeralSigningKeys()`. |
| `userResource` | The shared `User` resource on the commons pipeline (`stigmer.identity.user.v1`, apiVersion `identity.stigmer.ai/v1`). |
| `CredentialStore` / `RefreshTokenStore` | Ports; Postgres adapters under `@stigmer/identity/postgres`. Refresh tokens are opaque, hashed at rest, one-time-use with reuse detection. |
| `createCallerIdentityResolver` | (T05) A platform-asserted caller identity resolved to a user-kind principal: `whatsapp_phone` (wa_id) by exact E.164 match, `stigmer_user` by exact email match. **Not part of the chain** — see the box below. |

## The profile pattern (binding on every vertical)

The identity `User` carries **identity attributes only**: email (natural
key), name, phone (E.164 — a channel binding is an identity attribute).

Vertical-specific person data — a lawyer's bar number, a gym member's
plan — lives in **vertical-owned profile resources that reference the
user id**. Verticals extend by reference, never by widening this
package's proto. A field proposed for `UserSpec` must be an attribute of
*identity itself*, meaningful to every vertical, or it does not land.

Operation matrix: `create`, `update`, `get`, `list`, `setPassword`,
`issueActivationCode` — no delete (SetPassword's session revocation is
the offboarding lever). The writes are administration-tier by
consumer-policy convention (an operator, or a delegated administrator
role the consuming app names), **update included and at the same tier**:
`spec.phone` is a channel binding, so whoever may update a user decides
which verified WhatsApp sender resolves to them — profile editing one
notch below the administration tier would be a self-service
impersonation lever (the proto's Update comment carries the full
reasoning).

**Activation codes** are the no-email onboarding/reset path: an
administrator issues a one-time code (shown once, hashed at rest, three
days, replaced by reissue) and hands it over out-of-band; the person
redeems it (`AuthService.RedeemActivationCode`, pre-auth like Login) to
set their own password, which also revokes every session of the
account. `AuthService.ChangePassword` is the self-service change —
current password as proof of possession, all sessions revoked, the
client signs back in with the password it just set. SetPassword stays a
break-glass direct write: setting a password FOR someone is a silent
takeover, while a code redemption is visible to the account holder.

## Composing into an app

The app stays the composition root — it declares the chain, owns the
policy, registers the storage kinds, and orders the migration sources:

```ts
const keys = config.auth.ephemeralKeys
  ? await generateEphemeralSigningKeys()
  : await loadSigningKeys(config.auth);
const issuer = createAccessTokenIssuer(keys);
const resolver = createCallerResolver([
  operatorKeyAuthenticator(config.auth.operatorKeySha256Hex),
  bearerTokenAuthenticator(issuer),
]);

// Storage: spread the identity kinds into the app's one store.
const store = new PostgresResourceStore(pool, {
  ...identityStoreKinds(),
  Case: { /* the app's own kinds */ },
});

// Migrations: identity's source first, so app tables can reference users(id).
await runMigrations(pool, [
  { source: "identity", dir: identityMigrationsDir },
  { source: "app", dir: appMigrationsDir },
]);

// The resource: app policy, app publisher, the chain's resolver.
const users = userResource({ store, policy, caller: resolver.fromConnect, credentials, refreshTokens });
```

Deploy note: the app's build must ship both migration directories beside
the bundle (the deployed image carries no `node_modules`) — see the first
consumer's `build.mjs`.

## Caller identity is a separate seam, not a chain link

An earlier revision of this README planned T05's channel binding as one
more authenticator in the chain. **That plan was wrong for the topology
that actually shipped, and following it would have been a security
defect**: everything in the chain guards *every* request — web login
included — so caller-identity headers in the chain would let anyone who
can set two headers act as any user. The assumption only held for a
separate MCP server process presenting a single exchanged credential;
the first consumer mounts its MCP entrance inside the app instead.

So `createCallerIdentityResolver` is deliberately a distinct seam: the
app consumes it ONLY behind its MCP entrance's own shared-secret
gate, never on the general request path. Two identity kinds, each with
its own binding rule: `whatsapp_phone` by exact E.164 match with no
normalization layer (`'+' + wa_id` — the proto's strict validation makes
fuzz unnecessary by construction), and `stigmer_user` by exact lowercase
email match through the natural key (a platform-authenticated user, the
web-embed path). Shared rules (each a tested invariant): exactly one
match or refuse (phone ambiguity refuses, never guesses; email is unique
by construction), and a store failure propagates as an outage rather
than degrading to "unknown". The trust model — whoever holds the MCP
gate's secret can assert any identity — is the consuming app's design
record (first consumer: stigmer-law DD-008).

(The seam was named "channel identity" until the `stigmer_user` kind
arrived: a platform-authenticated user is not a channel, and the
platform's own name for the mechanism — and for its wire headers,
`X-Stigmer-Caller-Kind`/`-Value` — is caller identity.)

## Growth path (each waits for a real consumer)

- **OIDC authenticator** — "bring your own IdP" (Entra, Google, Okta):
  verify against the provider's JWKS, map the subject to a `User`. This is
  the enterprise-SSO answer; it plugs into the chain without app changes.
- **API-key authenticator** — platform-precedented (`stk_`), when a
  machine consumer exists.
- **Further caller-identity kinds** (Slack user id, email) — new
  branches in the caller resolver, each with its own binding rule.

## Invariants (tested)

1. No transport credential can produce the system principal — bearer
   tokens verify to user-kind only (`token_type` asserted even on genuine
   signatures), the operator key to operator-kind; `kind: "system"`
   exists only in-process.
2. A password reset revokes the user's refresh sessions (DD-005 D9): with
   no user delete/disable in the contract, SetPassword is the offboarding
   lever, and it must kill what the old credential earned.
