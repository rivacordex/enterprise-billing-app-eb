import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { conflict, notFound } from "@/lib/errors";
import { recomputeDistributionStatus } from "@/services/billing/distribute-run";

// bm04-spec §Design/§Implementation §8/§29. The run-level status push: the
// PROCESSING execution's error/`finally` handlers call this when the whole
// execution fails, so the run is not left stuck in PROCESSING with no
// heartbeat. Bumps `last_progress_at` and flips the run to the rerunnable
// PROCESSING_FAILED terminal state. Guarded the same way as the stage
// handler (§Guards) — rejected unless the run is PROCESSING.
//
// bm20-spec §Implementation §4 extends this SAME endpoint to the
// distribution execution's terminal push (§Design "the existing .../status
// endpoint carries the distribution execution's terminal push"):
//   - `DISTRIBUTION_FAILED` (the flow's `on_error` handler) forces the
//     terminal state directly — a flow-level crash, not an artifact-level
//     verdict.
//   - `DISTRIBUTION_FINISHED` (the flow's `finally` handler) triggers the
//     app's OWN recompute from the recorded `bill_run_distribution` outcomes
//     (`recomputeDistributionStatus`) — COMPLETED when every mandatory
//     artifact of the current round landed DELIVERED, DISTRIBUTION_FAILED
//     when one is FAILED, or no change (heartbeat only) when the recorded
//     set is still incomplete.
// A status that doesn't match the run's current execution (a
// `DISTRIBUTION_*` value while PROCESSING, `PROCESSING_FAILED` while
// DISTRIBUTING, or anything while the run is neither) is rejected with 409.

export interface StatusPushInput {
  runId: string;
  status: "PROCESSING_FAILED" | "DISTRIBUTION_FAILED" | "DISTRIBUTION_FINISHED";
}

export interface StatusPushResult {
  ok: true;
}

export async function handleStatusPush(
  input: StatusPushInput,
): Promise<StatusPushResult> {
  return db.transaction(async (tx) => {
    const run = await billRunRepository.findByIdForUpdate(tx, input.runId);
    if (!run) throw notFound("Bill run not found.");

    if (run.status === "PROCESSING") {
      if (input.status !== "PROCESSING_FAILED") {
        throw conflict("Bill run is not DISTRIBUTING.");
      }
      await billRunRepository.markProcessingFailed(tx, input.runId);
      return { ok: true };
    }

    if (run.status === "DISTRIBUTING") {
      if (input.status === "DISTRIBUTION_FAILED") {
        await billRunRepository.markDistributionFailed(tx, input.runId);
        return { ok: true };
      }
      if (input.status === "DISTRIBUTION_FINISHED") {
        await recomputeDistributionStatus(tx, run);
        return { ok: true };
      }
      throw conflict("Bill run is not PROCESSING.");
    }

    throw conflict("Bill run is not PROCESSING or DISTRIBUTING.");
  });
}
