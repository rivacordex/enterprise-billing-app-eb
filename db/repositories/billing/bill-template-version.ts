import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { appuser } from "@/db/schema/identity";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import type { LayoutPageSetup, TemplateKind } from "@/types/billing";
import type { InvoiceTemplateStructureInput } from "@/validation/billing/invoice-template-structure.schema";

// bm50-spec §Design D9 — repository over `bill_template_version`. bm57 adds the
// working-draft writes (`insertDraft`, `updateDraftStructure`); bm58 adds the
// activation writes (`findDraftForUpdate`, `retireActive`, `promoteDraft`). The
// one format is `INVOICE`
// (code-standards Part 2 TS rule 6), so every read is scoped to it.
const INVOICE = "INVOICE";

// bm57-spec §Design D1 — the draft's optimistic-concurrency token: its
// `last_modified_datetime` rendered in SQL at full microsecond precision. A JS
// `Date` truncates to milliseconds and would never match the stored value, so
// the token is produced and compared as text in the database.
export const DRAFT_TOKEN_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const draftToken = sql<string>`to_char(${billTemplateVersion.lastModifiedDatetime} AT TIME ZONE 'UTC', '${sql.raw(DRAFT_TOKEN_FORMAT)}')`;

export interface TemplateDraftRow extends BillTemplateVersion {
  token: string;
}

export interface TemplateVersionWithUsage extends BillTemplateVersion {
  usedByCount: number;
}

// Review fix (known-issues §24c) — the optional family filter shared by the
// generated-version reads/writes; `undefined` adds no condition.
function familyScope(familyId: string | undefined) {
  return familyId === undefined
    ? undefined
    : eq(billTemplateVersion.refBillTemplateFamilyId, familyId);
}

