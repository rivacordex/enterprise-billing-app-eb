import { z } from "zod";

// Q19 / architecture Inv. #21: an inclusive-billed date (`start_date`,
// `end_date`, `effective_date`) may be backdated at most 3 days; beyond that
// the write is rejected. This is the parse-time **fast-fail** copy shared by
// the ordering and inventory schemas — the authoritative re-check runs in the
// service (pm28) against an injectable `now`, inside the transaction, mirroring
// insert-price's two-copy pattern (pm15). `Date.now()` is read inside the
// refine, so it evaluates fresh on every parse, never frozen at module load.
export const BACKDATING_TOLERANCE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Inclusive-billed dates are calendar days, wire-encoded as ISO `YYYY-MM-DD` —
// matching the Drizzle `date` column (string mode).
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const inclusiveBilledDateSchema = z
  .string()
  .trim()
  .regex(ISO_DATE_REGEX, "Date must be in YYYY-MM-DD format")
  .superRefine((value, ctx) => {
    // Regex above guarantees exactly three numeric parts.
    const [year, month, day] = value.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    const parsed = new Date(Date.UTC(year, month - 1, day));
    // Reject non-real calendar dates: JS rolls e.g. 2026-02-30 forward to
    // 2026-03-02, so the round-tripped UTC components must equal the input.
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid calendar date." });
      return;
    }
    // Compare on UTC calendar-day boundaries, not raw millisecond subtraction,
    // so a date exactly N whole days before today counts as N days back
    // regardless of the current time of day. `Date.now()` is read here (fresh
    // per parse), never frozen at module load.
    const now = new Date();
    const todayUtcMidnight = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const daysInPast = Math.round(
      (todayUtcMidnight - parsed.getTime()) / MS_PER_DAY,
    );
    if (daysInPast > BACKDATING_TOLERANCE_DAYS) {
      ctx.addIssue({
        code: "custom",
        message: `Date cannot be more than ${BACKDATING_TOLERANCE_DAYS} days in the past.`,
      });
    }
  });
