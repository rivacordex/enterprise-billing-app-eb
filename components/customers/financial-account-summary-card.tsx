// cm20 (custmgmt-ui-context §9.2) — the Financial Account summary: id and the
// three live balances. Display only; values come from the read service.

import { AmountCell } from "@/components/accounts/amount-cell";
import { BanStateChip } from "@/components/customers/ban-state-chip";
import { cn } from "@/lib/utils";
import type { AccountState } from "@/types/accounts";

export interface FinancialAccountSummaryCardProps {
  financialAccountId: string;
  state: AccountState;
  currency: string;
  receivableBalance: string;
  unappliedCashBalance: string;
  depositBalance: string;
}

function Amount({
  label,
  amount,
  currency,
}: {
  label: string;
  amount: string;
  currency: string;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5">
        <AmountCell amount={amount} currency={currency} className="text-left" />
      </dd>
    </div>
  );
}

export function FinancialAccountSummaryCard({
  financialAccountId,
  state,
  currency,
  receivableBalance,
  unappliedCashBalance,
  depositBalance,
}: FinancialAccountSummaryCardProps): React.JSX.Element {
  return (
    <section
      aria-label={`Financial account ${financialAccountId}`}
      className={cn(
        "rounded-md border border-border bg-[color:var(--surface-card)] p-4",
        state === "closed" && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-h3 font-semibold text-foreground">
          Financial Account{" "}
          <span className="font-mono text-mono">{financialAccountId}</span>
        </h2>
        <BanStateChip state={state} />
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Amount
          label="Receivable"
          amount={receivableBalance}
          currency={currency}
        />
        <Amount
          label="Unapplied cash"
          amount={unappliedCashBalance}
          currency={currency}
        />
        <Amount label="Deposits" amount={depositBalance} currency={currency} />
      </dl>
    </section>
  );
}
