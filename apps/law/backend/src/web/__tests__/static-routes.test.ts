/**
 * Static handler tests (T04b D1). The handler is exercised through a real
 * http.Server with a fallthrough marker standing in for the Connect
 * adapter, so the boolean contract ("false lets the caller fall through")
 * is tested exactly as server.ts consumes it.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStaticRoutes, detectWebRoot } from "../static-routes.js";

const INDEX_HTML = "<!doctype html><title>law</title>";
const ASSET_JS = "console.log('hashed asset');";

describe("static routes (T04b D1)", () => {
  let server: http.Server;
  let baseUrl: string;
  let root: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "law-static-"));
    writeFileSync(path.join(root, "index.html"), INDEX_HTML);
    writeFileSync(path.join(root, "favicon.svg"), "<svg/>");
    mkdirSync(path.join(root, "assets"));
    writeFileSync(path.join(root, "assets", "app-abc123.js"), ASSET_JS);
    // A file OUTSIDE the web root — the traversal target.
    writeFileSync(path.join(root, "..", "law-static-secret.txt"), "secret");

    const staticRoutes = createStaticRoutes(root);
    server = http.createServer((req, res) => {
      if (staticRoutes(req, res)) return;
      // Stands in for the Connect adapter.
      res.writeHead(299, { "content-type": "text/plain" });
      res.end("fell through");
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("serves index.html at / with no-store (a deploy is visible on next load)", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves hashed assets as immutable", async () => {
    const res = await fetch(`${baseUrl}/assets/app-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(ASSET_JS);
  });

  it("serves other files with revalidation", async () => {
    const res = await fetch(`${baseUrl}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers client-routed paths with index.html (SPA fallback)", async () => {
    for (const route of ["/cases/case_01ABC", "/inbox", "/login"]) {
      const res = await fetch(`${baseUrl}${route}`);
      expect(res.status, route).toBe(200);
      expect(await res.text(), route).toBe(INDEX_HTML);
      expect(res.headers.get("cache-control"), route).toBe("no-store");
    }
  });

  it("404s a missing asset instead of serving index.html as JavaScript", async () => {
    const res = await fetch(`${baseUrl}/assets/app-gone999.js`);
    expect(res.status).toBe(404);
  });

  it("refuses path traversal out of the web root", async () => {
    for (const attempt of [
      "/../law-static-secret.txt",
      "/assets/../../law-static-secret.txt",
      "/%2e%2e/law-static-secret.txt",
    ]) {
      const res = await fetch(`${baseUrl}${attempt}`);
      expect(res.status, attempt).toBe(404);
      expect(await res.text(), attempt).not.toContain("secret");
    }
  });

  it("supports HEAD with headers and no body", async () => {
    const res = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(INDEX_HTML.length));
    expect(await res.text()).toBe("");
  });

  it("declines Connect paths — an unknown RPC must get Connect's answer, not HTML", async () => {
    const res = await fetch(`${baseUrl}/stigmer.law.case.v1.CaseService/Get`);
    expect(res.status).toBe(299);
    expect(await res.text()).toBe("fell through");
  });

  it("declines non-GET/HEAD methods", async () => {
    const res = await fetch(`${baseUrl}/anything`, { method: "POST" });
    expect(res.status).toBe(299);
  });

  it("detectWebRoot finds a built layout and rejects an empty one", () => {
    expect(detectWebRoot(path.join(root, ".."))).toBeUndefined();
    // A dir whose public/ carries index.html — the built-image layout.
    const built = mkdtempSync(path.join(tmpdir(), "law-built-"));
    mkdirSync(path.join(built, "public"));
    writeFileSync(path.join(built, "public", "index.html"), "x");
    expect(detectWebRoot(built)).toBe(path.join(built, "public"));
  });
});
