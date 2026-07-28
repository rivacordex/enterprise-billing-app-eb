// Payment-status badge (acctmgmt-ui-context.md §2, code-standards §4.1).
// Renders the stored payment_status PLUS the derived-overdue flag passed as a
// prop. The component never computes overdue — that is the service's job.
// When derivedOverdue is true, the badge shows "Overdue" (Danger family)
// regardless of the stored status.

import { AlertTriangle, CheckCircle, Clock, HelpCircle } from "lucide-react";
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils";
import type { PaymentStatus } from "@/types/accounts";

type BadgeVariant = PaymentStatus | "overdue";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      variant: {
        paid: "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        due: "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        in_dispute:
          "bg-[color:var(--color-info-50)] text-[color:var(--color-info-700)]",
        overdue:
          "bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]",
      } satisfies Record<BadgeVariant, string>,
    },
  },
);

const BADGE_CONFIG: Record<
  BadgeVariant,
  { icon: typeof CheckCircle; label: string }
> = {
  paid: { icon: CheckCircle, label: "Paid" },
  due: { icon: Clock, label: "Due" },
  in_dispute: { icon: HelpCircle, label: "In dispute" },
  overdue: { icon: AlertTriangle, label: "Overdue" },
};

export interface PaymentStatusBadgeProps {
  paymentStatus: PaymentStatus;
  // Derived at read time by the service (Q8, Inv. #2) — the component never
  // computes this. When true, Overdue rendering takes precedence.
  derivedOverdue: boolean;
  className?: string;
}

export function PaymentStatusBadge({
  paymentStatus,
  derivedOverdue,
  className,
}: PaymentStatusBadgeProps): React.JSX.Element {
  const variant: BadgeVariant = derivedOverdue ? "overdue" : paymentStatus;
  const { icon: Icon, label } = BADGE_CONFIG[variant];

  return (
    <span className={cn(badgeVariants({ variant }), className)}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
