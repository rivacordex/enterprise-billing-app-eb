import { z } from "zod";

// Rating-owned decimal-string validators for the udr_rate_detail wire
// contract. Deliberately NOT imported from validation/product: the rm19
// rp.py mirror must match these exactly, so a product-side edit must never
// change them. Bounds mirror the storage columns — rate/amount are
// numeric(18,6), quantity is numeric(20,6) — and RP's fail-closed
// "no silent round" rule (_exceeds_scale, scale 6). Unsigned, plain decimal
// (no exponent, no leading dot, no whitespace/newline, ASCII digits only).
export const SCALE = 6;

export const rateMoneyStringSchema = z
  .string()
  .regex(
    /^\d{1,12}(\.\d{1,6})?$/,
    'Must be a plain decimal with at most 12 integer and 6 fractional digits (e.g. "100" or "12.500000")',
  );

export const quantityStringSchema = z
  .string()
  .regex(
    /^\d{1,14}(\.\d{1,6})?$/,
    'Must be a plain decimal with at most 14 integer and 6 fractional digits (e.g. "20" or "1.500000")',
  );

// Exact scaled-integer value (value * 10^SCALE) of a string that already
// passed one of the schemas above. BigInt — never a float path.
export function toScaled(value: string): bigint {
  const [int, frac = ""] = value.split(".");
  return BigInt(int + frac.padEnd(SCALE, "0"));
}
