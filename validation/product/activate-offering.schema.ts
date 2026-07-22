import { z } from "zod";

export const activateOfferingSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500, "Reason must be 500 characters or fewer")
    .optional(),
});

export type ActivateOfferingInput = z.infer<typeof activateOfferingSchema>;
