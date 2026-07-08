import { Archive, CheckCircle, PencilLine } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { LifecycleStatus } from "@/types/product";

export interface LifecycleBadgeProps {
  status: LifecycleStatus;
  className?: string;
}

// Arbitrary-value utilities reference the success/warning/neutral CSS custom
// properties directly (ui-context §1), same construction as `status-badge.tsx`.
const lifecycleBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        DRAFT:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        RETIRED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<LifecycleStatus, string>,
    },
  },
);

const LIFECYCLE_ICONS = {
  ACTIVE: CheckCircle,
  DRAFT: PencilLine,
  RETIRED: Archive,
} as const satisfies Record<LifecycleStatus, typeof CheckCircle>;

const LIFECYCLE_LABELS = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  RETIRED: "Retired",
} as const satisfies Record<LifecycleStatus, string>;

export function LifecycleBadge({
  status,
  className,
}: LifecycleBadgeProps): React.JSX.Element {
  const Icon = LIFECYCLE_ICONS[status];

  return (
    <span className={cn(lifecycleBadgeVariants({ status }), className)}>
      <Icon size={12} aria-hidden="true" />
      {LIFECYCLE_LABELS[status]}
    </span>
  );
}
