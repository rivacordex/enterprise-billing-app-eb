import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { PersistablePricingComponent } from "@/validation/product/pricing-component.schema";

// pm71-spec I2 — the database arms of guardrails 43 (completeness at COMMIT,
// Inv. #63), 44 (type pinning, Inv. #62 / #70), 45 (DRAFT guard on the four
// price subtype tables, no orphans — price half), 2 (immutability of a
// released version) and 32 (envelope strictness "independently of Zod").
// Fixture headers go in THROUGH THE REPOSITORY; every refusal is then provoked
// with raw SQL (never through fromEnvelope) and asserted by SQLSTATE and
// constraint/trigger name, never by message text.
const databaseUrl = process.env.DATABASE_URL;

const SCHEMAS = [
  "billing",
  "customer",
  "product",
  "inventory",
  "ordering",
  "rating",
  "core",
  "drizzle",
];

const START = new Date("2026-01-01T00:00:00Z");

const USAGE: PersistablePricingComponent = {
  "@type": "usage_rate",
  specVersion: 1,
  plaSpecId: null,
  priceType: "usage",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: { ratePerUnit: "1", rateCardLookUp: null },
};
const FLAT: PersistablePricingComponent = {
  "@type": "flat_fee",
  specVersion: 1,
  plaSpecId: null,
  priceType: "oneTime",
  appliesAt: "billing",
  basis: "flat",
  boundTo: null,
  params: { amount: "10" },
};
const COMMITMENT: PersistablePricingComponent = {
  "@type": "capacity_commitment",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_COMMITMENT",
  priceType: "commitment",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: { committedQuantity: 100 },
};
const MOTIVATION_ONE_STEP: PersistablePricingComponent = {
  "@type": "capacity_motivation",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_MOTIVATION",
  priceType: "discount",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: { steps: [{ aboveQuantity: 1000, ratePerUnit: "5" }] },
};

type PgError = { code?: string; constraint_name?: string; message?: string };

async function refusal(work: Promise<unknown>): Promise<PgError> {
  try {
    await work;
  } catch (err) {
    return err as PgError;
  }
  throw new Error("expected the statement/transaction to be refused");
}

