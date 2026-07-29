// The only place money arithmetic is implemented (code-standards §2.2).
// Amounts stay `string` end-to-end; arithmetic converts to integer sen (minor
// units), operates there, and returns `string`.

export class MoneyPrecisionError extends Error {
  readonly code = "MONEY_PRECISION";
  constructor(amount: string) {
    super(`MONEY_PRECISION: amount '${amount}' has more than 2 decimal places`);
  }
}

// Converts a numeric string (e.g. "1234.56", "-500.00", "0") to integer sen.
// Throws MoneyPrecisionError on > 2 decimal places.
export function stringToSen(amount: string): bigint {
  const trimmed = amount.trim();
  const dotIdx = trimmed.indexOf(".");
  if (dotIdx === -1) {
    return BigInt(trimmed) * 100n;
  }
  const decimals = trimmed.length - dotIdx - 1;
  if (decimals > 2) {
    throw new MoneyPrecisionError(amount);
  }
  const intPart = trimmed.slice(0, dotIdx);
  const decPart = trimmed.slice(dotIdx + 1).padEnd(2, "0");
  const sign = intPart.startsWith("-") ? -1n : 1n;
  const absInt = BigInt(intPart.replace("-", ""));
  const absDec = BigInt(decPart);
  return sign * (absInt * 100n + absDec);
}

// Converts integer sen back to a formatted "1234.56" / "-1234.56" string.
export function senToString(sen: bigint): string {
  const negative = sen < 0n;
  const abs = negative ? -sen : sen;
  const intPart = abs / 100n;
  const decPart = abs % 100n;
  const formatted = `${intPart}.${String(decPart).padStart(2, "0")}`;
  return negative ? `-${formatted}` : formatted;
}

export function add(a: string, b: string): string {
  return senToString(stringToSen(a) + stringToSen(b));
}

export function subtract(a: string, b: string): string {
  return senToString(stringToSen(a) - stringToSen(b));
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const diff = stringToSen(a) - stringToSen(b);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

// pgledger balances are signed (debit − credit).
// Debit-normal (receivables): positive sen = open A/R.
export function openReceivable(balance: string): bigint {
  return stringToSen(balance);
}

// Credit-normal (unapplied_cash, deposits): we hold funds when balance < 0.
export function isHeldLiability(balance: string): boolean {
  return stringToSen(balance) < 0n;
}
