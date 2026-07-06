import { z } from "zod";

// Flat string record (pm02-spec Design #9) — exactly what the specifications
// panel renders as key-value chips (e.g. `{"SST_ID": "01"}`); numbers are
// stored as strings. Empty object `{}` is allowed (a spec with no
// characteristics).
export const productSpecCharacteristicsSchema = z.record(
  z.string().min(1),
  z.string(),
);
export type ProductSpecCharacteristics = z.infer<
  typeof productSpecCharacteristicsSchema
>;
