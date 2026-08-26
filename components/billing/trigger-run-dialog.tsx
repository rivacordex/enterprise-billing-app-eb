"use client";

// bm03-spec §Visual/§Implementation §7. The Deep-Petrol featured "Run" CTA
// (the one accent action per screen, ui-context §7) plus its confirm dialog —
// follows the close-period-button.tsx inline-confirmation shape (confirm →
// submitting/error states → router.refresh() on success).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";

import { triggerRunAction } from "@/actions/billing/trigger-run.action";
import { formatCalendarDate } from "@/lib/formatters";

export interface TriggerRunDialogProps {
  billRunId: string;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
}

export function TriggerRunDialog({
  billRunId,
  cycleName,
  periodStart,
  periodEnd,
}: TriggerRunDialogProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmButtonRef.current?.focus();
    } else if (cancelledRef.current) {
      // Return focus to the Run button after cancelling the confirmation,
      // so keyboard/AT focus is not dropped to <body> when Cancel unmounts.
      cancelledRef.current = false;
      runButtonRef.current?.focus();
    }
  }, [confirming]);

  async function handleTrigger(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await triggerRunAction({ billRunId });
      if (!result.ok) {
        // Stay in the confirmation panel so the inline error stays visible —
        // the plain "Run" button branch renders no error region.
        setError(describeError(result.code));
        return;
      }
      const { banCount, excludedCount } = result.value;
      setMessage(
        `Run started — ${banCount} account${banCount === 1 ? "" : "s"} queued` +
          (excludedCount > 0
            ? `, ${excludedCount} excluded (partial period).`
            : "."),
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
        ref={runButtonRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--billrun-cta-bg)] px-4 py-2 text-body-sm font-semibold text-[color:var(--billrun-cta-text)] hover:bg-[color:var(--billrun-cta-bg-hover)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] active:bg-[color:var(--billrun-cta-bg-active)]"
      >
        <Play size={14} aria-hidden="true" />
        Run
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label={`Confirm running ${cycleName}`}
      className="flex flex-wrap items-center gap-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-3"
    >
      <p className="text-body-sm text-foreground">
        Run <strong>{cycleName}</strong> for {formatCalendarDate(periodStart)}–
        {formatCalendarDate(periodEnd)}? This snapshots the cycle&apos;s
        eligible accounts and starts processing.
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
        onClick={() => void handleTrigger()}
        className="rounded-sm bg-[color:var(--action-primary-bg)] px-3 py-1.5 text-body-sm font-medium text-[color:var(--text-on-brand)] hover:bg-[color:var(--action-primary-bg-hover)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
      >
        {submitting ? "Starting…" : "Confirm Run"}
      </button>
      <button
        type="button"
        disabled={submitting}
        onClick={() => {
          cancelledRef.current = true;
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

function describeError(code: string): string {
  switch (code) {
    case "NOT_OPERABLE":
      return "This run can no longer be triggered — it may already be processing.";
    case "NO_ELIGIBLE_ACCOUNTS":
      return "No eligible accounts were found for this period.";
    case "PERIOD_CLOSED":
      return "The accounting period for this run has closed, so it can no longer be re-run.";
    case "ENGINE_UNREACHABLE":
      return "The processing engine could not be reached. The run was not started — you can retry.";
    case "FORBIDDEN":
      return "You do not have permission to run bill runs.";
    default:
      return "Something went wrong. Please try again.";
  }
}
