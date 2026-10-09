import { describe, expect, it, vi } from "vitest";

// bm53-spec §Design D2 — the seeded default is loaded through the REAL
// verified loader (`loadGenerated`). Only the blob transport is replaced: it
// serves the committed `db/seeds/invoice-templates/**` bytes, so this suite
// also proves the repo files verify against the migration's BTV00000002
// checksum end to end (index digest → per-file digests → compile → probe).
vi.mock(
  "@/services/billing/blob-store",
  async () =>
    (await import("@/tests/helpers/seeded-invoice-template"))
      .repoBlobStoreModule,
);

import { bind } from "@/services/billing/invoice-template/bind";
import { executeInvoiceTemplate } from "@/services/billing/invoice-template/compile";
import { loadGenerated } from "@/services/billing/invoice-template/load";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import type { InvoiceProfile } from "@/types/billing";
import {
  SEEDED_GENERATED_ROW as SEEDED_GENERATED,
  SEEDED_TEMPLATE_STAMP as TEMPLATE,
} from "@/tests/helpers/seeded-invoice-template";

// bm47-spec §Design D1/D8, test plan row 3; bm53-spec §Tests (extend). DB-free:
// exercises the seeded `generated/INVOICE/v1/*.hbs` through `bind()` + the
// verified loader, over a hand-built `RawInvoiceRenderInput` fixture — no
// database, no Playwright.

const LOGO_DATA_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

// A fixture ACTIVE profile, already parsed + logo-inlined (the D3/D4 output).
const PROFILE: InvoiceProfile = {
  configVersion: 1,
  company: {
    name: "Digital Billing Sdn Bhd",
    registrationNo: "202001000001",
    tin: "C12345678901",
    sstRegNo: "W10-1808-31000001",
    addressLine1: "Level 10, Menara Billing",
    addressLine2: null,
    postcode: "50450",
    city: "Kuala Lumpur",
    stateCode: "14",
    state: "Wilayah Persekutuan Kuala Lumpur",
    countryCode: "MY",
    country: "Malaysia",
    phone: "+60 3-2000 0000",
    email: "billing@digital-billing.example",
    website: null,
    brandColor: "#112233",
    accentColor: "#445566",
    logoUrl: LOGO_DATA_URI,
  },
  payment: {
    bankName: "Maybank Berhad",
    accountName: "Digital Billing Sdn Bhd",
    accountNo: "5140-1234-5678",
    swift: "MBBEMYKL",
    jomPayBillerCode: "98765",
    remittanceEmail: "ar@digital-billing.example",
  },
  paymentTermsDays: 30,
  logoAssetVersionId: "INVASV00000001",
};

function rawInput(
  overrides: Partial<RawInvoiceRenderInput> = {},
): RawInvoiceRenderInput {
  return {
    bill: {
      customerBillId: "CBL00000001",
      periodPartition: "2026-08-01",
      billingAccountId: "BAN00000001",
      currency: "MYR",
      billingPeriodStart: "2026-08-01",
      billingPeriodEnd: "2026-08-31",
      paymentDueDate: "2026-09-15",
      subtotal: "150.00",
      taxTotal: "0.00",
      totalAmount: "150.00",
      linesNetSum: "150.00",
      grossTotal: "150.00",
      discountTotal: "0.00",
      usageRatedTotal: "0.00",
    },
    run: { billRunId: "BRN00000042", cycleName: "Enterprise Monthly" },
    lines: [
      {
        lineNo: 1,
        source: "RECURRING",
        lineType: "charge",
        description: "Enterprise Fibre 1Gbps",
        refProductOfferingId: "POF00000010",
        udrType: null,
        udrCount: null,
        quantity: "1.000000",
        unit: "EA",
        snapshotQuantity: "1.000000",
        snapshotUnitPrice: "50.00",
        grossAmount: "50.00",
        discountAmount: "0.00",
        netAmount: "50.00",
        discountRate: null,
        groupGrossTotal: "50.00",
        groupDiscountTotal: "0.00",
        groupNetTotal: "50.00",
      },
      {
        lineNo: 2,
        source: "USAGE",
        lineType: "charge",
        description: "RAN Usage",
        refProductOfferingId: "POF00000020",
        udrType: "RAN_USAGE",
        udrCount: 2,
        quantity: "100.000000",
        unit: "GB",
        snapshotQuantity: null,
        snapshotUnitPrice: null,
        grossAmount: "100.00",
        discountAmount: "0.00",
        netAmount: "100.00",
        discountRate: null,
        groupGrossTotal: "100.00",
        groupDiscountTotal: "0.00",
        groupNetTotal: "100.00",
      },
    ],
    taxItems: [],
    document: null,
    customer: {
      name: "Acme Communications Sdn Bhd",
      tradingName: null,
      registrationNumber: null,
      taxId: null,
      email: null,
      phone: null,
      address: null,
    },
    usage: null,
    ...overrides,
  };
}

