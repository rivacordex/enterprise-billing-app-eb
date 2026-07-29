// The sole caller of `ledgerRepository.pgledgerCreateTransfers` (Module Inv.
// #3, code-standards §1.1 — ac17's grep-gate). `postDocument` runs the six
// steps of ac07-spec §2.3 in one `db.transaction` (the caller owns the
// transaction boundary, same convention as `onboardCustomerAccounts`).

import type { Database } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { accountingPeriodRepository } from "@/db/repositories/accounts/accounting-period.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { reasonCodeRepository } from "@/db/repositories/accounts/reason-code.repository";
import type { Document } from "@/db/schema/billing/documents";
import type { DocumentLine } from "@/db/schema/billing/documents";
import type { ReasonCode } from "@/db/schema/billing/catalogs";
import * as money from "@/services/accounts/money";
import { resolveLegTemplate } from "@/services/accounts/leg-templates";
import type { DocType, LineKind, PostingNature } from "@/types/accounts";

export type PostDocumentResult =
  | {
      ok: true;
      value: {
        documentId: string;
        state: "posted";
        postedAt: Date;
        lastModified: Date;
      };
    }
  | { ok: false; code: "DOCUMENT_NOT_FOUND" }
  | { ok: false; code: "DOC_STATE_INVALID" }
  | { ok: false; code: "APPROVAL_REQUIRED" }
  | { ok: false; code: "SELF_APPROVAL" }
  | { ok: false; code: "UNBALANCED_DOC" }
  | { ok: false; code: "PERIOD_CLOSED"; openPeriodHint: string }
  | { ok: false; code: "CONFLICT" };

export type PostedLeg = {
  fromAccountId: string;
  toAccountId: string;
  amount: string;
};

// Natures that resolve to a `sys.{name}.{ccy}` counter-account (Module Inv.
// #8, code-standards §2.3 step 4 exception). `name` is usually the nature
// itself, except `deposit_movement`, which steers to the existing
// `sys.cash` account — ac03 seeded no `sys.deposit_movement` account (Q16's
// `deposits ↔ sys.cash` story, ac08-spec §2.2, flagged in ac03's progress
// tracker entry for this unit to resolve).
const NATURE_SYS_ACCOUNT_NAME: Partial<Record<PostingNature, string>> = {
  revenue: "revenue",
  revenue_adj: "revenue_adj",
  write_off: "write_off",
  rounding: "rounding",
  cash: "cash",
  deposit_movement: "cash",
};

function periodKeyFor(eventAt: Date): string {
  return eventAt.toISOString().slice(0, 7);
}

type GuardedDocument = {
  doc: Document;
  lines: DocumentLine[];
  reason: ReasonCode;
};

// Steps 1–3 of §2.3, shared by both `postDocument` (template-resolved legs)
// and `postExplicitLegs` (caller-supplied legs, e.g. the refund workbench's
// allocation reversal): state/threshold/approval guard, balanced-doc check,
// and open-period validation — all inside the caller's transaction so a
// period close racing a post can't interleave (code-standards §6.8).
async function guardAndLoad(
  tx: Database,
  documentId: string,
): Promise<
  | { ok: true; value: GuardedDocument }
  | { ok: false; result: PostDocumentResult }
> {
  const doc = await documentRepository.findById(tx, documentId);
  if (!doc)
    return { ok: false, result: { ok: false, code: "DOCUMENT_NOT_FOUND" } };

  const reason = await reasonCodeRepository.findByCode(tx, doc.reasonCode);
  if (!reason) {
    throw new Error(
      `reason_code '${doc.reasonCode}' not found for document ${documentId}`,
    );
  }

  if (doc.state === "draft") {
    if (money.compare(doc.totalAmount, reason.autoPostLimit) > 0) {
      return { ok: false, result: { ok: false, code: "APPROVAL_REQUIRED" } };
    }
  } else if (doc.state === "pending_approval") {
    if (!doc.approvedBy) {
      return { ok: false, result: { ok: false, code: "APPROVAL_REQUIRED" } };
    }
    if (doc.approvedBy === doc.createdBy) {
      return { ok: false, result: { ok: false, code: "SELF_APPROVAL" } };
    }
  } else {
    return { ok: false, result: { ok: false, code: "DOC_STATE_INVALID" } };
  }

  const lines = await documentLineRepository.findByDocumentId(tx, documentId);
  if (
    lines.length === 0 ||
    money.compare(doc.totalAmount, money.sum(...lines.map((l) => l.amount))) !==
      0
  ) {
    return { ok: false, result: { ok: false, code: "UNBALANCED_DOC" } };
  }

  // Period-absence resolution (spec §"Note on codebase verification" — no
  // period-close policy toggle exists yet; ac14 owns period open/close
  // workflow). An absent period row is treated as open: only an existing
  // row with state='closed' rejects the post. Recorded in the progress
  // tracker's session notes.
  const period = periodKeyFor(doc.eventAt);
  const periodRow = await accountingPeriodRepository.findByPeriodAndCurrency(
    tx,
    period,
    doc.currency,
  );
  if (periodRow?.state === "closed") {
    return {
      ok: false,
      result: {
        ok: false,
        code: "PERIOD_CLOSED",
        openPeriodHint: `Period ${period} is closed for ${doc.currency}. Choose an entry date in an open period.`,
      },
    };
  }

  return { ok: true, value: { doc, lines, reason } };
}

