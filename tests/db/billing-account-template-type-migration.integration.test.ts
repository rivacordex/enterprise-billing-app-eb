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
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

// cm23-spec §3.12 (D1, Inv. #19) — `0054` swaps the BAN's version reference
// for a type reference on a POPULATED database, and refuses to lose data. The
// suite migrates to 0053 (the bm74 trimmed-journal harness), inserts a BAN,
// then applies the real folder: a non-NULL `ref_bill_template_version_id`
// aborts with MIGRATION_PRECONDITION and leaves the old column; with every BAN
// NULL it applies and the BAN reads `ref_bill_template_family_id IS NULL`.
const databaseUrl = process.env.DATABASE_URL;

const MIGRATIONS_FOLDER = "./db/migrations";
const CM23_MIGRATION_TAG = "0054_billing_account_template_type";

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

// A temp copy of db/migrations whose journal stops before 0054. Filtered on
// `when` (what the migrator gates on), the cm17/bm74 precedent.
function migrationsBefore0054(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cm23-pre-0054-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const cm23 = journal.entries.find((e) => e.tag === CM23_MIGRATION_TAG);
  if (!cm23) {
    throw new Error(`${CM23_MIGRATION_TAG} is missing from the journal.`);
  }
  journal.entries = journal.entries.filter((e) => e.when < cm23.when);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe.skipIf(!databaseUrl)(
  "cm23 0054 billing_account template type migration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let banId: string;

    async function dropAll(): Promise<void> {
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
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

    async function columnExists(column: string): Promise<boolean> {
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = 'billing_account'
          AND column_name = ${column}`;
      return rows.length > 0;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll();
      const pre = migrationsBefore0054();
      try {
        await migrate(drizzle(sql), {
          migrationsFolder: pre,
          migrationsSchema: "drizzle",
        });
      } finally {
        rmSync(pre, { recursive: true, force: true });
      }

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-cm23-mig', 'Test User', 'test-user-cm23-mig@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id`;
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('cm23 Migration Org', 'COMPANY', ${user!.id})
        RETURNING organization_id AS id`;
      const [role] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'ACTIVE', ${user!.id})
        RETURNING party_role_id AS id`;
      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, last_edited_by)
        VALUES ('cm23 Migration Cycle', ${user!.id})
        RETURNING bill_cycle_id AS id`;
      const [fa] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account
          (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('cm23 FA', ${role!.id}, 'MYR', ${user!.id})
        RETURNING financial_account_id AS id`;
      // A BAN bound to a version by SQL bypass — v1 never allowed this.
      const [ban] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency,
           ref_bill_cycle_id, last_edited_by, ref_bill_template_version_id)
        VALUES ('cm23 BAN', ${role!.id}, ${fa!.id}, 'MYR', ${cycle!.id}, ${user!.id},
                ${SEEDED_GENERATED_ROW.billTemplateVersionId})
        RETURNING billing_account_id AS id`;
      banId = ban!.id;
    }, 180_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("a non-NULL ref_bill_template_version_id aborts 0054 with MIGRATION_PRECONDITION and leaves the old column", async () => {
      const before = await appliedCount();

      // drizzle wraps the driver error (its message quotes the SQL), so read
      // the Postgres error itself.
      const err: unknown = await migrateAll().then(
        () => null,
        (e: unknown) => e,
      );
      const pgError = (err as { cause?: unknown } | null)?.cause ?? err;
      expect((pgError as Error | null)?.message).toMatch(
        /^MIGRATION_PRECONDITION: billing_account\.ref_bill_template_version_id is non-NULL on 1 row\(s\)/,
      );

      expect(await appliedCount()).toBe(before);
      expect(await columnExists("ref_bill_template_version_id")).toBe(true);
      expect(await columnExists("ref_bill_template_family_id")).toBe(false);
      const [row] = await sql<{ ref: string | null }[]>`
        SELECT ref_bill_template_version_id AS ref
        FROM billing.billing_account WHERE billing_account_id = ${banId}`;
      expect(row?.ref).toBe(SEEDED_GENERATED_ROW.billTemplateVersionId);
    }, 180_000);

    it("with every BAN NULL, 0054 applies and every BAN reads ref_bill_template_family_id IS NULL", async () => {
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_version_id = NULL`;
      const before = await appliedCount();

      await migrateAll();

      expect(await appliedCount()).toBe(before + 1);
      expect(await columnExists("ref_bill_template_version_id")).toBe(false);
      expect(await columnExists("ref_bill_template_family_id")).toBe(true);
      const rows = await sql<{ id: string; ref: string | null }[]>`
        SELECT billing_account_id AS id, ref_bill_template_family_id AS ref
        FROM billing.billing_account`;
      expect(rows).toEqual([{ id: banId, ref: null }]);
    }, 180_000);
  },
);
