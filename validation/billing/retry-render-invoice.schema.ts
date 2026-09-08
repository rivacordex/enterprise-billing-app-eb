import { z } from "zod";

import { billRunIdSchema } from "@/validation/billing/run-id.schema";
import { billingAccountIdSchema } from "@/validation/billing/ban-id.schema";

// bm19-spec §Implementation §4. The retry-render action payload — the
// (run, account) pair whose final invoice render/store failed and is being
// retried; the actor is the authenticated caller, never a caller-supplied
// field (same shape as `post-run.schema.ts`).
export const retryRenderInvoiceSchema = z.object({
  billRunId: billRunIdSchema,
  billingAccountId: billingAccountIdSchema,
});

export type RetryRenderInvoiceInput = z.infer<
  typeof retryRenderInvoiceSchema
>;
