import { z } from "zod";

// ac16-spec §2.5/§3.4 — closure is a direct state transition (no ledger
// transfer, no document), so unlike write-off/rounding this schema doesn't
// merge `documentBaseSchema` — just the target id and the CAS lock token.
export const closeBillingAccountSchema = z.object({
  billingAccountId: z
    .string()
    .regex(/^BAN\d{6}$/, "Invalid billing account ID"),
  lastModified: z.coerce.date(),
});
export type CloseBillingAccountInput = z.infer<
  typeof closeBillingAccountSchema
>;

export const closeFinancialAccountSchema = z.object({
  financialAccountId: z
    .string()
    .regex(/^FIN\d{6}$/, "Invalid financial account ID"),
  lastModified: z.coerce.date(),
});
export type CloseFinancialAccountInput = z.infer<
  typeof closeFinancialAccountSchema
>;
