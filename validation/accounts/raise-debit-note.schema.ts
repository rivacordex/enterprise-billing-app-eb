import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// DBN — raise-debit-note (ac09-spec §2.1/§2.3/§3.3). BAN required (Q1).
// Reason is always `MANUAL_CHARGE` (the phase's only charge vehicle, Q21) —
// not exposed as a field, mirroring `allocate-payment.schema.ts`'s hardcoded
// `CUST_PAYMENT`. `taxAmount` is optional — a 0/absent tax posts a single
// line (§2.3); arithmetic (net + tax total) happens only in `money.ts`.
export const raiseDebitNoteSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d+$/, "Invalid financial account ID"),
    billingAccountId: z
      .string()
      .regex(/^BAN\d+$/, "Invalid billing account ID"),
    netAmount: amountSchema,
    taxAmount: amountSchema.nullable().default(null),
  })
  .merge(documentBaseSchema);

export type RaiseDebitNoteInput = z.infer<typeof raiseDebitNoteSchema>;
