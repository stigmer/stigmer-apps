/**
 * Byte-route client tests (T04b D7): the one raw-fetch surface, so every
 * header of its contract is pinned — bearer auth, exact content-type,
 * URI-encoded x-file-name (non-ASCII filenames are normal here: party
 * names, Hindi) — plus the client-side pre-checks and the error shape.
 */

import { describe, expect, it, vi } from "vitest";
import { createFilesClient } from "../files.js";

const session = { getAccessToken: async () => "tok_1" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UPLOADED_DOCUMENT = {
  apiVersion: "law.stigmer.ai/v1",
  kind: "Document",
  metadata: { id: "doc_1" },
  spec: {
    caseId: "case_1",
    fileName: "वकालतनामा.pdf",
    mimeType: "application/pdf",
    sizeBytes: "3",
    objectKey: "cases/case_1/documents/x",
  },
};

describe("uploadDocument", () => {
  it("POSTs raw bytes with bearer, exact content-type, and URI-encoded filename", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, UPLOADED_DOCUMENT));
    const client = createFilesClient("http://api.example", session, fetchImpl as never);

    const file = new File([new Uint8Array([1, 2, 3])], "वकालतनामा.pdf", {
      type: "application/pdf",
    });
    const doc = await client.uploadDocument("case_1", file);

    expect(doc.metadata?.id).toBe("doc_1");
    expect(doc.spec?.sizeBytes).toBe(3n);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.example/files/cases/case_1/documents");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok_1");
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["x-file-name"]).toBe(encodeURIComponent("वकालतनामा.pdf"));
    expect(decodeURIComponent(headers["x-file-name"] as string)).toBe("वकालतनामा.pdf");
    expect(init.body).toBe(file);
  });

  it("pre-checks the mime type — an unsupported file never leaves the browser", async () => {
    const fetchImpl = vi.fn();
    const client = createFilesClient("", session, fetchImpl as never);
    const file = new File(["x"], "notes.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(client.uploadDocument("case_1", file)).rejects.toThrow(/PDF, PNG, or JPG/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pre-checks the 25 MB cap — an oversize file never leaves the browser", async () => {
    const fetchImpl = vi.fn();
    const client = createFilesClient("", session, fetchImpl as never);
    const big = new File([new Uint8Array(25 * 1024 * 1024 + 1)], "scan.pdf", {
      type: "application/pdf",
    });
    await expect(client.uploadDocument("case_1", big)).rejects.toThrow(/25 MB/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the server's own sentence from the {code, message} error body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(413, { code: "ResourceExhausted", message: "Document: upload exceeds the 25 MB limit" }),
    );
    const client = createFilesClient("", session, fetchImpl as never);
    const file = new File(["x"], "a.pdf", { type: "application/pdf" });
    await expect(client.uploadDocument("case_1", file)).rejects.toThrow(
      "Document: upload exceeds the 25 MB limit",
    );
  });
});

describe("downloadDocument", () => {
  it("GETs the content route with the bearer and returns the bytes", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([9, 9]), { status: 200 }));
    const client = createFilesClient("http://api.example", session, fetchImpl as never);

    const blob = await client.downloadDocument("doc_1");
    expect(blob.size).toBe(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://api.example/files/documents/doc_1/content");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok_1");
  });

  it("answers a readable sentence even when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const client = createFilesClient("", session, fetchImpl as never);
    await expect(client.downloadDocument("doc_1")).rejects.toThrow(/502/);
  });
});
