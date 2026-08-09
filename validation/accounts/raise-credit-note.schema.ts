import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// CRN — raise-credit-note (ac09-spec §2.1/§3.3). BAN required (Q1). Reason
// is always `GOODWILL_CREDIT` — not exposed as a field, same convention as
// `raise-debit-note.schema.ts`'s hardcoded `MANUAL_CHARGE`. No tax line in
// this phase (§2.3).
export const raiseCreditNoteSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d+$/, "Invalid financial account ID"),
    billingAccountId: z
      .string()
      .regex(/^BAN\d+$/, "Invalid billing account ID"),
    amount: amountSchema,
  })
  .merge(documentBaseSchema);

export type RaiseCreditNoteInput = z.infer<typeof raiseCreditNoteSchema>;
