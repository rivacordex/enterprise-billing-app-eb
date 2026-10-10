import { z } from "zod";

import { billAssetVersionIdSchema } from "@/validation/billing/template-version-id.schema";
import { DRAFT_TOKEN_RE } from "@/validation/billing/invoice-template-structure.schema";

// bm53-spec §Design D3 — THE company-profile schema (code-standards Part 2 TS
// rule 5), shared by the render-time read (bm53), the form and the save action
// (bm59). Keys are the `core.system_config` `invoice.profile` group's
// `config_key`s; `.strict()` rejects any key outside the set. The field formats
// are copied from `invoice-template/placeholder-catalog.md` §B — if the two ever
// disagree, the catalog wins and this file is corrected.
//
// bm59-spec §Design D2 — three schemas over one field set:
// - `invoiceProfileFieldsSchema`: the fields the form edits (every key except
//   `logo_asset_version_id`, which bm60 writes; `meta.*` is never a field).
// - `invoiceProfileDraftSchema` (= `.partial()`): SAVE. Every provided value
//   must match its format; blanks are allowed so incomplete work can be saved.
// - `invoiceProfileSchema` (fields + logo): the render-time read and ACTIVATION
//   (bm61), which require the required fields.
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

const COLOUR_MESSAGE = "Use a #RRGGBB colour, e.g. #2E45A9";
const EMAIL_MESSAGE = "Enter a valid email address";

function text(max: number): z.ZodString {
  return z.string().min(1, "Required").max(max, `At most ${max} characters`);
}

export const invoiceProfileFieldsSchema = z
  .object({
    company_name: text(150),
    registration_no: text(40),
    tin: z
      .string()
      .regex(TIN_RE, "TIN is 1–2 letters then 10–11 digits, e.g. C12345678901"),
    sst_reg_no: z
      .string()
      .regex(SST_RE, "SST no. looks like W10-1808-31000001")
      .optional(),
    address_line1: text(120),
    address_line2: z.string().max(120, "At most 120 characters").optional(),
    postcode: z.string().regex(POSTCODE_RE, "Postcode is 5 digits"),
    city: text(80),
    state_code: z.string().regex(STATE_CODE_RE, "Choose a state (01–16)"),
    country_code: z
      .string()
      .regex(COUNTRY_CODE_RE, "Country is a 2-letter code")
      .default("MY"),
    phone: text(30),
    email: z.email(EMAIL_MESSAGE),
    website: z
      .url({ protocol: /^https$/, error: "Website must start with https://" })
      .optional(),
    brand_color: z.string().regex(COLOUR_RE, COLOUR_MESSAGE),
    accent_color: z.string().regex(COLOUR_RE, COLOUR_MESSAGE),
    bank_name: text(80),
    bank_account_name: text(120),
    bank_account_no: z
      .string()
      .regex(ACCOUNT_NO_RE, "Account no. is 6–30 digits or dashes"),
    swift: z
      .string()
      .regex(SWIFT_RE, "SWIFT is 8 or 11 characters, e.g. MBBEMYKL"),
    jompay_biller_code: z
      .string()
      .regex(DIGITS_RE, "JomPAY biller code is digits only")
      .optional(),
    remittance_email: z.email(EMAIL_MESSAGE),
    payment_terms_days: z
      .number("Payment terms is a whole number of days")
      .int("Payment terms is a whole number of days")
      .min(0, "Payment terms is 0–120 days")
      .max(120, "Payment terms is 0–120 days"),
  })
  .strict();

// D2 — save: formats only, every key optional. `.strict()` still rejects
// `logo_asset_version_id` and `meta.*` posted from the form.
export const invoiceProfileDraftSchema = invoiceProfileFieldsSchema.partial();

export const invoiceProfileSchema = invoiceProfileFieldsSchema
  .extend({ logo_asset_version_id: billAssetVersionIdSchema.optional() })
  .strict();

export type InvoiceProfileInput = z.input<typeof invoiceProfileSchema>;
export type InvoiceProfileValues = z.output<typeof invoiceProfileSchema>;
export type InvoiceProfileDraftInput = z.input<
  typeof invoiceProfileDraftSchema
>;
export type InvoiceProfileDraftValues = z.output<
  typeof invoiceProfileDraftSchema
>;

// The keys the form edits, in schema order (the draft's stored row set adds
// `logo_asset_version_id`, bm59 D1).
export type InvoiceProfileFieldKey =
  keyof typeof invoiceProfileFieldsSchema.shape;
export const INVOICE_PROFILE_FIELD_KEYS = Object.keys(
  invoiceProfileFieldsSchema.shape,
) as InvoiceProfileFieldKey[];

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

const UPPER_CASE_KEYS: ReadonlySet<string> = new Set([
  "tin",
  "sst_reg_no",
  "swift",
  "brand_color",
  "accent_color",
]);

// bm59 D2 — normalisation before the draft parse, shared by the form resolver
// and the action: trim; blank (or `null`) → absent; upper-case TIN, SST,
// SWIFT and colours; strip spaces from the account no.; an all-digit
// `payment_terms_days` → integer (other text passes through and fails). A
// non-object input is returned as is, so the schema rejects it.
export function normalizeInvoiceProfileDraftInput(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    let v = value.trim();
    if (v === "") continue;
    if (UPPER_CASE_KEYS.has(key)) v = v.toUpperCase();
    if (key === "bank_account_no") v = v.replace(/\s+/g, "");
    out[key] =
      key === "payment_terms_days" && DIGITS_RE.test(v)
        ? Number.parseInt(v, 10)
        : v;
  }
  return out;
}

// bm59 D1/D2 — the save-draft action's input: the whole field set (an absent
// key is a blank, stored as NULL) and the optimistic token (`null` = "I
// believe no draft exists"), the bm57 token shape.
export const saveProfileDraftInputSchema = z
  .object({
    fields: z.preprocess(
      normalizeInvoiceProfileDraftInput,
      invoiceProfileDraftSchema,
    ),
    expectedDraftToken: z.string().regex(DRAFT_TOKEN_RE).nullable(),
  })
  .strict();

export type SaveProfileDraftInput = z.output<
  typeof saveProfileDraftInputSchema
>;
