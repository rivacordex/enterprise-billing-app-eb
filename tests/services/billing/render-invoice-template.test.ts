import { describe, expect, it } from "vitest";

import {
  buildDraftInvoiceHtml,
  buildFinalInvoiceHtml,
} from "@/services/billing/render-invoice-template";

// bm18-spec §Design "Draft ≠ a valid invoice" / §Implementation §2 /
// Verification checklist. Pure function — no DB/Next.js/Playwright import —
// so it's tested directly, without a database or browser.

const BASE_PARAMS = {
  bill: {
    billingAccountId: "BAN00000001",
    accountName: "Acme Communications",
    currency: "MYR",
    billingPeriodStart: "2026-08-01",
    billingPeriodEnd: "2026-08-31",
    subtotal: "100.00",
    taxTotal: "8.00",
    totalAmount: "108.00",
    paymentDueDate: "2026-09-15",
  },
  taxItems: [{ category: "GST", rate: "8.00", amount: "8.00" }],
  lines: [
    {
      udrId: "01ABCDEF0000000000000000",
      udrType: "DATA_USAGE",
      startDatetime: new Date("2026-08-01T00:00:00Z"),
      endDatetime: new Date("2026-08-01T01:00:00Z"),
      udrUsageQuantity: "1.000000",
      udrUsageUnit: "GB",
      udrRatedPrice: "100.00",
      udrCurrency: "MYR",
    },
  ],
  run: { billRunId: "BRN00000042", cycleName: "Enterprise Monthly" },
  locale: "en-MY",
};

describe("buildDraftInvoiceHtml", () => {
  it("shows the pending-posting placeholder instead of a real invoice number", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).toContain("— pending posting —");
  });

  it("carries the DRAFT · PRO-FORMA · NOT A VALID INVOICE watermark", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).toContain("DRAFT");
    expect(html).toContain("PRO-FORMA");
    expect(html).toContain("NOT&nbsp;A&nbsp;VALID&nbsp;INVOICE");
  });

  it("keeps the watermark behind an opaque sheet (never over the printed figures, ui-context §6c)", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).toMatch(/\.sheet\s*\{[^}]*background:\s*#ffffff/);
    expect(html).toMatch(/\.sheet\s*\{[^}]*z-index:\s*1/);
    expect(html).toMatch(/\.watermark\s*\{[^}]*z-index:\s*0/);
  });

  it("renders the claimed charge line and its formatted amount", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).toContain("DATA_USAGE");
    expect(html).toContain("1.000000");
    expect(html).toContain("GB");
  });

  it("renders each tax item and formats totals through formatCurrency (no bare numbers)", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).toContain("GST @ 8.00%");
    // formatCurrency(..., "MYR", "en-MY") always includes a currency marker —
    // a bare ">108.00<" would mean a hand-formatted number slipped through.
    expect(html).not.toMatch(/>108\.00</);
  });

  it("falls back to an explicit empty state when there are no claimed lines yet", () => {
    const html = buildDraftInvoiceHtml({ ...BASE_PARAMS, lines: [] });
    expect(html).toContain("No claimed charge lines for this account yet.");
  });

  it("escapes free-text account names (no raw HTML injection)", () => {
    const html = buildDraftInvoiceHtml({
      ...BASE_PARAMS,
      bill: { ...BASE_PARAMS.bill, accountName: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" / §Implementation §3.
describe("buildFinalInvoiceHtml", () => {
  it("shows the real INV… number instead of the pending-posting placeholder", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
    });
    expect(html).toContain("INV00000042");
    expect(html).not.toContain("— pending posting —");
  });

  it("[CRITICAL] carries no DRAFT/PRO-FORMA watermark markup (ui-context §6c — this IS the issued record)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
    });
    expect(html).not.toContain("PRO-FORMA");
    expect(html).not.toContain("NOT&nbsp;A&nbsp;VALID&nbsp;INVOICE");
    expect(html).not.toMatch(/class="watermark"/);
  });

  it("drops the preview-only subtitle/footer copy", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
    });
    expect(html).not.toContain("Preview only");
    expect(html).not.toContain(
      "must not be sent to or relied upon by the customer",
    );
  });

  it("renders the same charge lines, tax items, and formatted totals as the draft (same template/engine)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
    });
    expect(html).toContain("DATA_USAGE");
    expect(html).toContain("GST @ 8.00%");
    // Positively assert the FINAL total renders — the `not.toMatch(/>108\.00</)`
    // guard alone is vacuous (formatCurrency emits "RM 108.00", so ">108.00<"
    // never appears and it would pass even if the total row were dropped): the
    // issued invoice shows the "Total due" label and the currency-formatted
    // total, never a bare number.
    expect(html).toContain("Total due");
    expect(html).toContain("108.00");
    expect(html).not.toMatch(/>108\.00</);
  });

  it("escapes free-text account names the same as the draft", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      bill: { ...BASE_PARAMS.bill, accountName: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the invoice number too (defense in depth, though document ids are system-generated)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "<b>INV00000042</b>",
    });
    expect(html).not.toContain("<b>INV00000042</b>");
  });
});

