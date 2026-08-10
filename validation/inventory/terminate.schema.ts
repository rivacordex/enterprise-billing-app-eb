import { z } from "zod";

import { inclusiveBilledDateSchema } from "@/validation/backdating-tolerance";

const inventoryIdSchema = z
  .string()
  .trim()
  .regex(/^PRDINV\d{8}$/, "Invalid product inventory id");

// Terminate: `end_date` is the last billed day (architecture Inv. #21); a
// reason is required. `end_date >= start_date` is a DB CHECK and is re-checked
// in the service against the pinned instance — not expressible here (needs the
// instance's start_date). Same 3-day backdating fast-fail.
export const terminateSubscriptionSchema = z.object({
  inventoryId: inventoryIdSchema,
  endDate: inclusiveBilledDateSchema,
  reason: z
    .string()
    .trim()
    .min(1, "A termination reason is required")
    .max(1000, "Reason must be 1000 characters or fewer"),
});

export type TerminateSubscriptionInput = z.infer<
  typeof terminateSubscriptionSchema
>;
