import { describe, expect, it } from "vitest";

import { bind } from "@/services/billing/invoice-template/bind";
import { loadDefaultTemplateFromRepo } from "@/services/billing/invoice-template/load-stopgap";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";

// bm47-spec §Design D1/D8, test plan row 3 ("rewritten, bm18/bm19 cases
// moved"). DB-free: exercises the real seeded
// `db/seeds/invoice-templates/generated/INVOICE/v1/*.hbs` through
// `bind()` + the stopgap loader, over a hand-built `RawInvoiceRenderInput`
// fixture — no database, no Playwright.

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

async function renderDraft(overrides: Partial<RawInvoiceRenderInput> = {}) {
  const { render } = await loadDefaultTemplateFromRepo();
  const input = bind(rawInput(overrides), {
    isDraft: true,
    locale: "en-MY",
    timezone: "UTC",
    includeUsage: true,
  });
  return render(input);
}

async function renderFinal(overrides: Partial<RawInvoiceRenderInput> = {}) {
  const { render } = await loadDefaultTemplateFromRepo();
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
  });
  return render(input);
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
            state: "Selangor",
            district: "Petaling",
          },
        ],
        groups: [
          {
            state: "Selangor",
            district: "Petaling",
            gState: 0,
            gDistrict: 0,
            rowCount: 1,
            amount: "30000.00",
            quantity: "300.000000",
            unit: "EA",
          },
          {
            state: "Selangor",
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
    expect(html).toContain("Selangor");
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
