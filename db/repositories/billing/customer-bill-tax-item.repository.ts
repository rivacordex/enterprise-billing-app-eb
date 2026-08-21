import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillTaxItem } from "@/db/schema/billing/customer-bill-tax-item";

// bm06-spec §Design/§Implementation §3. The Taxation stage's tax-item writes.
// `replaceForBill` is rerun-safe (DELETE the bill's items + re-INSERT), and the
// `tax_amount` is computed ENTIRELY in SQL `numeric` — `round(subtotal * rate /
// 100, 2)` read straight off the bill row, never a JS float (code-standards
// §2.3). `listForRun` backs the Customers & Bills tab read.
export const customerBillTaxItemRepository = {
  // Rerun-safe replacement of one bill's tax items: DELETE then INSERT. The
  // INSERT is an `INSERT ... SELECT` off the bill so the subtotal → tax math
  // stays inside Postgres (numeric, half-up `round`). `tax_rate` is stored on
  // the row for provenance/reprint; `tax_category` is the configured GST label.
  // BOTH the DELETE and the INSERT are guarded on `ref_inv_document_id IS NULL`
  // (via `EXISTS` on the parent bill) — a posted bill is never taxed again NOR
  // has its finalized tax items wiped (architecture Inv. #4). Keeping the guard
  // on the DELETE too (not just the INSERT) makes the write self-protecting, so
  // it enforces the latch even if a future caller passes a posted bill's id.
  // v1 writes a single category; the table shape supports more.
  async replaceForBill(
    tx: Database,
    input: {
      customerBillId: string;
      periodPartition: string;
      category: string;
      rate: number;
    },
  ): Promise<void> {
    await tx.execute(sql`
      DELETE FROM billing.customer_bill_tax_item
      WHERE ref_customer_bill_id = ${input.customerBillId}
        AND period_partition = ${input.periodPartition}
        AND EXISTS (
          SELECT 1
          FROM billing.customer_bill AS cb
          WHERE cb.customer_bill_id = ${input.customerBillId}
            AND cb.period_partition = ${input.periodPartition}
            AND cb.ref_inv_document_id IS NULL
        )
    `);
    await tx.execute(sql`
      INSERT INTO billing.customer_bill_tax_item
        (ref_customer_bill_id, period_partition, tax_category, tax_rate, tax_amount)
      SELECT
        cb.customer_bill_id,
        cb.period_partition,
        ${input.category},
        ${input.rate}::numeric(5, 2),
        -- Compute the amount from the SAME numeric(5,2) rate that is persisted
        -- in tax_rate above, so the stored rate and the amount it produced can
        -- never disagree (the config already rejects >2dp rates, so this is
        -- defensive — a future caller passing a higher-precision rate stays
        -- consistent). round(...,2) keeps the half-up two-decimal amount.
        round(cb.subtotal * ${input.rate}::numeric(5, 2) / 100, 2)
      FROM billing.customer_bill AS cb
      WHERE cb.customer_bill_id = ${input.customerBillId}
        AND cb.period_partition = ${input.periodPartition}
        AND cb.ref_inv_document_id IS NULL
    `);
  },

  // bm06-spec §Design/§Implementation §4 — the tax lines for every bill in a
  // run, joined to `customer_bill` so the read can key them back to their
  // bill. The join matches the FULL composite key `(customer_bill_id,
  // period_partition)` — not just the id — so Postgres can prune both
  // partitioned tables to the run's period instead of scanning every monthly
  // partition, matching the composite-key discipline used across the module.
  // Ordered by bill then category for a stable render.
  async listForRun(
    db: Database,
    billRunId: string,
  ): Promise<
    {
      customerBillId: string;
      category: string;
      rate: string;
      amount: string;
    }[]
  > {
    return db
      .select({
        customerBillId: customerBillTaxItem.refCustomerBillId,
        category: customerBillTaxItem.taxCategory,
        rate: customerBillTaxItem.taxRate,
        amount: customerBillTaxItem.taxAmount,
      })
      .from(customerBillTaxItem)
      .innerJoin(
        customerBill,
        and(
          eq(
            customerBillTaxItem.refCustomerBillId,
            customerBill.customerBillId,
          ),
          eq(customerBillTaxItem.periodPartition, customerBill.periodPartition),
        ),
      )
      .where(eq(customerBill.refBillRunId, billRunId))
      .orderBy(
        customerBillTaxItem.refCustomerBillId,
        customerBillTaxItem.taxCategory,
      );
  },
};
