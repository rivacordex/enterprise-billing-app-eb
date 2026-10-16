import { describe, expect, it } from "vitest";

import { bind } from "@/services/billing/invoice-template/bind";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";
import { rawInvoiceRenderInputFixture } from "@/tests/helpers/invoice-render-input-fixtures";

// bm47-spec §Design D2/D3/D4/D5 + bm49-spec §Design D3/D4/D5/D6 + bm70-spec
// §6, test plan rows. Pure, DB-free — `bind()` takes no DB/Handlebars/next
// import.

const rawInput = rawInvoiceRenderInputFixture;

const TEMPLATE = { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 };

const CTX = {
  isDraft: true,
  locale: "en-MY",
  timezone: "UTC",
  includeUsage: true,
  template: TEMPLATE,
  profile: null,
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
        otherChargesSubTotal: "0.00",
        summaryBlocksSum: "0.00",
      },
      otherCharges: [],
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
        template: TEMPLATE,
        profile: null,
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
        template: TEMPLATE,
        profile: null,
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
      template: TEMPLATE,
      profile: null,
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

  it("bm70 — no longer emits the per-source chargeSummary", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound).not.toHaveProperty("chargeSummary");
  });
});

// bm70-spec §Design — the `ci` capacity fixture (base RM100/Mbps, target
// 1,000, step above 1,000 at RM50): the SQL figures the repository returns for
// each anchor (Unutilised = Σ(gross − rated), Utilised = Σ net − Unutilised).
const ANCHORS = [
  {
    usage: "800",
    utilised: "80000.00",
    unutilised: "20000.00",
    total: "100000.00",
  },
  {
    usage: "1000",
    utilised: "100000.00",
    unutilised: "0.00",
    total: "100000.00",
  },
  {
    usage: "2000",
    utilised: "150000.00",
    unutilised: "0.00",
    total: "150000.00",
  },
  {
    usage: "0",
    utilised: "0.00",
    unutilised: "100000.00",
    total: "100000.00",
  },
] as const;

function serviceType(
  offeringId: string,
  label: string,
  utilised: string,
  unutilised: string,
  total: string,
  flags: { missingRated?: boolean; negativeUtilised?: boolean } = {},
): RawInvoiceRenderInput["serviceTypes"][number] {
  return {
    offeringId,
    label,
    utilised,
    unutilised,
    total,
    missingRated: flags.missingRated ?? false,
    negativeUtilised: flags.negativeUtilised ?? false,
  };
}

// A capacity-only bill: one type whose Total is the whole subtotal.
function capacityRaw(
  type: RawInvoiceRenderInput["serviceTypes"][number],
): RawInvoiceRenderInput {
  return rawInput({
    bill: {
      ...rawInput().bill,
      subtotal: type.total,
      totalAmount: type.total,
      linesNetSum: type.total,
      otherChargesSubTotal: "0.00",
      summaryBlocksSum: type.total,
    },
    lines: [],
    serviceTypes: [type],
    otherCharges: [],
  });
}

