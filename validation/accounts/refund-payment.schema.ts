import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// Payment refund workbench (ac07-spec §2.4b) — BAN-scoped, one refund
// transaction per BAN. `allocationLineId: null` marks a pure
// unallocated-overpayment item (the simplest case, §2.4). Every server-side
// enforcement (amount ≤ original, single BAN, currency) lives in
// `refund-payment.ts` — this schema only shapes the input.
const refundItemSchema = z.object({
  allocationLineId: z
    .string()
    .regex(/^DLN\d{8}$/, "Invalid document line ID")
    .nullable(),
  refundedAmount: amountSchema,
});

export const refundPaymentSchema = z.object({
  financialAccountId: z
    .string()
    .regex(/^FIN\d{6}$/, "Invalid financial account ID"),
  billingAccountId: z
    .string()
    .regex(/^BAN\d{6}$/, "Invalid billing account ID"),
  refundType: z.enum(["cash", "convert_to_advance"]),
  items: z.array(refundItemSchema).min(1, "Select at least one item to refund"),
  ...documentBaseSchema.shape,
});

export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;