async function renderDraft(
  overrides: Partial<RawInvoiceRenderInput> = {},
  profile: InvoiceProfile | null = null,
) {
  const { invoice } = await loadGenerated(SEEDED_GENERATED);
  const input = bind(rawInput(overrides), {
    isDraft: true,
    locale: "en-MY",
    timezone: "UTC",
    includeUsage: true,
    template: TEMPLATE,
    profile,
  });
  return executeInvoiceTemplate(invoice, input);
}

async function renderFinal(
  overrides: Partial<RawInvoiceRenderInput> = {},
  profile: InvoiceProfile | null = null,
) {
  const { invoice } = await loadGenerated(SEEDED_GENERATED);
  const merged = rawInput({
    document: {
      documentId: "INV00000042",
      postingDate: new Date("2026-09-05"),
    },
    ...overrides,
  });
  const input = bind(merged, {
    isDraft: false,
    locale: "en-MY",
    timezone: "UTC",
    includeUsage: true,
    invoiceNo: "INV00000042",
    template: TEMPLATE,
    profile,
  });
  return executeInvoiceTemplate(invoice, input);
}

async function renderFooter(profile: InvoiceProfile | null) {
  const { footer } = await loadGenerated(SEEDED_GENERATED);
  return executeInvoiceTemplate(
    footer,
    bind(rawInput(), {
      isDraft: true,
      locale: "en-MY",
      timezone: "UTC",
      includeUsage: true,
      template: TEMPLATE,
      profile,
    }),
  );
}

