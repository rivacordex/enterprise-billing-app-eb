import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { INVOICE_OPTIONAL_SECTION_KEYS } from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm50-spec §Design D1/D2/D4/D7, Tests — the invoice template catalog on a
// fresh DB: seed rows, the CHECK family, the three partial unique indexes, the
// version-rules triggers (guardrail 45 DB half) and the permission row. Schema
// only — migrate() applies 0046, which also seeds the rows. bm64 adds the
// template family: the seeded Standard family, btv_generated_has_family, the
// family-scoped ACTIVE/DRAFT indexes and the family guard (guardrail 61).
const STANDARD = "BTF00000001";
const databaseUrl = process.env.DATABASE_URL;

const GEN_STRUCTURE = JSON.stringify({
  sections: Object.fromEntries(
    INVOICE_OPTIONAL_SECTION_KEYS.map((k) => [k, true]),
  ),
  columns: {},
  footnote: ["Calculations are done in Mbps"],
});

describe.skipIf(!databaseUrl)(
  "bm50 invoice template catalog (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    // A valid non-default generated row at a given version_no (the shape
    // activation produces), in the Standard family unless told otherwise.
    // Reused by the uniqueness/trigger cases.
    async function insertGenerated(
      id: string,
      versionNo: number,
      status: "DRAFT" | "ACTIVE",
      isDefault = false,
      familyId: string | null = STANDARD,
    ): Promise<void> {
      const activated = status === "DRAFT" ? null : sql`now()`;
      const blobRef =
        status === "DRAFT"
          ? null
          : `invoice-templates/generated/INVOICE/v${versionNo}/`;
      const checksum = status === "DRAFT" ? null : "a".repeat(64);
      const algo = status === "DRAFT" ? null : "sha256";
      const note = status === "DRAFT" ? null : "test row";
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES
          (${id}, 'INVOICE', 'generated', ${versionNo}, ${status}, ${isDefault},
           'BTV00000001', ${familyId}, ${GEN_STRUCTURE}::jsonb, ${blobRef}, ${checksum}, ${algo}, ${note}, ${activated})
      `;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll();
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("seeds exactly one bill_format (INVOICE) and three ACTIVE default versions", async () => {
      const formats = await sql<{ bill_format_id: string }[]>`
        SELECT bill_format_id FROM billing.bill_format`;
      expect(formats.map((f) => f.bill_format_id)).toEqual(["INVOICE"]);

      const versions = await sql<
        {
          bill_template_version_id: string;
          kind: string;
          status: string;
          is_default: boolean;
        }[]
      >`SELECT bill_template_version_id, kind, status, is_default
          FROM billing.bill_template_version ORDER BY bill_template_version_id`;
      expect(versions).toEqual([
        {
          bill_template_version_id: "BTV00000001",
          kind: "layout",
          status: "ACTIVE",
          is_default: true,
        },
        {
          bill_template_version_id: "BTV00000002",
          kind: "generated",
          status: "ACTIVE",
          is_default: true,
        },
        {
          bill_template_version_id: "BTV00000003",
          kind: "csv",
          status: "ACTIVE",
          is_default: true,
        },
      ]);
    });

    it("bm64 — seeds one family, Standard (default); only the generated version references it", async () => {
      const families = await sql<
        {
          bill_template_family_id: string;
          code: string;
          name: string;
          kind: string;
          is_default: boolean;
          retired_datetime: Date | null;
        }[]
      >`SELECT bill_template_family_id, code, name, kind, is_default, retired_datetime
          FROM billing.bill_template_family`;
      expect(families).toEqual([
        {
          bill_template_family_id: STANDARD,
          code: "STANDARD",
          name: "Standard",
          kind: "generated",
          is_default: true,
          retired_datetime: null,
        },
      ]);

      const versions = await sql<
        {
          bill_template_version_id: string;
          ref_bill_template_family_id: string | null;
        }[]
      >`SELECT bill_template_version_id, ref_bill_template_family_id
          FROM billing.bill_template_version ORDER BY 1`;
      expect(versions).toEqual([
        {
          bill_template_version_id: "BTV00000001",
          ref_bill_template_family_id: null,
        },
        {
          bill_template_version_id: "BTV00000002",
          ref_bill_template_family_id: STANDARD,
        },
        {
          bill_template_version_id: "BTV00000003",
          ref_bill_template_family_id: null,
        },
      ]);
    });

    it("the seeded generated structure has exactly the union keys, all true (manifest parity)", async () => {
      const [row] = await sql<
        {
          structure: {
            sections: Record<string, boolean>;
            columns: Record<string, boolean>;
          };
        }[]
      >`
        SELECT structure FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      // bm71 (D56) — only the optional sections are stored; no columns.
      expect(Object.keys(row!.structure.sections).sort()).toEqual(
        [...INVOICE_OPTIONAL_SECTION_KEYS].sort(),
      );
      expect(row!.structure.columns).toEqual({});
      expect(Object.values(row!.structure.sections).every(Boolean)).toBe(true);
    });

    it("bm72 — the seeded structure (row and structure.json) parses with the structure schema (general §6.17)", async () => {
      const [row] = await sql<{ structure: unknown }[]>`
        SELECT structure FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      const fromRow = invoiceTemplateStructureSchema.parse(row!.structure);
      const fromFile = invoiceTemplateStructureSchema.parse(
        JSON.parse(
          readFileSync(
            path.join(
              process.cwd(),
              "db/seeds/invoice-templates/generated/INVOICE/v1/structure.json",
            ),
            "utf-8",
          ),
        ),
      );
      expect(fromRow).toEqual(fromFile);
      expect(fromRow).toEqual({
        sections: { payment: true },
        columns: {},
        footnote: [
          "Calculations are done in Mbps",
          "This invoice is billed exclusive of Universal Service Provision (USP)",
        ],
      });
    });

    it("bm64 — refuses a generated version without a family (btv_generated_has_family)", async () => {
      await expect(
        insertGenerated("BTV00000009", 9, "ACTIVE", false, null),
      ).rejects.toMatchObject({
        code: "23514",
        constraint_name: "btv_generated_has_family",
      });
    });

    it("allows one non-default ACTIVE per family alongside the default, refuses a second (btv_one_active_family_uq)", async () => {
      await insertGenerated("BTV00000010", 2, "ACTIVE");
      await expect(
        insertGenerated("BTV00000011", 3, "ACTIVE"),
      ).rejects.toMatchObject({
        code: "23505",
        constraint_name: "btv_one_active_family_uq",
      });
    });

    it("refuses a second DRAFT per family (btv_one_draft_uq)", async () => {
      await insertGenerated("BTV00000020", 4, "DRAFT");
      await expect(
        insertGenerated("BTV00000021", 5, "DRAFT"),
      ).rejects.toMatchObject({
        code: "23505",
        constraint_name: "btv_one_draft_uq",
      });
    });

    it("bm64 — a version never changes family (VERSION_IMMUTABLE)", async () => {
      // BTV00000020 is the DRAFT from the previous case. Clearing its family is
      // an identity change, refused by the guard before any CHECK runs.
      await expect(sql`
        UPDATE billing.bill_template_version SET ref_bill_template_family_id = NULL
        WHERE bill_template_version_id = 'BTV00000020'
      `).rejects.toThrow(/VERSION_IMMUTABLE/);
    });

    it("bm64 — layout and CSV versions are inserted without a family", async () => {
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           layout_code, page_setup, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES ('BTV00000050','INVOICE','layout',2,'ACTIVE',
           'INVTPL-STD-A4','{}'::jsonb,'invoice-templates/layouts/INVTPL-STD-A4/v2/',${"d".repeat(64)},'sha256','test row',now())
      `;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES ('BTV00000051','INVOICE','csv',2,'ACTIVE',
           'invoice-templates/system/csv/v2/',${"e".repeat(64)},'sha256','test row',now())
      `;
      const rows = await sql<
        { kind: string; ref_bill_template_family_id: string | null }[]
      >`
        SELECT kind, ref_bill_template_family_id FROM billing.bill_template_version
        WHERE bill_template_version_id IN ('BTV00000050','BTV00000051') ORDER BY 1`;
      expect(rows).toEqual([
        { kind: "csv", ref_bill_template_family_id: null },
        { kind: "layout", ref_bill_template_family_id: null },
      ]);
    });

    it("bm64 — refuses a second default family (btf_one_default_uq)", async () => {
      await expect(sql`
        INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind, is_default)
        VALUES ('BTF00000090', 'SECOND', 'Second', 'generated', true)
      `).rejects.toMatchObject({
        code: "23505",
        constraint_name: "btf_one_default_uq",
      });
    });

    it("bm64 — Standard is immutable and undeletable", async () => {
      await expect(sql`
        UPDATE billing.bill_template_family SET name = 'Renamed' WHERE bill_template_family_id = ${STANDARD}
      `).rejects.toThrow(/DEFAULT_VERSION_IMMUTABLE/);
      await expect(sql`
        UPDATE billing.bill_template_family SET retired_datetime = now() WHERE bill_template_family_id = ${STANDARD}
      `).rejects.toThrow(/DEFAULT_VERSION_IMMUTABLE/);
      await expect(sql`
        DELETE FROM billing.bill_template_family WHERE bill_template_family_id = ${STANDARD}
      `).rejects.toThrow(/VERSION_DELETE_FORBIDDEN/);
    });

    it("bm64 — a non-default family may only be retired, once", async () => {
      await sql`
        INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind)
        VALUES ('BTF00000091', 'OTHER', 'Other', 'generated')
      `;
      await expect(sql`
        UPDATE billing.bill_template_family SET name = 'Renamed' WHERE bill_template_family_id = 'BTF00000091'
      `).rejects.toThrow(/VERSION_IMMUTABLE/);
      await sql`
        UPDATE billing.bill_template_family SET retired_datetime = now() WHERE bill_template_family_id = 'BTF00000091'
      `;
      await expect(sql`
        UPDATE billing.bill_template_family SET retired_datetime = NULL WHERE bill_template_family_id = 'BTF00000091'
      `).rejects.toThrow(/VERSION_IMMUTABLE/);
    });

    it("refuses a second default per kind (btv_one_default_uq)", async () => {
      await expect(
        insertGenerated("BTV00000030", 6, "ACTIVE", true),
      ).rejects.toThrow(/btv_one_default_uq/);
    });

    it("CHECKs: DRAFT with files, ACTIVE without note, generated without layout, layout DRAFT", async () => {
      // DRAFT with files
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, structure, ref_layout_version_id, ref_bill_template_family_id, blob_ref)
        VALUES ('BTV00000040','INVOICE','generated',40,'DRAFT',${GEN_STRUCTURE}::jsonb,'BTV00000001',${STANDARD},'x/')
      `).rejects.toThrow(/btv_draft_has_no_files/);
      // ACTIVE without change_note (checksum passed as a bound param)
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, structure, ref_layout_version_id, ref_bill_template_family_id, blob_ref, checksum, checksum_algorithm, activated_datetime)
        VALUES ('BTV00000041','INVOICE','generated',41,'ACTIVE',${GEN_STRUCTURE}::jsonb,'BTV00000001',${STANDARD},'x/',${"b".repeat(64)},'sha256',now())
      `).rejects.toThrow(/btv_change_note/);
      // generated without layout/structure
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, ref_bill_template_family_id, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES ('BTV00000042','INVOICE','generated',42,'ACTIVE',${STANDARD},'x/',${"c".repeat(64)},'sha256','n',now())
      `).rejects.toThrow(/btv_generated_has_layout/);
      // layout as DRAFT (only generated may be DRAFT)
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, layout_code, page_setup)
        VALUES ('BTV00000043','INVOICE','layout',43,'DRAFT','X','{}'::jsonb)
      `).rejects.toThrow(/btv_draft_only_generated/);
    });

    it("guardrail 45 — the default is immutable and undeletable", async () => {
      await expect(sql`
        UPDATE billing.bill_template_version SET status='RETIRED', retired_datetime=now()
        WHERE bill_template_version_id='BTV00000002'
      `).rejects.toThrow(/DEFAULT_VERSION_IMMUTABLE/);
      await expect(sql`
        DELETE FROM billing.bill_template_version WHERE bill_template_version_id='BTV00000002'
      `).rejects.toThrow(/VERSION_DELETE_FORBIDDEN/);
    });

    it("guardrail 45 — transitions: DRAFT structure edit allowed, ACTIVE structure edit refused, RETIRED->ACTIVE refused", async () => {
      // Reuse the single DRAFT slot from the earlier test (BTV00000020) —
      // DELETE is trigger-blocked, so rows accumulate; editing its structure is
      // allowed (DRAFT -> DRAFT).
      const edited = JSON.stringify({
        sections: Object.fromEntries(
          INVOICE_OPTIONAL_SECTION_KEYS.map((k) => [k, k !== "payment"]),
        ),
        columns: {},
      });
      await sql`UPDATE billing.bill_template_version SET structure=${edited}::jsonb, last_modified_datetime=now() WHERE bill_template_version_id='BTV00000020'`;

      // A non-default ACTIVE row (BTV00000010, inserted earlier) — structure edit refused.
      await expect(sql`
        UPDATE billing.bill_template_version SET structure=${edited}::jsonb WHERE bill_template_version_id='BTV00000010'
      `).rejects.toThrow(/VERSION_IMMUTABLE/);

      // Retire version 10, then RETIRED -> ACTIVE is refused.
      await sql`UPDATE billing.bill_template_version SET status='RETIRED', retired_datetime=now() WHERE bill_template_version_id='BTV00000010'`;
      await expect(sql`
        UPDATE billing.bill_template_version SET status='ACTIVE' WHERE bill_template_version_id='BTV00000010'
      `).rejects.toThrow(/VERSION_IMMUTABLE/);
    });

    it("seeds the invoice_settings permission row", async () => {
      const rows = await sql<{ permission_name: string }[]>`
        SELECT permission_name FROM core.permissions WHERE permission_name='invoice_settings'`;
      expect(rows).toHaveLength(1);
    });
  },
);
