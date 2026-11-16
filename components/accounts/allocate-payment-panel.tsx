"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { allocatePaymentAction } from "@/actions/accounts/allocate-payment";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface AllocatePaymentPanelProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AllocatePaymentPanel({
  financialAccountId,
  billingAccountId,
}: AllocatePaymentPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId || !billingAccountId;

  const [amount, setAmount] = useState("");
  const [refSettledDocumentId, setRefSettledDocumentId] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (!financialAccountId || !billingAccountId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const result = await allocatePaymentAction({
        financialAccountId,
        billingAccountId,
        amount,
        refSettledDocumentId: refSettledDocumentId.trim(),
        eventAt,
        entryDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(
          result.code === "VALIDATION_ERROR"
            ? describeValidationError(result.fieldErrors)
            : describeAllocateError(result.code),
        );
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Allocated and posted ${result.value.documentId}.`
          : `Allocation ${result.value.documentId} routed for approval.`,
      );
      setAmount("");
      setRefSettledDocumentId("");
      setReferenceInfo("");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4">
      <h3 className="text-h4 font-semibold text-foreground">
        Allocate Payment
      </h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account and Billing Account in the context strip to
          allocate unapplied cash.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <Field>
          <FieldLabel>Amount</FieldLabel>
          <Input
            inputMode="decimal"
            placeholder="e.g. 5400.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field>
          <FieldLabel>Settled Document (Invoice / Debit Note ID)</FieldLabel>
          <Input
            required
            placeholder="e.g. INV00000042 or DBN00000042"
            value={refSettledDocumentId}
            onChange={(e) => setRefSettledDocumentId(e.target.value)}
          />
          <p className="text-body-sm text-muted-foreground">
            Required — the document this payment amount settles.
          </p>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Reference Date</FieldLabel>
            <Input
              type="date"
              value={eventAt}
              onChange={(e) => setEventAt(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Entry Date</FieldLabel>
            <Input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
          </Field>
        </div>

        <Field>
          <FieldLabel>Reference Info</FieldLabel>
          <Input
            value={referenceInfo}
            onChange={(e) => setReferenceInfo(e.target.value)}
          />
        </Field>

        {error && <FieldError>{error}</FieldError>}
        {message && (
          <p className="text-body-sm text-[color:var(--color-success-700)]">
            {message}
          </p>
        )}

        <Button
          type="button"
          disabled={
            disabled ||
            submitting ||
            !amount ||
            !refSettledDocumentId.trim() ||
            !referenceInfo
          }
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Allocating…" : "Allocate Payment"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeValidationError(
  fieldErrors: Record<string, string[]>,
): string {
  if (fieldErrors.refSettledDocumentId) {
    return "Enter the ID of the invoice or debit note this payment settles (e.g. INV00000042).";
  }
  if (fieldErrors.amount) {
    return "Enter a valid amount with at most 2 decimal places.";
  }
  return "Please check the form and try again.";
}

function describeAllocateError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found, or does not belong to this Financial Account.";
    case "SETTLED_DOCUMENT_NOT_FOUND":
      return "Settled document not found on this Billing Account. Check the invoice or debit note ID.";
    case "PERIOD_CLOSED":
      return "The entry date falls in a closed accounting period. Choose a date in an open period.";
    case "UNBALANCED_DOC":
      return "The document did not balance. Please try again.";
    case "CONFLICT":
      return "This document was modified concurrently. Please try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
