"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { capturePaymentAction } from "@/actions/accounts/capture-payment";
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

export interface CapturePaymentPanelProps {
  financialAccountId: string | undefined;
}

type PaymentMode = "bank_transfer" | "cheque" | "cash";

const today = (): string => new Date().toISOString().slice(0, 10);

export function CapturePaymentPanel({
  financialAccountId,
}: CapturePaymentPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId;

  const [reasonCode, setReasonCode] = useState<
    "CUST_PAYMENT" | "ADVANCE_PAYMENT"
  >("CUST_PAYMENT");
  const [amount, setAmount] = useState("");
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("bank_transfer");
  const [bankRef, setBankRef] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [bank, setBank] = useState("");
  const [receiptNo, setReceiptNo] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [referenceDate, setReferenceDate] = useState(today());
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
        paymentMode === "bank_transfer"
          ? { bankRef }
          : paymentMode === "cheque"
            ? { chequeNo, bank }
            : { receiptNo };

      const result = await capturePaymentAction({
        financialAccountId,
        reasonCode,
        amount,
        payment_mode: paymentMode,
        mode_ref: modeRef,
        eventAt,
        referenceDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(describeCaptureError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Captured and posted ${result.value.documentId}.`
          : `Captured ${result.value.documentId} — routed for approval.`,
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
      <h3 className="text-h4 font-semibold text-foreground">Capture Payment</h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account in the context strip to capture a payment.
        </p>
      )}

      <fieldset disabled={disabled || submitting} className="space-y-3">
        <Field>
          <FieldLabel>Reason</FieldLabel>
          <Select
            value={reasonCode}
            onValueChange={(v) => setReasonCode(v as typeof reasonCode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="CUST_PAYMENT">Customer Payment</SelectItem>
              <SelectItem value="ADVANCE_PAYMENT">Advance Payment</SelectItem>
            </SelectContent>
          </Select>
        </Field>

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
          <FieldLabel>Payment Mode</FieldLabel>
          <Select
            value={paymentMode}
            onValueChange={(v) => setPaymentMode(v as PaymentMode)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
              <SelectItem value="cheque">Cheque</SelectItem>
              <SelectItem value="cash">Cash</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        {paymentMode === "bank_transfer" && (
          <Field>
            <FieldLabel>Bank Reference</FieldLabel>
            <Input
              value={bankRef}
              onChange={(e) => setBankRef(e.target.value)}
            />
          </Field>
        )}
        {paymentMode === "cheque" && (
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
        {paymentMode === "cash" && (
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
          {submitting ? "Capturing…" : "Capture Payment"}
        </Button>
      </fieldset>
    </section>
  );
}

function describeCaptureError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
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
