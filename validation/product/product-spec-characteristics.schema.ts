import { z } from "zod";

// Flat string record (pm02-spec Design #9) — exactly what the specifications
// panel renders as key-value chips (e.g. `{"SST_ID": "01"}`); numbers are
// stored as strings. Empty object `{}` is allowed (a spec with no
// characteristics).
//
// pm69 D5 (§1.55): a characteristic name must not be all digits. JavaScript
// hoists integer-like keys ("2", "10") ahead of every other key regardless of
// insertion order, so `Object.entries` — which derives `display_order`
// (pm72, Inv. #66) — could not honour entry order for them. `^\d+$` is a
// deliberate superset of the hazard (it also refuses "02"), chosen because it
// is the simpler rule to state. `validation/characteristics.schema.ts` (the
// ordering/inventory copy) is intentionally not changed.
export const productSpecCharacteristicsSchema = z.record(
  z
    .string()
    .min(1)
    .refine((k) => !/^\d+$/.test(k), {
      message: "Characteristic name must not be all digits",
    }),
  z.string(),
);
export type ProductSpecCharacteristics = z.infer<
  typeof productSpecCharacteristicsSchema
>;
