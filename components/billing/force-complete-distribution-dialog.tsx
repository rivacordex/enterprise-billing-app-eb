"use client";

// bm20-spec §Phase-2 review folds T11/D-T1 — the force-complete/abandon
// escape hatch. D-T1's control hierarchy: a quiet, LOW-EMPHASIS secondary
// trigger (never a peer button to "Rerun distribution") that opens a
// spelled-out danger-role confirm — mandatory reason, lists the abandoned
// artifacts, states the GL/abandonment consequence — mirroring the Reject
// dialog's shape (`reject-dialog.tsx`).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertOctagon } from "lucide-react";

import { forceCompleteDistributionAction } from "@/actions/billing/force-complete-distribution.action";
import { Button } from "@/components/ui/button";
import type { DistributionRow } from "@/types/billing";

export interface ForceCompleteDistributionDialogProps {
  billRunId: string;
  failedArtifactRefs: string[];
}

export function ForceCompleteDistributionDialog({
  billRunId,
  failedArtifactRefs,
}: ForceCompleteDistributionDialogProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      reasonRef.current?.focus();
    } else if (cancelledRef.current) {
      cancelledRef.current = false;
      triggerRef.current?.focus();
    }
  }, [confirming]);

  async function handleForceComplete(): Promise<void> {
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await forceCompleteDistributionAction({
        billRunId,
        reason,
      });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      setMessage(
        "Run force-completed. The GL period is now closed; undelivered artifacts are recorded as abandoned.",
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
        ref={triggerRef}
        type="button"
        onClick={() => setConfirming(true)}
        className="text-body-sm font-medium text-muted-foreground underline-offset-2 hover:text-destructive hover:underline"
      >
        Force-complete / abandon
      </button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm force-completing this bill run"
      className="w-full max-w-xl space-y-3 rounded-md border border-[color:var(--color-danger-500)] bg-[color:var(--surface-card)] p-4"
    >
      <div className="flex items-start gap-2">
        <AlertOctagon
          className="mt-0.5 shrink-0 text-[color:var(--color-danger-500)]"
          size={18}
          aria-hidden="true"
        />
        <p className="text-body-sm text-foreground">
          This abandons{" "}
          <strong>
            {failedArtifactRefs.length} undelivered artifact
            {failedArtifactRefs.length === 1 ? "" : "s"}
          </strong>{" "}
          ({failedArtifactRefs.join(", ")}) and moves this run straight to{" "}
          <strong>Completed</strong> — the GL period will close and those
          artifacts are marked abandoned, never retried again. Posted invoices
          are never touched.
        </p>
      </div>

      <label className="block space-y-1">
        <span className="text-body-sm font-medium text-foreground">
          Reason <span className="text-destructive">*</span>
        </span>
        <textarea
          ref={reasonRef}
          value={reason}
          disabled={submitting}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          required
          aria-required="true"
          maxLength={2000}
          placeholder="Why is delivery being abandoned?"
          className="block w-full rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-1.5 text-body-sm text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        />
      </label>

      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="destructive"
          disabled={submitting || reason.trim().length === 0}
          onClick={() => void handleForceComplete()}
        >
          {submitting ? "Force-completing…" : "Confirm force-complete"}
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
          Cancel
        </Button>
      </div>
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_ABANDONABLE":
      return "This run can no longer be force-completed — it may have already resolved.";
    case "FORBIDDEN":
      return "You do not have permission to force-complete distribution.";
    case "VALIDATION_ERROR":
      return "Enter a valid reason (1–2,000 characters).";
    default:
      return "Something went wrong. Please try again.";
  }
}

// Convenience — derives the failed artifact refs of the delivery log's
// CURRENT round (the highest recorded `distributionAttempt` — the log spans
// every round, including a superseded prior one after a rerun) so the
// run-detail page needn't re-derive this filter itself.
export function failedArtifactRefsFromRows(rows: DistributionRow[]): string[] {
  if (rows.length === 0) return [];
  const currentAttempt = Math.max(...rows.map((r) => r.distributionAttempt));
  return rows
    .filter((r) => r.distributionAttempt === currentAttempt && r.outcome === "FAILED")
    .map((r) => r.artifactRef);
}
