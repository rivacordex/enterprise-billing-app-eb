import { Archive, Ban, CheckCircle, Clock, Lock } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { UserStatus } from "@/types/rbac";

export interface StatusBadgeProps {
  status: UserStatus;
  isLocked?: boolean;
  className?: string;
}

// Arbitrary-value utilities reference the status/danger CSS custom
// properties directly (ui-context §3.4): those scales aren't re-exposed as
// Tailwind utilities via `@theme inline` (app/globals.css), only the
// curated shadcn semantic subset is.
const statusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        PENDING:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        DISABLED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        DELETED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)] line-through",
      } satisfies Record<UserStatus, string>,
    },
  },
);

const STATUS_ICONS = {
  ACTIVE: CheckCircle,
  PENDING: Clock,
  DISABLED: Ban,
  DELETED: Archive,
} as const satisfies Record<UserStatus, typeof CheckCircle>;

const STATUS_LABELS = {
  ACTIVE: "Active",
  PENDING: "Pending",
  DISABLED: "Disabled",
  DELETED: "Deleted",
} as const satisfies Record<UserStatus, string>;

export function StatusBadge({
  status,
  isLocked,
  className,
}: StatusBadgeProps): React.JSX.Element {
  const Icon = STATUS_ICONS[status];

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn(statusBadgeVariants({ status }), className)}>
        <Icon size={12} aria-hidden="true" />
        {STATUS_LABELS[status]}
      </span>
      {isLocked === true && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-danger-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-danger-700)] uppercase">
          <Lock size={12} aria-hidden="true" />
          Locked
        </span>
      )}
    </span>
  );
}
