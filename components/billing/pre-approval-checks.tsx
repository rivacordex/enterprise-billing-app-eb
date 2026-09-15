// bm10-spec §Visual, code-standards §4.6. Renders each pre-approval check as an
// explicit pass/fail row with a remediation line — always shown, never hidden
// behind a summary. Semantic tokens only, an icon paired with every state
// (ui-context "Rendering rule"). bm32 adds the INFORMATIONAL orphan-count line
// (§4): rendered with the Info family (never the danger accent), it always
// passes and carries no blocking remediation.

import { CheckCircle2, Info, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type { PreApprovalCheck, PreApprovalCheckKey } from "@/types/billing";

const CHECK_LABELS: Record<PreApprovalCheckKey, string> = {
  period_open: "Accounting period open",
  gl_mappings: "GL mappings resolvable",
  positive_totals: "No zero or negative totals",
  four_eyes: "Approver differs from the trigger actor",
  accounts_terminal: "All accounts terminal",
  no_rejected_pending: "No accounts pending reject-reprocess",
  orphan_count: "Orphaned usage records",
};

export interface PreApprovalChecksProps {
  checks: PreApprovalCheck[];
  className?: string;
}

export function PreApprovalChecks({
  checks,
  className,
}: PreApprovalChecksProps): React.JSX.Element {
  return (
    <ul
      className={cn(
        "space-y-3 rounded-md border border-[color:var(--border-default)] bg-[color:var(--surface-card)] p-4",
        className,
      )}
    >
      {checks.map((c) => {
        // bm32 — an informational check (the orphan count) renders as an Info
        // line: an Info icon (never the pass/fail success/danger icons) and an
        // info-toned remediation shown even though it always passes. It never
        // reads as a blocker.
        if (c.informational) {
          return (
            <li key={c.check} className="flex items-start gap-2">
              <Info
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[color:var(--color-info-500)]"
              />
              <div>
                <p className="text-body-sm font-medium text-foreground">
                  {CHECK_LABELS[c.check]}
                  <span className="sr-only"> — informational</span>
                </p>
                {c.remediation && (
                  <p className="text-body-sm text-[color:var(--color-info-700)]">
                    {c.remediation}
                  </p>
                )}
              </div>
            </li>
          );
        }

        return (
          <li key={c.check} className="flex items-start gap-2">
            {c.pass ? (
              <CheckCircle2
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[color:var(--color-success-500)]"
              />
            ) : (
              <XCircle
                size={16}
                aria-hidden="true"
                className="mt-0.5 shrink-0 text-[color:var(--color-danger-500)]"
              />
            )}
            <div>
              <p className="text-body-sm font-medium text-foreground">
                {CHECK_LABELS[c.check]}
                <span className="sr-only">
                  {c.pass ? " — pass" : " — fail"}
                </span>
              </p>
              {!c.pass && c.remediation && (
                <p className="text-body-sm text-[color:var(--color-danger-700)]">
                  {c.remediation}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
