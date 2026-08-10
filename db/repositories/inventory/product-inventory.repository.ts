import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { organization, partyRole } from "@/db/schema/customer";
import { productOffering } from "@/db/schema/product";
import { productInventory } from "@/db/schema/inventory";
import type {
  ProductInventory,
  ProductInventoryInsert,
  ProductStatus,
} from "@/types/inventory";
import type { SUBSCRIPTION_SORT_VALUES } from "@/validation/inventory/subscriptions-list.schema";

export type SubscriptionSort = (typeof SUBSCRIPTION_SORT_VALUES)[number];

export interface SubscriptionListFilters {
  q: string;
  status: ProductStatus | null;
  sort: SubscriptionSort;
  page: number;
  pageSize: number;
}

const SORT_COLUMNS = {
  start_date: productInventory.startDate,
  status: productInventory.status,
  product_inventory_id: productInventory.productInventoryId,
} as const;

function buildWhereClause(
  q: string,
  status: ProductStatus | null,
): SQL | undefined {
  const conditions: SQL[] = [];
  if (q.length > 0) {
    const escaped = q.replace(/[%_\\]/g, "\\$&");
    const term = `%${escaped}%`;
    const search = or(
      ilike(organization.name, term),
      ilike(productInventory.productInventoryId, term),
    );
    if (search) conditions.push(search);
  }
  if (status !== null) {
    conditions.push(eq(productInventory.status, status));
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

// The subscription (product inventory) instance repository. Core columns
// (offering, quantity, start_date) are write-once (architecture Inv. #15) — the
// only mutations are `updateStatus` (lifecycle) and `updateCharacteristics`
// (the one editable, never-rated field); no other update surface, no delete.
export const productInventoryRepository = {
  async insertInventory(
    tx: Database,
    data: ProductInventoryInsert,
  ): Promise<ProductInventory> {
    const [row] = await tx.insert(productInventory).values(data).returning();
    if (!row) {
      throw new Error("insertInventory: insert returned no row");
    }
    return row;
  },

  async findById(
    db: Database,
    productInventoryId: string,
  ): Promise<ProductInventory | null> {
    const [row] = await db
      .select()
      .from(productInventory)
      .where(eq(productInventory.productInventoryId, productInventoryId))
      .limit(1);
    return row ?? null;
  },

  // Single-row FOR UPDATE (pm16 locking pattern) — the pm31 lifecycle
  // transitions lock the instance before their TOCTOU-checked transition write.
  async findByIdForUpdate(
    tx: Database,
    productInventoryId: string,
  ): Promise<ProductInventory | null> {
    const [row] = await tx
      .select()
      .from(productInventory)
      .where(eq(productInventory.productInventoryId, productInventoryId))
      .for("update")
      .limit(1);
    return row ?? null;
  },

  // Backs the subscriptions list. Joins the customer organization name (search
  // + display) and pins the offering version; no ACTIVE filter on the offering
  // (Inv. #17 — a pinned version is a rating source regardless of
  // lifecycle_status).
  async findList(
    db: Database,
    filters: SubscriptionListFilters,
  ): Promise<{
    rows: Array<
      Pick<
        ProductInventory,
        | "productInventoryId"
        | "customerPartyRoleId"
        | "billingAccountId"
        | "productOfferingId"
        | "quantity"
        | "status"
        | "startDate"
        | "endDate"
      > & {
        customerName: string;
        offeringName: string;
        offeringVersion: number;
      }
    >;
    total: number;
  }> {
    const whereClause = buildWhereClause(filters.q, filters.status);

    // Count over the SAME join set as the data query below, for structural
    // consistency (the 1:1 UNIQUE FK to the order item already rules out
    // fan-out here, but keep the two queries in lockstep).
    const [countRow] = await db
      .select({ total: count() })
      .from(productInventory)
      .innerJoin(
        productOffering,
        eq(
          productOffering.productOfferingId,
          productInventory.productOfferingId,
        ),
      )
      .innerJoin(
        partyRole,
        eq(partyRole.partyRoleId, productInventory.customerPartyRoleId),
      )
      .innerJoin(
        organization,
        eq(organization.organizationId, partyRole.engagedParty),
      )
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const sortKey = filters.sort.startsWith("-")
      ? filters.sort.slice(1)
      : filters.sort;
    const sortColumn = SORT_COLUMNS[sortKey as keyof typeof SORT_COLUMNS];
    const orderBy = filters.sort.startsWith("-")
      ? [desc(sortColumn), asc(productInventory.productInventoryId)]
      : [asc(sortColumn), asc(productInventory.productInventoryId)];

    const page = Math.max(1, filters.page);
    const rows = await db
      .select({
        productInventoryId: productInventory.productInventoryId,
        customerName: organization.name,
        customerPartyRoleId: productInventory.customerPartyRoleId,
        billingAccountId: productInventory.billingAccountId,
        productOfferingId: productInventory.productOfferingId,
        offeringName: productOffering.name,
        offeringVersion: productOffering.version,
        quantity: productInventory.quantity,
        status: productInventory.status,
        startDate: productInventory.startDate,
        endDate: productInventory.endDate,
      })
      .from(productInventory)
      .innerJoin(
        productOffering,
        eq(
          productOffering.productOfferingId,
          productInventory.productOfferingId,
        ),
      )
      .innerJoin(
        partyRole,
        eq(partyRole.partyRoleId, productInventory.customerPartyRoleId),
      )
      .innerJoin(
        organization,
        eq(organization.organizationId, partyRole.engagedParty),
      )
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset((page - 1) * filters.pageSize);

    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        status: row.status as ProductStatus,
      })),
    };
  },

  // Lifecycle transition write (pm31) — status + optional end_date (set on
  // terminate) only. The `status` column mirrors the latest history row
  // (Inv. #18); the append itself is the history repository's job.
  async updateStatus(
    tx: Database,
    productInventoryId: string,
    data: { status: ProductStatus; endDate?: string },
  ): Promise<{ productInventoryId: string }> {
    const [row] = await tx
      .update(productInventory)
      .set({
        status: data.status,
        ...(data.endDate !== undefined ? { endDate: data.endDate } : {}),
        updatedAt: new Date(),
      })
      .where(eq(productInventory.productInventoryId, productInventoryId))
      .returning({ productInventoryId: productInventory.productInventoryId });
    if (!row) {
      throw new Error(
        `updateStatus: inventory ${productInventoryId} not found`,
      );
    }
    return { productInventoryId: row.productInventoryId };
  },

  // The one editable, never-rated field (Inv. #15) — descriptive
  // characteristics only, audited by the caller.
  async updateCharacteristics(
    tx: Database,
    productInventoryId: string,
    characteristics: Record<string, string>,
  ): Promise<{ productInventoryId: string }> {
    const [row] = await tx
      .update(productInventory)
      .set({
        instanceCharacteristics: characteristics,
        updatedAt: new Date(),
      })
      .where(eq(productInventory.productInventoryId, productInventoryId))
      .returning({ productInventoryId: productInventory.productInventoryId });
    if (!row) {
      throw new Error(
        `updateCharacteristics: inventory ${productInventoryId} not found`,
      );
    }
    return { productInventoryId: row.productInventoryId };
  },
};
