import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
  documentIdSchema,
} from "@/validation/accounts/document-base.schema";

// PAY allocation (ac07-spec §2.4/§3.5) — BAN required (Q1). The settled
// document (a DBN charge/future invoice) is optional — partial/general
// application against a BAN's outstanding receivables is valid without one
// (Q24 allows manual allocation with no auto-matching to a specific charge).
export const allocatePaymentSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d+$/, "Invalid financial account ID"),
    billingAccountId: z
      .string()
      .regex(/^BAN\d+$/, "Invalid billing account ID"),
    amount: amountSchema,
    refSettledDocumentId: documentIdSchema.nullable().default(null),
  })
  .merge(documentBaseSchema);

export type AllocatePaymentInput = z.infer<typeof allocatePaymentSchema>;
