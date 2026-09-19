import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm35-spec I4 — live-DB proof that the four per-price-type completeness CHECK
// constraints, the enum's five members, and the child-table cascade are
// enforced by the DATABASE, not the application. Every rejection is provoked by
// raw SQL (never a repository), so a green run means the constraint holds even
// when a direct write goes around the service layer (code-standards §6.18). The
// pm16 precedent: drop-all-schemas → migrate from empty → assert against the
// real shape 0006_product.sql produces.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product price completeness + enum + cascade (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // "product" holds FKs into "core", so it must drop first (same reset the
      // sibling product/migration integration suites use).
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql, { schema }), {
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

    // A parent to hang prices on. lifecycle_status defaults to DRAFT; pm35 adds
    // no trigger (that is pm36), so child writes are governed only by the CHECK
    // constraints under test here.
    async function createOffering(
      name: string,
      status?: string,
    ): Promise<string> {
      const rows = status
        ? await sql<{ product_offering_id: string }[]>`
            INSERT INTO product.product_offering
              (name, is_bundle, is_sellable, billing_only, lifecycle_status)
            VALUES (${name}, false, true, true, ${status}::product.lifecycle_status)
            RETURNING product_offering_id`
        : await sql<{ product_offering_id: string }[]>`
            INSERT INTO product.product_offering
              (name, is_bundle, is_sellable, billing_only)
            VALUES (${name}, false, true, true)
            RETURNING product_offering_id`;
      const id = rows[0]?.product_offering_id;
      if (!id) throw new Error("offering insert returned no row");
      return id;
    }

    // A flat price with every completeness-relevant column set explicitly, so a
    // single test controls exactly which constraint it means to trip. Returns
    // the raw insert promise (unawaited) so the caller can assert on rejection.
    function insertPrice(fields: {
      offeringId: string;
      name: string;
      priceType: string;
      periodLength: number | null;
      periodType: string | null;
      unitOfMeasure: string | null;
      startDateTime?: string;
    }): Promise<unknown> {
      return sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type,
           recurring_charge_period_length, recurring_charge_period_type,
           unit_of_measure, amount, currency, pricing_model, start_date_time)
        VALUES (
          ${fields.offeringId}, ${fields.name}, ${fields.priceType},
          ${fields.periodLength}, ${fields.periodType},
          ${fields.unitOfMeasure}, ${"10.00"}, ${"MYR"}, ${"flat"},
          ${fields.startDateTime ?? "2026-01-01T00:00:00Z"}
        )`;
    }

    it("rejects a recurring price with both period columns NULL", async () => {
      const offeringId = await createOffering("pm35 rec-null");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "recurring",
          periodLength: null,
          periodType: null,
          unitOfMeasure: null,
        }),
      ).rejects.toThrow("product_offering_price_recurring_period_check");
    });

    it("rejects a recurring price with length 6, type months", async () => {
      const offeringId = await createOffering("pm35 rec-6");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "recurring",
          periodLength: 6,
          periodType: "months",
          unitOfMeasure: null,
        }),
      ).rejects.toThrow("product_offering_price_period_value_check");
    });

    it("rejects a recurring price with length 1, type years", async () => {
      const offeringId = await createOffering("pm35 rec-years");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "recurring",
          periodLength: 1,
          periodType: "years",
          unitOfMeasure: null,
        }),
      ).rejects.toThrow("product_offering_price_period_value_check");
    });

    it("rejects a usage price with unit_of_measure NULL", async () => {
      const offeringId = await createOffering("pm35 usage-null");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "usage",
          periodLength: null,
          periodType: null,
          unitOfMeasure: null,
        }),
      ).rejects.toThrow("product_offering_price_usage_unit_check");
    });

    it("rejects a usage price with unit 'MBPS' (wrong case)", async () => {
      const offeringId = await createOffering("pm35 usage-mbps");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "usage",
          periodLength: null,
          periodType: null,
          unitOfMeasure: "MBPS",
        }),
      ).rejects.toThrow("product_offering_price_unit_value_check");
    });

    it("rejects a usage price with unit 'gb' (wrong case)", async () => {
      const offeringId = await createOffering("pm35 usage-gb");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "usage",
          periodLength: null,
          periodType: null,
          unitOfMeasure: "gb",
        }),
      ).rejects.toThrow("product_offering_price_unit_value_check");
    });

    it("rejects a once price carrying a charge period", async () => {
      const offeringId = await createOffering("pm35 once-period");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "once",
          periodLength: 1,
          periodType: "months",
          unitOfMeasure: null,
        }),
      ).rejects.toThrow("product_offering_price_recurring_period_check");
    });

    it("rejects a once price carrying a unit", async () => {
      const offeringId = await createOffering("pm35 once-unit");
      await expect(
        insertPrice({
          offeringId,
          name: "bad",
          priceType: "once",
          periodLength: null,
          periodType: null,
          unitOfMeasure: "GB",
        }),
      ).rejects.toThrow("product_offering_price_usage_unit_check");
    });

    it("accepts a complete recurring, usage, and once price on one offering", async () => {
      const offeringId = await createOffering("pm35 all-valid");
      await insertPrice({
        offeringId,
        name: "recurring 1/months",
        priceType: "recurring",
        periodLength: 1,
        periodType: "months",
        unitOfMeasure: null,
      });
      await insertPrice({
        offeringId,
        name: "usage GB",
        priceType: "usage",
        periodLength: null,
        periodType: null,
        unitOfMeasure: "GB",
      });
      await insertPrice({
        offeringId,
        name: "once neither",
        priceType: "once",
        periodLength: null,
        periodType: null,
        unitOfMeasure: null,
      });

      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("3");
    });

    it("cascades a DRAFT offering delete to its specifications and prices, leaving siblings untouched", async () => {
      const target = await createOffering("pm35 cascade-target", "DRAFT");
      // Created DRAFT, priced below, then activated: pm36's DRAFT-guard trigger
      // (0040) refuses a child write once the parent leaves DRAFT, so the
      // sibling's price must be inserted while it is still DRAFT and the sibling
      // activated afterward (the insert-then-activate pattern, pm36-spec I6).
      const sibling = await createOffering("pm35 cascade-sibling", "DRAFT");

      // 2 specifications on the target.
      for (const specName of ["spec A", "spec B"]) {
        await sql`
          INSERT INTO product.product_specifications
            (ref_product_offering_id, name, is_mandatory, is_default, product_spec_characteristics)
          VALUES (${target}, ${specName}, false, false, ${"{}"}::jsonb)`;
      }
      // 2 prices on the target.
      await insertPrice({
        offeringId: target,
        name: "t-recurring",
        priceType: "recurring",
        periodLength: 1,
        periodType: "months",
        unitOfMeasure: null,
      });
      await insertPrice({
        offeringId: target,
        name: "t-once",
        priceType: "once",
        periodLength: null,
        periodType: null,
        unitOfMeasure: null,
      });
      // 1 price on the sibling, to prove it survives. Inserted while the
      // sibling is still DRAFT, then the sibling is activated (pm36 trigger).
      await insertPrice({
        offeringId: sibling,
        name: "s-recurring",
        priceType: "recurring",
        periodLength: 1,
        periodType: "months",
        unitOfMeasure: null,
      });
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE' WHERE product_offering_id = ${sibling}`;

      await sql`DELETE FROM product.product_offering WHERE product_offering_id = ${target}`;

      const targetSpecs = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_specifications
        WHERE ref_product_offering_id = ${target}`;
      const targetPrices = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${target}`;
      const targetOffering = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id = ${target}`;
      expect(targetSpecs[0]?.count).toBe("0");
      expect(targetPrices[0]?.count).toBe("0");
      expect(targetOffering[0]?.count).toBe("0");

      const siblingOffering = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id = ${sibling}`;
      const siblingPrices = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${sibling}`;
      expect(siblingOffering[0]?.count).toBe("1");
      expect(siblingPrices[0]?.count).toBe("1");
    });

    it("accepts all five enum members and rejects a sixth value", async () => {
      for (const status of [
        "DRAFT",
        "TESTING",
        "ACTIVE",
        "OBSOLETE",
        "RETIRED",
      ]) {
        await createOffering(`pm35 enum ${status}`, status);
      }

      await expect(
        createOffering("pm35 enum ARCHIVED", "ARCHIVED"),
      ).rejects.toThrow(/invalid input value for enum/i);
    });
  },
);
