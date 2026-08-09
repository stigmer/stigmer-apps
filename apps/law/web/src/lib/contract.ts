/**
 * Wire-contract constants the screens must agree with the backend on —
 * each cites its deciding record. Never invent a value here; if a screen
 * needs a number the contract doesn't state, that is a contract question
 * (the plan's pause condition), not a constant.
 */

/** The contract's list page size (T01 owner decision 4). */
export const PAGE_SIZE = 20;

/** Upload cap (T01 owner decision 4; enforced server-side at 413). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** The only accepted document types (FR-INTEG-001 AC5). */
export const ALLOWED_MIME_TYPES = ["application/pdf", "image/png", "image/jpeg"] as const;
