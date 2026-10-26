import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// cm23-spec §3.12 (Inv. #19). After a full migrate (through 0054) the BAN's
// template reference is the TYPE column `ref_bill_template_family_id`: its
// shape, the named FK to bill_template_family and FK enforcement. Standard's
// id is accepted at the DB level — the "Standard only as NULL" rule is
// assertBindableTemplate's, not a constraint. The 0053 → 0054 upgrade path and
// its precondition abort are billing-account-template-type-migration's.
// Fixtures go through raw SQL, same convention as billing-schema.integration.
const databaseUrl = process.env.DATABASE_URL;

const MIGRATIONS_FOLDER = "./db/migrations";
const STANDARD = "BTF00000001";

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
  "cm23 billing_account template type column (requires DATABASE_URL)",
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

    function banValues(typeId?: string): Record<string, string> {
      return {
        name: "cm23 BAN",
        ref_party_role_id: partyRoleId,
        ref_financial_account_id: financialAccountId,
        currency: "MYR",
        ref_bill_cycle_id: billCycleId,
        last_edited_by: appuserId,
        ...(typeId === undefined
          ? {}
          : { ref_bill_template_family_id: typeId }),
      };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll();
      await migrate(drizzle(sql), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsSchema: "drizzle",
      });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-cm23', 'Test User', 'test-user-cm23@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("Test appuser insert returned no row.");
      appuserId = user.id;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('cm23 Org', 'COMPANY', ${appuserId})
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
        VALUES ('cm23 Cycle', ${appuserId})
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("Bill cycle insert returned no row.");
      billCycleId = cycle.id;

      const [fa] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account
          (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('cm23 FA', ${partyRoleId}, 'MYR', ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!fa) throw new Error("Financial account insert returned no row.");
      financialAccountId = fa.id;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    async function insertBan(
      typeId?: string,
    ): Promise<{ id: string; ref: string | null }> {
      const [row] = await sql<{ id: string; ref: string | null }[]>`
        INSERT INTO billing.billing_account ${sql(banValues(typeId))}
        RETURNING billing_account_id AS id, ref_bill_template_family_id AS ref
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
          AND column_name = 'ref_bill_template_family_id'
      `;
      expect(rows).toEqual([
        { data_type: "text", is_nullable: "YES", column_default: null },
      ]);
    });

    test("named FK runs billing_account(ref_bill_template_family_id) → bill_template_family(bill_template_family_id), NO ACTION", async () => {
      const rows = await sql<
        {
          contype: string;
          on_billing_account: boolean;
          refs_template_family: boolean;
          columns: string[];
          ref_columns: string[];
          confdeltype: string;
          confupdtype: string;
          name_len: number;
        }[]
      >`
        SELECT c.contype::text AS contype,
               c.conrelid = 'billing.billing_account'::regclass AS on_billing_account,
               c.confrelid = 'billing.bill_template_family'::regclass AS refs_template_family,
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
        WHERE c.conname = 'billing_account_ref_bill_template_family_id_fk'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        contype: "f",
        on_billing_account: true,
        refs_template_family: true,
        columns: ["ref_bill_template_family_id"],
        ref_columns: ["bill_template_family_id"],
        // 'a' = NO ACTION (cm23-spec D1).
        confdeltype: "a",
        confupdtype: "a",
      });
      expect(rows[0]!.name_len).toBeLessThanOrEqual(63);
    });

    test("the column carries the cm23 comment", async () => {
      const [row] = await sql<{ comment: string | null }[]>`
        SELECT col_description('billing.billing_account'::regclass, a.attnum) AS comment
        FROM pg_attribute a
        WHERE a.attrelid = 'billing.billing_account'::regclass
          AND a.attname = 'ref_bill_template_family_id'
      `;
      expect(row?.comment).toMatch(/^Invoice template type for this BAN\./);
    });

    test("ref_bill_template_version_id and its FK no longer exist", async () => {
      const columns = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = 'billing_account'
          AND column_name = 'ref_bill_template_version_id'
      `;
      expect(columns).toHaveLength(0);
      const constraints = await sql`
        SELECT 1 FROM pg_constraint
        WHERE conname = 'billing_account_ref_bill_template_version_id_fk'
      `;
      expect(constraints).toHaveLength(0);
    });

    test("a BAN inserted without the column reads back NULL (Standard)", async () => {
      const ban = await insertBan();
      expect(ban.ref).toBeNull();
    });

    test("a non-existent template type id is rejected (23503)", async () => {
      await expect(insertBan("BTF99999999")).rejects.toMatchObject({
        code: "23503",
      });
    });

    test("Standard's id BTF00000001 is accepted at the DB level (NULL-only is the gate's rule)", async () => {
      const ban = await insertBan(STANDARD);
      expect(ban.ref).toBe(STANDARD);
    });
  },
);
