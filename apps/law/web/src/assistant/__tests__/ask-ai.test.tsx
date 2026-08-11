/**
 * The Ask AI surface — OUR half of it: affordance visibility per
 * config, the dock's expand/collapse/resize mechanics, the bootstrap
 * contract (org + instance + the cursor engine pin + the composer's
 * model/attachments/mode passthrough + session context), and every
 * designed failure state. The platform SDK is a mocked module boundary
 * (its own repo tests SessionViewer and SessionComposer); what these
 * tests pin is what WE hand it and when.
 *
 * jsdom has no matchMedia (the dock's docked-vs-sheet split reads it
 * live), so the suite stubs one whose answer each test controls.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAssistant, renderScreen } from "../../test-support/render.js";
import { AskAiAboutCaseButton, AskAiButton } from "../AskAiButton.js";
import { AssistantDock } from "../AssistantDock.js";
import { CreditNotice } from "../CreditNotice.js";
import type { Stigmer } from "@stigmer/sdk";

/* The SDK boundary: controllable hook returns, render-probe components. */
const createExecution = vi.fn();
let createError: Error | null = null;
let sessions: { metadata?: { id: string }; spec?: { subject: string } }[] = [];

vi.mock("@stigmer/react", async () => {
  const React = await import("react");
  return {
    StigmerProvider: (props: { children: unknown }) => props.children,
    SessionViewer: (props: {
      sessionId: string;
      audience?: string;
      enableGitHub?: boolean;
    }) => (
      <div
        data-testid="session-viewer"
        data-audience={props.audience}
        data-enable-github={String(props.enableGitHub)}
      >
        {props.sessionId}
      </div>
    ),
    /**
     * A probe standing in for the SDK composer: surfaces the presentation
     * flags as data attributes, honors the imperative setMessage handle
     * (the seed path), and submits with a KNOWN model + attachment so the
     * passthrough to execution creation is observable.
     */
    SessionComposer: React.forwardRef(function SessionComposerProbe(
      props: {
        onSubmit: (message: string, modelName?: string, context?: unknown) => void;
        harness?: string;
        showHarnessSelector?: boolean;
        showModelSelector?: boolean;
        enableAttachments?: boolean;
        interactionMode?: string;
        ariaLabel?: string;
      },
      ref: React.Ref<{ setMessage(m: string): void; focus(): void; submit(): void }>,
    ) {
      const [message, setMessage] = React.useState("");
      React.useImperativeHandle(ref, () => ({
        setMessage,
        focus: () => undefined,
        submit: () => undefined,
      }));
      return (
        <div
          data-testid="session-composer"
          data-harness={props.harness}
          data-show-harness-selector={String(props.showHarnessSelector)}
          data-show-model-selector={String(props.showModelSelector)}
          data-enable-attachments={String(props.enableAttachments)}
        >
          <textarea
            aria-label={props.ariaLabel}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button
            type="button"
            onClick={() =>
              props.onSubmit(message, "picked-model", {
                attachments: [{ storageKey: "att_1" }],
                interactionMode: props.interactionMode,
              })
            }
          >
            Ask
          </button>
        </div>
      );
    }),
    useCreateAgentExecution: () => ({
      create: createExecution,
      isCreating: false,
      error: createError,
      clearError: vi.fn(),
    }),
    useSessionList: () => ({
      sessions,
      isLoading: false,
      isRefetching: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});
vi.mock("@stigmer/sdk", () => ({
  Stigmer: class {
    constructor(public readonly config: unknown) {}
  },
}));

const ENABLED = {
  enabled: true,
  apiBaseUrl: "https://api.stigmer.example",
  org: "test-org",
  agentInstanceId: "agi_test",
  consoleUrl: "https://console.stigmer.example",
};

/** What the dock's live media query answers; per-test controllable. */
let viewportIsDesktop = true;

beforeEach(() => {
  createExecution.mockReset();
  createExecution.mockResolvedValue({ executionId: "exe_1", sessionId: "ses_created" });
  createError = null;
  sessions = [];
  viewportIsDesktop = true;
  window.localStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: viewportIsDesktop,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

function Surface(props: { fileNumber?: string }) {
  return (
    <>
      <AskAiButton />
      {props.fileNumber && <AskAiAboutCaseButton fileNumber={props.fileNumber} />}
      <AssistantDock />
    </>
  );
}

describe("Ask AI affordances (visibility per deployment config)", () => {
  it("an unconfigured deployment shows NO assistant affordance anywhere — buttons or strip", async () => {
    renderScreen({}, [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }], "/");
    // The config read resolves to enabled:false (the harness default);
    // nothing may appear before OR after it settles.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Ask AI" })).not.toBeInTheDocument());
    expect(screen.queryByText(/Ask AI about this matter/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Open Ask AI")).not.toBeInTheDocument();
  });

  it("a configured deployment offers both entries AND the collapsed edge strip", async () => {
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    expect(await screen.findByRole("button", { name: "Ask AI" })).toBeInTheDocument();
    expect(screen.getByText("Ask AI about this matter")).toBeInTheDocument();
    expect(screen.getByLabelText("Open Ask AI")).toBeInTheDocument();
  });
});

describe("The dock (desktop: expanded panel or collapsed strip — never gone)", () => {
  it("expands from the strip as a page landmark (no dialog), and collapses back with focus handed to the strip", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByLabelText("Open Ask AI"));

    // Docked = part of the page: an aside landmark, NOT a dialog.
    const panel = await screen.findByRole("complementary", { name: "Ask AI" });
    expect(panel).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Ask the assistant")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Collapse Ask AI" }));
    expect(screen.queryByRole("complementary", { name: "Ask AI" })).not.toBeInTheDocument();
    // The conversation is findable where it visibly went.
    await waitFor(() => expect(screen.getByLabelText("Open Ask AI")).toHaveFocus());
  });

  it("Escape does NOT close the docked panel — it belongs to the page, and to the composer's own menus", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByLabelText("Open Ask AI"));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("complementary", { name: "Ask AI" })).toBeInTheDocument();
  });

  it("resizes by keyboard on the separator — clamped, and remembered for the next visit", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByLabelText("Open Ask AI"));

    const handle = await screen.findByRole("separator", { name: "Resize the Ask AI panel" });
    expect(handle).toHaveAttribute("aria-valuenow", "448");

    // The handle is the panel's LEFT edge: ArrowLeft widens.
    handle.focus();
    await user.keyboard("{ArrowLeft}");
    expect(handle).toHaveAttribute("aria-valuenow", "464");
    expect(window.localStorage.getItem("law.assistant.width")).toBe("464");

    // Clamped: the work area keeps its 480px floor — the panel may take
    // everything else (jsdom window: 1024, so the ceiling is 544).
    for (let i = 0; i < 10; i++) await user.keyboard("{ArrowLeft}");
    expect(Number(handle.getAttribute("aria-valuenow"))).toBeLessThanOrEqual(544);
  });

  it("a remembered width is applied on the next open", async () => {
    window.localStorage.setItem("law.assistant.width", "400");
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByLabelText("Open Ask AI"));
    expect(
      await screen.findByRole("separator", { name: "Resize the Ask AI panel" }),
    ).toHaveAttribute("aria-valuenow", "400");
  });
});

