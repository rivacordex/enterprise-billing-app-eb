import {
  Archive,
  CheckCircle,
  FlaskConical,
  History,
  PencilLine,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { LifecycleStatus } from "@/types/product";

export interface LifecycleBadgeProps {
  status: LifecycleStatus;
  className?: string;
}

// One variant per lifecycle status. `className` carries literal Tailwind colour
// utilities that reference globals.css custom properties (no hex in the
// component, code-standards §4.3, same construction as `status-badge.tsx`). It
// is a whole literal string on purpose: Tailwind's JIT only emits classes it can
// see verbatim in source, and inline `style` is banned repo-wide (CSP: no
// 'unsafe-inline' in style-src), so the colour must ride a class, not a token
// interpolated into a style prop. `muted` is the row-muted flag (D2/D3):
// OBSOLETE and RETIRED de-emphasise their row. The two neutral greys (600 vs
// 500) are deliberately one step apart, so the icon and label carry the
// distinction, never colour alone (ui-context §6).
export interface LifecycleBadgeVariant {
  label: string;
  icon: LucideIcon;
  className: string;
  muted: boolean;
}

// Total `Record` — adding a lifecycle status makes `tsc` demand its variant here
// rather than falling through a default (code-standards §2.2, pm37-spec D2).
export const LIFECYCLE_BADGE_VARIANTS: Record<
  LifecycleStatus,
  LifecycleBadgeVariant
> = {
  DRAFT: {
    label: "Draft",
    icon: PencilLine,
    className:
      "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
    muted: false,
  },
  TESTING: {
    label: "Testing",
    icon: FlaskConical,
    className:
      "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
    muted: false,
  },
  ACTIVE: {
    label: "Active",
    icon: CheckCircle,
    className:
      "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
    muted: false,
  },
  OBSOLETE: {
    label: "Obsolete",
    icon: History,
    className:
      "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
    muted: true,
  },
  RETIRED: {
    label: "Retired",
    icon: Archive,
    className:
      "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-500)]",
    muted: true,
  },
};

export function LifecycleBadge({
  status,
  className,
}: LifecycleBadgeProps): React.JSX.Element {
  const variant = LIFECYCLE_BADGE_VARIANTS[status];
  const Icon = variant.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase",
        variant.className,
        className,
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {variant.label}
    </span>
  );
}
