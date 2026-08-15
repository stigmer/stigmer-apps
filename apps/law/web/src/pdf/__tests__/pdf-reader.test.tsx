/**
 * Reader behavior against the ONE mock seam (pdfjs.ts): page
 * navigation, zoom, find (count, cycling, Ctrl+F interception), the
 * initialPage deep link, and windowing. jsdom renders no canvas —
 * REAL rendering is Playwright's assertion (the session-21 lesson:
 * a fake can encode the same wrong assumption as the code, so the
 * e2e layer must assert real output; this suite covers the state
 * machinery around the paint, not the paint).
 */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { computeLayout, scrollOffsetForPage, type PageSize } from "../geometry.js";

const PAGE_TEXTS = [
  "the limitation period runs from",
  "next hearing was adjourned",
  "no next hearing date was given",
  "annexure",
  "prayer",
];
const PAGE_SIZE: PageSize = { width: 612, height: 792 };

vi.mock("../pdfjs.js", () => {
  const fakePage = (n: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: PAGE_SIZE.width * scale,
      height: PAGE_SIZE.height * scale,
      scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }),
    streamTextContent: () => ({}),
    getTextContent: async () => ({ items: [{ str: PAGE_TEXTS[n - 1] ?? "" }] }),
  });
  return {
    getDocument: (_args: { data: unknown }) => ({
      promise: Promise.resolve({
        numPages: PAGE_TEXTS.length,
        getPage: async (n: number) => fakePage(n),
      }),
      destroy: async () => {},
    }),
    OutputScale: class {
      sx = 1;
      sy = 1;
      scaled = false;
    },
    TextLayer: class {
      async render() {}
      cancel() {}
    },
    PDF_ASSET_OPTIONS: {},
  };
});

// The reader's fit-width hook is the app's first ResizeObserver
// consumer; jsdom has none (per-suite stub, the matchMedia precedent).
beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());

/** jsdom's Blob has no arrayBuffer(); the mock never reads it anyway. */
const fakeBlob = () => ({ arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Blob;

// jsdom reports zero layout sizes, so the reader falls back to scale 1
// — expected offsets come from the SAME geometry the reader uses.
const LAYOUT = computeLayout(Array.from({ length: 5 }, () => PAGE_SIZE), 1);

async function renderReader(initialPage?: number) {
  const { default: PdfReader } = await import("../PdfReader.js");
  render(<PdfReader blob={fakeBlob()} label="vakalatnama.pdf" initialPage={initialPage} />);
  return screen.findByRole("region", { name: "vakalatnama.pdf" });
}

describe("PdfReader", () => {
  it("shows the page count and mounts only the windowed pages", async () => {
    await renderReader();
    expect(await screen.findByText("/ 5")).toBeInTheDocument();
    // Zero-height viewport windows page 1 ± overscan 2 → pages 1–3.
    expect(await screen.findByRole("group", { name: "Page 1 of 5" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Page 3 of 5" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Page 4 of 5" })).not.toBeInTheDocument();
  });

  it("initialPage scrolls to the cited page once (the ?page= seam)", async () => {
    const surface = await renderReader(4);
    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(LAYOUT, 4)));
    // The indicator follows: page 4 is now current.
    expect(screen.getByLabelText("Go to page")).toHaveValue("4");
  });

  it("the page jump form scrolls to the requested page and re-windows", async () => {
    const surface = await renderReader();
    const input = screen.getByLabelText("Go to page");
    await userEvent.clear(input);
    await userEvent.type(input, "5{Enter}");

    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(LAYOUT, 5)));
    expect(await screen.findByRole("group", { name: "Page 5 of 5" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Page 1 of 5" })).not.toBeInTheDocument();
  });

  it("an out-of-range page jump is refused, not clamped into a surprise", async () => {
    const surface = await renderReader();
    const input = screen.getByLabelText("Go to page");
    await userEvent.clear(input);
    await userEvent.type(input, "99{Enter}");
    expect(surface.scrollTop).toBe(0);
  });

  it("zoom steps move the percent display; Fit width returns to fit", async () => {
    await renderReader();
    expect(await screen.findByText("100%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("125%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    await userEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByText("80%")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("find counts matches across ALL pages, jumps to the first, Enter cycles with wrap", async () => {
    const surface = await renderReader();
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    const input = await screen.findByLabelText("Find in document");
    await userEvent.type(input, "next hearing");

    // Pages 2 and 3 match; the count proves the whole document was
    // searched, not just the mounted window — and the reader jumped to
    // the first match on its own (the native-find convention).
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(LAYOUT, 2)));
    await userEvent.type(input, "{Enter}");
    expect(await screen.findByText("2 of 2")).toBeInTheDocument();
    await waitFor(() => expect(surface.scrollTop).toBe(scrollOffsetForPage(LAYOUT, 3)));
    // Wraps back to the first match.
    await userEvent.type(input, "{Enter}");
    expect(await screen.findByText("1 of 2")).toBeInTheDocument();
  });

  it("an absent term answers 'No matches' honestly", async () => {
    await renderReader();
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    await userEvent.type(await screen.findByLabelText("Find in document"), "vakil");
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("Ctrl/Cmd+F inside the viewer opens the find bar; Escape closes it", async () => {
    const surface = await renderReader();
    surface.focus();
    await userEvent.keyboard("{Control>}f{/Control}");
    expect(await screen.findByLabelText("Find in document")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByLabelText("Find in document")).not.toBeInTheDocument();
  });
});
