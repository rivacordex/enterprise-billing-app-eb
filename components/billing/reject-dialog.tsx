"use client";

// bm17-spec §Design "Confirmation modals" / §Implementation §5. `RejectDialog`
// — the reject affordance, wired from the run-detail header, the Approve &
// Post page, and the Errors tab's rejected-pending accounts. Follows the
// `RerunDialog` inline-confirmation shape AND its `accountIds` convention
// (empty ⇒ "whole run", non-empty ⇒ the explicit selection) rather than a
// separate scope radio control — a resolved ambiguity: the spec's "scope
// radios (whole run / selected)" literally says to reuse the RerunDialog
// selection pattern, and RerunDialog expresses that scope purely through the
// `accountIds` prop, never a radio group. The action re-checks
// `billrun_approve:EDIT` server-side; this is a show/hide affordance only.
// The confirm is spelled-out and in the danger role so a stray click never
// commits (spec: "both Approve and Reject require an explicit, distinct
// confirm").

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";

import { rejectRunAction } from "@/actions/billing/reject-run.action";
import { Button } from "@/components/ui/button";

export interface RejectDialogProps {
  billRunId: string;
  // The accounts to reject. Empty ⇒ "whole run" (every postable account);
  // non-empty ⇒ the explicit selection (mirrors RerunDialog).
  accountIds: string[];
  triggerLabel?: string;
  variant?: "destructive" | "neutral";
}

export function RejectDialog({
  billRunId,
  accountIds,
  triggerLabel = "Reject",
  variant = "destructive",
}: RejectDialogProps): React.JSX.Element {
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

  const count = accountIds.length;
  const scope =
    count === 0 ? "the whole run" : `${count} account${count === 1 ? "" : "s"}`;

  async function handleReject(): Promise<void> {
    if (reason.trim().length === 0) {
      setError("A reason is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await rejectRunAction({
        billRunId,
        scope: count === 0 ? "all" : "selected",
        banIds: accountIds,
        reason,
      });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
      const { accountCount } = result.value;
      setMessage(
        `Rejected — ${accountCount} account${accountCount === 1 ? "" : "s"} sent back to reprocess. ` +
          "An operator must rerun them before this run can be approved.",
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
        <Ban aria-hidden="true" />
        {triggerLabel}
      </Button>
    );
  }

  return (
    <div
      role="alertdialog"
      aria-label="Confirm reject"
      className="w-full max-w-xl space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4"
    >
      <p className="text-body-sm text-foreground">
        Reject <strong>{scope}</strong> and send{" "}
        {count === 1 ? "it" : "them"} back to reprocess. Their draft bills are
        discarded; an operator must rerun them before this run can be
        approved.
      </p>

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
          placeholder="Why is this being rejected?"
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
          onClick={() => void handleReject()}
        >
          {submitting ? "Rejecting…" : "Confirm Reject"}
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
    case "NOT_REJECTABLE":
      return "This run can no longer be rejected — it may already be approved or still processing.";
    case "NO_ACCOUNTS_SELECTED":
      return "No eligible (postable) accounts to reject for this selection.";
    case "FORBIDDEN":
      return "You do not have permission to reject bill runs.";
    case "VALIDATION_ERROR":
      return "A reason is required to reject.";
    default:
      return "Something went wrong. Please try again.";
  }
}
