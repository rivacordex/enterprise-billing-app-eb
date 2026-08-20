import { db } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { BillCategory, CustomerBillRow } from "@/types/billing";

// bm05-spec §Implementation §5. The Customers & Bills tab's read — one row
// per trial `customer_bill`, joined to the account name/currency. Derived
// live, no cache read (architecture Inv. #12 idiom).
export async function listAccountBills(
  billRunId: string,
): Promise<CustomerBillRow[]> {
  const rows = await customerBillRepository.listForRun(db, billRunId);

  return rows.map((row) => ({
    customerBillId: row.customerBillId,
    billingAccountId: row.billingAccountId,
    accountName: row.accountName,
    category: row.category as BillCategory,
    currency: row.currency,
    subtotal: row.subtotal,
    taxTotal: row.taxTotal,
    totalAmount: row.totalAmount,
    paymentDueDate: row.paymentDueDate,
  }));
}
