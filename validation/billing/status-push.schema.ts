import { z } from "zod";

// bm04-spec §Implementation §6/§29 ("the workflow's error/finally handlers
// POST a terminal status ... an execution-failure marks the run
// PROCESSING_FAILED"). `PROCESSED` is never pushed here — it is derived by
// `handleStageSignal`'s run-status recompute once every account is terminal
// (architecture Inv. #12), so the only run-level status a caller can push
// for the PROCESSING execution is an execution failure. Resolved decision,
// recorded in the progress tracker (bm04-spec left the body shape unstated
// beyond this sentence).
//
// bm20-spec §Implementation §4 extends this SAME endpoint to carry the
// distribution execution's terminal push (§Design "the existing .../status
// endpoint carries the distribution execution's terminal push"):
// `DISTRIBUTION_FAILED` is the flow's `on_error` handler's literal push (a
// flow-level hard failure, forcing the terminal state regardless of any
// per-artifact outcome already recorded) — mirrors `PROCESSING_FAILED`'s
// shape exactly. `DISTRIBUTION_FINISHED` is the flow's `finally` handler's
// generic "I'm done" push (the YAML template's stub comment: "POST the
// terminal distribution status") — the app, not the flow, DERIVES
// COMPLETED vs. DISTRIBUTION_FAILED from the recorded `bill_run_distribution`
// outcomes (`handle-status-push.ts`'s `recomputeDistributionStatus`).
// `handleStatusPush` rejects whichever literal doesn't match the run's
// current execution (a `DISTRIBUTION_*` value while PROCESSING, or
// `PROCESSING_FAILED` while DISTRIBUTING) with a 409.
//
// `strictObject` (matching `stageSignalBodySchema`) rejects any undeclared
// key — including a charge field — with a 422 (code-standards §5.5). v1 has
// nowhere to persist a run-level failure reason (no `bill_run` error column,
// no read surface), so no `error_detail` is accepted rather than validating
// then silently discarding it; the field returns with a column + UI later.
//
// `attempt` is required for the two `DISTRIBUTION_*` pushes (mirrors
// `distributionOutcomeBodySchema.attempt`, T1's stale-round guard) so
// `handleStatusPush` can reject a straggler push from a superseded
// distribution execution — a prior round's `on_error`/`finally` handler
// firing late after `rerunDistribution` already started a new attempt. The
// PROCESSING execution has no run-level attempt concept (bm04), so
// `PROCESSING_FAILED` never carries or requires one.
export const statusPushBodySchema = z
  .strictObject({
    status: z.enum([
      "PROCESSING_FAILED",
      "DISTRIBUTION_FAILED",
      "DISTRIBUTION_FINISHED",
    ]),
    attempt: z.number().int().min(1).optional(),
  })
  .refine(
    (body) => body.status === "PROCESSING_FAILED" || body.attempt !== undefined,
    {
      message: "attempt is required for a distribution status push.",
      path: ["attempt"],
    },
  );

export type StatusPushBody = z.infer<typeof statusPushBodySchema>;
