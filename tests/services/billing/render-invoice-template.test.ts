import { describe, expect, it } from "vitest";

import { buildDraftInvoiceHtml } from "@/services/billing/render-invoice-template";

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
