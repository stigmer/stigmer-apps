/**
 * How the port reads an organization back: Stigmer rewrites an embedding vault's reference to the
 * organization's id, and the setup must still see the vault it wrote, or every run would rewrite
 * the embedding settings.
 */
import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ApiResourceKind } from "@stigmer/apis/ai/stigmer/commons/apiresource/apiresourcekind/api_resource_kind_pb";
import { OrganizationSchema } from "@stigmer/apis/ai/stigmer/tenancy/organization/v1/api_pb";
import { IamRole } from "@stigmer/apis/ai/stigmer/iam/v1/enum_pb";
import { toOrg } from "./stigmer-port.js";

describe("toOrg", () => {
  it("reads a vault reference stored by the organization's id as the organization's slug", () => {
    const org = create(OrganizationSchema, {
      metadata: { id: "org_1", slug: "blue-fern-press" },
      spec: {
        embedding: {
          createAccountsOnSignIn: true,
          signInRole: IamRole.member,
          allowedOrigins: ["http://localhost:5173"],
          vaults: [{ org: "org_1", kind: ApiResourceKind.vault, slug: "acme-ledger", id: "vlt_1" }],
        },
      },
    });
    expect(toOrg(org).embedding).toEqual({
      createAccountsOnSignIn: true,
      signInRole: "member",
      allowedOrigins: ["http://localhost:5173"],
      vaults: ["blue-fern-press/acme-ledger"],
    });
  });

  it("reads an organization with no embedding settings as none", () => {
    const org = create(OrganizationSchema, { metadata: { id: "org_2", slug: "acme-books" } });
    expect(toOrg(org).embedding).toEqual({ createAccountsOnSignIn: false, signInRole: "none", allowedOrigins: [], vaults: [] });
  });
});
