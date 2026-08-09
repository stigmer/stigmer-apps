/**
 * Bearer interceptor tests (T04b D4's backstop): the interceptor is
 * composed over Connect's in-memory router transport, so header handling
 * and the refresh-once retry are tested through real client machinery.
 */

import { Code, ConnectError, createClient, createRouterTransport } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { AuthService } from "../../gen/stigmer/identity/auth/v1/auth_pb.js";
import { createBearerInterceptor, type TokenSource } from "../transport.js";

/**
 * WhoAmI stands in for any authenticated unary RPC — the interceptor is
 * service-agnostic; only the header contract matters here.
 */
function serverAcceptingOnly(validToken: string, seenTokens: string[]) {
  return createRouterTransport(
    ({ service }) => {
      service(AuthService, {
        whoAmI(_req, ctx) {
          const presented = ctx.requestHeader.get("authorization") ?? "";
          seenTokens.push(presented);
          if (presented !== `Bearer ${validToken}`) {
            throw new ConnectError("Your session has expired. Log in again.", Code.Unauthenticated);
          }
          return { spec: { email: "asha@acme.example" } };
        },
      });
    },
    { transport: { interceptors: [] } },
  );
}

function tokenSource(tokens: string[]): TokenSource & { invalidations: number } {
  let index = 0;
  const source = {
    invalidations: 0,
    async getAccessToken() {
      const token = tokens[Math.min(index, tokens.length - 1)];
      if (!token) throw new Error("test misconfiguration: no tokens");
      return token;
    },
    invalidateAccessToken() {
      source.invalidations += 1;
      index += 1;
    },
  };
  return source;
}

describe("bearer interceptor", () => {
  it("attaches the current access token", async () => {
    const seen: string[] = [];
    const session = tokenSource(["tok_good"]);
    const transport = createRouterTransport(
      ({ service }) => {
        service(AuthService, {
          whoAmI(_req, ctx) {
            seen.push(ctx.requestHeader.get("authorization") ?? "");
            return {};
          },
        });
      },
      { transport: { interceptors: [createBearerInterceptor(session)] } },
    );

    await createClient(AuthService, transport).whoAmI({});
    expect(seen).toEqual(["Bearer tok_good"]);
    expect(session.invalidations).toBe(0);
  });

  it("on UNAUTHENTICATED: invalidates, refreshes, retries once — and succeeds", async () => {
    const seen: string[] = [];
    const session = tokenSource(["tok_stale", "tok_fresh"]);
    const base = serverAcceptingOnly("tok_fresh", seen);
    const transport = createRouterTransport(
      ({ service }) => {
        // Delegate to the strict server through a second client so the
        // interceptor under test wraps the outermost transport.
        const inner = createClient(AuthService, base);
        service(AuthService, {
          whoAmI: (req, ctx) =>
            inner.whoAmI(req, { headers: { authorization: ctx.requestHeader.get("authorization") ?? "" } }),
        });
      },
      { transport: { interceptors: [createBearerInterceptor(session)] } },
    );

    const user = await createClient(AuthService, transport).whoAmI({});
    expect(user.spec?.email).toBe("asha@acme.example");
    expect(seen).toEqual(["Bearer tok_stale", "Bearer tok_fresh"]);
    expect(session.invalidations).toBe(1);
  });

  it("gives up after one retry — the session kit has already ended the session by then", async () => {
    const seen: string[] = [];
    const session = tokenSource(["tok_stale", "tok_still_stale"]);
    const base = serverAcceptingOnly("tok_never", seen);
    const transport = createRouterTransport(
      ({ service }) => {
        const inner = createClient(AuthService, base);
        service(AuthService, {
          whoAmI: (req, ctx) =>
            inner.whoAmI(req, { headers: { authorization: ctx.requestHeader.get("authorization") ?? "" } }),
        });
      },
      { transport: { interceptors: [createBearerInterceptor(session)] } },
    );

    await expect(createClient(AuthService, transport).whoAmI({})).rejects.toSatisfy(
      (err: unknown) => ConnectError.from(err).code === Code.Unauthenticated,
    );
    expect(seen).toHaveLength(2);
    expect(session.invalidations).toBe(1);
  });

  it("does not touch the token on non-auth failures", async () => {
    const session = tokenSource(["tok_good"]);
    const transport = createRouterTransport(
      ({ service }) => {
        service(AuthService, {
          whoAmI() {
            throw new ConnectError("User 'usr_gone' not found", Code.NotFound);
          },
        });
      },
      { transport: { interceptors: [createBearerInterceptor(session)] } },
    );

    await expect(createClient(AuthService, transport).whoAmI({})).rejects.toSatisfy(
      (err: unknown) => ConnectError.from(err).code === Code.NotFound,
    );
    expect(session.invalidations).toBe(0);
  });
});
