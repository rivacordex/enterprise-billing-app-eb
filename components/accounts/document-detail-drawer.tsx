// ac21-spec §3.2 — Document detail drawer, server-rendered and URL-driven.
// Mirrors transfer-detail-drawer.tsx: opens via ?doc=<id>, receives closeHref
// that drops ?doc while preserving all other params (inv. #17). No client
// state. Read-only except for DocumentApprovalActions (the sole client
// component in this unit, rendered conditionally per §2.5).

import { ArrowRight, X } from "lucide-react";
import Link from "next/link";

import { AmountCell } from "@/components/accounts/amount-cell";
import { DocStateBadge } from "@/components/accounts/doc-state-badge";
import { DocumentApprovalActions } from "@/components/accounts/document-approval-actions";
import { ReverseButton } from "@/components/accounts/reversal-dialog";
import { formatDatetime } from "@/lib/formatters";
import type {
  DocState,
  DocType,
  LineKind,
  TransactionDocumentDetail,
} from "@/types/accounts";

// DocType chip — neutral chip, matches documents-table.tsx internal.
function DocTypeChip({ docType }: { docType: DocType }): React.JSX.Element {
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-[color:var(--color-neutral-600)] uppercase">
      {docType}
    </span>
  );
}

// Scope chip — reuses the account-kind CSS tokens (ui-context §1.2).
function ScopeChip({
  refBillingAccountId,
}: {
  refBillingAccountId: string | null;
}): React.JSX.Element {
  if (refBillingAccountId === null) {
    return (
      <span className="inline-flex items-center rounded-full bg-[color:var(--acct-chip-fa-bg)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--acct-chip-fa-fg)] uppercase">
        FA-level
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[color:var(--acct-chip-ban-bg)] px-1.5 py-0.5 font-mono text-[10px] font-semibold text-[color:var(--acct-chip-ban-fg)]">
      {refBillingAccountId}
    </span>
  );
}

const LINE_KIND_LABEL: Record<LineKind, string> = {
  capture: "Capture",
  allocation: "Allocation",
  charge: "Charge",
  release: "Release",
  refund: "Refund",
};

const DETAIL_LABEL =
  "block text-[11px] font-semibold tracking-wider text-muted-foreground uppercase";
const DETAIL_VALUE = "mt-0.5 text-body-sm text-foreground";

export interface DocumentDetailDrawerProps {
  detail: TransactionDocumentDetail;
  // closeHref has all current params minus ?doc — closing must not reset
  // the table underneath (ac21-spec §2.1, §3.4).
  closeHref: string;
  locale: string;
  timezone: string;
  canEdit: boolean;
  currentUserId: string;
  // ac22-spec §3.3 — the context FA the document belongs to, passed to the
  // reversal dialog. Present whenever the drawer renders (the drawer only loads
  // when ?doc resolves against the selected FA).
  financialAccountId: string;
  // Mirror of ac20's `reversible` derivation (inv. #18) computed by the page
  // from this document's own state/lines. The service re-validates on submit.
  reversible: boolean;
}

export function DocumentDetailDrawer({
  detail,
  closeHref,
  locale,
  timezone,
  canEdit,
  currentUserId,
  financialAccountId,
  reversible,
}: DocumentDetailDrawerProps): React.JSX.Element {
  const {
    document: doc,
    lines,
    partiallyReversed,
    reversedByDocumentId,
  } = detail;

  const docState = doc.state as DocState;
  const docType = doc.docType as DocType;

  // Build a href that opens a different document while preserving context/filters.
  // closeHref already has all params except ?doc.
  function docLinkHref(id: string): string {
    const sep = closeHref.includes("?") ? "&" : "?";
    return `${closeHref}${sep}doc=${encodeURIComponent(id)}`;
  }

  return (
    <aside
      aria-label="Document detail"
      className="space-y-5 rounded-none border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4"
    >
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-mono text-muted-foreground">
              {doc.documentId}
            </span>
            <DocTypeChip docType={docType} />
          </div>
          <DocStateBadge
            state={docState}
            partiallyReversed={partiallyReversed}
          />
        </div>
        <Link
          href={closeHref}
          aria-label="Close document detail"
          className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none"
        >
          <X className="size-4" />
        </Link>
      </div>

      {/* ── Details ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-[color:var(--border-subtle)] py-4 text-body-sm">
        <div>
          <span className={DETAIL_LABEL}>Scope</span>
          <span className={DETAIL_VALUE}>
            <ScopeChip refBillingAccountId={doc.refBillingAccountId} />
          </span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Reason Code</span>
          <span className={DETAIL_VALUE}>{doc.reasonCode}</span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Amount</span>
          <span className={DETAIL_VALUE}>
            <AmountCell amount={doc.totalAmount} currency={doc.currency} />
          </span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Reference Date</span>
          <span className={DETAIL_VALUE}>
            {formatDatetime(doc.eventAt, locale, timezone)}
          </span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Entry Date</span>
          <span className={DETAIL_VALUE}>
            {formatDatetime(doc.entryDate, locale, timezone)}
          </span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Reference</span>
          <span className={DETAIL_VALUE}>{doc.referenceInfo || "—"}</span>
        </div>
        <div>
          <span className={DETAIL_LABEL}>Created By</span>
          <span className="mt-0.5 truncate font-mono text-mono text-foreground">
            {doc.createdBy}
          </span>
        </div>
        {doc.approvedBy && (
          <div>
            <span className={DETAIL_LABEL}>Approved By</span>
            <span className="mt-0.5 truncate font-mono text-mono text-foreground">
              {doc.approvedBy}
            </span>
          </div>
        )}
      </div>

      {/* ── Cross-links ────────────────────────────────────────────── */}
      {(doc.reversalOf || reversedByDocumentId) && (
        <div className="space-y-1.5 text-body-sm">
          <span className={DETAIL_LABEL}>Cross-links</span>
          {doc.reversalOf && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Reverses</span>
              <ArrowRight
                size={12}
                className="shrink-0 text-muted-foreground"
                aria-hidden
              />
              <Link
                href={docLinkHref(doc.reversalOf)}
                className="font-mono text-mono text-foreground underline underline-offset-2 hover:no-underline"
              >
                {doc.reversalOf}
              </Link>
            </div>
          )}
          {reversedByDocumentId && (
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">Reversed by</span>
              <ArrowRight
                size={12}
                className="shrink-0 text-muted-foreground"
                aria-hidden
              />
              <Link
                href={docLinkHref(reversedByDocumentId)}
                className="font-mono text-mono text-foreground underline underline-offset-2 hover:no-underline"
              >
                {reversedByDocumentId}
              </Link>
            </div>
          )}
        </div>
      )}

      {/* ── Lines + Ledger legs ─────────────────────────────────────── */}
      <div className="space-y-2">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Lines
        </h3>
        {lines.length === 0 ? (
          <p className="text-body-sm text-muted-foreground">No lines.</p>
        ) : (
          lines.map(({ line, transfer }) => {
            const isReversed = line.reversedByLineId !== null;
            const lineKind = line.lineKind as LineKind;
            return (
              <div
                key={line.documentLineId}
                className="rounded-none border border-[color:var(--border-subtle)] p-3 text-body-sm"
              >
                {/* Line header */}
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-mono text-muted-foreground">
                    #{line.lineNo}
                  </span>
                  <span className="inline-flex items-center rounded-full bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-neutral-600)] uppercase">
                    {LINE_KIND_LABEL[lineKind] ?? lineKind}
                  </span>
                  {isReversed && (
                    <span className="inline-flex items-center rounded-full bg-[color:var(--color-danger-50)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-danger-700)] uppercase">
                      Reversed
                    </span>
                  )}
                </div>
                {/* Line amount */}
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-muted-foreground">Amount</span>
                  <AmountCell amount={line.amount} currency={doc.currency} />
                </div>
                {/* Ledger leg — shown for all lines that have a transfer */}
                {line.pgledgerTransferId !== null && (
                  <div className="mt-2 border-t border-[color:var(--border-subtle)] pt-2">
                    <span className="mb-1 block text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
                      Ledger transfer
                    </span>
                    {transfer === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5 font-mono text-mono text-foreground">
                          <span className="truncate">
                            {transfer.fromAccountName}
                          </span>
                          <ArrowRight
                            size={12}
                            className="shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                          <span className="truncate">
                            {transfer.toAccountName}
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">
                            {formatDatetime(transfer.eventAt, locale, timezone)}
                          </span>
                          <AmountCell
                            amount={transfer.amount}
                            currency={doc.currency}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ── Approval timeline (§2.4, SC11) ─────────────────────────── */}
      <div className="space-y-2 border-t border-[color:var(--border-subtle)] pt-4">
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Timeline
        </h3>
        <div className="space-y-1 text-body-sm">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-muted-foreground">Created</span>
            <span className="font-mono text-mono text-foreground">
              {doc.createdBy}
            </span>
          </div>
          {doc.state === "pending_approval" && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Status</span>
              <span className="text-[color:var(--color-warning-700)]">
                Awaiting approval
              </span>
            </div>
          )}
          {doc.approvedBy && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Approved by</span>
              <span className="font-mono text-mono text-foreground">
                {doc.approvedBy}
              </span>
            </div>
          )}
          {doc.postedAt && (
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-muted-foreground">Posted</span>
              <span className="text-foreground">
                {formatDatetime(doc.postedAt, locale, timezone)}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── Approve & post (SC11, SC14) — EDIT only, pending only ───── */}
      {canEdit && (
        <DocumentApprovalActions
          documentId={doc.documentId}
          lastModified={doc.lastModified}
          state={docState}
          createdBy={doc.createdBy}
          currentUserId={currentUserId}
        />
      )}

      {/* ── Reversal (ac22-spec §3.3) — EDIT only. Eligible → the control;
          ineligible → one line of explanatory text (informational, not a
          control) for the case an operator expects the action. Pending is
          handled above by DocumentApprovalActions (approve/reject), unchanged. */}
      {canEdit && reversible && (
        <div className="flex flex-col gap-2 border-t border-[color:var(--border-subtle)] pt-4">
          <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
            Reversal
          </h3>
          <div>
            <ReverseButton
              documentId={doc.documentId}
              financialAccountId={financialAccountId}
              label="↺ Reverse…"
            />
          </div>
        </div>
      )}
      {canEdit && !reversible && docState === "reversed" && (
        <div className="border-t border-[color:var(--border-subtle)] pt-4">
          <p className="text-body-sm text-muted-foreground">
            {reversedByDocumentId
              ? `Reversed by ${reversedByDocumentId}.`
              : "This document has been fully reversed."}
          </p>
        </div>
      )}
    </aside>
  );
}
