// Permanent zero-sum strip (ac06-spec §2.4, code-standards §4.1, ui-context
// §1.1/§4) — V1 (module inv. #1, Σ balance = 0 per currency) surfaced live in
// the UI, "the page's most reassuring pixel." Full-bleed, `--radius-none`,
// force-dynamic on every page load — it never caches. Green when every
// currency is zero; `bg-destructive` the moment any currency isn't (a
// five-alarm signal since the ledger is zero-sum by construction).

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { ZeroSumRow } from "@/types/accounts";

export interface BalanceCheckStripProps {
  balances: ZeroSumRow[];
  className?: string;
}

export function BalanceCheckStrip({
  balances,
  className,
}: BalanceCheckStripProps): React.JSX.Element {
  const allOk = balances.every((b) => b.ok);

  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-8 gap-y-2 px-4 py-3",
        allOk
          ? "bg-[color:var(--acct-balance-ok)] text-white"
          : "bg-destructive text-destructive-foreground",
        className,
      )}
    >
      {balances.length === 0 ? (
        <span className="text-body-sm">
          No ledger accounts yet — nothing to verify.
        </span>
      ) : (
        balances.map((b) => (
          <span key={b.currency} className="flex items-center gap-2">
            {b.ok ? (
              <CheckCircle2 size={16} aria-hidden />
            ) : (
              <AlertTriangle size={16} aria-hidden />
            )}
            <span className="text-overline font-semibold tracking-wider uppercase">
              {b.currency} Σ
            </span>
            <span className="font-[tabular-nums] text-h4 font-semibold">
              {b.ok ? "0.00" : b.total}
            </span>
          </span>
        ))
      )}
    </div>
  );
}
