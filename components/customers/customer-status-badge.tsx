import {
  AlertOctagon,
  Archive,
  CheckCircle,
  PencilLine,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { CustomerStatus } from "@/types/customer";

export interface CustomerStatusBadgeProps {
  status: CustomerStatus;
  className?: string;
}

// Colors/icons are verbatim from custmgmt-ui-context.md §2.
const customerStatusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        INITIALIZED:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        VALIDATED:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        SUSPENDED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        CLOSED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<CustomerStatus, string>,
    },
  },
);

const CUSTOMER_STATUS_ICONS = {
  INITIALIZED: PencilLine,
  VALIDATED: ShieldCheck,
  ACTIVE: CheckCircle,
  SUSPENDED: AlertOctagon,
  CLOSED: Archive,
} as const satisfies Record<CustomerStatus, LucideIcon>;

const CUSTOMER_STATUS_LABELS = {
  INITIALIZED: "Initialized",
  VALIDATED: "Validated",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  CLOSED: "Closed",
} as const satisfies Record<CustomerStatus, string>;

export function CustomerStatusBadge({
  status,
  className,
}: CustomerStatusBadgeProps): React.JSX.Element {
  const Icon = CUSTOMER_STATUS_ICONS[status];

  return (
    <span className={cn(customerStatusBadgeVariants({ status }), className)}>
      <Icon size={12} aria-hidden="true" />
      {CUSTOMER_STATUS_LABELS[status]}
    </span>
  );
}
