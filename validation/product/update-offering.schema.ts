import { z } from "zod";

export const updateOfferingSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Offering name is required")
    .max(200, "Offering name must be 200 characters or fewer"),
  isSellable: z.boolean(),
  billingOnly: z.boolean(),
  saveAsNew: z.boolean(),
});

export type UpdateOfferingInput = z.infer<typeof updateOfferingSchema>;

// pm20-spec §2.4/§3.1. UI-facing companion: the exact fields
// `OfferingForm`'s edit mode renders and validates client-side. `saveAsNew`
// is deliberately omitted — it's never a form field, only ever implied by
// which footer button was clicked (Design §2.5/§2.6). Mirrors
// `editUserDetailsFieldsSchema` / `editRoleFieldsSchema`'s own
// same-file, `.omit`-derived shape.
export const editOfferingFieldsSchema = updateOfferingSchema.omit({
  saveAsNew: true,
});
export type EditOfferingFields = z.infer<typeof editOfferingFieldsSchema>;
