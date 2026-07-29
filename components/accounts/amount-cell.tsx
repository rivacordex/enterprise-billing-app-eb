// Right-aligned money cell (acctmgmt-ui-context.md §3, code-standards §4.1).
// Never a raw `< 0` comparison here — sign is communicated by parentheses and
// --acct-amount-negative color only. Currency code is from the row, never
// hard-coded. 2 dp always; tabular-nums for column alignment.

import { cn } from "@/lib/utils";

export interface AmountCellProps {
  amount: string;
  currency: string;
  className?: string;
}

function formatAmount(amount: string): {
  display: string;
  negative: boolean;
} {
  const num = Number(amount);
  const negative = num < 0;
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return { display: negative ? `(${formatted})` : formatted, negative };
}

export function AmountCell({
  amount,
  currency,
  className,
}: AmountCellProps): React.JSX.Element {
  const { display, negative } = formatAmount(amount);

  return (
    <span
      className={cn(
        "block text-right font-[tabular-nums] text-body",
        negative
          ? "text-[color:var(--acct-amount-negative)]"
          : "text-[color:var(--acct-amount)]",
        className,
      )}
    >
      <span className="mr-1 text-body-sm text-[color:var(--text-muted)]">
        {currency}
      </span>
      {display}
    </span>
  );
}
