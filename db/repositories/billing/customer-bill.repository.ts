import { and, count, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { billRunInvoices } from "@/db/schema/billing/bill-run-invoices";
import { customerBill } from "@/db/schema/billing/customer-bill";

// bm05-spec §Design/§Implementation §4-5, trimmed bm16-spec §Design "Fork B".
// `listForRun` backs the Customers & Bills tab read. The trial-bill write
// (`deleteTrial`/`insertTrial`) and the taxation reads/writes
// (`findUnpostedBill`/`recomputeTotals`/`findUnpostedTotalForVerification`)
// were retired with `aggregate-bill.ts`/`taxation.ts`/`verify.ts` — phase 2
// moves that write into the bill run processor, as `billrun_runtime` (a
// second app-side writer would violate the two-writer boundary, architecture
// Inv. #2).
export const customerBillRepository = {
  // bm12-spec §Design/§Implementation §6 — a cancelled-then-re-triggered run
  // re-snapshots `bill_run_account` fresh, so the killed attempt's UNPOSTED
  // trial bills must be cleared in the same transaction; otherwise a bill for an
  // account re-scoped EXCLUDED (or failed) on the new attempt — which never
  // re-aggregates, so `deleteTrial` never runs for it — lingers on the money-
  // facing Customers & Bills tab. Keyed by the finalization latch
  // (`ref_inv_document_id IS NULL`): a posted bill is never touched (architecture
  // Inv. #4) — a cancellable run (PROCESSING only) can never have one anyway.
  async deleteUnpostedForRun(tx: Database, billRunId: string): Promise<void> {
    await tx
      .delete(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          isNull(customerBill.refInvDocumentId),
        ),
      );
  },

  // bm17-spec §Design/§Implementation §2 — reject's per-account unposted-
  // trial delete (tax items cascade via `ON DELETE CASCADE`, bm06). Scoped to
  // exactly the rejected accounts, never the whole run (unlike
  // `deleteUnpostedForRun`'s cancel-time sweep) — the finalization latch
  // (`ref_inv_document_id IS NULL`) still protects any posted row.
  async deleteUnpostedForAccounts(
    tx: Database,
    billRunId: string,
    billingAccountIds: string[],
  ): Promise<void> {
    if (billingAccountIds.length === 0) return;
    await tx
      .delete(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          inArray(customerBill.refBillingAccountId, billingAccountIds),
          isNull(customerBill.refInvDocumentId),
        ),
      );
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

  // bm10 — currencies among the run's postable bills that actually carry tax
  // (`tax_total > 0`). The pre-approval "GL mappings resolvable" check requires
  // `sys.tax_payable.{ccy}` ONLY for these, since posting only builds a tax leg
  // when `tax_total > 0` — a tax-free (zero-rated) currency needs no tax
  // mapping and must not block approval on one.
  async listPostableTaxCurrencies(
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
          sql`${customerBill.taxTotal} > 0`,
        ),
      );
    return rows.map((r) => r.currency);
  },

  // The "no zero/negative amounts" backstop's count — postable bills with a
  // non-positive `subtotal` OR `total_amount`, computed in SQL `numeric`
  // (code-standards §2.3). `subtotal` is checked too because posting always
  // inserts a revenue `charge` line at `amount = subtotal`, and
  // `document_line_amount_check` (`amount > 0`) would reject a `subtotal <= 0`
  // line at post time — permanently parking the account. Catching it here
  // blocks approval instead.
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
          sql`(${customerBill.subtotal} <= 0 OR ${customerBill.totalAmount} <= 0)`,
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

  // bm11-spec §Design/§Implementation §1 — the posting transaction's single
  // input read: one joined row carrying everything `postAccount` needs — the
  // trial bill (the source of the INV's two lines + the `refInvDocumentId`
  // resume latch), the account's current `attempt_count`, and the billing
  // account's GL fields (`ref_financial_account_id`/`currency`). `FOR UPDATE OF
  // customer_bill` locks ONLY the bill row (not the shared billing_account /
  // bill_run_account rows), so two concurrent resume/post attempts on the same
  // account serialize on the bill: the second blocks here, then reads the
  // now-set `ref_inv_document_id` and skips — at most one INV is ever created
  // (belt-and-suspenders with `stampPosted`'s NULL guard). Replaces the former
  // three sequential per-account reads (`findByRunAndAccount` + `findAttempt` +
  // `billingAccountRepository.findById`) with one round-trip.
  async lockBillForPosting(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
    periodPartition: string,
  ): Promise<{
    customerBillId: string;
    periodPartition: string;
    subtotal: string;
    taxTotal: string;
    totalAmount: string;
    refInvDocumentId: string | null;
    attemptCount: number;
    refFinancialAccountId: string;
    currency: string;
  } | null> {
    // Postgres requires `FOR UPDATE OF <unqualified name>`, but drizzle
    // schema-qualifies base tables (`"billing"."customer_bill"`), which
    // Postgres rejects. Aliasing the locked table emits the bare alias in the
    // `OF` clause (`FOR UPDATE OF "cb"`), so only the bill row is locked — never
    // the shared `billing_account` / `bill_run_account` rows the join reads.
    // `period_partition` (fixed per run — the 1st of the run's period month) is
    // filtered on both partitioned tables so Postgres can prune to the one
    // partition instead of scanning every month.
    const cb = alias(customerBill, "cb");
    const [row] = await tx
      .select({
        customerBillId: cb.customerBillId,
        periodPartition: cb.periodPartition,
        subtotal: cb.subtotal,
        taxTotal: cb.taxTotal,
        totalAmount: cb.totalAmount,
        refInvDocumentId: cb.refInvDocumentId,
        attemptCount: billRunAccount.attemptCount,
        refFinancialAccountId: billingAccount.refFinancialAccountId,
        currency: billingAccount.currency,
      })
      .from(cb)
      .innerJoin(
        billRunAccount,
        and(
          eq(billRunAccount.refBillRunId, cb.refBillRunId),
          eq(billRunAccount.refBillingAccountId, cb.refBillingAccountId),
          eq(billRunAccount.periodPartition, cb.periodPartition),
        ),
      )
      .innerJoin(
        billingAccount,
        eq(billingAccount.billingAccountId, cb.refBillingAccountId),
      )
      .where(
        and(
          eq(cb.refBillRunId, billRunId),
          eq(cb.refBillingAccountId, billingAccountId),
          eq(cb.periodPartition, periodPartition),
        ),
      )
      .for("update", { of: cb })
      .limit(1);
    return row ?? null;
  },

  // bm19-spec §Design "Posting reads real udr_rated (Inv #3)" — the
  // charge-checksum computation now lives in
  // `db/repositories/billing/rated-lines.repository.ts`
  // (`computeChargeChecksum` there), which reads the account's claimed
  // rated-usage rows directly. It could not stay in THIS file: this
  // repository already writes other tables below it, and the
  // billing-rating-write-boundary guardrail treats any file that both
  // touches the rating schema and writes anywhere as suspect, independent
  // of which table the write targets. The other file stays read-only, so
  // it is the sanctioned home for this read (same shape as its existing
  // claimed-lines lookup).

  // bm11-spec §Design/§Implementation §1 step 5 — the posting stamp: sets the
  // finalization latch (`ref_inv_document_id`, architecture Inv. #4) plus
  // `posted_attempt`/`charge_checksum`/`category='normal'`, all in the same
  // per-account transaction as the INV create + post (step 4's "no double-
  // post" — everything commits or rolls back together). The `IS NULL` guard
  // is self-protecting (same convention as `replaceForBill`): a posted bill
  // is never re-stamped even if a future caller passes one in. Returns whether
  // a row was actually stamped — `false` means the bill was concurrently posted
  // between this transaction's resume check and here, and the caller MUST throw
  // so the duplicate INV create + account `INVOICED` flip roll back together.
  //
  // bm19-spec §Phase-2 review folds T5 [P1] — this `IS NULL` guard (and
  // `lockBillForPosting`'s row lock above it) is demoted to a friendly,
  // resumable early-return rather than the SOLE backstop: `document`'s new
  // partial UNIQUE index (`document_ref_customer_bill_id_unique`,
  // 0037_document_customer_bill_latch.sql) structurally refuses a second
  // posted INV for the same bill regardless of what this guard does.
  async stampPosted(
    tx: Database,
    customerBillId: string,
    periodPartition: string,
    data: {
      refInvDocumentId: string;
      postedAttempt: number;
      chargeChecksum: string;
    },
  ): Promise<boolean> {
    const stamped = await tx
      .update(customerBill)
      .set({
        refInvDocumentId: data.refInvDocumentId,
        postedAttempt: data.postedAttempt,
        chargeChecksum: data.chargeChecksum,
        category: "normal",
      })
      .where(
        and(
          eq(customerBill.customerBillId, customerBillId),
          eq(customerBill.periodPartition, periodPartition),
          isNull(customerBill.refInvDocumentId),
        ),
      )
      .returning({ customerBillId: customerBill.customerBillId });
    return stamped.length > 0;
  },

  // bm18-spec §Implementation §2 step 1 — the draft-invoice renderer's single-
  // account read: the same account-name/currency join as `listForRun`, scoped
  // to one `(run, ban)` pair. `null` means no bill exists yet for this
  // account (the render service maps this to a typed not-found → 404 at the
  // route, never a 500). bm19-spec §Implementation §3/§4 reuses this same
  // read for the final renderer AND the retry-render path — both need
  // `refInvDocumentId` (the real invoice number / the render-pending check),
  // so it's included unconditionally rather than forking a second read.
  async findForAccount(
    db: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<{
    customerBillId: string;
    periodPartition: string;
    billingAccountId: string;
    accountName: string;
    currency: string;
    category: string;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    subtotal: string;
    taxTotal: string;
    totalAmount: string;
    paymentDueDate: string;
    refInvDocumentId: string | null;
  } | null> {
    const [row] = await db
      .select({
        customerBillId: customerBill.customerBillId,
        periodPartition: customerBill.periodPartition,
        billingAccountId: customerBill.refBillingAccountId,
        accountName: billingAccount.name,
        currency: billingAccount.currency,
        category: customerBill.category,
        billingPeriodStart: customerBill.billingPeriodStart,
        billingPeriodEnd: customerBill.billingPeriodEnd,
        subtotal: customerBill.subtotal,
        taxTotal: customerBill.taxTotal,
        totalAmount: customerBill.totalAmount,
        paymentDueDate: customerBill.paymentDueDate,
        refInvDocumentId: customerBill.refInvDocumentId,
      })
      .from(customerBill)
      .innerJoin(
        billingAccount,
        eq(customerBill.refBillingAccountId, billingAccount.billingAccountId),
      )
      .where(
        and(
          eq(customerBill.refBillRunId, billRunId),
          eq(customerBill.refBillingAccountId, billingAccountId),
        ),
      )
      .limit(1);
    return row ?? null;
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
      refInvDocumentId: string | null;
      hasStoredInvoice: boolean;
    }[]
  > {
    // bm19-spec §Implementation §5 — a left-join to `bill_run_invoices` (same
    // shape as `bill-run-account.repository.ts`'s `listPostingProgressForRun`)
    // so the tab can distinguish a posted bill whose final artifact is STORED
    // from one still render-pending (D10's tolerated render failure — INV set,
    // no `bill_run_invoices` row). Re-derived from the row's absence, never a
    // stored column.
    const rows = await db
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
        refInvDocumentId: customerBill.refInvDocumentId,
        billRunInvoiceId: billRunInvoices.billRunInvoiceId,
      })
      .from(customerBill)
      .innerJoin(
        billingAccount,
        eq(customerBill.refBillingAccountId, billingAccount.billingAccountId),
      )
      .leftJoin(
        billRunInvoices,
        and(
          eq(billRunInvoices.refBillRunId, customerBill.refBillRunId),
          eq(
            billRunInvoices.refBillingAccountId,
            customerBill.refBillingAccountId,
          ),
        ),
      )
      .where(eq(customerBill.refBillRunId, billRunId))
      .orderBy(billingAccount.name);
    return rows.map(({ billRunInvoiceId, ...r }) => ({
      ...r,
      hasStoredInvoice: billRunInvoiceId !== null,
    }));
  },
};
