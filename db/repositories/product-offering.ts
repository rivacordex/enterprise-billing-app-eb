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
import type {
  FamilyListRow,
  LifecycleStatus,
  OfferingListRow,
  VersionSummary,
} from "@/types/product";
import type { OFFERING_SORT_VALUES } from "@/validation/product/offering-list.schema";

export type OfferingSort = (typeof OFFERING_SORT_VALUES)[number];

export interface OfferingListFilters {
  q: string;
  status: LifecycleStatus | null;
  sort: OfferingSort;
  page: number;
  pageSize: number;
}

export interface FamilyPageFilters {
  q: string;
  status: LifecycleStatus | null;
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

// Escapes LIKE/ILIKE wildcards so a user's literal % or _ in the search term
// matches literally, not as a pattern. Shared by findList (View Product) and
// findFamilyPage (Manage Products) so both lists wildcard a search identically.
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function buildWhereClause(
  q: string,
  status: LifecycleStatus | null,
): SQL | undefined {
  const conditions = [];
  if (q.length > 0) {
    const escaped = escapeLikePattern(q);
    conditions.push(ilike(productOffering.name, `%${escaped}%`));
  }
  if (status === null) {
    // Default View Product list answers "what can be sold". Both terminal
    // states — OBSOLETE (superseded or stopped) and RETIRED (withdrawn) — are
    // not sellable, so the no-filter default hides both (pm37-spec D4 / G2).
    // Each stays reachable through the explicit status filter, which now
    // offers all five values (it derives from LIFECYCLE_STATUSES).
    conditions.push(ne(productOffering.lifecycleStatus, "OBSOLETE"));
    conditions.push(ne(productOffering.lifecycleStatus, "RETIRED"));
  } else {
    conditions.push(eq(productOffering.lifecycleStatus, status));
  }
  return and(...conditions);
}

// `prodmgmt-architecture-phase2.md` §3: version = MAX(version) across the
// resolved family + 1. `rootId` must already be resolved (one hop) by the
// caller — this helper does not itself chase `family_offering_id`.
//
// `pg_advisory_xact_lock` serializes concurrent branches of the same
// family: row-level locking can't help here (the contended row doesn't
// exist yet — it's the *next* branch's insert), so a session/xact-scoped
// advisory lock keyed on the family root is the mechanism that actually
// prevents two concurrent callers from both computing the same MAX and
// allocating the same version number. Auto-released at transaction end.
async function resolveNextVersion(
  tx: Database,
  rootId: string,
): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${rootId}))`);

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
  // Backs the offerings table (pm03-spec §3.5). Both terminal states —
  // OBSOLETE and RETIRED — are hidden by default (pm37 D4 / G2); the service
  // passes `status: null` through unchanged and this repository owns the
  // exclusion (see buildWhereClause). Callers that need "every status" must
  // request each hidden state explicitly — a `null` bucket no longer covers
  // OBSOLETE (see the Manage Products flag in the pm37 tracker entry).
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
        familyOfferingId: productOffering.familyOfferingId, // pm18
        billingOnly: productOffering.billingOnly, // pm20 — needed to prefill the Edit dialog
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

  // Backs the Manage Products families list (pm39 D2 / I2). One CTE groups every
  // offering by its family key COALESCE(family_offering_id, product_offering_id)
  // — the same expression pm36's indexes use — and picks each family's primary
  // version (ACTIVE first, then the single open DRAFT/TESTING version, then the
  // highest version) with ROW_NUMBER, alongside the version count and the open
  // version's id (at most one per family by index, so FILTER MAX yields it or
  // NULL). Filters (q ILIKE, status) apply to the primary version (D3); the
  // count query reuses the same CTE so the total survives LIMIT. Two statements,
  // no per-row detail fetch (§1.16, V9). Returns families, never versions.
  //
  // The ROW_NUMBER `CASE` below encodes the primary-version priority (ACTIVE →
  // open → highest). pm40's `resolveSelectedVersion` (services/product) applies
  // the identical rule in TS to auto-select a version when a family is opened —
  // keep the two in sync; a change here must change that helper in the same edit.
  async findFamilyPage(
    db: Database,
    filters: FamilyPageFilters,
  ): Promise<{ rows: FamilyListRow[]; total: number }> {
    const famCte = sql`
      SELECT
        coalesce(family_offering_id, product_offering_id) AS family_id,
        product_offering_id AS primary_version_id,
        name,
        lifecycle_status,
        version,
        is_sellable,
        billing_only,
        last_modified,
        row_number() OVER (
          PARTITION BY coalesce(family_offering_id, product_offering_id)
          ORDER BY
            CASE lifecycle_status
              WHEN 'ACTIVE' THEN 0
              WHEN 'TESTING' THEN 1
              WHEN 'DRAFT' THEN 1
              ELSE 2
            END,
            version DESC
        ) AS rank,
        count(*) OVER (
          PARTITION BY coalesce(family_offering_id, product_offering_id)
        ) AS version_count,
        max(product_offering_id) FILTER (
          WHERE lifecycle_status IN ('DRAFT', 'TESTING')
        ) OVER (
          PARTITION BY coalesce(family_offering_id, product_offering_id)
        ) AS open_version_id
      FROM product.product_offering
    `;

    // Filters run against the primary version's own columns (rank = 1 rows).
    const conditions = [sql`rank = 1`];
    if (filters.q.length > 0) {
      const escaped = escapeLikePattern(filters.q);
      conditions.push(sql`name ILIKE ${`%${escaped}%`}`);
    }
    if (filters.status !== null) {
      conditions.push(
        sql`lifecycle_status = ${filters.status}::product.lifecycle_status`,
      );
    }
    const whereClause = sql.join(conditions, sql` AND `);

    const page = Math.max(1, filters.page);
    const offset = (page - 1) * filters.pageSize;

    const rows = await db.execute<{
      family_id: string;
      primary_version_id: string;
      name: string;
      lifecycle_status: string;
      version: number;
      version_count: string | number;
      open_version_id: string | null;
      is_sellable: boolean;
      billing_only: boolean;
      last_modified: string | Date;
    }>(sql`
      WITH fam AS (${famCte})
      SELECT family_id, primary_version_id, name, lifecycle_status, version,
             version_count, open_version_id, is_sellable, billing_only,
             last_modified
      FROM fam
      WHERE ${whereClause}
      ORDER BY name ASC, family_id ASC
      LIMIT ${filters.pageSize} OFFSET ${offset}
    `);

    const countResult = await db.execute<{ total: string | number }>(sql`
      WITH fam AS (${famCte})
      SELECT count(*) AS total FROM fam WHERE ${whereClause}
    `);
    const total = Number(countResult[0]?.total ?? 0);

    return {
      total,
      rows: [...rows].map((row) => ({
        familyId: row.family_id,
        primaryVersionId: row.primary_version_id,
        name: row.name,
        lifecycleStatus: row.lifecycle_status as LifecycleStatus,
        version: Number(row.version),
        versionCount: Number(row.version_count),
        openVersionId: row.open_version_id,
        isSellable: row.is_sellable,
        billingOnly: row.billing_only,
        // Raw execute returns timestamptz as a string, not a Date
        // ([[raw-execute-timestamp-strings]]) — normalise to the read model's Date.
        lastModified:
          row.last_modified instanceof Date
            ? row.last_modified
            : new Date(row.last_modified),
      })),
    };
  },

  // Backs the Manage Products version bar (pm40 I1). One statement: every
  // version in the family, newest-first (D2 — descending, so the ACTIVE/open
  // version sits at the left edge). The family key is
  // COALESCE(family_offering_id, product_offering_id) — the same expression
  // pm36's indexes and findFamilyPage use — so a `familyId` (a root's own id)
  // matches the root row and every branch. Returns VersionSummary rows, never a
  // detail; the selected version's detail is a separate getOfferingDetail read.
  //
  // `version` is unique within a family (Inv. #8), so `desc(version)` is already
  // deterministic; the `asc(productOfferingId)` tie-breaker is kept anyway to
  // match findList/findFamilyPage's stable-ordering convention and to stay
  // deterministic if that invariant is ever violated by a data anomaly (the
  // order feeds `resolveSelectedVersion`'s "highest" primary fallback).
  async findFamilyVersions(
    db: Database,
    familyId: string,
  ): Promise<VersionSummary[]> {
    const rows = await db
      .select({
        productOfferingId: productOffering.productOfferingId,
        version: productOffering.version,
        lifecycleStatus: productOffering.lifecycleStatus,
        lastModified: productOffering.lastModified,
      })
      .from(productOffering)
      .where(
        sql`coalesce(${productOffering.familyOfferingId}, ${productOffering.productOfferingId}) = ${familyId}`,
      )
      .orderBy(
        desc(productOffering.version),
        asc(productOffering.productOfferingId),
      );

    return rows.map((row) => ({
      ...row,
      lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
    }));
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
    return this.findDetailByIdForUpdate(db, productOfferingId, false);
  },

  async findDetailByIdForUpdate(
    db: Database,
    productOfferingId: string,
    forUpdate = true,
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
    const rows = forUpdate
      ? await db
          .select({
            productOfferingId: productOffering.productOfferingId,
            name: productOffering.name,
            isBundle: productOffering.isBundle,
            isSellable: productOffering.isSellable,
            billingOnly: productOffering.billingOnly,
            lifecycleStatus: productOffering.lifecycleStatus,
            version: productOffering.version,
            lastModified: productOffering.lastModified,
            lastEditedByName: sql<string | null>`null`.as(
              "last_edited_by_name",
            ),
          })
          .from(productOffering)
          .where(eq(productOffering.productOfferingId, productOfferingId))
          .limit(1)
          .for("update")
      : await db
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

  // pm16-spec §3.6 (post-ship fix). Single-row, no join (unlike
  // findDetailById, so FOR UPDATE is legal here) — used only by
  // retireOffering's transaction-time re-check, to close the race where
  // the offering's status changes between the service's initial
  // pre-transaction read and the retire write, which would otherwise
  // produce a RETIRED/DISCARDED audit event that doesn't match what
  // actually happened.
  async findLifecycleStatusForUpdate(
    tx: Database,
    productOfferingId: string,
  ): Promise<{ lifecycleStatus: LifecycleStatus } | null> {
    const [row] = await tx
      .select({ lifecycleStatus: productOffering.lifecycleStatus })
      .from(productOffering)
      .where(eq(productOffering.productOfferingId, productOfferingId))
      .for("update")
      .limit(1);
    return row
      ? { lifecycleStatus: row.lifecycleStatus as LifecycleStatus }
      : null;
  },

  // pm16-spec §3.3. Locks every row belonging to the family — not just
  // whichever one currently reads ACTIVE — because the row set this method
  // locks must be fixed by immutable identity (id / family_offering_id), not
  // by the mutable lifecycle_status column, for the FOR UPDATE re-check to
  // actually serialize two concurrent activations on sibling drafts (Design;
  // architecture-phase2 §6 Inv. 13). Returns the family's current ACTIVE
  // member, if any, already locked for the caller's own transaction.
  async findActiveInFamily(
    tx: Database,
    rootId: string,
  ): Promise<{ offeringId: string } | null> {
    const familyRows = await tx
      .select({
        offeringId: productOffering.productOfferingId,
        lifecycleStatus: productOffering.lifecycleStatus,
      })
      .from(productOffering)
      .where(
        or(
          eq(productOffering.productOfferingId, rootId),
          eq(productOffering.familyOfferingId, rootId),
        ),
      )
      .for("update");

    const active = familyRows.find((row) => row.lifecycleStatus === "ACTIVE");
    return active ? { offeringId: active.offeringId } : null;
  },

  // pm42-spec I1. Narrow single-status writers — one per legal transition, no
  // generic `setLifecycleStatus(id, status)` helper (code-standards §1.15): a
  // transition the state table does not list has no code path. Each pins its
  // expected predecessor in the WHERE clause so a concurrent transition cannot
  // be silently clobbered, and each stamps `last_modified`/`last_edited_by`
  // (the transition is an edit). The calling service has already re-read the
  // status locked (`findLifecycleStatusForUpdate`) immediately before; the WHERE
  // predecessor is the defense-in-depth backstop, mirroring
  // `updateOfferingDraftInPlace`'s own status WHERE.
  async markTesting(
    tx: Database,
    offeringId: string,
    actorId: string,
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({
        lifecycleStatus: "TESTING",
        lastEditedBy: actorId,
        lastModified: new Date(),
      })
      .where(
        and(
          eq(productOffering.productOfferingId, offeringId),
          eq(productOffering.lifecycleStatus, "DRAFT"),
        ),
      )
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(
        `markTesting: offering ${offeringId} not found or not DRAFT`,
      );
    }
    return { offeringId: row.offeringId };
  },

  // pm42-spec I1. TESTING → DRAFT (returnToDraft). Not a rollback — no content is
  // restored (pm42 D4); the version simply becomes editable again because the
  // §3.5 trigger's DRAFT condition is satisfied once more.
  async markDraft(
    tx: Database,
    offeringId: string,
    actorId: string,
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({
        lifecycleStatus: "DRAFT",
        lastEditedBy: actorId,
        lastModified: new Date(),
      })
      .where(
        and(
          eq(productOffering.productOfferingId, offeringId),
          eq(productOffering.lifecycleStatus, "TESTING"),
        ),
      )
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(
        `markDraft: offering ${offeringId} not found or not TESTING`,
      );
    }
    return { offeringId: row.offeringId };
  },

  // pm42-spec I1/I4. TESTING → ACTIVE. Composed by `activateOffering` below after
  // the family's previous ACTIVE version has been superseded (index-safe order).
  async markActive(
    tx: Database,
    offeringId: string,
    actorId: string,
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({
        lifecycleStatus: "ACTIVE",
        lastEditedBy: actorId,
        lastModified: new Date(),
      })
      .where(
        and(
          eq(productOffering.productOfferingId, offeringId),
          eq(productOffering.lifecycleStatus, "TESTING"),
        ),
      )
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(
        `markActive: offering ${offeringId} not found or not TESTING`,
      );
    }
    return { offeringId: row.offeringId };
  },

  // pm42-spec I1/I4. ACTIVE → OBSOLETE. Used by `activateOffering` to supersede
  // the family's previous ACTIVE version (pm42 D3 — the status the superseded row
  // takes changed from RETIRED to OBSOLETE, so a superseded version keeps billing
  // its pinned subscriptions, Inv. #6/#17). pm43 will reuse this for the manual
  // stop-selling transition.
  async markObsolete(
    tx: Database,
    offeringId: string,
    actorId: string,
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({
        lifecycleStatus: "OBSOLETE",
        lastEditedBy: actorId,
        lastModified: new Date(),
      })
      .where(
        and(
          eq(productOffering.productOfferingId, offeringId),
          eq(productOffering.lifecycleStatus, "ACTIVE"),
        ),
      )
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(
        `markObsolete: offering ${offeringId} not found or not ACTIVE`,
      );
    }
    return { offeringId: row.offeringId };
  },

  // pm16-spec §3.3, amended pm42 D3/I4. Supersede-then-flip, index-ordered: the
  // family's current ACTIVE sibling (if any) is moved to OBSOLETE *before* the
  // target flips to ACTIVE, so `product_offering_one_active_per_family` never
  // sees two ACTIVE rows mid-transaction (the reverse order trips the index).
  // Activation now flips TESTING → ACTIVE (was DRAFT → ACTIVE): the release
  // preconditions moved one step earlier to `submitForTesting` (pm42 D2), and a
  // TESTING version's content has been frozen since it left DRAFT, so activation
  // re-checks nothing about content. `findActiveInFamily`'s family-wide
  // `FOR UPDATE` is the serialization that makes two concurrent activations safe
  // (Inv. #13) — unchanged; it is the "lock" pm42 D3 refers to (activation never
  // took a separate `pg_advisory_xact_lock` — that guards branching only). The
  // caller has already re-read this version's status locked and refused unless
  // TESTING (code-standards §1.13); `markActive`'s WHERE is the backstop.
  async activateOffering(
    tx: Database,
    offeringId: string,
    actorId: string,
  ): Promise<{ offeringId: string; supersededOfferingId: string | null }> {
    const [target] = await tx
      .select({
        productOfferingId: productOffering.productOfferingId,
        familyOfferingId: productOffering.familyOfferingId,
      })
      .from(productOffering)
      .where(eq(productOffering.productOfferingId, offeringId))
      .limit(1);
    if (!target) {
      throw new Error(`activateOffering: offering ${offeringId} not found`);
    }

    // One-hop family resolution (architecture-phase2 §3), duplicated from
    // branchOfferingAsDraft's own inline resolution — pm12-spec's own
    // prediction (Design).
    const rootId = target.familyOfferingId ?? target.productOfferingId;

    const activeSibling = await productOfferingRepository.findActiveInFamily(
      tx,
      rootId,
    );

    if (activeSibling) {
      await productOfferingRepository.markObsolete(
        tx,
        activeSibling.offeringId,
        actorId,
      );
    }

    const { offeringId: activatedId } =
      await productOfferingRepository.markActive(tx, offeringId, actorId);

    return {
      offeringId: activatedId,
      supersededOfferingId: activeSibling?.offeringId ?? null,
    };
  },

  // pm16-spec §3.3. Unconditional — sets RETIRED regardless of the row's
  // prior status (build plan's literal wording; code-standards-phase2 §1
  // rule 11: "Do not fork this into two repository methods"). The
  // already-RETIRED guard lives entirely in the calling service, ahead of
  // the transaction (Design) — this method has no WHERE-status backstop.
  async retireOffering(
    tx: Database,
    offeringId: string,
  ): Promise<{ offeringId: string }> {
    const [row] = await tx
      .update(productOffering)
      .set({ lifecycleStatus: "RETIRED" })
      .where(eq(productOffering.productOfferingId, offeringId))
      .returning({ offeringId: productOffering.productOfferingId });
    if (!row) {
      throw new Error(`retireOffering: offering ${offeringId} not found`);
    }
    return { offeringId: row.offeringId };
  },
};
