// bm02-spec §6 / ui-context §6 (architecture Inv. #15, code-standards §4.2),
// renamed + recopied bm15-spec §Implementation §4 / Phase-2 review fold D-T4.
// While `BILLRUN_PLACEHOLDER_MODE` is set, every bill-run surface is loudly
// badged: the workflow engine runs the bill run for real, but the billing
// steps are placeholders and `udr_rated` is seeded `_SAMPLE_` test data —
// approval, posting, invoice numbers, rendered PDFs and distribution are
// wired end-to-end and REAL (D-T4: the copy names what's real, not just what
// isn't). The banner is a persistent, full-width warning bar; the badge is a
// list-row chip. Never conditionally hidden by a per-run field — the caller
// threads the environment placeholder flag server-side and renders these iff
// it is on (there is no `udr_mode` column). Warning-family tokens only.

import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

const PLACEHOLDER_COPY =
  "Placeholder pipeline — the workflow engine runs the bill run, but the billing steps are placeholders and udr_rated is seeded _SAMPLE_ test data. Approval, posting, invoice numbers, rendered PDFs and distribution are wired end-to-end and REAL.";

export function PlaceholderBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-sm border border-[color:var(--color-warning-500)] bg-[color:var(--color-warning-50)] px-4 py-2.5 text-body-sm font-medium text-[color:var(--color-warning-700)]"
    >
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{PLACEHOLDER_COPY}</span>
    </div>
  );
}

export interface PlaceholderBadgeProps {
  className?: string;
}

export function PlaceholderBadge({
  className,
}: PlaceholderBadgeProps): React.JSX.Element {
  return (
    <span
      title={PLACEHOLDER_COPY}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-[color:var(--color-warning-500)] bg-[color:var(--surface-card)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase",
        className,
      )}
    >
      <AlertTriangle size={12} aria-hidden="true" />
      Placeholder
    </span>
  );
}
