// bm05-spec §Visual, ui-context §5 (code-standards §4.1). One variant per
// `BillCategory` value. `trial` renders outline-only (no fill) per
// ui-context — the only badge family in this module that does.

import { Clock, FileCheck, FileText } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { BillCategory } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        trial:
          "border border-[color:var(--color-neutral-500)] bg-[color:var(--surface-card)] text-[color:var(--color-neutral-700)]",
        normal:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        last: "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
      } satisfies Record<BillCategory, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  BillCategory,
  { icon: typeof Clock; label: string }
> = {
  trial: { icon: Clock, label: "Trial" },
  normal: { icon: FileText, label: "Normal" },
  last: { icon: FileCheck, label: "Last" },
};

export interface BillCategoryBadgeProps {
  category: BillCategory;
  className?: string;
}

export function BillCategoryBadge({
  category,
  className,
}: BillCategoryBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[category];
  return (
    <span className={cn(badgeVariants({ variant: category }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
