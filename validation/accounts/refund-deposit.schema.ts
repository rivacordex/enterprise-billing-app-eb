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
import { PAYMENT_MODES } from "@/types/accounts";

// DEP refund (ac08-spec §2.2/§3.3/§2.5) — FA required, no BAN (Q4/Q1).
// `payment_mode`/`mode_ref` are optional here (unlike capture's mandatory
// pair) — §2.5's "decide per finance need" default: refund may carry a
// payout `mode_ref` like capture, but doesn't have to. Modelled as a plain
// nullable pair (rather than capture's discriminated union) so "no mode
// chosen" is representable, with a `superRefine` enforcing the same
// per-mode shape (code-standards §6.5) whenever a mode is present.
// `amount ≤ refundable` is a live-balance check (Module Inv. #2) done in
// `refund-deposit.ts`, never here.
const MODE_REF_SCHEMAS = {
  bank_transfer: bankTransferModeRefSchema,
  cheque: chequeModeRefSchema,
  cash: cashModeRefSchema,
} as const;

const modeRefUnionSchema = z.union([
  bankTransferModeRefSchema,
  chequeModeRefSchema,
  cashModeRefSchema,
]);

export const refundDepositSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d{6}$/, "Invalid financial account ID"),
    amount: amountSchema,
    paymentMode: z.enum(PAYMENT_MODES).nullable().default(null),
    modeRef: modeRefUnionSchema.nullable().default(null),
  })
  .merge(documentBaseSchema)
  .superRefine((data, ctx) => {
    if (data.paymentMode === null) {
      if (data.modeRef !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["modeRef"],
          message: "modeRef must be null when paymentMode is not set",
        });
      }
      return;
    }
    const shape = MODE_REF_SCHEMAS[data.paymentMode];
    if (!shape.safeParse(data.modeRef).success) {
      ctx.addIssue({
        code: "custom",
        path: ["modeRef"],
        message: "Invalid mode_ref for the selected payment mode",
      });
    }
  });

export type RefundDepositInput = z.infer<typeof refundDepositSchema>;
