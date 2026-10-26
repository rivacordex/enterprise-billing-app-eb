import { z } from "zod";

import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";

// bm83 (D1) — retire a type: the target is a usable type's id, or `null` for
// Standard (an explicit Standard id is refused by the service, General rule 8).
// `confirmName` is the typed name, re-checked on the server.
export const retireTemplateTypeSchema = z
  .object({
    typeId: templateFamilyIdSchema,
    targetTypeId: templateFamilyIdSchema.nullable(),
    confirmName: z.string().trim().min(1).max(60),
  })
  .strict();

export type RetireTemplateTypeInput = z.infer<typeof retireTemplateTypeSchema>;

// bm83 (D8) — one page of the BANs bound to a type, for the Retire dialog.
export const listBoundBansSchema = z
  .object({
    typeId: templateFamilyIdSchema,
    page: z.number().int().min(0),
  })
  .strict();
