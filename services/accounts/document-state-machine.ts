// Document state machine (ac07-spec §2.2): submit (threshold routing, Q20),
// approve (approver ≠ creator, Inv. #6), cancel (draft only). Pure
// composition over `post-document.ts` + `document.repository.ts` — no
// direct pgledger call lives here (Inv. #3).

import { db } from "@/db/client";
import type { Database } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { reasonCodeRepository } from "@/db/repositories/accounts/reason-code.repository";
import * as money from "@/services/accounts/money";
import { postDocument } from "@/services/accounts/post-document";
import type { PostDocumentResult } from "@/services/accounts/post-document";

export type SubmitDocumentResult =
  | PostDocumentResult
  | {
      ok: true;
      value: {
        documentId: string;
        state: "pending_approval";
        lastModified: Date;
      };
    };

// At/below the reason code's `auto_post_limit` → posts immediately (a USER
// holding `accounts_transactions:EDIT` may post directly). Above → routes to
// `pending_approval` and stops; a later `approveDocument` call posts it.
// `auto_post_limit = 0` naturally always routes to approval, since every
// document line's `amount > 0` (DB CHECK) so `total <= 0` never holds.
export async function submitDocument(
  tx: Database,
  documentId: string,
  actorId: string,
): Promise<SubmitDocumentResult> {
  const doc = await documentRepository.findById(tx, documentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.state !== "draft") return { ok: false, code: "DOC_STATE_INVALID" };

  const reason = await reasonCodeRepository.findByCode(tx, doc.reasonCode);
  if (!reason) {
    throw new Error(
      `reason_code '${doc.reasonCode}' not found for document ${documentId}`,
    );
  }

  if (money.compare(doc.totalAmount, reason.autoPostLimit) <= 0) {
    return postDocument(tx, documentId, actorId);
  }

  const updated = await documentRepository.compareAndUpdateState(
    tx,
    documentId,
    doc.lastModified,
    { state: "pending_approval", lastEditedBy: actorId },
  );
  if (!updated) return { ok: false, code: "CONFLICT" };

  return {
    ok: true,
    value: {
      documentId,
      state: "pending_approval",
      lastModified: updated.lastModified,
    },
  };
}

export type ApproveDocumentResult =
  | PostDocumentResult
  | { ok: false; code: "SELF_APPROVAL" };

// `approved_by ≠ created_by` is enforced here (Inv. #6, code-standards
// §1.4) — independent of any UI hiding the approve button for the creator.
// Ownership: any permitted non-creator approver may approve (architecture
// §4), not just a designated owner.
export async function approveDocument(
  tx: Database,
  documentId: string,
  actorId: string,
): Promise<ApproveDocumentResult> {
  const doc = await documentRepository.findById(tx, documentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.state !== "pending_approval") {
    return { ok: false, code: "DOC_STATE_INVALID" };
  }
  if (actorId === doc.createdBy) return { ok: false, code: "SELF_APPROVAL" };

  const updated = await documentRepository.compareAndUpdateState(
    tx,
    documentId,
    doc.lastModified,
    { state: "pending_approval", approvedBy: actorId, lastEditedBy: actorId },
  );
  if (!updated) return { ok: false, code: "CONFLICT" };

  const posted = await postDocument(tx, documentId, actorId);
  if (!posted.ok || posted.value.state !== "posted") return posted;

  // Re-derive BAN payment_status after approval posts — same live-read pattern
  // as allocate-payment.ts / raise-credit-note.ts / rounding-adjustment.ts.
  // FA-only documents (DEP) have null refBillingAccountId and skip this step.
  if (doc.refBillingAccountId) {
    const banBindings = await ledgerBindingRepository.findByOwner(
      tx,
      "billing_account",
      doc.refBillingAccountId,
    );
    const rec = banBindings.find((b) => b.ledgerRole === "receivables");
    if (rec) {
      const balance = await ledgerRepository.balanceByLedgerAccountId(
        tx,
        rec.pgledgerAccountId,
      );
      const newStatus =
        money.openReceivable(balance ?? "0.00") > 0n ? "due" : "paid";
      await billingAccountRepository.updatePaymentStatus(
        tx,
        doc.refBillingAccountId,
        newStatus,
      );
    }
  }

  return posted;
}

// Standalone entry points for actions (which may not open their own
// `db.transaction` — `actions/**` must not import `db/**` directly,
// architecture §2) — each opens its own transaction and delegates.
export async function submitDocumentStandalone(
  documentId: string,
  actorId: string,
): Promise<SubmitDocumentResult> {
  return db.transaction((tx) => submitDocument(tx, documentId, actorId));
}

export async function approveDocumentStandalone(
  documentId: string,
  actorId: string,
): Promise<ApproveDocumentResult> {
  return db.transaction((tx) => approveDocument(tx, documentId, actorId));
}

export type CancelDocumentResult =
  | {
      ok: true;
      value: { documentId: string; state: "cancelled"; lastModified: Date };
    }
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "DOC_STATE_INVALID" }
  | { ok: false; code: "CONFLICT" };

export async function cancelDocument(
  tx: Database,
  documentId: string,
  actorId: string,
): Promise<CancelDocumentResult> {
  const doc = await documentRepository.findById(tx, documentId);
  if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
  if (doc.state !== "draft") return { ok: false, code: "DOC_STATE_INVALID" };

  const updated = await documentRepository.compareAndUpdateState(
    tx,
    documentId,
    doc.lastModified,
    { state: "cancelled", lastEditedBy: actorId },
  );
  if (!updated) return { ok: false, code: "CONFLICT" };

  return {
    ok: true,
    value: {
      documentId,
      state: "cancelled",
      lastModified: updated.lastModified,
    },
  };
}
