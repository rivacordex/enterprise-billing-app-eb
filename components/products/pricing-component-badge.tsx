import {
  ArrowDownToLine,
  Gauge,
  Repeat,
  TrendingDown,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ComponentType, EnvelopePriceType } from "@/types/product";

export interface PricingComponentBadgeProps {
  componentType: ComponentType;
  priceType: EnvelopePriceType;
  className?: string;
}

export interface PricingComponentBadgeVariant {
  label: string;
  icon: LucideIcon;
  className: string;
}

// pm53-spec D1: five rendered variants over the four persistable component
// types (types/product.ts COMPONENT_TYPES). `negotiated_override` is a fifth
// `PricingComponent` branch but is never a `ComponentType` member (Inv. #39)
// and gets no badge here — it is already wired as the Orders/Subscriptions
// "Negotiated" pill. This object is total over `ComponentType` (adding a
// member is a compile error, code-standards §2.2); `flat_fee` is the one
// entry with two variants, keyed by the envelope `priceType`.
export const PRICING_COMPONENT_BADGE_VARIANTS: Record<
  Exclude<ComponentType, "flat_fee">,
  PricingComponentBadgeVariant
> & {
  flat_fee: Record<"recurring" | "oneTime", PricingComponentBadgeVariant>;
} = {
  usage_rate: {
    label: "Usage rate",
    icon: Gauge,
    className:
      "bg-[color:var(--color-cyan-50)] text-[color:var(--color-cyan-700)]",
  },
  flat_fee: {
    recurring: {
      label: "Recurring charge",
      icon: Repeat,
      className:
        "bg-[color:var(--color-primary-50)] text-[color:var(--color-primary-700)]",
    },
    oneTime: {
      label: "One-time charge",
      icon: Zap,
      className:
        "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
    },
  },
  capacity_commitment: {
    label: "Target capacity commitment",
    icon: ArrowDownToLine,
    className:
      "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
  },
  capacity_motivation: {
    label: "Target capacity motivation",
    icon: TrendingDown,
    className:
      "bg-[color:var(--color-accent-50)] text-[color:var(--color-accent-700)]",
  },
};

// pm53-spec D2: `componentType` always equals `price_component ->> '@type'`
// (Inv. #30), so this switches on the column, never the JSON — the one
// envelope field read at all is `priceType`, for the `flat_fee` split. A row
// whose column and envelope disagree is corruption, not a variant: this is a
// guard against that unreachable state (pm46's CHECK + pm49's
// write-by-construction), not a fallback branch — it must not be
// "simplified away".
function resolveVariant(
  componentType: ComponentType,
  priceType: EnvelopePriceType,
): PricingComponentBadgeVariant | null {
  if (componentType === "flat_fee") {
    if (priceType !== "recurring" && priceType !== "oneTime") return null;
    return PRICING_COMPONENT_BADGE_VARIANTS.flat_fee[priceType];
  }
  return PRICING_COMPONENT_BADGE_VARIANTS[componentType];
}

export function PricingComponentBadge({
  componentType,
  priceType,
  className,
}: PricingComponentBadgeProps): React.JSX.Element | null {
  const variant = resolveVariant(componentType, priceType);
  if (variant === null) return null;

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
