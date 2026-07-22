import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
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

// The only three offering fields a branch may override — deliberately has
// no `isBundle` key (Design). pm13's `updateOfferingDraftInPlace` input
// shares this same field set minus `saveAsNew`, which is a service-level
// routing flag, not an offering column.
export interface BranchOfferingOverrides {
  name?: string;
  isSellable?: boolean;
  billingOnly?: boolean;
}

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

// `prodmgmt-architecture-phase2.md` §3: version = MAX(version) across the
// resolved family + 1. `rootId` must already be resolved (one hop) by the
// caller — this helper does not itself chase `family_offering_id`.
async function resolveNextVersion(
  tx: Database,
  rootId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      maxVersion: sql<number | null>`max(${productOffering.version})`,
    })
    .from(productOffering)
    .where(
      or(
        eq(productOffering.productOfferingId, rootId),
        eq(productOffering.familyOfferingId, rootId),
      ),
    );
  return (row?.maxVersion ?? 0) + 1;
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

    const page = Math.max(1, filters.page);
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
      .offset((page - 1) * filters.pageSize);

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

  async insertOffering(
    tx: Database,
    data: { name: string; isSellable: boolean; billingOnly: boolean },
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .insert(productOffering)
      .values({
        name: data.name,
        isSellable: data.isSellable,
        billingOnly: data.billingOnly,
        isBundle: false, // hardcoded — never sourced from caller input, no exceptions (Design)
        familyOfferingId: null, // this row is a family root
        lifecycleStatus: "DRAFT",
        version: 1,
      })
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error("insertOffering: insert returned no row");
    }
    return { offeringId: row.offeringId };
  },

  // pm13-spec §3.2. Valid only when the target row is currently DRAFT — the
  // WHERE clause below is a defense-in-depth backstop (Design), not the
  // primary check; the calling service already branches on status before
  // ever reaching this method. Does not touch `version` (architecture-phase2
  // §3: version is assigned once at insert and never changed afterward).
  async updateOfferingDraftInPlace(
    tx: Database,
    draftId: string,
    data: {
      name: string;
      isSellable: boolean;
      billingOnly: boolean;
      lastEditedBy: string;
    },
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({
        name: data.name,
        isSellable: data.isSellable,
        billingOnly: data.billingOnly,
        lastEditedBy: data.lastEditedBy,
        lastModified: new Date(),
      })
      .where(
        and(
          eq(productOffering.productOfferingId, draftId),
          eq(productOffering.lifecycleStatus, "DRAFT"),
        ),
      )
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(
        `updateOfferingDraftInPlace: offering ${draftId} not found or not DRAFT`,
      );
    }
    return { offeringId: row.offeringId };
  },

  // pm12-spec §3.1. Clones `sourceOfferingId` plus every one of its
  // specification and price rows into a new DRAFT row in the same version
  // family. No audit write (Design) — the caller composes this inside its
  // own `db.transaction` alongside its own audit entry.
  async branchOfferingAsDraft(
    tx: Database,
    sourceOfferingId: string,
    overrides?: BranchOfferingOverrides,
  ): Promise<{ offeringId: string }> {
    const [source] = await tx
      .select()
      .from(productOffering)
      .where(eq(productOffering.productOfferingId, sourceOfferingId))
      .limit(1);
    if (!source) {
      throw new Error(
        `branchOfferingAsDraft: source offering ${sourceOfferingId} not found`,
      );
    }

    // One-hop family resolution (architecture-phase2 §3): NULL means the
    // source itself is the root.
    const rootId = source.familyOfferingId ?? source.productOfferingId;
    const nextVersion = await resolveNextVersion(tx, rootId);

    const [branched] = await tx
      .insert(productOffering)
      .values({
        name: overrides?.name ?? source.name,
        // Copied unconditionally — never sourced from `overrides`, which has
        // no `isBundle` key to read in the first place (Design).
        isBundle: source.isBundle,
        isSellable: overrides?.isSellable ?? source.isSellable,
        billingOnly: overrides?.billingOnly ?? source.billingOnly,
        lifecycleStatus: "DRAFT",
        version: nextVersion,
        familyOfferingId: rootId,
        // lastModified / lastEditedBy intentionally omitted — fall through to
        // column defaults, matching insertOffering's precedent (Design).
      })
      .returning({ offeringId: productOffering.productOfferingId });
    if (!branched) {
      throw new Error("branchOfferingAsDraft: insert returned no row");
    }
    const offeringId = branched.offeringId;

    const sourceSpecs = await tx
      .select()
      .from(productSpecifications)
      .where(eq(productSpecifications.refProductOfferingId, sourceOfferingId));
    if (sourceSpecs.length > 0) {
      await tx.insert(productSpecifications).values(
        sourceSpecs.map((spec) => ({
          refProductOfferingId: offeringId,
          name: spec.name,
          isMandatory: spec.isMandatory,
          isDefault: spec.isDefault,
          defaultValue: spec.defaultValue,
          productSpecCharacteristics: spec.productSpecCharacteristics,
        })),
      );
    }

    const sourcePrices = await tx
      .select()
      .from(productOfferingPrice)
      .where(eq(productOfferingPrice.productOfferingId, sourceOfferingId));
    if (sourcePrices.length > 0) {
      await tx.insert(productOfferingPrice).values(
        sourcePrices.map((price) => ({
          productOfferingId: offeringId,
          name: price.name,
          priceType: price.priceType,
          recurringChargePeriodLength: price.recurringChargePeriodLength,
          recurringChargePeriodType: price.recurringChargePeriodType,
          unitOfMeasure: price.unitOfMeasure,
          amount: price.amount,
          currency: price.currency,
          glCode: price.glCode,
          pricingModel: price.pricingModel,
          policy: price.policy,
          pricingCharacteristics: price.pricingCharacteristics,
          startDateTime: price.startDateTime,
          // Copied, not defaulted — "byte-identical in content" (Design).
          createdAt: price.createdAt,
        })),
      );
    }

    return { offeringId };
  },
};
