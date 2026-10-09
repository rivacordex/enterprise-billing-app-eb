import { z } from "zod";

import { billAssetVersionIdSchema } from "@/validation/billing/template-version-id.schema";

// bm53-spec §Design D3 — THE company-profile schema (code-standards Part 2 TS
// rule 5), shared by the render-time read (bm53), the form and the save action
// (bm59). Keys are the `core.system_config` `invoice.profile` group's
// `config_key`s; `.strict()` rejects any key outside the set. The field formats
// are copied from `invoice-template/placeholder-catalog.md` §B — if the two ever
// disagree, the catalog wins and this file is corrected.
//
// `logo_asset_version_id` is optional HERE: "required for ACTIVE" is enforced
// at activation (bm61, `PROFILE_LOGO_REQUIRED`), and a hand-edited ACTIVE row
// without one still renders (the header hides the logo, D4).
const TIN_RE = /^[A-Z]{1,2}\d{10,11}$/;
const SST_RE = /^[A-Z]\d{2}-\d{4}-\d{8}$/;
const POSTCODE_RE = /^\d{5}$/;
const STATE_CODE_RE = /^(0[1-9]|1[0-6])$/;
const COUNTRY_CODE_RE = /^[A-Z]{2}$/;
const COLOUR_RE = /^#[0-9A-Fa-f]{6}$/;
const ACCOUNT_NO_RE = /^[0-9-]{6,30}$/;
const SWIFT_RE = /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const DIGITS_RE = /^\d+$/;

export const invoiceProfileSchema = z
  .object({
    company_name: z.string().min(1).max(150),
    registration_no: z.string().min(1).max(40),
    tin: z.string().regex(TIN_RE),
    sst_reg_no: z.string().regex(SST_RE).optional(),
    address_line1: z.string().min(1).max(120),
    address_line2: z.string().max(120).optional(),
    postcode: z.string().regex(POSTCODE_RE),
    city: z.string().min(1).max(80),
    state_code: z.string().regex(STATE_CODE_RE),
    country_code: z.string().regex(COUNTRY_CODE_RE).default("MY"),
    phone: z.string().min(1).max(30),
    email: z.email(),
    website: z.url({ protocol: /^https$/ }).optional(),
    brand_color: z.string().regex(COLOUR_RE),
    accent_color: z.string().regex(COLOUR_RE),
    bank_name: z.string().min(1).max(80),
    bank_account_name: z.string().min(1).max(120),
    bank_account_no: z.string().regex(ACCOUNT_NO_RE),
    swift: z.string().regex(SWIFT_RE),
    jompay_biller_code: z.string().regex(DIGITS_RE).optional(),
    remittance_email: z.email(),
    payment_terms_days: z.number().int().min(0).max(120),
    logo_asset_version_id: billAssetVersionIdSchema.optional(),
  })
  .strict();

export type InvoiceProfileInput = z.input<typeof invoiceProfileSchema>;
export type InvoiceProfileValues = z.output<typeof invoiceProfileSchema>;

// D3 — `config_value` is text; map the stored strings to the schema's typed
// input before parsing. A `null` or blank value is an absent key (so an
// optional field may be stored blank, and a required one fails as missing).
// `payment_terms_days` becomes an integer only when it is all digits — any
// other text is passed through unchanged so the schema rejects it.
export function toInvoiceProfileInput(
  rows: Readonly<Record<string, string | null>>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rows)) {
    if (value === null || value.trim() === "") continue;
    input[key] =
      key === "payment_terms_days" && DIGITS_RE.test(value)
        ? Number.parseInt(value, 10)
        : value;
  }
  return input;
}
