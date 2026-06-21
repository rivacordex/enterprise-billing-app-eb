import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { ConfigStatus } from "@/types/system-config";

export interface ConfigStatusBadgeProps {
  status: ConfigStatus;
  className?: string;
}

// Arbitrary-value utilities reference the success/info/neutral CSS custom
// properties directly (ui-context §3.4, mirroring permission-level-tag.tsx)
// — those scales aren't re-exposed as Tailwind utilities via `@theme
// inline`.
const configStatusBadgeVariants = cva(
  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      status: {
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        DRAFT:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        RETIRED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
      } satisfies Record<ConfigStatus, string>,
    },
  },
);

const STATUS_LABELS = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  RETIRED: "Retired",
} as const satisfies Record<ConfigStatus, string>;

export function ConfigStatusBadge({
  status,
  className,
}: ConfigStatusBadgeProps): React.JSX.Element {
  return (
    <span className={cn(configStatusBadgeVariants({ status }), className)}>
      {STATUS_LABELS[status]}
    </span>
  );
}
