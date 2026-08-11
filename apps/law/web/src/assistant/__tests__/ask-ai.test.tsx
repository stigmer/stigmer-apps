/**
 * The Ask AI surface — OUR half of it: affordance visibility per
 * config, the panel's open/seed mechanics, the bootstrap contract
 * (org + instance + the cursor engine pin + session context), and every
 * designed failure state. The platform SDK is a mocked module boundary
 * (its own repo tests SessionViewer); what these tests pin is what WE
 * hand it and when.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAssistant, renderScreen } from "../../test-support/render.js";
import { AskAiAboutCaseButton, AskAiButton, AssistantHost } from "../AskAiButton.js";
import { CreditNotice } from "../CreditNotice.js";
import type { Stigmer } from "@stigmer/sdk";

/* The SDK boundary: controllable hook returns, render-probe components. */
const createExecution = vi.fn();
let createError: Error | null = null;
let sessions: { metadata?: { id: string }; spec?: { subject: string } }[] = [];

vi.mock("@stigmer/react", () => ({
  StigmerProvider: (props: { children: unknown }) => props.children,
  SessionViewer: (props: { sessionId: string; audience?: string }) => (
    <div data-testid="session-viewer" data-audience={props.audience}>
      {props.sessionId}
    </div>
  ),
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
}));
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

beforeEach(() => {
  createExecution.mockReset();
  createExecution.mockResolvedValue({ executionId: "exe_1", sessionId: "ses_created" });
  createError = null;
  sessions = [];
});

function Surface(props: { fileNumber?: string }) {
  return (
    <>
      <AskAiButton />
      {props.fileNumber && <AskAiAboutCaseButton fileNumber={props.fileNumber} />}
      <AssistantHost />
    </>
  );
}

describe("Ask AI affordances (visibility per deployment config)", () => {
  it("an unconfigured deployment shows NO assistant affordance anywhere", async () => {
    renderScreen({}, [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }], "/");
    // The config read resolves to enabled:false (the harness default);
    // nothing may appear before OR after it settles.
    await waitFor(() => expect(screen.queryByText("Ask AI")).not.toBeInTheDocument());
    expect(screen.queryByText(/Ask AI about this matter/)).not.toBeInTheDocument();
  });

  it("a configured deployment offers both entries", async () => {
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    expect(await screen.findByText("Ask AI")).toBeInTheDocument();
    expect(screen.getByText("Ask AI about this matter")).toBeInTheDocument();
  });
});

describe("The panel", () => {
  it("opens on Ask AI with an empty composer, and closes again", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByText("Ask AI"));

    const panel = await screen.findByRole("dialog", { name: "Ask AI" });
    expect(panel).toBeInTheDocument();
    expect(screen.getByLabelText("What do you need?")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Close Ask AI" }));
    expect(screen.queryByRole("dialog", { name: "Ask AI" })).not.toBeInTheDocument();
  });

  it("the case entry seeds the composer with the file number — the vocabulary the agent takes", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    await user.click(await screen.findByText("Ask AI about this matter"));

    expect(await screen.findByLabelText("What do you need?")).toHaveValue("About CS/2026/041: ");
  });

  it("bootstraps with the org, the instance, the CURSOR engine pin, and the seeded context — then hands off to the conversation", async () => {
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface fileNumber="CS/2026/041" /> }],
      "/",
    );
    await user.click(await screen.findByText("Ask AI about this matter"));
    await user.type(await screen.findByLabelText("What do you need?"), "what happened last?");
    await user.click(screen.getByRole("button", { name: "Ask" }));

    await waitFor(() =>
      expect(createExecution).toHaveBeenCalledWith({
        org: "test-org",
        message: "About CS/2026/041: what happened last?",
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
    // Guest is the pure-chat presentation: no engine/model vocabulary
    // ever faces a lawyer.
    expect(viewer).toHaveAttribute("data-audience", "guest");
  });

  it("a failed start reads as a sentence, not a stack trace", async () => {
    createError = new Error("[failed_precondition] something platform-shaped");
    const user = userEvent.setup();
    renderScreen(
      { assistant: fakeAssistant(ENABLED) },
      [{ path: "/", element: <Surface /> }],
      "/",
    );
    await user.click(await screen.findByText("Ask AI"));

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
    await user.click(await screen.findByText("Ask AI"));
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