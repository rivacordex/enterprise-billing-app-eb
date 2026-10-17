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
import {
  BARE_RAW_CUSTOMER,
  rawInvoiceRenderInputFixture,
} from "@/tests/helpers/invoice-render-input-fixtures";

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

// The shared fixture with an undiscounted usage line, on a customer with no
// optional fields.
function rawInput(
  overrides: Partial<RawInvoiceRenderInput> = {},
): RawInvoiceRenderInput {
  const base = rawInvoiceRenderInputFixture();
  const [recurring, usage] = base.lines;
  return {
    ...base,
    lines: [
      recurring!,
      {
        ...usage!,
        grossAmount: "100.00",
        discountAmount: "0.00",
        discountRate: null,
      },
    ],
    customer: { ...BARE_RAW_CUSTOMER },
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

  it("renders the capacity detail pages on the draft too (bm71: type → State-District)", async () => {
    const html = await renderDraft({
      bill: {
        ...rawInput().bill,
        subtotal: "30150.00",
        totalAmount: "30150.00",
        linesNetSum: "30150.00",
        summaryBlocksSum: "30150.00",
      },
      serviceTypes: [
        {
          offeringId: "POF00000021",
          label: "RAN Target Capacity",
          utilised: "30000.00",
          unutilised: "0.00",
          total: "30000.00",
          ratedTotal: "30000.00",
          missingRated: false,
          negativeUtilised: false,
        },
      ],
      capacityDetail: {
        overLimit: false,
        rows: [
          {
            udrId: "UDR00000001",
            offeringId: "POF00000021",
            label: "RAN Target Capacity",
            regionLabel: "STATE-02 - DISTRICT-03",
            polygonStartDate: "2026-03-01",
            polygonId: "POLY-001",
            resourceOk: true,
            capacityMbps: "300.000000",
            ratePerMbps: "100.00",
            amount: "30000.00",
          },
        ],
        groups: [
          {
            offeringId: "POF00000021",
            regionLabel: "STATE-02 - DISTRICT-03",
            gRegion: 0,
            amount: "30000.00",
          },
          {
            offeringId: "POF00000021",
            regionLabel: null,
            gRegion: 1,
            amount: "30000.00",
          },
        ],
      },
    });
    expect(html).toContain(
      '<h2 class="detail-heading">RAN Target Capacity</h2>',
    );
    expect(html).toContain("Access Seeker: Acme Communications Sdn Bhd");
    expect(html).toContain("STATE-02 - DISTRICT-03");
    expect(html).toContain("POLY-001");
    expect(html).toContain("01/03/2026");
    expect(html).toContain("Sub Total");
    expect(html).not.toContain("Usage annex");
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

  it("a profile without a logo still prints the supplier block, minus the image", async () => {
    const html = await renderFinal(
      {},
      { ...PROFILE, company: { ...PROFILE.company, logoUrl: null } },
    );
    expect(html).toContain('class="supplier"');
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
