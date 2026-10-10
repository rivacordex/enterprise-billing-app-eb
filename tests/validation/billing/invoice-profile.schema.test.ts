import { describe, expect, it } from "vitest";

import {
  INVOICE_PROFILE_FIELD_KEYS,
  invoiceProfileDraftSchema,
  invoiceProfileSchema,
  saveProfileDraftInputSchema,
  toInvoiceProfileInput,
} from "@/validation/billing/invoice-profile.schema";

// bm53-spec §Design D3, §Tests row 3 — every placeholder-catalog §B format,
// valid and invalid, plus `.strict()` and the string → typed-input mapping.

const VALID: Record<string, string> = {
  company_name: "Digital Billing Sdn Bhd",
  registration_no: "202001000001",
  tin: "C12345678901",
  sst_reg_no: "W10-1808-31000001",
  address_line1: "Level 10, Menara Billing",
  address_line2: "Jalan Ampang",
  postcode: "50450",
  city: "Kuala Lumpur",
  state_code: "14",
  country_code: "MY",
  phone: "+60 3-2000 0000",
  email: "billing@digital-billing.example",
  website: "https://digital-billing.example",
  brand_color: "#2E45A9",
  accent_color: "#006975",
  bank_name: "Maybank Berhad",
  bank_account_name: "Digital Billing Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  jompay_biller_code: "98765",
  remittance_email: "ar@digital-billing.example",
  payment_terms_days: "30",
  logo_asset_version_id: "INVASV00000001",
};

function parse(overrides: Record<string, string | null> = {}) {
  return invoiceProfileSchema.safeParse(
    toInvoiceProfileInput({ ...VALID, ...overrides }),
  );
}

