import { z } from "zod";

import {
  amountSchema,
  documentBaseSchema,
} from "@/validation/accounts/document-base.schema";

// DEP reverse-to-account (ac08-spec §2.2/§3.3) — FA required, no BAN
// (Q4/Q1). No `payment_mode`/`mode_ref` — internal, no bank movement
// (§2.5). `amount ≤ held` is a live-balance check (Module Inv. #2) done in
// `reverse-deposit.ts`, never here.
export const reverseDepositSchema = z
  .object({
    financialAccountId: z
      .string()
      .regex(/^FIN\d+$/, "Invalid financial account ID"),
    amount: amountSchema,
  })
  .merge(documentBaseSchema);

export type ReverseDepositInput = z.infer<typeof reverseDepositSchema>;
