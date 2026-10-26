import { z } from "zod";

import type { ExpectedDraft } from "@/types/billing";
import { DRAFT_TOKEN_RE } from "@/validation/billing/invoice-template-structure.schema";
import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";
import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm78-spec §10 — the upload action's FormData fields. bm80: the expected
// draft is two optional fields, `expectedDraftVersionId` and
// `expectedDraftToken`, as the page read them — both absent is
// `{ none: true }` (create), both present is `{ versionId, lastModified }`
// (overwrite), only one is a VALIDATION_ERROR. The file must be a non-empty
// `.zip`; the action itself refuses one over LAYOUT_PACKAGE_MAX_BYTES as
// LAYOUT_REJECTED / ZIP_TOO_LARGE (a problem the dialog lists, not a
// validation error).

// `FormData.get` gives `null` for an absent field.
const optionalField = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema.optional());

export const layoutUploadSchema = z
  .object({
    familyId: templateFamilyIdSchema,
    expectedDraftVersionId: optionalField(billTemplateVersionIdSchema),
    expectedDraftToken: optionalField(z.string().min(1)),
    // bm81 review fix (#2) — the settings DRAFT token the page loaded (absent:
    // no settings DRAFT). A restore that would replace changed settings fails.
    expectedSettingsToken: optionalField(z.string().regex(DRAFT_TOKEN_RE)),
    file: z
      .instanceof(File)
      .refine((f) => f.size >= 1, "the file is empty")
      .refine((f) => /\.zip$/i.test(f.name), "the file must be a .zip"),
  })
  .refine(
    (v) =>
      (v.expectedDraftVersionId === undefined) ===
      (v.expectedDraftToken === undefined),
    {
      message: "expectedDraftVersionId and expectedDraftToken go together",
      path: ["expectedDraftToken"],
    },
  )
  .transform(
    ({
      familyId,
      expectedDraftVersionId,
      expectedDraftToken,
      expectedSettingsToken,
      file,
    }) => {
      const expectedDraft: ExpectedDraft =
        expectedDraftVersionId !== undefined && expectedDraftToken !== undefined
          ? {
              versionId: expectedDraftVersionId,
              lastModified: expectedDraftToken,
            }
          : { none: true };
      return {
        familyId,
        expectedDraft,
        expectedSettingsToken: expectedSettingsToken ?? null,
        file,
      };
    },
  );

export type LayoutUploadInput = z.infer<typeof layoutUploadSchema>;