function issuePaths(overrides: Record<string, string | null>): string[] {
  const r = parse(overrides);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("invoiceProfileSchema — a complete valid profile", () => {
  it("parses, mapping payment_terms_days to an integer", () => {
    const r = parse();
    expect(r.success).toBe(true);
    expect(r.success && r.data.payment_terms_days).toBe(30);
  });

  it("optional fields may be absent or blank (sst, address line 2, website, JomPAY, logo)", () => {
    const r = parse({
      sst_reg_no: null,
      address_line2: "",
      website: null,
      jompay_biller_code: "  ",
      logo_asset_version_id: null,
    });
    expect(r.success).toBe(true);
  });

  it("country_code defaults to MY", () => {
    const r = parse({ country_code: null });
    expect(r.success && r.data.country_code).toBe("MY");
  });
});

describe.each<[string, string[], string[]]>([
  [
    "tin",
    ["C1234567890", "IG12345678901"],
    ["C123", "c12345678901", "C123456789012"],
  ],
  [
    "sst_reg_no",
    ["W10-1808-31000001"],
    ["W10-1808-3100001", "w10-1808-31000001", "W101808-31000001"],
  ],
  ["postcode", ["50450", "01000"], ["5045", "504500", "5045A"]],
  ["swift", ["MBBEMYKL", "MBBEMYKLXXX"], ["MBBEMYK", "MBBEMYKLXX", "mbbemykl"]],
  ["email", ["a@b.example"], ["not-an-email", "a@"]],
  ["remittance_email", ["ar@b.example"], ["ar.b.example"]],
  ["brand_color", ["#A1b2C3"], ["A1B2C3", "#A1B2C", "#GGGGGG"]],
  ["accent_color", ["#000000"], ["#0000000", "red"]],
  ["state_code", ["01", "09", "10", "16"], ["00", "1", "17", "99"]],
  ["jompay_biller_code", ["12345"], ["12A45", "-1"]],
  ["payment_terms_days", ["0", "120"], ["121", "-1", "1.5", "thirty"]],
  ["bank_account_no", ["123456", "5140-1234-5678"], ["12345", "ABC123456"]],
  ["country_code", ["MY", "SG"], ["my", "MYS"]],
  [
    "website",
    ["https://x.example"],
    ["http://x.example", "ftp://x.example", "x.example"],
  ],
  ["logo_asset_version_id", ["INVASV00000001"], ["INVAST00000001", "INVASV1"]],
])("invoiceProfileSchema — %s", (key, valid, invalid) => {
  it.each(valid)("accepts %s", (value) => {
    expect(issuePaths({ [key]: value })).toEqual([]);
  });
  it.each(invalid)("rejects %s", (value) => {
    expect(issuePaths({ [key]: value })).toContain(key);
  });
});

describe("invoiceProfileSchema — lengths and required keys", () => {
  it.each([
    ["company_name", 150],
    ["registration_no", 40],
    ["address_line1", 120],
    ["city", 80],
    ["phone", 30],
    ["bank_name", 80],
    ["bank_account_name", 120],
  ])("%s accepts %i chars and rejects one more", (key, max) => {
    expect(issuePaths({ [key]: "x".repeat(max) })).toEqual([]);
    expect(issuePaths({ [key]: "x".repeat(max + 1) })).toContain(key);
  });

  it.each([
    "company_name",
    "registration_no",
    "tin",
    "address_line1",
    "postcode",
    "city",
    "state_code",
    "phone",
    "email",
    "brand_color",
    "accent_color",
    "bank_name",
    "bank_account_name",
    "bank_account_no",
    "swift",
    "remittance_email",
    "payment_terms_days",
  ])("%s is required", (key) => {
    expect(issuePaths({ [key]: null })).toContain(key);
  });

  it("rejects an unknown key (.strict())", () => {
    const r = parse({ customer_name: "Acme" });
    expect(r.success).toBe(false);
    expect(r.success ? [] : r.error.issues.map((i) => i.code)).toContain(
      "unrecognized_keys",
    );
  });
});

// bm59-spec §Tests row 1 — guardrail 51, FORMAT half: the save-draft schema
// accepts blanks (incomplete work) but every provided value must match its
// catalog §B format, after the shared normalisation; `.strict()` still rejects
// the logo (bm60 writes it) and `meta.*` (bm61) when posted from the form.
function draftIssuePaths(fields: Record<string, unknown>): string[] {
  const r = saveProfileDraftInputSchema.safeParse({
    fields,
    expectedDraftToken: null,
  });
  return r.success
    ? []
    : r.error.issues.map((i) => i.path.slice(1).join(".") || "fields");
}

describe("invoiceProfileDraftSchema — save validates formats, not completeness (bm59)", () => {
  it("accepts an empty draft and a draft of blanks", () => {
    expect(invoiceProfileDraftSchema.safeParse({}).success).toBe(true);
    const blanks = Object.fromEntries(
      INVOICE_PROFILE_FIELD_KEYS.map((k) => [k, "  "]),
    );
    expect(draftIssuePaths(blanks)).toEqual([]);
  });

  it("is .partial() over the same field set as the full schema (minus the logo)", () => {
    expect(Object.keys(invoiceProfileDraftSchema.shape).sort()).toEqual(
      [...INVOICE_PROFILE_FIELD_KEYS].sort(),
    );
    expect(Object.keys(invoiceProfileSchema.shape).sort()).toEqual(
      [...INVOICE_PROFILE_FIELD_KEYS, "logo_asset_version_id"].sort(),
    );
  });

  it.each<[string, string]>([
    ["tin", "C123"],
    ["sst_reg_no", "W101808-31000001"],
    ["postcode", "5045"],
    ["swift", "MBBEMYK"],
    ["email", "not-an-email"],
    ["remittance_email", "ar.b.example"],
    ["website", "http://x.example"],
    ["brand_color", "red"],
    ["accent_color", "#GGGGGG"],
    ["state_code", "17"],
    ["jompay_biller_code", "12A45"],
    ["bank_account_no", "ABC123456"],
    ["payment_terms_days", "121"],
    ["payment_terms_days", "thirty"],
    ["company_name", "x".repeat(151)],
  ])("rejects an invalid %s (%s)", (key, value) => {
    expect(draftIssuePaths({ [key]: value })).toEqual([key]);
  });

  it("normalises before validating: trim, upper-case TIN/SST/SWIFT/colours, account-no. spaces, terms → int", () => {
    const r = saveProfileDraftInputSchema.safeParse({
      fields: {
        tin: " c12345678901 ",
        sst_reg_no: "w10-1808-31000001",
        swift: "mbbemykl",
        brand_color: "#2e45a9",
        bank_account_no: "5140 1234 5678",
        payment_terms_days: " 30 ",
        city: "   ",
      },
      expectedDraftToken: null,
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.fields).toEqual({
      tin: "C12345678901",
      sst_reg_no: "W10-1808-31000001",
      swift: "MBBEMYKL",
      brand_color: "#2E45A9",
      bank_account_no: "514012345678",
      payment_terms_days: 30,
      country_code: "MY",
    });
  });

  it.each([
    ["logo_asset_version_id", "INVASV00000001"],
    ["meta.change_note", "x"],
    ["meta.activated_by", "user-1"],
  ])(".strict() rejects %s posted from the form", (key, value) => {
    expect(draftIssuePaths({ [key]: value })).toEqual(["fields"]);
  });

  it("rejects a malformed token and an unknown top-level key", () => {
    expect(
      saveProfileDraftInputSchema.safeParse({
        fields: {},
        expectedDraftToken: "2026-10-10",
      }).success,
    ).toBe(false);
    expect(
      saveProfileDraftInputSchema.safeParse({
        fields: {},
        expectedDraftToken: null,
        version: 3,
      }).success,
    ).toBe(false);
  });

  it("the full schema still requires what activation requires", () => {
    expect(invoiceProfileSchema.safeParse({}).success).toBe(false);
  });
});