function bindError(raw: RawInvoiceRenderInput): InvoiceRenderError {
  let caught: unknown;
  try {
    bind(raw, CTX);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(InvoiceRenderError);
  return caught as InvoiceRenderError;
}

describe("bind — page-1 capacity summary (bm70)", () => {
  it.each(ANCHORS)(
    "the $usage Mbps anchor maps to Utilised $utilised / Unutilised $unutilised / Total $total and Grand Total $total",
    (a) => {
      const bound = bind(
        capacityRaw(
          serviceType("POF-CAP", "Capacity", a.utilised, a.unutilised, a.total),
        ),
        CTX,
      );
      expect(bound.serviceTypes).toEqual([
        {
          offeringId: "POF-CAP",
          label: "Capacity",
          utilised: a.utilised,
          unutilised: a.unutilised,
          total: a.total,
        },
      ]);
      expect(bound.totals.totalCharges).toBe(a.total);
      expect(bound.totals.amountDue).toBe(a.total);
      expect(bound.totals.adjustments).toBe("0.00");
    },
  );

  it("keeps two types in the repository's label order", () => {
    // The repository sorts by label (ORDER BY min(description)); the binder
    // keeps that order.
    const bound = bind(
      rawInput({
        bill: {
          ...rawInput().bill,
          subtotal: "250000.00",
          totalAmount: "250000.00",
          linesNetSum: "250000.00",
          otherChargesSubTotal: "0.00",
          summaryBlocksSum: "250000.00",
        },
        lines: [],
        otherCharges: [],
        serviceTypes: [
          serviceType(
            "POF-B",
            "Alpha Capacity",
            "80000.00",
            "20000.00",
            "100000.00",
          ),
          serviceType(
            "POF-A",
            "Beta Capacity",
            "150000.00",
            "0.00",
            "150000.00",
          ),
        ],
      }),
      CTX,
    );
    expect(bound.serviceTypes.map((t) => t.label)).toEqual([
      "Alpha Capacity",
      "Beta Capacity",
    ]);
  });

  it("binds Other charges and their Sub Total when non-capacity lines exist", () => {
    const bound = bind(rawInput(), CTX);
    expect(bound.otherCharges).toEqual([
      { description: "Enterprise Fibre 1Gbps", amount: "50.00" },
      { description: "RAN Usage", amount: "100.00" },
    ]);
    expect(bound.totals.otherChargesSubTotal).toBe("150.00");
  });

  it("binds no Other charges on a capacity-only bill", () => {
    const a = ANCHORS[2];
    const bound = bind(
      capacityRaw(
        serviceType("POF-CAP", "Capacity", a.utilised, a.unutilised, a.total),
      ),
      CTX,
    );
    expect(bound.otherCharges).toEqual([]);
    expect(bound.totals.otherChargesSubTotal).toBe("0.00");
  });

  it("binds the recipient name, and null when the contact name is blank", () => {
    expect(bind(rawInput(), CTX).customer.recipientName).toBe("Aisha Rahman");
    const raw = rawInput();
    raw.customer = { ...raw.customer, recipientName: null };
    expect(bind(raw, CTX).customer.recipientName).toBeNull();
  });

  it('binds the tax rate label from the first tax item, else "0"', () => {
    expect(bind(rawInput(), CTX).taxRateLabel).toBe("0");
    const bound = bind(
      rawInput({
        taxItems: [{ category: "SST", rate: "8.00", amount: "0.00" }],
      }),
      CTX,
    );
    expect(bound.taxRateLabel).toBe("8.00");
  });

  it("guard 1 — a capacity line without rated_amount throws INVOICE_RECONCILIATION_FAILED", () => {
    const err = bindError(
      capacityRaw(
        serviceType("POF-CAP", "Capacity", "100000.00", "0.00", "100000.00", {
          missingRated: true,
        }),
      ),
    );
    expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      offeringId: "POF-CAP",
      reason: "CAPACITY_LINE_WITHOUT_RATED_AMOUNT",
    });
  });

  it("guard 2 — a negative Utilised throws INVOICE_NEGATIVE_UTILISED", () => {
    const err = bindError(
      capacityRaw(
        serviceType("POF-CAP", "Capacity", "-500.00", "0.00", "99500.00", {
          negativeUtilised: true,
        }),
      ),
    );
    expect(err.code).toBe("INVOICE_NEGATIVE_UTILISED");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      offeringId: "POF-CAP",
      utilised: "-500.00",
    });
  });

  it("guard 3 — summary blocks that do not add up to the lines net sum throw INVOICE_RECONCILIATION_FAILED", () => {
    const raw = rawInput({
      bill: { ...rawInput().bill, summaryBlocksSum: "149.99" },
    });
    const err = bindError(raw);
    expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      reason: "SUMMARY_BLOCKS_DO_NOT_ADD_UP",
    });
  });

  it("the guards run before the D2 subtotal reconciliation", () => {
    // Both a negative Utilised and a subtotal mismatch: the guard wins.
    const raw = capacityRaw(
      serviceType("POF-CAP", "Capacity", "-1.00", "0.00", "100.00", {
        negativeUtilised: true,
      }),
    );
    raw.bill = { ...raw.bill, subtotal: "999.00" };
    expect(bindError(raw).code).toBe("INVOICE_NEGATIVE_UTILISED");
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
            "State-01",
            "District-01",
          ),
          row(
            "2026-08-09",
            "POLY-004",
            "250.000000",
            "25000.00",
            "State-01",
            "District-09",
          ),
          row(
            "2026-08-03",
            "POLY-001",
            "300.000000",
            "30000.00",
            "State-02",
            "District-03",
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
          dgroup("State-01", "District-01", 1, "70000.00", "700.000000", "EA"),
          dgroup("State-01", "District-09", 1, "25000.00", "250.000000", "EA"),
          dgroup("State-02", "District-03", 1, "30000.00", "300.000000", "EA"),
          dgroup(null, null, 1, "5000.00", "50.000000", "EA"),
          sgroup("State-01", 2, "95000.00", "950.000000", "EA"),
          sgroup("State-02", 1, "30000.00", "300.000000", "EA"),
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
      "State-01",
      "State-02",
      null,
    ]);
    expect(usage.states[0]!.amount).toBe("95000.00");
    expect(usage.states[0]!.rowCount).toBe(2);
    expect(usage.states[0]!.districts.map((d) => d.district)).toEqual([
      "District-01",
      "District-09",
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
