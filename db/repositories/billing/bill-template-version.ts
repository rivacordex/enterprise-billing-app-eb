import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { auditLog } from "@/db/schema/audit";
import { billTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { appuser } from "@/db/schema/identity";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import type { TemplateKind } from "@/types/billing";
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
  // `customer_bill` rows stamped with this version id (as either the template
  // or the CSV stamp). Counted in SQL (no JS reduce).
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
             OR cb.ref_csv_template_version_id = ${billTemplateVersion.billTemplateVersionId}
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

  // `max(version_no) + 1` for the kind, under the kind lock. `btv_version_uq`
  // (per (type, kind) since bm74) is the backstop against a lost race.
  async nextVersionNo(
    tx: Database,
    { kind }: { kind: TemplateKind },
  ): Promise<number> {
    await this.lockKind(tx, { kind });
    const [row] = await tx
      .select({
        maxNo: sql<number>`COALESCE(max(${billTemplateVersion.versionNo}), 0)::int`,
      })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
        ),
      );
    return (row?.maxNo ?? 0) + 1;
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
      })
      .returning({
        ...getTableColumns(billTemplateVersion),
        token: draftToken,
      });
    if (!row) throw new Error("insertDraft returned no row");
    return row;
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
    },
  ): Promise<string | null> {
    const rows = await tx
      .update(billTemplateVersion)
      .set({ structure: input.structure, lastModifiedDatetime: sql`now()` })
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
  // (`btv_one_active_family_uq` for generated, bm64) are checked per
  // statement, so promoting first would violate it. The default row is never
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

  // bm57 D4 — who last saved the draft: the actor of the newest
  // `INVOICE_TEMPLATE_DRAFT_SAVED` audit row for it (the table keeps only the
  // creator, not the last modifier). A LEFT join, so a save by a since-deleted
  // user (`actor_user_id` is SET NULL) still counts as the newest save and is
  // reported as "a deleted user" instead of being skipped for an older saver.
  // `null` only when no audit row exists at all.
  async findLatestDraftSaver(
    db: Database,
    versionId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ name: appuser.userName })
      .from(auditLog)
      .leftJoin(appuser, sql`${appuser.id} = ${auditLog.actorUserId}`)
      .where(
        and(
          eq(auditLog.eventType, "INVOICE_TEMPLATE_DRAFT_SAVED"),
          eq(auditLog.targetId, versionId),
        ),
      )
      .orderBy(desc(auditLog.createdDatetime))
      .limit(1);
    return row ? (row.name ?? "a deleted user") : null;
  },
};
