/**
 * The firm's platform-credit standing, in lawyer language. Reads the
 * org's billing account with the member's own token (the platform lets
 * any org member VIEW billing; only admins manage it) and speaks up in
 * exactly two states, using the org's OWN configured low-balance
 * threshold — this app invents no money policy:
 *
 * - exhausted: the assistant will not answer until someone recharges;
 * - low: it still answers, but the runway is short.
 *
 * Anything else — healthy balance, a deployment without platform
 * billing (self-hosted OSS), a member the org denies the read — renders
 * NOTHING. A billing hiccup must never block or noise up the chat.
 * Recharging is deliberately a deep link to the platform console: the
 * law app holds no payment surface (v1 decision on record).
 */

import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import type { Stigmer } from "@stigmer/sdk";

export function CreditNotice(props: {
  stigmer: Stigmer;
  org: string;
  consoleUrl: string;
}) {
  const account = useQuery({
    queryKey: ["assistant", "billing-account", props.org],
    queryFn: () => props.stigmer.billing.getBillingAccount(props.org),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const balance = account.data?.balance;
  if (!balance) return null;

  const exhausted = balance.availableMicros <= 0n;
  const threshold = account.data?.lowBalanceThresholdMicros ?? 0n;
  const low = !exhausted && threshold > 0n && balance.availableMicros < threshold;
  if (!exhausted && !low) return null;

  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-card border px-3 py-2 text-sm ${
        exhausted
          ? "border-danger/40 bg-danger-surface text-danger"
          : "border-warn/40 bg-warn-surface text-warn"
      }`}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium">
          {exhausted
            ? "The firm is out of assistant credits"
            : "The firm's assistant credits are running low"}
        </p>
        <p className="mt-0.5">
          {exhausted
            ? "The assistant can't answer until the credits are topped up. "
            : "The assistant still works, but not for much longer. "}
          Whoever administers the firm's Stigmer account can{" "}
          <a
            href={`${props.consoleUrl}/settings/billing`}
            target="_blank"
            rel="noreferrer"
            className="font-medium underline"
          >
            recharge in the Stigmer console
          </a>
          .
        </p>
      </div>
    </div>
  );
}