// bm45-spec §Implementation §3/§Design D3/D5 — the per-polygon usage
// appendix: final-only, present-only, grouped state -> district -> polygon,
// a card-missing polygon surfaced under "Unmapped", every total reconciled
// via `services/accounts/money.ts` (never JS float summation).
describe("buildFinalInvoiceHtml — usage appendix (bm45)", () => {
  const MAPPED_ROWS = [
    {
      polygon: "POLY-001",
      state: "Selangor",
      district: "Petaling",
      volume: "300.000000",
      amount: "30000.00",
      unit: "EA",
    },
    {
      polygon: "POLY-002",
      state: "Selangor",
      district: "Klang",
      volume: "250.000000",
      amount: "25000.00",
      unit: "EA",
    },
    {
      polygon: "POLY-003",
      state: "Johor",
      district: "Johor Bahru",
      volume: "200.000000",
      amount: "20000.00",
      unit: "EA",
    },
  ];
  const UNMAPPED_ROW = {
    polygon: "POLY-UNMAPPED",
    state: null,
    district: null,
    volume: "100.000000",
    amount: "10000.00",
    unit: "EA",
  };

  it("never renders the appendix on the draft invoice (D5 — final-only)", () => {
    const html = buildDraftInvoiceHtml(BASE_PARAMS);
    expect(html).not.toContain("Usage appendix");
  });

  it("renders nothing when no appendix is present or it is empty (final invoice, no capacity line)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
    });
    expect(html).not.toContain("Usage appendix");

    const htmlEmpty = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      appendix: [],
    });
    expect(htmlEmpty).not.toContain("Usage appendix");
  });

  it("groups mapped rows state -> district -> polygon with volume+unit and formatted amounts", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      appendix: MAPPED_ROWS,
    });
    expect(html).toContain("Usage appendix");
    expect(html).toContain("Selangor");
    expect(html).toContain("Johor");
    expect(html).toContain("Petaling");
    expect(html).toContain("Klang");
    expect(html).toContain("Johor Bahru");
    expect(html).toContain("POLY-001");
    expect(html).toContain("300.000000 EA");
  });

  it("rolls district/state/grand subtotals up to the sum of the rows (Model-1 rated amount)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      appendix: MAPPED_ROWS,
    });
    // Selangor = 30000 + 25000 = 55000.00; Johor = 20000.00;
    // grand total = 75000.00.
    expect(html).toContain("55,000.00");
    expect(html).toContain("20,000.00");
    expect(html).toContain("75,000.00");
  });

  it("surfaces a card-missing polygon under an Unmapped group, never dropping it (D3)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      appendix: [...MAPPED_ROWS, UNMAPPED_ROW],
    });
    expect(html).toContain("Unmapped (no ratecard entry)");
    expect(html).toContain("POLY-UNMAPPED");
    // grand total now includes the unmapped row too: 75000 + 10000 = 85000.00.
    expect(html).toContain("85,000.00");
  });

  it("escapes free-text state/district/polygon values (external, ratecard-sourced data)", () => {
    const html = buildFinalInvoiceHtml({
      ...BASE_PARAMS,
      invoiceNumber: "INV00000042",
      appendix: [
        {
          polygon: "<script>alert(1)</script>",
          state: "<b>State</b>",
          district: "<i>District</i>",
          volume: "1.000000",
          amount: "100.00",
          unit: "EA",
        },
      ],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<b>State</b>");
    expect(html).not.toContain("<i>District</i>");
    expect(html).toContain("&lt;script&gt;");
  });
});
