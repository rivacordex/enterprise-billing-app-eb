import { describe, expect, it } from "vitest";

import { bind } from "@/services/billing/invoice-template/bind";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";

// bm47-spec §Design D2/D3/D4/D5 + bm49-spec §Design D3/D4/D5/D6, test plan
// rows. Pure, DB-free — `bind()` takes no DB/Handlebars/next import.

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

const CTX = {
  isDraft: true,
  locale: "en-MY",
  timezone: "UTC",
  includeUsage: true,
};

describe("bind — reconciliation (D2)", () => {
  it("throws INVOICE_RECONCILIATION_FAILED with both strings when lines net sum != subtotal", () => {
    const raw = rawInput({
      bill: { ...rawInput().bill, subtotal: "151.00" },
    });

    let caught: unknown;
    try {
      bind(raw, CTX);
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
    const bound = bind(raw, CTX);
    expect(bound.lineGroups).toEqual([]);
  });

  it("asserts the bound document id against the final render's requested invoice number", () => {
    const raw = rawInput({
      document: {
        documentId: "INV00000001",
        postingDate: new Date("2026-09-05"),
      },
    });

    let caught: unknown;
    try {
      bind(raw, {
        isDraft: false,
        locale: "en-MY",
        timezone: "UTC",
        includeUsage: true,
        invoiceNo: "INV00000002",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvoiceRenderError);
    expect((caught as InvoiceRenderError).code).toBe(
      "INVOICE_DOCUMENT_MISMATCH",
    );
  });

  it("throws FinalInvoiceNotFoundError on a final bind with no billing.document row", () => {
    const raw = rawInput({ document: null });
    expect(() =>
      bind(raw, {
        isDraft: false,
        locale: "en-MY",
        timezone: "UTC",
        includeUsage: true,
      }),
    ).toThrow(FinalInvoiceNotFoundError);
  });
});

describe("bind — invoice date", () => {
  it("formats the posting date as the calendar day in the app timezone, not UTC", () => {
    // 2026-09-04T16:30Z is 2026-09-05 00:30 in Asia/Kuala_Lumpur (UTC+8).
    const raw = rawInput({
      document: {
        documentId: "INV00000001",
        postingDate: new Date("2026-09-04T16:30:00Z"),
      },
    });
    const ctx = {
      isDraft: false,
      locale: "en-MY",
      includeUsage: true,
      invoiceNo: "INV00000001",
    };
    expect(
      bind(raw, { ...ctx, timezone: "Asia/Kuala_Lumpur" }).invoice.date,
    ).toBe("2026-09-05");
    expect(bind(raw, { ...ctx, timezone: "UTC" }).invoice.date).toBe(
      "2026-09-04",
    );
  });
});

describe("bind — line groups (D3)", () => {
  it("orders groups RECURRING -> USAGE -> OCC and omits an empty group", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound.lineGroups.map((g) => g.source)).toEqual([
      "RECURRING",
      "USAGE",
    ]);
  });

  it("keeps a discount line in place inside its source group (no merge/compute)", () => {
    const bound = bind(rawInput(), CTX);
    const usageGroup = bound.lineGroups.find((g) => g.source === "USAGE")!;
    expect(usageGroup.lines).toHaveLength(1);
    expect(usageGroup.lines[0]!.discountNote).toBe("Discount 16.666667%");
    expect(usageGroup.grossTotal).toBe("120.00");
    expect(usageGroup.discountTotal).toBe("20.00");
    expect(usageGroup.subtotal).toBe("100.00");
  });

  it("falls back unitPrice/quantity per D3 and carries the bill's period onto every line", () => {
    const bound = bind(rawInput(), CTX);
    const recurring = bound.lineGroups.find((g) => g.source === "RECURRING")!
      .lines[0]!;
    expect(recurring.unitPrice).toBe("50.00");
    expect(recurring.periodStart).toBe("2026-08-01");
    expect(recurring.periodEnd).toBe("2026-08-31");

    const usage = bound.lineGroups.find((g) => g.source === "USAGE")!.lines[0]!;
    expect(usage.unitPrice).toBeNull();
  });

  it("builds chargeSummary with one entry per present group at the group subtotal", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound.chargeSummary).toEqual([
      { name: "Recurring charges", source: "RECURRING", amount: "50.00" },
      { name: "Usage charges", source: "USAGE", amount: "100.00" },
    ]);
  });
});

