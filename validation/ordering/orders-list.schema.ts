import { z } from "zod";

import { ORDER_STATUSES } from "@/types/ordering";

// Sort key with optional `-` prefix for descending (offering-list precedent).
export const ORDER_SORT_VALUES = [
  "submitted_at",
  "-submitted_at",
  "status",
  "-status",
  "product_order_id",
  "-product_order_id",
] as const;

// Lenient by design (audit-log-filters / offering-list precedent,
// code-standards §3.3): a tampered or stale URL never 500s the page — every
// field falls back to its default on a parse failure.
export const ordersListSearchParamsSchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(ORDER_STATUSES).nullable().catch(null),
  sort: z.enum(ORDER_SORT_VALUES).catch("-submitted_at"),
  page: z.coerce.number().int().min(1).catch(1),
  order: z
    .string()
    .regex(/^PRDORD\d+$/)
    .nullable()
    .catch(null),
});

export type OrdersListSearchParams = z.infer<
  typeof ordersListSearchParamsSchema
>;
