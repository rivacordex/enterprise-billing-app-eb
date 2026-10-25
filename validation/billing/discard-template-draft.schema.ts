import { z } from "zod";

import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";
import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm79 — discard a type's DRAFTs: the type, the settings DRAFT the page shows
// and its token as the page loaded them (the same optimistic check as
// Activate).
export const discardTemplateDraftInputSchema = z
  .object({
    familyId: templateFamilyIdSchema,
    draftId: billTemplateVersionIdSchema,
    expectedDraftToken: z.string().min(1),
  })
  .strict();

export type DiscardTemplateDraftInput = z.infer<
  typeof discardTemplateDraftInputSchema
>;
