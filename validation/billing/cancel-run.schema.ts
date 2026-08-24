import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm12-spec §Implementation §4. The "Cancel run" action payload — just the
// run id; the cancelling actor is the authenticated caller, never a
// caller-supplied field.
export const cancelRunSchema = z.object({
  billRunId: billRunIdSchema,
});

export type CancelRunInput = z.infer<typeof cancelRunSchema>;
