import { db } from "@/db/client";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { customerBillLineRepository } from "@/db/repositories/billing/customer-bill-line.repository";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import type {
  BillCategory,
  BillLineRow,
  CustomerBillRow,
  CustomerBillTaxItemRow,
} from "@/types/billing";

// bm05-spec §Implementation §5, extended by bm06 §Implementation §4 and bm28
// §Implementation §4. The Customers & Bills tab's read — one row per trial
// `customer_bill`, joined to the account name/currency, each with its tax lines
// AND its `customer_bill_line` charge lines (bm28 — the invoice's face, Inv #3;
// replaces bm05's synthetic stub line). Derived live, no cache read
// (architecture Inv. #12 idiom).
//
// The bill totals, tax items, and charge lines are read inside ONE
// `repeatable read` transaction so all three see a single, consistent database
// snapshot: the flow's aggregation commits a bill's `subtotal` and its
// `customer_bill_line` rows atomically (and taxation its `tax_total` + tax
// items), and reading them on separate pooled connections could otherwise
// straddle that commit (a `subtotal` next to lines that don't yet sum to it).
// One snapshot removes the skew.
export async function listAccountBills(
  billRunId: string,
): Promise<CustomerBillRow[]> {
  const { rows, taxItems, lines } = await db.transaction(
    async (tx) => {
      const [rows, taxItems, lines] = await Promise.all([
        customerBillRepository.listForRun(tx, billRunId),
        customerBillTaxItemRepository.listForRun(tx, billRunId),
        customerBillLineRepository.listForRun(tx, billRunId),
      ]);
      return { rows, taxItems, lines };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );

  // Group the flat charge-line rows by their bill (already ordered by `lineNo`
  // from the repository, so each bill's lines stay in deterministic order).
  const linesByBill = new Map<string, BillLineRow[]>();
  for (const { refCustomerBillId, ...line } of lines) {
    const list = linesByBill.get(refCustomerBillId) ?? [];
    list.push(line);
    linesByBill.set(refCustomerBillId, list);
  }

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
    lines: linesByBill.get(row.customerBillId) ?? [],
    invoiceId: row.refInvDocumentId,
    hasStoredInvoice: row.hasStoredInvoice,
  }));
}
