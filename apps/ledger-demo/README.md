# Acme Books: Stigmer inside a real app

A small accounting product, Acme Books, with Stigmer's chat panel (`<AgentChat>` from `@stigmer/react-sdk`) docked beside a customer's ledger. It is the integrator path of Stigmer's Getting Started pages, built out as a product: each of Acme's customers has an organization of its own under Acme's, their people are signed in by Acme's backend, and the agent posts corrections to Acme's books through Acme's own MCP server, asking first.

Hosted at `https://acme.demo.stigmer.ai`, on Stigmer Cloud's demo environment, behind a presenter passcode.

## What happens in it

- **Dana at Northwind Books** exports the quarter (`ledger.csv`), attaches it in the panel and sends "Review this quarter's ledger."
- **The agent** works in its own sandbox. It reads the file and Northwind's budgets from Acme's `ledger` server (`get_budgets`, read-only, asks nothing) and finds the miscoded line: a design tool booked to Marketing.
- **Before posting**, `post_adjustment` is marked destructive, so Stigmer stops on an approval card. On approve, the correction appears in Acme's own ledger and Marketing's overspend is gone.
- **Priya at Blue Fern Press** sees none of it. Her token can't open Northwind's conversation; the presenter's drawer (Alt+D) shows Stigmer's own refusal.
- **`/stage`** is the presenter's opening: five things a team would otherwise build, ticked as the demo shows each.

## How it is put together

| Folder | What |
|---|---|
| `fixtures/` | The world as data: Acme, its customers, their people and quarters. The page, the server, the setup and the exported CSV all read it. |
| `server/` | One Node process: the page, Acme's `/api` (sign-in, `/api/token` minting each person into their customer's organization, the ledger), the `ledger` MCP server at `/mcp`, `/healthz`. |
| `setup/` | Builds Acme's world on a Stigmer, changing only what differs, and writes the keys the server needs. |
| `web/` | The page (Vite, React 19) and `/stage`. |
| `_kustomize/`, `service.yaml`, `Dockerfile` | How Planton's Service Hub builds it and deploys it to demo, with its own public name, certificate and route. |

Two choices worth knowing:

- **Each customer has its own minting service account, inside its own organization.** A customer's key for Acme's ledger lives in a vault in that customer's organization, named in its embedding settings. Stigmer applies an organization's embedding vaults only to people minted by a service account of that same organization, so a minter per customer is what carries each customer's key into their own conversations and nobody else's.
- **The ledger server decides the customer from the key, never from the caller identity.** Stigmer's runner fills `X-Stigmer-Caller-Kind/-Value`, but on a public address anyone can send those headers, so they only name the person on an adjustment, after the key has passed.

## Why it is its own package

Unlike the rest of this repository, this folder has no proto, no resource API and no authorization engine of its own: it exists to show Stigmer. The chat panel is a dev build of Stigmer's open-source main, published only on Stigmer's npm store. npm picks a registry per scope, so this folder sends the `@stigmer` scope there (`.npmrc`) and keeps its own lockfile, outside the workspace, whose `@stigmer` packages come from npmjs.com. `@bufbuild/protobuf` is pinned to the version `@stigmer/apis` pins, since two copies break the types.

## Run it

```bash
npm ci
npm test && npm run typecheck && npm run build
```

Setup, against a Stigmer whose plan includes child organizations, with a key of an admin of `acme-books` bound to it (`stigmer apikey create --bound-org acme-books`):

```bash
STIGMER_URL=https://api.demo.stigmer.ai STIGMER_ADMIN_KEY=… ACME_SECRETS_FILE=~/acme-secrets.json \
  npm run setup -- --ledger-url https://acme.demo.stigmer.ai --origin https://acme.demo.stigmer.ai
```

Run it again whenever the address changes, before the first message: a conversation keeps the Agent version it started on. A second run prints "Nothing changed."

Locally, with the page at http://localhost:5173 (the agent's ledger server must still be reachable from Stigmer's sandboxes over https, so a local run serves the page only):

```bash
ACME_PASSCODE=… ACME_SECRETS_FILE=~/acme-secrets.json STIGMER_URL=https://api.demo.stigmer.ai npm start
```

The stage page's wake figure is copied, with its date, from stigmer's `brand/measurements.ts` (`SANDBOX_WAKE`).
