// bm04-spec §Visual/§Implementation §9 (code-standards §4.1 — "ships with the
// first unit that renders a per-account row", which is the Workflow tab's
// `StageTimeline`). One variant per `AccountStatus` value, mirrors
// `run-status-badge.tsx`'s shape.

import {
  Ban,
  CheckCircle2,
  Clock,
  FileCheck,
  RefreshCw,
  Send,
  SkipForward,
  XCircle,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { AccountStatus } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        PENDING:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-muted)]",
        PROCESSING:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        PROCESSED:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        INVOICED:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        DISTRIBUTING:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        COMPLETED:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        PROCESSING_FAILED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        DISTRIBUTION_FAILED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        SKIPPED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-disabled)]",
        EXCLUDED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--text-disabled)]",
      } satisfies Record<AccountStatus, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  AccountStatus,
  { icon: typeof CheckCircle2; label: string }
> = {
  PENDING: { icon: Clock, label: "Pending" },
  PROCESSING: { icon: RefreshCw, label: "Processing" },
  PROCESSED: { icon: CheckCircle2, label: "Processed" },
  INVOICED: { icon: FileCheck, label: "Invoiced" },
  DISTRIBUTING: { icon: Send, label: "Distributing" },
  COMPLETED: { icon: CheckCircle2, label: "Completed" },
  PROCESSING_FAILED: { icon: XCircle, label: "Processing failed" },
  DISTRIBUTION_FAILED: { icon: XCircle, label: "Distribution failed" },
  SKIPPED: { icon: SkipForward, label: "Skipped" },
  EXCLUDED: { icon: Ban, label: "Excluded" },
};

export interface AccountStatusBadgeProps {
  status: AccountStatus;
  className?: string;
}

export function AccountStatusBadge({
  status,
  className,
}: AccountStatusBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[status];
  return (
    <span className={cn(badgeVariants({ variant: status }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
