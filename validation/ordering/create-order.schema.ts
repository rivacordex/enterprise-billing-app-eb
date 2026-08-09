import { z } from "zod";

import { inclusiveBilledDateSchema } from "@/validation/backdating-tolerance";
import { characteristicsRecordSchema } from "@/validation/characteristics.schema";

// Up-to-2-decimal positive money string; matches numeric(12,2) and the DB
// `amount > 0` CHECK on order_item_price_override.
const MONEY_2DP_REGEX = /^\d+(\.\d{1,2})?$/;

// A negotiated per-line override. `priceType` validity (exists ∧
// pricing_model = flat) and `currency` = BAN currency are **service-checked**
// (architecture §1) — they need DB state, not just shape.
const overrideSchema = z.object({
  priceType: z.string().trim().min(1, "Price type is required"),
  amount: z
    .string()
    .trim()
    .regex(
      MONEY_2DP_REGEX,
      "Amount must be a positive number with up to 2 decimals",
    )
    .refine((v) => Number(v) > 0, "Amount must be greater than 0"),
  currency: z.string().trim().length(3, "Currency must be a 3-letter code"),
});

export const createOrderSchema = z.object({
  // FK-reference formats — matched to the modules' actual 8-digit ids
  // (customer PTRL, billing BAN, product PRDOFR; repo-wide standard b27bb3e).
  customerPartyRoleId: z
    .string()
    .trim()
    .regex(/^PTRL\d{8}$/, "Invalid customer party role id"),
  billingAccountId: z
    .string()
    .trim()
    .regex(/^BAN\d{8}$/, "Invalid billing account id"),
  productOfferingId: z
    .string()
    .trim()
    .regex(/^PRDOFR\d{8}$/, "Invalid product offering id"),
  quantity: z.coerce
    .number()
    .int()
    .min(1, "Quantity must be at least 1")
    .default(1),
  startDate: inclusiveBilledDateSchema,
  characteristics: characteristicsRecordSchema.optional(),
  overrides: z
    .array(overrideSchema)
    .optional()
    .refine(
      (arr) => !arr || new Set(arr.map((o) => o.priceType)).size === arr.length,
      "At most one override per price type",
    ),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
