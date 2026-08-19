/**
 * The firm's clock — the single definition of "today" for every
 * calendar-date rule in the domain (task overdue derivation AND its
 * query predicate, the upcoming-hearings window). Extracted from the
 * task resource when T05 gave it a third consumer: two copies of a
 * timezone literal is how "overdue" and "upcoming" quietly start
 * disagreeing at midnight.
 *
 * Asia/Kolkata is a constant, not configuration, on purpose (DD-001:
 * the same clock the hearing-reminder schedule uses). When a firm in
 * another timezone exists, THIS module is the one place a per-firm
 * setting lands — config plumbing before that consumer exists would be
 * speculation.
 */

export const FIRM_TIMEZONE = "Asia/Kolkata";

/**
 * Today's calendar date in the firm's timezone, as YYYY-MM-DD. A UTC
 * server would otherwise flip tasks overdue at 05:30 the previous
 * evening, firm time. en-CA formats as YYYY-MM-DD, comparable to the
 * stored calendar dates as text.
 */
export function todayInFirmTimezone(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: FIRM_TIMEZONE }).format(new Date());
}

/**
 * Calendar-date arithmetic on the stored YYYY-MM-DD form (the
 * upcoming-hearings window's far edge). Pure date math via Date.UTC —
 * no timezone is involved because both operands are already calendar
 * dates, not instants.
 */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * A firm calendar day as UTC instant bounds — [gte, lt) in RFC3339 —
 * for range filters over stored timestamps (metadata.createdAt,
 * HearingStatus.recorded_at), which the store compares as UTC text.
 * The offset is derived from FIRM_TIMEZONE via Intl rather than
 * hardcoded, so this stays correct the day the timezone becomes
 * per-firm configuration (module header). Half-open on purpose: a
 * write at exactly next-midnight belongs to the next day.
 */
export function firmDayUtcBounds(isoDate: string): { gte: string; lt: string } {
  const toUtc = (date: string) => {
    // Probe at UTC noon of the date so the resolved offset is the one
    // in force on that calendar day (matters only for DST timezones;
    // Asia/Kolkata is fixed, but the derivation costs nothing).
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: FIRM_TIMEZONE,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(`${date}T12:00:00Z`));
    const gmt = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
    const offset = gmt === "GMT" ? "+00:00" : gmt.slice(3);
    return new Date(`${date}T00:00:00${offset}`).toISOString();
  };
  return { gte: toUtc(isoDate), lt: toUtc(addDaysToIsoDate(isoDate, 1)) };
}
