# Licensing

This repository deliberately has no single top-level license. Licensing
follows the directory structure, one license per package:

| Path | Package | License |
|------|---------|---------|
| `packages/resource-api/` | `@stigmer/resource-api` | [Apache-2.0](packages/resource-api/LICENSE) |
| `packages/identity/` | `@stigmer/identity` | [Apache-2.0](packages/identity/LICENSE) |
| `apps/law/` | Stigmer Law | [AGPL-3.0-only](apps/law/LICENSE) |

The split is a design decision (project DD-002, reaffirmed in DD-003):

- **Commons are permissive (Apache-2.0)** so that anyone — including
  closed-source products — can build on the shared TypeScript resource-API
  foundation without license obligations.
- **Vertical apps are copyleft (AGPL-3.0)** so that the business can
  operate the apps while copyleft blocks closed-SaaS competitors — the
  Frappe/ERPNext split.

Every new package added to this repository must declare its license in its
own `LICENSE` file and `package.json`, and be added to the table above.
