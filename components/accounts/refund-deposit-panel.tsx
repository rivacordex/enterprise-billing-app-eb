"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { refundDepositAction } from "@/actions/accounts/refund-deposit";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface RefundDepositPanelProps {
  financialAccountId: string | undefined;
}

type PayoutMode = "none" | "bank_transfer" | "cheque" | "cash";

const today = (): string => new Date().toISOString().slice(0, 10);

export function RefundDepositPanel({
  financialAccountId,
}: RefundDepositPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId;

  const [amount, setAmount] = useState("");
  const [payoutMode, setPayoutMode] = useState<PayoutMode>("none");
  const [bankRef, setBankRef] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [bank, setBank] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
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
      const modeRef =
        payoutMode === "bank_transfer"
          ? { bankRef }
          : payoutMode === "cheque"
            ? { chequeNo, bank }
            : payoutMode === "cash"
              ? { receiptNo }
              : null;

      const result = await refundDepositAction({
        financialAccountId,
        amount,
        paymentMode: payoutMode === "none" ? null : payoutMode,
        modeRef,
        eventAt,
        entryDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(describeRefundDepositError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Refund ${result.value.documentId} posted.`
          : `Refund ${result.value.documentId} routed for manager approval (always four-eyes).`,
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
      <h3 className="text-h4 font-semibold text-foreground">Refund Deposit</h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account in the context strip to refund the
          refundable deposit balance. Always requires manager approval.
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

        <Field>
          <FieldLabel>Payout Reference (optional)</FieldLabel>
          <Select
            value={payoutMode}
            onValueChange={(v) => setPayoutMode(v as PayoutMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
              <SelectItem value="cheque">Cheque</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {payoutMode === "bank_transfer" && (
          <Field>
            <FieldLabel>Bank Reference</FieldLabel>
            <Input
              value={bankRef}
              onChange={(e) => setBankRef(e.target.value)}
            />
          </Field>
        )}
        {payoutMode === "cheque" && (
          <>
            <Field>
              <FieldLabel>Cheque No.</FieldLabel>
              <Input
                value={chequeNo}
                onChange={(e) => setChequeNo(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Bank</FieldLabel>
              <Input value={bank} onChange={(e) => setBank(e.target.value)} />
            </Field>
          </>
        )}
        {payoutMode === "cash" && (
          <Field>
            <FieldLabel>Receipt No.</FieldLabel>
            <Input
              value={receiptNo}
              onChange={(e) => setReceiptNo(e.target.value)}
            />
          </Field>
        )}

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
          {submitting ? "Submitting…" : "Refund Deposit"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeRefundDepositError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "AMOUNT_EXCEEDS_REFUNDABLE":
      return "The refund amount exceeds the refundable balance.";
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
