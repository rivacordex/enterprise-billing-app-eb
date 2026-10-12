import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// cm17-spec §3.4. Fresh-migrates and asserts the per-BAN invoice template
// reference column (0050): shape, the named FK to bill_template_version, NULL
// on existing rows, and FK enforcement. Fixtures go through raw SQL, same
// convention as billing-schema.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

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

describe.skipIf(!databaseUrl)(
  "cm17 billing_account template reference column (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let partyRoleId: string;
    let financialAccountId: string;
    let billCycleId: string;

    async function dropAll(): Promise<void> {
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll();
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

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
    }, 120_000);

    afterAll(async () => {
      await dropAll();
      await sql.end();
    });

    async function insertBan(
      templateVersionId?: string,
    ): Promise<{ id: string; ref: string | null }> {
      const [row] =
        templateVersionId === undefined
          ? await sql<{ id: string; ref: string | null }[]>`
              INSERT INTO billing.billing_account
                (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
              VALUES ('cm17 BAN', ${partyRoleId}, ${financialAccountId}, 'MYR', ${billCycleId}, ${appuserId})
              RETURNING billing_account_id AS id, ref_bill_template_version_id AS ref
            `
          : await sql<{ id: string; ref: string | null }[]>`
              INSERT INTO billing.billing_account
                (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by,
                 ref_bill_template_version_id)
              VALUES ('cm17 BAN', ${partyRoleId}, ${financialAccountId}, 'MYR', ${billCycleId}, ${appuserId},
                      ${templateVersionId})
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

    test("named FK references bill_template_version(bill_template_version_id)", async () => {
      const rows = await sql<
        {
          conname: string;
          contype: string;
          ref_table: string;
          ref_column: string;
          name_len: number;
        }[]
      >`
        SELECT c.conname,
               c.contype,
               c.confrelid::regclass::text AS ref_table,
               a.attname AS ref_column,
               length(c.conname) AS name_len
        FROM pg_constraint c
        JOIN pg_attribute a
          ON a.attrelid = c.confrelid AND a.attnum = ANY (c.confkey)
        WHERE c.conname = 'billing_account_ref_bill_template_version_id_fk'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contype: "f",
        ref_table: "billing.bill_template_version",
        ref_column: "bill_template_version_id",
      });
      expect(rows[0]!.name_len).toBeLessThanOrEqual(63);
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
      const ban = await insertBan("BTV00000002");
      expect(ban.ref).toBe("BTV00000002");
    });
  },
);
