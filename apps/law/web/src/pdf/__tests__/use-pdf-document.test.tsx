/**
 * The document lifecycle invariant (use-pdf-document.ts): every
 * loading task created is destroyed — on unmount, on blob change, and
 * on the REJECT path (the backend's pdf-text.ts rule) — and a task is
 * never created at all for an already-unmounted viewer. The same
 * created/released rigor the old viewer's object-URL suite pinned.
 */

import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePdfDocument, type PdfDocumentState } from "../use-pdf-document.js";

const destroyed: unknown[] = [];
let nextLoad: () => Promise<unknown> = () => Promise.resolve({ numPages: 1 });
const getDocument = vi.fn((_args: { data: unknown }) => {
  const task = {
    promise: nextLoad(),
    destroy: vi.fn(async () => {
      destroyed.push(task);
    }),
  };
  return task;
});

vi.mock("../pdfjs.js", () => ({
  getDocument: (args: { data: unknown }) => getDocument(args),
  PDF_ASSET_OPTIONS: {},
}));

function Probe(props: { blob: Blob; onState: (s: PdfDocumentState) => void }) {
  props.onState(usePdfDocument(props.blob));
  return null;
}

/** jsdom's Blob has no arrayBuffer() — the minimal stand-in exposes
 * exactly the surface the hook consumes (per-suite, the matchMedia
 * stubbing precedent). */
function fakeBlob(): Blob {
  return { arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Blob;
}

beforeEach(() => {
  destroyed.length = 0;
  getDocument.mockClear();
  nextLoad = () => Promise.resolve({ numPages: 1 });
});

describe("usePdfDocument", () => {
  it("loads to ready and hands over a FRESH buffer, never the Blob", async () => {
    const states: PdfDocumentState[] = [];
    render(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);

    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(getDocument.mock.calls[0]?.[0]?.data).toBeInstanceOf(ArrayBuffer);
  });

  it("destroys the task on unmount (created/released pairing)", async () => {
    const states: PdfDocumentState[] = [];
    const view = render(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    view.unmount();
    expect(destroyed).toHaveLength(1);
  });

  it("a blob change destroys the old task and loads a new one", async () => {
    const states: PdfDocumentState[] = [];
    const view = render(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);
    await waitFor(() => expect(states.at(-1)?.status).toBe("ready"));

    view.rerender(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));
    expect(destroyed).toHaveLength(1);
  });

  it("never creates a task for a viewer unmounted mid-byte-read", async () => {
    const states: PdfDocumentState[] = [];
    const view = render(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);
    // Unmount synchronously — before blob.arrayBuffer() can resolve.
    view.unmount();

    // Let the abandoned async chain run to completion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("a rejected load answers the error state and destroy stays safe", async () => {
    nextLoad = () => Promise.reject(new Error("Invalid PDF structure"));
    const states: PdfDocumentState[] = [];
    const view = render(<Probe blob={fakeBlob()} onState={(s) => states.push(s)} />);

    await waitFor(() => expect(states.at(-1)?.status).toBe("error"));
    const last = states.at(-1);
    expect(last?.status === "error" && last.error.message).toBe("Invalid PDF structure");

    // The reject-path teardown (pdf-text.ts's rule): unmounting after a
    // failed load must still destroy the task.
    view.unmount();
    expect(destroyed).toHaveLength(1);
  });
});
