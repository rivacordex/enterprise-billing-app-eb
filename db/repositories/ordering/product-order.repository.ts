import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { productOffering } from "@/db/schema/product";
import {
  orderItemPriceOverride,
  productOrder,
  productOrderItem,
} from "@/db/schema/ordering";
import type {
  OrderListRow,
  OrderStatus,
  ProductOrder,
  ProductOrderInsert,
} from "@/types/ordering";
import type { ORDER_SORT_VALUES } from "@/validation/ordering/orders-list.schema";

export type OrderSort = (typeof ORDER_SORT_VALUES)[number];

export interface OrderListFilters {
  q: string;
  status: OrderStatus | null;
  sort: OrderSort;
  page: number;
  pageSize: number;
}

// Sort key → column lookup; every key appends `asc(productOrderId)` as a
// tie-breaker so pagination stays stable (offering-list precedent).
const SORT_COLUMNS = {
  submitted_at: productOrder.submittedAt,
  status: productOrder.status,
  product_order_id: productOrder.productOrderId,
} as const;

// Text search matches customer (organization) name or order id; status is an
// exact filter (no default-hide rule — orders list shows every status, unlike
// the catalog's RETIRED default). Absent filters contribute no condition.
function buildWhereClause(
  q: string,
  status: OrderStatus | null,
): SQL | undefined {
  const conditions: SQL[] = [];
  if (q.length > 0) {
    const escaped = q.replace(/[%_\\]/g, "\\$&");
    const term = `%${escaped}%`;
    const search = or(
      ilike(organization.name, term),
      ilike(productOrder.productOrderId, term),
    );
    if (search) conditions.push(search);
  }
  if (status !== null) {
    conditions.push(eq(productOrder.status, status));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

export const productOrderRepository = {
  async insertOrder(
    tx: Database,
    data: ProductOrderInsert,
  ): Promise<ProductOrder> {
    const [row] = await tx.insert(productOrder).values(data).returning();
    if (!row) {
      throw new Error("insertOrder: insert returned no row");
    }
    return row;
  },

  async findById(
    db: Database,
    productOrderId: string,
  ): Promise<ProductOrder | null> {
    const [row] = await db
      .select()
      .from(productOrder)
      .where(eq(productOrder.productOrderId, productOrderId))
      .limit(1);
    return row ?? null;
  },

  // Single-row FOR UPDATE (pm16 locking pattern) — used by the pm30 approval
  // transaction to lock the order before its TOCTOU re-validation. No join, so
  // FOR UPDATE is legal here (unlike a joined detail read).
  async findByIdForUpdate(
    tx: Database,
    productOrderId: string,
  ): Promise<ProductOrder | null> {
    const [row] = await tx
      .select()
      .from(productOrder)
      .where(eq(productOrder.productOrderId, productOrderId))
      .for("update")
      .limit(1);
    return row ?? null;
  },

  // Backs the orders list (update-overview "Lists and navigation"). One row per
  // order (the phase creates exactly one item per order): joins the item, its
  // pinned offering (name/version), the customer organization name, the
  // submitter/reviewer display names, and a correlated `exists` override flag.
  async findList(
    db: Database,
    filters: OrderListFilters,
  ): Promise<{ rows: OrderListRow[]; total: number }> {
    const whereClause = buildWhereClause(filters.q, filters.status);
    const submitter = alias(appuser, "submitter");
    const reviewer = alias(appuser, "reviewer");

    // Count over the SAME join set as the data query below — otherwise `total`
    // diverges from the rendered row count if an order ever has zero items
    // (orphan header) or more than one (the one-item-per-order rule is a
    // behavioral expectation, not a DB constraint).
    const [countRow] = await db
      .select({ total: count() })
      .from(productOrder)
      .innerJoin(
        productOrderItem,
        eq(productOrderItem.productOrderId, productOrder.productOrderId),
      )
      .innerJoin(
        productOffering,
        eq(
          productOffering.productOfferingId,
          productOrderItem.productOfferingId,
        ),
      )
      .innerJoin(
        partyRole,
        eq(partyRole.partyRoleId, productOrder.customerPartyRoleId),
      )
      .innerJoin(
        organization,
        eq(organization.organizationId, partyRole.engagedParty),
      )
      .innerJoin(submitter, eq(submitter.id, productOrder.submittedBy))
      .leftJoin(reviewer, eq(reviewer.id, productOrder.reviewedBy))
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const sortKey = filters.sort.startsWith("-")
      ? filters.sort.slice(1)
      : filters.sort;
    // `?? productOrderId` is a defensive fallback: `filters.sort` is a validated
    // `OrderSort` at the type boundary, so an unknown key can only arise from a
    // direct (Zod-bypassing) caller — never pass `undefined` to asc/desc.
    const sortColumn =
      SORT_COLUMNS[sortKey as keyof typeof SORT_COLUMNS] ??
      productOrder.productOrderId;
    const orderBy = filters.sort.startsWith("-")
      ? [desc(sortColumn), asc(productOrder.productOrderId)]
      : [asc(sortColumn), asc(productOrder.productOrderId)];

    const page = Math.max(1, filters.page);
    const rows = await db
      .select({
        orderId: productOrder.productOrderId,
        customerName: organization.name,
        customerPartyRoleId: productOrder.customerPartyRoleId,
        billingAccountId: productOrder.billingAccountId,
        offeringName: productOffering.name,
        offeringVersion: productOffering.version,
        quantity: productOrderItem.quantity,
        startDate: productOrderItem.startDate,
        hasOverride: sql<boolean>`exists (
          select 1 from ${orderItemPriceOverride}
          where ${orderItemPriceOverride.productOrderItemId} = ${productOrderItem.productOrderItemId}
        )`.as("has_override"),
        status: productOrder.status,
        submittedByName: submitter.userName,
        submittedAt: productOrder.submittedAt,
        reviewedByName: reviewer.userName,
        reviewedAt: productOrder.reviewedAt,
      })
      .from(productOrder)
      .innerJoin(
        productOrderItem,
        eq(productOrderItem.productOrderId, productOrder.productOrderId),
      )
      .innerJoin(
        productOffering,
        eq(
          productOffering.productOfferingId,
          productOrderItem.productOfferingId,
        ),
      )
      .innerJoin(
        partyRole,
        eq(partyRole.partyRoleId, productOrder.customerPartyRoleId),
      )
      .innerJoin(
        organization,
        eq(organization.organizationId, partyRole.engagedParty),
      )
      .innerJoin(submitter, eq(submitter.id, productOrder.submittedBy))
      .leftJoin(reviewer, eq(reviewer.id, productOrder.reviewedBy))
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset((page - 1) * filters.pageSize);

    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        status: row.status as OrderStatus,
        hasOverride: Boolean(row.hasOverride),
      })),
    };
  },

  // The only update this repository exports — status-workflow columns only
  // (architecture Inv. #15: the billing-relevant core is write-once). Backs the
  // pm30 approval / completion / failure transitions.
  async updateStatus(
    tx: Database,
    productOrderId: string,
    data: {
      status: OrderStatus;
      reviewedBy?: string;
      reviewedAt?: Date;
      completedAt?: Date;
      failureReason?: string | null;
    },
  ): Promise<{ productOrderId: string }> {
    const [row] = await tx
      .update(productOrder)
      .set({
        status: data.status,
        ...(data.reviewedBy !== undefined
          ? { reviewedBy: data.reviewedBy }
          : {}),
        ...(data.reviewedAt !== undefined
          ? { reviewedAt: data.reviewedAt }
          : {}),
        ...(data.completedAt !== undefined
          ? { completedAt: data.completedAt }
          : {}),
        ...(data.failureReason !== undefined
          ? { failureReason: data.failureReason }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(productOrder.productOrderId, productOrderId))
      .returning({ productOrderId: productOrder.productOrderId });
    if (!row) {
      throw new Error(`updateStatus: order ${productOrderId} not found`);
    }
    return { productOrderId: row.productOrderId };
  },
};
