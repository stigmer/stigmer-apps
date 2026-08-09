/**
 * Seeded identities — must match apps/law/backend/src/e2e/serve.ts (the
 * seeding side). Fictional by decree: the customer-data guard scans every
 * path of this public repo.
 */

export const ASHA = {
  email: "asha@acme.example",
  name: "Asha Rao",
  password: "sensible-e2e-passphrase",
} as const;

export const RAVI = {
  email: "ravi@acme.example",
  name: "Ravi Iyer",
  password: "sensible-e2e-passphrase",
} as const;

/** The seeded case (created by serve.ts as Asha). */
export const SEED_CASE = {
  caseNumber: "WP-1234/2026",
  clientName: "Acme Traders",
  caseType: "civil",
} as const;

/** DD-005's recorded uniform login failure — asserted verbatim. */
export const UNIFORM_LOGIN_FAILURE = "Email or password is incorrect";

/** The theft response — its ABSENCE is asserted by the two-tab test. */
export const THEFT_NOTICE = "Your session was ended for security reasons. Sign in again.";
