import { db } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import type {
  BillCategory,
  CustomerBillRow,
  CustomerBillTaxItemRow,
} from "@/types/billing";

// bm05-spec §Implementation §5, extended by bm06 §Implementation §4. The
// Customers & Bills tab's read — one row per trial `customer_bill`, joined to
// the account name/currency, each with its tax lines. Derived live, no cache
// read (architecture Inv. #12 idiom).
//
// The bill totals and the tax items are read inside ONE `repeatable read`
// transaction so both see a single, consistent database snapshot: taxation
// commits a bill's `tax_total` and its tax-item rows atomically, and reading
// them on two separate pooled connections could otherwise straddle that commit
// (a summary `tax_total` of 0.00 next to a just-inserted tax line). One
// snapshot removes the skew.
export async function listAccountBills(
  billRunId: string,
): Promise<CustomerBillRow[]> {
  const { rows, taxItems } = await db.transaction(
    async (tx) => {
      const [rows, taxItems] = await Promise.all([
        customerBillRepository.listForRun(tx, billRunId),
        customerBillTaxItemRepository.listForRun(tx, billRunId),
      ]);
      return { rows, taxItems };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  // Group the flat tax-item rows by their bill so each `CustomerBillRow` gets
  // its own lines. A bill with no tax item yet (taxation hasn't run) maps to an
  // empty array — its `taxTotal` is still "0.00" from aggregation.
  const itemsByBill = new Map<string, CustomerBillTaxItemRow[]>();
  for (const item of taxItems) {
    const list = itemsByBill.get(item.customerBillId) ?? [];
    list.push({
      category: item.category,
      rate: item.rate,
      amount: item.amount,
    });
    itemsByBill.set(item.customerBillId, list);
  }

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
    taxItems: itemsByBill.get(row.customerBillId) ?? [],
  }));
}
