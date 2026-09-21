import { z } from "zod";

import { UNITS_OF_MEASURE } from "@/types/product";

// ---------------------------------------------------------------------------
// The component envelope — pm47-spec D1/D11. This file is the module's single
// source of truth for a price: what a `product_offering_price.price_component`
// value may contain, and what it means. `db/schema/product.ts` consumes only
// the inferred `PricingComponent` type (`$type<PricingComponent>()`); pm46's
// six database CHECKs (`db/migrations/0006_product.sql`) mirror this file's
// rules as a backstop, never the other way around — Zod is the primary guard,
// the database refuses independently (Inv. #31/#32).
//
// The envelope is exactly eight fields over exactly five `@type` values. A
// ninth field or a sixth type is a new phase, not a unit (pm47-spec §1.32):
//
//   @type        — discriminant; one of the five branches below.
//   specVersion  — literal `1` on every branch, required (never optional).
//                  The forward-migration hook: a shape change without
//                  incrementing it is a breaking change disguised as a patch.
//   plaSpecId    — the `plaSpec` catalog entry (below) this component's
//                  pricing-logic algorithm implements, or `null` for a
//                  component priced by a plain scalar (no algorithm).
//   priceType    — the TMF620 pricing axis (`usage` | `recurring` | `oneTime`
//                  | `discount` | `commitment`). Deliberately NOT the same
//                  axis as the (deleted) row-level `PriceType` from before
//                  this unit and the module's `EnvelopePriceType` — see the
//                  comment on `EnvelopePriceType` in `types/product.ts`
//                  (pm47-spec D8): the two must never be equated, mapped onto
//                  each other, or derived from each other.
//   appliesAt    — the pricing stage this component is evaluated at
//                  (`rating` | `billing` | `post_aggregation`).
//   basis        — what the component is computed against (`quantity` |
//                  `flat`).
//   boundTo      — `{ unitOfMeasure }` for a component that prices a metered
//                  quantity, or `null` for one that doesn't (`flat_fee`). The
//                  one exception is `negotiated_override`, whose `boundTo`
//                  also carries the `priceType` of the component it overrides
//                  — the only place `priceType` appears inside `boundTo`.
//   params       — the branch's own numeric/rate payload. Money is always a
//                  decimal string (`moneyStringSchema`, declared once below);
//                  quantities are always JS numbers, never numeric strings.
//
// No `sequence` field: apply order is canonical by stage then class
// (pm47-spec PC12, Inv. #37) — a deliberate omission, not a gap.
//
// -- The `plaSpec` catalog (PC11) ------------------------------------------
//
// One entry per `@type`. `plaSpecId` names the entry a component's algorithm
// implements; a component with `plaSpecId: null` is priced by a plain scalar
// and consumes no `plaSpec`.
//
//   PLA_USAGE_RATE
//     Means:    a per-unit rate applied to a rated usage quantity, optionally
//               resolved through a named rate card rather than a flat scalar.
//     Consumes: `params.ratePerUnit` (the scalar/fallback rate) and
//               `params.rateCardLookUp` (a rate-card NAME, never a reference —
//               PC10, Inv. #42: no FK, no join, no table, no resolution logic
//               lives here or anywhere in this file).
//     Produces: a per-unit charge at the `rating` stage.
//     Stage:    `rating`.
//     Used by:  `usage_rate` components with a non-null `rateCardLookUp`.
//               `usage_rate` components with `rateCardLookUp: null` price
//               directly off `params.ratePerUnit` and carry `plaSpecId: null`
//               (D4's cross-field refinement, enforced inside the branch).
//
//   PLA_CAPACITY_COMMITMENT
//     Means:    a fixed charge for a pre-committed usage quantity, billed
//               regardless of whether the commitment is consumed.
//     Consumes: `params.committedQuantity` (a finite number > 0, VI2).
//     Produces: a flat charge at the `post_aggregation` stage, applied before
//               `capacity_motivation` in the transform pipeline (PC12) — a
//               commitment that is exceeded still prices the topped-up units
//               through the motivation schedule below it, which is what makes
//               the pipeline ordering correct rather than coincidental.
//     Stage:    `post_aggregation`.
//     Used by:  `capacity_commitment` components (always this `plaSpecId`).
//
//   PLA_CAPACITY_MOTIVATION
//     Means:    a step-priced discount/incentive schedule over an aggregated
//               usage quantity — each unit above a threshold is priced at
//               that step's rate.
//     Consumes: `params.steps` (VI1: non-empty, strictly ascending and
//               non-duplicate on `aboveQuantity > 0`, each `ratePerUnit` a
//               money string).
//     Produces: a tiered discount applied at the `post_aggregation` stage,
//               after `capacity_commitment` (PC12).
//     Stage:    `post_aggregation`.
//     Used by:  `capacity_motivation` components (always this `plaSpecId`).
//
//   (no plaSpec — flat_fee)
//     Means:    a scalar charge with no algorithm: `params.amount`, once
//               (`oneTime`) or on the row's own recurring period
//               (`recurring`, carried by the ROW columns
//               `recurring_charge_period_length`/`_type`, not the envelope —
//               those two columns are unchanged by this unit).
//     Consumes: `params.amount` (a money string).
//     Produces: a flat charge at the `billing` stage.
//     Stage:    `billing`.
//     Used by:  `flat_fee` components (always `plaSpecId: null`).
//
//   (no plaSpec — negotiated_override)
//     Means:    a manually negotiated, insert-only replacement rate for one
//               order item's `usage_rate` price, approved by a MANAGER
//               (pm30). Not a member of `ComponentType` (pm47-spec D3,
//               Inv. #39) — its physical row lives in
//               `ordering.order_item_price_override`, never in
//               `product.product_offering_price`. Exists in this union solely
//               so the TMF projection and this catalog are complete.
//     Consumes: `params.ratePerUnit` (a money string) and `boundTo.priceType`
//               (fixed to `usage` — the only price a negotiated override may
//               replace in this phase).
//     Produces: a per-unit charge at the `rating` stage, in place of the
//               `usage_rate` component it overrides.
//     Stage:    `rating`.
//     Used by:  `negotiated_override` only.
//
// -- TMF620 mapping table ----------------------------------------------------
//
//   This module's shape          | TMF620 concept
//   ----------------------------- | ------------------------------------------
//   one price component row       | one ProductOfferingPrice "POP"
//   `@type`                       | `@type` (the discriminant carries over
//                                   directly — this is the field TMF620 itself
//                                   uses to type a polymorphic resource)
//   `params` (algorithmic branch) | `pricingLogicAlgorithm[]` + `plaSpecId`
//                                   (this file's `plaSpec` catalog above is
//                                   that algorithm's out-of-band description —
//                                   TMF620 does not standardize algorithm
//                                   bodies, only that a POP may reference one)
//   `params` (plain branch)       | POP `price` = `Money { value, unit }`
//   `priceType`                   | TMF620 `priceType`, with `commitment` as a
//                                   documented **extension** — TMF620's own
//                                   enumeration does not define it
//   `boundTo`                     | `popRelationship[]` (the relationship a
//                                   component declares to the price/unit it is
//                                   bound to)
//   money string + `currency`     | `Money { value, unit }` — `currency` is a
//   (row column)                    row column, never envelope data
//   `unit_of_measure` (row column) | `Quantity` — likewise a row column, never
//                                   envelope data; the *only* echo of it inside
//                                   the envelope is `boundTo.unitOfMeasure`,
//                                   which exists solely to resolve a
//                                   modifier's binding (PC3/PC4)
//   `capacity_motivation.steps`    | the PLA's own algorithm params
//   `negotiated_override`          | `ProductPrice.priceAlteration` on the
//                                   order (TMF622), not a POP at all
//
//   PC10's rate-card precedence (recorded here, nowhere else — building any of
//   it would be the rate-card phase leaking into this one): when
//   `rateCardLookUp` names a card, resolution is (1) that card's own entry for
//   the priced unit, else (2) that card's "default" entry, else (3) falls back
//   to `params.ratePerUnit`; when `rateCardLookUp` is `null`, resolution is
//   always `params.ratePerUnit` directly. No FK, join, table, or fallback
//   logic exists in this codebase to enact this precedence — `rateCardLookUp`
//   is parsed here as a plain nullable string and nothing more.
//
//   Compliance verdict: this module is structurally aligned with TMF620's
//   POP/PLA concepts, not literally TMF620-conformant — there is no TMF620
//   SDK, adapter, mapper, serializer, DTO, `toTmf620()` or `app/api/product*`
//   in this phase or any other (Inv. #40). This doc-block *is* the compliance
//   artifact.
// ---------------------------------------------------------------------------

