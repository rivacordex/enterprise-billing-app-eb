import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import type { BillLineRow, ChargeSource, LineType } from "@/types/billing";

// bm28-spec §Implementation §4. The read of `customer_bill_line` — the bill's
// charge record (Inv #3), one row per `(product_offering_id, udr_type)` grain,
// written by the flow's aggregation stage as `billrun_runtime`. `app_runtime`
// holds SELECT-only on this table (billrun-db-roles.sql Step 5b), so this is a
// plain read; there is no app-side write of `customer_bill_line` anywhere (the
// two-writer boundary, Inv #2). bm31 adds the SQL `computeChargeChecksum`
// method to THIS repository (spec §1) — the posting tamper-evidence anchor, now
// hashed over the bill's OWN line content instead of the claimed `udr_rated`
// rows (which yielded `md5('')` for a recurring-only bill).
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

  // bm31-spec §Implementation §1 — the posting `charge_checksum`, re-anchored
  // onto `customer_bill_line` content (Inv #3, D7a/D20). Hashes each line's
  // `(source, ref_product_offering_id, udr_type, line_type, gross_amount,
  // discount_amount, net_amount)` — all THREE money columns, so a discount that
  // preserves `net` (a future phase) still changes the hash — never the
  // auto-generated `customer_bill_line_id`, so the checksum reproduces from an
  // archived invoice's own content.
  //
  // Ordered by `line_no`, NOT `grouping_key`: the spec text says "ordered by the
  // same `grouping_key` that assigns `line_no`", but bm29 assigns `line_no` via
  // `row_number() OVER (ORDER BY grouping_key, source)` — the `source` tiebreaker
  // exists because `grouping_key` is NOT a total order (a USAGE line whose
  // free-text `udr_type` is literally 'RECURRING' collides with a real RECURRING
  // line's `offering:RECURRING` key). Ordering the hash by `grouping_key` alone
  // would leave that tied pair in a `string_agg` order Postgres does not specify,
  // so the stamp-time value and a later recompute over identical content could
  // differ (a false tamper alarm). `line_no` is the deterministic total order the
  // spec intended, and being an integer it also sidesteps text-collation drift.
  //
  // Each line's fields are serialized with `json_build_array(...)::text` — an
  // UNAMBIGUOUS (injective) encoding — rather than raw `|`/`,` delimiters: a
  // free-text `udr_type` (no CHECK) may itself contain a `|` or `,`, and a
  // delimiter-based concat would then let two DIFFERENT line sets serialize to
  // the same string and collide on md5 (a tampered set escaping detection). JSON
  // keeps every field a quoted, escaped string, so distinct content always
  // yields distinct text. Computed ENTIRELY in SQL (`numeric`→`text`, no JS
  // float — code-standards §2.4, or the tamper-evidence breaks); the
  // `COALESCE(string_agg(...), '')` makes an empty bill hash `md5('')` rather
  // than NULL-poisoning. Because the anchor is the lines (which recurring
  // derivation writes) rather than `udr_rated` (which recurring never touches),
  // a recurring-only bill now has a real, content-derived checksum. Reads the
  // bill's lines unscoped by `line_type`/`source` — the whole charge record is
  // the anchor — and relies on the caller holding `customer_bill`'s `FOR UPDATE`
  // (bm28's whole-account replace cascades through the header) so the line set
  // can't tear mid-read.
  async computeChargeChecksum(
    tx: Database,
    customerBillId: string,
    periodPartition: string,
  ): Promise<string> {
    const [row] = await tx
      .select({
        checksum: sql<string>`md5(COALESCE(string_agg(
        json_build_array(
          ${customerBillLine.source}, ${customerBillLine.refProductOfferingId},
          COALESCE(${customerBillLine.udrType}, ''), ${customerBillLine.lineType},
          ${customerBillLine.grossAmount}::text, ${customerBillLine.discountAmount}::text,
          ${customerBillLine.netAmount}::text
        )::text,
        ',' ORDER BY ${customerBillLine.lineNo}), ''))`,
      })
      .from(customerBillLine)
      .where(
        and(
          eq(customerBillLine.refCustomerBillId, customerBillId),
          eq(customerBillLine.periodPartition, periodPartition),
        ),
      );
    if (!row) {
      throw new Error(
        `computeChargeChecksum: no result for bill ${customerBillId}`,
      );
    }
    return row.checksum;
  },
};
