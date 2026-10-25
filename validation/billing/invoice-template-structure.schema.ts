import { z } from "zod";

import { templateFamilyIdSchema } from "@/validation/billing/template-family-id.schema";

// bm55-spec §Design D2 (code-standards Part 2 TS rule 3, Inv #46/#49) — the
// admin's only template input. `.strict()` at every level, so an unknown key
// (markup, a label, an order) is rejected rather than stripped. bm71 (D56):
// `sections` holds only the optional sections (the mandatory ones are always
// on and are not stored), and `columns` is always empty — the layout has no
// admin column toggles. A structure carrying `usageAnnex`, a mandatory
// section or any column key is rejected. bm72 (D20, D56 part 2, Inv #46
// amended): `notes` is gone, and `footnote` holds 1–5 plain-text lines of at
// most 200 characters each (trimmed; a blank line is refused). The messages
// are the editor's field errors (ui-context §10b), shared with the server.
export const FOOTNOTE_MAX_LINES = 5;
export const FOOTNOTE_LINE_MAX_LENGTH = 200;

export const footnoteLineSchema = z
  .string()
  .trim()
  .min(1, "Enter text or remove the line")
  .max(FOOTNOTE_LINE_MAX_LENGTH, "200 characters at most");

export const invoiceTemplateStructureSchema = z
  .object({
    sections: z.object({ payment: z.boolean() }).strict(),
    columns: z.object({}).strict(),
    footnote: z
      .array(footnoteLineSchema)
      .min(1, "Keep at least one line")
      .max(FOOTNOTE_MAX_LINES, "5 lines at most"),
  })
  .strict();

export type InvoiceTemplateStructureInput = z.infer<
  typeof invoiceTemplateStructureSchema
>;

// bm55-spec §Design D3 — the live-preview action's input. `structure` is
// validated by the schema above; `source` is the layout's sample bill or one
// `customer_bill` by its `CBL` id (general §6.18 format validator).
export const previewInvoiceTemplateInputSchema = z
  .object({
    structure: invoiceTemplateStructureSchema,
    source: z.union([
      z.literal("sample"),
      z.object({ billId: z.string().regex(/^CBL\d{8}$/) }).strict(),
    ]),
    annotate: z.boolean().optional(),
    outline: z.boolean().optional(),
    // bm66-spec §4 — the family whose live versions the preview renders.
    familyId: templateFamilyIdSchema,
    // bm79 review fix — the form previews its working DRAFT (and the layout
    // it points at). The action honours it only for invoice_settings EDIT.
    draft: z.boolean().optional(),
  })
  .strict();

export type PreviewInvoiceTemplateInput = z.infer<
  typeof previewInvoiceTemplateInputSchema
>;

// bm57-spec §Design D2 — the save-draft action's input. `expectedDraftToken` is
// the working draft's concurrency token as the form last saw it (`null` when it
// believed no draft existed). The token is an ISO-8601 UTC string with
// microsecond precision, produced by the database (`TOKEN_FORMAT` in the
// repository); anything else is rejected before it reaches SQL.
export const DRAFT_TOKEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const saveTemplateDraftInputSchema = z
  .object({
    structure: invoiceTemplateStructureSchema,
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE).nullable(),
    // bm77 — the type being edited (from the `[typeId]` page), never the default.
    familyId: templateFamilyIdSchema,
  })
  .strict();

export type SaveTemplateDraftInput = z.infer<
  typeof saveTemplateDraftInputSchema
>;
