"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { approveOrderAction } from "@/actions/ordering/approve-order.action";
import { rejectOrderAction } from "@/actions/ordering/reject-order.action";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/formatters";
import type { OrderPriceLine } from "@/types/ordering";

export interface ReviewActionsProps {
  orderId: string;
  // MANAGER role ∧ product_orders:EDIT ∧ not the submitter (resolved server-
  // side and passed down — platform Inv. #3: pm30 enforces regardless, this is
  // UX only). When false the buttons render disabled with `disabledReason` as
  // an explanatory tooltip.
  canReview: boolean;
  disabledReason: string | null;
  // The resolved price lines (pm26 OrderPriceLine[]) so the approve confirmation
  // can restate list vs negotiated for every overridden line.
  prices: OrderPriceLine[];
  locale: string;
}

// pm31-spec §1: "Every pm30 code mapped to a user-readable message." The action
// layer stays a thin typed passthrough (create-order precedent); presentation
// lives here, next to the toast — the module's established pattern. The stale-
// precondition codes get the spec's exact "Cannot approve: <reason>…" copy.
const PRECONDITION_REASON: Record<string, string> = {
  CUSTOMER_NOT_ACTIVE: "the customer is no longer active",
  BILLING_ACCOUNT_CLOSED: "the billing account is closed",
  BILLING_ACCOUNT_MISMATCH:
    "the billing account no longer belongs to this customer",
  OFFERING_NOT_ORDERABLE: "the offering is no longer orderable",
  NO_PRICE_ROWS: "the offering has no active price",
  OVERRIDE_PRICE_TYPE_INVALID: "a negotiated price type is no longer valid",
  OVERRIDE_CURRENCY_MISMATCH:
    "a negotiated price currency no longer matches the billing account",
  BACKDATED_START_TOO_FAR: "the start date is now more than 3 days in the past",
};

function messageForCode(code: string): string {
  if (code in PRECONDITION_REASON) {
    return `Cannot approve: ${PRECONDITION_REASON[code]}. The order remains pending; reject it if no longer valid.`;
  }
  switch (code) {
    case "NOT_MANAGER":
      return "Only a manager can approve or reject orders.";
    case "SELF_REVIEW":
      return "You can't review an order you submitted.";
    case "ORDER_NOT_FOUND":
      return "This order no longer exists. Refreshing…";
    case "ORDER_NOT_PENDING":
      return "This order is no longer pending review. Refreshing…";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "VALIDATION_ERROR":
      return "Please check your input and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// A code that means the panel's data is stale — refresh so the reviewer sees
// the real current state rather than a phantom PENDING order.
function shouldRefreshOnError(code: string): boolean {
  return code === "ORDER_NOT_FOUND" || code === "ORDER_NOT_PENDING";
}

export function ReviewActions({
  orderId,
  canReview,
  disabledReason,
  prices,
  locale,
}: ReviewActionsProps): React.JSX.Element {
  const router = useRouter();
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Only the negotiated lines are worth restating in the approve confirmation
  // (list vs negotiated side by side).
  const overriddenLines = prices.filter((line) => line.overrideAmount !== null);

  function handleApproveOpenChange(next: boolean): void {
    if (isSubmitting) return;
    setApproveOpen(next);
  }

  function handleRejectOpenChange(next: boolean): void {
    if (isSubmitting) return;
    if (next) {
      setReason("");
      setReasonError(null);
    }
    setRejectOpen(next);
  }

  async function handleApprove(): Promise<void> {
    setIsSubmitting(true);
    try {
      const result = await approveOrderAction({ orderId });
      if (result.ok) {
        setApproveOpen(false);
        toast.success("Order approved — subscription created");
        router.refresh();
      } else {
        toast.error(messageForCode(result.code));
        if (shouldRefreshOnError(result.code)) {
          setApproveOpen(false);
          router.refresh();
        }
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleReject(): Promise<void> {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setReasonError("A rejection reason is required");
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await rejectOrderAction({ orderId, reason: trimmed });
      if (result.ok) {
        setRejectOpen(false);
        toast.success("Order rejected");
        router.refresh();
      } else {
        toast.error(messageForCode(result.code));
        if (shouldRefreshOnError(result.code)) {
          setRejectOpen(false);
          router.refresh();
        }
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // Disabled path (platform Inv. #3, UX only): render the reason as visible
  // helper text (not just a `title` on a non-focusable span, which keyboard
  // and assistive-technology users can never reach) and associate it with both
  // buttons via `aria-describedby`. The buttons stay `disabled`; the text is
  // page content every user — sighted, keyboard, or AT — encounters.
  const disabledReasonId = "review-disabled-reason";
  if (!canReview) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            disabled
            aria-describedby={disabledReason ? disabledReasonId : undefined}
            className="bg-[color:var(--action-cta-bg)]"
          >
            Approve
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled
            aria-describedby={disabledReason ? disabledReasonId : undefined}
          >
            Reject
          </Button>
        </div>
        {disabledReason && (
          <p
            id={disabledReasonId}
            className="text-body-sm text-muted-foreground"
          >
            {disabledReason}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Dialog open={approveOpen} onOpenChange={handleApproveOpenChange}>
        <DialogTrigger asChild>
          <Button type="button" className="bg-[color:var(--action-cta-bg)]">
            Approve
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve this order?</DialogTitle>
          </DialogHeader>

          <p className="text-body-sm text-muted-foreground">
            Approving re-validates the order under locks, then creates the
            subscription and completes the order. You are stamped as the
            reviewer.
          </p>

          {overriddenLines.length > 0 && (
            <div className="rounded-md border border-border">
              <table className="w-full border-collapse text-body-sm">
                <thead>
                  <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
                    <th className="px-3 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                      Price
                    </th>
                    <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                      List
                    </th>
                    <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                      Negotiated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overriddenLines.map((line) => (
                    <tr
                      key={line.priceType}
                      className="border-b border-[color:var(--border-subtle)] last:border-0"
                    >
                      <td className="px-3 py-2 text-foreground">
                        {line.priceName}
                      </td>
                      <td className="px-3 py-2 text-right text-muted-foreground tabular-nums line-through">
                        {line.listAmount !== null
                          ? formatCurrency(
                              line.listAmount,
                              line.currency,
                              locale,
                            )
                          : "—"}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-foreground tabular-nums">
                        {line.overrideAmount !== null
                          ? formatCurrency(
                              line.overrideAmount,
                              line.currency,
                              locale,
                            )
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={isSubmitting}
              onClick={() => handleApproveOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={isSubmitting}
              onClick={() => void handleApprove()}
              className="bg-[color:var(--action-cta-bg)]"
            >
              {isSubmitting && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Approve order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={rejectOpen} onOpenChange={handleRejectOpenChange}>
        <AlertDialogTrigger asChild>
          <Button type="button" variant="destructive">
            Reject
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Rejecting is terminal — no subscription is created and the order
              cannot be re-approved. A reason is required.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <Field data-invalid={reasonError ? "true" : undefined}>
            <FieldLabel htmlFor="reject-reason">Reason</FieldLabel>
            <Textarea
              id="reject-reason"
              rows={3}
              maxLength={1000}
              placeholder="Negotiated price not approved by finance"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(null);
              }}
              disabled={isSubmitting}
              aria-invalid={reasonError ? true : undefined}
            />
            {reasonError && <FieldError>{reasonError}</FieldError>}
          </Field>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSubmitting}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={isSubmitting}
              onClick={() => void handleReject()}
            >
              {isSubmitting && (
                <Loader2 size={14} className="mr-1 animate-spin" />
              )}
              Reject order
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
