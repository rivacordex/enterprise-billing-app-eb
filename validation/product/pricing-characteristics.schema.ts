import { z } from "zod";

const MONEY_STRING_REGEX = /^\d+(\.\d+)?$/;

// One tier of a tiered price's bounds/rate. `to: null` marks the open-ended
// top tier (pm02-spec §3.6) — only the last tier in `tiers` may carry it.
export const tierSchema = z.strictObject({
  from: z.number().finite().min(0),
  to: z.number().finite().nullable(),
  rate: z.string().regex(MONEY_STRING_REGEX),
});
export type Tier = z.infer<typeof tierSchema>;

// Inv. #4: tiers must be contiguous and non-overlapping — `tiers[n].to`
// exactly equals `tiers[n + 1].from`, every non-last tier has a finite `to`
// greater than its `from`, and only the last tier may be open-ended (`to:
// null`). Enforced here (Zod), mirrored by the DB in a later unit's writes.
export const tieredPricingCharacteristicsSchema = z
  .strictObject({
    tiers: z.array(tierSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const { tiers } = value;
    tiers.forEach((tier, index) => {
      const isLast = index === tiers.length - 1;

      if (tier.to !== null && tier.to <= tier.from) {
        ctx.addIssue({
          code: "custom",
          message: "Tier `to` must be greater than `from`.",
          path: ["tiers", index, "to"],
        });
      }

      if (!isLast) {
        if (tier.to === null) {
          ctx.addIssue({
            code: "custom",
            message: "Only the last tier may be open-ended (`to: null`).",
            path: ["tiers", index, "to"],
          });
        } else if (tier.to !== tiers[index + 1]?.from) {
          ctx.addIssue({
            code: "custom",
            message:
              "Tiers must be contiguous: this tier's `to` must equal the next tier's `from`.",
            path: ["tiers", index, "to"],
          });
        }
      }
    });
  });
export type TieredPricingCharacteristics = z.infer<
  typeof tieredPricingCharacteristicsSchema
>;

// Discriminated union on `pricing_model` — the XOR triple (Inv. #5) between
// `amount` and `pricing_characteristics` is structural here, so Zod itself
// rejects both violation directions (pm02-spec guardrail §9.5).
export const priceCharacteristicsSchema = z.discriminatedUnion(
  "pricing_model",
  [
    z.strictObject({
      pricing_model: z.literal("flat"),
      amount: z.string().regex(MONEY_STRING_REGEX),
      pricing_characteristics: z.null(),
    }),
    z.strictObject({
      pricing_model: z.literal("tiered"),
      amount: z.null(),
      pricing_characteristics: tieredPricingCharacteristicsSchema,
    }),
  ],
);
export type PriceCharacteristics = z.infer<typeof priceCharacteristicsSchema>;
