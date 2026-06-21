import { z } from "zod";

export const updateConfigValueSchema = z.object({
  configId: z.string().uuid("Invalid configuration ID"),
  configValue: z
    .string()
    .max(2000, "Value must be 2000 characters or fewer")
    .nullable(),
});

export type UpdateConfigInput = z.infer<typeof updateConfigValueSchema>;
