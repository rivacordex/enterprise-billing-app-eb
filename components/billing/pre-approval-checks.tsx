// bm10-spec §Visual, code-standards §4.6. Renders each of the five
// pre-approval checks as an explicit pass/fail row with a remediation line —
// always shown, never hidden behind a summary. Semantic tokens only, an
// icon paired with every state (ui-context "Rendering rule").

import { CheckCircle2, XCircle } from "lucide-react";

import { cn } from "@/lib/utils";
import type {
  PreApprovalCheck,
  PreApprovalCheckKey,
} from "@/services/billing/pre-approval-checks";

const CHECK_LABELS: Record<PreApprovalCheckKey, string> = {
  period_open: "Accounting period open",
  gl_mappings: "GL mappings resolvable",
  positive_totals: "No zero or negative totals",
  four_eyes: "Approver differs from the trigger actor",
  accounts_terminal: "All accounts terminal",
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
      {checks.map((c) => (
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
              <span className="sr-only">{c.pass ? " — pass" : " — fail"}</span>
            </p>
            {!c.pass && c.remediation && (
              <p className="text-body-sm text-[color:var(--color-danger-700)]">
                {c.remediation}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
