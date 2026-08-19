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

// Read models (pm32) — composed shapes services return, never raw Drizzle
// rows (code-standards §2.7).

// Backs the subscriptions list. One row per instance; no ACTIVE-version
// filter on the offering join (Inv. #17 — a pinned version stays a rating
// source regardless of lifecycle_status).
export type SubscriptionListRow = {
  inventoryId: string;
  customerName: string;
  billingAccountId: string;
  offeringName: string;
  offeringVersion: number;
  hasOverride: boolean;
  quantity: number;
  startDate: string; // `date` column — a calendar day, never an instant
  endDate: string | null;
  status: ProductStatus;
};

export type SubscriptionListPage = {
  rows: SubscriptionListRow[];
  total: number;
  page: number;
  pageSize: number;
};

// One ordered transition row on a subscription's history (architecture Inv.
// #18 — append-only, gap-free). `from` is `null` only on the creation row.
export type StatusHistoryEntry = {
  from: ProductStatus | null;
  to: ProductStatus;
  effectiveDate: string;
  reason: string | null;
  changedByName: string;
  createdAt: Date;
};

// Derived from consecutive SUSPENDED/ACTIVE (or TERMINATED) transitions
// (pm32-spec §1). An unresumed suspension has `to: null`.
export type SuspensionWindow = {
  from: string;
  to: string | null;
};

// Backs the subscription detail view: the list row shape plus the editable
// characteristics field, the ordered history, and the derived suspension
// windows (computed once — the reference derivation the future bill run
// reuses).
export type SubscriptionDetail = SubscriptionListRow & {
  instanceCharacteristics: Record<string, string> | null;
  history: StatusHistoryEntry[];
  suspensionWindows: SuspensionWindow[];
};
