import type { RunStatus } from "@/types/billing";

// bm12-spec §Design/§Implementation §3, architecture Inv. #10. `STALLED` is
// derived on read, never persisted: a run DISPLAYS as stalled when it is
// `PROCESSING` and `now() - last_progress_at` exceeds the configured
// threshold. Pure and total — no DB access, no background job.

export interface StallCheckRun {
  status: RunStatus;
  lastProgressAt: Date | null;
}

export function isStalled(
  run: StallCheckRun,
  now: Date,
  thresholdMinutes: number,
): boolean {
  if (run.status !== "PROCESSING") return false;
  // A PROCESSING run always carries a heartbeat, stamped at trigger
  // (`markProcessing`) and bumped by every stage signal — `null` here would
  // mean the row is inconsistent with its own status, not that it's stalled.
  if (!run.lastProgressAt) return false;

  const elapsedMinutes =
    (now.getTime() - run.lastProgressAt.getTime()) / 60_000;
  return elapsedMinutes > thresholdMinutes;
}
