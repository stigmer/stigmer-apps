/**
 * Acme Books' world, as data: the integrator, its two customers, the people who sign in for each,
 * and each customer's quarter. Acme's server keeps the books from it, the page draws them, the
 * setup builds each customer's organization from it, and each customer's `ledger.csv` (the file the
 * presenter attaches) is printed from it, so none of them can disagree.
 *
 * Every name is fictional. Northwind Books is the customer the Getting Started pages already use;
 * its quarter holds exactly one unmistakable miscoding: a design tool's annual subscription booked
 * to Marketing. That line is the whole of Marketing's overspend and of Software's underspend, so
 * moving it leaves both on budget. Blue Fern Press's quarter is clean.
 */

/** The accounts every customer's books use, in the order the page lists them. */
export const ACCOUNTS = ["Marketing", "Software", "Travel", "Office"] as const;

export type Account = (typeof ACCOUNTS)[number];

/** Acme Books, the integrator: its organization, and the Agent it shares with every customer. */
export const ACME = {
  name: "Acme Books",
  org: "acme-books",
  agent: "variance-reporter",
} as const;

/** A person at a customer, as Acme's own sign-in knows them. */
export interface Person {
  /** Acme's user id: stable, so every token minted for it belongs to the same Stigmer account. */
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** One booked line of the quarter. */
export interface Line {
  readonly date: string;
  readonly vendor: string;
  readonly description: string;
  readonly account: Account;
  readonly amount: number;
}

/** One of Acme's customers, with its organization under Acme's. */
export interface Customer {
  /** The child organization's slug, which is also the key Acme's server files the customer under. */
  readonly slug: string;
  readonly name: string;
  /** Acme's own id for the customer, the child organization's external id. */
  readonly externalId: string;
  readonly people: readonly Person[];
  readonly quarter: string;
  readonly budgets: Readonly<Record<Account, number>>;
  readonly lines: readonly Line[];
}

export const CUSTOMERS: readonly Customer[] = [
  {
    slug: "northwind-books",
    name: "Northwind Books",
    externalId: "cust-4411",
    people: [{ id: "usr-dana", name: "Dana", email: "dana@northwind.example" }],
    quarter: "Q3 2026",
    budgets: { Marketing: 30000, Software: 14000, Travel: 6000, Office: 4000 },
    lines: [
      { date: "2026-07-03", vendor: "Brightwave Media", description: "Search ads, July", account: "Marketing", amount: 9800 },
      { date: "2026-07-14", vendor: "Ledgerly", description: "Accounting software, annual plan", account: "Software", amount: 6000 },
      { date: "2026-07-21", vendor: "Northline Rail", description: "Book fair, Leeds: travel", account: "Travel", amount: 1850 },
      { date: "2026-08-02", vendor: "Paper & Ink Co.", description: "Autumn catalogue print run", account: "Marketing", amount: 11400 },
      { date: "2026-08-11", vendor: "Pixelform", description: "Design tool, annual subscription, 20 seats", account: "Marketing", amount: 4800 },
      { date: "2026-08-19", vendor: "Cloudnine Hosting", description: "Web shop hosting, Q3", account: "Software", amount: 3200 },
      { date: "2026-08-27", vendor: "Deskwise", description: "Office supplies", account: "Office", amount: 2130 },
      { date: "2026-09-05", vendor: "Brightwave Media", description: "Social ads, September", account: "Marketing", amount: 8800 },
      { date: "2026-09-16", vendor: "Northline Rail", description: "Author visits: travel", account: "Travel", amount: 3800 },
      { date: "2026-09-24", vendor: "Deskwise", description: "Printer toner and paper", account: "Office", amount: 1990 },
    ],
  },
  {
    slug: "blue-fern-press",
    name: "Blue Fern Press",
    externalId: "cust-5208",
    people: [{ id: "usr-priya", name: "Priya", email: "priya@bluefern.example" }],
    quarter: "Q3 2026",
    budgets: { Marketing: 18000, Software: 7000, Travel: 4000, Office: 3000 },
    lines: [
      { date: "2026-07-08", vendor: "Brightwave Media", description: "Search ads, summer list", account: "Marketing", amount: 7600 },
      { date: "2026-07-17", vendor: "Ledgerly", description: "Accounting software, annual plan", account: "Software", amount: 4100 },
      { date: "2026-08-06", vendor: "Paper & Ink Co.", description: "Poetry series print run", account: "Marketing", amount: 9900 },
      { date: "2026-08-21", vendor: "Northline Rail", description: "Festival stand: travel", account: "Travel", amount: 3700 },
      { date: "2026-09-02", vendor: "Cloudnine Hosting", description: "Web shop hosting, Q3", account: "Software", amount: 2800 },
      { date: "2026-09-18", vendor: "Deskwise", description: "Office supplies", account: "Office", amount: 2900 },
    ],
  },
];

/** The customer filed under `slug`, or undefined. */
export function customerBySlug(slug: string): Customer | undefined {
  return CUSTOMERS.find((c) => c.slug === slug);
}

/** The customer a person signs in for, and the person, by Acme's user id. */
export function personById(id: string): { customer: Customer; person: Person } | undefined {
  for (const customer of CUSTOMERS) {
    const person = customer.people.find((p) => p.id === id);
    if (person) return { customer, person };
  }
  return undefined;
}

/** The quarter as the file the presenter attaches: one row per line, with a header. */
export function ledgerCsv(customer: Customer): string {
  const quote = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const rows = customer.lines.map((l) => [l.date, quote(l.vendor), quote(l.description), l.account, String(l.amount)].join(","));
  return ["date,vendor,description,account,amount", ...rows].join("\n") + "\n";
}
