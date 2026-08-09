# Stigmer manifests — the firm's WhatsApp assistant (templates)

The four resources that put a law firm's assistant on WhatsApp, as
generic templates. Per-firm concretions (real org, firm slug, channel
app) live in the PRIVATE ops repo under
`stigmer-cloud _ops/planton/clients/law/<client>/stigmer/` — this repo
is public and carries no customer strings (DD-A10). The design record
is the project's DD-008.

## How the identity flows (why these files look the way they do)

```
WhatsApp sender
  → Meta verifies the number (wa_id)
  → the platform carries it on the session, NEVER through the model
  → the runner injects STIGMER_CALLER_IDENTITY_* into THIS server's
    env map (because mcp-server.yaml declares those keys)
  → the headers reach the firm backend's MCP entrance
  → the backend resolves phone → User and runs the call as that lawyer
```

The shared secret is the entire authorization boundary for those
asserted headers (they are runner-asserted, not signed) — which is why
the MCP entrance is a cluster-internal port with no ingress, the secret
is required-not-optional in the manifest, and the backend refuses to
start without one.

## Concretizing for a firm (the runbook)

1. Copy the four files into the client's private folder; replace every
   `<placeholder>`. One org holds all four (the platform enforces
   same-org refs between channel, agent, and channel app).
2. `LAW_MCP_SHARED_SECRET`'s value = the `mcp-shared-secret` key of the
   firm's auth-keys config-manager secret (one value, two homes: the
   chart deploys it to the backend; the environment hands it to the
   agent platform). Fill it into environment.yaml AT APPLY TIME from
   the gitignored staging — never commit it.
3. Apply in order: `stigmer apply -f` mcp-server, agent, environment.
4. **Console step, before the channel manifest**: Agent → Channels →
   Connect to WhatsApp, binding the firm's number on the org's
   ChannelApp. Take the verified `phone_number_id` from the install and
   fill it into agent-channel.yaml, then apply it.
5. Console testing (optional): whoever connects the MCP server in the
   console supplies the secret into their PERSONAL environment when
   prompted — that path does not read the org environment.

## The traps, so nobody re-learns them

- **Approval overrides cover EVERY tool, reads included.** On WhatsApp
  (unattended) a gated tool is silently skipped, and the platform's
  classifier gates reads too. The overrides in agent.yaml are the only
  layer that can un-gate.
- **The identity env keys are `optional: true` or every run is
  rejected**; the secret is required or the server is silently dropped.
  Opposite failure directions, both silent.
- **The environment is `visibility_org` or the channel path silently
  skips it.**
- **A schedule's runs present the org's synthetic schedule account**
  (`schedule+<org-slug>@schedule.stigmer.internal`), not the creator —
  a scheduled reminder run needs its own binding before it can act
  (stage 6, with the hearing-reminder push).
- **Moving orgs later is a recreate, not a move**: manifests re-apply
  cheaply, but conversation history and the WhatsApp number install do
  not carry over.
