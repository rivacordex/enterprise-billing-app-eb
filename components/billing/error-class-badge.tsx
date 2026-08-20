// bm04-spec §Visual, ui-context §4 (code-standards §4.1). One variant per
// `ErrorClass` value, shown on a `FAILED` stage cell / the future Errors tab.

import { AlertOctagon, AlertTriangle, Wifi } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { ErrorClass } from "@/types/billing";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        HARD: "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        SOFT: "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        INFRA:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
      } satisfies Record<ErrorClass, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  ErrorClass,
  { icon: typeof AlertOctagon; label: string }
> = {
  HARD: { icon: AlertOctagon, label: "Hard" },
  SOFT: { icon: AlertTriangle, label: "Soft" },
  INFRA: { icon: Wifi, label: "Infra" },
};

export interface ErrorClassBadgeProps {
  errorClass: ErrorClass;
  className?: string;
}

export function ErrorClassBadge({
  errorClass,
  className,
}: ErrorClassBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[errorClass];
  return (
    <span className={cn(badgeVariants({ variant: errorClass }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
