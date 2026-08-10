import { z } from "zod";

import { PRODUCT_STATUSES } from "@/types/inventory";

export const SUBSCRIPTION_SORT_VALUES = [
  "start_date",
  "-start_date",
  "status",
  "-status",
  "product_inventory_id",
  "-product_inventory_id",
] as const;

// Lenient by design (offering-list precedent, code-standards §3.3): invalid
// values fall back to defaults rather than erroring.
export const subscriptionsListSearchParamsSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(PRODUCT_STATUSES).nullable().catch(null),
  sort: z.enum(SUBSCRIPTION_SORT_VALUES).catch("-start_date"),
  page: z.coerce.number().int().min(1).catch(1),
  subscription: z
    .string()
    .regex(/^PRDINV\d+$/)
    .nullable()
    .catch(null),
});

export type SubscriptionsListSearchParams = z.infer<
  typeof subscriptionsListSearchParamsSchema
>;