const unitOfMeasureSchema = z.enum(UNITS_OF_MEASURE);

// Money is a decimal string, never a float, declared exactly once and reused
// by every money field in this file (pm47-spec D5). This module performs no
// money arithmetic.
export const moneyStringSchema = z
  .string()
  .regex(
    /^\d+(\.\d+)?$/,
    'Must be a plain decimal amount (e.g. "100" or "12.50")',
  );

export const stepSchema = z.strictObject({
  aboveQuantity: z.number().finite().positive(),
  ratePerUnit: moneyStringSchema,
});
export type Step = z.infer<typeof stepSchema>;

// VI1: `steps` is non-empty, and `aboveQuantity` strictly ascends with no
// duplicates (a step is a threshold, not a bounded band — unlike the deleted
// `tierSchema`'s contiguity rule, a step needs only strict ascent, not
// `to === next.from`). One issue per offending index, naming the threshold it
// failed to clear.
export const stepsSchema = z
  .array(stepSchema)
  .min(1, "At least one step is required")
  .superRefine((steps, ctx) => {
    for (let index = 1; index < steps.length; index += 1) {
      const previous = steps[index - 1]!;
      const current = steps[index]!;
      if (current.aboveQuantity <= previous.aboveQuantity) {
        ctx.addIssue({
          code: "custom",
          message: `Step ${index} (aboveQuantity ${current.aboveQuantity}) must strictly exceed the previous step's threshold (${previous.aboveQuantity}) — steps must ascend with no duplicates.`,
          path: [index, "aboveQuantity"],
        });
      }
    }
  });

