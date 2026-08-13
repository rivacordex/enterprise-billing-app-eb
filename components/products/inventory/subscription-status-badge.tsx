// pm33-spec — TMF637 subscription-status pill. All eight PRODUCT_STATUSES get
// a variant (the phase only ever writes ACTIVE/SUSPENDED/TERMINATED —
// architecture §3 — the other five render if the seeded enum is ever
// exercised, but are otherwise unused; OrderStatusBadge/pm27 precedent).
// Mapping per prodmgmt-ui-context.md's SubscriptionStatusBadge wiring
// section: ACTIVE -> success, SUSPENDED -> warning, TERMINATED ->
// neutral/archive (the catalog's RETIRED-row convention), everything else ->
// neutral.

import {
  AlertTriangle,
  Archive,
  Ban,
  CheckCircle2,
  CircleDashed,
  Clock,
  PauseCircle,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { ProductStatus } from "@/types/inventory";

export interface SubscriptionStatusBadgeProps {
  status: ProductStatus;
  className?: string;
}

const subscriptionStatusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        CREATED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        PENDING_ACTIVE:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        SUSPENDED:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        PENDING_TERMINATE:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        TERMINATED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        CANCELLED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        ABORTED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<ProductStatus, string>,
    },
  },
);

const SUBSCRIPTION_STATUS_ICONS = {
  CREATED: CircleDashed,
  PENDING_ACTIVE: Clock,
  ACTIVE: CheckCircle2,
  SUSPENDED: PauseCircle,
  PENDING_TERMINATE: Clock,
  TERMINATED: Archive,
  CANCELLED: Ban,
  ABORTED: AlertTriangle,
} as const satisfies Record<ProductStatus, typeof Clock>;

export const SUBSCRIPTION_STATUS_LABELS = {
  CREATED: "Created",
  PENDING_ACTIVE: "Pending Active",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  PENDING_TERMINATE: "Pending Terminate",
  TERMINATED: "Terminated",
  CANCELLED: "Cancelled",
  ABORTED: "Aborted",
} as const satisfies Record<ProductStatus, string>;

export function SubscriptionStatusBadge({
  status,
  className,
}: SubscriptionStatusBadgeProps): React.JSX.Element {
  const Icon = SUBSCRIPTION_STATUS_ICONS[status];

  return (
    <span
      className={cn(subscriptionStatusBadgeVariants({ status }), className)}
    >
      <Icon size={12} aria-hidden="true" />
      {SUBSCRIPTION_STATUS_LABELS[status]}
    </span>
  );
}
