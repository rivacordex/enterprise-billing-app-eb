import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product schema integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // "product" holds FKs into "core", so it must drop first.
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function insertOffering(name: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only)
        VALUES (${name}, false, true, false)
        RETURNING product_offering_id AS id
      `;
      if (!row) throw new Error("Offering insert returned no row.");
      return row.id;
    }

    test("the product schema, its 3 tables, and its 3 sequences exist", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'product'
      `;
      expect(schemas).toHaveLength(1);

      const tables = await sql<{ table_name: string }[]>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'product' AND c.relkind = 'r'
      `;
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        [
          "product_offering",
          "product_specifications",
          "product_offering_price",
        ].sort(),
      );

      const sequences = await sql<{ sequence_name: string }[]>`
        SELECT sequencename AS sequence_name FROM pg_sequences WHERE schemaname = 'product'
      `;
      expect(sequences.map((s) => s.sequence_name).sort()).toEqual(
        [
          "product_offering_seq",
          "product_specifications_seq",
          "product_offering_price_seq",
        ].sort(),
      );
    });

    test("inserted offering rows get PRDOFR-format IDs from the column default", async () => {
      const id = await insertOffering("Test Offering");
      expect(id).toMatch(/^PRDOFR\d{6}$/);
    });

    test("duplicate (product_offering_id, price_type, start_date_time) insert fails (revised Inv. #2)", async () => {
      const offeringId = await insertOffering("Dup Test Offering");
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
        VALUES (${offeringId}, 'Price A', 'recurring', '10.00', 'MYR', 'flat', '2026-01-01T00:00:00Z')
      `;

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Price B', 'recurring', '20.00', 'MYR', 'flat', '2026-01-01T00:00:00Z')
        `,
      ).rejects.toThrow();
    });

    test("flat + NULL amount and tiered + non-NULL amount both fail the CHECK (Inv. #5)", async () => {
      const offeringId = await insertOffering("Check Test Offering");

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Flat Null Amount', 'recurring', NULL, 'MYR', 'flat', '2026-02-01T00:00:00Z')
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Tiered NonNull Amount', 'usage', '5.00', 'MYR', 'tiered', '2026-02-01T00:00:00Z')
        `,
      ).rejects.toThrow();
    });

    test("invalid lifecycle_status is rejected", async () => {
      await expect(
        sql`
          INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only, lifecycle_status)
          VALUES ('Bad Status Offering', false, true, false, 'BOGUS')
        `,
      ).rejects.toThrow();
    });

    test("invalid price_type, pricing_model, and currency are each rejected", async () => {
      const offeringId = await insertOffering("Invalid Enum Offering");

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Bad Price Type', 'bogus', '10.00', 'MYR', 'flat', '2026-03-01T00:00:00Z')
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Bad Pricing Model', 'recurring', '10.00', 'MYR', 'bogus', '2026-03-02T00:00:00Z')
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${offeringId}, 'Bad Currency', 'recurring', '10.00', 'US', 'flat', '2026-03-03T00:00:00Z')
        `,
      ).rejects.toThrow();
    });

    test("last_edited_by FK to a nonexistent user is rejected", async () => {
      await expect(
        sql`
          INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only, last_edited_by)
          VALUES ('Bad FK Offering', false, true, false, 'nonexistent-user-id')
        `,
      ).rejects.toThrow();
    });

    test("the core.permissions row 'products' exists after migration", async () => {
      const rows = await sql<{ permission_name: string }[]>`
        SELECT permission_name FROM core.permissions WHERE permission_name = 'products'
      `;
      expect(rows).toHaveLength(1);
    });
  },
);
