// bm04-spec §Visual, ui-context §3 (code-standards §4.1). One variant per
// `StageStatus` value on the `StageTimeline`, semantic tokens only, icon +
// label pairing (ui-context "Rendering rule"). Pattern mirrors
// `components/billing/run-status-badge.tsx`.

import {
  CheckCircle2,
  Circle,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { StageStatus } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        PENDING:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-muted)]",
        RUNNING:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        DONE: "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        FAILED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        SKIPPED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-disabled)]",
      } satisfies Record<StageStatus, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  StageStatus,
  { icon: typeof Circle; label: string }
> = {
  PENDING: { icon: Circle, label: "Pending" },
  RUNNING: { icon: RefreshCw, label: "Running" },
  DONE: { icon: CheckCircle2, label: "Done" },
  FAILED: { icon: XCircle, label: "Failed" },
  SKIPPED: { icon: MinusCircle, label: "Skipped" },
};

export interface StageStatusBadgeProps {
  // `null` = no signal received yet for this (account, stage) cell —
  // rendered as the neutral PENDING badge, never a stored row
  // (`services/billing/read/get-stage-timeline.ts`).
  status: StageStatus | null;
  className?: string;
}

export function StageStatusBadge({
  status,
  className,
}: StageStatusBadgeProps): React.JSX.Element {
  const effective = status ?? "PENDING";
  const { icon: Icon, label } = BADGE_CONFIG[effective];
  return (
    <span className={cn(badgeVariants({ variant: effective }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
