import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { AuditEventCategory } from "@/types/audit-log";

export interface AuditEventCategoryBadgeProps {
  category: AuditEventCategory;
  className?: string;
}

// Arbitrary-value utilities reference the success/info/danger/cyan/warning
// CSS custom properties directly (ui-context §3.7), mirroring
// permission-level-tag.tsx and config-status-badge.tsx — those scales
// aren't re-exposed as Tailwind utilities via `@theme inline`.
const auditEventCategoryBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-overline font-semibold tracking-wider uppercase whitespace-nowrap",
  {
    variants: {
      category: {
        Additive:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        Change:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        Removal:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        Session:
          "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
        Security:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
      } satisfies Record<AuditEventCategory, string>,
    },
  },
);

export function AuditEventCategoryBadge({
  category,
  className,
}: AuditEventCategoryBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(auditEventCategoryBadgeVariants({ category }), className)}
    >
      {category}
    </span>
  );
}
