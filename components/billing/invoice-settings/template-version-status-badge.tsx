// bm55-spec §Design D4, code-standards Part 2 Styling rule 7, ui-context §10a —
// `TemplateVersionStatusBadge`, the ONE status treatment for invoice template
// and company-profile versions (bm56 reuses it; never fork a second one).
// `DRAFT` neutral outline, `ACTIVE` success, `RETIRED` muted (never danger —
// retiring is the normal result of activating a successor), plus a primary-
// outline `Default` chip with `Lock` when the version is the seeded default.
// Colour always pairs with an icon and a label (ui-context rendering rule).

import { Archive, CircleCheck, Lock, PencilLine } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { TemplateVersionStatus } from "@/types/billing";

const PILL =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider";

export const templateVersionStatusBadgeVariants = cva(PILL, {
  variants: {
    status: {
      DRAFT:
        "border border-[color:var(--color-neutral-500)] bg-[color:var(--surface-card)] text-[color:var(--color-neutral-700)]",
      ACTIVE:
        "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
      RETIRED:
        "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
    } satisfies Record<TemplateVersionStatus, string>,
  },
});

const STATUS_CONFIG = {
  DRAFT: { icon: PencilLine, label: "Draft" },
  ACTIVE: { icon: CircleCheck, label: "Active" },
  RETIRED: { icon: Archive, label: "Retired" },
} as const satisfies Record<
  TemplateVersionStatus,
  { icon: typeof Lock; label: string }
>;

export interface TemplateVersionStatusBadgeProps {
  status: TemplateVersionStatus;
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
