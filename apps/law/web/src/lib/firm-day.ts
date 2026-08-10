/**
 * The firm's calendar day, for query bounds only. Hearing and deadline
 * dates are calendar dates in the firm's timezone (Asia/Kolkata, the
 * record model); the home screen's "today and tomorrow" / "this week"
 * windows need today's date IN THAT timezone, whatever the machine's
 * clock says. Rendering never uses these — format.ts stays pure string
 * work.
 */

const FIRM_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today as YYYY-MM-DD in the firm's timezone. */
export function firmToday(): string {
  return FIRM_DAY.format(new Date());
}

/**
 * Pure calendar arithmetic on a YYYY-MM-DD string: parts in, parts out
 * through UTC, so no local timezone ever touches the date.
 */
export function addDays(isoDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return isoDate;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
