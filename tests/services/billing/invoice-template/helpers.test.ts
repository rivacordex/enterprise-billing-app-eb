import { describe, expect, it } from "vitest";

import { compileInvoiceTemplate } from "@/services/billing/invoice-template/compile";
import { KNOWN_HELPERS } from "@/services/billing/invoice-template/helpers";
import { InvoiceRenderError } from "@/types/billing";
import type { InvoiceRenderInput } from "@/types/billing";

// bm47-spec §Design D6, test plan row 2. Each of the nine helpers, compiled
// through the real locked-down env (`knownHelpersOnly`, `strict`).

function fixture(
  overrides: Partial<InvoiceRenderInput> = {},
): InvoiceRenderInput {
  return {
    template: { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 },
    company: null,
    payment: null,
    invoice: {
      number: "INV00000001",
      isDraft: false,
      date: "2026-09-05",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      dueDate: "2026-09-15",
      paymentTermsDays: null,
      currency: "MYR",
      billRunId: "BRN00000042",
      cycleName: "Enterprise Monthly",
      billRef: "CBL00000001",
      poRef: null,
      contractRef: null,
    },
    customer: {
      billingAccountId: "BAN00000001",
      recipientName: null,
      name: "Acme",
      tradingName: null,
      registrationNo: null,
      tin: null,
      sstRegNo: null,
      address: null,
      email: null,
      phone: null,
    },
    totals: {
      grossTotal: "100.00",
      discountTotal: "0.00",
      subtotalExclTax: "100.00",
      taxTotal: "0.00",
      totalAmount: "100.00",
      amountDue: "100.00",
      totalCharges: "100.00",
      adjustments: "0.00",
      otherChargesSubTotal: "0.00",
    },
    taxes: [],
    taxRateLabel: "0",
    serviceTypes: [],
    otherCharges: [],
    lineGroups: [],
    usage: null,
    isDraft: false,
    locale: "en-MY",
    timezone: "UTC",
    ...overrides,
  };
}

function render(source: string, data: InvoiceRenderInput): string {
  return compileInvoiceTemplate(source)(data);
}

// Most helper cases render a template against a single overridden `amountDue`.
function renderAmount(source: string, amountDue: string): string {
  return render(
    source,
    fixture({ totals: { ...fixture().totals, amountDue } }),
  );
}

describe("money", () => {
  it("formats through the shared formatCurrency (no bare number)", () => {
    const html = render("{{money totals.amountDue}}", fixture());
    expect(html).not.toBe("100.00");
    expect(html).toContain("100.00");
  });

  it("brackets a negative amount", () => {
    const html = renderAmount("{{money totals.amountDue}}", "-50.00");
    expect(html).toMatch(/^\(.*50\.00.*\)$/);
  });

  it("negate=true prints – for a zero amount", () => {
    const html = renderAmount("{{money totals.amountDue negate=true}}", "0.00");
    expect(html).toBe("–");
  });
});

describe("date / period", () => {
  it("formats a calendar date as DD/MM/YYYY (bm69)", () => {
    expect(render("{{date invoice.date}}", fixture())).toBe("05/09/2026");
  });

  it("renders a dash for a null date", () => {
    expect(
      render(
        "{{date invoice.date}}",
        fixture({ invoice: { ...fixture().invoice, date: null } }),
      ),
    ).toBe("—");
  });

  it("joins two dates with an en dash", () => {
    expect(
      render("{{period invoice.periodStart invoice.periodEnd}}", fixture()),
    ).toBe("01/08/2026 – 31/08/2026");
  });
});

describe("qty / price / int / amt", () => {
  // bm69 — whole number when the fraction is all zeros, else exactly 2 dp,
  // grouped by locale.
  it.each([
    ["1500", "1,500"],
    ["1500.000000", "1,500"],
    ["1500.5", "1,500.50"],
    ["1500.005", "1,500.01"], // display rounding
    ["0.25", "0.25"],
  ])("qty renders %s as %s", (value, expected) => {
    expect(renderAmount("{{qty totals.amountDue}}", value)).toBe(expected);
  });

  it("qty renders a dash for a null value", () => {
    const data = fixture({
      totals: {
        ...fixture().totals,
        amountDue: null as unknown as string,
      },
    });
    expect(render("{{qty totals.amountDue}}", data)).toBe("—");
  });

  it("price renders 2 dp at or above 1", () => {
    expect(renderAmount("{{price totals.amountDue}}", "12.5")).toBe("12.50");
  });

  it("price renders 4 dp below 1 (sub-cent unit rates)", () => {
    expect(renderAmount("{{price totals.amountDue}}", "0.0125")).toBe("0.0125");
  });

  it("int renders a grouped integer, no decimals", () => {
    expect(renderAmount("{{int totals.amountDue}}", "12345")).toBe("12,345");
  });

  it("amt renders 2 dp with no grouping", () => {
    expect(renderAmount("{{amt totals.amountDue}}", "12345.6")).toBe(
      "12345.60",
    );
  });
});

describe("unitCode", () => {
  it("maps a known unit to UN/ECE rec 20", () => {
    expect(
      render(
        "{{unitCode customer.billingAccountId}}",
        fixture({
          customer: { ...fixture().customer, billingAccountId: "GB" },
        }),
      ),
    ).toBe("E34");
  });

  it("passes an unrecognised unit through unchanged", () => {
    expect(
      render(
        "{{unitCode customer.billingAccountId}}",
        fixture({
          customer: { ...fixture().customer, billingAccountId: "XX" },
        }),
      ),
    ).toBe("XX");
  });
});

describe("asset", () => {
  it("throws TEMPLATE_COMPILE_FAILED — reserved, never used by layout v1", () => {
    expect(() =>
      render("{{asset customer.billingAccountId}}", fixture()),
    ).toThrow(InvoiceRenderError);
  });
});

describe("no helper returns SafeString", () => {
  it("escapes HTML in a value money/date/etc. wrap (the layout never needs {{{)", () => {
    const html = render(
      "{{customer.name}}",
      fixture({
        customer: { ...fixture().customer, name: "<script>alert(1)</script>" },
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("KNOWN_HELPERS", () => {
  it("still lists exactly the nine helpers (Inv #46, bm69)", () => {
    expect(Object.keys(KNOWN_HELPERS).sort()).toEqual(
      [
        "amt",
        "asset",
        "date",
        "int",
        "money",
        "period",
        "price",
        "qty",
        "unitCode",
      ].sort(),
    );
  });
});
