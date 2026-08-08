import type { IncomingMessage } from "node:http";
import type { HandlerContext } from "@connectrpc/connect";
import { describe, expect, it } from "vitest";
import { bearerTokenAuthenticator } from "../authenticator.js";
import { generateEphemeralSigningKeys } from "../keys.js";
import { createAccessTokenIssuer } from "../token.js";
import { createCallerResolver } from "../transport.js";

function connectCtx(headers: Record<string, string>): HandlerContext {
  return { requestHeader: new Headers(headers) } as unknown as HandlerContext;
}

function httpReq(headers: Record<string, string | string[]>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe("createCallerResolver", () => {
  it("resolves the same credential identically on both transports", async () => {
    const issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
    const resolver = createCallerResolver([bearerTokenAuthenticator(issuer)]);
    const token = await issuer.issue("user_7");

    const expected = { id: "user_7", kind: "user" };
    expect(await resolver.fromConnect(connectCtx({ authorization: `Bearer ${token}` }))).toEqual(expected);
    expect(await resolver.fromHttp(httpReq({ authorization: `Bearer ${token}` }))).toEqual(expected);
  });

  it("accepts RFC 6750 scheme case-insensitively", async () => {
    const issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
    const resolver = createCallerResolver([bearerTokenAuthenticator(issuer)]);
    const token = await issuer.issue("user_8");

    expect(await resolver.fromConnect(connectCtx({ authorization: `bearer ${token}` }))).toBeDefined();
    expect(await resolver.fromConnect(connectCtx({ authorization: `BEARER ${token}` }))).toBeDefined();
  });

  it("treats missing or malformed headers as no credential, never an error", async () => {
    const issuer = createAccessTokenIssuer(await generateEphemeralSigningKeys());
    const resolver = createCallerResolver([bearerTokenAuthenticator(issuer)]);

    expect(await resolver.fromConnect(connectCtx({}))).toBeUndefined();
    expect(await resolver.fromConnect(connectCtx({ authorization: "Basic dXNlcjpwdw==" }))).toBeUndefined();
    expect(await resolver.fromConnect(connectCtx({ authorization: "Bearer" }))).toBeUndefined();
    expect(await resolver.fromHttp(httpReq({}))).toBeUndefined();
  });
});
