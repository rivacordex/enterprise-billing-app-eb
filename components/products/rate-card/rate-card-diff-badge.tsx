import { Minus, Pencil, Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

// pm66-spec D5 / ui-context §10.2 — `RateCardDiffBadge`, the module's TENTH
// binding component name (C9, settled at pm65). Its three values render IN ONE
// VIEW (a chip row plus a per-row column), so they must be distinguishable by
// HUE **and** ICON, never colour alone (ui-context §6). Ordered by billing
// consequence — the order the diff itself uses (§2.28/§4.25).
//
// Removed takes DANGER, a deliberate departure from §1's neutral end-of-life
// treatment: a removed key is one absent from the version going live, and
// neutral would bury the only change a user cannot undo without a rollback. The
// label is always "Removed" — never "Retiring", never "Deleted": the row is not
// destroyed, it stays readable in the superseded version (the panel carries
// that qualifier). Changed takes INFO, not warning, because warning is already
// spoken for on this page (the Draft badge, the validation count) — ui-context
// §10.1/§10.2.
export const RATE_CARD_DIFF_CATEGORIES = [
  "added",
  "changed",
  "removed",
] as const;
export type RateCardDiffCategory = (typeof RATE_CARD_DIFF_CATEGORIES)[number];

export interface RateCardDiffBadgeVariant {
  label: string;
  icon: LucideIcon;
  className: string;
}

// Total `Record` (§2.2) — a new diff category is a compile error here.
export const RATE_CARD_DIFF_BADGE_VARIANTS: Record<
  RateCardDiffCategory,
  RateCardDiffBadgeVariant
> = {
  added: {
    label: "Added",
    icon: Plus,
    className:
      "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
  },
  changed: {
    label: "Changed",
    icon: Pencil,
    className:
      "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
  },
  removed: {
    label: "Removed",
    icon: Minus,
    className:
      "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
  },
};

export interface RateCardDiffBadgeProps {
  category: RateCardDiffCategory;
  className?: string;
}

export function RateCardDiffBadge({
  category,
  className,
}: RateCardDiffBadgeProps): React.JSX.Element {
  const variant = RATE_CARD_DIFF_BADGE_VARIANTS[category];
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
