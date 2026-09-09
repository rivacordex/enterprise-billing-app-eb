import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm20-spec §Implementation §3 "Rerun distribution". Just the run id — the
// scope is never caller-selected (unlike `rerun-run.schema.ts`'s
// `accountIds`): the service always redelivers exactly the FAILED artifacts
// of the current round, never a caller-chosen subset.
export const rerunDistributionSchema = z.object({
  billRunId: billRunIdSchema,
});

export type RerunDistributionInput = z.infer<typeof rerunDistributionSchema>;
