// Canonical decimal-string normalization. Pure, dependency-free, string in →
// string out (pm69-spec D2, code-standards §1.52 / §2.31, Inv. #68). node-
// postgres returns a `numeric(18,6)` / `numeric(20,6)` column at its full
// declared scale ("100.000000"); the `PricingComponent` envelope never carried
// that padding, so the one reader that reassembles an envelope from rows
// (db/repositories/product-offering-price.ts `toEnvelope`, pm71) strips it
// through here. This is the only function in the codebase that edits a money
// string's text.
//
// It strips trailing fractional zeros (and a `.` left behind) and nothing
// else: it never rounds, never truncates a significant digit, never touches an
// integer digit, never pads, and never parses to `number`. Anything that is
// not a plain unsigned decimal — a sign, an exponent, a thousands separator,
// whitespace, a bare `.` on either side — throws a `TypeError`: the caller
// treats a row set that does not reassemble as corruption (§1.49), and a
// helper that passed the garbage through would hide exactly that.
const PLAIN_DECIMAL_RE = /^\d+(\.\d+)?$/;

export function canonicalDecimalString(value: string): string {
  if (!PLAIN_DECIMAL_RE.test(value)) {
    throw new TypeError(
      `canonicalDecimalString: ${JSON.stringify(value)} is not a plain unsigned decimal string`,
    );
  }
  if (!value.includes(".")) {
    return value;
  }
  // Only reached when a fractional part exists, so the scan back from the end
  // stops at the `.` at the latest and can never reach an integer digit
  // ("100100" returned above). A linear scan rather than `/0+$/`, which
  // backtracks quadratically on a long zero run that is not at the end.
  let end = value.length;
  while (value[end - 1] === "0") end--;
  if (value[end - 1] === ".") end--;
  return value.slice(0, end);
}
