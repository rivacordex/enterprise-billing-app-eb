// bm07-spec §Visual — the Errors tab: the run's blocking `PROCESSING_FAILED`
// accounts (fix-then-rerun). Destructive "blocking" treatment (never the
// Uncharged neutral styling — code-standards §4.7). Per row: account, an
// `ErrorClassBadge` (HARD), the failed stage + `error_code`/detail. bm08 wires
// the "Rerun these accounts" affordance to the live `RerunDialog` (the failed
// accounts, gated on `billrun_operate`). Server component (the dialog is a
// client island). Zero errors is a positive empty state, not a blank tab.

import { CircleCheck } from "lucide-react";

import { ErrorClassBadge } from "@/components/billing/error-class-badge";
import { RerunDialog } from "@/components/billing/rerun-dialog";
import type { ErrorRow } from "@/types/billing";

export interface ErrorsTableProps {
  runId: string;
  rows: ErrorRow[];
  // Whether the viewer holds `billrun_operate` — show/hide the rerun control
  // (the action re-checks server-side regardless, code-standards §8).
  canOperate: boolean;
}

export function ErrorsTable({
  runId,
  rows,
  canOperate,
}: ErrorsTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-none bg-card p-10 text-center shadow-sm">
        <CircleCheck
          className="mx-auto mb-3 size-10 text-[color:var(--color-success-500)]"
          aria-hidden="true"
        />
        <p className="text-body font-semibold text-foreground">
          No blocking errors
        </p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          No account failed with a hard error this run — nothing to fix and
          rerun.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body-sm text-muted-foreground">
          {rows.length} account{rows.length === 1 ? "" : "s"} blocked by a hard
          error — fix the underlying issue, then rerun.
        </p>
        {canOperate && (
          <RerunDialog
            billRunId={runId}
            accountIds={rows.map((r) => r.billingAccountId)}
          />
        )}
      </div>

      <div className="overflow-x-auto rounded-none border-l-2 border-[color:var(--color-danger-500)] bg-card shadow-sm">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
              <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Account
              </th>
              <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Class
              </th>
              <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Stage
              </th>
              <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Error
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.billingAccountId}
                className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
              >
                <td className="px-4 py-3 align-top">
                  <div className="font-medium text-foreground">
                    {row.accountName}
                  </div>
                  <div className="font-mono text-mono text-muted-foreground">
                    {row.billingAccountId}
                  </div>
                </td>
                <td className="px-4 py-3 align-top">
                  <ErrorClassBadge errorClass={row.errorClass} />
                </td>
                <td className="px-4 py-3 align-top whitespace-nowrap text-foreground">
                  {row.stage}
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="font-mono text-mono text-[color:var(--color-danger-700)]">
                    {row.errorCode ?? "—"}
                  </div>
                  {row.errorDetail !== null && (
                    <div className="mt-0.5 text-body-sm text-muted-foreground">
                      {row.errorDetail}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
