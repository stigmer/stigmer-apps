/**
 * The presenter's opening, at `/stage`: the five things a team builds to put an agent in its
 * product, each struck through as the demo shows Stigmer doing it. Keys 1 to 5 tick them, 0 clears;
 * the turn line shows once all five are ticked.
 *
 * The words are the build-it-yourself list's, the same on stigmer.ai and in the video; a change
 * there is a change here. The order is the job's: the demo shows the computer first, then the
 * approval, the restart, the walls and the keys.
 */
import { useEffect, useState } from "react";

interface Item {
  readonly worry: string;
  readonly build: string;
  readonly stigmer: string;
}

export const ITEMS: readonly Item[] = [
  {
    worry: "Can the agent's code touch your servers?",
    build: "a sandbox you run yourself",
    stigmer: "each customer's agent gets its own computer",
  },
  {
    worry: "Will it act before anyone says yes?",
    build: "hand-rolled approval flags",
    stigmer: "it asks before acting on what you mark",
  },
  {
    worry: "What if the server restarts mid-job?",
    build: "queues, retries and timeouts you wrote",
    stigmer: "it works for hours and survives restarts",
  },
  {
    worry: "Can one customer's agent see another's files?",
    build: "tenant checks in your own code",
    stigmer: "agents, files and keys stay apart",
  },
  {
    worry: "Who holds your model keys and data?",
    build: "a hosted vendor that keeps both",
    stigmer: "your model keys, on your servers or ours",
  },
];

export const TURN_LINE = "You could build all of that. Or use Stigmer.";

/**
 * How long a sleeping conversation takes to be working again, as stigmer's `brand/measurements.ts`
 * (`SANDBOX_WAKE`) records it: Stigmer Cloud's preprod environment, measured 2026-10-31, the median
 * wait a person sees when the sandbox wakes on its node. Copied as a dated figure, not computed.
 */
export const WAKE = { seconds: 2.53, measuredOn: "2026-10-31", environment: "Stigmer Cloud, preprod" } as const;

export function Stage() {
  const [ticked, setTicked] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= "0" && e.key <= "5") setTicked(Number(e.key));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="stage">
      <h1>What it takes to put an agent in your product</h1>
      <ol className="stage-list">
        {ITEMS.map((item, i) => {
          const done = i < ticked;
          return (
            <li key={item.build} className={done ? "is-done" : undefined}>
              <span className="stage-worry">{item.worry}</span>
              <span className="stage-build">{item.build}</span>
              <span className="stage-gives" aria-hidden={!done}>
                {item.stigmer}
                {i === 0 && done && (
                  <span className="stage-figure">
                    awake again in {WAKE.seconds.toFixed(1)} s · {WAKE.environment}, {WAKE.measuredOn}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <p className={ticked === ITEMS.length ? "stage-turn is-shown" : "stage-turn"}>{TURN_LINE}</p>
    </div>
  );
}
