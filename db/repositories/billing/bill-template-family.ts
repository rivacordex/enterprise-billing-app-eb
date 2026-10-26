import { and, asc, desc, eq, isNull, not, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billTemplateFamily } from "@/db/schema/billing/bill-template-family";
import type { BillTemplateFamily } from "@/types/billing";

// bm64-spec §4 / bm77 — the repository over `bill_template_family` (invoice
// template types). Since bm77 `app_runtime` may INSERT (create type) and UPDATE
// (retire, bm83); DELETE stays revoked, and the `bill_template_family_guard`
// trigger (0053) allows only `retired_datetime` to change. Per code-standards
// › Invoice Template Types General rule 9 there is NO function here that
// updates `name`, `code` or `layout_code`.
export const billTemplateFamilyRepository = {
  // The default family (Standard, `BTF00000001`), or `null`. `btf_one_default_uq`
  // guarantees at most one.
  async findDefault(tx: Database): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .select()
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.isDefault, true))
      .limit(1);
    return row ?? null;
  },

  async findById(tx: Database, id: string): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .select()
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.billTemplateFamilyId, id))
      .limit(1);
    return row ?? null;
  },

  // bm78 (Inv #66) — the one type-row lock. Always inside a db.transaction; when two
  // types are locked, the caller locks them in ascending bill_template_family_id order.
  async lockTemplateType(
    tx: Database,
    typeId: string,
    mode: "update" | "share",
  ): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .select()
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.billTemplateFamilyId, typeId))
      .for(mode === "update" ? "update" : "share");
    return row ?? null;
  },

  // bm77 — every type, retired included: the default first, then by name.
  async listAll(db: Database): Promise<BillTemplateFamily[]> {
    return db
      .select()
      .from(billTemplateFamily)
      .orderBy(
        desc(billTemplateFamily.isDefault),
        asc(billTemplateFamily.name),
      );
  },

  // bm77 — the type whose name equals `name` case- and space-insensitively,
  // retired included (a retired name stays reserved; `btf_name_ci_uq`).
  async findByNameCi(
    db: Database,
    name: string,
  ): Promise<BillTemplateFamily | null> {
    const [row] = await db
      .select()
      .from(billTemplateFamily)
      .where(
        sql`lower(btrim(${billTemplateFamily.name})) = lower(btrim(${name}))`,
      )
      .limit(1);
    return row ?? null;
  },

  async codeExists(db: Database, code: string): Promise<boolean> {
    const [row] = await db
      .select({ id: billTemplateFamily.billTemplateFamilyId })
      .from(billTemplateFamily)
      .where(eq(billTemplateFamily.code, code))
      .limit(1);
    return row !== undefined;
  },

  // bm77 — create type: a non-default `generated`-kind type with no versions.
  async insertType(
    tx: Database,
    input: {
      code: string;
      name: string;
      layoutCode: string;
      createdBy: string;
    },
  ): Promise<BillTemplateFamily> {
    const [row] = await tx
      .insert(billTemplateFamily)
      .values({
        code: input.code,
        name: input.name,
        layoutCode: input.layoutCode,
        kind: "generated",
        isDefault: false,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("insertType returned no row");
    return row;
  },

  // bm83 (Inv #65, #67) — the ONE update the type guard allows: retirement. null when the
  // row is already retired or is the default (callers re-check first; this is the backstop).
  async retireType(
    tx: Database,
    typeId: string,
  ): Promise<BillTemplateFamily | null> {
    const [row] = await tx
      .update(billTemplateFamily)
      .set({ retiredDatetime: sql`now()` })
      .where(
        and(
          eq(billTemplateFamily.billTemplateFamilyId, typeId),
          isNull(billTemplateFamily.retiredDatetime),
          not(billTemplateFamily.isDefault),
        ),
      )
      .returning();
    return row ?? null;
  },

  // bm77 — the types a BAN may be bound to, besides Standard (which is NULL): not default,
  // not retired, with a non-default ACTIVE settings version. By name ascending. Read by
  // Customer Management's listBindableTemplateTypes (cm23) and the retire target picker (bm83).
  async listUsable(
    db: Database,
  ): Promise<{ billTemplateFamilyId: string; name: string }[]> {
    const rows = await db.execute<{
      bill_template_family_id: string;
      name: string;
    }>(sql`
      SELECT btf.bill_template_family_id, btf.name
      FROM billing.bill_template_family btf
      WHERE NOT btf.is_default AND btf.retired_datetime IS NULL
        AND EXISTS (SELECT 1 FROM billing.bill_template_version v
                    WHERE v.ref_bill_template_family_id = btf.bill_template_family_id
                      AND v.kind = 'generated' AND v.status = 'ACTIVE' AND NOT v.is_default)
      ORDER BY btf.name`);
    return rows.map((r) => ({
      billTemplateFamilyId: r.bill_template_family_id,
      name: r.name,
    }));
  },
};