describe("The sheet (small screens: no room to dock)", () => {
  it("opens as a dialog, and Escape closes it", async () => {
    viewportIsDesktop = false;
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    // No strip on a phone — the sidebar entry is the way in.
    expect(await screen.findByRole("button", { name: "Ask AI" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Open Ask AI")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    const sheet = await screen.findByRole("dialog", { name: "Ask AI" });
    expect(sheet).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close Ask AI" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).not.toBeInTheDocument();
  });
});

describe("The conversation bootstrap", () => {
  it("the case entry seeds the composer with the file number — the vocabulary the agent takes", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    await user.click(await screen.findByRole("button", { name: "Ask AI about this matter" }));

    expect(await screen.findByLabelText("Ask the assistant")).toHaveValue("About CS/2026/041: ");
  });

  it("hands the SDK composer the firm presentation: cursor engine pinned and hidden, model picker and attachments on", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByRole("button", { name: "Ask AI" }));

    const composer = await screen.findByTestId("session-composer");
    expect(composer).toHaveAttribute("data-harness", "cursor");
    expect(composer).toHaveAttribute("data-show-harness-selector", "false");
    expect(composer).toHaveAttribute("data-show-model-selector", "true");
    expect(composer).toHaveAttribute("data-enable-attachments", "true");
  });

  it("bootstraps with the org, the instance, the CURSOR engine pin, the seeded context — and the lawyer's model, attachments, and mode — then hands off to the endUser conversation", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    await user.click(await screen.findByRole("button", { name: "Ask AI about this matter" }));
    await user.type(await screen.findByLabelText("Ask the assistant"), "what happened last?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(createExecution).toHaveBeenCalledWith({
        org: "test-org",
        message: "About CS/2026/041: what happened last?",
        // The composer's choices pass through VERBATIM.
        modelName: "picked-model",
        attachments: [{ storageKey: "att_1" }],
        interactionMode: "agent",
        sessionSpec: {
          agentInstanceId: "agi_test",
          // THE pin: a session's engine is immutable after its first
          // turn, and the platform default is a different engine than
          // WhatsApp's (and currently broken in production).
          harness: "cursor",
          sessionContext:
            "This conversation is from the firm's web app. " +
            "This conversation was started from the web page of case CS/2026/041.",
        },
      }),
    );
    const viewer = await screen.findByTestId("session-viewer");
    expect(viewer).toHaveTextContent("ses_created");
    // endUser: agent locked, model/mode/attachments face the lawyer —
    // workspaces stay off (a lawyer has no repository to mount).
    expect(viewer).toHaveAttribute("data-audience", "endUser");
    expect(viewer).toHaveAttribute("data-enable-github", "false");
  });

  it("a failed start reads as a sentence, not a stack trace", async () => {
    createError = new Error("[failed_precondition] something platform-shaped");
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByRole("button", { name: "Ask AI" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /couldn't start this conversation/,
    );
  });

  it("recent conversations reopen by a click", async () => {
    sessions = [{ metadata: { id: "ses_old" }, spec: { subject: "Yesterday's hearing" } }];
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByRole("button", { name: "Ask AI" }));
    await user.click(await screen.findByText("Yesterday's hearing"));

    expect(await screen.findByTestId("session-viewer")).toHaveTextContent("ses_old");
  });
});

