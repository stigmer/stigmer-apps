/**
 * Seeded identities — must match apps/law/backend/src/e2e/serve.ts (the
 * seeding side). Fictional by decree: the customer-data guard scans every
 * path of this public repo.
 */

export const ASHA = {
  email: "asha@acme.example",
  name: "Asha Rao",
  password: "sensible-e2e-passphrase",
  role: "managing partner",
} as const;

export const RAVI = {
  email: "ravi@acme.example",
  name: "Ravi Iyer",
  password: "sensible-e2e-passphrase",
  role: "associate",
} as const;

/** The seeded client + case (created by serve.ts as Ravi, the lead). */
export const SEED_CLIENT = { displayName: "Acme Traders" } as const;
export const SEED_CASE = {
  fileNumber: "WP/2026/1234",
  clientName: SEED_CLIENT.displayName,
  caseType: "writ",
} as const;

/** DD-005's recorded uniform login failure — asserted verbatim. */
export const UNIFORM_LOGIN_FAILURE = "Email or password is incorrect";

/** The theft response — its ABSENCE is asserted by the two-tab test. */
export const THEFT_NOTICE = "Your session was ended for security reasons. Sign in again.";
