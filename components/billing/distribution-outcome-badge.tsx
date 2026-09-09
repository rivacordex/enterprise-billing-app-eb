// bm20-spec §Visual, ui-context §6b. One variant per `DistributionOutcome`
// value, shown on each row of the Distribution tab's delivery log.

import { CheckCircle2, XCircle } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { DistributionOutcome } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        DELIVERED:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        FAILED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
      } satisfies Record<DistributionOutcome, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  DistributionOutcome,
  { icon: typeof CheckCircle2; label: string }
> = {
  DELIVERED: { icon: CheckCircle2, label: "Delivered" },
  FAILED: { icon: XCircle, label: "Failed" },
};

export interface DistributionOutcomeBadgeProps {
  outcome: DistributionOutcome;
  className?: string;
}

export function DistributionOutcomeBadge({
  outcome,
  className,
}: DistributionOutcomeBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[outcome];
  return (
    <span className={cn(badgeVariants({ variant: outcome }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