describe("CreditNotice (the firm's platform-credit standing, in lawyer language)", () => {
  function renderNotice(billing: {
    getBillingAccount: (org: string) => Promise<unknown>;
  }) {
    const stigmer = { billing } as unknown as Stigmer;
    return render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CreditNotice stigmer={stigmer} org="test-org" consoleUrl="https://console.stigmer.example" />
      </QueryClientProvider>,
    );
  }

  it("says OUT OF CREDITS, with the console recharge link, when the balance is exhausted", async () => {
    renderNotice({
      getBillingAccount: async () => ({
        balance: { availableMicros: 0n },
        lowBalanceThresholdMicros: 5_000_000n,
      }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/out of assistant credits/);
    expect(screen.getByRole("link", { name: /recharge in the Stigmer console/ })).toHaveAttribute(
      "href",
      "https://console.stigmer.example/settings/billing",
    );
  });

  it("warns below the org's OWN threshold — this app invents no money policy", async () => {
    renderNotice({
      getBillingAccount: async () => ({
        balance: { availableMicros: 2_000_000n },
        lowBalanceThresholdMicros: 5_000_000n,
      }),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(/running low/);
  });

  it("renders nothing on a healthy balance", async () => {
    renderNotice({
      getBillingAccount: async () => ({
        balance: { availableMicros: 9_000_000n },
        lowBalanceThresholdMicros: 5_000_000n,
      }),
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("renders nothing when billing is unavailable (self-hosted OSS) — never an error in the chat", async () => {
    renderNotice({
      getBillingAccount: async () => {
        throw new Error("unimplemented");
      },
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });
});
