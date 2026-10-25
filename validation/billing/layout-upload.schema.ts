import { z } from "zod";

import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";

// bm78-spec §10 — the upload action's FormData fields. `expectedDraft` is the
// literal "none" in bm78 (an upload only creates a draft when the type has
// none), mapped to `{ none: true }`; bm80 widens it to the
// `versionId|lastModified` form. The file must be a non-empty `.zip`; the
// action itself refuses one over LAYOUT_PACKAGE_MAX_BYTES as LAYOUT_REJECTED /
// ZIP_TOO_LARGE (a problem the dialog lists, not a validation error).
export const layoutUploadSchema = z.object({
  familyId: templateFamilyIdSchema,
  expectedDraft: z.literal("none").transform(() => ({ none: true }) as const),
  file: z
    .instanceof(File)
    .refine((f) => f.size >= 1, "the file is empty")
    .refine((f) => /\.zip$/i.test(f.name), "the file must be a .zip"),
});

export type LayoutUploadInput = z.infer<typeof layoutUploadSchema>;
