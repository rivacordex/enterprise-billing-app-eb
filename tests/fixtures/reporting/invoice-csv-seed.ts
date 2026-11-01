import type postgresjs from "postgres";

import { createPostedInvoiceFixtures } from "@/tests/fixtures/reporting/posted-invoice-fixtures";
import type { PostedInvoice } from "@/tests/fixtures/reporting/posted-invoice-fixtures";

export type { PostedInvoice };

// rpt08-spec Implementation §4 — the Part D seed. Every invoice is built
// through the real bill-run path (posted-invoice-fixtures.ts, shared with the
// rpt09 GL feed seed), so the `udr_rated` claims and capacity lines are the
// ones production would write and post. The suite mocks the post-commit PDF
// render: posting never depends on it (D10), and the parity case reads the
// capacity detail directly.
//
// Its own seed, not the Part A one: Part C reports every party role with a
// billing account, so adding MNOs there would change rpt05's expected file.
//
// Invoices (posted on 2026-10-05, Asia/Kuala_Lumpur, unless stated):
//   P2 — MNO-P, posted first (the lower INV number): one polygon, 2.5 Mbps,
//        no discount (R08-T7)
//   P1 — MNO-P, another bill run and BAN (R08-T5): polygons 500.00 / 300.00 /
//        200.00 with a 100.00 line discount (R08-T6), and a claimed row in
//        another unit, billed as an ordinary USAGE line (R08-T3)
//   Q1 — MNO-Q, posted 23:59: polygons 100.00 / 125.00, a 5.00 discount that
//        doesn't split evenly (2.22 / 2.78)
//   Q2 — MNO-Q, posted 00:01 on 2026-10-06: not on the 20261005 file (Inv 8)
//   R1 — MNO-R, a polygon row with no polygon_id= key (POLYGON_ID_MISSING)
//   R2 — MNO-R, a polygon row with no commercial_unit= key
//        (COMMERCIAL_UNIT_MISSING); MNO-R gets no file
//   S1 — a party role with no mnoPublicKey1 (MNO_PUBLIC_KEY_MISSING)
//   T1 — MNO-T, a commitment-only capacity line with no usage
//        (NO_POLYGON_LINES)

export const INVOICE_DAY = "20261005";
export const NEXT_DAY = "20261006";

export const MNO = { P: "MNO-P", Q: "MNO-Q", R: "MNO-R", T: "MNO-T" } as const;

const PREFIX = "RPT08";
const PERIOD_START = "2026-09-01";
const PERIOD_END = "2026-09-30";
const CLAIM_AT = "2026-09-10T00:00:00.000Z";

export const PRODUCT = {
  embb: "eMBB Wholesale 5G Network",
  fwa: "FWA Wholesale Capacity",
} as const;

export interface InvoiceCsvFixture {
  // By fixture name (P1 … T1).
  invoices: Record<string, PostedInvoice>;
}

export async function seedInvoiceCsvFixture(
  sql: postgresjs.Sql,
): Promise<InvoiceCsvFixture> {
  const { postedInvoice } = await createPostedInvoiceFixtures(sql, {
    prefix: PREFIX,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    claimAt: CLAIM_AT,
  });

  // A capacity offering is one with a commitment or motivation component
  // (bm42, Inv #32); a band no fixture reaches gives a 0.00 line discount.
  const usageOnly = {
    baseRate: "100",
    committedQuantity: null,
    steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
  };
  const at = (time: string) => `2026-10-05T${time}+08:00`;
  const invoices: Record<string, PostedInvoice> = {};

  invoices.P2 = await postedInvoice({
    label: "P2",
    mno: MNO.P,
    product: PRODUCT.fwa,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-P-0004", commercialUnit: "CU-P-2", ea: 2.5 }],
    postedAt: at("09:00:00"),
  });
  invoices.P1 = await postedInvoice({
    label: "P1",
    mno: MNO.P,
    product: PRODUCT.embb,
    // 10 Mbps: the 5 above 5 at RM80 instead of RM100, a 100.00 line discount.
    offering: {
      baseRate: "100",
      committedQuantity: null,
      steps: [{ aboveQuantity: 5, ratePerUnit: "80" }],
    },
    polygons: [
      { polygonId: "PCU-P-0001", commercialUnit: "CU-P-1", ea: 5 },
      {
        polygonId: "PCU-P-0002",
        commercialUnit: "CU-P-1",
        ea: 3,
        start: "2025-04-15",
      },
      { polygonId: "PCU-P-0003", commercialUnit: "CU-P-1", ea: 2 },
    ],
    otherUnitGb: 4,
    postedAt: at("10:00:00"),
  });
  invoices.Q1 = await postedInvoice({
    label: "Q1",
    mno: MNO.Q,
    product: PRODUCT.embb,
    // 0.25 Mbps above 2 at RM80: a 5.00 line discount over 100.00 / 125.00.
    offering: {
      baseRate: "100",
      committedQuantity: null,
      steps: [{ aboveQuantity: 2, ratePerUnit: "80" }],
    },
    polygons: [
      { polygonId: "PCU-Q-0001", commercialUnit: "CU-Q-1", ea: 1 },
      { polygonId: "PCU-Q-0002", commercialUnit: "CU-Q-1", ea: 1.25 },
    ],
    postedAt: at("23:59:00"),
  });
  invoices.Q2 = await postedInvoice({
    label: "Q2",
    mno: MNO.Q,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-Q-0003", commercialUnit: "CU-Q-2", ea: 1 }],
    postedAt: "2026-10-06T00:01:00+08:00",
  });
  invoices.R1 = await postedInvoice({
    label: "R1",
    mno: MNO.R,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: null, commercialUnit: "CU-R-1", ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.R2 = await postedInvoice({
    label: "R2",
    mno: MNO.R,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-R-0002", commercialUnit: null, ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.S1 = await postedInvoice({
    label: "S1",
    mno: null,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-S-0001", commercialUnit: "CU-S-1", ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.T1 = await postedInvoice({
    label: "T1",
    mno: MNO.T,
    product: PRODUCT.embb,
    // The commitment floor alone: a capacity line, no claimed row.
    offering: { baseRate: "100", committedQuantity: 2, steps: null },
    polygons: [],
    postedAt: at("09:00:00"),
  });
  return { invoices };
}
