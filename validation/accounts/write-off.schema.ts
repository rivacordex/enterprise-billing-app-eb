import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// ADJ write-off (ac10-spec §2.1/§3.3). BAN required (Q1). Reason is always
// `BAD_DEBT_WRITEOFF` — not exposed as a field, same convention as
// `raise-credit-note.schema.ts`'s hardcoded `GOODWILL_CREDIT`. `amount` must
// not exceed the BAN's live open A/R balance — that check needs a live
// balance read, so it happens in the service (§3.3), not here.
export const writeOffSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d{6}$/, "Invalid financial account ID"),
    billingAccountId: z
      .string()
      .regex(/^BAN\d{6}$/, "Invalid billing account ID"),
    amount: amountSchema,
  })
  .merge(documentBaseSchema);

export type WriteOffInput = z.infer<typeof writeOffSchema>;
