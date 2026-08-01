"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  getReversalPreviewAction,
  reverseDocumentAction,
} from "@/actions/accounts/reverse-document";
import type {
  ReversalPreview,
  ReversalPreviewLine,
} from "@/actions/accounts/reverse-document";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface ReversalsPanelProps {
  financialAccountId: string | undefined;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function describeReversalError(code: string): string {
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

export function ReversalsPanel({
  financialAccountId,
}: ReversalsPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId;

  const [docId, setDocId] = useState("");
  const [preview, setPreview] = useState<ReversalPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(
    new Set(),
  );
  const [reversalComment, setReversalComment] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [referenceDate, setReferenceDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<
    string,
    string[]
  > | null>(null);

  async function handleLoadPreview(): Promise<void> {
    if (!financialAccountId || !docId.trim()) return;
    setLoadingPreview(true);
    setPreviewError(null);
    setPreview(null);
    setSelectedLineIds(new Set());
    setError(null);
    setMessage(null);

    try {
      const result = await getReversalPreviewAction(
        docId.trim(),
        financialAccountId,
      );
      if (!result.ok) {
        setPreviewError(describeReversalError(result.code));
      } else {
        setPreview(result.value);
        // Auto-select all selectable (allocation) unreversed lines.
        const auto = new Set(
          result.value.lines
            .filter((l) => l.isAllocation && !l.alreadyReversed)
            .map((l) => l.documentLineId),
        );
        setSelectedLineIds(auto);
      }
    } catch {
      setPreviewError("Could not load preview. Please try again.");
    } finally {
      setLoadingPreview(false);
    }
  }

  function toggleLine(lineId: string): void {
    setSelectedLineIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  async function handleSubmit(): Promise<void> {
    if (!financialAccountId || !preview) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    setFieldErrors(null);

    const ids = [...selectedLineIds];
    const isLineLevel =
      ids.length > 0 &&
      ids.length < preview.lines.filter((l) => !l.alreadyReversed).length;

    try {
      const result = await reverseDocumentAction({
        originalDocumentId: preview.documentId,
        financialAccountId,
        selectedLineIds: isLineLevel ? ids : undefined,
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

      setMessage(
        result.value.state === "posted"
          ? `Reversal ${result.value.documentId} posted.`
          : `Reversal ${result.value.documentId} routed for approval.`,
      );
      setDocId("");
      setPreview(null);
      setSelectedLineIds(new Set());
      setReversalComment("");
      setReferenceInfo("");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const unreversedLines =
    preview?.lines.filter((l) => !l.alreadyReversed) ?? [];
  const hasAllocationLines = unreversedLines.some((l) => l.isAllocation);
  const canSubmit =
    !!preview &&
    reversalComment.trim().length > 0 &&
    referenceInfo.trim().length > 0 &&
    (!hasAllocationLines || selectedLineIds.size > 0);

  return (
    <section className="space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="text-h4 font-semibold text-foreground">Reversals</h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account in the context strip to reverse a document.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <div className="flex gap-2">
          <Field className="flex-1">
            <FieldLabel>Document ID</FieldLabel>
            <Input
              placeholder="e.g. PAY00000001"
              value={docId}
              onChange={(e) => {
                setDocId(e.target.value);
                setPreview(null);
                setPreviewError(null);
              }}
            />
          </Field>
          <div className="flex items-end">
            <Button
              type="button"
              variant="outline"
              disabled={disabled || !docId.trim() || loadingPreview}
              onClick={() => void handleLoadPreview()}
            >
              {loadingPreview ? "Loading…" : "Load Preview"}
            </Button>
          </div>
        </div>

        {previewError && <FieldError role="alert">{previewError}</FieldError>}

        {preview && (
          <div className="space-y-3 rounded-md border border-[color:var(--border-muted)] p-3">
            <p className="text-body-sm font-medium text-foreground">
              {preview.docType} {preview.documentId} — {preview.reasonCode} —{" "}
              {preview.currency} {preview.totalAmount}
            </p>

            {unreversedLines.length === 0 ? (
              <p className="text-body-sm text-destructive">
                All lines of this document have already been reversed.
              </p>
            ) : (
              <div className="space-y-1">
                <p className="text-body-sm text-muted-foreground">
                  Opposite legs that will post (select allocation lines to
                  reverse individually, or leave all selected for a full
                  document reversal):
                </p>
                {unreversedLines.map((line) => (
                  <PreviewLineRow
                    key={line.documentLineId}
                    line={line}
                    selected={selectedLineIds.has(line.documentLineId)}
                    {...(line.isAllocation
                      ? { onToggle: () => toggleLine(line.documentLineId) }
                      : {})}
                  />
                ))}
                {preview.lines.some((l) => l.alreadyReversed) && (
                  <p className="text-body-sm text-muted-foreground">
                    {preview.lines.filter((l) => l.alreadyReversed).length}{" "}
                    line(s) already reversed — excluded from this reversal.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {preview && unreversedLines.length > 0 && (
          <>
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
            {message && (
              <p
                role="status"
                aria-live="polite"
                className="text-body-sm text-[color:var(--color-success-700)]"
              >
                {message}
              </p>
            )}

            <Button
              type="button"
              disabled={!canSubmit || submitting}
              onClick={() => void handleSubmit()}
            >
              {submitting ? "Reversing…" : "Reverse"}
            </Button>
          </>
        )}
      </fieldset>
    </section>
  );
}

function PreviewLineRow({
  line,
  selected,
  onToggle,
}: {
  line: ReversalPreviewLine;
  selected: boolean;
  onToggle?: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2 rounded-sm p-1 text-body-sm">
      {onToggle ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          className="mt-0.5 shrink-0"
          aria-label={`Reverse ${line.lineKind} line ${line.lineNo}`}
        />
      ) : (
        <span className="mt-0.5 w-4 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <span className="font-medium text-muted-foreground">
          L{line.lineNo} {line.lineKind}
        </span>{" "}
        <span className="font-mono text-foreground">{line.amount}</span>
        {line.reversalFromAccountName && (
          <p className="text-muted-foreground">
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
    </div>
  );
}
