import {
  insertPriceSchema,
  type InsertPriceInput,
} from "@/validation/product/insert-price.schema";

// pm38-spec D2/I2. A DRAFT price's start date is editable, so the update shape
// is IDENTICAL to insert — the same discriminated core plus the same
// `startDateTime` composition. Re-exported rather than re-declared so the two
// can never drift; if a future rule ever makes update diverge from insert (e.g.
// forbidding a priceType change), split this into its own union at that point.
export const updatePriceSchema = insertPriceSchema;
export type UpdatePriceInput = InsertPriceInput;
