import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm20-spec §Phase-2 review fold T2. The "Start distribution" action payload
// — just the run id (mirrors `check-status.schema.ts`); the triggering actor
// is the authenticated caller, never a caller-supplied field.
export const startDistributionSchema = z.object({
  billRunId: billRunIdSchema,
});

export type StartDistributionInput = z.infer<typeof startDistributionSchema>;
