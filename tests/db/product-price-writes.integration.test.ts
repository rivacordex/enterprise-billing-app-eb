import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { updatePrice as UpdatePrice } from "@/services/product/update-price";
import type { deletePrice as DeletePrice } from "@/services/product/delete-price";
import type { UnitOfMeasure } from "@/types/product";
import type { UpdatePriceInput } from "@/validation/product/update-price.schema";

// pm38-spec I7 / guardrail 2 (re-scoped). Live-DB proof of the DRAFT-only price
// mutation path: update and delete succeed on a DRAFT parent and are refused for
// every released status by the repository (`OFFERING_NOT_DRAFT`) AND by the
// §3.5 trigger on a direct SQL write; a colliding start date returns
// `DUPLICATE_START` rather than a raw error; every success writes exactly one
// audit row of the right type inside the same transaction. The services use
// their own `@/db/client` pool; the local `sql` handle drives setup and
// assertions and provokes the raw-SQL trigger cases.
const databaseUrl = process.env.DATABASE_URL;

const RELEASED_STATUSES = ["TESTING", "ACTIVE", "OBSOLETE", "RETIRED"] as const;

describe.skipIf(!databaseUrl)(
  "DRAFT-only price mutation (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let updatePrice: typeof UpdatePrice;
    let deletePrice: typeof DeletePrice;
    let actorId: string;

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

      const [updatePriceMod, deletePriceMod] = await Promise.all([
        import("@/services/product/update-price"),
        import("@/services/product/delete-price"),
      ]);
      updatePrice = updatePriceMod.updatePrice;
      deletePrice = deletePriceMod.deletePrice;

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Price Editor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = user!.id;
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

    async function createDraftOffering(name: string): Promise<string> {
      const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only)
        VALUES (${name}, false, true, true)
        RETURNING product_offering_id`;
      return rows[0]!.product_offering_id;
    }

    // A complete recurring price inserted directly while the parent is DRAFT,
    // so a test can then exercise the service/trigger against an existing row.
    async function insertRecurringPrice(
      offeringId: string,
      name: string,
      startDateTime: string,
    ): Promise<string> {
      const rows = await sql<{ product_offering_price_id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type,
           recurring_charge_period_length, recurring_charge_period_type,
           amount, currency, pricing_model, start_date_time)
        VALUES (${offeringId}, ${name}, ${"recurring"}, ${1}, ${"months"},
                ${"10.00"}, ${"USD"}, ${"flat"}, ${startDateTime})
        RETURNING product_offering_price_id`;
      return rows[0]!.product_offering_price_id;
    }

    async function insertUsagePrice(
      offeringId: string,
      name: string,
      startDateTime: string,
      unit: string,
    ): Promise<string> {
      const rows = await sql<{ product_offering_price_id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, unit_of_measure,
           amount, currency, pricing_model, start_date_time)
        VALUES (${offeringId}, ${name}, ${"usage"}, ${unit},
                ${"0.05"}, ${"USD"}, ${"flat"}, ${startDateTime})
        RETURNING product_offering_price_id`;
      return rows[0]!.product_offering_price_id;
    }

    function recurringInput(
      amount: string,
      startDateTime: Date,
    ): UpdatePriceInput {
      return {
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        name: "Monthly",
        currency: "USD",
        glCode: null,
        startDateTime,
        priceCharacteristics: {
          pricing_model: "flat",
          amount,
          pricing_characteristics: null,
        },
      };
    }

    function usageInput(
      amount: string,
      unit: UnitOfMeasure,
      startDateTime: Date,
    ): UpdatePriceInput {
      return {
        priceType: "usage",
        unitOfMeasure: unit,
        name: "Per unit",
        currency: "USD",
        glCode: null,
        startDateTime,
        priceCharacteristics: {
          pricing_model: "flat",
          amount,
          pricing_characteristics: null,
        },
      };
    }

    function onceInput(amount: string, startDateTime: Date): UpdatePriceInput {
      return {
        priceType: "once",
        name: "Setup fee",
        currency: "USD",
        glCode: null,
        startDateTime,
        priceCharacteristics: {
          pricing_model: "flat",
          amount,
          pricing_characteristics: null,
        },
      };
    }

    async function auditCount(
      priceId: string,
      eventType: string,
    ): Promise<number> {
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM core.audit_log
        WHERE target_id = ${priceId} AND event_type = ${eventType}`;
      return Number(rows[0]!.count);
    }

    // The audit event's before/after JSONB payloads (spec I4/I7: each mutation
    // records before and after values). postgres-js returns jsonb as parsed JS.
    async function auditPayload(
      priceId: string,
      eventType: string,
    ): Promise<{
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }> {
      const rows = await sql<
        {
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown> | null;
        }[]
      >`
        SELECT before_data, after_data FROM core.audit_log
        WHERE target_id = ${priceId} AND event_type = ${eventType}
        ORDER BY created_datetime DESC
        LIMIT 1`;
      return {
        before: rows[0]?.before_data ?? null,
        after: rows[0]?.after_data ?? null,
      };
    }

    it("updates a price on a DRAFT version and writes exactly one PRODUCT_PRICE_UPDATED audit row", async () => {
      const offeringId = await createDraftOffering("pm38 upd-draft");
      const priceId = await insertRecurringPrice(
        offeringId,
        "Original",
        "2026-01-01T00:00:00Z",
      );

      const result = await updatePrice(
        priceId,
        recurringInput("99.00", new Date()),
        actorId,
      );

      expect(result.ok).toBe(true);
      const rows = await sql<{ amount: string }[]>`
        SELECT amount FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.amount).toBe("99.00");
      expect(await auditCount(priceId, "PRODUCT_PRICE_UPDATED")).toBe(1);

      // The one audit row carries the true before AND after values, including
      // the recurring completeness columns that must survive the update.
      const payload = await auditPayload(priceId, "PRODUCT_PRICE_UPDATED");
      expect(payload.before).toMatchObject({
        amount: "10.00",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      });
      expect(payload.after).toMatchObject({
        amount: "99.00",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
      });
    });

    it("re-saving a DRAFT price without moving its (old) start date is not blocked by backdating (pm41 review #1)", async () => {
      const offeringId = await createDraftOffering("pm41 unchanged-start");
      const oldStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const priceId = await insertRecurringPrice(
        offeringId,
        "Old",
        oldStart.toISOString(),
      );

      // Amount-only edit re-submits the row's own >3-day-old start; the
      // tolerance must not fire because the start is unchanged.
      const result = await updatePrice(
        priceId,
        recurringInput("88.00", oldStart),
        actorId,
      );

      expect(result.ok).toBe(true);
      const rows = await sql<{ amount: string }[]>`
        SELECT amount FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.amount).toBe("88.00");
      expect(await auditCount(priceId, "PRODUCT_PRICE_UPDATED")).toBe(1);
    });

    it("rejects a DRAFT price update that MOVES the start >3 days into the past, rolling the change back (pm41 review #1)", async () => {
      const offeringId = await createDraftOffering("pm41 moved-start");
      const priceId = await insertRecurringPrice(
        offeringId,
        "Recent",
        new Date().toISOString(),
      );

      const movedBack = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      const result = await updatePrice(
        priceId,
        recurringInput("88.00", movedBack),
        actorId,
      );

      expect(result).toEqual({ ok: false, code: "BACKDATED_START_TOO_FAR" });
      // The in-transaction throw rolled the update back: amount unchanged, no
      // audit row written.
      const rows = await sql<{ amount: string }[]>`
        SELECT amount FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.amount).toBe("10.00");
      expect(await auditCount(priceId, "PRODUCT_PRICE_UPDATED")).toBe(0);
    });

    it("deletes a price on a DRAFT version and writes exactly one PRODUCT_PRICE_DELETED audit row", async () => {
      const offeringId = await createDraftOffering("pm38 del-draft");
      const priceId = await insertRecurringPrice(
        offeringId,
        "Doomed",
        "2026-01-01T00:00:00Z",
      );

      const result = await deletePrice(priceId, actorId);

      expect(result.ok).toBe(true);
      const rows = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.count).toBe("0");
      expect(await auditCount(priceId, "PRODUCT_PRICE_DELETED")).toBe(1);

      // The deleted row's snapshot is the only surviving record of it.
      const payload = await auditPayload(priceId, "PRODUCT_PRICE_DELETED");
      expect(payload.before).toMatchObject({
        amount: "10.00",
        priceType: "recurring",
      });
      expect(payload.after).toBeNull();
    });

    it("refuses update and delete with OFFERING_NOT_DRAFT for every released status", async () => {
      for (const status of RELEASED_STATUSES) {
        const offeringId = await createDraftOffering(
          `pm38 not-draft ${status}`,
        );
        const priceId = await insertRecurringPrice(
          offeringId,
          "Frozen",
          "2026-01-01T00:00:00Z",
        );
        await sql`UPDATE product.product_offering
                  SET lifecycle_status = ${status}::product.lifecycle_status
                  WHERE product_offering_id = ${offeringId}`;

        const updated = await updatePrice(
          priceId,
          recurringInput("55.00", new Date()),
          actorId,
        );
        const deleted = await deletePrice(priceId, actorId);

        expect(updated).toEqual({ ok: false, code: "OFFERING_NOT_DRAFT" });
        expect(deleted).toEqual({ ok: false, code: "OFFERING_NOT_DRAFT" });
        // The row is untouched and no audit row was written.
        const rows = await sql<{ amount: string }[]>`
          SELECT amount FROM product.product_offering_price
          WHERE product_offering_price_id = ${priceId}`;
        expect(rows[0]!.amount).toBe("10.00");
        expect(await auditCount(priceId, "PRODUCT_PRICE_UPDATED")).toBe(0);
        expect(await auditCount(priceId, "PRODUCT_PRICE_DELETED")).toBe(0);
      }
    });

    it("the §3.5 trigger rejects a raw-SQL update or delete against a non-DRAFT parent's price", async () => {
      const offeringId = await createDraftOffering("pm38 trigger");
      const priceId = await insertRecurringPrice(
        offeringId,
        "Guarded",
        "2026-01-01T00:00:00Z",
      );
      await sql`UPDATE product.product_offering
                SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${offeringId}`;

      // Assert the §3.5 DRAFT-guard trigger specifically refused (not just "some
      // error") — its RAISE names `product_child_write_requires_draft`.
      await expect(
        sql`UPDATE product.product_offering_price SET amount = ${"1.00"}
            WHERE product_offering_price_id = ${priceId}`,
      ).rejects.toThrow(/product_child_write_requires_draft/);
      await expect(
        sql`DELETE FROM product.product_offering_price
            WHERE product_offering_price_id = ${priceId}`,
      ).rejects.toThrow(/product_child_write_requires_draft/);
    });

    it("returns DUPLICATE_START when an update collides with a sibling's start date", async () => {
      const offeringId = await createDraftOffering("pm38 dup-start");
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
      const todayIso = today.toISOString();
      const tomorrowIso = tomorrow.toISOString();

      await insertRecurringPrice(offeringId, "First", todayIso);
      const second = await insertRecurringPrice(
        offeringId,
        "Second",
        tomorrowIso,
      );

      const result = await updatePrice(
        second,
        recurringInput("77.00", today),
        actorId,
      );

      expect(result).toEqual({ ok: false, code: "DUPLICATE_START" });
      // The colliding write rolled back — the sibling still holds its own start.
      const rows = await sql<{ amount: string }[]>`
        SELECT amount FROM product.product_offering_price
        WHERE product_offering_price_id = ${second}`;
      expect(rows[0]!.amount).toBe("10.00");
      expect(await auditCount(second, "PRODUCT_PRICE_UPDATED")).toBe(0);
    });

    it("updates a usage price on a DRAFT version, preserving the unit-of-measure completeness column", async () => {
      const offeringId = await createDraftOffering("pm38 usage-upd");
      const priceId = await insertUsagePrice(
        offeringId,
        "Per GB",
        "2026-01-01T00:00:00Z",
        "GB",
      );

      const result = await updatePrice(
        priceId,
        usageInput("0.09", "MB", new Date()),
        actorId,
      );

      expect(result.ok).toBe(true);
      const rows = await sql<
        {
          unit_of_measure: string | null;
          amount: string;
          recurring_charge_period_length: number | null;
        }[]
      >`
        SELECT unit_of_measure, amount, recurring_charge_period_length
        FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.unit_of_measure).toBe("MB");
      expect(rows[0]!.amount).toBe("0.09");
      expect(rows[0]!.recurring_charge_period_length).toBeNull();
      expect(await auditCount(priceId, "PRODUCT_PRICE_UPDATED")).toBe(1);
    });

    it("changes a recurring price to a once price, nulling the now-forbidden completeness columns", async () => {
      const offeringId = await createDraftOffering("pm38 type-swap");
      const priceId = await insertRecurringPrice(
        offeringId,
        "Was recurring",
        "2026-01-01T00:00:00Z",
      );

      const result = await updatePrice(
        priceId,
        onceInput("500.00", new Date()),
        actorId,
      );

      // If toPriceWriteData failed to null the period columns on the type swap,
      // the DB's product_offering_price_recurring_period_check would reject the
      // write — so a success here proves the forbidden columns were cleared.
      expect(result.ok).toBe(true);
      const rows = await sql<
        {
          price_type: string;
          recurring_charge_period_length: number | null;
          recurring_charge_period_type: string | null;
          unit_of_measure: string | null;
        }[]
      >`
        SELECT price_type, recurring_charge_period_length,
               recurring_charge_period_type, unit_of_measure
        FROM product.product_offering_price
        WHERE product_offering_price_id = ${priceId}`;
      expect(rows[0]!.price_type).toBe("once");
      expect(rows[0]!.recurring_charge_period_length).toBeNull();
      expect(rows[0]!.recurring_charge_period_type).toBeNull();
      expect(rows[0]!.unit_of_measure).toBeNull();
    });

    it("returns PRICE_NOT_FOUND for a price id that does not exist", async () => {
      const updated = await updatePrice(
        "PRDOFP99999999",
        recurringInput("1.00", new Date()),
        actorId,
      );
      const deleted = await deletePrice("PRDOFP99999999", actorId);
      expect(updated).toEqual({ ok: false, code: "PRICE_NOT_FOUND" });
      expect(deleted).toEqual({ ok: false, code: "PRICE_NOT_FOUND" });
    });
  },
);