// -- The four persistable branches (pm47-spec D2) ---------------------------

export const usageRateComponentSchema = z
  .strictObject({
    "@type": z.literal("usage_rate"),
    specVersion: z.literal(1),
    plaSpecId: z.literal("PLA_USAGE_RATE").nullable(),
    priceType: z.literal("usage"),
    appliesAt: z.literal("rating"),
    basis: z.literal("quantity"),
    boundTo: z.strictObject({ unitOfMeasure: unitOfMeasureSchema }),
    params: z.strictObject({
      ratePerUnit: moneyStringSchema,
      rateCardLookUp: z.string().trim().min(1).nullable(),
    }),
  })
  // D4: `plaSpecId` is a cross-field refinement, never a caller's choice — a
  // card-driven rate (`rateCardLookUp` non-null) MUST carry `PLA_USAGE_RATE`;
  // a plain scalar rate (`rateCardLookUp: null`) MUST carry `plaSpecId: null`.
  // Living inside this branch means no caller can construct the wrong pairing.
  .superRefine((value, ctx) => {
    const expected =
      value.params.rateCardLookUp !== null ? "PLA_USAGE_RATE" : null;
    if (value.plaSpecId !== expected) {
      ctx.addIssue({
        code: "custom",
        message:
          "plaSpecId must be 'PLA_USAGE_RATE' when params.rateCardLookUp names a card, and null when it does not — the two fields must agree.",
        path: ["plaSpecId"],
      });
    }
  });
export type UsageRateComponent = z.infer<typeof usageRateComponentSchema>;

