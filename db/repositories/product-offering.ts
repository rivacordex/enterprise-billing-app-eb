import { and, asc, count, desc, eq, ilike, ne, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { productOffering } from "@/db/schema/product";
import type { LifecycleStatus, OfferingListRow } from "@/types/product";
import type { OFFERING_SORT_VALUES } from "@/validation/product/offering-list.schema";

export type OfferingSort = (typeof OFFERING_SORT_VALUES)[number];

export interface OfferingListFilters {
  q: string;
  status: LifecycleStatus | null;
  sort: OfferingSort;
  page: number;
  pageSize: number;
}

// Sort key → column lookup (Design #11); every key always appends
// `asc(productOfferingId)` as a tie-breaker so pagination stays stable.
const SORT_COLUMNS = {
  name: productOffering.name,
  product_offering_id: productOffering.productOfferingId,
  lifecycle_status: productOffering.lifecycleStatus,
  version: productOffering.version,
  last_modified: productOffering.lastModified,
} as const;

function buildWhereClause(
  q: string,
  status: LifecycleStatus | null,
): SQL | undefined {
  const conditions = [];
  if (q.length > 0) {
    const escaped = q.replace(/[%_\\]/g, "\\$&");
    conditions.push(ilike(productOffering.name, `%${escaped}%`));
  }
  conditions.push(
    status === null
      ? ne(productOffering.lifecycleStatus, "RETIRED")
      : eq(productOffering.lifecycleStatus, status),
  );
  return and(...conditions);
}

export const productOfferingRepository = {
  // Backs the offerings table (pm03-spec §3.5). RETIRED is hidden by
  // default (Design #5) — the service passes `status: null` through
  // unchanged and this repository owns the exclusion.
  async findList(
    db: Database,
    filters: OfferingListFilters,
  ): Promise<{ rows: OfferingListRow[]; total: number }> {
    const whereClause = buildWhereClause(filters.q, filters.status);

    const [countRow] = await db
      .select({ total: count() })
      .from(productOffering)
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const sortKey = filters.sort.startsWith("-")
      ? filters.sort.slice(1)
      : filters.sort;
    const sortColumn = SORT_COLUMNS[sortKey as keyof typeof SORT_COLUMNS];
    const orderBy = filters.sort.startsWith("-")
      ? [desc(sortColumn), asc(productOffering.productOfferingId)]
      : [asc(sortColumn), asc(productOffering.productOfferingId)];

    const rows = await db
      .select({
        productOfferingId: productOffering.productOfferingId,
        name: productOffering.name,
        lifecycleStatus: productOffering.lifecycleStatus,
        version: productOffering.version,
        isSellable: productOffering.isSellable,
        lastModified: productOffering.lastModified,
      })
      .from(productOffering)
      .where(whereClause)
      .orderBy(...orderBy)
      .limit(filters.pageSize)
      .offset((filters.page - 1) * filters.pageSize);

    return {
      total,
      rows: rows.map((row) => ({
        ...row,
        lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
      })),
    };
  },

  // Backs the offering detail section (pm03-spec §3.6). Left-joins
  // `core.appuser` to resolve `last_edited_by`'s display name; `null` when
  // no offering matches (getOfferingDetail's not-found path).
  async findDetailById(
    db: Database,
    productOfferingId: string,
  ): Promise<{
    productOfferingId: string;
    name: string;
    isBundle: boolean;
    isSellable: boolean;
    billingOnly: boolean;
    lifecycleStatus: LifecycleStatus;
    version: number;
    lastModified: Date;
    lastEditedByName: string | null;
  } | null> {
    const rows = await db
      .select({
        productOfferingId: productOffering.productOfferingId,
        name: productOffering.name,
        isBundle: productOffering.isBundle,
        isSellable: productOffering.isSellable,
        billingOnly: productOffering.billingOnly,
        lifecycleStatus: productOffering.lifecycleStatus,
        version: productOffering.version,
        lastModified: productOffering.lastModified,
        lastEditedByName: appuser.userName,
      })
      .from(productOffering)
      .leftJoin(appuser, eq(productOffering.lastEditedBy, appuser.id))
      .where(eq(productOffering.productOfferingId, productOfferingId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      ...row,
      lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
      lastEditedByName: row.lastEditedByName ?? null,
    };
  },
};
