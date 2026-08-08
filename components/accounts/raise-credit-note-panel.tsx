"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { raiseCreditNoteAction } from "@/actions/accounts/raise-credit-note";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface RaiseCreditNotePanelProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function RaiseCreditNotePanel({
  financialAccountId,
  billingAccountId,
}: RaiseCreditNotePanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId || !billingAccountId;

  const [amount, setAmount] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<
    string,
    string[]
  > | null>(null);

  async function handleSubmit(): Promise<void> {
    if (!financialAccountId || !billingAccountId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);
    setFieldErrors(null);

    try {
      const result = await raiseCreditNoteAction({
        financialAccountId,
        billingAccountId,
        amount,
        eventAt,
        entryDate,
        referenceInfo,
      });

      if (!result.ok) {
        if (result.code === "VALIDATION_ERROR") {
          setFieldErrors(result.fieldErrors);
        }
        setError(describeRaiseCreditNoteError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Raised and posted ${result.value.documentId}.`
          : `Credit note ${result.value.documentId} routed for approval.`,
      );
      setAmount("");
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
        Raise Credit Note
      </h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account and Billing Account in the context strip to
          raise a goodwill credit note.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <Field>
          <FieldLabel>Amount</FieldLabel>
          <Input
            inputMode="decimal"
            placeholder="e.g. 500.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {fieldErrors?.amount?.map((e, i) => (
            <FieldError key={i}>{e}</FieldError>
          ))}
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Reference Date</FieldLabel>
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
            <FieldLabel>Entry Date</FieldLabel>
            <Input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
            />
            {fieldErrors?.entryDate?.map((e, i) => (
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
          disabled={disabled || submitting || !amount || !referenceInfo}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Raising…" : "Raise Credit Note"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeRaiseCreditNoteError(code: string): string {
  switch (code) {
    case "VALIDATION_ERROR":
      return "Some fields are invalid — see details below.";
    case "FORBIDDEN":
      return "You do not have permission to perform this action.";
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found, or does not belong to this Financial Account.";
    case "PERIOD_CLOSED":
      return "The entry date falls in a closed accounting period. Choose a date in an open period.";
    case "UNBALANCED_DOC":
      return "The document did not balance. Please try again.";
    case "CONFLICT":
      return "This document was modified concurrently. Please try again.";
    case "APPROVAL_REQUIRED":
      return "This amount requires manager approval.";
    default:
      return "Something went wrong. Please try again.";
  }
}
