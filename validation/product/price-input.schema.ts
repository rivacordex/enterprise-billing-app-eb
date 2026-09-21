import { z } from "zod";

import {
  RECURRING_PERIOD_LENGTHS,
  RECURRING_PERIOD_TYPES,
  UNITS_OF_MEASURE,
  type RecurringPeriodLength,
} from "@/types/product";
import {
  moneyStringSchema,
  stepsSchema,
} from "@/validation/product/pricing-component.schema";

// pm47-spec D7/I2. Rebuilt to discriminate on `componentType`, not the
// deleted `priceType`/`pricingModel` axis. Each branch declares exactly the
// row columns and envelope `params` its component type may carry — the
// impossible combination is untypeable, not merely rejected (§2.8): a
// `usage_rate` price can never carry a recurring period pair, and a
// `flat_fee` (oneTime) price can never carry a unit of measure. The branches
// are `strictObject`s, so a forbidden field is an unrecognized key, not a
// silently-stripped one. pm46's per-`component_type` CHECKs are the backstop
// for a write that goes around this schema (Inv. #31/#32).
//
// `moneyStringSchema`/`stepsSchema` are imported from
// `pricing-component.schema.ts` rather than restated (§2.16 — no second copy
// of a rule) — the same money/step rules the envelope itself enforces.

// Charge-period length ∈ (1, 3, 12), built from pm37's RECURRING_PERIOD_LENGTHS
// so the value list has exactly one source. The type-guard predicate narrows
// the parsed output to `RecurringPeriodLength`, and the message names the rule.
const RECURRING_PERIOD_LENGTH_SET: ReadonlySet<number> = new Set(
  RECURRING_PERIOD_LENGTHS,
);
const recurringChargePeriodLengthSchema = z
  .number({ message: "A recurring price needs a charge period" })
  .refine(
    (value): value is RecurringPeriodLength =>
      RECURRING_PERIOD_LENGTH_SET.has(value),
    { message: "Charge period must be 1, 3 or 12 months" },
  );

const unitOfMeasureFieldSchema = z.enum(UNITS_OF_MEASURE, {
  message: "Choose a unit of measure for this price",
});

// Name, currency and GL code — the core every price-write branch shares
// (pm47-spec D7).
const priceInputCoreShape = {
  name: z
    .string()
    .trim()
    .min(1, "Price name is required")
    .max(200, "Price name must be 200 characters or fewer"),
  currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
  glCode: z
    .string()
    .trim()
    .max(50, "GL code must be 50 characters or fewer")
    .nullable()
    .default(null),
} as const;

// Exported as plain field-shape records (not assembled schemas) so
// insert-price composes them with its own `startDateTime` rule without
// re-declaring the per-type field requirements — the same pattern pm38
// established (pm47-spec D7).
export const USAGE_RATE_PRICE_INPUT_SHAPE = {
  componentType: z.literal("usage_rate"),
  unitOfMeasure: unitOfMeasureFieldSchema,
  params: z.strictObject({
    ratePerUnit: moneyStringSchema,
    rateCardLookUp: z.string().trim().min(1).nullable(),
  }),
  ...priceInputCoreShape,
} as const;

export const FLAT_FEE_RECURRING_PRICE_INPUT_SHAPE = {
  componentType: z.literal("flat_fee"),
  priceType: z.literal("recurring"),
  recurringChargePeriodLength: recurringChargePeriodLengthSchema,
  recurringChargePeriodType: z.enum(RECURRING_PERIOD_TYPES),
  params: z.strictObject({ amount: moneyStringSchema }),
  ...priceInputCoreShape,
} as const;

export const FLAT_FEE_ONE_TIME_PRICE_INPUT_SHAPE = {
  componentType: z.literal("flat_fee"),
  priceType: z.literal("oneTime"),
  params: z.strictObject({ amount: moneyStringSchema }),
  ...priceInputCoreShape,
} as const;

export const CAPACITY_COMMITMENT_PRICE_INPUT_SHAPE = {
  componentType: z.literal("capacity_commitment"),
  unitOfMeasure: unitOfMeasureFieldSchema,
  params: z.strictObject({
    committedQuantity: z.number().finite().positive(),
  }),
  ...priceInputCoreShape,
} as const;

export const CAPACITY_MOTIVATION_PRICE_INPUT_SHAPE = {
  componentType: z.literal("capacity_motivation"),
  unitOfMeasure: unitOfMeasureFieldSchema,
  params: z.strictObject({ steps: stepsSchema }),
  ...priceInputCoreShape,
} as const;

// Nested `z.discriminatedUnion`, not a plain `z.union` — a flat `z.union`
// collapses every branch's failures into one root-level `invalid_union`
// issue instead of pointing at the field that's actually wrong (post-review
// fix). `flat_fee`'s `recurring` and `oneTime` variants both carry the
// literal `componentType: 'flat_fee'`, so they can't occupy two slots of the
// outer discriminant map directly (Zod requires a unique literal per option)
// — but Zod resolves a discriminated union nested as one of the outer
// union's own options, provided every branch of the inner union still
// carries the outer key's literal. So `flat_fee` is one outer option: an
// inner `z.discriminatedUnion("priceType", …)` over its two variants. Each
// branch stays a `strictObject`, keeping the impossible field combinations
// untypeable (D7's actual requirement) while field-level errors now land on
// the offending key instead of the schema root.
const flatFeePriceInputSchema = z.discriminatedUnion("priceType", [
  z.strictObject(FLAT_FEE_RECURRING_PRICE_INPUT_SHAPE),
  z.strictObject(FLAT_FEE_ONE_TIME_PRICE_INPUT_SHAPE),
]);

export const priceInputSchema = z.discriminatedUnion("componentType", [
  z.strictObject(USAGE_RATE_PRICE_INPUT_SHAPE),
  flatFeePriceInputSchema,
  z.strictObject(CAPACITY_COMMITMENT_PRICE_INPUT_SHAPE),
  z.strictObject(CAPACITY_MOTIVATION_PRICE_INPUT_SHAPE),
]);

export type PriceInput = z.infer<typeof priceInputSchema>;
