// Document-state badge (ac07-spec §2.5, code-standards §4.1) — one variant
// per `DOC_STATES`, mapped to the ui-context §2 status families. ac20-spec
// §2.6 adds a derived `partiallyReversed` prop rendered beside the `posted`
// badge, mirroring how `payment-status-badge.tsx` takes `derivedOverdue`.
// The component never computes partiallyReversed — the service does (§2.3).

import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileEdit,
  RotateCcw,
} from "lucide-react";
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
  // Derived by list-transaction-documents.ts (ac20-spec §2.3, inv. #18).
  // When true and state === "posted", renders a Warning chip beside the posted
  // badge. Never a sixth DOC_STATES member (§2.6). Family: Warning per
  // ui-context §2.
  partiallyReversed?: boolean;
  className?: string;
}

export function DocStateBadge({
  state,
  partiallyReversed = false,
  className,
}: DocStateBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = BADGE_CONFIG[state];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={cn(badgeVariants({ variant: state }), className)}>
        <Icon size={12} aria-hidden="true" />
        {label}
      </span>
      {partiallyReversed && state === "posted" && (
        <span className="inline-flex items-center gap-1 rounded-full bg-[color:var(--color-warning-50)] px-2 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-warning-700)] uppercase">
          <AlertTriangle size={12} aria-hidden="true" />
          Partially reversed
        </span>
      )}
    </span>
  );
}
