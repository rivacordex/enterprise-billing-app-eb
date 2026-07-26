import { z } from "zod";

// `document.mode_ref` (ac02-spec §2.5, Q22) — discriminated on the sibling
// `payment_mode` column. The DB column itself carries no `payment_mode` key
// (that lives on `document.payment_mode`); this schema's discriminant key
// exists only so `z.discriminatedUnion` can select a branch when a caller
// validates `{ payment_mode, mode_ref }` together (later write-path units).
export const modeRefSchema = z.discriminatedUnion("payment_mode", [
  z.strictObject({
    payment_mode: z.literal("bank_transfer"),
    bankRef: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    payment_mode: z.literal("cheque"),
    chequeNo: z.string().trim().min(1).max(50),
    bank: z.string().trim().min(1).max(100),
  }),
  z.strictObject({
    payment_mode: z.literal("cash"),
    receiptNo: z.string().trim().min(1).max(50),
  }),
]);
export type ModeRefEnvelope = z.infer<typeof modeRefSchema>;

// The `document.mode_ref` column itself stores only the payload half (no
// `payment_mode` key duplicated inside the jsonb — that's the sibling
// column); these are what `$type<…>()` on the Drizzle column declares.
export const bankTransferModeRefSchema = z.strictObject({
  bankRef: z.string().trim().min(1).max(100),
});
export const chequeModeRefSchema = z.strictObject({
  chequeNo: z.string().trim().min(1).max(50),
  bank: z.string().trim().min(1).max(100),
});
export const cashModeRefSchema = z.strictObject({
  receiptNo: z.string().trim().min(1).max(50),
});
export type ModeRef =
  | z.infer<typeof bankTransferModeRefSchema>
  | z.infer<typeof chequeModeRefSchema>
  | z.infer<typeof cashModeRefSchema>;
