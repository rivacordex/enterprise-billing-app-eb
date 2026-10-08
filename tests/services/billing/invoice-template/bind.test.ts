import { describe, expect, it } from "vitest";

import { bind } from "@/services/billing/invoice-template/bind";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";

// bm47-spec §Design D2/D3/D4/D5, §Implementation §4, test plan row 1.
// Pure, DB-free — `bind()` takes no DB/Handlebars/next import.

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
        grossAmount: "120.00",
        discountAmount: "20.00",
        netAmount: "100.00",
        discountRate: "16.666667",
        groupGrossTotal: "120.00",
        groupDiscountTotal: "20.00",
        groupNetTotal: "100.00",
      },
    ],
    taxItems: [],
    document: null,
    customer: {
      name: "Acme Communications Sdn Bhd",
      tradingName: "Acme Communications",
      registrationNumber: "201001098765",
      taxId: "C98765432109",
      email: "accounts@acme.example",
      phone: "+60 3-7654 3210",
      address: {
        line1: "Suite 5, Wisma Acme",
        line2: null,
        city: "Petaling Jaya",
        stateProvince: "Selangor",
        postalCode: "46050",
        country: "Malaysia",
      },
    },
    usage: null,
    ...overrides,
  };
}

describe("bind — reconciliation (D2)", () => {
  it("throws INVOICE_RECONCILIATION_FAILED with both strings when lines net sum != subtotal", () => {
    const raw = rawInput({
      bill: { ...rawInput().bill, subtotal: "151.00" },
    });

    let caught: unknown;
    try {
      bind(raw, { isDraft: true, locale: "en-MY", timezone: "UTC" });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvoiceRenderError);
    const err = caught as InvoiceRenderError;
    expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
    expect(err.detail).toMatchObject({
      subtotal: "151.00",
      linesNetSum: "150.00",
      customerBillId: "CBL00000001",
    });
  });

  it("reconciles a zero-line bill (COALESCE(SUM,0.00))", () => {
    const raw = rawInput({
      lines: [],
      bill: {
        ...rawInput().bill,
        subtotal: "0.00",
        totalAmount: "0.00",
        linesNetSum: "0.00",
        grossTotal: "0.00",
        discountTotal: "0.00",
      },
    });
    const bound = bind(raw, { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.lineGroups).toEqual([]);
  });

  it("asserts the bound document id against the final render's requested invoice number", () => {
    const raw = rawInput({
      document: { documentId: "INV00000001", postingDate: new Date("2026-09-05") },
    });

    let caught: unknown;
    try {
      bind(raw, {
        isDraft: false,
        locale: "en-MY",
        timezone: "UTC",
        invoiceNo: "INV00000002",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvoiceRenderError);
    expect((caught as InvoiceRenderError).code).toBe("INVOICE_DOCUMENT_MISMATCH");
  });

  it("throws FinalInvoiceNotFoundError on a final bind with no billing.document row", () => {
    const raw = rawInput({ document: null });
    expect(() =>
      bind(raw, { isDraft: false, locale: "en-MY", timezone: "UTC" }),
    ).toThrow(FinalInvoiceNotFoundError);
  });
});

describe("bind — invoice date", () => {
  it("formats the posting date as the calendar day in the app timezone, not UTC", () => {
    // 2026-09-04T16:30Z is 2026-09-05 00:30 in Asia/Kuala_Lumpur (UTC+8).
    const raw = rawInput({
      document: { documentId: "INV00000001", postingDate: new Date("2026-09-04T16:30:00Z") },
    });
    const ctx = { isDraft: false, locale: "en-MY", invoiceNo: "INV00000001" };
    expect(bind(raw, { ...ctx, timezone: "Asia/Kuala_Lumpur" }).invoice.date).toBe("2026-09-05");
    expect(bind(raw, { ...ctx, timezone: "UTC" }).invoice.date).toBe("2026-09-04");
  });
});

describe("bind — line groups (D3)", () => {
  it("orders groups RECURRING -> USAGE -> OCC and omits an empty group", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.lineGroups.map((g) => g.source)).toEqual(["RECURRING", "USAGE"]);
  });

  it("keeps a discount line in place inside its source group (no merge/compute)", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    const usageGroup = bound.lineGroups.find((g) => g.source === "USAGE")!;
    expect(usageGroup.lines).toHaveLength(1);
    expect(usageGroup.lines[0]!.discountNote).toBe("Discount 16.666667%");
    expect(usageGroup.grossTotal).toBe("120.00");
    expect(usageGroup.discountTotal).toBe("20.00");
    expect(usageGroup.subtotal).toBe("100.00");
  });

  it("falls back unitPrice/quantity per D3 and carries the bill's period onto every line", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    const recurring = bound.lineGroups.find((g) => g.source === "RECURRING")!.lines[0]!;
    expect(recurring.unitPrice).toBe("50.00");
    expect(recurring.periodStart).toBe("2026-08-01");
    expect(recurring.periodEnd).toBe("2026-08-31");

    const usage = bound.lineGroups.find((g) => g.source === "USAGE")!.lines[0]!;
    expect(usage.unitPrice).toBeNull();
  });

  it("builds chargeSummary with one entry per present group at the group subtotal", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.chargeSummary).toEqual([
      { name: "Recurring charges", source: "RECURRING", amount: "50.00" },
      { name: "Usage charges", source: "USAGE", amount: "100.00" },
    ]);
  });
});

