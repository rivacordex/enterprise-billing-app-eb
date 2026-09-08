import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billRunInvoices } from "@/db/schema/billing/bill-run-invoices";
import type { BillRunInvoiceInsert } from "@/db/schema/billing/bill-run-invoices";

// bm19-spec §Implementation §1 — insert + read-by-(run, ban) for the stored,
// immutable final invoice artifact. Written in a SEPARATE step AFTER the
// posting transaction commits (D10, `services/billing/post-run.ts`); the
// table's own trigger (`bill_run_invoices_immutability_guard`,
// 0036_bill_run_invoices.sql) rejects any UPDATE/DELETE of an existing row —
// there is no update path here to accidentally expose.
export const billRunInvoicesRepository = {
  async insert(
    db: Database,
    data: BillRunInvoiceInsert,
  ): Promise<{ billRunInvoiceId: string }> {
    const [row] = await db
      .insert(billRunInvoices)
      .values(data)
      .returning({ billRunInvoiceId: billRunInvoices.billRunInvoiceId });
    if (!row) {
      throw new Error("bill-run-invoices.repository.insert: no row returned");
    }
    return row;
  },

  // Scoped to `(run, ban)` — the run's own period_partition composite unique
  // (`bill_run_invoices_run_ban_period_unique`) guarantees at most one row.
  // `null` means the account has a posted INV but no stored artifact yet
  // (the render-pending state D10 tolerates) — never a table scan for the
  // caller to distinguish "not posted" from "posted, render pending".
  async findByRunAndAccount(
    db: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<{
    billRunInvoiceId: string;
    refInvDocumentId: string;
    blobRef: string;
    checksum: string;
    renderedAt: Date;
  } | null> {
    const [row] = await db
      .select({
        billRunInvoiceId: billRunInvoices.billRunInvoiceId,
        refInvDocumentId: billRunInvoices.refInvDocumentId,
        blobRef: billRunInvoices.blobRef,
        checksum: billRunInvoices.checksum,
        renderedAt: billRunInvoices.renderedAt,
      })
      .from(billRunInvoices)
      .where(
        and(
          eq(billRunInvoices.refBillRunId, billRunId),
          eq(billRunInvoices.refBillingAccountId, billingAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
  },
};
