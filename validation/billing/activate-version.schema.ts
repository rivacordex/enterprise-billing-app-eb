import { z } from "zod";

import { DRAFT_TOKEN_RE } from "@/validation/billing/invoice-template-structure.schema";
import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm58-spec §Design D1/D2 step 1 (Inv #49): the template activation input. The
// change note is trimmed and must be 1-500 characters; an empty (or blank) note
// carries the binding message `CHANGE_NOTE_REQUIRED` so the action can return
// that code, while an over-long one is an ordinary validation error. bm61's
// company-profile variant sits below.
export const CHANGE_NOTE_MAX_LENGTH = 500;

export const changeNoteSchema = z
  .string()
  .transform((v) => v.trim())
  .pipe(
    z
      .string()
      .min(1, "CHANGE_NOTE_REQUIRED")
      .max(
        CHANGE_NOTE_MAX_LENGTH,
        `Change note must be ${CHANGE_NOTE_MAX_LENGTH} characters or fewer`,
      ),
  );

export const activateTemplateInputSchema = z
  .object({
    draftId: billTemplateVersionIdSchema,
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE),
    changeNote: changeNoteSchema,
  })
  .strict();

export type ActivateTemplateInput = z.infer<typeof activateTemplateInputSchema>;

// bm61-spec §Design D1 — the company-profile variant: the draft's
// `config_version`, its token and the same required change note.
export const activateProfileInputSchema = z
  .object({
    configVersion: z.number().int().positive(),
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE),
    changeNote: changeNoteSchema,
  })
  .strict();

export type ActivateProfileInput = z.infer<typeof activateProfileInputSchema>;
