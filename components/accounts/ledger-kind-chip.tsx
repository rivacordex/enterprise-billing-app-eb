// Ledger account kind chip (ac06-spec §2.1/§3.2, ui-context §1.2). Extracted
// so the picker, transfers grid, and transfer-detail drawer render a
// `ban.*`/`fa.*`/`sys.*` account the same way everywhere (radius-pill, §4).

import { cn } from "@/lib/utils";
import type { LedgerAccountKind } from "@/types/accounts";

const KIND_LABEL: Record<LedgerAccountKind, string> = {
  ban: "BAN",
  fa: "FA",
  sys: "SYS",
};

const KIND_CLASS: Record<LedgerAccountKind, string> = {
  ban: "bg-[color:var(--acct-chip-ban-bg)] text-[color:var(--acct-chip-ban-fg)]",
  fa: "bg-[color:var(--acct-chip-fa-bg)] text-[color:var(--acct-chip-fa-fg)]",
  sys: "bg-[color:var(--acct-chip-sys-bg)] text-[color:var(--acct-chip-sys-fg)]",
};

export interface LedgerKindChipProps {
  kind: LedgerAccountKind;
  className?: string;
}

export function LedgerKindChip({
  kind,
  className,
}: LedgerKindChipProps): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase",
        KIND_CLASS[kind],
        className,
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
