"use client";

// bm10-spec §Visual/§Implementation §3. `ApproveAndPostPanel` — names the
// final trigger actor, pre-empts self-approval (Approve disabled for that
// actor + a reason, backed by the service check — show/hide only), and
// frames irreversibility with an explicit confirm before the danger-role
// submit. Follows the `TriggerRunDialog`/`RerunDialog` inline-confirmation
// shape (confirm → submitting/error → router.refresh() on success), scaled
// to a full review page rather than a small dialog.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";

import { approveRunAction } from "@/actions/billing/approve-run.action";
import { Button } from "@/components/ui/button";
import { PreApprovalChecks } from "@/components/billing/pre-approval-checks";
import { RunStatusBadge } from "@/components/billing/run-status-badge";
import { formatCalendarDate } from "@/lib/formatters";
import type { ApprovePreview } from "@/services/billing/read/get-approve-preview";

export interface ApproveAndPostPanelProps {
  preview: ApprovePreview;
  triggeredAtDisplay: string;
  totalAmountDisplay: string;
}

export function ApproveAndPostPanel({
  preview,
  triggeredAtDisplay,
  totalAmountDisplay,
}: ApproveAndPostPanelProps): React.JSX.Element {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [checks, setChecks] = useState(preview.checks);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (confirming) {
      confirmButtonRef.current?.focus();
    } else if (cancelledRef.current) {
      cancelledRef.current = false;
      approveButtonRef.current?.focus();
    }
  }, [confirming]);

  const fourEyes = checks.find((c) => c.check === "four_eyes");
  const selfApproveBlocked = !!fourEyes && !fourEyes.pass;
  const notApprovable = preview.status !== "PROCESSED";

  async function handleApprove(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await approveRunAction({ billRunId: preview.billRunId });
      if (!result.ok) {
        if (result.code === "CHECKS_FAILED") {
          // Merge the re-checked failures back into the displayed checklist
          // so a check that changed between page-load and submit (e.g. the
          // period closed in the meantime) is reflected without a reload.
          setChecks((prev) =>
            prev.map(
              (c) => result.checks.find((f) => f.check === c.check) ?? c,
            ),
          );
        }
        setError(describeError(result.code));
        return;
      }
      const { skippedCount } = result.value;
      setMessage(
        `Approved — total ${totalAmountDisplay} stamped` +
          (skippedCount > 0
            ? `, ${skippedCount} account${skippedCount === 1 ? "" : "s"} skipped.`
            : ".") +
          " Posting is a separate step.",
      );
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-h1 font-semibold text-foreground">
            {preview.billRunId}
          </h1>
          <RunStatusBadge status={preview.status} />
        </div>
        <p className="text-body text-muted-foreground">
          {preview.cycleName} · Period {formatCalendarDate(preview.periodStart)}{" "}
          – {formatCalendarDate(preview.periodEnd)}
        </p>
        <p className="text-body-sm text-muted-foreground">
          Final trigger by{" "}
          <strong className="text-foreground">
            {preview.triggeredByName ?? "an unknown user"}
          </strong>{" "}
          at {triggeredAtDisplay}.
        </p>
      </header>

      {notApprovable && (
        <p role="alert" className="text-body-sm text-destructive">
          This run is {preview.status.toLowerCase()} and cannot be approved
          right now.
        </p>
      )}

      <PreApprovalChecks checks={checks} />

      {message ? (
        <p
          role="status"
          aria-live="polite"
          className="text-body-sm font-medium text-[color:var(--color-success-700)]"
        >
          {message}
        </p>
      ) : !confirming ? (
        <div className="space-y-2">
          <Button
            ref={approveButtonRef}
            type="button"
            disabled={notApprovable || selfApproveBlocked}
            onClick={() => setConfirming(true)}
          >
            <ShieldCheck aria-hidden="true" />
            Approve &amp; Post
          </Button>
          {selfApproveBlocked && (
            <p className="text-body-sm text-destructive">
              {fourEyes?.remediation}
            </p>
          )}
        </div>
      ) : (
        <div
          role="alertdialog"
          aria-label="Confirm approve and post"
          className="space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4"
        >
          <p className="text-body-sm text-foreground">
            Post{" "}
            <strong>
              {`${preview.postableCount} invoice${preview.postableCount === 1 ? "" : "s"}`}
            </strong>{" "}
            totalling <strong>{totalAmountDisplay}</strong>. This consumes
            invoice numbers and cannot be undone; corrections require a manual
            credit note.
          </p>
          {preview.skippedCount > 0 && (
            <p className="text-body-sm text-muted-foreground">
              {`${preview.skippedCount} account${preview.skippedCount === 1 ? "" : "s"} will be recorded skipped (no charge, no invoice number consumed).`}
            </p>
          )}
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
              onClick={() => void handleApprove()}
            >
              {submitting ? "Approving…" : "Confirm Approve & Post"}
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
      )}
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_APPROVABLE":
      return "This run can no longer be approved — it may already be approved or still processing.";
    case "FOUR_EYES_VIOLATION":
      return "You triggered the final attempt on this run and cannot also approve it.";
    case "CHECKS_FAILED":
      return "One or more pre-approval checks failed — see the checklist above.";
    case "FORBIDDEN":
      return "You do not have permission to approve bill runs.";
    case "VALIDATION_ERROR":
      return "Invalid request.";
    default:
      return "Something went wrong. Please try again.";
  }
}
