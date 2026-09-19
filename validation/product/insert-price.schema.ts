import { z } from "zod";

import {
  ONCE_PRICE_INPUT_SHAPE,
  RECURRING_PRICE_INPUT_SHAPE,
  USAGE_PRICE_INPUT_SHAPE,
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

// pm38-spec I2. Composes the discriminated price-input branches (price-input
// .schema.ts) with `startDateTime`. Each branch stays a `strictObject`, so a
// field forbidden for the chosen `priceType` is still rejected once composed.
export const insertPriceSchema = z.discriminatedUnion("priceType", [
  z.strictObject({
    ...RECURRING_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
  z.strictObject({
    ...USAGE_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
  z.strictObject({
    ...ONCE_PRICE_INPUT_SHAPE,
    startDateTime: startDateTimeField,
  }),
]);

export type InsertPriceInput = z.infer<typeof insertPriceSchema>;
