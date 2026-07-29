// Payment refund workbench (ac07-spec §2.4b) — BAN-scoped, always four-eyes
// (reason `PAYMENT_REFUND`, `auto_post_limit = 0`). Reverses selected
// allocation applications (`release` lines, the opposite of `allocation`'s
// leg) and, for a cash refund, adds one payout line (`sys.cash →
// fa.unapplied_cash`) for the combined total. Convert-to-advance posts the
// reversal(s) only — no payout leg. The simplest case (no application, a
// pure unallocated-overpayment refund) needs only the payout line.
//
// `release`/`refund` are both deterministic (doc_type, line_kind) shapes —
// registered in `leg-templates.ts` — so this composes on the same generic
// `submitDocument`/`postDocument` path as capture/allocate; no direct
// ledger call lives here (Module Inv. #3).

import { db } from "@/db/client";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { financialAccountRepository } from "@/db/repositories/accounts/financial-account.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import type { Document, DocumentLine } from "@/db/schema/billing/documents";
import * as money from "@/services/accounts/money";
import { submitDocument } from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import type { AssignedItem } from "@/types/accounts";

export type { AssignedItem };

// Read side for the workbench's two entry modes (§2.4b) — both "by payment"
// and "by financial document" group the same underlying set of posted,
// not-yet-reversed allocation lines for the BAN; grouping is a UI concern
// over this one list.
export async function listAssignedItemsForBan(
  billingAccountId: string,
): Promise<AssignedItem[]> {
  const lines = await documentLineRepository.findAllocationsForBillingAccount(
    db,
    billingAccountId,
  );
  return lines.map((row) => ({
    allocationLineId: row.line.documentLineId,
    paymentDocumentId: row.line.refDocumentId,
    refSettledDocumentId: row.line.refSettledDocumentId,
    amount: row.line.amount,
    eventAt: row.document.eventAt,
  }));
}

export async function getUnappliedCashAvailable(
  financialAccountId: string,
): Promise<string> {
  const bindings = await ledgerBindingRepository.findByOwner(
    db,
    "financial_account",
    financialAccountId,
  );
  const uc = bindings.find((b) => b.ledgerRole === "unapplied_cash");
  if (!uc)
    throw new Error(
      `unapplied_cash binding not found for FA ${financialAccountId}`,
    );
  const balance = await ledgerRepository.balanceByLedgerAccountId(
    db,
    uc.pgledgerAccountId,
  );
  // Credit-normal account — held magnitude is `0 - balance` (balance <= 0).
  return money.subtract("0.00", balance ?? "0.00");
}

export type RefundItemInput = {
  // The assigned item (posted `allocation` line) being reversed. null = a
  // pure unallocated-overpayment refund straight from the unapplied pool —
  // the simplest case (§2.4, only the payout leg).
  allocationLineId: string | null;
  refundedAmount: string;
};

export type RefundPaymentInput = {
  financialAccountId: string;
  billingAccountId: string;
  refundType: "cash" | "convert_to_advance";
  items: RefundItemInput[];
  eventAt: Date;
  referenceDate: Date;
  referenceInfo: string;
};

