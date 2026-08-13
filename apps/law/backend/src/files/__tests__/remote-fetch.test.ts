/**
 * The remote-fetch guard, rejection class by rejection class. The
 * fetch-path cases ride a loopback HTTP fixture through the
 * `allowPrivateNetworks` test seam (its one documented purpose); the
 * address-guard cases use IP-literal URLs so no test depends on DNS
 * answers. What CANNOT be unit-tested here — a public hostname
 * resolving privately — is covered by the same `isPublicAddress`
 * judgment the literal cases pin.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchRemoteDocument, isPublicAddress } from "../remote-fetch.js";
import { MAX_DOCUMENT_BYTES } from "../../domain/document/store-document.js";

const PDF_BYTES = Buffer.from("%PDF-1.7 probe fixture body");
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("png-body"),
]);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpg")]);

async function expectRefusal(url: string, code: Code, sentenceFragment: string) {
  const err = await fetchRemoteDocument(url, { allowPrivateNetworks: true }).then(
    () => undefined,
    (e: unknown) => ConnectError.from(e),
  );
  expect(err, `expected '${url}' to refuse`).toBeDefined();
  expect(err!.code).toBe(code);
  expect(err!.rawMessage).toContain(sentenceFragment);
}

describe("URL and address validation (no network)", () => {
  it("refuses text that is not a URL", async () => {
    const err = await fetchRemoteDocument("not a link").catch((e: unknown) => ConnectError.from(e));
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
  });

  it("refuses plain http outside the test seam", async () => {
    const err = await fetchRemoteDocument("http://example.com/f.pdf").catch((e: unknown) =>
      ConnectError.from(e),
    );
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    expect((err as ConnectError).rawMessage).toContain("https");
  });

  it.each([
    "https://127.0.0.1/f.pdf",
    "https://10.0.0.8/f.pdf",
    "https://172.16.4.2/f.pdf",
    "https://192.168.1.10/f.pdf",
    "https://169.254.169.254/latest/meta-data", // cloud metadata
    "https://100.64.0.1/f.pdf", // CGNAT
    "https://0.0.0.0/f.pdf",
    "https://[::1]/f.pdf",
    "https://[fd00::1]/f.pdf",
    "https://[fe80::1]/f.pdf",
    "https://[::ffff:10.0.0.1]/f.pdf",
  ])("refuses the non-public literal %s", async (url) => {
    const err = await fetchRemoteDocument(url).catch((e: unknown) => ConnectError.from(e));
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    expect((err as ConnectError).rawMessage).toContain("not reachable");
  });

  it("resolves hostnames and judges the answer (localhost is private)", async () => {
    const err = await fetchRemoteDocument("https://localhost/f.pdf").catch((e: unknown) =>
      ConnectError.from(e),
    );
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    expect((err as ConnectError).rawMessage).toContain("not reachable");
  });

  it("judges address classes", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("104.18.2.1")).toBe(true);
    expect(isPublicAddress("2606:4700::1")).toBe(true);
    expect(isPublicAddress("10.255.255.255")).toBe(false);
    expect(isPublicAddress("172.31.0.1")).toBe(false);
    expect(isPublicAddress("172.32.0.1")).toBe(true); // just past the RFC1918 block
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("not-an-ip")).toBe(false);
  });
});

describe("fetching (loopback fixture through the test seam)", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/doc.pdf") {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(PDF_BYTES);
      } else if (path === "/image.png") {
        res.writeHead(200);
        res.end(PNG_BYTES);
      } else if (path === "/photo.jpg") {
        res.writeHead(200);
        res.end(JPEG_BYTES);
      } else if (path === "/lying-content-type.txt") {
        // Claims PDF, serves text — the sniff must win over the header.
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("just some words, no magic bytes");
      } else if (path === "/expired") {
        res.writeHead(403);
        res.end("expired");
      } else if (path === "/broken") {
        res.writeHead(500);
        res.end("boom");
      } else if (path === "/redirect") {
        res.writeHead(302, { location: `${base}/doc.pdf` });
        res.end();
      } else if (path === "/declared-oversize") {
        res.writeHead(200, { "content-length": String(MAX_DOCUMENT_BYTES + 1) });
        res.end(); // headers are enough — the guard refuses before reading
      } else if (path === "/streamed-oversize") {
        // No Content-Length: the streaming cap has to catch it.
        res.writeHead(200);
        const chunk = Buffer.alloc(1024 * 1024, 0x25);
        for (let sent = 0; sent <= MAX_DOCUMENT_BYTES; sent += chunk.length) {
          res.write(chunk);
        }
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("fetches a PDF and types it from its bytes", async () => {
    const fetched = await fetchRemoteDocument(`${base}/doc.pdf`, { allowPrivateNetworks: true });
    expect(fetched.mimeType).toBe("application/pdf");
    expect(fetched.bytes.equals(PDF_BYTES)).toBe(true);
  });

  it("recognizes PNG and JPEG by magic bytes", async () => {
    const png = await fetchRemoteDocument(`${base}/image.png`, { allowPrivateNetworks: true });
    expect(png.mimeType).toBe("image/png");
    const jpg = await fetchRemoteDocument(`${base}/photo.jpg`, { allowPrivateNetworks: true });
    expect(jpg.mimeType).toBe("image/jpeg");
  });

  it("refuses content whose bytes are not PDF/PNG/JPG, whatever the header claims", async () => {
    await expectRefusal(`${base}/lying-content-type.txt`, Code.InvalidArgument, "not a PDF");
  });

  it("answers the expired-link class with the resend instruction", async () => {
    await expectRefusal(`${base}/expired`, Code.FailedPrecondition, "sent again");
  });

  it("names the HTTP status on other failures", async () => {
    await expectRefusal(`${base}/broken`, Code.FailedPrecondition, "HTTP 500");
  });

  it("refuses redirects", async () => {
    await expectRefusal(`${base}/redirect`, Code.FailedPrecondition, "could not be reached");
  });

  it("refuses an over-cap Content-Length before reading the body", async () => {
    await expectRefusal(`${base}/declared-oversize`, Code.ResourceExhausted, "MB limit");
  });

  it("caps a stream that never declared its length", async () => {
    await expectRefusal(`${base}/streamed-oversize`, Code.ResourceExhausted, "MB limit");
  });

  it("refuses an unreachable port with the one honest sentence", async () => {
    await expectRefusal("http://127.0.0.1:1/nothing", Code.FailedPrecondition, "could not be reached");
  });
});
