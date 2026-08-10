import { z } from "zod";

// Q19 / architecture Inv. #21: an inclusive-billed date (`start_date`,
// `end_date`, `effective_date`) may be backdated at most 3 days; beyond that
// the write is rejected. This is the parse-time **fast-fail** copy shared by
// the ordering and inventory schemas — the authoritative re-check runs in the
// service (pm28) against an injectable `now`, inside the transaction, mirroring
// insert-price's two-copy pattern (pm15). `Date.now()` is read inside the
// refine, so it evaluates fresh on every parse, never frozen at module load.
export const BACKDATING_TOLERANCE_DAYS = 3;
const TOLERANCE_MS = BACKDATING_TOLERANCE_DAYS * 24 * 60 * 60 * 1000;

// Inclusive-billed dates are calendar days, wire-encoded as ISO `YYYY-MM-DD` —
// matching the Drizzle `date` column (string mode).
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export const inclusiveBilledDateSchema = z
  .string()
  .trim()
  .regex(ISO_DATE_REGEX, "Date must be in YYYY-MM-DD format")
  .superRefine((value, ctx) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: "custom", message: "Invalid calendar date." });
      return;
    }
    if (Date.now() - parsed.getTime() > TOLERANCE_MS) {
      ctx.addIssue({
        code: "custom",
        message: `Date cannot be more than ${BACKDATING_TOLERANCE_DAYS} days in the past.`,
      });
    }
  });
