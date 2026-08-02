import { z } from "zod";

export const setWizardDefaultsSchema = z.object({
  defaultBillCycleId: z.string().min(1),
  // null = no credit limit pre-fill (manual per customer, ac03 §2.6 resolution)
  defaultCreditLimit: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, "Must be a non-negative decimal (e.g. 5000.00)")
    .refine((v) => parseFloat(v) >= 0, "Must be ≥ 0")
    .nullable()
    .optional(),
});

export type SetWizardDefaultsInput = z.infer<typeof setWizardDefaultsSchema>;