// Steps 5–6 of §2.3: post every leg in one `pgledger_create_transfers` call,
// stamp each line's `pgledger_transfer_id` (Module Inv. #3/#7), flip the doc
// to `posted`, and write the audit event. Shared tail for both entry points.
async function finalizePosting(
  tx: Database,
  doc: Document,
  lines: DocumentLine[],
  legs: PostedLeg[],
  actorId: string,
): Promise<PostDocumentResult> {
  const transfers = await ledgerRepository.pgledgerCreateTransfers(
    tx,
    legs,
    doc.eventAt,
    { doc: doc.documentId },
  );
  if (transfers.length !== lines.length) {
    throw new Error(
      `pgledger_create_transfers returned ${transfers.length} transfers for ${lines.length} document lines`,
    );
  }
  for (let i = 0; i < lines.length; i++) {
    await documentLineRepository.setTransferId(
      tx,
      lines[i]!.documentLineId,
      transfers[i]!.id,
    );
  }

  const postedAt = new Date();
  const updated = await documentRepository.compareAndUpdateState(
    tx,
    doc.documentId,
    doc.lastModified,
    { state: "posted", postedAt, lastEditedBy: actorId },
  );
  // Ledger transfers are already written — a CAS miss here means concurrent
  // mutation raced past the transaction boundary. Throw so the enclosing
  // db.transaction rolls back rather than committing orphaned ledger entries.
  if (!updated)
    throw new Error(
      `CONFLICT: document ${doc.documentId} state update failed after ledger writes`,
    );

  await insertAuditEvent(tx, {
    eventType: "DOCUMENT_POSTED",
    actorUserId: actorId,
    targetEntity: "DOCUMENT",
    targetId: doc.documentId,
    beforeData: null,
    afterData: {
      documentId: doc.documentId,
      docType: doc.docType,
      reasonCode: doc.reasonCode,
      totalAmount: doc.totalAmount,
      lineCount: lines.length,
    },
  });

  return {
    ok: true,
    value: {
      documentId: doc.documentId,
      state: "posted",
      postedAt: updated.postedAt!,
      lastModified: updated.lastModified,
    },
  };
}

// The one place every non-explicit-leg post resolves its legs from
// `leg-templates.ts` (§2.3 step 4/5) — capture, allocation, and the simple
// (unallocated-overpayment) refund case.
export async function postDocument(
  tx: Database,
  documentId: string,
  actorId: string,
): Promise<PostDocumentResult> {
  const guarded = await guardAndLoad(tx, documentId);
  if (!guarded.ok) return guarded.result;
  const { doc, lines, reason } = guarded.value;

  const ucBindings = await ledgerBindingRepository.findByOwner(
    tx,
    "financial_account",
    doc.refFinancialAccountId,
  );
  const uc = ucBindings.find((b) => b.ledgerRole === "unapplied_cash");
  if (!uc) {
    throw new Error(
      `unapplied_cash binding not found for FA ${doc.refFinancialAccountId}`,
    );
  }
  const deposits = ucBindings.find((b) => b.ledgerRole === "deposits");

  let sysAccountId: string | null = null;
  const sysAccountName =
    NATURE_SYS_ACCOUNT_NAME[reason.postingNature as PostingNature];
  if (sysAccountName) {
    const sysAccount = await ledgerRepository.findByName(
      tx,
      `sys.${sysAccountName}.${doc.currency}`,
    );
    if (!sysAccount) {
      throw new Error(
        `sys.${sysAccountName}.${doc.currency} account not found`,
      );
    }
    sysAccountId = sysAccount.id;
  }

  const legs: PostedLeg[] = [];
  for (const line of lines) {
    let receivablesAccountId: string | null = null;
    if (line.refBillingAccountId) {
      const banBindings = await ledgerBindingRepository.findByOwner(
        tx,
        "billing_account",
        line.refBillingAccountId,
      );
      const rec = banBindings.find((b) => b.ledgerRole === "receivables");
      if (!rec) {
        throw new Error(
          `receivables binding not found for BAN ${line.refBillingAccountId}`,
        );
      }
      receivablesAccountId = rec.pgledgerAccountId;
    }

    const template = resolveLegTemplate(
      doc.docType as DocType,
      line.lineKind as LineKind,
    );
    const resolved = template({
      financialAccountUnappliedCashId: uc.pgledgerAccountId,
      financialAccountDepositsId: deposits?.pgledgerAccountId ?? null,
      sysAccountId,
      billingAccountReceivablesId: receivablesAccountId,
    });
    legs.push({ ...resolved, amount: line.amount });
  }

  return finalizePosting(tx, doc, lines, legs, actorId);
}

// The explicit-leg primitive (§3.3) — for legs that can't be derived from a
// line's `(doc_type, line_kind)` alone, e.g. the refund workbench's
// allocation reversal (the opposite of some other already-posted transfer).
// Still runs the full guard/balance/period/audit pipeline; the caller is
// responsible only for computing `legs`, one per document line in line-no
// order, each amount matching its line's `amount`.
export async function postExplicitLegs(
  tx: Database,
  documentId: string,
  actorId: string,
  legs: PostedLeg[],
): Promise<PostDocumentResult> {
  const guarded = await guardAndLoad(tx, documentId);
  if (!guarded.ok) return guarded.result;
  const { doc, lines } = guarded.value;

  if (legs.length !== lines.length) {
    throw new Error(
      `postExplicitLegs: ${legs.length} legs supplied for ${lines.length} document lines`,
    );
  }
  for (let i = 0; i < lines.length; i++) {
    if (money.compare(legs[i]!.amount, lines[i]!.amount) !== 0) {
      throw new Error(
        `postExplicitLegs: leg amount does not match line ${lines[i]!.documentLineId}`,
      );
    }
  }

  return finalizePosting(tx, doc, lines, legs, actorId);
}
