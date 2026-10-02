import { z } from "zod";

import { moneyStringSchema } from "@/validation/product/pricing-component.schema";

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
export const flatRateDetailSchema = z.object({
  rateType: z.literal("FLAT"),
});

// PER_UNIT is explicit/self-describing (unlike FLAT, which carries only the
// discriminant): it carries ratePerUnit/quantity/amountRaw even though
// they're deliberately redundant with udr_usage_rate/udr_usage_quantity/
// udr_rated_price_raw, so the detail reads as a complete calculation record
// (rm17-spec). All three reuse the money-string validator the usage_rate
// pricing component uses — one regex, never a divergent one.
export const perUnitRateDetailSchema = z.strictObject({
  rateType: z.literal("PER_UNIT"),
  ratePerUnit: moneyStringSchema,
  quantity: moneyStringSchema,
  amountRaw: moneyStringSchema,
});

export const udrRateDetailSchema = z.discriminatedUnion("rateType", [
  flatRateDetailSchema,
  perUnitRateDetailSchema,
]);

export type UdrRateDetail = z.infer<typeof udrRateDetailSchema>;