describe("bind — company/payment/G9 fields (G15/G9 interim)", () => {
  it("binds company and payment as null, and every G9 field as null", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.company).toBeNull();
    expect(bound.payment).toBeNull();
    expect(bound.invoice.poRef).toBeNull();
    expect(bound.invoice.contractRef).toBeNull();
    expect(bound.customer.sstRegNo).toBeNull();
  });

  it("never leaves a key `undefined` anywhere in the bound object (deep walk)", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    const offenders: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (value === undefined) {
        offenders.push(path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          walk(v, path ? `${path}.${k}` : k);
        }
      }
    };
    walk(bound, "");
    expect(offenders).toEqual([]);
  });
});

describe("bind — usage section (D5)", () => {
  function usageRaw() {
    return rawInput({
      usage: {
        rows: [
          { polygon: "POLY-001", state: "Selangor", district: "Petaling", volume: "300.000000", amount: "30000.00", unit: "EA" },
          { polygon: "POLY-002", state: "Selangor", district: "Klang", volume: "250.000000", amount: "25000.00", unit: "EA" },
          { polygon: "POLY-003", state: "Johor", district: "Johor Bahru", volume: "200.000000", amount: "20000.00", unit: "EA" },
          { polygon: "POLY-UNMAPPED", state: null, district: null, volume: "100.000000", amount: "10000.00", unit: "EA" },
        ],
        subtotals: [
          { grain: "district" as const, state: "Selangor", district: "Petaling", amount: "30000.00" },
          { grain: "district" as const, state: "Selangor", district: "Klang", amount: "25000.00" },
          { grain: "district" as const, state: "Johor", district: "Johor Bahru", amount: "20000.00" },
          { grain: "district" as const, state: null, district: null, amount: "10000.00" },
          { grain: "state" as const, state: "Selangor", district: null, amount: "55000.00" },
          { grain: "state" as const, state: "Johor", district: null, amount: "20000.00" },
          { grain: "state" as const, state: null, district: null, amount: "10000.00" },
          { grain: "grand" as const, state: null, district: null, amount: "85000.00" },
        ],
      },
    });
  }

  it("is null when the bill has no appendix rows", () => {
    const bound = bind(rawInput(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.usage).toBeNull();
  });

  it("groups state -> district -> polygon, sorting the Unmapped state last, with SQL-summed subtotals", () => {
    const bound = bind(usageRaw(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    const usage = bound.usage!;
    expect(usage.states.map((s) => s.state)).toEqual(["Selangor", "Johor", null]);
    expect(usage.states[0]!.subtotalAmount).toBe("55000.00");
    expect(usage.states[0]!.districts.map((d) => d.district)).toEqual(["Petaling", "Klang"]);
    expect(usage.states[0]!.districts[0]!.subtotalAmount).toBe("30000.00");
    expect(usage.totalAmount).toBe("85000.00");
    expect(usage.rowCount).toBe(4);
    expect(usage.states[2]!.label).toBe("Unmapped (no ratecard entry)");
  });

  it("reports a single homogeneous unit, else null", () => {
    const bound = bind(usageRaw(), { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(bound.usage!.unit).toBe("EA");

    const mixed = usageRaw();
    mixed.usage!.rows[0]!.unit = "GB";
    const boundMixed = bind(mixed, { isDraft: true, locale: "en-MY", timezone: "UTC" });
    expect(boundMixed.usage!.unit).toBeNull();
  });
});
