import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm74-spec §5 (guardrail 75, Inv #65) — `0053` makes the invoice template
// catalog type-scoped, on a POPULATED database. The suite migrates to 0052,
// inserts the Standard rows 0053 must survive, then applies the real folder:
// the backfill, the enabled guards, the precondition abort and every row of
// the spec's refusal matrix. Fixtures go through raw SQL, same convention as
// invoice-template-catalog.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const MIGRATIONS_FOLDER = "./db/migrations";
const BM74_MIGRATION_TAG = "0053_invoice_template_types";

const STANDARD = "BTF00000001";
const STANDARD_LAYOUT = "BTV00000001";
const WHOLESALE = "BTF00000100";
const ACTOR = "test-user-bm74";

const SCHEMAS = [
  "billing",
  "customer",
  "product",
  "inventory",
  "ordering",
  "rating",
  "core",
  "partman",
  "drizzle",
];

const STRUCTURE = JSON.stringify({
  sections: { payment: true },
  columns: {},
  footnote: ["Calculations are done in Mbps"],
});

// A temp copy of db/migrations whose journal stops before 0053. Filtered on
// `when` (what the migrator gates on), the cm17 precedent.
function migrationsBefore0053(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bm74-pre-0053-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const bm74 = journal.entries.find((e) => e.tag === BM74_MIGRATION_TAG);
  if (!bm74) {
    throw new Error(`${BM74_MIGRATION_TAG} is missing from the journal.`);
  }
  journal.entries = journal.entries.filter((e) => e.when < bm74.when);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

// The journal entries from 0053 on: what migrating a 0052 database applies
// (0053 itself, then every later migration, e.g. cm23's 0054).
function migrationsFrom0053Count(): number {
  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  const bm74 = journal.entries.find((e) => e.tag === BM74_MIGRATION_TAG);
  if (!bm74) {
    throw new Error(`${BM74_MIGRATION_TAG} is missing from the journal.`);
  }
  return journal.entries.filter((e) => e.when >= bm74.when).length;
}

describe.skipIf(!databaseUrl)(
  "bm74 type-scoped invoice template catalog (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    async function dropAll(): Promise<void> {
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    // A scratch database at 0052: every schema dropped, then the trimmed
    // folder migrated.
    async function resetTo0052(): Promise<void> {
      await dropAll();
      const pre = migrationsBefore0053();
      try {
        await migrate(drizzle(sql), {
          migrationsFolder: pre,
          migrationsSchema: "drizzle",
        });
      } finally {
        rmSync(pre, { recursive: true, force: true });
      }
    }

    async function migrateAll(): Promise<void> {
      await migrate(drizzle(sql), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: "drizzle",
      });
    }

    async function appliedCount(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      return row!.n;
    }

    async function columnExists(
      table: string,
      column: string,
    ): Promise<boolean> {
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = ${table} AND column_name = ${column}`;
      return rows.length > 0;
    }

    async function insertType(
      id: string,
      code: string,
      name: string,
      layoutCode: string,
    ): Promise<void> {
      await sql`
        INSERT INTO billing.bill_template_family
          (bill_template_family_id, code, name, layout_code, kind)
        VALUES (${id}, ${code}, ${name}, ${layoutCode}, 'generated')`;
    }

    // A layout row. DRAFT and discarded rows carry files too (a layout DRAFT
    // must, `btv_layout_draft_has_files`); only ACTIVE is stamped activated.
    async function insertLayout(opts: {
      id: string;
      typeId: string | null;
      layoutCode: string;
      versionNo: number;
      status: "DRAFT" | "ACTIVE" | "DISCARDED";
      files?: boolean;
    }): Promise<void> {
      const files = opts.files ?? true;
      const status = opts.status === "DISCARDED" ? "RETIRED" : opts.status;
      const active = opts.status === "ACTIVE";
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           ref_bill_template_family_id, layout_code, page_setup, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime, retired_datetime)
        VALUES
          (${opts.id}, 'INVOICE', 'layout', ${opts.versionNo}, ${status},
           ${opts.typeId}, ${opts.layoutCode}, '{}'::jsonb,
           ${files ? `invoice-templates/layouts/${opts.layoutCode}/v${opts.versionNo}/` : null},
           ${files ? "a".repeat(64) : null}, ${files ? "sha256" : null},
           ${active ? "test row" : null}, ${active ? sql`now()` : null},
           ${opts.status === "DISCARDED" ? sql`now()` : null})`;
    }

    // A settings (generated) row. ACTIVE rows carry files, a change note and
    // the activation stamp; a DRAFT has none unless `blobRef` is forced.
    async function insertGenerated(opts: {
      id: string;
      typeId: string;
      layoutId: string;
      versionNo: number;
      status: "DRAFT" | "ACTIVE";
      blobRef?: string;
    }): Promise<void> {
      const active = opts.status === "ACTIVE";
      const blobRef =
        opts.blobRef ??
        (active
          ? `invoice-templates/generated/INVOICE/v${opts.versionNo}/`
          : null);
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           ref_bill_template_family_id, ref_layout_version_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime)
        VALUES
          (${opts.id}, 'INVOICE', 'generated', ${opts.versionNo}, ${opts.status},
           ${opts.typeId}, ${opts.layoutId}, ${STRUCTURE}::jsonb, ${blobRef},
           ${active ? "b".repeat(64) : null}, ${active ? "sha256" : null},
           ${active ? "test row" : null}, ${active ? sql`now()` : null})`;
    }

    // The Standard rows 0053 must survive, as JSON minus the new column.
    async function fixtureRows(): Promise<unknown[]> {
      const rows = await sql<{ r: unknown }[]>`
        SELECT to_jsonb(v) - 'last_modified_by' AS r FROM billing.bill_template_version v
        WHERE bill_template_version_id IN ('BTV00000010', 'BTV00000011')
        ORDER BY bill_template_version_id`;
      return rows.map((row) => row.r);
    }

    beforeAll(() => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
    });

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    describe("preconditions", () => {
      it("a second pre-existing type aborts 0053 with MIGRATION_PRECONDITION and changes nothing", async () => {
        await resetTo0052();
        // An INSERT, so the family guard (UPDATE/DELETE only) does not fire.
        await sql`
          INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind)
          VALUES ('BTF00000099', 'EXTRA', 'Extra', 'generated')`;
        const before = await appliedCount();

        // drizzle wraps the driver error (its message quotes the SQL), so read
        // the Postgres error itself.
        const err: unknown = await migrateAll().then(
          () => null,
          (e: unknown) => e,
        );
        const pgError = (err as { cause?: unknown } | null)?.cause ?? err;
        expect((pgError as Error | null)?.message).toMatch(
          /^MIGRATION_PRECONDITION: 0053 expects exactly one template type/,
        );

        expect(await appliedCount()).toBe(before);
        expect(await columnExists("bill_template_family", "layout_code")).toBe(
          false,
        );
        expect(
          await columnExists("bill_template_version", "last_modified_by"),
        ).toBe(false);
      }, 180_000);
    });

    describe("populated-database apply and the refusal matrix", () => {
      let fixturesBefore: unknown[];

      beforeAll(async () => {
        await resetTo0052();
        await sql`
          INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
          VALUES (${ACTOR}, 'Test User', 'test-user-bm74@example.com', 'LOCAL', 'ACTIVE')`;
        // Standard generated v2 ACTIVE (non-default) and v3 DRAFT on layout v1.
        await insertGenerated({
          id: "BTV00000010",
          typeId: STANDARD,
          layoutId: STANDARD_LAYOUT,
          versionNo: 2,
          status: "ACTIVE",
        });
        await insertGenerated({
          id: "BTV00000011",
          typeId: STANDARD,
          layoutId: STANDARD_LAYOUT,
          versionNo: 3,
          status: "DRAFT",
        });
        fixturesBefore = await fixtureRows();

        const before = await appliedCount();
        await migrateAll();
        expect(await appliedCount()).toBe(before + migrationsFrom0053Count());
      }, 180_000);

      it("backfills Standard's layout_code and the default layout's type", async () => {
        const [type] = await sql<{ layout_code: string }[]>`
          SELECT layout_code FROM billing.bill_template_family
          WHERE bill_template_family_id = ${STANDARD}`;
        expect(type?.layout_code).toBe("INVTPL-STD-A4");
        const [layout] = await sql<
          { ref_bill_template_family_id: string | null }[]
        >`
          SELECT ref_bill_template_family_id FROM billing.bill_template_version
          WHERE bill_template_version_id = ${STANDARD_LAYOUT}`;
        expect(layout?.ref_bill_template_family_id).toBe(STANDARD);
      });

      it("leaves the v2/v3 fixtures unchanged", async () => {
        expect(await fixtureRows()).toEqual(fixturesBefore);
      });

      it("leaves both guard triggers enabled", async () => {
        const rows = await sql<{ tgname: string; tgenabled: string }[]>`
          SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgname IN ('bill_template_version_guard_trg', 'bill_template_family_guard_trg')
          ORDER BY tgname`;
        expect(rows).toEqual([
          { tgname: "bill_template_family_guard_trg", tgenabled: "O" },
          { tgname: "bill_template_version_guard_trg", tgenabled: "O" },
        ]);
      });

      it("adds last_modified_by, nullable", async () => {
        const [col] = await sql<{ is_nullable: string }[]>`
          SELECT is_nullable FROM information_schema.columns
          WHERE table_schema = 'billing' AND table_name = 'bill_template_version'
            AND column_name = 'last_modified_by'`;
        expect(col?.is_nullable).toBe("YES");
      });

      it("keeps the four reused index names and adds btv_version_csv_uq", async () => {
        const rows = await sql<{ indexname: string }[]>`
          SELECT indexname FROM pg_indexes
          WHERE schemaname = 'billing' AND tablename = 'bill_template_version'
            AND indexname IN ('btv_version_uq', 'btv_version_csv_uq', 'btv_one_draft_uq',
                              'btv_one_active_family_uq', 'btv_one_active_uq')
          ORDER BY indexname`;
        expect(rows.map((r) => r.indexname)).toEqual([
          "btv_one_active_family_uq",
          "btv_one_active_uq",
          "btv_one_draft_uq",
          "btv_version_csv_uq",
          "btv_version_uq",
        ]);
      });

      // --- Type (bill_template_family) rules ---------------------------------

      it("refuses a case or space variant of Standard's name", async () => {
        await expect(
          insertType("BTF00000201", "N1", "standard", "INVTPL-N1"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_ci_uq" });
        await expect(
          insertType("BTF00000202", "N2", " Standard", "INVTPL-N2"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_spacing" });
        await expect(
          insertType("BTF00000203", "N3", "STANDARD", "INVTPL-N3"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_ci_uq" });
      });

      it("refuses doubled spaces, a too-short name and a bad character", async () => {
        await expect(
          insertType("BTF00000204", "N4", "Whole  sale", "INVTPL-N4"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_spacing" });
        await expect(
          insertType("BTF00000205", "N5", "ab", "INVTPL-N5"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_format" });
        await expect(
          insertType("BTF00000206", "N6", "Café", "INVTPL-N6"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_format" });
      });

      it("refuses a lower-case code and a layout code without the INVTPL- prefix", async () => {
        await expect(
          insertType("BTF00000207", "wholesale", "Code Case", "INVTPL-N7"),
        ).rejects.toMatchObject({ constraint_name: "btf_code_format" });
        await expect(
          insertType("BTF00000208", "N8", "Layout Case", "WHOLESALE"),
        ).rejects.toMatchObject({ constraint_name: "btf_layout_code_format" });
      });

      it("refuses a second type reusing INVTPL-STD-A4", async () => {
        await expect(
          insertType("BTF00000209", "N9", "Reuse", "INVTPL-STD-A4"),
        ).rejects.toMatchObject({ constraint_name: "btf_layout_code_uq" });
      });

      it("accepts a well-formed second type, then refuses any identity update", async () => {
        await insertType(
          WHOLESALE,
          "WHOLESALE",
          "Wholesale",
          "INVTPL-WHOLESALE",
        );
        await expect(sql`
          UPDATE billing.bill_template_family SET name = 'Renamed'
          WHERE bill_template_family_id = ${WHOLESALE}`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_family SET code = 'RENAMED'
          WHERE bill_template_family_id = ${WHOLESALE}`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_family SET layout_code = 'INVTPL-RENAMED'
          WHERE bill_template_family_id = ${WHOLESALE}`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
      });

      it("allows retiring a non-default type; its name stays reserved", async () => {
        await insertType("BTF00000101", "RETIREE", "Retiree", "INVTPL-RETIREE");
        await sql`
          UPDATE billing.bill_template_family SET retired_datetime = now()
          WHERE bill_template_family_id = 'BTF00000101'`;
        const [row] = await sql<{ retired: boolean }[]>`
          SELECT retired_datetime IS NOT NULL AS retired FROM billing.bill_template_family
          WHERE bill_template_family_id = 'BTF00000101'`;
        expect(row?.retired).toBe(true);
        await expect(
          insertType("BTF00000210", "N10", "RETIREE", "INVTPL-N10"),
        ).rejects.toMatchObject({ constraint_name: "btf_name_ci_uq" });
      });

      // --- Version (bill_template_version) rules -----------------------------

      it("refuses a layout row with no type", async () => {
        await expect(
          insertLayout({
            id: "BTV00000300",
            typeId: null,
            layoutCode: "INVTPL-STD-A4",
            versionNo: 30,
            status: "ACTIVE",
          }),
        ).rejects.toMatchObject({
          constraint_name: "btv_type_scoped_has_family",
        });
      });

      it("refuses a CSV row with a type and a CSV DRAFT", async () => {
        await expect(sql`
          INSERT INTO billing.bill_template_version
            (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
             ref_bill_template_family_id, blob_ref, checksum, checksum_algorithm, change_note, activated_datetime)
          VALUES ('BTV00000301', 'INVOICE', 'csv', 2, 'ACTIVE', ${STANDARD},
             'invoice-templates/system/csv/v2/', ${"c".repeat(64)}, 'sha256', 'test row', now())
        `).rejects.toMatchObject({ constraint_name: "btv_csv_has_no_family" });
        await expect(sql`
          INSERT INTO billing.bill_template_version
            (bill_template_version_id, ref_bill_format_id, kind, version_no, status)
          VALUES ('BTV00000302', 'INVOICE', 'csv', 3, 'DRAFT')
        `).rejects.toMatchObject({ constraint_name: "btv_draft_not_csv" });
      });

      it("refuses a settings row of one type pointing at another type's layout", async () => {
        await expect(
          insertGenerated({
            id: "BTV00000303",
            typeId: WHOLESALE,
            layoutId: STANDARD_LAYOUT,
            versionNo: 1,
            status: "DRAFT",
          }),
        ).rejects.toMatchObject({ constraint_name: "btv_pair_same_type_fk" });
      });

      it("refuses a layout row carrying another type's layout_code", async () => {
        await expect(
          insertLayout({
            id: "BTV00000304",
            typeId: WHOLESALE,
            layoutCode: "INVTPL-STD-A4",
            versionNo: 1,
            status: "ACTIVE",
          }),
        ).rejects.toMatchObject({
          constraint_name: "btv_layout_code_of_type_fk",
        });
      });

      it("allows layout v1 for two types, refuses a second v1 for one type", async () => {
        // Standard already holds layout v1 (BTV00000001).
        await insertLayout({
          id: "BTV00000310",
          typeId: WHOLESALE,
          layoutCode: "INVTPL-WHOLESALE",
          versionNo: 1,
          status: "ACTIVE",
        });
        // A discarded row, so only the version index can object.
        await expect(
          insertLayout({
            id: "BTV00000311",
            typeId: WHOLESALE,
            layoutCode: "INVTPL-WHOLESALE",
            versionNo: 1,
            status: "DISCARDED",
          }),
        ).rejects.toMatchObject({ constraint_name: "btv_version_uq" });
      });

      it("refuses a second non-default ACTIVE layout for one type", async () => {
        await expect(
          insertLayout({
            id: "BTV00000312",
            typeId: WHOLESALE,
            layoutCode: "INVTPL-WHOLESALE",
            versionNo: 2,
            status: "ACTIVE",
          }),
        ).rejects.toMatchObject({
          constraint_name: "btv_one_active_family_uq",
        });
      });

      it("allows one layout DRAFT and one settings DRAFT per type, refuses a second layout DRAFT", async () => {
        await insertLayout({
          id: "BTV00000320",
          typeId: WHOLESALE,
          layoutCode: "INVTPL-WHOLESALE",
          versionNo: 3,
          status: "DRAFT",
        });
        await expect(
          insertLayout({
            id: "BTV00000321",
            typeId: WHOLESALE,
            layoutCode: "INVTPL-WHOLESALE",
            versionNo: 4,
            status: "DRAFT",
          }),
        ).rejects.toMatchObject({ constraint_name: "btv_one_draft_uq" });
        await insertGenerated({
          id: "BTV00000322",
          typeId: WHOLESALE,
          layoutId: "BTV00000310",
          versionNo: 1,
          status: "DRAFT",
        });
        const rows = await sql<{ kind: string }[]>`
          SELECT kind FROM billing.bill_template_version
          WHERE ref_bill_template_family_id = ${WHOLESALE} AND status = 'DRAFT'
          ORDER BY kind`;
        expect(rows.map((r) => r.kind)).toEqual(["generated", "layout"]);
      });

      it("refuses a layout DRAFT without files", async () => {
        await expect(
          insertLayout({
            id: "BTV00000323",
            typeId: WHOLESALE,
            layoutCode: "INVTPL-WHOLESALE",
            versionNo: 5,
            status: "DRAFT",
            files: false,
          }),
        ).rejects.toMatchObject({
          constraint_name: "btv_layout_draft_has_files",
        });
      });

      it("refuses a settings DRAFT with a blob_ref", async () => {
        await expect(
          insertGenerated({
            id: "BTV00000324",
            typeId: WHOLESALE,
            layoutId: "BTV00000310",
            versionNo: 6,
            status: "DRAFT",
            blobRef: "x/",
          }),
        ).rejects.toMatchObject({ constraint_name: "btv_draft_has_no_files" });
      });

      it("a layout DRAFT may overwrite its files and page_setup", async () => {
        await sql`
          UPDATE billing.bill_template_version
             SET blob_ref = 'invoice-templates/layouts/INVTPL-WHOLESALE/v3b/',
                 checksum = ${"d".repeat(64)},
                 page_setup = '{"format":"A4"}'::jsonb
           WHERE bill_template_version_id = 'BTV00000320'`;
        const [row] = await sql<{ checksum: string }[]>`
          SELECT checksum FROM billing.bill_template_version
          WHERE bill_template_version_id = 'BTV00000320'`;
        expect(row?.checksum).toBe("d".repeat(64));
      });

      it("a layout DRAFT may not change structure, ref_layout_version_id or layout_code", async () => {
        await expect(sql`
          UPDATE billing.bill_template_version SET structure = ${STRUCTURE}::jsonb
          WHERE bill_template_version_id = 'BTV00000320'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_version SET ref_layout_version_id = 'BTV00000310'
          WHERE bill_template_version_id = 'BTV00000320'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_version SET layout_code = 'INVTPL-STD-A4'
          WHERE bill_template_version_id = 'BTV00000320'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
      });

      it("a settings DRAFT may re-point to another same-type layout", async () => {
        await sql`
          UPDATE billing.bill_template_version SET ref_layout_version_id = 'BTV00000320'
          WHERE bill_template_version_id = 'BTV00000322'`;
        const [row] = await sql<{ ref_layout_version_id: string }[]>`
          SELECT ref_layout_version_id FROM billing.bill_template_version
          WHERE bill_template_version_id = 'BTV00000322'`;
        expect(row?.ref_layout_version_id).toBe("BTV00000320");
      });

      it("a settings DRAFT may not change its blob_ref", async () => {
        await expect(sql`
          UPDATE billing.bill_template_version SET blob_ref = 'x/'
          WHERE bill_template_version_id = 'BTV00000322'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
      });

      it("a settings DRAFT may change last_modified_by", async () => {
        await sql`
          UPDATE billing.bill_template_version SET last_modified_by = ${ACTOR}
          WHERE bill_template_version_id = 'BTV00000322'`;
        const [row] = await sql<{ last_modified_by: string | null }[]>`
          SELECT last_modified_by FROM billing.bill_template_version
          WHERE bill_template_version_id = 'BTV00000322'`;
        expect(row?.last_modified_by).toBe(ACTOR);
      });

      it("activating a layout DRAFT may not change its files; unchanged (with a note) it activates", async () => {
        // Free the one non-default ACTIVE layout slot first (ACTIVE -> RETIRED).
        await sql`
          UPDATE billing.bill_template_version SET status = 'RETIRED', retired_datetime = now()
          WHERE bill_template_version_id = 'BTV00000310'`;
        await expect(sql`
          UPDATE billing.bill_template_version
             SET status = 'ACTIVE', activated_datetime = now(), change_note = 'go live',
                 checksum = ${"e".repeat(64)}
           WHERE bill_template_version_id = 'BTV00000320'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await sql`
          UPDATE billing.bill_template_version
             SET status = 'ACTIVE', activated_datetime = now(), activated_by = ${ACTOR},
                 change_note = 'go live'
           WHERE bill_template_version_id = 'BTV00000320'`;
        const [row] = await sql<{ status: string; checksum: string }[]>`
          SELECT status, checksum FROM billing.bill_template_version
          WHERE bill_template_version_id = 'BTV00000320'`;
        expect(row).toEqual({ status: "ACTIVE", checksum: "d".repeat(64) });
      });

      it("discards a layout DRAFT and a settings DRAFT; refuses a discard without retired_datetime or with a file change", async () => {
        await insertLayout({
          id: "BTV00000330",
          typeId: WHOLESALE,
          layoutCode: "INVTPL-WHOLESALE",
          versionNo: 7,
          status: "DRAFT",
        });
        await expect(sql`
          UPDATE billing.bill_template_version SET status = 'RETIRED'
          WHERE bill_template_version_id = 'BTV00000330'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_version
             SET status = 'RETIRED', retired_datetime = now(), blob_ref = 'x/'
           WHERE bill_template_version_id = 'BTV00000330'`).rejects.toThrow(
          /VERSION_IMMUTABLE/,
        );
        await sql`
          UPDATE billing.bill_template_version SET status = 'RETIRED', retired_datetime = now()
          WHERE bill_template_version_id IN ('BTV00000330', 'BTV00000322')`;
        const rows = await sql<
          {
            bill_template_version_id: string;
            status: string;
            activated_datetime: Date | null;
            change_note: string | null;
          }[]
        >`
          SELECT bill_template_version_id, status, activated_datetime, change_note
          FROM billing.bill_template_version
          WHERE bill_template_version_id IN ('BTV00000322', 'BTV00000330')
          ORDER BY bill_template_version_id`;
        expect(rows).toEqual([
          {
            bill_template_version_id: "BTV00000322",
            status: "RETIRED",
            activated_datetime: null,
            change_note: null,
          },
          {
            bill_template_version_id: "BTV00000330",
            status: "RETIRED",
            activated_datetime: null,
            change_note: null,
          },
        ]);
      });

      it("refuses any update of Standard's default layout and type", async () => {
        await expect(sql`
          UPDATE billing.bill_template_version SET change_note = 'x'
          WHERE bill_template_version_id = ${STANDARD_LAYOUT}`).rejects.toThrow(
          /DEFAULT_VERSION_IMMUTABLE/,
        );
        await expect(sql`
          UPDATE billing.bill_template_family SET retired_datetime = now()
          WHERE bill_template_family_id = ${STANDARD}`).rejects.toThrow(
          /DEFAULT_VERSION_IMMUTABLE/,
        );
      });
    });
  },
);
