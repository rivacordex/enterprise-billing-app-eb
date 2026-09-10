"use client";

// bm11-spec §Visual. `PostingProgressView` — a full-page resumable view
// (per-account status, a running "{n}/{N} posted" count, Retry-failed).
// Reached from the Approve & Post confirm (the approve page re-renders here
// once the run is `APPROVED`) or the `APPROVED`/`POSTING` run's Post
// affordance on the detail page. Not a global spinner — posting is an
// explicit, confirmable click (same discipline as every other operator
// mutation in this module), never auto-fired on page load.

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileCheck, RotateCcw } from "lucide-react";
import { cva } from "class-variance-authority";

import { postRunAction } from "@/actions/billing/post-run.action";
import { retryRenderInvoiceAction } from "@/actions/billing/retry-render-invoice.action";
import { Button } from "@/components/ui/button";
import { StoredInvoiceModal } from "@/components/billing/invoice-preview-modal";
import { cn } from "@/lib/utils";
import { formatCalendarDate } from "@/lib/formatters";
import type { PostingAccountStatus, PostingProgress } from "@/types/billing";

const statusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        pending:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-muted)]",
        invoiced:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        PERIOD_CLOSED:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        failed:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
      } satisfies Record<PostingAccountStatus, string>,
    },
  },
);

const STATUS_LABEL: Record<PostingAccountStatus, string> = {
  pending: "Pending",
  invoiced: "Invoiced",
  PERIOD_CLOSED: "Period closed",
  failed: "Failed",
};

export interface PostingProgressViewProps {
  progress: PostingProgress;
  cycleName: string;
  periodStart: string;
  periodEnd: string;
}

export function PostingProgressView({
  progress,
  cycleName,
  periodStart,
  periodEnd,
}: PostingProgressViewProps): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const failedCount = progress.rows.filter(
    (r) => r.status === "PERIOD_CLOSED" || r.status === "failed",
  ).length;
  // bm20-spec §Design D8/D9 — posting itself now completes into `INVOICED`,
  // not `COMPLETED` directly (the run moves on into `DISTRIBUTING` via a
  // separate, automatic trigger). `postingDone` is the set of states that are
  // strictly AT-OR-PAST posting completion (keyed on the status, not a count
  // match, so a run with zero postable accounts — every account SKIPPED —
  // still renders the completion message); `DistributionTab` is the dedicated
  // surface for what happens next. Deliberately an ALLOWLIST, not
  // `!== APPROVED && !== POSTING`: this page also renders for any non-PROCESSED
  // run (the approve route falls through to it), so a denylist would show a
  // false "posting complete" message on a run that is still SCHEDULED/
  // PROCESSING, or one that FAILED/was CANCELLED before posting ever ran.
  const POSTING_DONE_STATUSES: ReadonlySet<string> = new Set([
    "INVOICED",
    "DISTRIBUTING",
    "COMPLETED",
    "DISTRIBUTION_FAILED",
  ]);
  const postingDone = POSTING_DONE_STATUSES.has(progress.runStatus);
  const canPost =
    progress.runStatus === "APPROVED" || progress.runStatus === "POSTING";

  async function handlePost(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await postRunAction({ billRunId: progress.billRunId });
      if (!result.ok) {
        setError(describeError(result.code));
        return;
      }
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
        <h1 className="font-mono text-h1 font-semibold text-foreground">
          {progress.billRunId}
        </h1>
        <p className="text-body text-muted-foreground">
          {cycleName} · Period {formatCalendarDate(periodStart)} –{" "}
          {formatCalendarDate(periodEnd)}
        </p>
        <p className="text-body-sm font-medium text-foreground">
          {progress.postedCount}/{progress.totalCount} posted
        </p>
      </header>

      {progress.totalCount === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          No postable accounts on this run.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--border-default)] rounded-md border border-[color:var(--border-default)]">
          {progress.rows.map((row) => (
            <li
              key={row.billingAccountId}
              className="flex items-center justify-between gap-3 px-4 py-2 text-body-sm"
            >
              <div>
                <p className="font-medium text-foreground">{row.accountName}</p>
                {row.errorDetail && (
                  <p className="text-body-sm text-destructive">
                    {row.errorDetail}
                  </p>
                )}
                {/* bm19-spec §Design D10 — a render/store failure never blocks
                    INVOICED, so it's surfaced here (not as an errorDetail on
                    the account itself) alongside a standalone retry that
                    works regardless of the run's own status. */}
                {row.status === "invoiced" && !row.hasStoredInvoice && (
                  <RenderPendingRow
                    billRunId={progress.billRunId}
                    billingAccountId={row.billingAccountId}
                  />
                )}
              </div>
              <div className="flex items-center gap-2">
                {row.status === "invoiced" && row.hasStoredInvoice && (
                  <StoredInvoiceModal
                    billRunId={progress.billRunId}
                    billingAccountId={row.billingAccountId}
                    accountName={row.accountName}
                  />
                )}
                <span
                  className={cn(statusBadgeVariants({ variant: row.status }))}
                >
                  {STATUS_LABEL[row.status]}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-body-sm text-destructive">
          {error}
        </p>
      )}

      {postingDone ? (
        <p
          role="status"
          aria-live="polite"
          className="text-body-sm font-medium text-[color:var(--color-success-700)]"
        >
          {progress.postedCount > 0
            ? "All accounts invoiced. See the Distribution tab for delivery progress."
            : "Posting complete. No invoices were posted."}
        </p>
      ) : canPost ? (
        <Button
          type="button"
          disabled={submitting}
          onClick={() => void handlePost()}
        >
          {failedCount > 0 ? (
            <>
              <RotateCcw aria-hidden="true" />
              {submitting ? "Retrying…" : "Retry failed"}
            </>
          ) : (
            <>
              <FileCheck aria-hidden="true" />
              {submitting ? "Posting…" : "Post"}
            </>
          )}
        </Button>
      ) : null}
    </div>
  );
}

