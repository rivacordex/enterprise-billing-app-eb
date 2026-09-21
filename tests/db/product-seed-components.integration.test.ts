import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { seedProductDemo } from "@/db/seeds/demo/product-demo";
import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";

// pm48-spec I4.1/I4.2 — live-DB proof that `seedProductDemo` (the only seed
// set this file exercises live; `seed-billrun-sample.ts`'s D5 flat_fee re-key
// and product.ts's D2 confirmed-no-op are covered by inspection, not here —
// see the pm48 commit notes) emits parsed envelopes on a freshly migrated
// database: every row is a persistable `component_type`, `component_type`
// agrees with the envelope's own `@type` (Inv. #30), `specVersion` is present
// (Inv. #44), the D4 capacity-plan offering carries its exact four
// components, and no row is a `flat_fee` with a unit or a `usage_rate`
// without one. `seedProductDemo` is called directly against a transaction —
// it is exported for exactly this purpose and takes no dependency on the
// other demo seed (`ordering-demo.ts`, which needs customer/accounts seeded
// first and is out of this module's boundary).
const databaseUrl = process.env.DATABASE_URL;

const PERSISTABLE_COMPONENT_TYPES = [
  "usage_rate",
  "flat_fee",
  "capacity_commitment",
  "capacity_motivation",
];

