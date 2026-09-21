import { z } from "zod";

import {
  CAPACITY_COMMITMENT_PRICE_INPUT_SHAPE,
  CAPACITY_MOTIVATION_PRICE_INPUT_SHAPE,
  FLAT_FEE_ONE_TIME_PRICE_INPUT_SHAPE,
  FLAT_FEE_RECURRING_PRICE_INPUT_SHAPE,
  USAGE_RATE_PRICE_INPUT_SHAPE,
} from "@/validation/product/price-input.schema";

// 3-day backdating tolerance (Design; prodmgmt-architecture §6 Inv. #2). This
// is the single module-local source (pm38-spec I2 — "do not duplicate the
// tolerance constant a third time"): update-price.schema.ts imports it and the
// `startDateTimeField` below rather than declaring a fourth copy. The service
// layer's authoritative, transaction-time check (services/product/insert-price.ts
// and update-price.ts) keeps its own value against an injectable `now`.
export const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

// Fast-fail, parse-time backdating check (Design). `.refine`'s predicate runs
// on every parse, so `Date.now()` is evaluated fresh, never frozen at module
// load; the error lands on the `startDateTime` path. The authoritative check is
// in services/product/insert-price.ts against an injectable `now`. Shared with
// update-price.schema.ts so a DRAFT price's start date obeys the same rule.
export const startDateTimeField = z.coerce
  .date()
  .refine((value) => Date.now() - value.getTime() <= THREE_DAYS_MS, {
    message: "Start date cannot be more than 3 days in the past.",
  });

// pm47-spec D7/I2. Composes the price-input branches (price-input.schema.ts)
// with `startDateTime`. Each branch stays a `strictObject`, so a field
// forbidden for the chosen `componentType` is still rejected once composed.
// A nested `z.discriminatedUnion`, matching price-input.schema.ts's own
// composition (post-review fix) — the inner `flat_fee` union discriminates
// on `priceType` since its recurring/oneTime branches share one
// `componentType` literal and can't be discriminated on it alone.
const flatFeeInsertPriceSchema = z.discriminatedUnion("priceType", [
  z.strictObject({
    ...FLAT_FEE_RECURRING_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
  z.strictObject({
    ...FLAT_FEE_ONE_TIME_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
]);

export const insertPriceSchema = z.discriminatedUnion("componentType", [
  z.strictObject({
    ...USAGE_RATE_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
  flatFeeInsertPriceSchema,
  z.strictObject({
    ...CAPACITY_COMMITMENT_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
  z.strictObject({
    ...CAPACITY_MOTIVATION_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
]);

export type InsertPriceInput = z.infer<typeof insertPriceSchema>;
