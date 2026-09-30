import { CheckCircle, History, PencilLine, XCircle } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { RateCardVersionStatus } from "@/types/product";

// pm65-spec D2 / ui-context §10.1 — the rate-card version-status badge. A
// SEPARATE total `Record<RateCardVersionStatus, …>`, sharing NO type with
// `LifecycleBadge` (§2.19, §4.22, workflow §3.13): the two sets share three
// spellings and no semantics, so a card version must never inherit an
// `OBSOLETE`/`RETIRED` branch nor an offering a `SUPERSEDED` one. Same pill
// construction as `LifecycleBadge` (icon + label, dark `-fg` on light `-bg`,
// never colour-only — ui-context §6); `className` carries whole literal
// Tailwind colour utilities referencing globals.css custom properties (no hex
// in the component, §4.3), for the same JIT + CSP reasons `lifecycle-badge.tsx`
// documents.
//
// C1 — this component is `RateCardStatusBadge` (code-standards owns component
// names, §7.7/§8; ui-context §10.1 already reads `RateCardStatusBadge`,
// confirmed 2026-09-27). If a stale `RateCardVersionBadge` ever resurfaces, it
// is the bug — correct it to this name.
export interface RateCardStatusBadgeProps {
  status: RateCardVersionStatus;
  className?: string;
}

export interface RateCardStatusBadgeVariant {
  label: string;
  icon: LucideIcon;
  className: string;
  // SUPERSEDED de-emphasises its row, the same way §1's OBSOLETE/RETIRED do —
  // the version list reads this flag to mute a superseded row (ui-context
  // §10.5).
  muted: boolean;
}

// Total `Record` (§2.2) — adding a version status makes `tsc` demand its
// variant here rather than defaulting. DRAFT/ACTIVE/SUPERSEDED deliberately
// keep §1's hues + icons because the words mean the same thing across the two
// Products surfaces; DRAFT takes WARNING, not info (D2, ui-context §10.1 — the
// mockup's info tint is rejected so DRAFT means one thing app-wide and info
// stays §1's TESTING hue). REJECTED gets a variant for TOTALITY though it is
// unreachable in this delivery (a failed upload inserts nothing, RC7) — present
// so the union is closed, not because the phase writes it (§1.42, D2).
export const RATE_CARD_STATUS_BADGE_VARIANTS: Record<
  RateCardVersionStatus,
  RateCardStatusBadgeVariant
> = {
  DRAFT: {
    label: "Draft",
    icon: PencilLine,
    className:
      "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
    muted: false,
  },
  ACTIVE: {
    label: "Active",
    icon: CheckCircle,
    className:
      "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
    muted: false,
  },
  SUPERSEDED: {
    label: "Superseded",
    icon: History,
    className:
      "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
    muted: true,
  },
  REJECTED: {
    label: "Rejected",
    icon: XCircle,
    className:
      "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
    muted: false,
  },
};

export function RateCardStatusBadge({
  status,
  className,
}: RateCardStatusBadgeProps): React.JSX.Element {
  const variant = RATE_CARD_STATUS_BADGE_VARIANTS[status];
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
