import { z } from "zod";

export const createOfferingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Offering name is required")
    .max(200, "Offering name must be 200 characters or fewer"),
  isSellable: z.boolean(),
  billingOnly: z.boolean(),
});

export type CreateOfferingInput = z.infer<typeof createOfferingSchema>;
