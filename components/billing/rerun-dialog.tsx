"use client";

// bm08-spec §Visual/§Implementation §4. `RerunDialog` — the inline-confirm
// rerun affordance, wired from the Errors tab ("Rerun these accounts", the
// failed accounts) and a run-level "Rerun" control (all eligible accounts).
// Follows the `TriggerRunDialog` inline-confirmation shape (trigger → preview +
// stage selector + MANDATORY reason → submitting/error → router.refresh() on
// success). The action re-checks `billrun_operate:EDIT` server-side; this is a
// show/hide affordance only.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";

import { rerunRunAction } from "@/actions/billing/rerun-run.action";
import { Button } from "@/components/ui/button";
import {
  RERUN_STAGES,
  type RerunStage,
} from "@/validation/billing/rerun-run.schema";

const STAGE_LABELS: Record<RerunStage, string> = {
  validation: "Validation",
  collection: "Collection",
  aggregation: "Aggregation",
  taxation: "Taxation",
  verification: "Verification",
};

export interface RerunDialogProps {
  billRunId: string;
  // The accounts to rerun. Empty ⇒ "all eligible accounts in the run" (the
  // run-level control); non-empty ⇒ the explicit selection (the Errors tab).
  accountIds: string[];
  triggerLabel?: string;
  variant?: "destructive" | "neutral";
}

export function RerunDialog({
  billRunId,
  accountIds,
  triggerLabel = "Rerun these accounts",
  variant = "destructive",
}: RerunDialogProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [fromStage, setFromStage] = useState<RerunStage>("validation");
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

  const count = accountIds.length;
  const scope =
    count === 0
      ? "all eligible accounts"
      : `${count} account${count === 1 ? "" : "s"}`;

  async function handleRerun(): Promise<void> {
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await rerunRunAction({
        billRunId,
        accountIds,
        fromStage,
        reason,
      });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      const { accountCount, attempt } = result.value;
      setMessage(
        `Rerun started — ${accountCount} account${accountCount === 1 ? "" : "s"} back to processing (attempt ${attempt}). ` +
          "Later stages are recomputed; watch Customers & Bills for the updated totals.",
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
        variant={variant === "destructive" ? "destructive" : "outline"}
        onClick={() => setConfirming(true)}
      >
        <RotateCcw aria-hidden="true" />
        {triggerLabel}
      </Button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm rerun"
      className="w-full max-w-xl space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4"
    >
      <p className="text-body-sm text-foreground">
        Rerun <strong>{scope}</strong> from stage{" "}
        <strong>{STAGE_LABELS[fromStage]}</strong>; later stages are recomputed.
      </p>

      <label className="block space-y-1">
        <span className="text-body-sm font-medium text-foreground">
          Start from stage
        </span>
        <select
          value={fromStage}
          disabled={submitting}
          onChange={(e) => setFromStage(e.target.value as RerunStage)}
          className="block w-full rounded-sm border border-[color:var(--border-default)] bg-[color:var(--surface-card)] px-3 py-1.5 text-body-sm text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
        >
          {RERUN_STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {STAGE_LABELS[stage]}
            </option>
          ))}
        </select>
      </label>

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
          placeholder="Why is this run being rerun?"
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
          onClick={() => void handleRerun()}
        >
          {submitting ? "Starting…" : "Confirm Rerun"}
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
    case "NOT_RERUNNABLE":
      return "This run can no longer be rerun — it may already be approved or still processing.";
    case "NO_ACCOUNTS_SELECTED":
      return "No eligible accounts to rerun for this selection.";
    case "ENGINE_UNREACHABLE":
      return "The processing engine could not be reached. The rerun was not started — you can retry.";
    case "FORBIDDEN":
      return "You do not have permission to rerun bill runs.";
    case "VALIDATION_ERROR":
      return "A reason is required to rerun.";
    default:
      return "Something went wrong. Please try again.";
  }
}
