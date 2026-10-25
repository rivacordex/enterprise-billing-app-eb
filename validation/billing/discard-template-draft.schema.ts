import { z } from "zod";

import { DRAFT_TOKEN_RE } from "@/validation/billing/invoice-template-structure.schema";
import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";
import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm79 — discard a type's DRAFTs: the type, the settings DRAFT the page shows
// and its token as the page loaded them (the same optimistic check as
// Activate). Review fix — the token has Activate's format check too, so a
// malformed one is refused before any lock is taken.
export const discardTemplateDraftInputSchema = z
  .object({
    familyId: templateFamilyIdSchema,
    draftId: billTemplateVersionIdSchema,
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE),
  })
  .strict();

export type DiscardTemplateDraftInput = z.infer<
  typeof discardTemplateDraftInputSchema
>;
