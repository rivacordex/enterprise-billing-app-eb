import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm20-spec §Phase-2 review fold T11. The force-complete/abandon action
// payload — a MANDATORY reason (mirrors `rerun-run.schema.ts`'s), since this
// is a danger-role, audited decision to abandon undelivered artifacts and
// close the GL period regardless.
export const forceCompleteDistributionSchema = z.object({
  billRunId: billRunIdSchema,
  reason: z.string().trim().min(1, "A reason is required.").max(2000),
});

export type ForceCompleteDistributionInput = z.infer<
  typeof forceCompleteDistributionSchema
>;