describe.skipIf(!databaseUrl)(
  "pm71 normalized price constraints — guardrails 43, 44, 45, 2, 32 (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        for (const s of SCHEMAS) {
          await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
        }
        await sql.end();
      }
    }, 120_000);

    async function createDraft(name: string): Promise<string> {
      const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status)
        VALUES (${name}, false, true, true, 'DRAFT')
        RETURNING product_offering_id`;
      return rows[0]!.product_offering_id;
    }

    async function activate(offeringId: string): Promise<void> {
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                 WHERE product_offering_id = ${offeringId}`;
    }

    // The fixture header, through the repository, on a transaction.
    async function insertPrice(
      offeringId: string,
      x: PersistablePricingComponent,
      start: Date = START,
    ): Promise<string> {
      const { productOfferingPriceId } = await db.transaction((tx) =>
        productOfferingPriceRepository.insertPrice(tx, {
          productOfferingId: offeringId,
          name: "fixture",
          componentType: x["@type"],
          component: x,
          currency: "USD",
          glCode: null,
          recurringChargePeriodLength: null,
          recurringChargePeriodType: null,
          unitOfMeasure: x.boundTo === null ? null : x.boundTo.unitOfMeasure,
          startDateTime: start,
        }),
      );
      return productOfferingPriceId;
    }

    // A raw header INSERT (unit GB unless a flat fee).
    function rawHeader(
      tx: postgresjs.TransactionSql,
      offeringId: string,
      componentType: string,
      priceType: string,
      start: Date = START,
    ) {
      const unit = componentType === "flat_fee" ? null : "GB";
      return tx<{ id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_type,
           unit_of_measure, currency, start_date_time)
        VALUES (${offeringId}, 'raw', ${componentType}, ${priceType},
                ${unit}, 'USD', ${start.toISOString()})
        RETURNING product_offering_price_id AS id`;
    }

    async function count(table: string, priceId: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql("product")}.${sql(table)}
         WHERE product_offering_price_id = ${priceId}`;
      return row!.n;
    }

    // -- Guardrail 43: completeness at COMMIT (Inv. #63) ----------------------

    describe("guardrail 43 — completeness is checked at COMMIT", () => {
      it("a raw header alone is refused at COMMIT with 23514", async () => {
        const offeringId = await createDraft("43 header alone");
        const err = await refusal(
          sql.begin((tx) => rawHeader(tx, offeringId, "usage_rate", "usage")),
        );
        expect(err.code).toBe("23514");
        expect(err.message).toContain("product_price_header_incomplete");
      });

      it("a raw capacity_motivation header with zero steps is refused with 23514", async () => {
        const offeringId = await createDraft("43 zero steps");
        const err = await refusal(
          sql.begin((tx) =>
            rawHeader(tx, offeringId, "capacity_motivation", "discount"),
          ),
        );
        expect(err.code).toBe("23514");
      });

      it("deleting a DRAFT motivation's only step succeeds as a statement and fails at COMMIT", async () => {
        const offeringId = await createDraft("43 last step");
        const id = await insertPrice(offeringId, MOTIVATION_ONE_STEP);
        let deleted = -1;
        const err = await refusal(
          sql.begin(async (tx) => {
            const rows = await tx`
              DELETE FROM product.pop_motivation_step
               WHERE product_offering_price_id = ${id} RETURNING 1`;
            deleted = rows.length;
          }),
        );
        expect(deleted).toBe(1);
        expect(err.code).toBe("23514");
        expect(await count("pop_motivation_step", id)).toBe(1);
      });

      it("header then child in one transaction commits", async () => {
        const offeringId = await createDraft("43 header + child");
        const id = await sql.begin(async (tx) => {
          const [h] = await rawHeader(tx, offeringId, "usage_rate", "usage");
          await tx`INSERT INTO product.pop_usage_rate
                     (product_offering_price_id, rate_per_unit)
                   VALUES (${h!.id}, 1)`;
          return h!.id;
        });
        expect(await count("pop_usage_rate", id)).toBe(1);
      });
    });

    // -- Guardrail 44: type pinning (Inv. #62, #70) ---------------------------

    describe("guardrail 44 — a subtype row is pinned to its header's type", () => {
      it("a pop_flat_fee row for a usage_rate header is refused with 23503", async () => {
        const offeringId = await createDraft("44 wrong child");
        const id = await insertPrice(offeringId, USAGE);
        const err = await refusal(
          sql`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
              VALUES (${id}, 1)`,
        );
        expect(err.code).toBe("23503");
        expect(err.constraint_name).toBe("pop_flat_fee_header_fk");
      });

      // pm70 deviation 2: (flat_fee, 'usage') is refused by the per-type CHECK
      // before the pair FK is evaluated; the pair FK itself is proven with
      // (usage_rate, 'recurring'), which every CHECK admits.
      it("an unseeded (component_type, price_type) pair is refused", async () => {
        const offeringId = await createDraft("44 pair");
        const viaFk = await refusal(
          sql.begin((tx) =>
            rawHeader(tx, offeringId, "usage_rate", "recurring"),
          ),
        );
        expect(viaFk.code).toBe("23503");
        expect(viaFk.constraint_name).toBe(
          "product_offering_price_price_type_fk",
        );
        const viaCheck = await refusal(
          sql.begin((tx) => rawHeader(tx, offeringId, "flat_fee", "usage")),
        );
        expect(viaCheck.code).toBe("23514");
        expect(viaCheck.constraint_name).toBe(
          "product_offering_price_flat_fee_check",
        );
      });

      it("a header's component_type cannot change while a child references it (23503)", async () => {
        const offeringId = await createDraft("44 retype");
        const id = await insertPrice(offeringId, USAGE);
        const err = await refusal(
          sql`UPDATE product.product_offering_price
                 SET component_type = 'flat_fee', price_type = 'oneTime',
                     unit_of_measure = NULL
               WHERE product_offering_price_id = ${id}`,
        );
        expect(err.code).toBe("23503");
        expect(err.constraint_name).toBe("pop_usage_rate_header_fk");
      });

      it("the D6 order — delete child, update header, insert child — commits", async () => {
        const offeringId = await createDraft("44 d6 order");
        const id = await insertPrice(offeringId, USAGE);
        await sql.begin(async (tx) => {
          await tx`DELETE FROM product.pop_usage_rate
                    WHERE product_offering_price_id = ${id}`;
          await tx`UPDATE product.product_offering_price
                      SET component_type = 'flat_fee', price_type = 'oneTime',
                          unit_of_measure = NULL
                    WHERE product_offering_price_id = ${id}`;
          await tx`INSERT INTO product.pop_flat_fee
                     (product_offering_price_id, amount) VALUES (${id}, 3)`;
        });
        expect(await count("pop_usage_rate", id)).toBe(0);
        expect(await count("pop_flat_fee", id)).toBe(1);
      });
    });

    // -- Guardrails 45 + 2: the DRAFT guard on released versions --------------

    describe("guardrails 45 and 2 — a released version's price rows are immutable", () => {
      let ids: Record<string, string>;
      let offeringId: string;

      beforeAll(async () => {
        offeringId = await createDraft("45 released");
        ids = {
          pop_usage_rate: await insertPrice(offeringId, USAGE),
          pop_flat_fee: await insertPrice(offeringId, FLAT),
          pop_capacity_commitment: await insertPrice(offeringId, COMMITMENT),
          pop_motivation_step: await insertPrice(
            offeringId,
            MOTIVATION_ONE_STEP,
          ),
        };
        await activate(offeringId);
      });

      const INSERTS: Record<string, (id: string) => string> = {
        pop_usage_rate: (id) =>
          `INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit) VALUES ('${id}', 2)`,
        pop_flat_fee: (id) =>
          `INSERT INTO product.pop_flat_fee (product_offering_price_id, amount) VALUES ('${id}', 2)`,
        pop_capacity_commitment: (id) =>
          `INSERT INTO product.pop_capacity_commitment (product_offering_price_id, committed_quantity) VALUES ('${id}', 2)`,
        pop_motivation_step: (id) =>
          `INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit) VALUES ('${id}', 2000, 1)`,
      };
      const UPDATES: Record<string, string> = {
        pop_usage_rate: "rate_per_unit = rate_per_unit + 1",
        pop_flat_fee: "amount = amount + 1",
        pop_capacity_commitment: "committed_quantity = committed_quantity + 1",
        pop_motivation_step: "rate_per_unit = rate_per_unit + 1",
      };

      for (const table of [
        "pop_usage_rate",
        "pop_flat_fee",
        "pop_capacity_commitment",
        "pop_motivation_step",
      ]) {
        it(`${table}: INSERT / UPDATE / DELETE are refused with 23514`, async () => {
          const id = ids[table]!;
          for (const statement of [
            INSERTS[table]!(id),
            `UPDATE product.${table} SET ${UPDATES[table]} WHERE product_offering_price_id = '${id}'`,
            `DELETE FROM product.${table} WHERE product_offering_price_id = '${id}'`,
          ]) {
            const err = await refusal(sql.unsafe(statement));
            expect(err.code, statement).toBe("23514");
            expect(err.message, statement).toContain(
              "product_child_write_requires_draft",
            );
          }
          expect(await count(table, id)).toBeGreaterThan(0);
        });
      }

      it("the released header itself is refused (guardrail 2, DB arm)", async () => {
        const id = ids.pop_usage_rate!;
        for (const statement of [
          `UPDATE product.product_offering_price SET name = 'x' WHERE product_offering_price_id = '${id}'`,
          `DELETE FROM product.product_offering_price WHERE product_offering_price_id = '${id}'`,
        ]) {
          const err = await refusal(sql.unsafe(statement));
          expect(err.code, statement).toBe("23514");
        }
        const err = await refusal(
          sql.begin((tx) => rawHeader(tx, offeringId, "flat_fee", "oneTime")),
        );
        expect(err.code).toBe("23514");
      });

      it("discarding a DRAFT version leaves no row in any of the four tables", async () => {
        const draftId = await createDraft("45 discard");
        const draftIds = [
          await insertPrice(draftId, USAGE),
          await insertPrice(draftId, FLAT),
          await insertPrice(draftId, COMMITMENT),
          await insertPrice(draftId, MOTIVATION_ONE_STEP),
        ];
        await sql`DELETE FROM product.product_offering
                   WHERE product_offering_id = ${draftId}`;
        for (const id of draftIds) {
          for (const table of [
            "product_offering_price",
            "pop_usage_rate",
            "pop_flat_fee",
            "pop_capacity_commitment",
            "pop_motivation_step",
          ]) {
            expect(await count(table, id), `${table} ${id}`).toBe(0);
          }
        }
      });
    });

    // -- Guardrail 32: strictness independently of Zod ------------------------

    describe("guardrail 32 — the database refuses bad subtype rows on its own", () => {
      it("a duplicate above_quantity is refused by the step PK (23505)", async () => {
        const offeringId = await createDraft("32 dup step");
        const id = await insertPrice(offeringId, MOTIVATION_ONE_STEP);
        const err = await refusal(
          sql`INSERT INTO product.pop_motivation_step
                (product_offering_price_id, above_quantity, rate_per_unit)
              VALUES (${id}, 1000, 9)`,
        );
        expect(err.code).toBe("23505");
        expect(err.constraint_name).toBe("pop_motivation_step_pk");
      });

      it("a negative rate_per_unit is refused by the column CHECK (23514)", async () => {
        const offeringId = await createDraft("32 negative");
        const id = await insertPrice(offeringId, USAGE);
        const err = await refusal(
          sql`UPDATE product.pop_usage_rate SET rate_per_unit = -1
               WHERE product_offering_price_id = ${id}`,
        );
        expect(err.code).toBe("23514");
        expect(err.constraint_name).toBe("pop_usage_rate_rate_check");
      });
    });
  },
);
