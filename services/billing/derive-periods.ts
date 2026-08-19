// bm02-spec §4 / Design §Structural. Pure, total, never-throwing calendar math
// for the monthly in-arrears window. No timezone conversion happens here —
// `today` is already the business-zone calendar day (resolved by the caller via
// `lib/timezone.ts` from `getAppTimezone()`); every computation is UTC-anchored
// so there is no local-offset drift. Non-monthly cycles are the caller's
// concern (skipped with a logged note); this helper assumes a monthly cadence
// with `cycle_day` 1–28.

export interface DuePeriod {
  periodStart: string; // YYYY-MM-DD
  periodEnd: string; // YYYY-MM-DD
  scheduledRunDate: string; // YYYY-MM-DD
}

const DAY_MS = 86_400_000;

// Formats a UTC-midnight instant as a `YYYY-MM-DD` calendar-date string.
function toYmd(utcMs: number): string {
  const d = new Date(utcMs);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// The single most-recent in-arrears period whose `scheduled_run_date <= today`,
// anchored on THIS month's cycle day (Design §Structural — the "just-closed
// month, 1 month back"). Returns `null` when this month's run date has not yet
// arrived (`today` is before the cycle day): earlier un-opened months are NEVER
// retro-materialized (no backfill) — any already-materialized SCHEDULED run
// simply stays operable oldest-first via the list read. `today` and every
// field of the result are calendar-date strings (`YYYY-MM-DD`).
//
// For `cycle_day = d`: `period_start` = the d-th of the previous month,
// `period_end` = `scheduled_run_date − 1 day`, `scheduled_run_date` = the d-th
// of today's month. JS `Date.UTC` normalizes the month/year underflow, so a
// January `today` maps `period_start` to the prior December correctly.
export function currentDuePeriod(
  cycleDay: number,
  today: string,
): DuePeriod | null {
  const [ty, tm, td] = today.split("-").map(Number);
  // Defensive totality — a malformed `today` yields no due period rather than
  // throwing (this runs on every list render).
  if (!ty || !tm || !td) return null;

  const todayMs = Date.UTC(ty, tm - 1, td);
  const scheduledMs = Date.UTC(ty, tm - 1, cycleDay);
  // This month's run date has not arrived yet — nothing due, no backfill.
  if (scheduledMs > todayMs) return null;

  const periodStartMs = Date.UTC(ty, tm - 2, cycleDay);
  const periodEndMs = scheduledMs - DAY_MS;

  return {
    periodStart: toYmd(periodStartMs),
    periodEnd: toYmd(periodEndMs),
    scheduledRunDate: toYmd(scheduledMs),
  };
}
