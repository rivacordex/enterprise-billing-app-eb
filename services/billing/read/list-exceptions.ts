import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { exceptionWindowForRun } from "@/services/billing/exception-window";
import type { ExceptionRow } from "@/types/billing";

// bm32-spec §Design/§Implementation §2. The per-record exception surface read —
// the "things not on the bill" that are records, not accounts (Info family,
// never blocking): `BILL_NOTUSED` rated usage rows and unresolvable-subscriber
// orphans (D32/Inv #25), plus (known-issues §28) the run accounts' unbilled
// usage from earlier periods. The first two are scoped to the run's WINDOW
// (`exceptionWindowForRun`): the ≤2 UTC-month `partition_period` buckets the
// window spans (`periodPartitions`) AND `start_datetime` within `[periodStart, periodEnd]`. Scoping by the window (not
// a single `firstOfMonth(periodStart)` partition) is what keeps a `cycle_day != 1`
// run — whose period straddles two calendar months, so `rating.udr_rated` rows
// land in two partitions — from silently dropping the second month's in-window
// rows (Inv #25 — never filter silently). Derived live, no cache read
// (architecture Inv. #12 idiom).
//
// An account EXCLUDED from THIS run gets no in-window row here (Inv #26) — it
// never entered processing. Its usage from an earlier excluded month does show
// as PRIOR_PERIOD on a later run that includes it (§28). A resolvable orphan
// carries its account name; an unresolvable one a `null` account (shown by
// `subscriberRef`). Never filters silently.
export async function listExceptions(
  billRunId: string,
): Promise<ExceptionRow[]> {
  const run = await billRunRepository.findById(db, billRunId);
  if (!run) return [];

  const window = exceptionWindowForRun(run);
  // known-issues §28 option 1 — after the in-window records, the run accounts'
  // unbilled usage from EARLIER periods (summed per account and month): no run
  // claims it any more, so it is listed here rather than lost silently.
  const [inWindow, priorPeriod] = await Promise.all([
    ratedLinesRepository.listExceptionsForWindow(db, window),
    ratedLinesRepository.listPriorPeriodForRun(db, window, run.billRunId),
  ]);
  return [...inWindow, ...priorPeriod];
}
