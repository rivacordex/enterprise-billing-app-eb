import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { PermissionType } from "@/types/rbac";

export interface PermissionLevelTagProps {
  level: PermissionType;
  className?: string;
}

// Arbitrary-value utilities reference the info/warning/danger CSS custom
// properties directly (ui-context §3.6), mirroring status-badge.tsx — those
// scales aren't re-exposed as Tailwind utilities via `@theme inline`.
const permissionLevelTagVariants = cva(
  "inline-flex items-center rounded-xs px-1.5 py-0.5 text-overline font-semibold tracking-wider uppercase",
  {
    variants: {
      level: {
        READ: "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        EDIT: "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        DELETE:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
      } satisfies Record<PermissionType, string>,
    },
  },
);

export function PermissionLevelTag({
  level,
  className,
}: PermissionLevelTagProps): React.JSX.Element {
  return (
    <span className={cn(permissionLevelTagVariants({ level }), className)}>
      {level}
    </span>
  );
}