describe("bind — company/payment/G9 fields (G15/G9 interim)", () => {
  it("binds company and payment as null, and every G9 field as null", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound.company).toBeNull();
    expect(bound.payment).toBeNull();
    expect(bound.invoice.poRef).toBeNull();
    expect(bound.invoice.contractRef).toBeNull();
    expect(bound.customer.sstRegNo).toBeNull();
  });

  it("never leaves a key `undefined` anywhere in the bound object (deep walk)", () => {
    const bound = bind(rawInput(), CTX);
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

describe("bind — usage section (bm49 D5)", () => {
  function row(
    startDate: string,
    cell: string,
    quantity: string,
    amount: string,
    state: string | null,
    district: string | null,
  ) {
    return {
      startDate,
      cell,
      udrType: "RAN_USAGE",
      quantity,
      unit: "EA",
      amount,
      state,
      district,
    };
  }
  function dgroup(
    state: string | null,
    district: string | null,
    rowCount: number,
    amount: string,
    quantity: string | null,
    unit: string | null,
  ) {
    return {
      state,
      district,
      gState: 0,
      gDistrict: 0,
      rowCount,
      amount,
      quantity,
      unit,
    };
  }
  function sgroup(
    state: string | null,
    rowCount: number,
    amount: string,
    quantity: string | null,
    unit: string | null,
  ) {
    return {
      state,
      district: null,
      gState: 0,
      gDistrict: 1,
      rowCount,
      amount,
      quantity,
      unit,
    };
  }
  function ggroup(
    rowCount: number,
    amount: string,
    quantity: string | null,
    unit: string | null,
  ) {
    return {
      state: null,
      district: null,
      gState: 1,
      gDistrict: 1,
      rowCount,
      amount,
      quantity,
      unit,
    };
  }

  // Two states × two districts + one Unassigned row, already ordered as the
  // repository returns them (state ASC NULLS LAST, district ASC NULLS LAST).
  function usageRaw(
    billOverrides: Partial<RawInvoiceRenderInput["bill"]> = {},
  ): RawInvoiceRenderInput {
    return rawInput({
      bill: {
        ...rawInput().bill,
        usageRatedTotal: "130000.00",
        ...billOverrides,
      },
      usage: {
        overLimit: false,
        rows: [
          row(
            "2026-08-07",
            "POLY-003",
            "700.000000",
            "70000.00",
            "Johor",
            "Johor Bahru",
          ),
          row(
            "2026-08-09",
            "POLY-004",
            "250.000000",
            "25000.00",
            "Johor",
            "Kluang",
          ),
          row(
            "2026-08-03",
            "POLY-001",
            "300.000000",
            "30000.00",
            "Selangor",
            "Petaling",
          ),
          row(
            "2026-08-11",
            "POLY-UNMAPPED",
            "50.000000",
            "5000.00",
            null,
            null,
          ),
        ],
        groups: [
          dgroup("Johor", "Johor Bahru", 1, "70000.00", "700.000000", "EA"),
          dgroup("Johor", "Kluang", 1, "25000.00", "250.000000", "EA"),
          dgroup("Selangor", "Petaling", 1, "30000.00", "300.000000", "EA"),
          dgroup(null, null, 1, "5000.00", "50.000000", "EA"),
          sgroup("Johor", 2, "95000.00", "950.000000", "EA"),
          sgroup("Selangor", 1, "30000.00", "300.000000", "EA"),
          sgroup(null, 1, "5000.00", "50.000000", "EA"),
          ggroup(4, "130000.00", "1300.000000", "EA"),
        ],
      },
    });
  }

  it("is null when the bill has no billed usage rows", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound.usage).toBeNull();
  });

  it("groups state -> district -> rows, Unassigned last, with SQL-summed subtotals", () => {
    const bound = bind(usageRaw(), CTX);
    const usage = bound.usage!;
    expect(usage.states.map((s) => s.state)).toEqual([
      "Johor",
      "Selangor",
      null,
    ]);
    expect(usage.states[0]!.amount).toBe("95000.00");
    expect(usage.states[0]!.rowCount).toBe(2);
    expect(usage.states[0]!.districts.map((d) => d.district)).toEqual([
      "Johor Bahru",
      "Kluang",
    ]);
    expect(usage.states[0]!.districts[0]!.amount).toBe("70000.00");
    expect(usage.states[2]!.label).toBe("Unassigned region");
    expect(usage.states[2]!.districts[0]!.label).toBe("—");
    expect(usage.totalAmount).toBe("130000.00");
    expect(usage.totalQuantity).toBe("1300.000000");
    expect(usage.unit).toBe("EA");
    expect(usage.rowCount).toBe(4);
  });

  it("carries the itemised record fields onto each row (startDate/cell/udrType)", () => {
    const bound = bind(usageRaw(), CTX);
    const firstRow = bound.usage!.states[0]!.districts[0]!.rows[0]!;
    expect(firstRow).toMatchObject({
      startDate: "2026-08-07",
      cell: "POLY-003",
      udrType: "RAN_USAGE",
      quantity: "700.000000",
      unit: "EA",
      amount: "70000.00",
    });
  });

  it("leaves a group's quantity subtotal null when the group mixes units", () => {
    const raw = usageRaw();
    const grand = raw.usage as Extract<typeof raw.usage, { overLimit: false }>;
    const grandGroup = grand.groups.find((g) => g.gState === 1)!;
    grandGroup.quantity = null;
    grandGroup.unit = null;
    const bound = bind(raw, CTX);
    expect(bound.usage!.totalQuantity).toBeNull();
    expect(bound.usage!.unit).toBeNull();
  });

  it("D6 — throws INVOICE_RECONCILIATION_FAILED (detail 'usage') when the annex total != USAGE rated_amount", () => {
    const raw = usageRaw({ usageRatedTotal: "129999.00" });
    let caught: unknown;
    try {
      bind(raw, CTX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvoiceRenderError);
    const err = caught as InvoiceRenderError;
    expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
    expect(err.detail).toMatchObject({
      detail: "usage",
      annexTotal: "130000.00",
    });
  });
});

describe("bind — usage over limit (bm49 D3)", () => {
  it("throws INVOICE_USAGE_OVER_LIMIT with the row count and the limit", () => {
    const raw = rawInput({ usage: { overLimit: true, rowCount: 10001 } });
    let caught: unknown;
    try {
      bind(raw, CTX);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvoiceRenderError);
    const err = caught as InvoiceRenderError;
    expect(err.code).toBe("INVOICE_USAGE_OVER_LIMIT");
    expect(err.detail).toMatchObject({ rowCount: 10001, limit: 10000 });
  });
});

describe("bind — hidden annex (bm49 D4)", () => {
  it("skips the read result entirely when includeUsage is false: usage null, no over-limit throw", () => {
    // Even an over-limit marker is ignored when the section is hidden.
    const raw = rawInput({ usage: { overLimit: true, rowCount: 999999 } });
    const bound = bind(raw, { ...CTX, includeUsage: false });
    expect(bound.usage).toBeNull();
  });
});
