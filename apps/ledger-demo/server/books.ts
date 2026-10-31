/**
 * Acme Books' books: each customer's quarter from the fixtures, plus the adjustments posted since
 * the server started, held in memory. A restart of Acme's server starts the quarter over, which is
 * what a rehearsal wants; Stigmer's server restarting does not touch them.
 *
 * Every read and write names its customer, and nothing here can reach across: the customer is
 * decided by the caller (the page's signed-in person, or the ledger server's key), never by an
 * argument the agent writes.
 */
import { ACCOUNTS, type Account, type Customer } from "../fixtures/books.js";

/** An adjustment posted to a customer's books. */
export interface Adjustment {
  readonly id: string;
  readonly at: string;
  readonly from: Account;
  readonly to: Account;
  readonly amount: number;
  readonly reason: string;
  /** Who asked for it: the person the call came for, and how it reached the books. */
  readonly by: string;
}

/** One account's line in the variance view. */
export interface AccountView {
  readonly account: Account;
  readonly budget: number;
  readonly actual: number;
  readonly variance: number;
}

/** What the page shows for a customer. */
export interface BooksView {
  readonly customer: { readonly slug: string; readonly name: string; readonly quarter: string };
  readonly accounts: readonly AccountView[];
  readonly lines: Customer["lines"];
  readonly adjustments: readonly Adjustment[];
}

/** A refused adjustment, worded for the agent that asked. */
export class AdjustmentRefused extends Error {}

/** The largest single adjustment the books accept: a guard against a runaway amount, not a policy. */
const MAX_AMOUNT = 1_000_000;

export function isAccount(value: string): value is Account {
  return (ACCOUNTS as readonly string[]).includes(value);
}

export class Books {
  private readonly adjustments = new Map<string, Adjustment[]>();
  private seq = 0;

  constructor(private readonly customers: readonly Customer[]) {}

  /** The customer's quarter: budget against actual per account, the lines, and what was posted. */
  view(customer: Customer): BooksView {
    const posted = this.adjustments.get(customer.slug) ?? [];
    const accounts = ACCOUNTS.map((account) => {
      const booked = customer.lines.filter((l) => l.account === account).reduce((sum, l) => sum + l.amount, 0);
      const moved = posted.reduce((sum, a) => sum + (a.to === account ? a.amount : 0) - (a.from === account ? a.amount : 0), 0);
      const actual = booked + moved;
      return { account, budget: customer.budgets[account], actual, variance: actual - customer.budgets[account] };
    });
    return {
      customer: { slug: customer.slug, name: customer.name, quarter: customer.quarter },
      accounts,
      lines: customer.lines,
      adjustments: posted,
    };
  }

  /** Moves `amount` from one account to another in the customer's books. */
  post(customer: Customer, input: { from: string; to: string; amount: number; reason: string; by: string }): Adjustment {
    if (!this.customers.includes(customer)) throw new AdjustmentRefused("Unknown customer.");
    if (!isAccount(input.from) || !isAccount(input.to)) {
      throw new AdjustmentRefused(`Accounts are ${ACCOUNTS.join(", ")}.`);
    }
    if (input.from === input.to) throw new AdjustmentRefused("The two accounts must differ.");
    if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > MAX_AMOUNT) {
      throw new AdjustmentRefused(`The amount must be more than 0 and at most ${MAX_AMOUNT}.`);
    }
    if (input.reason.trim() === "") throw new AdjustmentRefused("Give the reason in one line.");
    const adjustment: Adjustment = {
      id: `adj-${++this.seq}`,
      at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      amount: Math.round(input.amount * 100) / 100,
      reason: input.reason.trim(),
      by: input.by,
    };
    this.adjustments.set(customer.slug, [...(this.adjustments.get(customer.slug) ?? []), adjustment]);
    return adjustment;
  }

  /** Starts every customer's quarter over (a rehearsal's reset). */
  reset(): void {
    this.adjustments.clear();
  }
}
