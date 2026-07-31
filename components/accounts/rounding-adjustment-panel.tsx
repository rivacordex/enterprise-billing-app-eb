"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { roundingAdjustmentAction } from "@/actions/accounts/rounding-adjustment";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface RoundingAdjustmentPanelProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
}

const today = (): string => new Date().toISOString().slice(0, 10);

export function RoundingAdjustmentPanel({
  financialAccountId,
  billingAccountId,
}: RoundingAdjustmentPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId || !billingAccountId;

  const [amount, setAmount] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [referenceDate, setReferenceDate] = useState(today());
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
      const result = await roundingAdjustmentAction({
        financialAccountId,
        billingAccountId,
        amount,
        eventAt,
        referenceDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(describeRoundingAdjustmentError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Rounding adjustment ${result.value.documentId} posted.`
          : `Rounding adjustment ${result.value.documentId} routed for manager approval.`,
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
        Rounding Adjustment
      </h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account and Billing Account in the context strip to
          clear a small A/R residue. Direction follows the residue&apos;s sign
          automatically.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <Field>
          <FieldLabel>Amount</FieldLabel>
          <Input
            inputMode="decimal"
            placeholder="e.g. 0.05"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel>Entry Date</FieldLabel>
            <Input
              type="date"
              value={eventAt}
              onChange={(e) => setEventAt(e.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel>Reference Date</FieldLabel>
            <Input
              type="date"
              value={referenceDate}
              onChange={(e) => setReferenceDate(e.target.value)}
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
          disabled={disabled || submitting || !amount || !referenceInfo}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Submitting…" : "Clear Residue"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeRoundingAdjustmentError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found, or does not belong to this Financial Account.";
    case "NO_RESIDUE_TO_CLEAR":
      return "This billing account has no open A/R residue to clear.";
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
