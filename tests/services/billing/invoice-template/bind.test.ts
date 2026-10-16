import { describe, expect, it } from "vitest";

import { bind } from "@/services/billing/invoice-template/bind";
import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import type {
  CapacityDetailGroupRaw,
  CapacityDetailRowRaw,
} from "@/db/repositories/billing/rated-lines.repository";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";
import { rawInvoiceRenderInputFixture } from "@/tests/helpers/invoice-render-input-fixtures";

// bm47-spec §Design D2/D3/D4/D5 + bm70-spec §6 + bm71-spec §6, test plan
// rows. Pure, DB-free — `bind()` takes no DB/Handlebars/next
// import.

const rawInput = rawInvoiceRenderInputFixture;

const TEMPLATE = { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: 1 };

const CTX = {
  isDraft: true,
  locale: "en-MY",
  timezone: "UTC",
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
    expect(bound.totals.totalCharges).toBe("0.00");
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

describe("bind — page-1 summary shape (bm70)", () => {
  it("no longer emits the per-source chargeSummary", () => {
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
  flags: {
    missingRated?: boolean;
    negativeUtilised?: boolean;
    ratedTotal?: string;
  } = {},
): RawInvoiceRenderInput["serviceTypes"][number] {
  return {
    offeringId,
    label,
    utilised,
    unutilised,
    total,
    // No detail rows unless a case adds them, so the detail total is 0.00.
    ratedTotal: flags.ratedTotal ?? "0.00",
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
          regions: [],
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

// bm71-spec §Design "Guards" / "Bind shape" — the detail pages. Two capacity
// types; rows arrive in the repository's D21 order (type label, region label
// with "Unassigned region" last, polygon id), Sub Totals and per-type totals
// summed in SQL.
describe("bind — capacity detail pages (bm71)", () => {
  function detailRow(
    udrId: string,
    offeringId: string,
    regionLabel: string,
    polygonId: string | null,
    amount: string,
    resourceOk = true,
  ): CapacityDetailRowRaw {
    return {
      udrId,
      offeringId,
      label: offeringId === "POF-A" ? "Alpha Capacity" : "Beta Capacity",
      regionLabel,
      polygonStartDate: "2025-03-01",
      polygonId,
      resourceOk,
      capacityMbps: "700.000000",
      ratePerMbps: "100.00",
      amount,
    };
  }

  function detailRaw(
    rows: CapacityDetailRowRaw[],
    groups: CapacityDetailGroupRaw[],
    ratedTotals: { a: string; b: string } = { a: "130000.00", b: "0.00" },
  ): RawInvoiceRenderInput {
    return rawInput({
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
          "POF-A",
          "Alpha Capacity",
          "130000.00",
          "0.00",
          "150000.00",
          {
            ratedTotal: ratedTotals.a,
          },
        ),
        serviceType(
          "POF-B",
          "Beta Capacity",
          "0.00",
          "100000.00",
          "100000.00",
          {
            ratedTotal: ratedTotals.b,
          },
        ),
      ],
      capacityDetail: { overLimit: false, rows, groups },
    });
  }

  const ROWS = [
    detailRow(
      "UDR-1",
      "POF-A",
      "STATE-01 - DISTRICT-01",
      "POLY-001",
      "70000.00",
    ),
    detailRow(
      "UDR-2",
      "POF-A",
      "STATE-01 - DISTRICT-01",
      "POLY-002",
      "25000.00",
    ),
    detailRow("UDR-3", "POF-A", "STATE-02", "POLY-003", "30000.00"),
    detailRow("UDR-4", "POF-A", "Unassigned region", "POLY-004", "5000.00"),
  ];
  const GROUPS: CapacityDetailGroupRaw[] = [
    {
      offeringId: "POF-A",
      regionLabel: "STATE-01 - DISTRICT-01",
      gRegion: 0,
      amount: "95000.00",
    },
    {
      offeringId: "POF-A",
      regionLabel: "STATE-02",
      gRegion: 0,
      amount: "30000.00",
    },
    {
      offeringId: "POF-A",
      regionLabel: "Unassigned region",
      gRegion: 0,
      amount: "5000.00",
    },
    { offeringId: "POF-A", regionLabel: null, gRegion: 1, amount: "130000.00" },
  ];

  it("groups each type's rows by region in the read order, with the SQL Sub Totals", () => {
    const bound = bind(detailRaw(ROWS, GROUPS), CTX);
    const alpha = bound.serviceTypes[0]!;
    expect(
      alpha.regions.map((r) => [r.label, r.subTotal, r.rows.length]),
    ).toEqual([
      ["STATE-01 - DISTRICT-01", "95000.00", 2],
      ["STATE-02", "30000.00", 1],
      ["Unassigned region", "5000.00", 1],
    ]);
    expect(alpha.regions[0]!.rows[0]).toEqual({
      polygonStartDate: "2025-03-01",
      polygonName: "POLY-001",
      capacityMbps: "700.000000",
      ratePerMbps: "100.00",
      amount: "70000.00",
    });
  });

  it("gives a type with a capacity line but no claimed row empty regions", () => {
    const bound = bind(detailRaw(ROWS, GROUPS), CTX);
    expect(bound.serviceTypes[1]!.label).toBe("Beta Capacity");
    expect(bound.serviceTypes[1]!.regions).toEqual([]);
  });

  it("no longer binds the old line table or usage annex", () => {
    const bound = bind(detailRaw(ROWS, GROUPS), CTX);
    expect(bound).not.toHaveProperty("lineGroups");
    expect(bound).not.toHaveProperty("usage");
  });

  it("throws INVOICE_POLYGON_DATA_MISSING (polygon_id) for a row without a polygon_id= segment", () => {
    const rows = [ROWS[0]!, { ...ROWS[1]!, polygonId: null }, ROWS[2]!];
    const err = bindError(detailRaw(rows, GROUPS));
    expect(err.code).toBe("INVOICE_POLYGON_DATA_MISSING");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      udrRatedId: "UDR-2",
      missing: "polygon_id",
    });
  });

  it("throws INVOICE_POLYGON_DATA_MISSING (udr_resource) for a NULL or malformed udr_resource", () => {
    const rows = [ROWS[0]!, { ...ROWS[1]!, resourceOk: false }];
    const err = bindError(detailRaw(rows, GROUPS));
    expect(err.code).toBe("INVOICE_POLYGON_DATA_MISSING");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      udrRatedId: "UDR-2",
      missing: "udr_resource",
    });
  });

  it("reports the first failing row", () => {
    const rows = [
      ROWS[0]!,
      { ...ROWS[1]!, resourceOk: false },
      { ...ROWS[2]!, polygonId: null },
    ];
    expect(bindError(detailRaw(rows, GROUPS)).detail).toMatchObject({
      udrRatedId: "UDR-2",
    });
  });

  it("throws INVOICE_RECONCILIATION_FAILED when a type's detail total differs from its rated_amount", () => {
    const err = bindError(
      detailRaw(ROWS, GROUPS, { a: "130000.01", b: "0.00" }),
    );
    expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
    expect(err.detail).toEqual({
      banId: "BAN00000001",
      offeringId: "POF-A",
      reason: "DETAIL_DOES_NOT_MATCH_RATED_AMOUNT",
    });
  });

  it("reconciles a type with no claimed row against a 0.00 rated_amount only", () => {
    const err = bindError(
      detailRaw(ROWS, GROUPS, { a: "130000.00", b: "1.00" }),
    );
    expect(err.detail).toMatchObject({
      offeringId: "POF-B",
      reason: "DETAIL_DOES_NOT_MATCH_RATED_AMOUNT",
    });
  });

  it("throws INVOICE_USAGE_OVER_LIMIT with the BAN and the row count, on draft and final", () => {
    const raw = rawInput({
      capacityDetail: { overLimit: true, rowCount: 10001 },
      document: {
        documentId: "INV00000001",
        postingDate: new Date("2026-09-05"),
      },
    });
    for (const isDraft of [true, false]) {
      let caught: unknown;
      try {
        bind(raw, { ...CTX, isDraft });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvoiceRenderError);
      expect((caught as InvoiceRenderError).code).toBe(
        "INVOICE_USAGE_OVER_LIMIT",
      );
      expect((caught as InvoiceRenderError).detail).toEqual({
        banId: "BAN00000001",
        rowCount: 10001,
      });
    }
  });
});
