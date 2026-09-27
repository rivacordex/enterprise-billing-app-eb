import { and, asc, count, desc, eq, ilike, or, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { ratecardRanUsageLkp, ratecardVersion } from "@/db/schema/product";
import type { RatecardRanUsageLkp, RatecardVersion } from "@/db/schema/product";
import type { RateCardVersionStatus } from "@/types/product";

// ---------------------------------------------------------------------------
// pm60-spec — the rate card's whole data-access surface, flat path (C6). This
// repository's HEADLINE RESULT is a proof of absence: it exports FOUR writes
// and FOUR reads (plus one locked read), and NO row-level update or delete of
// a lookup row OF ANY NAME (Inv. #46). A lookup row is only ever inserted, or
// removed by the parent version's `ON DELETE CASCADE` — never edited or
// deleted directly. A correction is a new upload; a wrong open draft is
// REPLACED by re-upload (pm61 D12), never row-edited. Guardrail 37 asserts
// this exported surface (tests/db/product-repository-exports.test.ts).
//
// Every function takes `tx` or `db` explicitly as its first argument; this
// repository NEVER opens a transaction — the caller owns it, so a full upload
// (one version + N batches) either commits whole or leaves nothing behind
// (RC7). SQL lives here (§1). No cache of any kind (Inv. #59, §1.44): the
// ACTIVE version can change at any activation or rollback, so a cached copy is
// stale the moment it is taken.
//
// Dates are strings end to end (D7): `snapshot_date`, `polygon_start_date` and
// `polygon_end_date` are Postgres `date` columns declared `mode: "string"` in
// db/schema/product.ts, so they arrive and depart as `YYYY-MM-DD` strings and
// never become a `Date`. Only `uploaded_at`/`activated_at` (timestamptz) are
// `Date`. Getting this backwards moves a polygon date by a day at a zone
// boundary, which changes what a period bills (§4.30).
// ---------------------------------------------------------------------------

// pm60-spec D3. Declared ONCE here (§6.34). Postgres caps a statement at 65,535
// bind parameters; a lookup insert binds 11 columns per row, so large uploads
// are split into batches of this size inside the caller's single transaction.
// NOT derived at runtime and NOT configurable: a computed size hides the cap
// it protects against, and a configurable one is a production incident waiting
// for someone to tune it upward.
export const RATECARD_INSERT_BATCH_SIZE = 1000;

export interface InsertVersionInput {
  cardName: string;
  versionNum: number;
  // The caller's — this function decides nothing about lifecycle.
  status: RateCardVersionStatus;
  // Set by the upload service (D-A8), a YYYY-MM-DD string; never read from the
  // file, never used for matching.
  snapshotDate: string;
  sourceFile: string;
  fileChecksum?: string | null;
  rowCount: number;
  uploadedBy?: string | null;
}

// The ten data fields of one lookup row (the eleventh bound column,
// `ratecardVersionId`, is supplied by insertLookupRows). Dates are strings.
export interface LookupRowInput {
  mnoPublicKey: string;
  commercialUnitPublicKey: string;
  polygonId: string;
  polygonStartDate: string;
  polygonEndDate: string | null;
  state: string | null;
  district: string | null;
  lkpSubscriberRefId: string;
  serviceCode: string | null;
  ratePerUnit: string | null;
}

// Provenance columns that move with a status change (D1). Each is optional so a
// plain status flip touches only `status`; `undefined` leaves a column
// untouched, `null` clears it.
export interface VersionStatusProvenance {
  activatedBy?: string | null;
  activatedAt?: Date | null;
  supersededByVersionId?: string | null;
}

export type DeleteDraftVersionResult =
  | { ok: true; versionId: string }
  | { ok: false; code: "VERSION_NOT_FOUND" }
  | { ok: false; code: "NOT_DRAFT"; status: RateCardVersionStatus };

export interface VersionRowsPage {
  rows: RatecardRanUsageLkp[];
  total: number;
}

export interface VersionRowsQuery {
  limit: number;
  offset: number;
  // Optional free-text filter, matched (ILIKE) across the key columns and the
  // subscriber reference — a preview convenience, never a resolution path.
  filter?: string;
}

// Escapes LIKE/ILIKE wildcards so a literal % or _ in the filter matches
// literally, mirroring product-offering.ts's own escapeLikePattern.
function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

export const ratecardRepository = {
  // ---- Writes (four) ------------------------------------------------------

  // One `ratecard_version` row. Status is the caller's (D1); provenance columns
  // default null and move later via setVersionStatus.
  async insertVersion(
    tx: Database,
    data: InsertVersionInput,
  ): Promise<{ versionId: string }> {
    const [row] = await tx
      .insert(ratecardVersion)
      .values({
        cardName: data.cardName,
        versionNum: data.versionNum,
        status: data.status,
        snapshotDate: data.snapshotDate,
        sourceFile: data.sourceFile,
        fileChecksum: data.fileChecksum ?? null,
        rowCount: data.rowCount,
        uploadedBy: data.uploadedBy ?? null,
      })
      .returning({ versionId: ratecardVersion.ratecardVersionId });
    if (!row) {
      throw new Error("insertVersion: insert returned no row");
    }
    return { versionId: row.versionId };
  },

  // N lookup rows in batches of RATECARD_INSERT_BATCH_SIZE (D3), on the
  // caller's `tx`. This repository opens no transaction: a failure mid-batch
  // rolls the whole upload back with the caller's transaction, so a failed
  // upload writes nothing (RC7). There is no `updateLookupRow` and no
  // `deleteLookupRow` — inserting is the only row-level write a lookup row ever
  // receives (Inv. #46).
  async insertLookupRows(
    tx: Database,
    versionId: string,
    rows: LookupRowInput[],
  ): Promise<{ inserted: number }> {
    let inserted = 0;
    for (let i = 0; i < rows.length; i += RATECARD_INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + RATECARD_INSERT_BATCH_SIZE);
      if (batch.length === 0) continue;
      await tx.insert(ratecardRanUsageLkp).values(
        batch.map((r) => ({
          ratecardVersionId: versionId,
          mnoPublicKey: r.mnoPublicKey,
          commercialUnitPublicKey: r.commercialUnitPublicKey,
          polygonId: r.polygonId,
          polygonStartDate: r.polygonStartDate,
          polygonEndDate: r.polygonEndDate,
          state: r.state,
          district: r.district,
          lkpSubscriberRefId: r.lkpSubscriberRefId,
          serviceCode: r.serviceCode,
          ratePerUnit: r.ratePerUnit,
        })),
      );
      inserted += batch.length;
    }
    return { inserted };
  },

  // One version's `status` plus the provenance columns that move with it. This
  // is the only writer of `status`; activation/rollback are status flips only
  // (D-A7) — no row writes, no INSERT … SELECT carry-forward.
  async setVersionStatus(
    tx: Database,
    versionId: string,
    status: RateCardVersionStatus,
    provenance: VersionStatusProvenance = {},
  ): Promise<{ versionId: string }> {
    const set: {
      status: RateCardVersionStatus;
      activatedBy?: string | null;
      activatedAt?: Date | null;
      supersededByVersionId?: string | null;
    } = { status };
    if (provenance.activatedBy !== undefined) {
      set.activatedBy = provenance.activatedBy;
    }
    if (provenance.activatedAt !== undefined) {
      set.activatedAt = provenance.activatedAt;
    }
    if (provenance.supersededByVersionId !== undefined) {
      set.supersededByVersionId = provenance.supersededByVersionId;
    }

    const [row] = await tx
      .update(ratecardVersion)
      .set(set)
      .where(eq(ratecardVersion.ratecardVersionId, versionId))
      .returning({ versionId: ratecardVersion.ratecardVersionId });
    if (!row) {
      throw new Error(`setVersionStatus: version ${versionId} not found`);
    }
    return { versionId: row.versionId };
  },

  // Discards a DRAFT version WHOLE: one guarded DELETE of the `ratecard_version`
  // row, whose lookup rows go with it by the existing ON DELETE CASCADE. Re-reads
  // status on `tx` `FOR UPDATE` immediately before the decision (§1.13, the
  // TOCTOU pattern this module fixed four times) and REFUSES to delete anything
  // not in DRAFT — an ACTIVE/SUPERSEDED/REJECTED version is immutable (RC11,
  // Inv. #46). This is the ONLY delete the surface exports, it is version-level,
  // and it exists only so pm61 can replace an open draft on re-upload (D-A11,
  // pm61 D12); there is no standalone discard UI, action or permission.
  async deleteDraftVersion(
    tx: Database,
    versionId: string,
  ): Promise<DeleteDraftVersionResult> {
    const [locked] = await tx
      .select({ status: ratecardVersion.status })
      .from(ratecardVersion)
      .where(eq(ratecardVersion.ratecardVersionId, versionId))
      .for("update")
      .limit(1);
    if (!locked) {
      return { ok: false, code: "VERSION_NOT_FOUND" };
    }
    if (locked.status !== "DRAFT") {
      return { ok: false, code: "NOT_DRAFT", status: locked.status };
    }

    await tx
      .delete(ratecardVersion)
      .where(eq(ratecardVersion.ratecardVersionId, versionId));
    return { ok: true, versionId };
  },

  // ---- Reads (four) + one locked read ------------------------------------

  // The version list, newest first — for one `card_name` or, when `cardName` is
  // null, all cards. A DISPLAY path; it lists every status, superseded included.
  async listVersions(
    db: Database,
    cardName: string | null = null,
  ): Promise<RatecardVersion[]> {
    const base = db.select().from(ratecardVersion);
    const filtered =
      cardName === null
        ? base
        : base.where(eq(ratecardVersion.cardName, cardName));
    return filtered.orderBy(
      desc(ratecardVersion.uploadedAt),
      desc(ratecardVersion.ratecardVersionId),
    );
  },

  // A version BY ID — for the version bar, the row preview and the diff.
  //
  // DISPLAY PATH, NOT A RESOLUTION PATH. This deliberately returns a version of
  // ANY status, SUPERSEDED included: the caller is showing a specific version
  // the user asked for, not resolving "the current rate for a period". Every
  // read of card rows FOR RESOLUTION filters `status = 'ACTIVE'` instead
  // (getCurrentActive / findActiveForUpdate, §6.35). This is why §6.35 is
  // phrased about resolution rather than about the table — do not "fix" this
  // into an ACTIVE-only read; that would break the very screens (version bar,
  // diff of a superseded version) it exists to feed.
  async getVersionById(
    db: Database,
    versionId: string,
  ): Promise<RatecardVersion | null> {
    const [row] = await db
      .select()
      .from(ratecardVersion)
      .where(eq(ratecardVersion.ratecardVersionId, versionId))
      .limit(1);
    return row ?? null;
  },

  // A page of a version's lookup rows, with an optional free-text filter. A
  // DISPLAY path (the row preview), never a resolution path — it reads by
  // version id, so it can preview a superseded version's rows.
  async getVersionRows(
    db: Database,
    versionId: string,
    query: VersionRowsQuery,
  ): Promise<VersionRowsPage> {
    const conditions: SQL[] = [
      eq(ratecardRanUsageLkp.ratecardVersionId, versionId),
    ];
    // Trim before deciding whether a filter is present: a whitespace-only
    // filter is "no filter", not a search for a literal space (escapeLikePattern
    // does not touch spaces, so an untrimmed " " would build ILIKE '% %' and
    // silently narrow the preview).
    const filter = query.filter?.trim() ?? "";
    if (filter.length > 0) {
      const pattern = `%${escapeLikePattern(filter)}%`;
      const match = or(
        ilike(ratecardRanUsageLkp.mnoPublicKey, pattern),
        ilike(ratecardRanUsageLkp.commercialUnitPublicKey, pattern),
        ilike(ratecardRanUsageLkp.polygonId, pattern),
        ilike(ratecardRanUsageLkp.lkpSubscriberRefId, pattern),
      );
      if (match) conditions.push(match);
    }
    const whereClause = and(...conditions);

    const [countRow] = await db
      .select({ total: count() })
      .from(ratecardRanUsageLkp)
      .where(whereClause);
    const total = countRow?.total ?? 0;

    const rows = await db
      .select()
      .from(ratecardRanUsageLkp)
      .where(whereClause)
      .orderBy(
        asc(ratecardRanUsageLkp.mnoPublicKey),
        asc(ratecardRanUsageLkp.commercialUnitPublicKey),
        asc(ratecardRanUsageLkp.polygonId),
        asc(ratecardRanUsageLkp.ratecardRanUsageLkpId),
      )
      .limit(query.limit)
      .offset(query.offset);

    return { rows, total };
  },

  // The current ACTIVE version for a card name — the RESOLUTION read (§6.35).
  // Filters `status = 'ACTIVE'` and so never returns a SUPERSEDED version, even
  // one newer by `version_num`. At most one ACTIVE per card (RV1, the partial
  // unique index), so this yields it or null. Exists now so pm62 and pm63 share
  // one definition of "the current ACTIVE" rather than three.
  async getCurrentActive(
    db: Database,
    cardName: string,
  ): Promise<RatecardVersion | null> {
    const [row] = await db
      .select()
      .from(ratecardVersion)
      .where(
        and(
          eq(ratecardVersion.cardName, cardName),
          eq(ratecardVersion.status, "ACTIVE"),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // The locked variant of getCurrentActive (D8): the current ACTIVE version for
  // a card name, read `FOR UPDATE` so a lifecycle decider (pm63/pm64) can make a
  // status-gated decision on `tx` immediately before its write, with no TOCTOU
  // window. This repository supplies the locked read; the decision is the
  // caller's. Treat a pre-transaction status read in a caller as a
  // review-blocking defect (§1.13).
  async findActiveForUpdate(
    tx: Database,
    cardName: string,
  ): Promise<RatecardVersion | null> {
    const [row] = await tx
      .select()
      .from(ratecardVersion)
      .where(
        and(
          eq(ratecardVersion.cardName, cardName),
          eq(ratecardVersion.status, "ACTIVE"),
        ),
      )
      .for("update")
      .limit(1);
    return row ?? null;
  },
};
