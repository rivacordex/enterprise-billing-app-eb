import { z } from "zod";

export const retireOfferingSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export type RetireOfferingInput = z.infer<typeof retireOfferingSchema>;
