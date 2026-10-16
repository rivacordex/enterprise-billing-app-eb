import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billCycle } from "@/db/schema/billing/catalogs";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/extract-flow-sql";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";
import { createCapacityPricingFixtures } from "@/tests/db/helpers/billrun-capacity-pricing-fixtures";

// bm68-spec §5 — the DB-gated capacity calc-trace regression, rewritten from
// bm45's appendix suite (`billrun-capacity-appendix.integration.test.ts`)
// once the flow stopped writing `additional_info.appendix` (D31). Same
// flow-double pattern as bm42/bm43: it runs the `aggregation` SQL extracted
// from `local-dev/bill_run_processing.yml`, so the behaviour is provable
// without a live Kestra. It asserts:
//   * on a multi-polygon claim, no capacity line's `additional_info` has an
//     `appendix` key — the trace is `{ v, productInventoryId, pricing, calc,
//     summary }` exactly;
//   * `pricing`, `calc` and `summary` at the bm42 anchors (800/1000/2000/0 EA
//     on a 1000-EA commitment + >1000-EA@50 motivation) are unchanged, with
//     the same money columns;
//   * 10,001 claimed polygon rows no longer fail the account (the removed
//     appendix bound): only the invoice bound (`INVOICE_USAGE_OVER_LIMIT`,
//     D37) applies, at render, so aggregation processes the account.
//
// It runs on the superuser DATABASE_URL connection (like the bm42/bm43
// doubles), so it exercises the aggregation LOGIC, not the billrun_runtime
// grants — those are proven by billrun-db-roles.integration.test.ts (17h).
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

const TRACE_KEYS = ["calc", "pricing", "productInventoryId", "summary", "v"];

