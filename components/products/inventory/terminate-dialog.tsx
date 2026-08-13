"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { terminateSubscriptionAction } from "@/actions/inventory/terminate-subscription.action";
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

function messageForCode(code: string): string {
  switch (code) {
    case "SUBSCRIPTION_NOT_FOUND":
      return "This subscription no longer exists. Refreshing…";
    case "INVALID_TRANSITION":
      return "Subscription is no longer active — refresh and retry";
    case "END_BEFORE_START":
      return "End date must be on or after the subscription's start date.";
    case "BACKDATED_EFFECTIVE_TOO_FAR":
      return `End date cannot be more than ${BACKDATING_TOLERANCE_DAYS} days in the past.`;
    case "EFFECTIVE_DATE_BEFORE_PRIOR":
      return "End date must be on or after the last status change.";
    case "FORBIDDEN":
      return "You don't have permission to do that.";
    case "VALIDATION_ERROR":
      return "Please check your input and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}

export interface TerminateDialogProps {
  trigger: React.ReactNode;
  inventoryId: string;
}

// pm33-spec §Implementation-2. Terminate is an AlertDialog (danger,
// terminal-action copy — retire-offering-dialog.tsx precedent):
// "Terminating ends billing after <end date>. This cannot be undone." End
// date (default today; same ≤3-day-warning/>3-day-error split as the other
// dialogs) + a required reason.
export function TerminateDialog({
  trigger,
  inventoryId,
}: TerminateDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [endDate, setEndDate] = useState(todayLocalDate());
  const [reason, setReason] = useState("");
  const [dateError, setDateError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nowMs] = useState(() => Date.now());

  function handleOpenChange(next: boolean): void {
    if (isSubmitting) return;
    if (next) {
      setEndDate(todayLocalDate());
      setReason("");
      setDateError(null);
      setReasonError(null);
    }
    setOpen(next);
  }

  const backdatedWarning = (() => {
    const start = new Date(`${endDate}T00:00:00`);
    if (Number.isNaN(start.getTime())) return null;
    const msSince = nowMs - start.getTime();
    if (msSince > 0 && msSince <= BACKDATING_TOLERANCE_DAYS * MS_PER_DAY) {
      return `This is backdated to ${endDate}; historical bills may be affected.`;
    }
    return null;
  })();

  async function handleConfirm(): Promise<void> {
    const dateResult = inclusiveBilledDateSchema.safeParse(endDate);
    const trimmedReason = reason.trim();
    let hasError = false;

    if (!dateResult.success) {
      setDateError(dateResult.error.issues[0]?.message ?? "Invalid date");
      hasError = true;
    } else {
      setDateError(null);
    }
    if (trimmedReason.length === 0) {
      setReasonError("A termination reason is required");
      hasError = true;
    } else {
      setReasonError(null);
    }
    if (hasError) return;

    setIsSubmitting(true);
    try {
      const result = await terminateSubscriptionAction({
        inventoryId,
        endDate,
        reason: trimmedReason,
      });
      if (result.ok) {
        setOpen(false);
        toast.success("Subscription terminated");
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
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Terminate subscription</AlertDialogTitle>
          <AlertDialogDescription>
            Terminating ends billing after {endDate}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <Field data-invalid={dateError ? "true" : undefined}>
          <FieldLabel htmlFor={`terminate-date-${inventoryId}`}>
            End date
          </FieldLabel>
          <Input
            id={`terminate-date-${inventoryId}`}
            type="date"
            value={endDate}
            onChange={(e) => {
              setEndDate(e.target.value);
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
          <FieldLabel htmlFor={`terminate-reason-${inventoryId}`}>
            Reason
          </FieldLabel>
          <Textarea
            id={`terminate-reason-${inventoryId}`}
            rows={3}
            maxLength={1000}
            placeholder="Customer cancelled service"
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
          <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={isSubmitting}
            onClick={() => void handleConfirm()}
          >
            {isSubmitting && (
              <Loader2 size={14} className="mr-1 animate-spin" />
            )}
            Terminate subscription
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
