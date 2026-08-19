// bm02-spec §6 / ui-context §1 (code-standards §4.1). One variant per `RunStatus`
// value, mapped to the shared token families — semantic tokens only, never raw
// hex (ui-context §"Rendering rule"). Every badge pairs a `lucide-react` icon
// with a label, so meaning never depends on colour alone. Pattern mirrors
// `components/accounts/doc-state-badge.tsx`.

import {
  Ban,
  Banknote,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  FileCheck,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { RunStatus } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        SCHEDULED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        PROCESSING:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        PROCESSED:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        APPROVED:
          "bg-[color:var(--surface-selected)] text-[color:var(--color-primary-700)]",
        POSTING:
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
        CANCELLED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
      } satisfies Record<RunStatus, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  RunStatus,
  { icon: typeof CheckCircle2; label: string }
> = {
  SCHEDULED: { icon: CalendarClock, label: "Scheduled" },
  PROCESSING: { icon: RefreshCw, label: "Processing" },
  PROCESSED: { icon: ClipboardCheck, label: "Processed" },
  APPROVED: { icon: ShieldCheck, label: "Approved" },
  POSTING: { icon: Banknote, label: "Posting" },
  INVOICED: { icon: FileCheck, label: "Invoiced" },
  DISTRIBUTING: { icon: Send, label: "Distributing" },
  COMPLETED: { icon: CheckCircle2, label: "Completed" },
  PROCESSING_FAILED: { icon: XCircle, label: "Processing failed" },
  DISTRIBUTION_FAILED: { icon: XCircle, label: "Distribution failed" },
  CANCELLED: { icon: Ban, label: "Cancelled" },
};

export interface RunStatusBadgeProps {
  status: RunStatus;
  className?: string;
}

export function RunStatusBadge({
  status,
  className,
}: RunStatusBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[status];
  return (
    <span className={cn(badgeVariants({ variant: status }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
