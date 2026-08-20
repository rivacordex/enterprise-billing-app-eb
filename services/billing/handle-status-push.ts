import { db } from "@/db/client";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { conflict, notFound } from "@/lib/errors";

// bm04-spec §Design/§Implementation §8/§29. The run-level status push: the
// workflow's error/`finally` handlers call this when the whole execution
// fails, so the run is not left stuck in PROCESSING with no heartbeat.
// Bumps `last_progress_at` and flips the run to the rerunnable
// PROCESSING_FAILED terminal state. Guarded the same way as the stage
// handler (§Guards) — rejected unless the run is PROCESSING.

export interface StatusPushInput {
  runId: string;
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
    if (run.status !== "PROCESSING") {
      throw conflict("Bill run is not PROCESSING.");
    }

    await billRunRepository.markProcessingFailed(tx, input.runId);

    return { ok: true };
  });
}
