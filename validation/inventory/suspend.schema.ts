import { z } from "zod";

import { inclusiveBilledDateSchema } from "@/validation/backdating-tolerance";

const inventoryIdSchema = z
  .string()
  .trim()
  .regex(/^PRDINV\d{8}$/, "Invalid product inventory id");

// Suspend: `effective_date` is the first non-billed day (architecture Inv.
// #21); a reason is required. The 3-day backdating fast-fail rides on the
// shared inclusive-billed date schema.
export const suspendSubscriptionSchema = z.object({
  inventoryId: inventoryIdSchema,
  effectiveDate: inclusiveBilledDateSchema,
  reason: z
    .string()
    .trim()
    .min(1, "A suspension reason is required")
    .max(1000, "Reason must be 1000 characters or fewer"),
});

export type SuspendSubscriptionInput = z.infer<
  typeof suspendSubscriptionSchema
>;
