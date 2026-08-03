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

// Pure string manipulation — no `Number()`/`parseFloat()` on the amount
// (code-standards §2.2, ac17 grep-gate: money arithmetic/formatting outside
// money.ts must never touch a float). `amount` is always a well-formed
// `numeric(18,2)`-derived string ("1234.56" / "-1234.56" / "0.00"), so sign
// and grouping are derived directly from the text.
function formatAmount(amount: string): {
  display: string;
  negative: boolean;
} {
  const trimmed = amount.trim();
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholePart = "0", fractionPart = ""] = unsigned.split(".");
  const fraction = fractionPart.padEnd(2, "0").slice(0, 2);
  const grouped = wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = `${grouped}.${fraction}`;
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
