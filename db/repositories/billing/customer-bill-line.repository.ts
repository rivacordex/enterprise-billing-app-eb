import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import type { BillLineRow, ChargeSource, LineType } from "@/types/billing";

// bm28-spec §Implementation §4. The read of `customer_bill_line` — the bill's
// charge record (Inv #3), one row per `(product_offering_id, udr_type)` grain,
// written by the flow's aggregation stage as `billrun_runtime`. `app_runtime`
// holds SELECT-only on this table (billrun-db-roles.sql Step 5b), so this is a
// plain read; there is no app-side write of `customer_bill_line` anywhere (the
// two-writer boundary, Inv #2). bm31 adds the SQL `charge_checksum` method to
// THIS repository (spec §4 note).
//
// `listForRun` joins each line to its `customer_bill` header so the read
// composes lines per bill for one run in a single round-trip; each row carries
// its `refCustomerBillId` so `list-account-bills.ts` can group them under the
// matching `CustomerBillRow`. Ordered by `lineNo` (deterministic, Inv #21).
export const customerBillLineRepository = {
  async listForRun(
    db: Database,
    billRunId: string,
  ): Promise<(BillLineRow & { refCustomerBillId: string })[]> {
    const rows = await db
      .select({
        refCustomerBillId: customerBillLine.refCustomerBillId,
        customerBillLineId: customerBillLine.customerBillLineId,
        lineNo: customerBillLine.lineNo,
        source: customerBillLine.source,
        lineType: customerBillLine.lineType,
        refProductOfferingId: customerBillLine.refProductOfferingId,
        udrType: customerBillLine.udrType,
        description: customerBillLine.description,
        quantity: customerBillLine.quantity,
        unit: customerBillLine.unit,
        grossAmount: customerBillLine.grossAmount,
        discountAmount: customerBillLine.discountAmount,
        netAmount: customerBillLine.netAmount,
        udrCount: customerBillLine.udrCount,
        groupingKey: customerBillLine.groupingKey,
        currency: customerBillLine.currency,
        // bm29 — the RECURRING price snapshot (D19); NULL for USAGE. Rendered in
        // the line's disclosure slot in place of the udr_rated drill-down.
        snapshotPriceRef: customerBillLine.snapshotPriceRef,
        snapshotUnitPrice: customerBillLine.snapshotUnitPrice,
        snapshotQuantity: customerBillLine.snapshotQuantity,
        snapshotEffectiveDate: customerBillLine.snapshotEffectiveDate,
      })
      .from(customerBillLine)
      .innerJoin(
        customerBill,
        and(
          eq(customerBill.customerBillId, customerBillLine.refCustomerBillId),
          eq(customerBill.periodPartition, customerBillLine.periodPartition),
        ),
      )
      .where(eq(customerBill.refBillRunId, billRunId))
      .orderBy(asc(customerBillLine.lineNo));

    return rows.map((r) => ({
      ...r,
      source: r.source as ChargeSource,
      lineType: r.lineType as LineType,
    }));
  },
};
