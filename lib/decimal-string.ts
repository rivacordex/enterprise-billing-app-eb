// Canonical decimal-string normalization. Pure, dependency-free, string in →
// string out (pm69-spec D2, code-standards §1.52 / §2.31, Inv. #68). node-
// postgres returns a `numeric(18,6)` / `numeric(20,6)` column at its full
// declared scale ("100.000000"); the `PricingComponent` envelope never carried
// that padding, so the one reader that reassembles an envelope from rows
// (db/repositories/product-offering-price.ts `toEnvelope`, pm71) strips it
// through here. This is the only function in the codebase that edits a money
// string's text.
//
// Like a numeric read, it removes redundant leading integer zeros (keeping
// one zero for values below one) and trailing fractional zeros. It never
// rounds, removes significant digits, pads, or parses to `number`. Anything that is
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
  const normalized = value.replace(/^0+(?=\d)/, "");
  return normalized.includes(".")
    ? normalized.replace(/0+$/, "").replace(/\.$/, "")
    : normalized;
}
