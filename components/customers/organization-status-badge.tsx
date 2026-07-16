import {
  AlertOctagon,
  Archive,
  CheckCircle,
  ClipboardList,
  GitMerge,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { OrganizationStatus } from "@/types/customer";

export interface OrganizationStatusBadgeProps {
  status: OrganizationStatus;
  className?: string;
}

// Colors/icons are verbatim from custmgmt-ui-context.md §1 — same
// cva/dark-fg-on-light-bg construction as products' `lifecycle-badge.tsx`.
const organizationStatusBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        REGISTERED:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        INACTIVE:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        SUSPENDED:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        DISSOLVED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
        MERGED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<OrganizationStatus, string>,
    },
  },
);

const ORGANIZATION_STATUS_ICONS = {
  REGISTERED: ClipboardList,
  ACTIVE: CheckCircle,
  INACTIVE: PauseCircle,
  SUSPENDED: AlertOctagon,
  DISSOLVED: Archive,
  MERGED: GitMerge,
} as const satisfies Record<OrganizationStatus, LucideIcon>;

const ORGANIZATION_STATUS_LABELS = {
  REGISTERED: "Registered",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  SUSPENDED: "Suspended",
  DISSOLVED: "Dissolved",
  MERGED: "Merged",
} as const satisfies Record<OrganizationStatus, string>;

export function OrganizationStatusBadge({
  status,
  className,
}: OrganizationStatusBadgeProps): React.JSX.Element {
  const Icon = ORGANIZATION_STATUS_ICONS[status];

  return (
    <span
      className={cn(organizationStatusBadgeVariants({ status }), className)}
    >
      <Icon size={12} aria-hidden="true" />
      {ORGANIZATION_STATUS_LABELS[status]}
    </span>
  );
}
