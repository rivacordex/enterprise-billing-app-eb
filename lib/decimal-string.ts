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
  // Anchored at the end and only reached when a fractional part exists, so the
  // strip can never reach an integer digit ("100100" returned above).
  return value.replace(/0+$/, "").replace(/\.$/, "");
}
