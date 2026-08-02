import { z } from "zod";

export const setWizardDefaultsSchema = z.object({
  defaultBillCycleId: z.string().min(1),
  // null = no credit limit pre-fill (manual per customer, ac03 §2.6 resolution)
  defaultCreditLimit: z
    .string()
    .regex(
      /^\d{1,16}(\.\d{1,2})?$/,
      "Must be a non-negative decimal with at most 16 integer digits (e.g. 5000.00)",
    )
    .nullable()
    .optional(),
});

export type SetWizardDefaultsInput = z.infer<typeof setWizardDefaultsSchema>;
