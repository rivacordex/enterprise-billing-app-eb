import type { RunStatus } from "@/types/billing";

// bm12-spec §Design/§Implementation §3, architecture Inv. #10, extended
// bm20-spec §Phase-2 review fold T2. `STALLED` is derived on read, never
// persisted: a run DISPLAYS as stalled when it is `PROCESSING` OR
// `DISTRIBUTING` and `now() - last_progress_at` exceeds the configured
// threshold — a wedged distribution execution gets the same derived-STALLED
// treatment as a wedged processing one. Pure and total — no DB access, no
// background job.

export interface StallCheckRun {
  status: RunStatus;
  lastProgressAt: Date | null;
}

export function isStalled(
  run: StallCheckRun,
  now: Date,
  thresholdMinutes: number,
): boolean {
  if (run.status !== "PROCESSING" && run.status !== "DISTRIBUTING") {
    return false;
  }
  // A PROCESSING/DISTRIBUTING run always carries a heartbeat, stamped at
  // trigger (`markProcessing`/`markDistributing`) and bumped by every
  // stage/outcome signal — `null` here would mean the row is inconsistent
  // with its own status, not that it's stalled.
  if (!run.lastProgressAt) return false;

  const elapsedMinutes =
    (now.getTime() - run.lastProgressAt.getTime()) / 60_000;
  return elapsedMinutes > thresholdMinutes;
}
