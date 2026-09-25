import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm46-spec I4 — live-DB proof that the reshaped price table's six
// per-component-type completeness CHECKs, the `pricing_steps_ok` helper, the
// `NULLS NOT DISTINCT` uniqueness rekey, `negotiated_override`'s exclusion
// (D5), the envelope/component_type agreement (Inv. #30), and pm36's
// unmodified DRAFT-guard trigger (D7) are enforced by the DATABASE, not the
// application. Every rejection is provoked by raw SQL (never the
// repository), and each one names the specific constraint it tripped — the
// pm35 precedent (product-price-constraints.integration.test.ts), reused
// here for the reshaped table. That older file is now superseded by this one
// for the price table's own shape (it still inserts the pre-pm46 columns and
// is red by design under gate G-E — see the progress tracker).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product price component envelope constraints (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
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

    // Raw-SQL component insert — every field the six CHECKs read is an
    // explicit parameter, so a single test controls exactly which
    // constraint it means to trip (pm35 precedent).
    function insertComponent(fields: {
      offeringId: string;
      name?: string;
      componentType: string;
      priceComponent: unknown;
      unitOfMeasure?: string | null;
      periodLength?: number | null;
      periodType?: string | null;
      startDateTime?: string;
    }): Promise<unknown> {
      return sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component,
           recurring_charge_period_length, recurring_charge_period_type,
           unit_of_measure, currency, start_date_time)
        VALUES (
          ${fields.offeringId}, ${fields.name ?? "price"}, ${fields.componentType},
          ${JSON.stringify(fields.priceComponent)}::jsonb,
          ${fields.periodLength ?? null}, ${fields.periodType ?? null},
          ${fields.unitOfMeasure ?? null}, ${"MYR"},
          ${fields.startDateTime ?? "2026-01-01T00:00:00Z"}
        )`;
    }

    const usageRateEnvelope = (overrides: Record<string, unknown> = {}) => ({
      "@type": "usage_rate",
      specVersion: 1,
      plaSpecId: null,
      priceType: "usage",
      appliesAt: "rating",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: { ratePerUnit: "100", rateCardLookUp: null },
      ...overrides,
    });

    const flatFeeEnvelope = (overrides: Record<string, unknown> = {}) => ({
      "@type": "flat_fee",
      specVersion: 1,
      plaSpecId: null,
      priceType: "oneTime",
      appliesAt: "billing",
      basis: "flat",
      boundTo: null,
      params: { amount: "250" },
      ...overrides,
    });

    const capacityCommitmentEnvelope = (
      overrides: Record<string, unknown> = {},
    ) => ({
      "@type": "capacity_commitment",
      specVersion: 1,
      plaSpecId: "PLA_CAPACITY_COMMITMENT",
      priceType: "commitment",
      appliesAt: "post_aggregation",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: { committedQuantity: 1000 },
      ...overrides,
    });

    const capacityMotivationEnvelope = (
      overrides: Record<string, unknown> = {},
    ) => ({
      "@type": "capacity_motivation",
      specVersion: 1,
      plaSpecId: "PLA_CAPACITY_MOTIVATION",
      priceType: "discount",
      appliesAt: "post_aggregation",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: {
        steps: [
          { aboveQuantity: 1000, ratePerUnit: "50" },
          { aboveQuantity: 2000, ratePerUnit: "25" },
        ],
      },
      ...overrides,
    });

    it("inserts a valid usage_rate (unit EA, ratePerUnit '100', rateCardLookUp null)", async () => {
      const offeringId = await createOffering("pm46 valid usage_rate");
      await insertComponent({
        offeringId,
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope(),
        unitOfMeasure: "EA",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("inserts a valid flat_fee recurring (amount '5000', unit NULL, period 1/months)", async () => {
      const offeringId = await createOffering("pm46 valid flat_fee recurring");
      await insertComponent({
        offeringId,
        componentType: "flat_fee",
        priceComponent: flatFeeEnvelope({
          priceType: "recurring",
          params: { amount: "5000" },
        }),
        periodLength: 1,
        periodType: "months",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("inserts a valid flat_fee oneTime (amount '250', unit NULL, no period)", async () => {
      const offeringId = await createOffering("pm46 valid flat_fee oneTime");
      await insertComponent({
        offeringId,
        componentType: "flat_fee",
        priceComponent: flatFeeEnvelope(),
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("inserts a valid capacity_commitment (committedQuantity 1000, unit EA)", async () => {
      const offeringId = await createOffering("pm46 valid capacity_commitment");
      await insertComponent({
        offeringId,
        componentType: "capacity_commitment",
        priceComponent: capacityCommitmentEnvelope(),
        unitOfMeasure: "EA",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("inserts a valid capacity_motivation (two ascending steps, unit EA)", async () => {
      const offeringId = await createOffering("pm46 valid capacity_motivation");
      await insertComponent({
        offeringId,
        componentType: "capacity_motivation",
        priceComponent: capacityMotivationEnvelope(),
        unitOfMeasure: "EA",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("1");
    });

    it("rejects component_type = 'negotiated_override' (D5, Inv. #39)", async () => {
      const offeringId = await createOffering("pm46 negotiated_override");
      await expect(
        insertComponent({
          offeringId,
          componentType: "negotiated_override",
          priceComponent: {
            "@type": "negotiated_override",
            specVersion: 1,
            plaSpecId: null,
            priceType: "discount",
            appliesAt: "rating",
            basis: "quantity",
            boundTo: { priceType: "usage", unitOfMeasure: "EA" },
            params: { ratePerUnit: "85" },
          },
        }),
      ).rejects.toThrow("product_offering_price_component_type_check");
    });

    it("rejects component_type='usage_rate' with envelope @type 'flat_fee' (Inv. #30)", async () => {
      const offeringId = await createOffering("pm46 envelope mismatch");
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: flatFeeEnvelope(),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_envelope_type_check");
    });

    it("rejects a recurring flat_fee whose recurring_charge_period_length is 6 (not 1/3/12)", async () => {
      const offeringId = await createOffering("pm46 flat_fee period 6");
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope({
            priceType: "recurring",
            params: { amount: "5000" },
          }),
          periodLength: 6,
          periodType: "months",
        }),
      ).rejects.toThrow("product_offering_price_period_value_check");
    });

    it("rejects a usage_rate whose unit_of_measure is 'XX' (not Mbps/GB/MB/EA)", async () => {
      const offeringId = await createOffering("pm46 usage_rate bad unit");
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope({
            boundTo: { unitOfMeasure: "XX" },
          }),
          unitOfMeasure: "XX",
        }),
      ).rejects.toThrow("product_offering_price_unit_value_check");
    });

    it("rejects usage_rate with NULL unit_of_measure", async () => {
      const offeringId = await createOffering("pm46 usage_rate null unit");
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope(),
        }),
      ).rejects.toThrow("product_offering_price_usage_rate_check");
    });

    it("rejects usage_rate carrying a charge period", async () => {
      const offeringId = await createOffering("pm46 usage_rate with period");
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope(),
          unitOfMeasure: "EA",
          periodLength: 1,
          periodType: "months",
        }),
      ).rejects.toThrow("product_offering_price_usage_rate_check");
    });

    it("rejects usage_rate with ratePerUnit as a number, not a string", async () => {
      const offeringId = await createOffering("pm46 usage_rate numeric rate");
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope({
            params: { ratePerUnit: 100, rateCardLookUp: null },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_usage_rate_check");
    });

    it("rejects flat_fee with no params.amount", async () => {
      const offeringId = await createOffering("pm46 flat_fee no amount");
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope({ params: {} }),
        }),
      ).rejects.toThrow("product_offering_price_flat_fee_check");
    });

    it("rejects flat_fee carrying a unit_of_measure", async () => {
      const offeringId = await createOffering("pm46 flat_fee with unit");
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope(),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_flat_fee_check");
    });

    it("rejects flat_fee recurring with no period pair", async () => {
      const offeringId = await createOffering(
        "pm46 flat_fee recurring no period",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope({ priceType: "recurring" }),
        }),
      ).rejects.toThrow("product_offering_price_flat_fee_check");
    });

    it("rejects flat_fee with no priceType", async () => {
      const offeringId = await createOffering("pm46 flat_fee no priceType");
      const envelope = flatFeeEnvelope() as Record<string, unknown>;
      delete envelope.priceType;
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: envelope,
        }),
      ).rejects.toThrow("product_offering_price_flat_fee_check");
    });

    it("rejects flat_fee oneTime carrying a period pair", async () => {
      const offeringId = await createOffering(
        "pm46 flat_fee onetime with period",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope(),
          periodLength: 1,
          periodType: "months",
        }),
      ).rejects.toThrow("product_offering_price_flat_fee_check");
    });

    it.each([0, -5])(
      "rejects capacity_commitment with committedQuantity %d",
      async (committedQuantity) => {
        const offeringId = await createOffering(
          `pm46 capacity_commitment ${committedQuantity}`,
        );
        await expect(
          insertComponent({
            offeringId,
            componentType: "capacity_commitment",
            priceComponent: capacityCommitmentEnvelope({
              params: { committedQuantity },
            }),
            unitOfMeasure: "EA",
          }),
        ).rejects.toThrow("product_offering_price_capacity_commitment_check");
      },
    );

    it("rejects capacity_commitment with committedQuantity as a string", async () => {
      const offeringId = await createOffering(
        "pm46 capacity_commitment string qty",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_commitment",
          priceComponent: capacityCommitmentEnvelope({
            params: { committedQuantity: "1000" },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_commitment_check");
    });

    it("rejects capacity_motivation with an empty steps array (VI1)", async () => {
      const offeringId = await createOffering("pm46 capacity_motivation empty");
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: { steps: [] },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects capacity_motivation with descending steps", async () => {
      const offeringId = await createOffering(
        "pm46 capacity_motivation descending",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: {
              steps: [
                { aboveQuantity: 2000, ratePerUnit: "50" },
                { aboveQuantity: 1000, ratePerUnit: "25" },
              ],
            },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects capacity_motivation with duplicate thresholds", async () => {
      const offeringId = await createOffering(
        "pm46 capacity_motivation duplicate",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: {
              steps: [
                { aboveQuantity: 1000, ratePerUnit: "50" },
                { aboveQuantity: 1000, ratePerUnit: "25" },
              ],
            },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects capacity_motivation with aboveQuantity 0", async () => {
      const offeringId = await createOffering("pm46 capacity_motivation zero");
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: { steps: [{ aboveQuantity: 0, ratePerUnit: "50" }] },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects capacity_motivation with a step ratePerUnit as a number", async () => {
      const offeringId = await createOffering(
        "pm46 capacity_motivation numeric rate",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: { steps: [{ aboveQuantity: 1000, ratePerUnit: 50 }] },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects capacity_motivation with a step missing aboveQuantity", async () => {
      const offeringId = await createOffering(
        "pm46 capacity_motivation missing aboveQuantity",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "capacity_motivation",
          priceComponent: capacityMotivationEnvelope({
            params: { steps: [{ ratePerUnit: "50" }] },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });

    it("rejects a second NULL-unit flat_fee on one offering at the same start_date_time (G-F)", async () => {
      const offeringId = await createOffering("pm46 unique flat_fee");
      await insertComponent({
        offeringId,
        componentType: "flat_fee",
        priceComponent: flatFeeEnvelope(),
      });
      await expect(
        insertComponent({
          offeringId,
          componentType: "flat_fee",
          priceComponent: flatFeeEnvelope({ params: { amount: "999" } }),
        }),
      ).rejects.toThrow("product_offering_price_component_start_unique");
    });

    it("rejects a second usage_rate with the same unit at the same start_date_time", async () => {
      const offeringId = await createOffering("pm46 unique usage_rate");
      await insertComponent({
        offeringId,
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope(),
        unitOfMeasure: "EA",
      });
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope({
            params: { ratePerUnit: "200", rateCardLookUp: null },
          }),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_offering_price_component_start_unique");
    });

    it("accepts a usage_rate and a capacity_motivation on the same unit at the same start_date_time — different lanes", async () => {
      const offeringId = await createOffering("pm46 different lanes");
      await insertComponent({
        offeringId,
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope(),
        unitOfMeasure: "EA",
      });
      await insertComponent({
        offeringId,
        componentType: "capacity_motivation",
        priceComponent: capacityMotivationEnvelope(),
        unitOfMeasure: "EA",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("2");
    });

    it("accepts two usage_rate rows on the same unit at different start_date_time (dated successor)", async () => {
      const offeringId = await createOffering("pm46 dated successor");
      await insertComponent({
        offeringId,
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope(),
        unitOfMeasure: "EA",
        startDateTime: "2026-01-01T00:00:00Z",
      });
      await insertComponent({
        offeringId,
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope({
          params: { ratePerUnit: "200", rateCardLookUp: null },
        }),
        unitOfMeasure: "EA",
        startDateTime: "2026-02-01T00:00:00Z",
      });
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      expect(rows[0]?.count).toBe("2");
    });

    it("rejects a direct SQL component insert against a TESTING parent (pm36 trigger, D7)", async () => {
      const offeringId = await createOffering(
        "pm46 trigger testing",
        "TESTING",
      );
      await expect(
        insertComponent({
          offeringId,
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope(),
          unitOfMeasure: "EA",
        }),
      ).rejects.toThrow("product_child_write_requires_draft");
    });

    it("cascades a DRAFT parent delete to its components (pm36 trigger unmodified, D7)", async () => {
      const offeringId = await createOffering("pm46 trigger cascade", "DRAFT");
      await insertComponent({
        offeringId,
        componentType: "flat_fee",
        priceComponent: flatFeeEnvelope(),
      });

      await sql`DELETE FROM product.product_offering WHERE product_offering_id = ${offeringId}`;

      const remainingPrices = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      const remainingOffering = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id = ${offeringId}`;
      expect(remainingPrices[0]?.count).toBe("0");
      expect(remainingOffering[0]?.count).toBe("0");
    });
  },
);
