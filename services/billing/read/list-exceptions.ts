import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { periodPartitions } from "@/services/billing/derive-periods";
import type { ExceptionRow } from "@/types/billing";

// bm32-spec §Design/§Implementation §2. The per-record exception surface read —
// the two "things not on the bill" that are records, not accounts (Info family,
// never blocking): `BILL_NOTUSED` rated usage rows and unresolvable-subscriber
// orphans (D32/Inv #25). Both are scoped to the run's WINDOW: the ≤2 UTC-month
// `partition_period` buckets the window spans (`periodPartitions`) AND
// `start_datetime` within `[periodStart, periodEnd]`. Scoping by the window (not
// a single `firstOfMonth(periodStart)` partition) is what keeps a `cycle_day != 1`
// run — whose period straddles two calendar months, so `rating.udr_rated` rows
// land in two partitions — from silently dropping the second month's in-window
// rows (Inv #25 — never filter silently). Derived live, no cache read
// (architecture Inv. #12 idiom).
//
// EXCLUDED accounts belong to NEITHER this surface nor Uncharged (Inv #26) —
// they never entered processing, so no per-record exception is attributed to
// them. A resolvable orphan carries its account name; an unresolvable one a
// `null` account (shown by `subscriberRef`). Never filters silently.
export async function listExceptions(
  billRunId: string,
): Promise<ExceptionRow[]> {
  const run = await billRunRepository.findById(db, billRunId);
  if (!run) return [];

  return ratedLinesRepository.listExceptionsForWindow(db, {
    partitions: periodPartitions(run.periodStart, run.periodEnd),
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
  });
}
