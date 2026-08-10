// Domain unions for the inventory module (pm25). Defined once here as `as const`
// string-literal tuples (code-standards §2.1); the Drizzle pgSchema enum and the
// Zod validation layer both derive from these, never a hand-written duplicate.

// TMF637 product (subscription) status — seeded in full; the phase uses the
// subset `ACTIVE / SUSPENDED / TERMINATED` (architecture §3).
export const PRODUCT_STATUSES = [
  "CREATED",
  "PENDING_ACTIVE",
  "ACTIVE",
  "SUSPENDED",
  "PENDING_TERMINATE",
  "TERMINATED",
  "CANCELLED",
  "ABORTED",
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export type {
  ProductInventory,
  ProductInventoryInsert,
  InventoryStatusHistory,
  InventoryStatusHistoryInsert,
} from "@/db/schema";
