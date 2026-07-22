import { z } from "zod";

import { PRICE_TYPES } from "@/types/product";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";

// 3-day backdating tolerance (Design; prodmgmt-architecture-phase2 §3, §6
// Inv. 2 amendment). Declared independently in services/product/insert-price.ts
// too — this file's copy is a fast-fail, parse-time check; the service's
// copy is the authoritative, transaction-time check (Design). Same
// small-duplication judgment call pm14-spec made for its two-caller
// findClonedCounterpart/recordsEqual helpers.
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export const insertPriceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Price name is required")
      .max(200, "Price name must be 200 characters or fewer"),
    priceType: z.enum(PRICE_TYPES),
    currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
    glCode: z
      .string()
      .trim()
      .max(50, "GL code must be 50 characters or fewer")
      .nullable()
      .default(null),
    startDateTime: z.coerce.date(),
    // Reused wholesale, snake_case keys and all (Design) — the amount/tiers
    // XOR (Inv. #5) and tier-contiguity (Inv. #4) invariants stay defined in
    // exactly the one place pm02 shipped them; no re-declaration here.
    priceCharacteristics: priceCharacteristicsSchema,
  })
  .superRefine((value, ctx) => {
    // `Date.now()` is called inside this callback, so it is evaluated fresh
    // on every parse — not frozen at module load. Fast-fail copy only; the
    // authoritative check lives in services/product/insert-price.ts against
    // an injectable `now` (Design).
    const msSinceStart = Date.now() - value.startDateTime.getTime();
    if (msSinceStart > THREE_DAYS_MS) {
      ctx.addIssue({
        code: "custom",
        message: "Start date cannot be more than 3 days in the past.",
        path: ["startDateTime"],
      });
    }
  });

export type InsertPriceInput = z.infer<typeof insertPriceSchema>;
