import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
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
    // Keyed exactly on the `(run, ban, period)` UNIQUE plus the finalization
    // latch: delete the single UNPOSTED row so the re-derived trial can be
    // inserted without colliding on the unique key. A posted row
    // (`ref_inv_document_id` set) is never touched (architecture Inv. #4). A
    // `category` predicate is deliberately NOT added — with at most one row per
    // key, filtering to `trial` would skip a non-trial unposted row and then
    // collide on `insertTrial`.
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

  // bm06-spec §Design/§Implementation §3 — Taxation resolves the run's single
  // UNPOSTED bill for an account (`ref_inv_document_id IS NULL`, the
  // finalization latch, architecture Inv. #4). A posted bill is never
  // returned, so the taxation service never re-taxes it. Returns the identity
  // needed to key the tax-item write + the totals recompute.
  async findUnpostedBill(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<{
    customerBillId: string;
    periodPartition: string;
    subtotal: string;
  } | null> {
    const [row] = await tx
      .select({
        customerBillId: customerBill.customerBillId,
        periodPartition: customerBill.periodPartition,
        subtotal: customerBill.subtotal,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(customerBill.refBillingAccountId, billingAccountId),
          isNull(customerBill.refInvDocumentId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // bm06-spec §Design/§Implementation §3 — after the bill's tax items are
  // (re)written, recompute `tax_total` = the SQL SUM of its items and
  // `total_amount` = `subtotal + tax_total`, ALL in SQL `numeric` (never JS
  // float, code-standards §2.3). The subquery over `customer_bill_tax_item`
  // and the `subtotal` addition happen inside Postgres, so the total equals the
  // summed items to the cent by construction. Keyed on the full PK
  // `(customer_bill_id, period_partition)`; the `ref_inv_document_id IS NULL`
  // guard is retained even though `findUnpostedBill` already filtered it — a
  // posted bill is never mutated (architecture Inv. #4).
  async recomputeTotals(
    tx: Database,
    customerBillId: string,
    periodPartition: string,
  ): Promise<void> {
    await tx.execute(sql`
      UPDATE billing.customer_bill AS cb
      SET tax_total = COALESCE(items.total, 0),
          total_amount = cb.subtotal + COALESCE(items.total, 0)
      FROM (
        SELECT COALESCE(SUM(tax_amount), 0) AS total
        FROM billing.customer_bill_tax_item
        WHERE ref_customer_bill_id = ${customerBillId}
          AND period_partition = ${periodPartition}
      ) AS items
      WHERE cb.customer_bill_id = ${customerBillId}
        AND cb.period_partition = ${periodPartition}
        AND cb.ref_inv_document_id IS NULL
    `);
  },

  // bm07-spec §Design/§Implementation §1 — Verification's backstop check reads
  // the account's UNPOSTED bill total (`ref_inv_document_id IS NULL`, the
  // finalization latch, architecture Inv. #4). `nonPositive` is computed in SQL
  // `numeric` (`total_amount <= 0`) so the check never touches JS float
  // (code-standards §2.3). No bill (aggregation hasn't run, or the account was
  // excluded) ⇒ `null`, and Verification records a clean DONE.
  async findUnpostedTotalForVerification(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<{ totalAmount: string; nonPositive: boolean } | null> {
    const [row] = await tx
      .select({
        totalAmount: customerBill.totalAmount,
        nonPositive: sql<boolean>`${customerBill.totalAmount} <= 0`,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(customerBill.refBillingAccountId, billingAccountId),
          isNull(customerBill.refInvDocumentId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // bm08-spec §Design/§Implementation §1 — the rerun finalization guard's read:
  // the account ids in this run whose bill is already POSTED
  // (`ref_inv_document_id` set, the finalization latch, architecture Inv. #4).
  // The rerun service drops these from the eligible set so it never invalidates,
  // re-derives, or re-attempts a finalized account (belt-and-suspenders with the
  // DB delete guard). In v1 nothing is posted yet, so this is always empty — the
  // guard is proven here and enforced for real in bm11.
  async listPostedAccountIds(
    tx: Database,
    billRunId: string,
  ): Promise<string[]> {
    const rows = await tx
      .select({ billingAccountId: customerBill.refBillingAccountId })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          isNotNull(customerBill.refInvDocumentId),
        ),
      );
    return rows.map((r) => r.billingAccountId);
  },

  // bm08 — the account ids in this run that already have an UNPOSTED trial bill
  // (`ref_inv_document_id IS NULL`). The rerun service re-derives a bill inline
  // ONLY for these accounts: re-deriving is a delta-display convenience for
  // accounts that previously reached Aggregation, so an account with no bill yet
  // (e.g. one that failed at Validation/Collection) is left for the re-triggered
  // engine to (re-)validate and create through the single validated
  // `handle-stage-signal` path — never billed inline for an unvalidated account,
  // and `taxBill` is never called with no bill to tax (which would throw).
  async listUnpostedBillAccountIds(
    tx: Database,
    billRunId: string,
  ): Promise<string[]> {
    const rows = await tx
      .select({ billingAccountId: customerBill.refBillingAccountId })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          isNull(customerBill.refInvDocumentId),
        ),
      );
    return rows.map((r) => r.billingAccountId);
  },

  // bm08-spec §Design/§Implementation §1 — the prior totals stamped into the
  // `BILL_RUN_RERUN` audit event's `beforeData` (the run's current billed total
  // across the rerun accounts, before re-derivation), summed in SQL `numeric`
  // (never JS float, code-standards §2.3) so the audit trail records what the
  // figures were before the rerun. No selected accounts ⇒ "0.00".
  async sumTotalsForAccounts(
    tx: Database,
    billRunId: string,
    billingAccountIds: string[],
  ): Promise<string> {
    if (billingAccountIds.length === 0) return "0.00";
    const [row] = await tx
      .select({
        total: sql<string>`COALESCE(SUM(${customerBill.totalAmount}), 0)::numeric(18,2)::text`,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          inArray(customerBill.refBillingAccountId, billingAccountIds),
        ),
      );
    return row?.total ?? "0.00";
  },

  // bm10-spec §Design/§Implementation §1 — the "postable" bill set: bills
  // belonging to a `PROCESSED` account (the only status left besides
  // `PROCESSING_FAILED`/`EXCLUDED`, which get marked `SKIPPED` at approval,
  // never posted). The three reads below all join on this same condition —
  // GL-mapping currencies, the zero/negative-total backstop, and the
  // immutable `total_amount` stamp all need exactly this set.

  // Distinct currencies among the run's postable bills — the pre-approval
  // "GL mappings resolvable" check resolves `sys.revenue.{ccy}`/
  // `sys.tax_payable.{ccy}` for each of these (single-currency per cycle in
  // v1, architecture §"Cross-schema boundary"; not assumed here).
  async listPostableCurrencies(
    db: Database,
    billRunId: string,
  ): Promise<string[]> {
    const rows = await db
      .selectDistinct({ currency: billingAccount.currency })
      .from(customerBill)
      .innerJoin(
        billingAccount,
        eq(customerBill.refBillingAccountId, billingAccount.billingAccountId),
      )
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccount.refBillRunId, customerBill.refBillRunId),
          eq(
            billRunAccount.refBillingAccountId,
            customerBill.refBillingAccountId,
          ),
        ),
      )
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(billRunAccount.status, "PROCESSED"),
        ),
      );
    return rows.map((r) => r.currency);
  },

  // The "no zero/negative totals" backstop's count — postable bills with
  // `total_amount <= 0`, computed in SQL `numeric` (code-standards §2.3).
  async countNonPositivePostable(
    db: Database,
    billRunId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ cnt: count() })
      .from(customerBill)
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccount.refBillRunId, customerBill.refBillRunId),
          eq(
            billRunAccount.refBillingAccountId,
            customerBill.refBillingAccountId,
          ),
        ),
      )
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(billRunAccount.status, "PROCESSED"),
          sql`${customerBill.totalAmount} <= 0`,
        ),
      );
    return row?.cnt ?? 0;
  },

  // The immutable `bill_run.total_amount` stamp — the SQL SUM of the
  // postable bills (never a JS reduce, code-standards §2.3). Shared by the
  // Approve preview and the approve write itself, so the confirm-panel figure
  // and the stamped total can never drift.
  async sumPostableTotalForRun(
    db: Database,
    billRunId: string,
  ): Promise<string> {
    const [row] = await db
      .select({
        total: sql<string>`COALESCE(SUM(${customerBill.totalAmount}), 0)::numeric(18,2)::text`,
      })
      .from(customerBill)
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccount.refBillRunId, customerBill.refBillRunId),
          eq(
            billRunAccount.refBillingAccountId,
            customerBill.refBillingAccountId,
          ),
        ),
      )
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(billRunAccount.status, "PROCESSED"),
        ),
      );
    return row?.total ?? "0.00";
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
