import { Building2, Landmark, type LucideIcon } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { OrganizationType } from "@/types/customer";

export interface OrganizationTypeBadgeProps {
  organizationType: OrganizationType;
  className?: string;
}

// Colors/icons are verbatim from custmgmt-ui-context.md §3 — categorical,
// not a lifecycle status, but same cva construction as the status badges.
const organizationTypeBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      organizationType: {
        COMPANY:
          "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
        GOVERNMENT:
          "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
      } satisfies Record<OrganizationType, string>,
    },
  },
);

const ORGANIZATION_TYPE_ICONS = {
  COMPANY: Building2,
  GOVERNMENT: Landmark,
} as const satisfies Record<OrganizationType, LucideIcon>;

const ORGANIZATION_TYPE_LABELS = {
  COMPANY: "Company",
  GOVERNMENT: "Government",
} as const satisfies Record<OrganizationType, string>;

export function OrganizationTypeBadge({
  organizationType,
  className,
}: OrganizationTypeBadgeProps): React.JSX.Element {
  const Icon = ORGANIZATION_TYPE_ICONS[organizationType];

  return (
    <span
      className={cn(
        organizationTypeBadgeVariants({ organizationType }),
        className,
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {ORGANIZATION_TYPE_LABELS[organizationType]}
    </span>
  );
}
