import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { INVOICE_COLUMN_KEYS, INVOICE_SECTION_KEYS } from "@/types/billing";

// bm50-spec §Design D1/D2/D4/D7, Tests — the invoice template catalog on a
// fresh DB: seed rows, the CHECK family, the three partial unique indexes, the
// version-rules triggers (guardrail 45 DB half) and the permission row. Schema
// only — migrate() applies 0046, which also seeds the rows.
const databaseUrl = process.env.DATABASE_URL;

const GEN_STRUCTURE = JSON.stringify({
  sections: Object.fromEntries(INVOICE_SECTION_KEYS.map((k) => [k, true])),
  columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
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
    // activation produces). Reused by the uniqueness/trigger cases.
    async function insertGenerated(
      id: string,
      versionNo: number,
      status: "DRAFT" | "ACTIVE",
      isDefault = false,
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
           ref_layout_version_id, structure, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES
          (${id}, 'INVOICE', 'generated', ${versionNo}, ${status}, ${isDefault},
           'BTV00000001', ${GEN_STRUCTURE}::jsonb, ${blobRef}, ${checksum}, ${algo}, ${note}, ${activated})
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
      expect(Object.keys(row!.structure.sections).sort()).toEqual(
        [...INVOICE_SECTION_KEYS].sort(),
      );
      expect(Object.keys(row!.structure.columns).sort()).toEqual(
        [...INVOICE_COLUMN_KEYS].sort(),
      );
      expect(Object.values(row!.structure.sections).every(Boolean)).toBe(true);
      expect(Object.values(row!.structure.columns).every(Boolean)).toBe(true);
    });

    it("allows one non-default ACTIVE per kind alongside the default, refuses a second (btv_one_active_uq)", async () => {
      await insertGenerated("BTV00000010", 2, "ACTIVE");
      await expect(insertGenerated("BTV00000011", 3, "ACTIVE")).rejects.toThrow(
        /btv_one_active_uq/,
      );
    });

    it("refuses a second DRAFT per kind (btv_one_draft_uq)", async () => {
      await insertGenerated("BTV00000020", 4, "DRAFT");
      await expect(insertGenerated("BTV00000021", 5, "DRAFT")).rejects.toThrow(
        /btv_one_draft_uq/,
      );
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
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, structure, ref_layout_version_id, blob_ref)
        VALUES ('BTV00000040','INVOICE','generated',40,'DRAFT',${GEN_STRUCTURE}::jsonb,'BTV00000001','x/')
      `).rejects.toThrow(/btv_draft_has_no_files/);
      // ACTIVE without change_note (checksum passed as a bound param)
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, structure, ref_layout_version_id, blob_ref, checksum, checksum_algorithm, activated_datetime)
        VALUES ('BTV00000041','INVOICE','generated',41,'ACTIVE',${GEN_STRUCTURE}::jsonb,'BTV00000001','x/',${"b".repeat(64)},'sha256',now())
      `).rejects.toThrow(/btv_change_note/);
      // generated without layout/structure
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
        VALUES ('BTV00000042','INVOICE','generated',42,'ACTIVE','x/',${"c".repeat(64)},'sha256','n',now())
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
          INVOICE_SECTION_KEYS.map((k) => [k, k !== "payment"]),
        ),
        columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
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
