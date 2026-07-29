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

// DEP capture (ac08-spec §2.2/§3.3) — FA required, no BAN (Q4/Q1). Reason
// is always `SEC_DEPOSIT` (the only reason for the `capture` line_kind, §2.2
// table) — not exposed as a field, mirroring `allocate-payment.schema.ts`'s
// hardcoded `CUST_PAYMENT`. `payment_mode` + `mode_ref` mandatory (Q22),
// same discriminated-union composition as `capture-payment.schema.ts`.
const captureDepositBaseFields = {
  financialAccountId: z
    .string()
    .regex(/^FIN\d{6}$/, "Invalid financial account ID"),
  amount: amountSchema,
  ...documentBaseSchema.shape,
};

export const captureDepositSchema = z.discriminatedUnion("payment_mode", [
  z.object({
    ...captureDepositBaseFields,
    payment_mode: z.literal("bank_transfer"),
    mode_ref: bankTransferModeRefSchema,
  }),
  z.object({
    ...captureDepositBaseFields,
    payment_mode: z.literal("cheque"),
    mode_ref: chequeModeRefSchema,
  }),
  z.object({
    ...captureDepositBaseFields,
    payment_mode: z.literal("cash"),
    mode_ref: cashModeRefSchema,
  }),
]);

export type CaptureDepositInput = z.infer<typeof captureDepositSchema>;
