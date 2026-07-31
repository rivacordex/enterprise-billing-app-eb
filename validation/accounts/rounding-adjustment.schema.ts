import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// ADJ rounding adjustment (ac10-spec §2.1/§2.2/§3.3). BAN required (Q1).
// Reason is always `ROUNDING_ADJ` — not exposed as a field, same convention
// as `write-off.schema.ts`. `amount` is the small residue being cleared; the
// leg *direction* is decided in the service from the live sign of the BAN's
// A/R balance (§2.2), never from client input.
export const roundingAdjustmentSchema = z
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

export type RoundingAdjustmentInput = z.infer<typeof roundingAdjustmentSchema>;
