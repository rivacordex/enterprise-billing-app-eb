import { z } from "zod";

import { inclusiveBilledDateSchema } from "@/validation/backdating-tolerance";

const inventoryIdSchema = z
  .string()
  .trim()
  .regex(/^PRDINV\d{8}$/, "Invalid product inventory id");

// Resume: `effective_date` only (no reason). Resume-day billing treatment is
// reserved to the bill-run phase (Q17/Q20). Same 3-day backdating fast-fail.
export const resumeSubscriptionSchema = z.object({
  inventoryId: inventoryIdSchema,
  effectiveDate: inclusiveBilledDateSchema,
});

export type ResumeSubscriptionInput = z.infer<typeof resumeSubscriptionSchema>;
