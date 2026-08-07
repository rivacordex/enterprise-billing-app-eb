"use client";

// ac22-spec §3.1 — the document-bound reversal dialog. Replaces
// ReversalsPanel's free-typed document-ID form (deleted in this unit, SC10):
// the dialog is bound to a `documentId` by construction, so there is no
// preview-cancellation ref, no docId input and no standalone preview-loading
// state to compensate for "no document to start from".
//
// The line checkboxes select between full and partial reversal against the
// already-shipped ac11 contract (§2.4): all unreversed lines checked → the
// action omits `selectedLineIds` and `reverseDocument` runs (original flips to
// `reversed`); a strict subset → `selectedLineIds` is sent and `reverseLine`
// runs (original stays `posted` with a reduced remainder). No schema, action
// or service change — this is a UI change (inv. #18: the service re-validates
// state/coverage/ownership/CAS/period on every call regardless of what the UI
// rendered).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getReversalPreviewAction,
  reverseDocumentAction,
} from "@/actions/accounts/reverse-document";
import type { ReversalPreview } from "@/actions/accounts/reverse-document";
import { AmountCell } from "@/components/accounts/amount-cell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Migrated verbatim from ReversalsPanel (ac22-spec §2.7) so the reversal error
// vocabulary does not regress. Exported for the dialog's tests.
export function describeReversalError(code: string): string {
  switch (code) {
    case "VALIDATION_ERROR":
      return "Some fields are invalid — see details below.";
    case "FORBIDDEN":
      return "You do not have permission to perform this action.";
    case "DOCUMENT_NOT_FOUND":
      return "Document not found.";
    case "WRONG_FINANCIAL_ACCOUNT":
      return "This document does not belong to the selected Financial Account.";
    case "DOC_STATE_INVALID":
      return "Only posted documents can be reversed.";
    case "ALREADY_REVERSED":
      return "All lines of this document have already been reversed.";
    case "LINE_NOT_FOUND":
      return "One or more selected lines were not found on this document.";
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found or does not belong to this Financial Account.";
    case "PERIOD_CLOSED":
      return "The entry date falls in a closed accounting period. Choose a date in an open period.";
    case "UNBALANCED_DOC":
      return "The reversal document did not balance. Please try again.";
    case "CONFLICT":
      return "The document was modified concurrently. Please reload and try again.";
    case "APPROVAL_REQUIRED":
      return "This amount requires manager approval.";
    case "SELF_APPROVAL":
      return "You cannot approve your own reversal.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface ReversalDialogProps {
  documentId: string;
  financialAccountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ReversalDialog({
  documentId,
  financialAccountId,
  open,
  onOpenChange,
}: ReversalDialogProps): React.JSX.Element {
  const router = useRouter();

  const [preview, setPreview] = useState<ReversalPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewErrorCode, setPreviewErrorCode] = useState<string | null>(null);

  // Checked = the unreversed lines the operator wants to reverse. Seeded to
  // "all unreversed" on load (§2.4 — checkbox checked by default).
  const [checkedLineIds, setCheckedLineIds] = useState<Set<string>>(new Set());
  const [reversalComment, setReversalComment] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [referenceDate, setReferenceDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<
    string,
    string[]
  > | null>(null);

  // A manual reload trigger for the CONFLICT "Reload preview" button; the
  // fetch effect re-runs whenever this changes.
  const [reloadNonce, setReloadNonce] = useState(0);

  // Reset-during-render on the closed→open transition (the codebase's
  // sanctioned pattern, cf. delete-user-dialog.tsx) — clears prior state and
  // resets the comment + date trio to defaults so a re-open starts clean,
  // without a synchronous setState inside an effect
  // (react-hooks/set-state-in-effect).
  const openKey = open ? documentId : null;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (openKey !== openedFor) {
    setOpenedFor(openKey);
    if (open) {
      setLoadingPreview(true);
      setPreview(null);
      setPreviewError(null);
      setPreviewErrorCode(null);
      setCheckedLineIds(new Set());
      setError(null);
      setFieldErrors(null);
      setReversalComment("");
      setReferenceInfo("");
      setEventAt(today());
      setReferenceDate(today());
    }
  }

  // Fetch the preview when open (and on manual reload). The effect body calls
  // no setState synchronously — every write happens after the await.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await getReversalPreviewAction(
          documentId,
          financialAccountId,
        );
        if (cancelled) return;
        if (!result.ok) {
          setPreviewError(describeReversalError(result.code));
          setPreviewErrorCode(result.code);
          return;
        }
        setPreview(result.value);
        // All unreversed lines checked by default (§2.4).
        setCheckedLineIds(
          new Set(
            result.value.lines
              .filter((l) => !l.alreadyReversed)
              .map((l) => l.documentLineId),
          ),
        );
      } catch {
        if (!cancelled) {
          setPreviewError("Could not load preview. Please try again.");
          setPreviewErrorCode(null);
        }
      } finally {
        if (!cancelled) setLoadingPreview(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, documentId, financialAccountId, reloadNonce]);

  function reloadPreview(): void {
    setLoadingPreview(true);
    setPreview(null);
    setPreviewError(null);
    setPreviewErrorCode(null);
    setReloadNonce((n) => n + 1);
  }

  function toggleLine(lineId: string): void {
    setCheckedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  const unreversed = preview?.lines.filter((l) => !l.alreadyReversed) ?? [];
  const checkedUnreversed = unreversed.filter((l) =>
    checkedLineIds.has(l.documentLineId),
  );
  const checkedCount = checkedUnreversed.length;
  const allChecked =
    unreversed.length > 0 && checkedCount === unreversed.length;
  const isStrictSubset = checkedCount > 0 && checkedCount < unreversed.length;

  // Submit is disabled when nothing is checked (§2.4 — reverseLine would return
  // LINE_NOT_FOUND; the UI does not manufacture a call it knows will fail).
  const canSubmit =
    checkedCount > 0 &&
    reversalComment.trim().length > 0 &&
    referenceInfo.trim().length > 0;

  async function handleSubmit(): Promise<void> {
    if (!preview || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    setFieldErrors(null);

    const ids = checkedUnreversed.map((l) => l.documentLineId);
    // Send selectedLineIds ONLY for a strict subset; omit when all are checked
    // so the action routes to reverseDocument (§2.4).
    const selectedLineIds = isStrictSubset ? ids : undefined;

    try {
      const result = await reverseDocumentAction({
        originalDocumentId: preview.documentId,
        financialAccountId,
        selectedLineIds,
        reversalComment,
        eventAt,
        referenceDate,
        referenceInfo,
        lastModified: preview.lastModified,
      });

      if (!result.ok) {
        if (result.code === "VALIDATION_ERROR") {
          setFieldErrors(result.fieldErrors);
        }
        setError(describeReversalError(result.code));
        return;
      }

      // Success: let the server-rendered table/drawer re-read and close.
      router.refresh();
      onOpenChange(false);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reverse {documentId}</DialogTitle>
          <DialogDescription>
            Select the lines to reverse. Reversal posts the opposite ledger legs
            and inherits this document&apos;s approval requirement.
          </DialogDescription>
        </DialogHeader>

        {loadingPreview && (
          <p className="text-body-sm text-muted-foreground">Loading preview…</p>
        )}

        {previewError && (
          <div className="space-y-2">
            <FieldError role="alert">{previewError}</FieldError>
            {previewErrorCode === "CONFLICT" && (
              <Button type="button" variant="outline" onClick={reloadPreview}>
                Reload preview
              </Button>
            )}
          </div>
        )}

        {preview && !loadingPreview && (
          <div className="space-y-4">
            <p className="text-body-sm font-medium text-foreground">
              {preview.docType} {preview.documentId} — {preview.reasonCode} —{" "}
              <span className="font-mono">
                {preview.currency} {preview.totalAmount}
              </span>
            </p>

            {/* ── Line selection (ac21 line rendering, §2.4/§2.7) ───────── */}
            <div className="space-y-1.5">
              {preview.lines.map((line) => {
                const checked = checkedLineIds.has(line.documentLineId);
                return (
                  <label
                    key={line.documentLineId}
                    className={cn(
                      "flex items-start gap-2 rounded-none border border-[color:var(--border-subtle)] p-2 text-body-sm",
                      line.alreadyReversed
                        ? "opacity-60"
                        : "cursor-pointer hover:bg-[color:var(--action-ghost-hover)]",
                    )}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={line.alreadyReversed ? false : checked}
                      disabled={line.alreadyReversed || submitting}
                      onCheckedChange={() => toggleLine(line.documentLineId)}
                      aria-label={`Reverse line ${line.lineNo} ${line.lineKind}`}
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-mono text-muted-foreground">
                          #{line.lineNo}
                        </span>
                        <span className="inline-flex items-center rounded-full bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-neutral-600)] uppercase">
                          {line.lineKind}
                        </span>
                        {line.alreadyReversed && (
                          <span className="inline-flex items-center rounded-full bg-[color:var(--color-danger-50)] px-1.5 py-0.5 text-[10px] font-semibold tracking-wider text-[color:var(--color-danger-700)] uppercase">
                            Already reversed
                          </span>
                        )}
                        <span className="ml-auto">
                          <AmountCell
                            amount={line.amount}
                            currency={preview.currency}
                          />
                        </span>
                      </div>
                      {/* Opposite legs — from the preview, for CHECKED lines
                          only (§2.5). Never computed client-side. */}
                      {checked && !line.alreadyReversed && (
                        <p className="font-mono text-mono text-muted-foreground">
                          <span className="text-destructive">
                            {line.reversalFromAccountName}
                          </span>{" "}
                          →{" "}
                          <span className="text-foreground">
                            {line.reversalToAccountName}
                          </span>
                        </p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>

            {/* ── What this will do (§2.4) ─────────────────────────────── */}
            <p
              className="text-body-sm text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {checkedCount === 0
                ? "Select at least one line to reverse."
                : allChecked
                  ? "Reverses the entire document — it will be marked Reversed."
                  : `Reverses ${checkedCount} of ${unreversed.length} line${unreversed.length === 1 ? "" : "s"} — the document stays Posted with a reduced remainder.`}
            </p>

            {/* Approval weight is inherited and stated, never computed here
                (inv. #21) — the service routes to pending_approval if needed. */}
            <p className="text-body-sm text-muted-foreground">
              The reversal inherits this document&apos;s approval requirement
              and may require manager approval before it posts.
            </p>

            <fieldset disabled={submitting} className="space-y-3">
              <Field>
                <FieldLabel>Reversal Comment</FieldLabel>
                <Input
                  placeholder="Reason for reversal"
                  value={reversalComment}
                  onChange={(e) => setReversalComment(e.target.value)}
                />
                {fieldErrors?.reversalComment?.map((e, i) => (
                  <FieldError key={i}>{e}</FieldError>
                ))}
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>Entry Date</FieldLabel>
                  <Input
                    type="date"
                    value={eventAt}
                    onChange={(e) => setEventAt(e.target.value)}
                  />
                  {fieldErrors?.eventAt?.map((e, i) => (
                    <FieldError key={i}>{e}</FieldError>
                  ))}
                </Field>
                <Field>
                  <FieldLabel>Reference Date</FieldLabel>
                  <Input
                    type="date"
                    value={referenceDate}
                    onChange={(e) => setReferenceDate(e.target.value)}
                  />
                  {fieldErrors?.referenceDate?.map((e, i) => (
                    <FieldError key={i}>{e}</FieldError>
                  ))}
                </Field>
              </div>

              <Field>
                <FieldLabel>Reference Info</FieldLabel>
                <Input
                  value={referenceInfo}
                  onChange={(e) => setReferenceInfo(e.target.value)}
                />
                {fieldErrors?.referenceInfo?.map((e, i) => (
                  <FieldError key={i}>{e}</FieldError>
                ))}
              </Field>

              {error && <FieldError role="alert">{error}</FieldError>}

              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!canSubmit || submitting}
                  onClick={() => void handleSubmit()}
                >
                  {submitting
                    ? "Reversing…"
                    : isStrictSubset
                      ? "Reverse selected lines"
                      : "Reverse document"}
                </Button>
              </div>
            </fieldset>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface ReverseButtonProps {
  documentId: string;
  financialAccountId: string;
  // Row uses "↺ Reverse"; the drawer footer uses "↺ Reverse…".
  label?: string;
  className?: string;
}

// Self-contained trigger + dialog. Both entry points (table row actions column
// and drawer footer, §2.3) render this; there is no context-free entry point.
// stopPropagation keeps a row-level click from also opening the ac21 drawer.
export function ReverseButton({
  documentId,
  financialAccountId,
  label = "↺ Reverse",
  className,
}: ReverseButtonProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Reverse document ${documentId}`}
        className={cn(
          "inline-flex items-center gap-1 rounded-sm px-2 py-1 text-body-sm font-medium text-[color:var(--color-danger-700)] hover:bg-[color:var(--color-danger-50)] focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none",
          className,
        )}
      >
        {label}
      </button>
      <ReversalDialog
        documentId={documentId}
        financialAccountId={financialAccountId}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}
