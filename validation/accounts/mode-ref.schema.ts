import { z } from "zod";

import type { PaymentMode } from "@/types/accounts";

// `document.mode_ref` jsonb — discriminated on the sibling `payment_mode`
// column (Q22, ac02-spec §2.5). The discriminant lives outside the jsonb
// value itself, so it can't be a `z.discriminatedUnion` on the value alone;
// `modeRefSchemaForPaymentMode` is the pairing a future write-path unit uses.
export const bankTransferModeRefSchema = z.strictObject({
  bankRef: z.string(),
});
export type BankTransferModeRef = z.infer<typeof bankTransferModeRefSchema>;

export const chequeModeRefSchema = z.strictObject({
  chequeNo: z.string(),
  bank: z.string(),
});
export type ChequeModeRef = z.infer<typeof chequeModeRefSchema>;

export const cashModeRefSchema = z.strictObject({
  receiptNo: z.string(),
});
export type CashModeRef = z.infer<typeof cashModeRefSchema>;

export const modeRefSchema = z.union([
  bankTransferModeRefSchema,
  chequeModeRefSchema,
  cashModeRefSchema,
]);
export type ModeRef = z.infer<typeof modeRefSchema>;

export function modeRefSchemaForPaymentMode(paymentMode: PaymentMode) {
  switch (paymentMode) {
    case "bank_transfer":
      return bankTransferModeRefSchema;
    case "cheque":
      return chequeModeRefSchema;
    case "cash":
      return cashModeRefSchema;
  }
}
