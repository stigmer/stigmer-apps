/**
 * Customer-data guard — build-enforced backing for the confinement rule:
 * customer-specific strings live ONLY under _projects/, _changelog/, and
 * clients/ (working records and per-client deployment config); every
 * other path — code, protos, charts, fixtures, roles, rules, docs —
 * stays publication-ready at all times. Onboarding a customer is
 * configuration only, and that configuration lives under clients/.
 *
 * The repo is private today, but the guard is the insurance that keeps a
 * future open-sourcing a bounded excision (drop the three excluded
 * folders) instead of a forensic scrub of the whole tree (project
 * DD-003; clients/ added by owner direction in DD-004).
 *
 * Two layers:
 *
 * 1. Generic patterns (committed here, safe to publish): phone numbers in
 *    E.164 form and WhatsApp caller-id assignments. Real customer data of
 *    these shapes must never be committed; tests use obviously fake ids.
 * 2. A customer-name denylist injected via the CUSTOMER_DENYLIST secret
 *    (newline- or comma-separated, case-insensitive). It is a secret for
 *    one reason: committing the list would publish the very names it
 *    exists to keep out of this repo.
 *
 * Failure policy for the missing secret: fork PRs never receive secrets,
 * so on pull_request events the denylist layer is skipped with a warning;
 * on push (and every other trigger) a missing secret is a hard failure —
 * the guard must never silently green-wash the branch that ships.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Lockfiles are machine-generated dependency metadata; base64 integrity
// hashes can coincidentally match the phone pattern.
const SKIPPED = new Set(["package-lock.json"]);

// The confinement boundary (DD-003, clients/ added by DD-004): project
// working records, changelogs, and per-client deployment config
// legitimately carry customer context — they are the ONLY paths allowed
// to. Everything outside these prefixes must stay publication-ready,
// which is exactly what the scan enforces.
const EXCLUDED_PREFIXES = ["_projects/", "_changelog/", "clients/"];

const GENERIC_PATTERNS = [
  { name: "E.164 phone number", regex: /\+[1-9]\d{9,14}\b/ },
  { name: "WhatsApp caller id", regex: /wa[_-]?id["'\s:=]+\d{10,15}/i },
];

function trackedFiles() {
  return execFileSync("git", ["ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter(
      (f) =>
        f &&
        !SKIPPED.has(f.split("/").pop()) &&
        !EXCLUDED_PREFIXES.some((prefix) => f.startsWith(prefix)),
    );
}

function denylistTerms() {
  const raw = process.env.CUSTOMER_DENYLIST ?? "";
  return raw
    .split(/[\n,]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

const violations = [];
const terms = denylistTerms();

if (terms.length === 0) {
  if (process.env.GITHUB_EVENT_NAME === "pull_request") {
    console.warn(
      "WARN: CUSTOMER_DENYLIST is not available (expected on fork PRs); " +
        "running generic patterns only. The push to main re-runs the full guard.",
    );
  } else {
    console.error(
      "FAIL: CUSTOMER_DENYLIST secret is missing on a non-PR run. " +
        "The guard must not pass vacuously on the branch that ships.",
    );
    process.exit(1);
  }
}

for (const file of trackedFiles()) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // unreadable/binary — nothing textual to scan
  }
  const haystacks = [
    { where: "path", text: file.toLowerCase() },
    { where: "content", text: content.toLowerCase() },
  ];
  for (const { name, regex } of GENERIC_PATTERNS) {
    if (regex.test(content)) {
      violations.push(`${file}: matches generic pattern "${name}"`);
    }
  }
  for (const term of terms) {
    for (const { where, text } of haystacks) {
      if (text.includes(term)) {
        // Never echo the term itself — this log is public.
        violations.push(`${file}: ${where} matches a denylisted customer term`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Customer-data guard failed:\n" + violations.map((v) => `  - ${v}`).join("\n"));
  process.exit(1);
}
console.log("Customer-data guard passed.");
