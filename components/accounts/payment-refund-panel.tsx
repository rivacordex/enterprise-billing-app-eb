"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { refundPaymentAction } from "@/actions/accounts/refund-payment";
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
import type { AssignedItem } from "@/types/accounts";

export interface PaymentRefundPanelProps {
  financialAccountId: string | undefined;
  billingAccountId: string | undefined;
  assignedItems: AssignedItem[];
  unappliedCashAvailable: string;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function PaymentRefundPanel({
  financialAccountId,
  billingAccountId,
  assignedItems,
  unappliedCashAvailable,
}: PaymentRefundPanelProps): React.JSX.Element {
  const router = useRouter();
  const disabled = !financialAccountId || !billingAccountId;

  const [refundType, setRefundType] = useState<"cash" | "convert_to_advance">(
    "cash",
  );
  const [selectedAmounts, setSelectedAmounts] = useState<
    Record<string, string>
  >({});
  const [overpaymentAmount, setOverpaymentAmount] = useState("");
  const [eventAt, setEventAt] = useState(today());
  const [referenceDate, setReferenceDate] = useState(today());
  const [referenceInfo, setReferenceInfo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedCount = Object.keys(selectedAmounts).length;
  const overpaymentEnabled = refundType === "cash";

  const canSubmit = useMemo(() => {
    if (disabled || submitting) return false;
    const hasItems = selectedCount > 0;
    const hasOverpayment =
      overpaymentEnabled && overpaymentAmount.trim() !== "";
    return (hasItems || hasOverpayment) && referenceInfo.trim() !== "";
  }, [
    disabled,
    submitting,
    selectedCount,
    overpaymentEnabled,
    overpaymentAmount,
    referenceInfo,
  ]);

  function toggleItem(lineId: string, defaultAmount: string): void {
    setSelectedAmounts((prev) => {
      const next = { ...prev };
      if (lineId in next) {
        delete next[lineId];
      } else {
        next[lineId] = defaultAmount;
      }
      return next;
    });
  }

  async function handleSubmit(): Promise<void> {
    if (!financialAccountId || !billingAccountId) return;
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const items: {
        allocationLineId: string | null;
        refundedAmount: string;
      }[] = Object.entries(selectedAmounts).map(
        ([allocationLineId, refundedAmount]) => ({
          allocationLineId,
          refundedAmount,
        }),
      );
      if (overpaymentEnabled && overpaymentAmount.trim() !== "") {
        items.push({
          allocationLineId: null,
          refundedAmount: overpaymentAmount,
        });
      }

      const result = await refundPaymentAction({
        financialAccountId,
        billingAccountId,
        refundType,
        items,
        eventAt,
        referenceDate,
        referenceInfo,
      });

      if (!result.ok) {
        setError(describeRefundError(result.code));
        return;
      }

      setMessage(
        result.value.state === "posted"
          ? `Refund ${result.value.documentId} posted.`
          : `Refund ${result.value.documentId} routed for manager approval (always four-eyes).`,
      );
      setSelectedAmounts({});
      setOverpaymentAmount("");
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
      <h3 className="text-h4 font-semibold text-foreground">Payment Refund</h3>
      {disabled && (
        <p className="text-body-sm text-muted-foreground">
          Select a Financial Account and Billing Account in the context strip to
          refund a payment. Refunds always require manager approval.
        </p>
      )}

      {!disabled && (
        <fieldset disabled={submitting} className="space-y-4">
          <Field>
            <FieldLabel>Refund Type</FieldLabel>
            <Select
              value={refundType}
              onValueChange={(v) => setRefundType(v as typeof refundType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Refund Payment (cash)</SelectItem>
                <SelectItem value="convert_to_advance">
                  Convert to Advance Payment
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="space-y-2">
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Assigned Items (payments applied to this BAN)
            </p>
            {assignedItems.length === 0 ? (
              <p className="text-body-sm text-muted-foreground">
                No settled applications for this billing account.
              </p>
            ) : (
              <div
                role="list"
                className="divide-y divide-[color:var(--border-subtle)] overflow-hidden rounded-md border border-[color:var(--border-default)]"
              >
                {assignedItems.map((item) => {
                  const checked = item.allocationLineId in selectedAmounts;
                  return (
                    <div
                      key={item.allocationLineId}
                      role="listitem"
                      className="flex items-center gap-3 px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          toggleItem(item.allocationLineId, item.amount)
                        }
                      />
                      <span className="flex-1 font-mono text-body-sm text-muted-foreground">
                        {item.allocationLineId}
                        {item.refSettledDocumentId
                          ? ` → ${item.refSettledDocumentId}`
                          : ""}
                      </span>
                      <span className="text-body-sm text-muted-foreground">
                        original: {item.amount}
                      </span>
                      <Input
                        className="w-28"
                        inputMode="decimal"
                        disabled={!checked}
                        value={selectedAmounts[item.allocationLineId] ?? ""}
                        onChange={(e) =>
                          setSelectedAmounts((prev) => ({
                            ...prev,
                            [item.allocationLineId]: e.target.value,
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {overpaymentEnabled && (
            <Field>
              <FieldLabel>
                Refund from unapplied cash (available: {unappliedCashAvailable})
              </FieldLabel>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={overpaymentAmount}
                onChange={(e) => setOverpaymentAmount(e.target.value)}
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
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            className="bg-[color:var(--action-primary-bg)] text-white hover:bg-[color:var(--action-primary-bg-hover)]"
          >
            {submitting ? "Submitting…" : "Submit Refund for Approval"}
          </Button>
        </fieldset>
      )}
    </section>
  );
}

function describeRefundError(code: string): string {
  switch (code) {
    case "FINANCIAL_ACCOUNT_NOT_FOUND":
      return "Financial account not found.";
    case "BILLING_ACCOUNT_NOT_FOUND":
      return "Billing account not found, or an item does not belong to this billing account.";
    case "UNSUPPORTED_CURRENCY":
      return "Only MYR is supported.";
    case "NO_ITEMS_SELECTED":
      return "Select at least one item to refund.";
    case "ALLOCATION_LINE_NOT_FOUND":
      return "The selected application was not found.";
    case "ALREADY_REFUNDED":
      return "This application has already been refunded.";
    case "AMOUNT_EXCEEDS_ORIGINAL":
      return "The refunded amount cannot exceed the original applied amount.";
    case "INSUFFICIENT_UNAPPLIED_CASH":
      return "The refund from unapplied cash exceeds what is currently held.";
    case "CONVERT_TO_ADVANCE_REQUIRES_APPLICATION":
      return "Convert to advance requires at least one selected application.";
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
