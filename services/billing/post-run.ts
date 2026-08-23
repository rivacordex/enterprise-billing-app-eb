import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { postDocument } from "@/services/accounts/post-document";
import type { PostDocumentResult } from "@/services/accounts/post-document";
import * as money from "@/services/accounts/money";
import type { BillRun } from "@/db/schema/billing/bill-run";

// bm11-spec §Design/§Implementation. Approval drives posting: on `APPROVED`,
// one INV per non-skipped account, each in its **own** transaction (Inv.
// #6 — there is no whole-run posting transaction), resumable (an account
// already carrying `ref_inv_document_id` is skipped on retry), and
// `PERIOD_CLOSED` — like any other posting failure — is a tolerated,
// first-class per-account error: the account is parked and the run stays
// `POSTING`. Once every non-skipped account is `INVOICED`, the run completes
// straight through to `COMPLETED` (v1 has no distribution targets).

export type PostAccountResult =
  | { status: "skipped" }
  | { status: "invoiced"; invoiceId: string }
  | { status: "parked"; code: string; detail: string };

export type PostRunResult =
  | {
      ok: true;
      value: {
        billRunId: string;
        results: { billingAccountId: string; result: PostAccountResult }[];
        completed: boolean;
      };
    }
  | { ok: false; code: "NOT_POSTABLE" };

// Internal-only signal — thrown from inside the per-account transaction so a
// `postDocument` failure rolls the INV create + attempted post back together
// (Design step 4's "no double-post"; the invoice number itself is
// non-transactional and may leave a tolerated gap, Inv. #7). Caught just
// outside to park the account via a SEPARATE write, keeping the run
// resumable (Design "PERIOD_CLOSED handling").
class PostAccountFailureSignal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function describePostFailure(
  result: Extract<PostDocumentResult, { ok: false }>,
): string {
  switch (result.code) {
    case "PERIOD_CLOSED":
      return result.openPeriodHint;
    case "ACCOUNT_CLOSED":
      return "The financial or billing account is closed.";
    case "UNBALANCED_DOC":
      return "The invoice's lines do not balance to its total.";
    case "DOC_STATE_INVALID":
      return "The invoice is not in a postable state.";
    case "APPROVAL_REQUIRED":
      return "The invoice exceeds the auto-post limit and requires approval.";
    case "SELF_APPROVAL":
      return "The invoice cannot be approved by its own creator.";
    case "CONFLICT":
      return "A concurrent update conflicted with posting.";
    case "DOCUMENT_NOT_FOUND":
      return "The invoice document could not be found.";
    default:
      return "Posting failed.";
  }
}

