import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
import type { DistributionView, RunStatus } from "@/types/billing";

// The four D-T3 states the tab actually renders — a run earlier than
// INVOICED (or one that never reached it, e.g. CANCELLED) has no
// distribution to show at all.
const DISTRIBUTABLE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "INVOICED",
  "DISTRIBUTING",
  "COMPLETED",
  "DISTRIBUTION_FAILED",
]);

// bm20-spec §Visual/D-T3. The Distribution tab's read — the run's targets
// (one loopback in v1, deferred targets greyed by the component) and the
// full delivery log across every round (newest first — the log is meant to
// show history, including a superseded prior round after a rerun). `null`
// means either the run doesn't exist or it hasn't reached INVOICED yet (or
// never will, e.g. CANCELLED) — the page renders the same "not available
// yet" copy either way; the component itself branches on `runStatus` for
// the four D-T3 states once a view IS returned.
export async function getDistribution(
  billRunId: string,
): Promise<DistributionView | null> {
  const run = await billRunRepository.findDetailById(db, billRunId);
  if (!run) return null;
  if (!DISTRIBUTABLE_RUN_STATUSES.has(run.status)) return null;

  const rows = await billRunDistributionRepository.listForRun(db, billRunId);

  return {
    billRunId,
    runStatus: run.status as RunStatus,
    hasExecution: rows.length > 0,
    // v1 ships exactly one target (D20); a future target lands as a config
    // addition here, not a schema change (no target-catalog table).
    targets: [{ name: "loopback", isMandatory: true }],
    rows,
  };
}
