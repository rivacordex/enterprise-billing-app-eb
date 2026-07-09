import { Gauge, Repeat, Zap } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { PriceType } from "@/types/product";

export interface PriceTypeBadgeProps {
  priceType: PriceType;
  className?: string;
}

const priceTypeBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      priceType: {
        recurring:
          "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
        usage:
          "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
        once: "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<PriceType, string>,
    },
  },
);

const PRICE_TYPE_ICONS = {
  recurring: Repeat,
  usage: Gauge,
  once: Zap,
} as const satisfies Record<PriceType, typeof Repeat>;

const PRICE_TYPE_LABELS = {
  recurring: "Recurring",
  usage: "Usage",
  once: "Once",
} as const satisfies Record<PriceType, string>;

export function PriceTypeBadge({
  priceType,
  className,
}: PriceTypeBadgeProps): React.JSX.Element {
  const Icon = PRICE_TYPE_ICONS[priceType];

  return (
    <span className={cn(priceTypeBadgeVariants({ priceType }), className)}>
      <Icon size={12} aria-hidden="true" />
      {PRICE_TYPE_LABELS[priceType]}
    </span>
  );
}