export const flatFeeComponentSchema = z.strictObject({
  "@type": z.literal("flat_fee"),
  specVersion: z.literal(1),
  plaSpecId: z.null(),
  priceType: z.enum(["recurring", "oneTime"]),
  appliesAt: z.literal("billing"),
  basis: z.literal("flat"),
  boundTo: z.null(),
  params: z.strictObject({ amount: moneyStringSchema }),
});
export type FlatFeeComponent = z.infer<typeof flatFeeComponentSchema>;

export const capacityCommitmentComponentSchema = z.strictObject({
  "@type": z.literal("capacity_commitment"),
  specVersion: z.literal(1),
  plaSpecId: z.literal("PLA_CAPACITY_COMMITMENT"),
  priceType: z.literal("commitment"),
  appliesAt: z.literal("post_aggregation"),
  basis: z.literal("quantity"),
  boundTo: z.strictObject({ unitOfMeasure: unitOfMeasureSchema }),
  // VI2: a finite JS number > 0 — never a numeric string.
  params: z.strictObject({ committedQuantity: z.number().finite().positive() }),
});
export type CapacityCommitmentComponent = z.infer<
  typeof capacityCommitmentComponentSchema
>;

export const capacityMotivationComponentSchema = z.strictObject({
  "@type": z.literal("capacity_motivation"),
  specVersion: z.literal(1),
  plaSpecId: z.literal("PLA_CAPACITY_MOTIVATION"),
  priceType: z.literal("discount"),
  appliesAt: z.literal("post_aggregation"),
  basis: z.literal("quantity"),
  boundTo: z.strictObject({ unitOfMeasure: unitOfMeasureSchema }),
  params: z.strictObject({ steps: stepsSchema }),
});
export type CapacityMotivationComponent = z.infer<
  typeof capacityMotivationComponentSchema
>;

// -- The fifth branch: not persistable (pm47-spec D3) -----------------------
//
// `negotiated_override` is a branch of this union and NOT a member of
// `ComponentType` (types/product.ts) — its row lives in
// `ordering.order_item_price_override`, insert-only, scalar `amount` +
// `currency` (PC9, Inv. #16/#39). `persistablePricingComponentSchema` below
// excludes it, which is what makes writing one to `product_offering_price` a
// type error rather than a runtime check.
export const negotiatedOverrideComponentSchema = z.strictObject({
  "@type": z.literal("negotiated_override"),
  specVersion: z.literal(1),
  plaSpecId: z.null(),
  priceType: z.literal("discount"),
  appliesAt: z.literal("rating"),
  basis: z.literal("quantity"),
  // The one place `priceType` appears inside `boundTo` (pm47-spec §2.13) — a
  // negotiated override in this phase always replaces a `usage_rate` price.
  boundTo: z.strictObject({
    priceType: z.literal("usage"),
    unitOfMeasure: unitOfMeasureSchema,
  }),
  params: z.strictObject({ ratePerUnit: moneyStringSchema }),
});
export type NegotiatedOverrideComponent = z.infer<
  typeof negotiatedOverrideComponentSchema
>;

// The full union — five branches, everything a price component may be
// (pm47-spec D1). `PricingComponent` is inferred, never hand-declared
// alongside (pm47-spec §2.4) — this is the type `db/schema/product.ts`
// consumes via `$type<PricingComponent>()`.
export const pricingComponentSchema = z.discriminatedUnion("@type", [
  usageRateComponentSchema,
  flatFeeComponentSchema,
  capacityCommitmentComponentSchema,
  capacityMotivationComponentSchema,
  negotiatedOverrideComponentSchema,
]);
export type PricingComponent = z.infer<typeof pricingComponentSchema>;

// What may actually be written to `product.product_offering_price` — the same
// union minus `negotiated_override` (pm47-spec I1.8). pm48's seeds and pm49's
// repository parse against this, never `pricingComponentSchema` directly.
export const persistablePricingComponentSchema = z.discriminatedUnion("@type", [
  usageRateComponentSchema,
  flatFeeComponentSchema,
  capacityCommitmentComponentSchema,
  capacityMotivationComponentSchema,
]);
export type PersistablePricingComponent = z.infer<
  typeof persistablePricingComponentSchema
>;
