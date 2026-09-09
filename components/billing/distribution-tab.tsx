// bm20-spec §Implementation §6, §Phase-2 review fold D-T3 — the Distribution
// tab: the targets list (loopback mandatory; deferred targets greyed), the
// per-artifact delivery log, and the state-dependent action per D-T1's
// control hierarchy. Server component (the three action controls are client
// islands); zero-exceptions is a positive empty state, same idiom as
// Uncharged/Errors.

import { CircleCheck, Send } from "lucide-react";

import { DistributionOutcomeBadge } from "@/components/billing/distribution-outcome-badge";
import { StartDistributionControl } from "@/components/billing/start-distribution-control";
import { RerunDistributionControl } from "@/components/billing/rerun-distribution-control";
import {
  ForceCompleteDistributionDialog,
  failedArtifactRefsFromRows,
} from "@/components/billing/force-complete-distribution-dialog";
import { formatDatetime } from "@/lib/formatters";
import type { DistributionView } from "@/types/billing";

export interface DistributionTabProps {
  view: DistributionView;
  // Show/hide only (code-standards §8) — the actions re-check server-side.
  canOperate: boolean;
  canApprove: boolean;
  locale: string;
  timezone: string;
}

const ARTIFACT_TYPE_LABEL: Record<string, string> = {
  invoice_pdf: "Invoice PDF",
  report_csv: "Run report (CSV)",
};

export function DistributionTab({
  view,
  canOperate,
  canApprove,
  locale,
  timezone,
}: DistributionTabProps): React.JSX.Element {
  const { runStatus, targets, rows } = view;

  return (
    <div className="space-y-6">
      <TargetsList targets={targets} />

      {runStatus === "INVOICED" && !view.hasExecution && (
        <div className="space-y-3 rounded-md border border-[color:var(--color-success-500)] bg-[color:var(--color-success-50)] p-4">
          <p className="text-body-sm font-medium text-[color:var(--color-success-700)]">
            Money posted — every invoice for this run is in the ledger.
            Distribution to the configured targets starts automatically; use
            the control below if it hasn&apos;t started yet.
          </p>
          {canOperate && <StartDistributionControl billRunId={view.billRunId} />}
        </div>
      )}

      {runStatus === "DISTRIBUTING" && (
        <div className="rounded-md border border-[color:var(--color-info-500)] bg-[color:var(--color-info-50)] px-4 py-3">
          <p className="text-body-sm font-medium text-[color:var(--color-info-700)]">
            Delivering artifacts to every configured target… this list fills
            in as outcomes land, then completes once every mandatory artifact
            is delivered.
          </p>
        </div>
      )}

      {runStatus === "COMPLETED" && (
        <div className="flex items-center gap-2 rounded-md border border-[color:var(--color-success-500)] bg-[color:var(--color-success-50)] px-4 py-3">
          <CircleCheck
            className="shrink-0 text-[color:var(--color-success-500)]"
            size={18}
            aria-hidden="true"
          />
          <p className="text-body-sm font-medium text-[color:var(--color-success-700)]">
            Distribution complete — every mandatory artifact was delivered.
          </p>
        </div>
      )}

      {runStatus === "DISTRIBUTION_FAILED" && (
        <div className="space-y-3 rounded-md border border-[color:var(--color-danger-500)] bg-[color:var(--color-danger-50)] p-4">
          <p className="text-body-sm font-medium text-[color:var(--color-danger-700)]">
            A mandatory target failed to receive at least one artifact.
            Posted invoices are untouched, and next month&apos;s run is
            already unblocked (next-cycle operability keys off Invoiced, not
            Completed).
          </p>
          <div className="flex flex-wrap items-center gap-4">
            {canOperate && (
              <RerunDistributionControl billRunId={view.billRunId} />
            )}
            {canApprove && (
              <ForceCompleteDistributionDialog
                billRunId={view.billRunId}
                failedArtifactRefs={failedArtifactRefsFromRows(rows)}
              />
            )}
          </div>
        </div>
      )}

      <DeliveryLog rows={rows} locale={locale} timezone={timezone} />
    </div>
  );
}

function TargetsList({
  targets,
}: {
  targets: DistributionView["targets"];
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <h2 className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        Targets
      </h2>
      <ul className="flex flex-wrap gap-2">
        {targets.map((t) => (
          <li
            key={t.name}
            className="rounded-full bg-[color:var(--surface-selected)] px-3 py-1 text-body-sm font-medium text-foreground"
          >
            {t.name}
            {t.isMandatory && (
              <span className="ml-1 text-muted-foreground">(mandatory)</span>
            )}
          </li>
        ))}
        {["portal", "AR feed", "statutory", "email"].map((deferred) => (
          <li
            key={deferred}
            className="rounded-full bg-[color:var(--color-neutral-100)] px-3 py-1 text-body-sm text-[color:var(--text-disabled)]"
          >
            {deferred} (not configured)
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeliveryLog({
  rows,
  locale,
  timezone,
}: {
  rows: DistributionView["rows"];
  locale: string;
  timezone: string;
}): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-none bg-card p-10 text-center shadow-sm">
        <Send
          className="mx-auto mb-3 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <p className="text-body font-semibold text-foreground">
          No delivery activity yet
        </p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Outcomes appear here as each artifact is delivered to its target.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-none bg-card shadow-sm">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Target
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Artifact
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Attempt
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Outcome
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              At
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.billRunDistributionId}`}
              className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
            >
              <td className="px-4 py-3 align-top font-medium text-foreground">
                {row.target}
              </td>
              <td className="px-4 py-3 align-top">
                <div className="text-foreground">
                  {ARTIFACT_TYPE_LABEL[row.artifactType] ?? row.artifactType}
                </div>
                <div className="font-mono text-mono text-muted-foreground">
                  {row.artifactRef}
                </div>
              </td>
              <td className="px-4 py-3 align-top text-foreground">
                {row.distributionAttempt}
              </td>
              <td className="px-4 py-3 align-top">
                <DistributionOutcomeBadge outcome={row.outcome} />
              </td>
              <td className="px-4 py-3 align-top text-muted-foreground">
                {formatDatetime(row.at, locale, timezone)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
