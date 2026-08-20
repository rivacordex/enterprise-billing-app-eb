import { z } from "zod";

// bm04-spec §Implementation §6/§29 ("the workflow's error/finally handlers
// POST a terminal status ... an execution-failure marks the run
// PROCESSING_FAILED"). `PROCESSED` is never pushed here — it is derived by
// `handleStageSignal`'s run-status recompute once every account is terminal
// (architecture Inv. #12), so the only run-level status a caller can push is
// an execution failure. Resolved decision, recorded in the progress tracker
// (bm04-spec left the body shape unstated beyond this sentence).
export const statusPushBodySchema = z.object({
  status: z.literal("PROCESSING_FAILED"),
  error_detail: z.string().min(1).max(2000).optional(),
});

export type StatusPushBody = z.infer<typeof statusPushBodySchema>;
