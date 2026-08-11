// pm27-spec §Design — TMF622 order-status pill. All nine ORDER_STATUSES get a
// variant (the phase only ever writes ACKNOWLEDGED/PENDING/COMPLETED/REJECTED/
// FAILED — architecture §3 — the other four render if the seeded enum is ever
// exercised, but are otherwise unused). Mapping per prodmgmt-ui-context.md's
// OrderStatusBadge wiring section: COMPLETED -> success, PENDING -> warning,
// REJECTED/FAILED -> danger, everything else -> neutral.

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileCheck2,
  Loader,
  PauseCircle,
  CircleDashed,
  XCircle,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { OrderStatus } from "@/types/ordering";

export interface OrderStatusBadgeProps {
  status: OrderStatus;
  className?: string;
}

const orderStatusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        ACKNOWLEDGED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        REJECTED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        PENDING:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        HELD: "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        IN_PROGRESS:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        CANCELLED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        COMPLETED:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        FAILED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        PARTIAL:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<OrderStatus, string>,
    },
  },
);

const ORDER_STATUS_ICONS = {
  ACKNOWLEDGED: FileCheck2,
  REJECTED: XCircle,
  PENDING: Clock,
  HELD: PauseCircle,
  IN_PROGRESS: Loader,
  CANCELLED: Ban,
  COMPLETED: CheckCircle2,
  FAILED: AlertTriangle,
  PARTIAL: CircleDashed,
} as const satisfies Record<OrderStatus, typeof Clock>;

const ORDER_STATUS_LABELS = {
  ACKNOWLEDGED: "Acknowledged",
  REJECTED: "Rejected",
  PENDING: "Pending",
  HELD: "Held",
  IN_PROGRESS: "In Progress",
  CANCELLED: "Cancelled",
  COMPLETED: "Completed",
  FAILED: "Failed",
  PARTIAL: "Partial",
} as const satisfies Record<OrderStatus, string>;

export function OrderStatusBadge({
  status,
  className,
}: OrderStatusBadgeProps): React.JSX.Element {
  const Icon = ORDER_STATUS_ICONS[status];

  return (
    <span className={cn(orderStatusBadgeVariants({ status }), className)}>
      <Icon size={12} aria-hidden="true" />
      {ORDER_STATUS_LABELS[status]}
    </span>
  );
}
