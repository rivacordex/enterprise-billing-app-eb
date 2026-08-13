"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { suspendSubscriptionAction } from "@/actions/inventory/suspend-subscription.action";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  BACKDATING_TOLERANCE_DAYS,
  inclusiveBilledDateSchema,
} from "@/validation/backdating-tolerance";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function todayLocalDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// pm33-spec §3 — every pm32 LifecycleErrorCode mapped to a user-readable
// message (review-actions.tsx precedent). INVALID_TRANSITION gets the spec's
// exact "Subscription is no longer <status> — refresh and retry" copy.
function messageForCode(code: string): string {
  switch (code) {
    case "SUBSCRIPTION_NOT_FOUND":
      return "This subscription no longer exists. Refreshing…";
    case "INVALID_TRANSITION":
      return "Subscription is no longer active — refresh and retry";
    case "BACKDATED_EFFECTIVE_TOO_FAR":
      return `Effective date cannot be more than ${BACKDATING_TOLERANCE_DAYS} days in the past.`;
    case "EFFECTIVE_DATE_BEFORE_PRIOR":
      return "Effective date must be on or after the last status change.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "VALIDATION_ERROR":
      return "Please check your input and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export interface SuspendDialogProps {
  trigger: React.ReactNode;
  inventoryId: string;
}

// pm33-spec §Implementation-2. Effective-date (default today; ≤3-day
// backdate warning banner, >3 days field error — catalog copy pattern,
// price-form.tsx precedent) + a required reason. Plain useState form, not
// react-hook-form (retire-offering-dialog.tsx's "single-field schemas don't
// earn that weight" call, extended here to this dialog's two fields).
export function SuspendDialog({
  trigger,
  inventoryId,
}: SuspendDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [effectiveDate, setEffectiveDate] = useState(todayLocalDate());
  const [reason, setReason] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nowMs] = useState(() => Date.now());

  function handleOpenChange(next: boolean): void {
    if (isSubmitting) return;
    if (next) {
      setEffectiveDate(todayLocalDate());
      setReason("");
      setDateError(null);
      setReasonError(null);
    }
    setOpen(next);
  }

  const backdatedWarning = (() => {
    const start = new Date(`${effectiveDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const msSince = nowMs - start.getTime();
    if (msSince > 0 && msSince <= BACKDATING_TOLERANCE_DAYS * MS_PER_DAY) {
      return `This is backdated to ${effectiveDate}; historical bills may be affected.`;
    }
    return null;
  })();

  async function handleConfirm(): Promise<void> {
    const dateResult = inclusiveBilledDateSchema.safeParse(effectiveDate);
    const trimmedReason = reason.trim();
    let hasError = false;

    if (!dateResult.success) {
      setDateError(dateResult.error.issues[0]?.message ?? "Invalid date");
      hasError = true;
    } else {
      setDateError(null);
    }
    if (trimmedReason.length === 0) {
      setReasonError("A suspension reason is required");
      hasError = true;
    } else {
      setReasonError(null);
    }
    if (hasError) return;

    setIsSubmitting(true);
    try {
      const result = await suspendSubscriptionAction({
        inventoryId,
        effectiveDate,
        reason: trimmedReason,
      });
      if (result.ok) {
        setOpen(false);
        toast.success("Subscription suspended");
        router.refresh();
      } else {
        toast.error(messageForCode(result.code));
        if (
          result.code === "SUBSCRIPTION_NOT_FOUND" ||
          result.code === "INVALID_TRANSITION"
        ) {
          setOpen(false);
          router.refresh();
        }
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Suspend subscription</DialogTitle>
        </DialogHeader>

        <Field data-invalid={dateError ? "true" : undefined}>
          <FieldLabel htmlFor={`suspend-date-${inventoryId}`}>
            Effective date
          </FieldLabel>
          <Input
            id={`suspend-date-${inventoryId}`}
            type="date"
            value={effectiveDate}
            onChange={(e) => {
              setEffectiveDate(e.target.value);
              if (dateError) setDateError(null);
            }}
            disabled={isSubmitting}
            aria-invalid={dateError ? true : undefined}
          />
          {dateError && <FieldError>{dateError}</FieldError>}
          {backdatedWarning && !dateError && (
            <div className="rounded-[var(--radius)] bg-[color:var(--bg-warning)] px-3 py-2 text-body-sm text-[color:var(--text-warning)]">
              {backdatedWarning}
            </div>
          )}
        </Field>

        <Field data-invalid={reasonError ? "true" : undefined}>
          <FieldLabel htmlFor={`suspend-reason-${inventoryId}`}>
            Reason
          </FieldLabel>
          <Textarea
            id={`suspend-reason-${inventoryId}`}
            rows={3}
            maxLength={1000}
            placeholder="Customer requested a temporary hold"
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

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting && (
              <Loader2 size={14} className="mr-1 animate-spin" />
            )}
            Suspend
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
