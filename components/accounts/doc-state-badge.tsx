// Document-state badge (ac07-spec §2.5, code-standards §4.1) — one variant
// per `DOC_STATES`, mapped to the ui-context §2 status families.

import { Ban, CheckCircle2, Clock, FileEdit, RotateCcw } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { DocState } from "@/types/accounts";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        draft:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
        pending_approval:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        posted:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        reversed:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
        cancelled:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-400)]",
      } satisfies Record<DocState, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  DocState,
  { icon: typeof CheckCircle2; label: string }
> = {
  draft: { icon: FileEdit, label: "Draft" },
  pending_approval: { icon: Clock, label: "Pending approval" },
  posted: { icon: CheckCircle2, label: "Posted" },
  reversed: { icon: RotateCcw, label: "Reversed" },
  cancelled: { icon: Ban, label: "Cancelled" },
};

export interface DocStateBadgeProps {
  state: DocState;
  className?: string;
}

export function DocStateBadge({
  state,
  className,
}: DocStateBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[state];
  return (
    <span className={cn(badgeVariants({ variant: state }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
