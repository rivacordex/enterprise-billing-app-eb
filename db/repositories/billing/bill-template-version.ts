import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { customerBill } from "@/db/schema/billing/customer-bill";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import type { TemplateKind } from "@/types/billing";

// bm50-spec §Design D9 — READ-ONLY repository over `bill_template_version`.
// Writes arrive with their units (bm57/bm58). The one format is `INVOICE`
// (code-standards Part 2 TS rule 6), so every read is scoped to it.
const INVOICE = "INVOICE";

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
    { kind }: { kind: TemplateKind },
  ): Promise<TemplateVersionWithUsage[]> {
    const rows = await db
      .select({
        version: billTemplateVersion,
        usedByCount: sql<number>`(
          SELECT count(*)::int FROM ${customerBill} cb
          WHERE cb.ref_bill_template_version_id = ${billTemplateVersion.billTemplateVersionId}
             OR cb.ref_csv_template_version_id = ${billTemplateVersion.billTemplateVersionId}
        )`,
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
};
