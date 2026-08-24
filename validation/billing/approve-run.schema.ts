import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm10-spec §Implementation §2. The approve action payload — just the run id;
// the approver is the authenticated actor, never a caller-supplied field.
export const approveRunSchema = z.object({
  billRunId: billRunIdSchema,
});

export type ApproveRunInput = z.infer<typeof approveRunSchema>;
