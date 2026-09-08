import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { billRunInvoicesRepository } from "@/db/repositories/billing/bill-run-invoices.repository";
import { postDocument } from "@/services/accounts/post-document";
import type { PostDocumentResult } from "@/services/accounts/post-document";
import * as money from "@/services/accounts/money";
import { firstOfMonth } from "@/services/billing/derive-periods";
import { renderFinalInvoice } from "@/services/billing/render-invoice";
import { blobStore } from "@/services/billing/blob-store";
import { logger } from "@/lib/logger";
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

// bm19-spec §Design "Render + store is a SEPARATE step from the posting
// transaction (D10)" — called ONLY after `postAccount`'s per-account
// transaction has committed the posted INV. Deliberately swallows every
// failure: a render/store failure must never roll back the posted INV, never
// hold `INVOICED`, and never abort the caller's loop — it is only ever
// recorded via the ABSENCE of a `bill_run_invoices` row (no separate
// "render-pending" flag column exists; `retryRenderInvoice` below re-derives
// exactly this same absence).
async function renderAndStoreInvoice(
  billRunId: string,
  billingAccountId: string,
  posted: {
    customerBillId: string;
    periodPartition: string;
    documentId: string;
  },
): Promise<void> {
  try {
    const pdf = await renderFinalInvoice({
      runId: billRunId,
      banId: billingAccountId,
      invoiceNo: posted.documentId,
    });
    const { blobRef, checksum } = await blobStore.putInvoice(
      posted.periodPartition,
      posted.documentId,
      pdf,
    );
    await billRunInvoicesRepository.insert(db, {
      refBillRunId: billRunId,
      refBillingAccountId: billingAccountId,
      refCustomerBillId: posted.customerBillId,
      refInvDocumentId: posted.documentId,
      blobRef,
      checksum,
      periodPartition: posted.periodPartition,
    });
  } catch (err) {
    logger.error(
      "post-run: final render/store failed — INV posted, artifact render-pending",
      {
        billRunId,
        billingAccountId,
        documentId: posted.documentId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

// bm19-spec §Implementation §4 "Add a retry-render path". Standalone —
// deliberately NOT gated on the run's status (unlike `postRun`/`postAccount`,
// which require `APPROVED`/`POSTING`): a run reaches `INVOICED`/`COMPLETED`
// on posting completion regardless of render outcome (Design), so a
// render-pending account may need retrying long after the run itself is
// done and `postRun` would refuse it (`NOT_POSTABLE`). Only requires the
// target account to actually be posted and not yet stored.
export type RetryRenderResult =
  | { ok: true; value: { billingAccountId: string; blobRef: string } }
  | { ok: false; code: "NOT_INVOICED" | "ALREADY_STORED" | "RENDER_FAILED" };

export async function retryRenderInvoice(
  billRunId: string,
  billingAccountId: string,
): Promise<RetryRenderResult> {
  const bill = await customerBillRepository.findForAccount(
    db,
    billRunId,
    billingAccountId,
  );
  if (!bill || !bill.refInvDocumentId) {
    return { ok: false, code: "NOT_INVOICED" };
  }

  const existing = await billRunInvoicesRepository.findByRunAndAccount(
    db,
    billRunId,
    billingAccountId,
  );
  if (existing) {
    return { ok: false, code: "ALREADY_STORED" };
  }

  try {
    const pdf = await renderFinalInvoice({
      runId: billRunId,
      banId: billingAccountId,
      invoiceNo: bill.refInvDocumentId,
    });
    const { blobRef, checksum } = await blobStore.putInvoice(
      bill.periodPartition,
      bill.refInvDocumentId,
      pdf,
    );
    await billRunInvoicesRepository.insert(db, {
      refBillRunId: billRunId,
      refBillingAccountId: billingAccountId,
      refCustomerBillId: bill.customerBillId,
      refInvDocumentId: bill.refInvDocumentId,
      blobRef,
      checksum,
      periodPartition: bill.periodPartition,
    });
    return { ok: true, value: { billingAccountId, blobRef } };
  } catch (err) {
    // A concurrent renderer (the post-commit render in `renderAndStoreInvoice`,
    // or a double-fired retry) can store the artifact between our existence
    // check above and this insert; the (run, ban, period) unique constraint
    // then rejects our insert. That is a successful store, not a render
    // failure — re-check and report it as ALREADY_STORED rather than a
    // misleading RENDER_FAILED.
    const stored = await billRunInvoicesRepository.findByRunAndAccount(
      db,
      billRunId,
      billingAccountId,
    );
    if (stored) {
      return { ok: false, code: "ALREADY_STORED" };
    }
    logger.error("post-run: retry-render failed", {
      billRunId,
      billingAccountId,
      documentId: bill.refInvDocumentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, code: "RENDER_FAILED" };
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

  // Captured inside the transaction below, read again just after it commits
  // (D10 — render + store is a step SEPARATE from the posting transaction,
  // never inside it). Stays `null` on every path that doesn't reach a fresh
  // `INVOICED` (skip/failure), so the post-commit hook only ever fires once
  // per new post.
  let justPosted: {
    customerBillId: string;
    periodPartition: string;
    documentId: string;
  } | null = null;

  try {
    const result = await db.transaction(async (tx) => {
      // One row-locked read: the trial bill + the account's attempt counter +
      // the billing-account GL fields, in a single round-trip. `FOR UPDATE OF
      // customer_bill` serializes concurrent posts of the same account.
      const bill = await customerBillRepository.lockBillForPosting(
        tx,
        run.billRunId,
        billingAccountId,
        firstOfMonth(run.periodStart),
      );
      if (!bill) {
        throw new Error(
          `postAccount: no postable customer_bill for run ${run.billRunId} / account ${billingAccountId}`,
        );
      }
      if (bill.refInvDocumentId) {
        return { status: "skipped" } as const;
      }

      const doc = await documentRepository.insert(tx, "INV", {
        state: "draft",
        refFinancialAccountId: bill.refFinancialAccountId,
        refBillingAccountId: billingAccountId,
        reasonCode: "STANDARD_INVOICE",
        currency: bill.currency,
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
        // bm19-spec §Phase-2 review folds T5 [P1] — the structural
        // one-INV-per-bill latch: stamping these two lets the DB's partial
        // UNIQUE index (`document_ref_customer_bill_id_unique`) refuse a
        // second INV for this same bill outright, backing up (not
        // replacing) the `lockBillForPosting`/`stampPosted` guards below.
        refCustomerBillId: bill.customerBillId,
        periodPartition: bill.periodPartition,
      });

      await documentLineRepository.insert(tx, {
        refDocumentId: doc.documentId,
        lineNo: 1,
        lineKind: "charge",
        refBillingAccountId: billingAccountId,
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
          refBillingAccountId: billingAccountId,
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

      const chargeChecksum = await ratedLinesRepository.computeChargeChecksum(
        tx,
        run.billRunId,
        billingAccountId,
        bill.attemptCount,
      );
      const stamped = await customerBillRepository.stampPosted(
        tx,
        bill.customerBillId,
        bill.periodPartition,
        {
          refInvDocumentId: doc.documentId,
          postedAttempt: bill.attemptCount,
          chargeChecksum,
        },
      );
      if (!stamped) {
        // The bill was posted concurrently (its `ref_inv_document_id` was set
        // after our FOR UPDATE-guarded resume check). Throw so this INV create
        // + post and the account `INVOICED` flip roll back — at most one INV.
        throw new Error(
          `postAccount: customer_bill ${bill.customerBillId} was concurrently posted`,
        );
      }
      await billRunAccountRepository.updateStatus(
        tx,
        run.billRunId,
        billingAccountId,
        { status: "INVOICED", errorCode: null, errorDetail: null },
      );

      justPosted = {
        customerBillId: bill.customerBillId,
        periodPartition: bill.periodPartition,
        documentId: doc.documentId,
      };
      return { status: "invoiced", invoiceId: doc.documentId } as const;
    });

    if (justPosted) {
      await renderAndStoreInvoice(run.billRunId, billingAccountId, justPosted);
    }
    return result;
  } catch (err) {
    // The transaction above already rolled back — no orphan INV/ledger write.
    // Park the account with a fresh, separate write so the failure is visible
    // and `postRun` can move on to the next account (Design "park + continue").
    let code: string;
    let detail: string;
    if (err instanceof PostAccountFailureSignal) {
      // A tolerated, operator-facing posting failure — `message` is already a
      // friendly `describePostFailure` string.
      code = err.code;
      detail = err.message;
    } else {
      // An unexpected error (an invariant breach — missing bill/account — or the
      // concurrent-post guard). Log the real cause server-side, but never leak
      // internal ids/messages into the operator-facing `errorDetail`.
      logger.error("post-run: unexpected postAccount failure", {
        billRunId: run.billRunId,
        billingAccountId,
        error: err instanceof Error ? err.message : String(err),
      });
      code = "POSTING_FAILED";
      detail = "An unexpected error occurred while posting this invoice.";
    }
    // `expectedStatus: 'PROCESSED'` guards against clobbering an account a
    // concurrent poster has already committed as `INVOICED` (the row lock only
    // serialized the bill, not this after-rollback write). Wrapped in its own
    // try/catch so a transient failure of THIS write can never propagate out of
    // `postAccount` and abort the whole `postRun` loop — the account is simply
    // left `PROCESSED` and retried on the next `postRun` (Design "park +
    // continue" / resumable).
    try {
      const parked = await billRunAccountRepository.updateStatus(
        db,
        run.billRunId,
        billingAccountId,
        {
          status: "PROCESSED",
          errorCode: code,
          errorDetail: detail,
          expectedStatus: "PROCESSED",
        },
      );
      if (!parked) {
        // The guarded write matched no row: the account is no longer
        // `PROCESSED` — a concurrent poster committed it as `INVOICED` between
        // our rollback and this park. There is nothing to park; report it as
        // skipped (already posted) rather than falsely claiming a parked
        // failure.
        return { status: "skipped" } as const;
      }
    } catch (parkErr) {
      // Could not record the failure. Log it, leave the account `PROCESSED`
      // (the next `postRun` retries it), and still report the failure to the
      // caller so the loop moves on to the next account instead of aborting.
      logger.error("post-run: failed to park account after a posting failure", {
        billRunId: run.billRunId,
        billingAccountId,
        error: parkErr instanceof Error ? parkErr.message : String(parkErr),
      });
    }
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
      // Guarded on `status = 'APPROVED'`; under the lock this always applies,
      // but treat a 0-row result as not-postable rather than proceeding.
      const flipped = await billRunRepository.markPosting(tx, billRunId);
      return flipped ? { ...found, status: "POSTING" } : null;
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

  // Decide completion INSIDE the run's FOR UPDATE lock: read the account
  // statuses and flip to COMPLETED atomically, so the "no account still
  // PROCESSED" check and the write can't be computed from divergent snapshots
  // (two concurrent resumes, or a park landing between an unlocked read and the
  // flip). `completePosting`'s `status = 'POSTING'` guard makes a losing
  // concurrent invocation a no-op that skips the audit.
  const completed = await db.transaction(async (tx) => {
    const locked = await billRunRepository.findByIdForUpdate(tx, billRunId);
    if (!locked || locked.status !== "POSTING") return false;
    const statuses = await billRunAccountRepository.listStatusesForRun(
      tx,
      billRunId,
    );
    if (statuses.some((a) => a.status === "PROCESSED")) return false;
    const done = await billRunRepository.completePosting(tx, billRunId);
    if (!done) return false;
    await insertAuditEvent(tx, {
      eventType: "BILL_RUN_POSTED",
      actorUserId: actorId,
      targetEntity: "BILL_RUN",
      targetId: billRunId,
      beforeData: { status: locked.status },
      afterData: { status: "COMPLETED" },
    });
    return true;
  });

  return {
    ok: true,
    value: { billRunId, results, completed },
  } as const;
}
