import { z } from "zod";

import { LOGO_MIME_TYPES } from "@/types/billing";
import { DRAFT_TOKEN_RE } from "@/validation/billing/invoice-template-structure.schema";

// bm60-spec §Design D1 — the logo upload's `FormData` fields. `file` must be a
// `File`; its declared `type` must be one of the three logo MIME types (else
// `LOGO_REJECTED: mime`, mapped by the action from the `type` issue path). The
// declared type and `File.size` never decide on their own: the service checks
// the actual bytes (data rule 9).
export const logoUploadSchema = z
  .object({
    file: z.instanceof(File),
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE),
  })
  .strict();

export const logoDeclaredMimeSchema = z.enum(LOGO_MIME_TYPES);

// D8 — the "Use the current app logo" import takes only the draft token.
export const importAppLogoSchema = z
  .object({ expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE) })
  .strict();
