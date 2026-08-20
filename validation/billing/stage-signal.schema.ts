import { z } from "zod";

import { ERROR_CLASSES, STAGES, STAGE_STATUSES } from "@/types/billing";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm04-spec §Implementation §6. `runId`/`stage` path params, parsed before
// any repository call (code-standards §2.6).
export const runIdParamSchema = billRunIdSchema;

export const stageParamSchema = z.enum(STAGES);

// The stage-complete body. No charge fields are accepted (code-standards
// §5.5) — the signal never carries an amount.
export const stageSignalBodySchema = z.object({
  ban_id: z.string().regex(/^BAN\d{8}$/, "Invalid billing account id."),
  attempt: z.number().int().min(1),
  status: z.enum(STAGE_STATUSES),
  error_class: z.enum(ERROR_CLASSES).optional(),
  error_code: z.string().min(1).max(200).optional(),
  error_detail: z.string().min(1).max(2000).optional(),
});

export type StageSignalBody = z.infer<typeof stageSignalBodySchema>;