describe.skipIf(!databaseUrl)(
  "bm68 capacity calc trace without the appendix (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;

    function fixtures() {
      return createFlowDoubleFixtures({
        sql,
        db,
        getActorId: () => actorId,
        getCycleId: () => cycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        labelPrefix: "BM68",
      });
    }
    const dropAll = (client: postgresjs.Sql) => fixtures().dropAll(client);
    const newAccount = (label: string, currency?: string) =>
      fixtures().newAccount(label, currency);
    const newRun = (runId: string) => fixtures().newRun(runId);
    const newOffering = (name: string) => fixtures().newOffering(name);
    const newProductSpec = (
      offeringId: string,
      name: string,
      defaultValue: string,
    ) => fixtures().newProductSpec(offeringId, name, defaultValue);
    const newInventory = (args: {
      piId: string;
      ban: string;
      offeringId: string;
      quantity: number;
      orderItemId: string;
      status?: string;
    }) => fixtures().newInventory(args);
    const readBill = (runId: string, ban: string) =>
      fixtures().readBill(runId, ban);
    const readLines = (customerBillId: string) =>
      fixtures().readLines(customerBillId);

    // One eager instance: it closes over the `seq` counter that keeps every
    // insertCapacityVolumeRow() udr_key unique (see the fixtures file).
    const capacityFixtures = createCapacityPricingFixtures({
      getSql: () => sql,
      newOffering,
      newProductSpec,
      newAccount,
      newRun,
      newInventory,
      claimAt: IN_WINDOW,
      labelPrefix: "BM68",
    });
    const setupSingleAccountCapacity =
      capacityFixtures.setupSingleAccountCapacity;
    const insertCapacityVolumeRow = capacityFixtures.insertCapacityVolumeRow;

    // The bm42 anchor offering: base 100/EA, 1000-EA commitment, one
    // motivation band above 1000 EA at 50/EA.
    const ANCHOR_OFFERING = {
      baseRate: "100",
      committedQuantity: 1000,
      steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
      udrType: "RAN_USAGE",
    } as const;

    async function aggregate(runId: string, ban: string): Promise<void> {
      await runAggregation(sql, {
        runId,
        ban,
        attempt: 1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
    }

    async function readSingleLine(runId: string, ban: string) {
      const bill = await readBill(runId, ban);
      expect(bill).toBeDefined();
      const lines = await readLines(bill!.customerBillId);
      expect(lines).toHaveLength(1);
      return { bill: bill!, line: lines[0]! };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // `billrun_delete_trial_bill` is created by db/bootstrap/billrun-db-roles.sql
      // (not a migration), so create it here for the flow-double (verbatim,
      // the bm28/bm29 precedent).
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION "billing".billrun_delete_trial_bill(p_run text, p_ban text)
        RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = billing AS $$
          WITH d AS (
            DELETE FROM billing.customer_bill
             WHERE ref_bill_run_id = p_run
               AND ref_billing_account_id = p_ban
               AND ref_inv_document_id IS NULL
            RETURNING 1
          )
          SELECT count(*)::integer FROM d;
        $$;
      `);

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM68-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM68 Fixture Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "[CRITICAL] a multi-polygon capacity line carries no appendix key — the " +
        "trace is pricing / calc / summary only (D31)",
      async () => {
        const { ban, runId, piId, usageRatePriceId } =
          await setupSingleAccountCapacity(
            "MULTI",
            "BM68 Offering MULTI",
            ANCHOR_OFFERING,
          );

        // Four distinct polygons in the raw rating key form (rm24–rm29), one
        // row each; the total, 1000 EA, meets the commitment exactly.
        const polygons = [
          { polygonId: "POLY-A1", ea: 400 },
          { polygonId: "POLY-A2", ea: 300 },
          { polygonId: "POLY-B1", ea: 200 },
          { polygonId: "POLY-UNMAPPED", ea: 100 },
        ];
        for (const p of polygons) {
          await insertCapacityVolumeRow({
            subRef: piId,
            runId,
            ban,
            attempt: 1,
            quantityEa: p.ea,
            rate: "100.000000",
            priceRef: usageRatePriceId,
            udrKey: `commercial_unit=CU-BM68|mno_public_id=MNO-BM68|polygon_id=${p.polygonId}`,
          });
        }

        await aggregate(runId, ban);

        const { bill, line } = await readSingleLine(runId, ban);
        expect(line.udrCount).toBe(4);
        expect(line.ratedAmount).toBe("100000.00");
        expect(line.netAmount).toBe("100000.00");
        const info = line.additionalInfo as unknown as Record<string, unknown>;
        expect(info).not.toHaveProperty("appendix");
        expect(Object.keys(info).sort()).toEqual(TRACE_KEYS);

        // The same, straight off the stored jsonb (no driver reshaping).
        const [row] = await sql<{ has_appendix: boolean }[]>`
          SELECT bool_or(additional_info ? 'appendix') AS has_appendix
          FROM   billing.customer_bill_line
          WHERE  ref_customer_bill_id = ${bill.customerBillId}
        `;
        expect(row!.has_appendix).toBe(false);
      },
    );

    it(
      "[CRITICAL] pricing / calc / summary and the money columns are unchanged " +
        "at the bm42 anchors 800 / 1000 / 2000 / 0 EA",
      async () => {
        const anchors = [
          {
            label: "A800",
            ea: 800,
            udrCount: 1,
            rated: "80000.00",
            gross: "100000.00",
            discount: "0.00",
            net: "100000.00",
            commitment: {
              op: "commitment",
              target: "1000.000000",
              outcome: "SHORTFALL",
              shortfall: "200.000000",
              topUp: "20000.00",
            },
            band: { quantity: "0.000000", charge: "0.00", discount: "0.00" },
            summary: [
              "Rated usage: 1 record(s), 800.000000 EA = 80,000.00",
              "Commitment 1,000.000000 EA: shortfall 200.000000, top-up 20,000.00",
              "Motivation discount: 0.00",
              "Gross 100,000.00, discount 0.00, net 100,000.00",
            ],
          },
          {
            label: "A1000",
            ea: 1000,
            udrCount: 1,
            rated: "100000.00",
            gross: "100000.00",
            discount: "0.00",
            net: "100000.00",
            commitment: {
              op: "commitment",
              target: "1000.000000",
              outcome: "MET",
              topUp: "0.00",
            },
            band: { quantity: "0.000000", charge: "0.00", discount: "0.00" },
            summary: [
              "Rated usage: 1 record(s), 1,000.000000 EA = 100,000.00",
              "Commitment 1,000.000000 EA: met, top-up 0.00",
              "Motivation discount: 0.00",
              "Gross 100,000.00, discount 0.00, net 100,000.00",
            ],
          },
          {
            label: "A2000",
            ea: 2000,
            udrCount: 1,
            rated: "200000.00",
            gross: "200000.00",
            discount: "50000.00",
            net: "150000.00",
            commitment: {
              op: "commitment",
              target: "1000.000000",
              outcome: "MET",
              topUp: "0.00",
            },
            band: {
              quantity: "1000.000000",
              charge: "50000.00",
              discount: "50000.00",
            },
            summary: [
              "Rated usage: 1 record(s), 2,000.000000 EA = 200,000.00",
              "Commitment 1,000.000000 EA: met, top-up 0.00",
              "Motivation discount: 50,000.00",
              "Gross 200,000.00, discount 50,000.00, net 150,000.00",
            ],
          },
          {
            label: "A0",
            ea: 0,
            udrCount: 0,
            rated: "0.00",
            gross: "100000.00",
            discount: "0.00",
            net: "100000.00",
            commitment: {
              op: "commitment",
              target: "1000.000000",
              outcome: "SHORTFALL",
              shortfall: "1000.000000",
              topUp: "100000.00",
            },
            band: { quantity: "0.000000", charge: "0.00", discount: "0.00" },
            summary: [
              "Rated usage: 0 record(s), 0.000000 EA = 0.00",
              "Commitment 1,000.000000 EA: shortfall 1,000.000000, top-up 100,000.00",
              "Motivation discount: 0.00",
              "Gross 100,000.00, discount 0.00, net 100,000.00",
            ],
          },
        ];

        for (const a of anchors) {
          const { ban, usageRatePriceId, runId, piId } =
            await setupSingleAccountCapacity(
              a.label,
              `BM68 Anchor Offering ${a.label}`,
              ANCHOR_OFFERING,
            );
          if (a.ea > 0) {
            await insertCapacityVolumeRow({
              subRef: piId,
              runId,
              ban,
              attempt: 1,
              quantityEa: a.ea,
              rate: "100.000000",
              priceRef: usageRatePriceId,
            });
          }

          await aggregate(runId, ban);

          const { bill, line } = await readSingleLine(runId, ban);
          expect(line.quantity).toBe(`${a.ea}.000000`);
          expect(line.udrCount).toBe(a.udrCount);
          expect(line.ratedAmount).toBe(a.rated);
          expect(line.grossAmount).toBe(a.gross);
          expect(line.discountAmount).toBe(a.discount);
          expect(line.netAmount).toBe(a.net);
          expect(bill.subtotal).toBe(a.net);

          const info = line.additionalInfo!;
          expect(Object.keys(info).sort()).toEqual(TRACE_KEYS);
          expect(info.v).toBe(1);
          expect(info.productInventoryId).toBe(piId);
          expect(info.pricing).toEqual({
            usageRate: {
              priceId: usageRatePriceId,
              ratePerUnit: "100.000000",
            },
            commitment: {
              priceId: expect.any(String),
              committedQuantity: "1000.000000",
            },
            motivation: {
              priceId: expect.any(String),
              steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
            },
          });
          expect(info.calc).toEqual([
            {
              op: "rated_sum",
              udrCount: a.udrCount,
              quantity: `${a.ea}.000000`,
              amount: a.rated,
            },
            a.commitment,
            {
              op: "motivation",
              band: 1,
              from: "1000.000000",
              baseRate: "100.000000",
              stepRate: "50.000000",
              ...a.band,
            },
            {
              op: "total",
              gross: a.gross,
              discount: a.discount,
              net: a.net,
            },
          ]);
          expect(info.summary).toEqual(a.summary);
        }
      },
      180_000,
    );

    it(
      "[CRITICAL] 10,001 claimed polygon rows no longer fail the account — " +
        "only the invoice bound applies (D31, D37)",
      async () => {
        const { ban, runId, piId, usageRatePriceId } =
          await setupSingleAccountCapacity(
            "MANYPOLY",
            "BM68 Offering MANYPOLY",
            {
              baseRate: "100",
              committedQuantity: 1, // 10,001 EA of usage: no floor top-up
              udrType: "RAN_USAGE",
            },
          );

        // Bulk-insert 10,001 distinct-polygon BILL_DRAFT rows in one
        // INSERT...SELECT (far faster than 10,001 round-trips) — each row 1
        // EA at the base rate, a distinct udr_key per polygon.
        await sql`
          INSERT INTO rating.udr_rated
            (partition_period, udr_type, start_datetime, end_datetime, status,
             udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
             udr_rate_type, udr_usage_rate, udr_price_ref, udr_rated_price,
             udr_rated_price_raw, udr_rounding_mode, udr_currency, udr_ref_batch_id,
             udr_source_file, rating_engine_version, rating_flow_revision,
             billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
             upsert_datetime)
          SELECT
            rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
            ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
            ${piId},
            'commercial_unit=CU-BM68|mno_public_id=MNO-BM68|polygon_id=POLY-MANY-' || g.i,
            '1.000000', 'EA', 'PER_UNIT', '100.000000', ${usageRatePriceId},
            '100.00', '100.00', 'HALF_UP', 'MYR', '_BM68_BATCH', '_BM68', '_BM68', 0,
            ${runId}, ${ban}, 1, 'bm68-manypoly-claim', now()
          FROM generate_series(1, 10001) AS g(i)
        `;

        await aggregate(runId, ban);

        const { line } = await readSingleLine(runId, ban);
        expect(line.udrCount).toBe(10001);
        expect(line.quantity).toBe("10001.000000");
        expect(line.ratedAmount).toBe("1000100.00");
        expect(line.netAmount).toBe("1000100.00");
        expect(line.additionalInfo).not.toHaveProperty("appendix");
      },
      60_000,
    );
  },
);
