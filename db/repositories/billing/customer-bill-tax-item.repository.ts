import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillTaxItem } from "@/db/schema/billing/customer-bill-tax-item";

// bm06-spec §Design/§Implementation §3, trimmed bm16-spec §Design "Fork B".
// The Taxation stage's write (`replaceForBill`) was retired with
// `taxation.ts` — phase 2 moves that write into the bill run processor, as
// `billrun_runtime` (a second app-side writer would violate the two-writer
// boundary, architecture Inv. #2). `listForRun` backs the Customers & Bills
// tab read.
export const customerBillTaxItemRepository = {
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
