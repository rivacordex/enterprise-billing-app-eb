"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

import { closePeriodAction } from "@/actions/accounts/close-period.action";
import type { ClosePeriodActionResult } from "@/actions/accounts/close-period.action";

export interface ClosePeriodButtonProps {
  period: string;
  currency: string;
  periodLabel: string;
}

// ac14-spec §3.7 — close-period button with inline confirmation step.
// Requires accounts_config:EDIT (enforced server-side in the action).
export function ClosePeriodButton({
  period,
  currency,
  periodLabel,
}: ClosePeriodButtonProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming) confirmButtonRef.current?.focus();
  }, [confirming]);

  async function handleClose(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await closePeriodAction({ period, currency });
      if (!result.ok) {
        setError(describeError(result, periodLabel));
        setConfirming(false);
        return;
      }
      setMessage(
        `${periodLabel} has been closed. No further postings will be accepted.`,
      );
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (message) {
    return (
      <p
        role="status"
        aria-live="polite"
        className="text-body-sm font-medium text-[color:var(--color-success-700)]"
      >
        {message}
      </p>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-1.5 text-body-sm font-medium text-foreground hover:bg-[color:var(--surface-sunken)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
      >
        Close Period
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Confirm closing ${periodLabel}`}
      className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-3"
    >
      <p className="text-body-sm text-foreground">
        Close <strong>{periodLabel}</strong> for {currency}? This cannot be
        undone.
      </p>
      {error && (
        <p role="alert" className="w-full text-body-sm text-destructive">
          {error}
        </p>
      )}
      <button
        ref={confirmButtonRef}
        type="button"
        disabled={submitting}
        onClick={() => void handleClose()}
        className="rounded-sm bg-destructive px-3 py-1.5 text-body-sm font-medium text-destructive-foreground hover:opacity-90 focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
      >
        {submitting ? "Closing…" : "Confirm Close"}
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
        className="rounded-sm border border-[color:var(--border-default)] px-3 py-1.5 text-body-sm font-medium text-foreground hover:bg-[color:var(--surface-sunken)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  );
}

// bm09-spec §Implementation §4 — BILL_RUN_IN_PROGRESS surfaces the blocking
// bill_run count against the period being closed.
function describeError(
  result: Exclude<ClosePeriodActionResult, { ok: true }>,
  periodLabel: string,
): string {
  switch (result.code) {
    case "ALREADY_CLOSED":
      return "This period is already closed.";
    case "FORBIDDEN":
      return "You do not have permission to close periods.";
    case "BILL_RUN_IN_PROGRESS":
      return `${result.activeRunIds.length} bill run(s) still posting into ${periodLabel}.`;
    default:
      return "Something went wrong. Please try again.";
  }
}
