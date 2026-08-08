/**
 * The User kind's storage registration, exported so the consuming app can
 * spread it into its own `PostgresResourceStore` config — the app stays
 * the composition root (one store, every kind, cross-package references
 * resolve by kind through it), and this mapping stays beside the
 * migration it must mirror.
 */

import type { PostgresKindConfig } from "@stigmer/resource-api/postgres";
import { UserSchema } from "../gen/stigmer/identity/user/v1/user_pb.js";
import { USER_KIND } from "../user-resource.js";

export function identityStoreKinds(): Record<string, PostgresKindConfig> {
  return {
    [USER_KIND]: {
      schema: UserSchema,
      table: "users",
      naturalKey: { column: "email", jsonField: "email" },
      columns: {
        email: "email",
      },
    },
  };
}