describe("the default generated template — draft", () => {
  it("shows the pending-posting placeholder and the indicative total label", async () => {
    const html = await renderDraft();
    expect(html).toContain("— pending posting —");
    expect(html).toContain("Total (indicative)");
  });

  it("carries the DRAFT watermark, position: fixed", async () => {
    const html = await renderDraft();
    expect(html).toContain("DRAFT");
    expect(html).toMatch(/\.watermark\s*\{[^}]*position:\s*fixed/);
  });

  it("renders every RECURRING and USAGE line", async () => {
    const html = await renderDraft();
    expect(html).toContain("Enterprise Fibre 1Gbps");
    expect(html).toContain("RAN Usage");
  });

  it("omits the issuer and payment blocks when company/payment are null (G15)", async () => {
    const html = await renderDraft();
    expect(html).not.toContain('class="issuer"');
    expect(html).not.toContain("sec--payment");
  });

  it("states that amount due covers current charges only (Inv #50)", async () => {
    const html = await renderDraft();
    expect(html).toContain(
      "Amount due covers the current charges on this invoice only.",
    );
  });

  it("renders the usage annex on the draft too (bm49: billed udr_rated rows, state → district)", async () => {
    const html = await renderDraft({
      bill: { ...rawInput().bill, usageRatedTotal: "30000.00" },
      usage: {
        overLimit: false,
        rows: [
          {
            startDate: "2026-08-03",
            cell: "POLY-001",
            udrType: "RAN_USAGE",
            quantity: "300.000000",
            unit: "EA",
            amount: "30000.00",
            state: "State-02",
            district: "District-03",
          },
        ],
        groups: [
          {
            state: "State-02",
            district: "District-03",
            gState: 0,
            gDistrict: 0,
            rowCount: 1,
            amount: "30000.00",
            quantity: "300.000000",
            unit: "EA",
          },
          {
            state: "State-02",
            district: null,
            gState: 0,
            gDistrict: 1,
            rowCount: 1,
            amount: "30000.00",
            quantity: "300.000000",
            unit: "EA",
          },
          {
            state: null,
            district: null,
            gState: 1,
            gDistrict: 1,
            rowCount: 1,
            amount: "30000.00",
            quantity: "300.000000",
            unit: "EA",
          },
        ],
      },
    });
    expect(html).toContain("Usage annex — billed usage by region");
    expect(html).toContain("POLY-001");
    expect(html).toContain("State-02");
    expect(html).toContain("Total rated usage");
  });

  it("escapes free-text account names", async () => {
    const html = await renderDraft({
      customer: { ...rawInput().customer, name: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the default generated template — final", () => {
  it("shows the real INV number and no watermark", async () => {
    const html = await renderFinal();
    expect(html).toContain("INV00000042");
    expect(html).not.toContain("— pending posting —");
    expect(html).not.toMatch(/class="watermark"/);
  });

  it("renders every RECURRING and USAGE line, same template as the draft", async () => {
    const html = await renderFinal();
    expect(html).toContain("Enterprise Fibre 1Gbps");
    expect(html).toContain("RAN Usage");
  });

  it("states that amount due covers current charges only on the final too", async () => {
    const html = await renderFinal();
    expect(html).toContain(
      "Amount due covers the current charges on this invoice only.",
    );
  });
});

// bm53-spec §Tests (extend) — G15 option A: the issuer/payment blocks print
// only from a resolved profile.
describe("the default generated template — company profile (G15 A)", () => {
  it("no ACTIVE profile: no issuer block, no logo, no payment block, no company in the footer", async () => {
    const html = await renderFinal({}, null);
    expect(html).not.toContain('class="issuer"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("sec--payment");
    expect(await renderFooter(null)).not.toContain("Digital Billing");
  });

  it("a fixture ACTIVE profile: issuer block, inlined data: logo, bank block, brand colours", async () => {
    const html = await renderFinal({}, PROFILE);
    expect(html).toContain('class="issuer"');
    // Auto-escaping encodes the base64 `=` padding as `&#x3D;`; the browser
    // decodes attribute entities, so the `src` is the same data: URI.
    expect(html).toContain(
      `<img src="${LOGO_DATA_URI.replaceAll("=", "&#x3D;")}"`,
    );
    expect(html).not.toMatch(/<img src="http/);
    expect(html).toContain("Digital Billing Sdn Bhd");
    expect(html).toContain("sec--payment");
    expect(html).toContain("Maybank Berhad");
    expect(html).toContain("5140-1234-5678");
    expect(html).toContain("SWIFT MBBEMYKL");
    expect(html).toContain("JomPAY 98765");
    expect(html).toContain("--inv-brand: #112233");
    expect(html).toContain("--inv-accent: #445566");
    expect(await renderFooter(PROFILE)).toContain("Digital Billing Sdn Bhd");
  });

  it("a profile without a logo still prints the issuer block, minus the image", async () => {
    const html = await renderFinal(
      {},
      { ...PROFILE, company: { ...PROFILE.company, logoUrl: null } },
    );
    expect(html).toContain('class="issuer"');
    expect(html).not.toContain("<img");
  });

  it("escapes a profile field carrying markup (guardrail 50)", async () => {
    const html = await renderFinal(
      {},
      {
        ...PROFILE,
        company: { ...PROFILE.company, name: "<script>alert(1)</script>" },
      },
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
