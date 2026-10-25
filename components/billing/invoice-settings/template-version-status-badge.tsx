// bm55-spec §Design D4, code-standards Part 2 Styling rule 7, ui-context §10a —
// `TemplateVersionStatusBadge`, the ONE status treatment for invoice template
// and company-profile versions (bm56 reuses it; never fork a second one).
// `DRAFT` neutral outline, `ACTIVE` success, `RETIRED` muted (never danger —
// retiring is the normal result of activating a successor), plus a primary-
// outline `Default` chip with `Lock` when the version is the seeded default.
// Colour always pairs with an icon and a label (ui-context rendering rule).
// bm77 (Styling rule 2) — it also renders the three derived TYPE states:
// `USABLE` uses the ACTIVE style, `NOT_YET_USABLE` the DRAFT outline, and
// `RETIRED` is shared. Still the one status component.

import { Archive, CircleCheck, Lock, PencilLine } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type {
  TemplateTypeStatus,
  TemplateVersionStatus,
} from "@/types/billing";

type BadgeStatus = TemplateVersionStatus | TemplateTypeStatus;

const DRAFT_CLASSES =
  "border border-[color:var(--color-neutral-500)] bg-[color:var(--surface-card)] text-[color:var(--color-neutral-700)]";
const ACTIVE_CLASSES =
  "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]";

const PILL =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider";

export const templateVersionStatusBadgeVariants = cva(PILL, {
  variants: {
    status: {
      DRAFT: DRAFT_CLASSES,
      ACTIVE: ACTIVE_CLASSES,
      RETIRED:
        "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
      USABLE: ACTIVE_CLASSES,
      NOT_YET_USABLE: DRAFT_CLASSES,
    } satisfies Record<BadgeStatus, string>,
  },
});

const STATUS_CONFIG = {
  DRAFT: { icon: PencilLine, label: "Draft" },
  ACTIVE: { icon: CircleCheck, label: "Active" },
  RETIRED: { icon: Archive, label: "Retired" },
  USABLE: { icon: CircleCheck, label: "Usable" },
  NOT_YET_USABLE: { icon: PencilLine, label: "Not yet usable" },
} as const satisfies Record<BadgeStatus, { icon: typeof Lock; label: string }>;

export interface TemplateVersionStatusBadgeProps {
  status: BadgeStatus;
  isDefault?: boolean;
  className?: string;
}

export function TemplateVersionStatusBadge({
  status,
  isDefault = false,
  className,
}: TemplateVersionStatusBadgeProps): React.JSX.Element {
  const { icon: Icon, label } = STATUS_CONFIG[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <span
        data-status={status}
        className={templateVersionStatusBadgeVariants({ status })}
      >
        <Icon size={12} aria-hidden="true" />
        {label}
      </span>
      {isDefault ? (
        <span
          data-default="true"
          className={cn(
            PILL,
            "border border-[color:var(--color-primary-500)] bg-[color:var(--surface-card)] text-[color:var(--color-primary-700)]",
          )}
        >
          <Lock size={12} aria-hidden="true" />
          Default
        </span>
      ) : null}
    </span>
  );
}
