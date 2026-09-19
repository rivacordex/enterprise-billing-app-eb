import { z } from "zod";

import {
  RECURRING_PERIOD_LENGTHS,
  RECURRING_PERIOD_TYPES,
  UNITS_OF_MEASURE,
  type RecurringPeriodLength,
} from "@/types/product";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";

// pm38-spec D1/I1. The impossible combination is made untypeable, not merely
// rejected: `priceInputSchema` discriminates on `priceType`, so each branch
// declares exactly the columns its type may carry. A recurring price that also
// names a unit of measure, or a `once` price carrying a charge period, is a
// compile error at every call site (code-standards §2.8) AND a runtime
// rejection here — the branches are `strictObject`s, so a forbidden field is an
// unrecognized key, not a silently-stripped one (verification checklist: "…are
// rejected by Zod and by the database"). The DB CHECKs shipped by pm35 are the
// backstop for a write that goes around this schema.

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

// Name, currency, GL code and the per-`pricing_model` characteristics — the
// core every price-write schema shares (pm38-spec D2). The amount-XOR-tiers
// (Inv. #5) and tier-contiguity (Inv. #4) rules stay defined exactly once, in
// pricing-characteristics.schema.ts; they are reused here, never re-declared.
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
  priceCharacteristics: priceCharacteristicsSchema,
} as const;

// Exported as plain field-shape records (not assembled schemas) so insert-price
// and update-price compose them with their own `startDateTime` rule without
// re-declaring the per-type field requirements (pm38-spec D2). Spreading the
// same field-schema instances into another `strictObject` is safe — Zod schemas
// are immutable and reusable.
export const RECURRING_PRICE_INPUT_SHAPE = {
  priceType: z.literal("recurring"),
  recurringChargePeriodLength: recurringChargePeriodLengthSchema,
  recurringChargePeriodType: z.enum(RECURRING_PERIOD_TYPES),
  ...priceInputCoreShape,
} as const;

export const USAGE_PRICE_INPUT_SHAPE = {
  priceType: z.literal("usage"),
  unitOfMeasure: z.enum(UNITS_OF_MEASURE, {
    message: "Choose a unit of measure for a usage price",
  }),
  ...priceInputCoreShape,
} as const;

export const ONCE_PRICE_INPUT_SHAPE = {
  priceType: z.literal("once"),
  ...priceInputCoreShape,
} as const;

export const priceInputSchema = z.discriminatedUnion("priceType", [
  z.strictObject(RECURRING_PRICE_INPUT_SHAPE),
  z.strictObject(USAGE_PRICE_INPUT_SHAPE),
  z.strictObject(ONCE_PRICE_INPUT_SHAPE),
]);

export type PriceInput = z.infer<typeof priceInputSchema>;