export type RefundPaymentResult =
  | SubmitDocumentResult
  | { ok: false; code: "FINANCIAL_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "BILLING_ACCOUNT_NOT_FOUND" }
  | { ok: false; code: "UNSUPPORTED_CURRENCY" }
  | { ok: false; code: "NO_ITEMS_SELECTED" }
  | { ok: false; code: "ALLOCATION_LINE_NOT_FOUND" }
  | { ok: false; code: "ALREADY_REFUNDED" }
  | { ok: false; code: "AMOUNT_EXCEEDS_ORIGINAL" }
  | { ok: false; code: "INSUFFICIENT_UNAPPLIED_CASH" }
  | { ok: false; code: "CONVERT_TO_ADVANCE_REQUIRES_APPLICATION" };

type ResolvedItem = {
  allocationLine: DocumentLine | null;
  refundedAmount: string;
};

export async function refundPayment(
  input: RefundPaymentInput,
  actorId: string,
): Promise<RefundPaymentResult> {
  const fa = await financialAccountRepository.findById(
    db,
    input.financialAccountId,
  );
  if (!fa) return { ok: false, code: "FINANCIAL_ACCOUNT_NOT_FOUND" };
  if (fa.currency !== "MYR") return { ok: false, code: "UNSUPPORTED_CURRENCY" };

  const ban = await billingAccountRepository.findById(
    db,
    input.billingAccountId,
  );
  if (!ban || ban.refFinancialAccountId !== fa.financialAccountId) {
    return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
  }

  if (input.items.length === 0) return { ok: false, code: "NO_ITEMS_SELECTED" };

  if (
    input.refundType === "convert_to_advance" &&
    input.items.some((i) => i.allocationLineId === null)
  ) {
    return { ok: false, code: "CONVERT_TO_ADVANCE_REQUIRES_APPLICATION" };
  }

  const resolvedItems: ResolvedItem[] = [];
  for (const item of input.items) {
    if (item.allocationLineId === null) {
      resolvedItems.push({
        allocationLine: null,
        refundedAmount: item.refundedAmount,
      });
      continue;
    }
    const line = await documentLineRepository.findById(
      db,
      item.allocationLineId,
    );
    if (!line || line.lineKind !== "allocation") {
      return { ok: false, code: "ALLOCATION_LINE_NOT_FOUND" };
    }
    if (line.refBillingAccountId !== ban.billingAccountId) {
      return { ok: false, code: "BILLING_ACCOUNT_NOT_FOUND" };
    }
    if (line.reversedByLineId) return { ok: false, code: "ALREADY_REFUNDED" };
    if (money.compare(item.refundedAmount, line.amount) > 0) {
      return { ok: false, code: "AMOUNT_EXCEEDS_ORIGINAL" };
    }
    resolvedItems.push({
      allocationLine: line,
      refundedAmount: item.refundedAmount,
    });
  }

  const overpaymentTotal = money.sum(
    ...resolvedItems
      .filter((i) => !i.allocationLine)
      .map((i) => i.refundedAmount),
  );
  if (money.compare(overpaymentTotal, "0.00") > 0) {
    const available = await getUnappliedCashAvailable(fa.financialAccountId);
    if (money.compare(overpaymentTotal, available) > 0) {
      return { ok: false, code: "INSUFFICIENT_UNAPPLIED_CASH" };
    }
  }

  type PlannedLine = {
    lineKind: "release" | "refund";
    amount: string;
    refBillingAccountId: string | null;
    refSettledDocumentId: string | null;
    reverses: DocumentLine | null;
  };

  const plannedLines: PlannedLine[] = resolvedItems
    .filter(
      (i): i is ResolvedItem & { allocationLine: DocumentLine } =>
        i.allocationLine !== null,
    )
    .map((i) => ({
      lineKind: "release",
      amount: i.refundedAmount,
      refBillingAccountId: ban.billingAccountId,
      refSettledDocumentId: i.allocationLine.refSettledDocumentId,
      reverses: i.allocationLine,
    }));

  if (input.refundType === "cash") {
    const payoutTotal = money.sum(
      ...resolvedItems.map((i) => i.refundedAmount),
    );
    plannedLines.push({
      lineKind: "refund",
      amount: payoutTotal,
      refBillingAccountId: null,
      refSettledDocumentId: null,
      reverses: null,
    });
  }

  const totalAmount = money.sum(...plannedLines.map((l) => l.amount));

  return db.transaction(async (tx) => {
    const doc: Document = await documentRepository.insert(tx, "PAY", {
      state: "draft",
      refFinancialAccountId: fa.financialAccountId,
      refBillingAccountId: ban.billingAccountId,
      reasonCode: "PAYMENT_REFUND",
      currency: fa.currency,
      totalAmount,
      paymentMode: null,
      modeRef: null,
      referenceDate: input.referenceDate,
      referenceInfo: input.referenceInfo,
      eventAt: input.eventAt,
      postedAt: null,
      reversalOf: null,
      createdBy: actorId,
      approvedBy: null,
      metadata: null,
      lastEditedBy: actorId,
    });

    let lineNo = 1;
    for (const planned of plannedLines) {
      const line = await documentLineRepository.insert(tx, {
        refDocumentId: doc.documentId,
        lineNo: lineNo++,
        lineKind: planned.lineKind,
        refBillingAccountId: planned.refBillingAccountId,
        refSettledDocumentId: planned.refSettledDocumentId,
        amount: planned.amount,
        pgledgerTransferId: null,
        reversedByLineId: null,
        lastEditedBy: actorId,
      });
      if (planned.reverses) {
        await documentLineRepository.setReversedByLineId(
          tx,
          planned.reverses.documentLineId,
          line.documentLineId,
        );
      }
    }

    // Always four-eyes (`auto_post_limit = 0`, Q20) — `submitDocument`
    // always routes this to `pending_approval`; a non-creator MANAGER posts
    // it via `approve-document`.
    return submitDocument(tx, doc.documentId, actorId);
  });
}