export const billTemplateVersionRepository = {
  async findById(
    db: Database,
    id: string,
  ): Promise<BillTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(billTemplateVersion)
      .where(eq(billTemplateVersion.billTemplateVersionId, id))
      .limit(1);
    return row ?? null;
  },

  // The current non-default ACTIVE row for the kind, or `null` — resolution
  // order is pinned → this → default (G3/C3). For CSV `btv_one_active_uq`
  // guarantees at most one. For layout and `generated`, uniqueness is per
  // (type, kind) since bm74 (`btv_one_active_family_uq`), so generated callers pass `familyId`
  // (review fix, known-issues §24c); without it the read is exact only while
  // one family exists (the Customer Management label reader, D46).
  async findActive(
    db: Database,
    { kind, familyId }: { kind: TemplateKind; familyId?: string },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          familyScope(familyId),
          eq(billTemplateVersion.status, "ACTIVE"),
          eq(billTemplateVersion.isDefault, false),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // The kind's default row, or `null`. A generated default exists only in the
  // default family (`btv_one_default_uq`, architecture P7), so a non-default
  // `familyId` yields `null`.
  async findDefault(
    db: Database,
    { kind, familyId }: { kind: TemplateKind; familyId?: string },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          familyScope(familyId),
          eq(billTemplateVersion.isDefault, true),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // Version history, newest first, with `usedByCount` = the number of
  // `customer_bill` rows stamped with this version id (the template stamp).
  // Counted in SQL (no JS reduce).
  async listForKind(
    db: Database,
    {
      kind,
      withUsage = true,
      familyId,
    }: { kind: TemplateKind; withUsage?: boolean; familyId?: string },
  ): Promise<TemplateVersionWithUsage[]> {
    // `withUsage: false` skips the `customer_bill` count (callers that only
    // need labels, e.g. layout versions, whose count is always 0).
    const rows = await db
      .select({
        version: billTemplateVersion,
        usedByCount: withUsage
          ? sql<number>`(
          SELECT count(*)::int FROM ${customerBill} cb
          WHERE cb.ref_bill_template_version_id = ${billTemplateVersion.billTemplateVersionId}
        )`
          : sql<number>`0`,
      })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          familyScope(familyId),
        ),
      )
      .orderBy(desc(billTemplateVersion.versionNo));
    return rows.map((r) => ({ ...r.version, usedByCount: r.usedByCount }));
  },

  // Serialise writers of one kind's versions for the rest of the transaction
  // (an advisory xact lock, not `FOR UPDATE` on bill_format — `app_runtime`
  // has only SELECT there). Re-entrant within a transaction, so callers that
  // also call `nextVersionNo` simply re-take it. bm57 takes it BEFORE looking
  // up the working draft, so two concurrent first saves become one insert and
  // one conflict rather than a unique violation.
  async lockKind(
    tx: Database,
    { kind }: { kind: TemplateKind },
  ): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`billing.bill_template_version:${INVOICE}:${kind}`}))`,
    );
  },

  // `max(version_no) + 1` under the kind lock. bm77: layout and generated
  // numbers are per TYPE (`familyId` required), matching bm74's
  // `btv_version_uq` per (type, kind). The unique index is the backstop
  // against a lost race; the global per-kind lock is coarser than needed, and
  // safe.
  async nextVersionNo(
    tx: Database,
    scope: { kind: TemplateKind; familyId: string },
  ): Promise<number> {
    await this.lockKind(tx, { kind: scope.kind });
    const [row] = await tx
      .select({
        maxNo: sql<number>`COALESCE(max(${billTemplateVersion.versionNo}), 0)::int`,
      })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, scope.kind),
          familyScope(scope.familyId),
        ),
      );
    return (row?.maxNo ?? 0) + 1;
  },

  // bm77 — per type, its non-default ACTIVE `generated` version, else its
  // default: the settings version new invoices of that type use. One query,
  // for the type list (version no + since when).
  async listActiveSettingsByFamily(
    db: Database,
  ): Promise<
    Map<string, { versionNo: number; activatedDatetime: Date | null }>
  > {
    const rows = await db
      .selectDistinctOn([billTemplateVersion.refBillTemplateFamilyId], {
        familyId: billTemplateVersion.refBillTemplateFamilyId,
        versionNo: billTemplateVersion.versionNo,
        activatedDatetime: billTemplateVersion.activatedDatetime,
      })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, "generated"),
          eq(billTemplateVersion.status, "ACTIVE"),
        ),
      )
      // Within a type the non-default ACTIVE (is_default false) sorts first.
      .orderBy(
        billTemplateVersion.refBillTemplateFamilyId,
        billTemplateVersion.isDefault,
      );
    return new Map(
      rows
        .filter(
          (r): r is typeof r & { familyId: string } => r.familyId !== null,
        )
        .map((r) => [
          r.familyId,
          { versionNo: r.versionNo, activatedDatetime: r.activatedDatetime },
        ]),
    );
  },

  // bm57 D1 — the working DRAFT of the kind (at most one, `btv_one_draft_uq`),
  // with its concurrency token.
  async findDraft(
    db: Database,
    { kind, familyId }: { kind: TemplateKind; familyId?: string },
  ): Promise<TemplateDraftRow | null> {
    const [row] = await db
      .select({ version: billTemplateVersion, token: draftToken })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          familyScope(familyId),
          eq(billTemplateVersion.status, "DRAFT"),
        ),
      )
      .limit(1);
    return row ? { ...row.version, token: row.token } : null;
  },

  // bm80 — `findDraft` plus the name of the DRAFT's last writer, for the
  // overwrite warning (code-standards › Invoice Template Types, Next.js rule
  // 5). A LEFT join: a since-deleted writer is "a deleted user"; no recorded
  // writer is `null`. bm81 review fix: also the settings draft's "saved by".
  async findDraftWithModifier(
    db: Database,
    { kind, familyId }: { kind: TemplateKind; familyId?: string },
  ): Promise<
    (TemplateDraftRow & { lastModifiedByName: string | null }) | null
  > {
    const [row] = await db
      .select({
        version: billTemplateVersion,
        token: draftToken,
        name: appuser.userName,
      })
      .from(billTemplateVersion)
      .leftJoin(
        appuser,
        sql`${appuser.id} = ${billTemplateVersion.lastModifiedBy}`,
      )
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          familyScope(familyId),
          eq(billTemplateVersion.status, "DRAFT"),
        ),
      )
      .limit(1);
    if (!row) return null;
    const lastModifiedByName =
      row.version.lastModifiedBy === null
        ? null
        : (row.name ?? "a deleted user");
    return { ...row.version, token: row.token, lastModifiedByName };
  },

  // bm57 D1 — first save: insert the working DRAFT. No files
  // (`btv_draft_has_no_files`, which applies to settings DRAFTs only since
  // bm74), never the default. A concurrent first save is refused by
  // `btv_one_draft_uq` (the service maps the 23505 to `DRAFT_CONFLICT`). bm64:
  // the draft carries its family (`btv_type_scoped_has_family`, which replaced
  // `btv_generated_has_family` in bm74) — the family of the version it is built from.
  async insertDraft(
    tx: Database,
    input: {
      versionNo: number;
      refLayoutVersionId: string;
      refBillTemplateFamilyId: string;
      structure: InvoiceTemplateStructureInput;
      createdBy: string;
      // bm81 review fix — stamp clock_timestamp(), not the transaction's
      // now(), so the token differs from a layout row written in the same
      // transaction (restored settings).
      distinctToken?: boolean;
    },
  ): Promise<TemplateDraftRow> {
    const [row] = await tx
      .insert(billTemplateVersion)
      .values({
        refBillFormatId: INVOICE,
        kind: "generated",
        versionNo: input.versionNo,
        status: "DRAFT",
        isDefault: false,
        refLayoutVersionId: input.refLayoutVersionId,
        refBillTemplateFamilyId: input.refBillTemplateFamilyId,
        structure: input.structure,
        createdBy: input.createdBy,
        // bm77 (D128) — every DRAFT write records its last writer.
        lastModifiedBy: input.createdBy,
        ...(input.distinctToken
          ? { lastModifiedDatetime: sql`clock_timestamp()` }
          : {}),
      })
      .returning({
        ...getTableColumns(billTemplateVersion),
        token: draftToken,
      });
    if (!row) throw new Error("insertDraft returned no row");
    return row;
  },

  // bm78 (Inv #59) — the layout DRAFT a package upload creates. Files are
  // already stored write-once under `blobRef`; `checksum` is the sha256 of the
  // package's `checksums.json`. Written ONLY by installLayoutPackage
  // (guardrail 68).
  async insertLayoutDraft(
    tx: Database,
    input: {
      familyId: string;
      layoutCode: string;
      versionNo: number;
      pageSetup: LayoutPageSetup;
      blobRef: string;
      checksum: string;
      createdBy: string;
    },
  ): Promise<TemplateDraftRow> {
    const [row] = await tx
      .insert(billTemplateVersion)
      .values({
        refBillFormatId: INVOICE,
        kind: "layout",
        versionNo: input.versionNo,
        status: "DRAFT",
        isDefault: false,
        layoutCode: input.layoutCode,
        refBillTemplateFamilyId: input.familyId,
        pageSetup: input.pageSetup,
        blobRef: input.blobRef,
        checksum: input.checksum,
        checksumAlgorithm: "sha256",
        createdBy: input.createdBy,
        lastModifiedBy: input.createdBy,
      })
      .returning({
        ...getTableColumns(billTemplateVersion),
        token: draftToken,
      });
    if (!row) throw new Error("insertLayoutDraft returned no row");
    return row;
  },

  // bm80 (Inv #59) — layout DRAFT → DRAFT, in place: same row and version_no, new files.
  // Called only by install-layout-package.ts (guardrail 68). null → the token moved.
  // The bm74 guard allows exactly these columns on a layout DRAFT → DRAFT;
  // `change_note` stays NULL.
  async overwriteLayoutDraft(
    tx: Database,
    input: {
      id: string;
      expectedToken: string;
      blobRef: string;
      checksum: string;
      pageSetup: LayoutPageSetup;
      actorId: string;
    },
  ): Promise<{ row: BillTemplateVersion; token: string } | null> {
    const [row] = await tx
      .update(billTemplateVersion)
      .set({
        blobRef: input.blobRef,
        checksum: input.checksum,
        checksumAlgorithm: "sha256",
        pageSetup: input.pageSetup,
        lastModifiedDatetime: sql`now()`,
        lastModifiedBy: input.actorId,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, input.id),
          eq(billTemplateVersion.kind, "layout"),
          eq(billTemplateVersion.status, "DRAFT"),
          sql`${draftToken} = ${input.expectedToken}`,
        ),
      )
      .returning({
        ...getTableColumns(billTemplateVersion),
        token: draftToken,
      });
    if (!row) return null;
    const { token, ...version } = row;
    return { row: version, token };
  },

  // bm78 (Inv #62) — point the settings DRAFT at a new layout DRAFT. Bumps the
  // draft's token (`last_modified_datetime`), so an editor holding the old token
  // gets DRAFT_CONFLICT. bm74's guard allows a settings DRAFT to change
  // `ref_layout_version_id`. Returns the new token, or `null` when the row is no
  // longer a settings DRAFT. bm81: a restore also sets `structure` in the same
  // UPDATE (the guard allows `structure` on a settings DRAFT). Review fix: a
  // restore is guarded by the token the dialog saw (#2), and stamped with
  // clock_timestamp() so its token differs from the layout row written in the
  // same transaction — restored settings are a settings change, so a stale
  // editor gets DRAFT_CONFLICT, not bm80's "layout replaced" (#1).
  async repointDraftLayout(
    tx: Database,
    input: {
      id: string;
      layoutVersionId: string;
      actorId: string;
      restore?: {
        structure: InvoiceTemplateStructureInput;
        expectedToken: string;
      };
    },
  ): Promise<string | null> {
    const rows = await tx
      .update(billTemplateVersion)
      .set({
        refLayoutVersionId: input.layoutVersionId,
        ...(input.restore ? { structure: input.restore.structure } : {}),
        lastModifiedBy: input.actorId,
        lastModifiedDatetime: input.restore
          ? sql`clock_timestamp()`
          : sql`now()`,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, input.id),
          eq(billTemplateVersion.status, "DRAFT"),
          eq(billTemplateVersion.kind, "generated"),
          input.restore
            ? sql`${draftToken} = ${input.restore.expectedToken}`
            : undefined,
        ),
      )
      .returning({ token: draftToken });
    return rows[0]?.token ?? null;
  },

  // bm57 D1 — the only DRAFT update the guard trigger permits. Guarded by the
  // caller's token: zero rows means the draft changed (or was consumed), and
  // the caller reports `DRAFT_CONFLICT`. Returns the new token, or `null` on a
  // conflict.
  async updateDraftStructure(
    tx: Database,
    input: {
      id: string;
      structure: InvoiceTemplateStructureInput;
      expectedToken: string;
      actorId: string;
    },
  ): Promise<string | null> {
    const rows = await tx
      .update(billTemplateVersion)
      .set({
        structure: input.structure,
        lastModifiedBy: input.actorId,
        lastModifiedDatetime: sql`now()`,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, input.id),
          eq(billTemplateVersion.status, "DRAFT"),
          sql`${draftToken} = ${input.expectedToken}`,
        ),
      )
      .returning({ token: draftToken });
    return rows[0]?.token ?? null;
  },

  // bm58 D2 step 8 — re-read one DRAFT by id under a row lock, with its token,
  // so the activation transaction decides on the state it will write over.
  // `null` when the row is gone or no longer a DRAFT.
  async findDraftForUpdate(
    tx: Database,
    id: string,
  ): Promise<TemplateDraftRow | null> {
    const [row] = await tx
      .select({ version: billTemplateVersion, token: draftToken })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, id),
          eq(billTemplateVersion.status, "DRAFT"),
        ),
      )
      .limit(1)
      .for("update");
    return row ? { ...row.version, token: row.token } : null;
  },

  // bm58 D2 step 8 — retire the current NON-default ACTIVE of the kind, if any.
  // MUST run before `promoteDraft`: the one-ACTIVE indexes
  // (`btv_one_active_family_uq` for generated, bm64; layout too, from bm79)
  // are checked per statement, so promoting first would violate it. The default row is never
  // touched (it is excluded here, and the guard trigger would refuse anyway).
  // Returns the retired row, or `null` when only the default was in use.
  async retireActive(
    tx: Database,
    { kind, familyId }: { kind: TemplateKind; familyId?: string },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await tx
      .update(billTemplateVersion)
      .set({
        status: "RETIRED",
        retiredDatetime: sql`now()`,
        lastModifiedDatetime: sql`now()`,
      })
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          // Review fix (§24c) — activation retires only within the draft's
          // own family, never another family's ACTIVE version.
          familyScope(familyId),
          eq(billTemplateVersion.status, "ACTIVE"),
          eq(billTemplateVersion.isDefault, false),
        ),
      )
      .returning();
    return row ?? null;
  },

  // bm58 D2 step 8 — DRAFT → ACTIVE, stamping the stored files. Guarded by the
  // draft's token as well as its status, so a draft edited since the caller
  // read it is not promoted. `null` means the guard failed (the caller reports
  // `DRAFT_CONFLICT` and rolls back). The guard trigger allows exactly these
  // columns on this transition and refuses any change to the structure/layout.
  async promoteDraft(
    tx: Database,
    input: {
      id: string;
      expectedToken: string;
      blobRef: string;
      checksum: string;
      checksumAlgorithm: "sha256";
      activatedBy: string;
      changeNote: string;
    },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await tx
      .update(billTemplateVersion)
      .set({
        status: "ACTIVE",
        blobRef: input.blobRef,
        checksum: input.checksum,
        checksumAlgorithm: input.checksumAlgorithm,
        activatedBy: input.activatedBy,
        activatedDatetime: sql`now()`,
        changeNote: input.changeNote,
        lastModifiedDatetime: sql`now()`,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, input.id),
          eq(billTemplateVersion.status, "DRAFT"),
          sql`${draftToken} = ${input.expectedToken}`,
        ),
      )
      .returning();
    return row ?? null;
  },

  // bm79 — layout DRAFT → ACTIVE. Files are NOT set: the guard freezes
  // blob_ref/checksum at activation, and the WHERE re-asserts the checksum
  // step 3 verified. `null` → the caller reports DRAFT_CONFLICT.
  async promoteLayoutDraft(
    tx: Database,
    input: {
      id: string;
      expectedChecksum: string;
      activatedBy: string;
      changeNote: string;
    },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await tx
      .update(billTemplateVersion)
      .set({
        status: "ACTIVE",
        activatedBy: input.activatedBy,
        activatedDatetime: sql`now()`,
        changeNote: input.changeNote,
        lastModifiedDatetime: sql`now()`,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, input.id),
          eq(billTemplateVersion.kind, "layout"),
          eq(billTemplateVersion.status, "DRAFT"),
          eq(billTemplateVersion.checksum, input.expectedChecksum),
        ),
      )
      .returning();
    return row ?? null;
  },

  // bm79 — DRAFT → RETIRED (discard). The bm74 guard allows only status +
  // retired_datetime (last_modified_* are not frozen). `null` when the row is
  // no longer a DRAFT.
  async discardDraft(
    tx: Database,
    { id, actorId }: { id: string; actorId: string },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await tx
      .update(billTemplateVersion)
      .set({
        status: "RETIRED",
        retiredDatetime: sql`now()`,
        lastModifiedDatetime: sql`now()`,
        lastModifiedBy: actorId,
      })
      .where(
        and(
          eq(billTemplateVersion.billTemplateVersionId, id),
          eq(billTemplateVersion.status, "DRAFT"),
        ),
      )
      .returning();
    return row ?? null;
  },
};
