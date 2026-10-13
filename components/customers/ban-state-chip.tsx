// cm20 (custmgmt-ui-context §9.2) — Financial / Billing Account state pill
// (both use the same account states), mapped per
// acctmgmt-ui-context §2 (account active → success, suspended → warning,
// closed → neutral). No shared account-state badge exists to reuse.

import { Ban, CheckCircle2, PauseCircle } from "lucide-react";
import { cva } from "class-variance-authority";

import type { AccountState } from "@/types/accounts";

const chipVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      state: {
        active:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        suspended:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        closed:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-600)]",
      } satisfies Record<AccountState, string>,
    },
  },
);

const CHIP_CONFIG: Record<
  AccountState,
  { icon: typeof CheckCircle2; label: string }
> = {
  active: { icon: CheckCircle2, label: "Active" },
  suspended: { icon: PauseCircle, label: "Suspended" },
  closed: { icon: Ban, label: "Closed" },
};

export interface BanStateChipProps {
  state: AccountState;
}

export function BanStateChip({ state }: BanStateChipProps): React.JSX.Element {
  const { icon: Icon, label } = CHIP_CONFIG[state];
  return (
    <span className={chipVariants({ state })}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}
