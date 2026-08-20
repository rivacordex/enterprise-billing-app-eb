// bm02-spec §6 / ui-context §6 (architecture Inv. #15, code-standards §4.2).
// While `STUB_DATA_MODE` is set, every bill-run surface is loudly badged as
// fixture data. The banner is a persistent, full-width warning bar; the badge
// is a list-row chip. Never conditionally hidden by a per-run field — the
// caller threads the environment stub flag server-side and renders these iff
// it is on (there is no `udr_mode` column). Warning-family tokens only.

import { AlertTriangle } from "lucide-react";

import { cn } from "@/lib/utils";

const STUB_COPY = "Stub data — figures are fixtures, not production charges.";

export function StubDataBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-sm border border-[color:var(--color-warning-500)] bg-[color:var(--color-warning-50)] px-4 py-2.5 text-body-sm font-medium text-[color:var(--color-warning-700)]"
    >
      <AlertTriangle size={16} aria-hidden="true" />
      <span>{STUB_COPY}</span>
    </div>
  );
}

export interface StubBadgeProps {
  className?: string;
}

export function StubBadge({ className }: StubBadgeProps): React.JSX.Element {
  return (
    <span
      title={STUB_COPY}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-[color:var(--color-warning-500)] bg-[color:var(--surface-card)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase",
        className,
      )}
    >
      <AlertTriangle size={12} aria-hidden="true" />
      Stub
    </span>
  );
}
