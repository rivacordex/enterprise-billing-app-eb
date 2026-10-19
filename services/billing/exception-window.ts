import type { ExceptionWindow } from "@/db/repositories/billing/rated-lines.repository";
import { periodPartitions } from "@/services/billing/derive-periods";
import { getAppTimezone } from "@/services/system-config/app-config-read.service";

// bm32 / known-issues §28 — the run's exception window, built ONCE for the
// Exceptions tab (`list-exceptions.ts`) and the informational checklist counts
// (`orphan_count`, `prior_period_usage`), so the list and the counts always
// read the same partitions, dates and business zone.
export function exceptionWindowForRun(run: {
  periodStart: string;
  periodEnd: string;
}): ExceptionWindow {
  return {
    partitions: periodPartitions(run.periodStart, run.periodEnd),
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    timezone: getAppTimezone(),
  };
}
