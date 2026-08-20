import { z } from "zod";

// bm04-spec §Implementation §6/§29 ("the workflow's error/finally handlers
// POST a terminal status ... an execution-failure marks the run
// PROCESSING_FAILED"). `PROCESSED` is never pushed here — it is derived by
// `handleStageSignal`'s run-status recompute once every account is terminal
// (architecture Inv. #12), so the only run-level status a caller can push is
// an execution failure. Resolved decision, recorded in the progress tracker
// (bm04-spec left the body shape unstated beyond this sentence).
//
// `strictObject` (matching `stageSignalBodySchema`) rejects any undeclared
// key — including a charge field — with a 422 (code-standards §5.5). v1 has
// nowhere to persist a run-level failure reason (no `bill_run` error column,
// no read surface), so no `error_detail` is accepted rather than validating
// then silently discarding it; the field returns with a column + UI later.
export const statusPushBodySchema = z.strictObject({
  status: z.literal("PROCESSING_FAILED"),
});

export type StatusPushBody = z.infer<typeof statusPushBodySchema>;
