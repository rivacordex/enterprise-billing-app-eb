import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm12-spec §Implementation §4. The "Check status" action payload — just the
// run id; the reconciling actor is the authenticated caller, never a
// caller-supplied field.
export const checkStatusSchema = z.object({
  billRunId: billRunIdSchema,
});

export type CheckStatusInput = z.infer<typeof checkStatusSchema>;
