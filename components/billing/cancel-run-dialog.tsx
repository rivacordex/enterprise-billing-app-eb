"use client";

// bm12-spec §Visual/§Implementation §5. `CancelRunDialog` — the spelled-out
// confirm for the Layer-3 escape hatch. Follows the `RerunDialog`/
// `TriggerRunDialog` inline-confirmation shape (trigger → confirm →
// submitting/error → router.refresh() on success). The action re-checks
// `billrun_operate:EDIT` server-side; this is a show/hide affordance only.
// Danger role for the confirm, inside its own confirmation panel only
// (ui-context §7) — the trigger button itself stays a quiet secondary.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";

import { cancelRunAction } from "@/actions/billing/cancel-run.action";
import { Button } from "@/components/ui/button";

export interface CancelRunDialogProps {
  billRunId: string;
}

export function CancelRunDialog({
  billRunId,
}: CancelRunDialogProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmButtonRef.current?.focus();
    } else if (cancelledRef.current) {
      cancelledRef.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming]);

  async function handleCancel(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await cancelRunAction({ billRunId });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      const { accountsReset } = result.value;
      setMessage(
        `Run cancelled — ${accountsReset} account${accountsReset === 1 ? "" : "s"} reset to Pending. ` +
          "No invoice numbers were consumed; the run can be triggered again.",
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
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        <Ban aria-hidden="true" />
        Cancel run
      </Button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm cancelling this bill run"
      className="w-full max-w-xl space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4"
    >
      <p className="text-body-sm text-foreground">
        Cancel this run? The workflow execution is killed, every non-excluded
        account resets to <strong>Pending</strong>, and the run moves to{" "}
        <strong>Cancelled</strong>. No invoice numbers are consumed, and the
        period can be triggered again cleanly.
      </p>

      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          ref={confirmButtonRef}
          type="button"
          variant="destructive"
          disabled={submitting}
          onClick={() => void handleCancel()}
        >
          {submitting ? "Cancelling…" : "Confirm Cancel"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting}
          onClick={() => {
            cancelledRef.current = true;
            setConfirming(false);
            setError(null);
          }}
        >
          Keep running
        </Button>
      </div>
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_CANCELLABLE":
      return "This run can no longer be cancelled — it may have already finished, or been cancelled already.";
    case "FORBIDDEN":
      return "You do not have permission to cancel bill runs.";
    case "VALIDATION_ERROR":
      return "Something went wrong validating this request.";
    default:
      return "Something went wrong. Please try again.";
  }
}
