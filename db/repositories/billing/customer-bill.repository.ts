import { and, eq, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { customerBill } from "@/db/schema/billing/customer-bill";
import type { CustomerBillInsert } from "@/db/schema/billing/customer-bill";

// bm05-spec §Design/§Implementation §4-5. `deleteTrial` + `insertTrial` are
// the Aggregation service's rerun-safe write: a conditional
// `DELETE ... WHERE ref_inv_document_id IS NULL` (the finalization latch,
// architecture Inv. #4) followed by the INSERT — both issued inside the
// caller's stage-signal transaction. `listForRun` backs the Customers &
// Bills tab read.
export const customerBillRepository = {
  async deleteTrial(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<void> {
    await tx
      .delete(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(customerBill.refBillingAccountId, billingAccountId),
          isNull(customerBill.refInvDocumentId),
        ),
      );
  },

  async insertTrial(tx: Database, row: CustomerBillInsert): Promise<void> {
    await tx.insert(customerBill).values(row);
  },

  // bm05-spec §Visual — one row per trial bill, joined to the account name +
  // currency for money formatting (neither lives on `customer_bill`). No
  // `EXCLUDED`-account filter needed: those accounts never reach Aggregation
  // (bm04's `advanceAccountStatus` keeps them terminal), so no row for them
  // is ever written here.
  async listForRun(
    db: Database,
    billRunId: string,
  ): Promise<
    {
      customerBillId: string;
      billingAccountId: string;
      accountName: string;
      currency: string;
      category: string;
      subtotal: string;
      taxTotal: string;
      totalAmount: string;
      paymentDueDate: string;
    }[]
  > {
    return db
      .select({
        customerBillId: customerBill.customerBillId,
        billingAccountId: customerBill.refBillingAccountId,
        accountName: billingAccount.name,
        currency: billingAccount.currency,
        category: customerBill.category,
        subtotal: customerBill.subtotal,
        taxTotal: customerBill.taxTotal,
        totalAmount: customerBill.totalAmount,
        paymentDueDate: customerBill.paymentDueDate,
      })
      .from(customerBill)
      .innerJoin(
        billingAccount,
        eq(customerBill.refBillingAccountId, billingAccount.billingAccountId),
      )
      .where(eq(customerBill.refBillRunId, billRunId))
      .orderBy(billingAccount.name);
  },
};
