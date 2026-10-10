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
// working-draft writes (`insertDraft`, `updateDraftStructure`); activation
// arrives with bm58. The one format is `INVOICE`
// (code-standards Part 2 TS rule 6), so every read is scoped to it.
const INVOICE = "INVOICE";

// bm57-spec §Design D1 — the draft's optimistic-concurrency token: its
// `last_modified_datetime` rendered in SQL at full microsecond precision. A JS
// `Date` truncates to milliseconds and would never match the stored value, so
// the token is produced and compared as text in the database.
const TOKEN_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
const draftToken = sql<string>`to_char(${billTemplateVersion.lastModifiedDatetime} AT TIME ZONE 'UTC', '${sql.raw(TOKEN_FORMAT)}')`;

export interface TemplateDraftRow extends BillTemplateVersion {
  token: string;
}

export interface TemplateVersionWithUsage extends BillTemplateVersion {
  usedByCount: number;
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
  // order is pinned → this → default (G3/C3). The partial unique index
  // `btv_one_active_uq` guarantees at most one.
  async findActive(
    db: Database,
    { kind }: { kind: TemplateKind },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          eq(billTemplateVersion.status, "ACTIVE"),
          eq(billTemplateVersion.isDefault, false),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findDefault(
    db: Database,
    { kind }: { kind: TemplateKind },
  ): Promise<BillTemplateVersion | null> {
    const [row] = await db
      .select()
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
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
    { kind, withUsage = true }: { kind: TemplateKind; withUsage?: boolean },
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
        ),
      )
      .orderBy(desc(billTemplateVersion.versionNo));
    return rows.map((r) => ({ ...r.version, usedByCount: r.usedByCount }));
  },

  // `max(version_no) + 1` for the kind, serialized by an advisory xact lock
  // (not `FOR UPDATE` on bill_format — `app_runtime` has only SELECT there).
  // `btv_version_uq` is the backstop against a lost race.
  async nextVersionNo(
    tx: Database,
    { kind }: { kind: TemplateKind },
  ): Promise<number> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`billing.bill_template_version:${INVOICE}:${kind}`}))`,
    );
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
    { kind }: { kind: TemplateKind },
  ): Promise<TemplateDraftRow | null> {
    const [row] = await db
      .select({ version: billTemplateVersion, token: draftToken })
      .from(billTemplateVersion)
      .where(
        and(
          eq(billTemplateVersion.refBillFormatId, INVOICE),
          eq(billTemplateVersion.kind, kind),
          eq(billTemplateVersion.status, "DRAFT"),
        ),
      )
      .limit(1);
    return row ? { ...row.version, token: row.token } : null;
  },

  // bm57 D1 — first save: insert the working DRAFT. No files
  // (`btv_draft_has_no_files`), never the default. A concurrent first save is
  // refused by `btv_one_draft_uq` (the service maps the 23505 to
  // `DRAFT_CONFLICT`).
  async insertDraft(
    tx: Database,
    input: {
      versionNo: number;
      refLayoutVersionId: string;
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

  // bm57 D4 — who last saved the draft: the actor of the newest
  // `INVOICE_TEMPLATE_DRAFT_SAVED` audit row for it (the table keeps only the
  // creator, not the last modifier).
  async findLatestDraftSaver(
    db: Database,
    versionId: string,
  ): Promise<string | null> {
    const [row] = await db
      .select({ name: appuser.userName })
      .from(auditLog)
      .innerJoin(appuser, sql`${appuser.id} = ${auditLog.actorUserId}`)
      .where(
        and(
          eq(auditLog.eventType, "INVOICE_TEMPLATE_DRAFT_SAVED"),
          eq(auditLog.targetId, versionId),
        ),
      )
      .orderBy(desc(auditLog.createdDatetime))
      .limit(1);
    return row?.name ?? null;
  },
};
