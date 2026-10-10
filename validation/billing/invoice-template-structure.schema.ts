import { z } from "zod";

import { MANDATORY_SECTION_KEYS } from "@/types/billing";

// bm55-spec §Design D2 (code-standards Part 2 TS rule 3, Inv #46/#49) — the
// admin's only template input: a boolean map over the nine section keys and
// the four column keys. `.strict()` at every level, so an unknown key (markup,
// a label, an order) is rejected rather than stripped. Every mandatory section
// must be `true`; the issue's message is the binding code
// `MANDATORY_SECTION_HIDDEN`. The generator re-asserts the same rule.
export const invoiceTemplateStructureSchema = z
  .object({
    sections: z
      .object({
        billTo: z.boolean(),
        identification: z.boolean(),
        amountDue: z.boolean(),
        chargeSummary: z.boolean(),
        taxSummary: z.boolean(),
        payment: z.boolean(),
        chargeDetails: z.boolean(),
        usageAnnex: z.boolean(),
        notes: z.boolean(),
      })
      .strict(),
    columns: z
      .object({
        showServicePeriod: z.boolean(),
        showDiscountColumn: z.boolean(),
        showProductId: z.boolean(),
        showUdrCount: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((s, ctx) => {
    for (const k of MANDATORY_SECTION_KEYS) {
      if (!s.sections[k]) {
        ctx.addIssue({
          code: "custom",
          path: ["sections", k],
          message: "MANDATORY_SECTION_HIDDEN",
        });
      }
    }
  });

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
const DRAFT_TOKEN_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export const saveTemplateDraftInputSchema = z
  .object({
    structure: invoiceTemplateStructureSchema,
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE).nullable(),
  })
  .strict();

export type SaveTemplateDraftInput = z.infer<
  typeof saveTemplateDraftInputSchema
>;
