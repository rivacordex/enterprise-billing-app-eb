import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm11-spec §Implementation §2. The post action payload — just the run id;
// the poster is the authenticated actor, never a caller-supplied field (same
// shape as `approve-run.schema.ts`).
export const postRunSchema = z.object({
  billRunId: billRunIdSchema,
});

export type PostRunInput = z.infer<typeof postRunSchema>;
