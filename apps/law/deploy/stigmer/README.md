# Stigmer manifests — the firm's assistant (templates)

The resources that put a law firm's assistant on WhatsApp AND inside
the firm's web app ("Ask AI"), as generic templates. Per-firm
concretions (real org, firm slug, channel app) live in the PRIVATE ops
repo under `stigmer-cloud _ops/planton/clients/law/<client>/stigmer/` —
this repo is public and carries no customer strings (DD-A10). The
design record is the project's DD-008 (WhatsApp) and the T05 web leg.

## How the identity flows (why these files look the way they do)

```
WhatsApp sender                        Web app user
  → Meta verifies the number (wa_id)     → the firm backend verifies the
  → the platform carries it on the         login session and mints a
    session, NEVER through the model       platform token for THAT user
                                           (id + email) — MintToken RPC
  → the runner injects STIGMER_CALLER_IDENTITY_* into THIS server's
    env map (because mcp-server.yaml declares those keys)
  → the headers reach the firm backend's MCP entrance
  → the backend resolves phone → User (whatsapp_phone) or
    email → User (stigmer_user) and runs the call as that lawyer
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

## The web assistant ("Ask AI") — additional onboarding

The web app drives the SAME agent through PlatformClient-minted user
tokens: every web conversation names the agent itself (`org/slug`), and
the PlatformClient that mints the lawyers carries the environment that
delivers the MCP secret to their runs. One more platform resource, then
the backend's config:

6. **PlatformClient — a Console step, and the settings are one-way.**
   The kind is not manifest-appliable (it is absent from the CLI's verb
   matrix); create it in the platform console (IAM → Platform Clients)
   with:
   - `auto_provision_accounts: true`, `auto_grant_on_org: true`, and
     **`auto_grant_role: member` FROM THE FIRST APPLY** — `viewer` (the
     default) cannot start executions, and role edits never reach
     already-provisioned users (stigmer/stigmer#380): a wrong first
     value is manual IAM surgery per lawyer, not a settings fix.
   - `allowed_origins` = the firm's web origin. Declared-but-unenforced
     today (stigmer/stigmer#375) — set it anyway so enforcement, when
     it lands, finds the right value.
   - `environment_refs` = the firm's MCP-credentials environment
     (`kind: environment`, `org: <stigmer-org>`,
     `slug: <firm>-law-mcp-credentials`). A PlatformClient's
     environments are a layer every execution of a user it minted
     receives, so this binding is what carries `LAW_MCP_SHARED_SECRET`
     to web conversations; without it every web execution fails a
     precondition (the MCP server requires the secret and nothing else
     delivers it). The reference must be in the client's own
     organization (an execution in any other org receives nothing).
     The console form does not render this binding (it keeps whatever
     is stored); set it through the SDK's `platformclient.update`,
     sending the client's full spec back with the reference added — an
     update replaces the spec.
   The client id + secret go into the firm's config-manager secrets;
   the secret never enters either repo or the browser.
7. **Backend config** (the chart's values): the all-or-nothing
   STIGMER_* group — `STIGMER_API_BASE_URL`,
   `STIGMER_PLATFORM_CLIENT_ID`, `STIGMER_PLATFORM_CLIENT_SECRET`,
   `STIGMER_ORG`, `STIGMER_AGENT` (the applied agent as
   `<stigmer-org>/<firm>-law-assistant`; the chart's `assistant_agent`
   value) — all five or none (a partial group, or an agent that is not
   `org/slug`, refuses boot); optional `STIGMER_CONSOLE_URL` for
   self-hosted consoles. No variables set = the web app simply has no
   Ask AI (the open-source posture). VERIFY the applied agent is
   org-visible (`agent.yaml` sets `visibility_org`): the platform runs
   an agent only for a caller who can read it, so a private agent
   refuses every lawyer's first message.

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
- **A corrected email goes stale platform-side** (stigmer/stigmer#377):
  the platform freezes a JIT-provisioned user's email at FIRST mint, so
  after an email fix in the law app the web assistant presents the OLD
  email to the MCP entrance — the resolver refuses (fail-closed) and
  Ask AI goes dark for that one person. The minted JWT's email claim
  looks correct anyway (it echoes the request): diagnose from the MCP
  entrance's refusal, not the token.
- **The web session's engine is pinned in the web app** (cursor — the
  WhatsApp channel's engine). The platform default is a different
  engine with different tools/billing; the pin lives in the law web
  bootstrap, not in any manifest — do not "fix" a manifest to change it.
- **Ask AI JIT-provisions each signing-in user into the platform org as
  a MEMBER.** In a shared org that puts them inside every org-visible
  resource boundary there — re-check the org-boundary decision (project
  DD-006) before the first real user signs in.
