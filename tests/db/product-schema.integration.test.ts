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
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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

    test("the product schema, its tables, and its sequences exist", async () => {
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
      // pm57 (Part 5) added the two rate-card tables to the product schema.
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        [
          "product_offering",
          "product_specifications",
          "product_offering_price",
          "ratecard_version",
          "ratecard_ran_usage_lkp",
        ].sort(),
      );

      const sequences = await sql<{ sequence_name: string }[]>`
        SELECT sequencename AS sequence_name FROM pg_sequences WHERE schemaname = 'product'
      `;
      // `ratecard_ran_usage_lkp` uses a ULID PK, so it adds no sequence; only
      // `ratecard_version_seq` joins the three original ones (pm57).
      expect(sequences.map((s) => s.sequence_name).sort()).toEqual(
        [
          "product_offering_seq",
          "product_specifications_seq",
          "product_offering_price_seq",
          "ratecard_version_seq",
        ].sort(),
      );
    });

    test("inserted offering rows get PRDOFR-format IDs from the column default", async () => {
      const id = await insertOffering("Test Offering");
      expect(id).toMatch(/^PRDOFR\d{8}$/);
    });

    // pm56a: rekeyed to pm46's `product_offering_price_component_start_unique`
    // (product_offering_id, component_type, unit_of_measure, start_date_time)
    // with NULLS NOT DISTINCT — two NULL-unit flat_fee rows at one start collide.
    const FLAT_FEE_RECURRING = JSON.stringify({
      "@type": "flat_fee",
      specVersion: 1,
      plaSpecId: null,
      priceType: "recurring",
      appliesAt: "billing",
      basis: "flat",
      boundTo: null,
      params: { amount: "10.00" },
    });

    test("duplicate (product_offering_id, component_type, unit_of_measure, start_date_time) insert fails (Inv. #2, rekeyed)", async () => {
      const offeringId = await insertOffering("Dup Test Offering");
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component,
           recurring_charge_period_length, recurring_charge_period_type,
           currency, start_date_time)
        VALUES (${offeringId}, 'Price A', 'flat_fee', ${FLAT_FEE_RECURRING}::jsonb,
                1, 'months', 'MYR', '2026-01-01T00:00:00Z')
      `;

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             recurring_charge_period_length, recurring_charge_period_type,
             currency, start_date_time)
          VALUES (${offeringId}, 'Price B', 'flat_fee', ${FLAT_FEE_RECURRING}::jsonb,
                  1, 'months', 'MYR', '2026-01-01T00:00:00Z')
        `,
      ).rejects.toThrow();
    });

    test("a row whose component_type disagrees with its envelope @type is rejected (envelope_type_check)", async () => {
      const offeringId = await insertOffering("Envelope Mismatch Offering");
      // component_type says flat_fee but the envelope is a usage_rate — the
      // `component_type = price_component ->> '@type'` CHECK refuses it (Inv. #30).
      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             unit_of_measure, currency, start_date_time)
          VALUES (${offeringId}, 'Mismatch', 'flat_fee', ${JSON.stringify({
            "@type": "usage_rate",
            specVersion: 1,
            plaSpecId: null,
            priceType: "usage",
            appliesAt: "rating",
            basis: "quantity",
            boundTo: { unitOfMeasure: "EA" },
            params: { ratePerUnit: "1.00", rateCardLookUp: null },
          })}::jsonb, 'EA', 'MYR', '2026-02-01T00:00:00Z')
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

    test("invalid component_type and currency are each rejected", async () => {
      const offeringId = await insertOffering("Invalid Enum Offering");

      // component_type not in the four persistable values → component_type_check.
      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             unit_of_measure, currency, start_date_time)
          VALUES (${offeringId}, 'Bad Component Type', 'bogus', ${FLAT_FEE_RECURRING}::jsonb, NULL, 'MYR', '2026-03-01T00:00:00Z')
        `,
      ).rejects.toThrow();

      // currency that is not a 3-character code → currency_check.
      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component,
             recurring_charge_period_length, recurring_charge_period_type,
             currency, start_date_time)
          VALUES (${offeringId}, 'Bad Currency', 'flat_fee', ${FLAT_FEE_RECURRING}::jsonb, 1, 'months', 'US', '2026-03-03T00:00:00Z')
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
