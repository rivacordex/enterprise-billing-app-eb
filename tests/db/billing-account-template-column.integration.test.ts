import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

// cm17-spec §3.4 + §5. Migrates to the last entry before 0050, inserts a BAN,
// then applies 0050 on top: the suite proves the upgrade path (0050 applies on
// a database already at 0049 and the pre-existing BAN reads back NULL) as well
// as the column shape, the named FK to bill_template_version and FK
// enforcement. The fresh path through 0050 is exercised by every other suite's
// full migrate. Fixtures go through raw SQL, same convention as
// billing-schema.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const MIGRATIONS_FOLDER = "./db/migrations";
const CM17_MIGRATION_TAG = "0050_billing_account_template_ref";

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

// A temp copy of db/migrations whose journal stops before 0050. Filtered on
// `when` (what the migrator gates on), so no later migration can be applied
// ahead of 0050 and make the second `migrate` skip it.
function migrationsBeforeCm17(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cm17-pre-0050-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const cm17 = journal.entries.find((e) => e.tag === CM17_MIGRATION_TAG);
  if (!cm17) {
    throw new Error(`${CM17_MIGRATION_TAG} is missing from the journal.`);
  }
  journal.entries = journal.entries.filter((e) => e.when < cm17.when);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe.skipIf(!databaseUrl)(
  "cm17 billing_account template reference column (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let partyRoleId: string;
    let financialAccountId: string;
    let billCycleId: string;
    let preExistingBanId: string;

    async function dropAll(): Promise<void> {
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    function banValues(templateVersionId?: string): Record<string, string> {
      return {
        name: "cm17 BAN",
        ref_party_role_id: partyRoleId,
        ref_financial_account_id: financialAccountId,
        currency: "MYR",
        ref_bill_cycle_id: billCycleId,
        last_edited_by: appuserId,
        ...(templateVersionId === undefined
          ? {}
          : { ref_bill_template_version_id: templateVersionId }),
      };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll();

      const preCm17 = migrationsBeforeCm17();
      try {
        await migrate(drizzle(sql), {
          migrationsFolder: preCm17,
          migrationsSchema: "drizzle",
        });
      } finally {
        rmSync(preCm17, { recursive: true, force: true });
      }

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-cm17', 'Test User', 'test-user-cm17@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("Test appuser insert returned no row.");
      appuserId = user.id;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('cm17 Org', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("Organization insert returned no row.");

      const [role] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'ACTIVE', ${appuserId})
        RETURNING party_role_id AS id
      `;
      if (!role) throw new Error("Party role insert returned no row.");
      partyRoleId = role.id;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, last_edited_by)
        VALUES ('cm17 Cycle', ${appuserId})
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("Bill cycle insert returned no row.");
      billCycleId = cycle.id;

      const [fa] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account
          (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('cm17 FA', ${partyRoleId}, 'MYR', ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!fa) throw new Error("Financial account insert returned no row.");
      financialAccountId = fa.id;

      // Exists before the column does (the database is at 0049 here).
      const [column] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = 'billing_account'
          AND column_name = 'ref_bill_template_version_id'
      `;
      if (column?.n !== 0) {
        throw new Error("The pre-0050 migrate already added the column.");
      }
      const [preExisting] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account ${sql(banValues())}
        RETURNING billing_account_id AS id
      `;
      if (!preExisting) throw new Error("Pre-0050 BAN insert returned no row.");
      preExistingBanId = preExisting.id;

      await migrate(drizzle(sql), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    async function insertBan(
      templateVersionId?: string,
    ): Promise<{ id: string; ref: string | null }> {
      const [row] = await sql<{ id: string; ref: string | null }[]>`
        INSERT INTO billing.billing_account ${sql(banValues(templateVersionId))}
        RETURNING billing_account_id AS id, ref_bill_template_version_id AS ref
      `;
      if (!row) throw new Error("Billing account insert returned no row.");
      return row;
    }

    test("column is text, nullable, with no default", async () => {
      const rows = await sql<
        {
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`
        SELECT data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'billing'
          AND table_name = 'billing_account'
          AND column_name = 'ref_bill_template_version_id'
      `;
      expect(rows).toEqual([
        { data_type: "text", is_nullable: "YES", column_default: null },
      ]);
    });

    test("named FK runs billing_account(ref_bill_template_version_id) → bill_template_version(bill_template_version_id), NO ACTION", async () => {
      const rows = await sql<
        {
          contype: string;
          on_billing_account: boolean;
          refs_template_version: boolean;
          columns: string[];
          ref_columns: string[];
          confdeltype: string;
          confupdtype: string;
          name_len: number;
        }[]
      >`
        SELECT c.contype::text AS contype,
               c.conrelid = 'billing.billing_account'::regclass AS on_billing_account,
               c.confrelid = 'billing.bill_template_version'::regclass AS refs_template_version,
               ARRAY(SELECT a.attname::text
                     FROM unnest(c.conkey) AS k(attnum)
                     JOIN pg_attribute a
                       ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS columns,
               ARRAY(SELECT a.attname::text
                     FROM unnest(c.confkey) AS k(attnum)
                     JOIN pg_attribute a
                       ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_columns,
               c.confdeltype::text AS confdeltype,
               c.confupdtype::text AS confupdtype,
               length(c.conname) AS name_len
        FROM pg_constraint c
        WHERE c.conname = 'billing_account_ref_bill_template_version_id_fk'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contype: "f",
        on_billing_account: true,
        refs_template_version: true,
        columns: ["ref_bill_template_version_id"],
        ref_columns: ["bill_template_version_id"],
        // 'a' = NO ACTION (cm17-spec §2).
        confdeltype: "a",
        confupdtype: "a",
      });
      expect(rows[0]!.name_len).toBeLessThanOrEqual(63);
    });

    test("a BAN that existed before 0050 reads back NULL after the upgrade", async () => {
      const rows = await sql<{ ref: string | null }[]>`
        SELECT ref_bill_template_version_id AS ref
        FROM billing.billing_account
        WHERE billing_account_id = ${preExistingBanId}
      `;
      expect(rows).toEqual([{ ref: null }]);
    });

    test("a BAN inserted without the column reads back NULL", async () => {
      const ban = await insertBan();
      expect(ban.ref).toBeNull();
    });

    test("a non-existent template version id is rejected (23503)", async () => {
      await expect(insertBan("BTV99999999")).rejects.toMatchObject({
        code: "23503",
      });
    });

    test("the seeded default generated version BTV00000002 is accepted", async () => {
      const seededId = SEEDED_GENERATED_ROW.billTemplateVersionId;
      const ban = await insertBan(seededId);
      expect(ban.ref).toBe(seededId);
    });
  },
);
