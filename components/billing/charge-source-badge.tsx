// bm29-spec §Implementation §5, code-standards §4.1 (`ChargeSourceBadge`) — one
// variant per rendered `ChargeSource`, mirroring `bill-category-badge.tsx`. It
// labels a bill line's origin so a reviewer can tell a derived RECURRING charge
// from a claimed USAGE rollup without opening the disclosure: `USAGE` → info/cyan
// (`--color-info-*`), `RECURRING` → primary (`--color-primary-*`). `OCC` is
// reserved and unbuilt this phase (Inv #16/D30) — nothing emits it, so it renders
// nothing rather than an unstyled variant.

import { Gauge, Repeat } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { ChargeSource } from "@/types/billing";

type RenderedSource = Exclude<ChargeSource, "OCC">;

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        USAGE:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        RECURRING:
          "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
      } satisfies Record<RenderedSource, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  RenderedSource,
  { icon: typeof Gauge; label: string }
> = {
  USAGE: { icon: Gauge, label: "Usage" },
  RECURRING: { icon: Repeat, label: "Recurring" },
};

export interface ChargeSourceBadgeProps {
  source: ChargeSource;
  className?: string;
}

export function ChargeSourceBadge({
  source,
  className,
}: ChargeSourceBadgeProps): React.JSX.Element | null {
  // `OCC` is reserved and never emitted this phase — render nothing rather than
  // invent a treatment for a source that does not exist yet.
  if (source === "OCC") return null;
  const { icon: Icon, label } = BADGE_CONFIG[source];
  return (
    <span className={cn(badgeVariants({ variant: source }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
