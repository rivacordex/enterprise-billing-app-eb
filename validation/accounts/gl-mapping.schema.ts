import { z } from "zod";

export const GL_SELECTOR_TYPES = ["ledger_role", "system_account"] as const;

export const upsertGlMappingSchema = z
  .object({
    // Present on edit, absent on create.
    glMappingId: z.string().min(1).nullable().optional(),
    selectorType: z.enum(GL_SELECTOR_TYPES),
    selector: z.string().min(1).max(120),
    // NULL = all currencies (role selectors, architecture §3).
    currency: z
      .string()
      .length(3)
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    refGlCode: z.string().min(1).max(20),
    // ISO string for the optimistic-lock field (required on edit, absent on create).
    lastModified: z.iso.datetime().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.glMappingId && !data.lastModified) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastModified"],
        message: "lastModified is required when editing an existing mapping",
      });
    }
  });

export type UpsertGlMappingInput = z.infer<typeof upsertGlMappingSchema>;

export const retireGlMappingSchema = z.object({
  glMappingId: z.string().min(1),
  lastModified: z.iso.datetime(),
});

export type RetireGlMappingInput = z.infer<typeof retireGlMappingSchema>;
