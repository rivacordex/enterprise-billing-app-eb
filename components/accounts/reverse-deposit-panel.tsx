"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { reverseDepositAction } from "@/actions/accounts/reverse-deposit";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export interface ReverseDepositPanelProps {
  financialAccountId: string | undefined;
}

// Local calendar date (not UTC) so the default matches the operator's day —
// same helper as rounding-adjustment-panel.tsx.
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ReverseDepositPanel({
  financialAccountId,
}: ReverseDepositPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId;

  const [amount, setAmount] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [entryDate, setEntryDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(): Promise<void> {
    if (!financialAccountId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const result = await reverseDepositAction({
        financialAccountId,
        amount,
        eventAt,
        entryDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(describeReverseDepositError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Reversal ${result.value.documentId} posted.`
          : `Reversal ${result.value.documentId} routed for manager approval (always four-eyes).`,
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
        Reverse Deposit to Account
      </h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account in the context strip to release a held
          deposit into unapplied cash. Always requires manager approval.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <Field>
          <FieldLabel>Amount</FieldLabel>
          <Input
            inputMode="decimal"
            placeholder="e.g. 10000.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
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
          disabled={disabled || submitting || !amount || !referenceInfo}
          onClick={() => void handleSubmit()}
        >
          {submitting ? "Submitting…" : "Reverse to Account"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeReverseDepositError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "AMOUNT_EXCEEDS_HELD_DEPOSIT":
      return "The reversal amount exceeds the currently held deposit.";
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
