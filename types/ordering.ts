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

// The negotiated-override price-type axis (`recurring`/`usage`/`once`) — the
// values the `ordering.order_item_price_override.price_type` CHECK enforces.
// This is the ordering module's OWN vocabulary, deliberately separate from the
// catalog's component axis (Inv. #38); the Zod override schema derives its enum
// from this tuple, never a hand-written duplicate (§2.1). pm50 declared it in
// `create-order.schema.ts` only to dodge the deleted catalog `PriceType`; its
// proper home is here with the other ordering domain unions.
export const OVERRIDE_PRICE_TYPES = ["recurring", "usage", "once"] as const;
export type OverridePriceType = (typeof OVERRIDE_PRICE_TYPES)[number];

export type {
  ProductOrder,
  ProductOrderInsert,
  ProductOrderItem,
  ProductOrderItemInsert,
  OrderItemPriceOverride,
  OrderItemPriceOverrideInsert,
} from "@/db/schema";

// Read models (pm26) — composed shapes services return, never raw Drizzle rows
// (code-standards §2.7).

// Backs the orders list (update-overview "Lists and navigation"). One row per
// order; `hasOverride` flags a negotiated price, `*Name` fields are resolved
// display names.
export type OrderListRow = {
  orderId: string;
  customerName: string;
  customerPartyRoleId: string;
  billingAccountId: string;
  offeringName: string;
  offeringVersion: number;
  quantity: number;
  startDate: string; // `date` column — a calendar day, never an instant
  hasOverride: boolean;
  status: OrderStatus;
  submittedByName: string; // submitted_by is NOT NULL, resolved via inner join
  submittedAt: Date;
  reviewedByName: string | null; // reviewed_by is nullable — left join
  reviewedAt: Date | null;
};

export type OrderListPage = {
  rows: OrderListRow[];
  total: number; // matching rows across all pages (for "Page X of Y")
  page: number;
  pageSize: number;
};

// One resolved price line on an order detail. The rating contract (Inv. #16)
// is computed here, once, for every consumer: `effectiveAmount` is the override
// if present, else the catalog list amount. Only override-eligible components
// become lines — `usage_rate` (→ `usage`) and `flat_fee` (→ `recurring`/`once`),
// each carrying a scalar amount; the `capacity_*` modifiers are never an
// override target and are not emitted as order lines (pm50 D2). `listAmount`
// stays nullable for read-model stability, though a rendered line always
// carries a scalar today.
export type OrderPriceLine = {
  priceType: OverridePriceType;
  priceName: string;
  listAmount: string | null; // numeric → string (general §2.15)
  currency: string;
  overrideAmount: string | null;
  effectiveAmount: string | null;
};

export type OrderDetailItem = {
  productOrderItemId: string;
  productOfferingId: string;
  offeringName: string;
  offeringVersion: number;
  quantity: number;
  startDate: string;
  orderedCharacteristics: Record<string, string> | null;
};

export type OrderDetail = {
  productOrderId: string;
  customerPartyRoleId: string;
  billingAccountId: string;
  status: OrderStatus;
  failureReason: string | null;
  submittedBy: string;
  submittedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  completedAt: Date | null;
  item: OrderDetailItem;
  prices: OrderPriceLine[]; // override-else-catalog resolved on the read date
};
