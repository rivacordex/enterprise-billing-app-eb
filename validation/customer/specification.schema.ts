import { z } from "zod";

// Well-formedness only (Module Inv. #7): any plain object with string keys
// and arbitrary values, rejecting arrays/primitives at the top level. No
// key/shape enforcement — `CUST_TYPE`/`PARTY_TYPE`/`CUST_KEY` are just
// conventional keys, not required ones.
export const specificationSchema = z.record(z.string(), z.unknown());
export type PartyRoleSpecification = z.infer<typeof specificationSchema>;

export type SpecificationParseResult =
  | { ok: true; value: PartyRoleSpecification }
  | { ok: false };

export function parseSpecificationInput(raw: string): SpecificationParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const result = specificationSchema.safeParse(parsed);
  return result.success ? { ok: true, value: result.data } : { ok: false };
}