describe.skipIf(!databaseUrl)(
  "product-demo seed emits pricing-component envelopes (requires DATABASE_URL)",
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
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      await db.transaction(async (tx) => {
        await seedProductDemo(tx);
      });
    }, 30_000);

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

    it("every product_offering_price row has a non-null, persistable component_type", async () => {
      const rows = await sql<{ component_type: string | null }[]>`
        SELECT component_type FROM product.product_offering_price
      `;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.component_type).not.toBeNull();
        expect(PERSISTABLE_COMPONENT_TYPES).toContain(row.component_type);
      }
    });

    it("component_type equals price_component ->> '@type' on every row (Inv. #30)", async () => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE component_type IS DISTINCT FROM (price_component ->> '@type')
      `;
      expect(rows[0]?.count).toBe("0");
    });

    it("specVersion is present on every stored envelope (Inv. #44)", async () => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE (price_component -> 'specVersion') IS NULL
      `;
      expect(rows[0]?.count).toBe("0");
    });

    it("no row is a flat_fee with a unit_of_measure, or a usage_rate without one", async () => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE (component_type = 'flat_fee' AND unit_of_measure IS NOT NULL)
           OR (component_type = 'usage_rate' AND unit_of_measure IS NULL)
      `;
      expect(rows[0]?.count).toBe("0");
    });

    it("no negotiated_override row was written (not a member of ComponentType, Inv. #39)", async () => {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE component_type = 'negotiated_override'
      `;
      expect(rows[0]?.count).toBe("0");
    });

    it("the 'Demo — Enterprise Capacity Plan' offering has exactly its four D4 components", async () => {
      const rows = await sql<
        {
          component_type: string;
          price_component: Record<string, unknown>;
          unit_of_measure: string | null;
          recurring_charge_period_length: number | null;
          recurring_charge_period_type: string | null;
        }[]
      >`
        SELECT popp.component_type, popp.price_component, popp.unit_of_measure,
               popp.recurring_charge_period_length, popp.recurring_charge_period_type
        FROM product.product_offering_price popp
        JOIN product.product_offering po ON po.product_offering_id = popp.product_offering_id
        WHERE po.name = 'Demo — Enterprise Capacity Plan'
        ORDER BY popp.component_type
      `;
      expect(rows).toHaveLength(4);
      const byType = new Map(rows.map((r) => [r.component_type, r]));

      const usageRate = byType.get("usage_rate");
      expect(usageRate?.unit_of_measure).toBe("EA");
      expect(usageRate?.recurring_charge_period_length).toBeNull();
      expect(usageRate?.price_component.params).toMatchObject({
        ratePerUnit: "100",
        rateCardLookUp: "ENTERPRISE_EA_CARD",
      });
      expect(usageRate?.price_component.plaSpecId).toBe("PLA_USAGE_RATE");

      const commitment = byType.get("capacity_commitment");
      expect(commitment?.unit_of_measure).toBe("EA");
      expect(commitment?.price_component.params).toMatchObject({
        committedQuantity: 1000,
      });

      const motivation = byType.get("capacity_motivation");
      expect(motivation?.unit_of_measure).toBe("EA");
      expect(motivation?.price_component.params).toMatchObject({
        steps: [
          { aboveQuantity: 1000, ratePerUnit: "50" },
          { aboveQuantity: 2000, ratePerUnit: "25" },
        ],
      });

      const flatFee = byType.get("flat_fee");
      expect(flatFee?.unit_of_measure).toBeNull();
      expect(flatFee?.recurring_charge_period_length).toBe(1);
      expect(flatFee?.recurring_charge_period_type).toBe("months");
      expect(flatFee?.price_component.params).toMatchObject({
        amount: "2000.00",
      });
      expect(flatFee?.price_component.priceType).toBe("recurring");
    });

    it("the dated 2027 successor still seeds, in its own (component_type, unit) lane", async () => {
      const rows = await sql<
        { component_type: string; unit_of_measure: string | null }[]
      >`
        SELECT component_type, unit_of_measure FROM product.product_offering_price
        WHERE name = 'Demo — Monthly Recurring Charge (2027)'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.component_type).toBe("flat_fee");
      expect(rows[0]?.unit_of_measure).toBeNull();
    });

    it("every seeded row round-trips through persistablePricingComponentSchema (defense in depth)", async () => {
      const rows = await sql<{ price_component: unknown }[]>`
        SELECT price_component FROM product.product_offering_price
      `;
      for (const row of rows) {
        expect(() =>
          persistablePricingComponentSchema.parse(row.price_component),
        ).not.toThrow();
      }
    });

    // pm48-spec D1/I4.2 — the database half of the double-failure guarantee.
    // The Zod half (persistablePricingComponentSchema itself rejects a
    // descending-steps object) is asserted DB-free below, outside this
    // describe block.
    it("a deliberately malformed capacity_motivation (descending steps), inserted via raw SQL bypassing Zod, is rejected by the CHECK", async () => {
      const [offering] = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering (name, is_bundle, is_sellable, billing_only)
        VALUES ('pm48 D1 malformed steps', false, true, true)
        RETURNING product_offering_id`;
      const offeringId = offering?.product_offering_id;
      if (!offeringId) throw new Error("offering insert returned no row");

      const malformedEnvelope = {
        "@type": "capacity_motivation",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_MOTIVATION",
        priceType: "discount",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: "EA" },
        params: {
          steps: [
            { aboveQuantity: 2000, ratePerUnit: "50" },
            { aboveQuantity: 1000, ratePerUnit: "25" },
          ],
        },
      };

      await expect(
        sql`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_component, unit_of_measure, currency, start_date_time)
          VALUES (
            ${offeringId}, 'malformed capacity_motivation', 'capacity_motivation',
            ${JSON.stringify(malformedEnvelope)}::jsonb, 'EA', 'MYR', '2026-01-01T00:00:00Z'
          )`,
      ).rejects.toThrow("product_offering_price_capacity_motivation_check");
    });
  },
);

// pm48-spec D1/I4.2 — the Zod half of the double-failure guarantee. DB-free:
// runs unconditionally, unlike the describe block above which needs
// DATABASE_URL.
describe("pm48 D1 — a malformed seed fails at Zod before it ever reaches the database", () => {
  it("rejects a descending-steps capacity_motivation envelope", () => {
    const malformedEnvelope = {
      "@type": "capacity_motivation",
      specVersion: 1,
      plaSpecId: "PLA_CAPACITY_MOTIVATION",
      priceType: "discount",
      appliesAt: "post_aggregation",
      basis: "quantity",
      boundTo: { unitOfMeasure: "EA" },
      params: {
        steps: [
          { aboveQuantity: 2000, ratePerUnit: "50" },
          { aboveQuantity: 1000, ratePerUnit: "25" },
        ],
      },
    };
    expect(() =>
      persistablePricingComponentSchema.parse(malformedEnvelope),
    ).toThrow();
  });
});
