import { z } from "zod";

import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm55-spec §Design D4, code-standards Part 2 Next.js rule 2 — the Invoice
// template page's view state. Parsed, never trusted: an unknown `?tab=` falls
// back to `edit` and a malformed `?version=` is dropped (run-detail.schema.ts
// idiom), never an error.
export const INVOICE_TEMPLATE_TABS = ["edit", "generated", "history"] as const;
export type InvoiceTemplateTab = (typeof INVOICE_TEMPLATE_TABS)[number];

export const invoiceTemplateSearchParamsSchema = z.object({
  tab: z.enum(INVOICE_TEMPLATE_TABS).catch("edit"),
  version: billTemplateVersionIdSchema.optional().catch(undefined),
});

export type InvoiceTemplateSearchParams = z.infer<
  typeof invoiceTemplateSearchParamsSchema
>;
