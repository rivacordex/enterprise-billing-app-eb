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

import type { PriceType } from "@/types/product";

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
// if present, else the catalog list amount (null for a tiered price type, which
// carries no scalar amount and is never overridable).
export type OrderPriceLine = {
  priceType: PriceType;
  priceName: string;
  listAmount: string | null; // null for tiered (numeric → string, general §2.15)
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
