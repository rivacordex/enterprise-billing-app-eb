// Domain unions for the ordering module (pm25). Defined once here as `as const`
// string-literal tuples (code-standards §2.1); the Drizzle pgSchema enum and the
// Zod validation layer both derive from these, never a hand-written duplicate.

// TMF622 order status — seeded in full; the phase writes the subset
// `ACKNOWLEDGED / PENDING / COMPLETED / REJECTED / FAILED` (architecture §3).
export const ORDER_STATUSES = [
  "ACKNOWLEDGED",
  "REJECTED",
  "PENDING",
  "HELD",
  "IN_PROGRESS",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
  "PARTIAL",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export type {
  ProductOrder,
  ProductOrderInsert,
  ProductOrderItem,
  ProductOrderItemInsert,
  OrderItemPriceOverride,
  OrderItemPriceOverrideInsert,
} from "@/db/schema";
