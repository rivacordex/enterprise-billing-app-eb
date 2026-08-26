import { z } from "zod";

// rating.udr_rated.udr_rate_detail — type-specific rating data, Zod-validated
// and discriminated by udr_rate_type (rm01-spec §Implementation §2;
// ratemgmt-code-standards.md §2.3). Every write passes this schema first —
// there is no well-formed-only JSONB exemption in this module.
//
// v1 ships FLAT only (ratemgmt-project-overview.md "Out of scope"). The
// remaining udr_rated_rate_type_check values — PER_UNIT, TIERED_GRADUATED,
// TIERED_VOLUME, BLOCK, PERCENTAGE, ZERO_RATED — have no rating computation
// yet; adding one's variant here is a validation change, never a migration.
export const flatRateDetailSchema = z.object({
  rateType: z.literal("FLAT"),
});

export const udrRateDetailSchema = z.discriminatedUnion("rateType", [
  flatRateDetailSchema,
]);

export type UdrRateDetail = z.infer<typeof udrRateDetailSchema>;
