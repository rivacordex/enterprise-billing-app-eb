import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
  documentIdSchema,
} from "@/validation/accounts/document-base.schema";

// PAY allocation (ac07-spec §2.4/§3.5) — BAN required (Q1). The settled
// document (the INV / DBN charge the payment settles) is REQUIRED on every
// allocation (owner decision 2026-11-13): an allocation must always name the
// document it applies to, so the payment↔document application the refund
// workbench and the settlement reports read is never ambiguous. Manual
// allocation only (Q24) — the operator picks the document, nothing auto-matches.
export const allocatePaymentSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d+$/, "Invalid financial account ID"),
    billingAccountId: z
      .string()
      .regex(/^BAN\d+$/, "Invalid billing account ID"),
    amount: amountSchema,
    refSettledDocumentId: documentIdSchema,
  })
  .merge(documentBaseSchema);

export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;