function describeError(code: string): string {
  switch (code) {
    case "NOT_POSTABLE":
      return "This run cannot be posted right now.";
    case "FORBIDDEN":
      return "You do not have permission to post bill runs.";
    case "VALIDATION_ERROR":
      return "Invalid request.";
    default:
      return "Something went wrong. Please try again.";
  }
}

// bm19-spec §Implementation §4 "Add a retry-render path (operator or the
// posting-progress 'Retry' already present)" — a standalone per-row control,
// deliberately independent of `canPost`/`done`: the run itself may already be
// `COMPLETED` (Design "postRun reaches INVOICED on posting completion
// regardless of render outcome") long before an operator notices a render
// gap, so this must stay reachable after the main Post/Retry-failed button
// has disappeared.
function RenderPendingRow({
  billRunId,
  billingAccountId,
}: {
  billRunId: string;
  billingAccountId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRetry(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const result = await retryRenderInvoiceAction({
        billRunId,
        billingAccountId,
      });
      if (!result.ok) {
        setError(describeRetryRenderError(result.code));
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-1 flex items-center gap-2">
      <p className="text-body-sm text-[color:var(--color-warning-700)]">
        Invoice artifact render pending.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting}
        onClick={() => void handleRetry()}
      >
        <RotateCcw aria-hidden="true" />
        {submitting ? "Retrying…" : "Retry render"}
      </Button>
      {error && (
        <span role="alert" className="text-caption text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}

function describeRetryRenderError(code: string): string {
  switch (code) {
    case "NOT_INVOICED":
      return "This account has not been posted yet.";
    case "ALREADY_STORED":
      return "The invoice was already stored — refresh to see it.";
    case "FORBIDDEN":
      return "You do not have permission to retry this.";
    case "VALIDATION_ERROR":
      return "Invalid request.";
    default:
      return "Render failed again. Please try again.";
  }
}
