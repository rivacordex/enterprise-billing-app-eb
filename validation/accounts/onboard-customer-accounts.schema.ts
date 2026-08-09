import { z } from "zod";

import { optimisticLockSchema } from "@/validation/customer/party-role.schema";

// Decimal-string format check — arithmetic is deferred to ac07's money.ts
// (ac04-spec §3.2). Accepts "1234", "1234.5", "1234.56"; capped at 15 chars
// so oversized monetary strings are rejected before persistence or display.
const creditLimitSchema = z
  .string()
  .regex(
    /^\d+(\.\d{1,2})?$/,
    "Must be a non-negative decimal with at most 2 decimal places",
  )
  .max(15, "Must be at most 15 characters");

export const onboardCustomerAccountsSchema = z
  .object({
    partyRoleId: z.string().regex(/^PTRL\d{8}$/, "Invalid party role ID"),
    billCycleId: z.string().regex(/^BCY\d+$/, "Invalid bill cycle ID"),
    currency: z.literal("MYR"),
    faCreditLimit: creditLimitSchema.optional(),
    banCreditLimit: creditLimitSchema.optional(),
    paymentDueDaysOverride: z.number().int().positive().optional(),
    statusReason: z.string().trim().min(1).max(500),
  })
  .merge(optimisticLockSchema);

export type OnboardCustomerAccountsInput = z.infer<
  typeof onboardCustomerAccountsSchema
>;
