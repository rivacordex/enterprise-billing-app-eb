import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";
import {
  bankTransferModeRefSchema,
  cashModeRefSchema,
  chequeModeRefSchema,
} from "@/validation/accounts/mode-ref.schema";

// PAY capture (ac07-spec §2.4/§3.5) — FA required (Q1), reason chosen by
// the operator (CUST_PAYMENT | ADVANCE_PAYMENT — Q15: advance payment is
// exactly a capture with no allocation line), `payment_mode` + `mode_ref`
// discriminated on the sibling field (Q22). Composed as its own
// discriminated union (rather than intersecting with `modeRefSchema`)
// because that schema's branches are `strictObject`s and would reject the
// rest of this input's keys under a `.and()` intersection.
const captureBaseFields = {
  financialAccountId: z
    .string()
    .regex(/^FIN\d+$/, "Invalid financial account ID"),
  reasonCode: z.enum(["CUST_PAYMENT", "ADVANCE_PAYMENT"]),
  amount: amountSchema,
  ...documentBaseSchema.shape,
};

export const capturePaymentSchema = z.discriminatedUnion("payment_mode", [
  z.object({
    ...captureBaseFields,
    payment_mode: z.literal("bank_transfer"),
    mode_ref: bankTransferModeRefSchema,
  }),
  z.object({
    ...captureBaseFields,
    payment_mode: z.literal("cheque"),
    mode_ref: chequeModeRefSchema,
  }),
  z.object({
    ...captureBaseFields,
    payment_mode: z.literal("cash"),
    mode_ref: cashModeRefSchema,
  }),
]);

export type CapturePaymentInput = z.infer<typeof capturePaymentSchema>;
