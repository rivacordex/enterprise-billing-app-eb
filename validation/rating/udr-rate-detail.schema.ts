import { z } from "zod";

import {
  quantityStringSchema,
  rateMoneyStringSchema,
  toScaled,
} from "@/validation/rating/decimal-string";

// rating.udr_rated.udr_rate_detail — type-specific rating data, Zod-validated
// and discriminated by udr_rate_type (rm01-spec §Implementation §2;
// ratemgmt-code-standards.md §2.3). Every write passes this schema first —
// there is no well-formed-only JSONB exemption in this module.
//
// v1 shipped FLAT only (ratemgmt-project-overview.md "Out of scope"). rm17
// adds PER_UNIT. The remaining udr_rated_rate_type_check values —
// TIERED_GRADUATED, TIERED_VOLUME, BLOCK, PERCENTAGE, ZERO_RATED — still have
// no rating computation; adding one's variant here is a validation change,
// never a migration.
//
// Both variants are strict: an unknown key is rejected, never silently
// stripped (a stripped PER_UNIT payload mislabelled FLAT would drop the
// calculation record without error).
export const flatRateDetailSchema = z.strictObject({
  rateType: z.literal("FLAT"),
});

// PER_UNIT is explicit/self-describing (unlike FLAT, which carries only the
// discriminant): it carries ratePerUnit/quantity/amountRaw even though
// they're deliberately redundant with udr_usage_rate/udr_usage_quantity/
// udr_rated_price_raw, so the detail reads as a complete calculation record
// (rm17-spec). RL does not re-validate, so this schema is the only guard:
// field shapes are bounded to the column precision, and amountRaw must equal
// ratePerUnit × quantity exactly (a product that is not storable at scale 6
// is rejected, matching RP's fail-closed rule).
export const perUnitRateDetailSchema = z
  .strictObject({
    rateType: z.literal("PER_UNIT"),
    ratePerUnit: rateMoneyStringSchema,
    quantity: quantityStringSchema,
    amountRaw: rateMoneyStringSchema,
  })
  .superRefine((detail, ctx) => {
    // Zod v4 can still run this after a field-shape failure; compare only
    // well-formed values (the shape issue is already reported).
    if (
      !rateMoneyStringSchema.safeParse(detail.ratePerUnit).success ||
      !quantityStringSchema.safeParse(detail.quantity).success ||
      !rateMoneyStringSchema.safeParse(detail.amountRaw).success
    ) {
      return;
    }
    // (rate·10^6)(qty·10^6) = product·10^12; amountRaw·10^6 scaled to match.
    const product = toScaled(detail.ratePerUnit) * toScaled(detail.quantity);
    const amount = toScaled(detail.amountRaw) * 1_000_000n;
    if (product !== amount) {
      ctx.addIssue({
        code: "custom",
        path: ["amountRaw"],
        message: "amountRaw must equal ratePerUnit × quantity exactly",
      });
    }
  });

export const udrRateDetailSchema = z.discriminatedUnion("rateType", [
  flatRateDetailSchema,
  perUnitRateDetailSchema,
]);

export type UdrRateDetail = z.infer<typeof udrRateDetailSchema>;