// bm11-spec §Design step 20. The per-account posting transaction:
//   1. Skip if the bill already carries `ref_inv_document_id` (resume).
//   2. Read the trial bill + the account's current `attempt_count`.
//   3. Build the INV — a revenue `charge` line (subtotal) and, when tax
//      applies, a tax `release` line (bm09's INV leg template) — from the
//      Accounts document engine's own sequence (`document_inv_seq`).
//   4. Post it — `postDocument` auto-posts under `STANDARD_INVOICE`'s
//      unlimited limit; a failure throws so the whole transaction (INV +
//      any posted legs) rolls back.
//   5. Stamp the bill (`ref_inv_document_id`/`posted_attempt`/
//      `charge_checksum`/`category='normal'`) and mark the account
//      `INVOICED` — all inside the same transaction as steps 3-4.
export async function postAccount(
  run: BillRun,
  billingAccountId: string,
  actorId: string,
): Promise<PostAccountResult> {
  if (!run.approvedBy) {
    throw new Error(
      `postAccount: bill_run ${run.billRunId} has no approvedBy stamp`,
    );
  }
  const approvedBy = run.approvedBy;
  const eventAt = new Date(run.glEventAt ?? run.scheduledRunDate);
  const entryDate = new Date(run.scheduledRunDate);

  try {
    return await db.transaction(async (tx) => {
      const bill = await customerBillRepository.findByRunAndAccount(
        tx,
        run.billRunId,
        billingAccountId,
      );
      if (!bill) {
        throw new Error(
          `postAccount: no customer_bill for run ${run.billRunId} / account ${billingAccountId}`,
        );
      }
      if (bill.refInvDocumentId) {
        return { status: "skipped" } as const;
      }

      const attempt = await billRunAccountRepository.findAttempt(
        tx,
        run.billRunId,
        billingAccountId,
      );
      if (attempt === null) {
        throw new Error(
          `postAccount: no bill_run_account for run ${run.billRunId} / account ${billingAccountId}`,
        );
      }

      const ban = await billingAccountRepository.findById(tx, billingAccountId);
      if (!ban) {
        throw new Error(
          `postAccount: billing_account ${billingAccountId} not found`,
        );
      }

      const doc = await documentRepository.insert(tx, "INV", {
        state: "draft",
        refFinancialAccountId: ban.refFinancialAccountId,
        refBillingAccountId: ban.billingAccountId,
        reasonCode: "STANDARD_INVOICE",
        currency: ban.currency,
        totalAmount: bill.totalAmount,
        paymentMode: null,
        modeRef: null,
        entryDate,
        referenceInfo: `Bill run ${run.billRunId}`,
        eventAt,
        postedAt: null,
        reversalOf: null,
        createdBy: approvedBy,
        approvedBy: null,
        metadata: null,
        lastEditedBy: actorId,
      });

      await documentLineRepository.insert(tx, {
        refDocumentId: doc.documentId,
        lineNo: 1,
        lineKind: "charge",
        refBillingAccountId: ban.billingAccountId,
        refSettledDocumentId: null,
        amount: bill.subtotal,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });

      const hasTax = money.compare(bill.taxTotal, "0.00") > 0;
      if (hasTax) {
        await documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: 2,
          lineKind: "release",
          refBillingAccountId: ban.billingAccountId,
          refSettledDocumentId: null,
          amount: bill.taxTotal,
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: actorId,
        });
      }

      const posted = await postDocument(tx, doc.documentId, actorId);
      if (!posted.ok) {
        throw new PostAccountFailureSignal(
          posted.code,
          describePostFailure(posted),
        );
      }

      const chargeChecksum = await customerBillRepository.computeChargeChecksum(
        tx,
        bill.customerBillId,
        bill.periodPartition,
      );
      await customerBillRepository.stampPosted(
        tx,
        bill.customerBillId,
        bill.periodPartition,
        {
          refInvDocumentId: doc.documentId,
          postedAttempt: attempt,
          chargeChecksum,
        },
      );
      await billRunAccountRepository.updateStatus(
        tx,
        run.billRunId,
        billingAccountId,
        { status: "INVOICED", errorCode: null, errorDetail: null },
      );

      return { status: "invoiced", invoiceId: doc.documentId } as const;
    });
  } catch (err) {
    // The transaction above already rolled back — no orphan INV/ledger write.
    // Park the account with a fresh, separate write so the failure is visible
    // and `postRun` can move on to the next account (Design "park + continue").
    const code =
      err instanceof PostAccountFailureSignal ? err.code : "POSTING_FAILED";
    const detail =
      err instanceof Error ? err.message : "Unknown posting failure";
    await billRunAccountRepository.updateStatus(
      db,
      run.billRunId,
      billingAccountId,
      { status: "PROCESSED", errorCode: code, errorDetail: detail },
    );
    return { status: "parked", code, detail } as const;
  }
}

// bm11-spec §Implementation §1. `postRun`: flip `APPROVED → POSTING` once
// (idempotent — re-invoking on an already-`POSTING` run just resumes), post
// every `PROCESSED` (not-yet-`INVOICED`) account, then — once none remain
// `PROCESSED` — complete the run and write the `BILL_RUN_POSTED` audit
// marking the `INVOICED` milestone.
export async function postRun(
  billRunId: string,
  actorId: string,
): Promise<PostRunResult> {
  const run = await db.transaction(async (tx) => {
    const found = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!found) return null;
    if (found.status === "APPROVED") {
      await billRunRepository.markPosting(tx, billRunId);
      return { ...found, status: "POSTING" };
    }
    if (found.status === "POSTING") return found;
    return null;
  });
  if (!run) return { ok: false, code: "NOT_POSTABLE" };

  const accounts = await billRunAccountRepository.listStatusesForRun(
    db,
    billRunId,
  );
  const toPost = accounts.filter((a) => a.status === "PROCESSED");

  const results: { billingAccountId: string; result: PostAccountResult }[] = [];
  for (const account of toPost) {
    const result = await postAccount(run, account.billingAccountId, actorId);
    results.push({ billingAccountId: account.billingAccountId, result });
  }

  const finalStatuses = await billRunAccountRepository.listStatusesForRun(
    db,
    billRunId,
  );
  const completed = !finalStatuses.some((a) => a.status === "PROCESSED");
  if (completed) {
    await db.transaction(async (tx) => {
      const locked = await billRunRepository.findByIdForUpdate(tx, billRunId);
      if (!locked || locked.status !== "POSTING") return;
      await billRunRepository.completePosting(tx, billRunId);
      await insertAuditEvent(tx, {
        eventType: "BILL_RUN_POSTED",
        actorUserId: actorId,
        targetEntity: "BILL_RUN",
        targetId: billRunId,
        beforeData: { status: locked.status },
        afterData: { status: "COMPLETED" },
      });
    });
  }

  return {
    ok: true,
    value: { billRunId, results, completed },
  } as const;
}
