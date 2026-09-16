import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { productOffering } from "@/db/schema/product";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/billrun-aggregate";

// bm35-spec §Implementation §4 / code-standards §9.31 — the `volume` profile's
// guardrail. It drives the SAME shared aggregation flow-double
// (tests/db/helpers/billrun-aggregate.ts) the bm28/bm29 suites use — the exact
// `billrun_runtime` SQL the real bill_run_processing flow's Aggregation stage
// runs — at HIGH usage-row cardinality, and proves the two things the `volume`
// profile exists to prove (bm35-spec §Design, code-standards §9.31):
//
//   1. LINE COUNT TRACKS PRODUCT FOOTPRINT, NOT RECORD COUNT. An account with
//      thousands of RAN_USAGE rows across many subscriptions of ONE offering
//      aggregates to exactly ONE USAGE line (footprint = offerings × udr_types);
//      three offerings → three lines — never one line per record.
//   2. AGGREGATION IS SET-BASED (a BOUNDED statement count, not one-per-record).
//      Instrumented via a postgres.js `debug` counter: the number of SQL
//      statements one aggregation issues is INVARIANT to the number of usage
//      rows (a ~1000× record difference issues the identical, small statement
//      count) — the signature of a set-based GROUP BY, not a per-record loop.
//
// Like the bm28 double it runs on the superuser DATABASE_URL connection, so it
// exercises the aggregation LOGIC, not the billrun_runtime grants (those are
// proven by billrun-db-roles.integration.test.ts). This suite is deliberately
// heavier than the per-commit guardrails — run it on the DB-gated schedule
// (code-standards §9.31: "Run deliberately, not on every commit").
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
// A unit price of 1.00 makes SUM(net) equal the row count exactly, so the
// footprint-vs-record-count assertion reads directly off the money.
const UNIT_PRICE = "1.00";

// A generous ceiling on the statements a single set-based aggregation may issue
// (BEGIN + the fixed handful of temp-table/DO/delete/INSERT/UPDATE statements +
// COMMIT). The real assertion is INVARIANCE across record counts; this bound is
// a second net that a per-record implementation (statements ∝ rows) would blow
// past immediately.
const MAX_AGGREGATION_STATEMENTS = 20;

describe.skipIf(!databaseUrl)(
  "bm35 volume profile — aggregation is set-based (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    // A second client whose only job is to run aggregations we count. Its
    // `debug` hook fires once per statement sent to the server; fixtures and
    // reads go through `sql`, so the counter reflects ONLY the aggregation.
    let countingClient: postgresjs.Sql;
    let debugCount = 0;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;
    let seq = 0;

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    async function newAccount(label: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM35V-${label}-Customer`,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: `BM35V-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM35V-${label}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "MYR",
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newRun(runId: string): Promise<void> {
      const [runCycle] = await db
        .insert(billCycle)
        .values({ name: `BM35V Run Cycle ${runId}`, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      await db.insert(billRun).values({
        billRunId: runId,
        refBillCycleId: runCycle!.billCycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        scheduledRunDate: "2026-07-01",
        status: "PROCESSING",
        runType: "onCycle",
      });
    }

    async function newOffering(name: string): Promise<string> {
      const [off] = await db
        .insert(productOffering)
        .values({
          name,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      return off!.productOfferingId;
    }

    // A product_inventory row linking (product_inventory_id) → (account,
    // offering). Only billing_account_id + product_offering_id matter to
    // Aggregation; FK triggers are disabled and the ordering/party ids
    // fabricated (the bm27/bm28 fixture technique).
    async function newInventory(
      piId: string,
      ban: string,
      offeringId: string,
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO inventory.product_inventory
            (product_inventory_id, product_order_item_id, customer_party_role_id,
             billing_account_id, product_offering_id, quantity, status, start_date)
          VALUES
            (${piId}, ${`_bm35v-poi-${piId}`}, ${`_bm35v-party-${piId}`},
             ${ban}, ${offeringId}, 1, 'ACTIVE', '2026-01-01')
        `;
      });
    }

    // Bulk-insert N CLAIMED RAN_USAGE rows (status BILL_DRAFT, the six claim
    // columns stamped — the shape Collection leaves before Aggregation). One
    // set-based INSERT ... SELECT fans out over `generate_series(1, count)` (a
    // single statement per call, scalar params only — no builder), so seeding
    // thousands of rows stays fast without hitting the bind-parameter wall. A
    // per-call `keyBase` (a global sequence) times the series index keeps every
    // `udr_key` distinct so the live-row UNIQUE never collides even though every
    // row shares one `start_datetime`.
    async function insertClaimedRows(args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
      count: number;
    }): Promise<void> {
      seq += 1;
      const keyBase = `_bm35v-key-${seq}`;
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw,
           udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
           rating_engine_version, rating_flow_revision,
           billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
           upsert_datetime)
        SELECT rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
               ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
               ${args.subRef}, ${keyBase} || '-' || g::text, '1.000000', 'EA', 'FLAT',
               ${UNIT_PRICE}, ${UNIT_PRICE}, 'HALF_UP', 'MYR', '_BM35V_BATCH',
               '_BM35V', '_BM35V', 0,
               ${args.runId}, ${args.ban}, ${args.attempt}, 'bm35v-claim', now()
        FROM   generate_series(1, ${args.count}) AS g
      `;
    }

    // Run the shared aggregation flow-double through the COUNTING client and
    // return how many statements it issued.
    async function aggregateCounted(
      runId: string,
      ban: string,
      attempt: number,
    ): Promise<number> {
      debugCount = 0;
      await runAggregation(countingClient, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
      return debugCount;
    }

    async function readBill(runId: string, ban: string) {
      const [bill] = await db
        .select({
          customerBillId: customerBill.customerBillId,
          subtotal: customerBill.subtotal,
        })
        .from(customerBill)
        .where(
          and(
            eq(customerBill.refBillRunId, runId),
            eq(customerBill.refBillingAccountId, ban),
          ),
        );
      return bill;
    }

    async function readLines(customerBillId: string) {
      return db
        .select({
          lineNo: customerBillLine.lineNo,
          source: customerBillLine.source,
          offeringId: customerBillLine.refProductOfferingId,
          udrType: customerBillLine.udrType,
          netAmount: customerBillLine.netAmount,
          udrCount: customerBillLine.udrCount,
          groupingKey: customerBillLine.groupingKey,
        })
        .from(customerBillLine)
        .where(eq(customerBillLine.refCustomerBillId, customerBillId))
        .orderBy(asc(customerBillLine.lineNo));
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      countingClient = postgres(databaseUrl as string, {
        max: 1,
        // Fires once per statement sent to the server (BEGIN/COMMIT included);
        // the exact composition doesn't matter — its INVARIANCE to record count
        // is what proves the aggregation is set-based.
        debug: () => {
          debugCount += 1;
        },
      });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // `billrun_delete_trial_bill` (the whole-account replace's deletion path)
      // is created by db/bootstrap/billrun-db-roles.sql, not a migration —
      // create it here verbatim for the flow-double (bm28 precedent).
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
          userName: "BM35V-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM35V Fixture Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (countingClient) await countingClient.end();
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "an account with 1000 RAN_USAGE rows across 5 subscriptions of ONE " +
        "offering aggregates to exactly ONE USAGE line — footprint, not record " +
        "count (bm35-spec §4, §9.31)",
      async () => {
        const ban = await newAccount("Footprint");
        const offering = await newOffering("Volume Offering");
        const runId = "BRN-BM35V-01";
        const attempt = 1;
        await newRun(runId);

        const SUBS = 5;
        const ROWS_PER_SUB = 200; // 5 × 200 = 1000 usage rows
        for (let i = 0; i < SUBS; i += 1) {
          const pi = `PRDINV-BM35V-A${i}`;
          await newInventory(pi, ban, offering);
          await insertClaimedRows({
            subRef: pi,
            runId,
            ban,
            attempt,
            count: ROWS_PER_SUB,
          });
        }

        const statements = await aggregateCounted(runId, ban, attempt);

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);

        // Footprint = 1 offering × 1 udr_type = ONE line (never 1000).
        expect(lines).toHaveLength(1);
        const [line] = lines;
        expect(line!.source).toBe("USAGE");
        expect(line!.udrType).toBe("RAN_USAGE");
        expect(line!.groupingKey).toBe(`${offering}:RAN_USAGE`);
        // The single line rolled up ALL 1000 records.
        expect(line!.udrCount).toBe(SUBS * ROWS_PER_SUB);
        expect(line!.netAmount).toBe("1000.00");
        expect(bill!.subtotal).toBe("1000.00");

        // Set-based: one aggregation over 1000 rows still issues only a small,
        // bounded number of statements — nowhere near one-per-record.
        expect(statements).toBeGreaterThan(0);
        expect(statements).toBeLessThanOrEqual(MAX_AGGREGATION_STATEMENTS);
      },
      180_000,
    );

    it(
      "line count tracks the (offering × udr_type) footprint: 3 offerings, " +
        "hundreds of rows each → exactly 3 lines (bm35-spec §4, §9.31)",
      async () => {
        const ban = await newAccount("ThreeOfferings");
        const runId = "BRN-BM35V-02";
        const attempt = 1;
        await newRun(runId);

        const offerings: string[] = [];
        for (let o = 0; o < 3; o += 1) {
          const offering = await newOffering(`Volume Offering ${o}`);
          offerings.push(offering);
          const pi = `PRDINV-BM35V-O${o}`;
          await newInventory(pi, ban, offering);
          await insertClaimedRows({
            subRef: pi,
            runId,
            ban,
            attempt,
            count: 300,
          });
        }

        await aggregateCounted(runId, ban, attempt);
        const bill = await readBill(runId, ban);
        const lines = await readLines(bill!.customerBillId);

        // 3 offerings × 1 udr_type = exactly 3 lines (not 900).
        expect(lines).toHaveLength(3);
        for (const line of lines) {
          expect(line.udrCount).toBe(300);
          expect(line.netAmount).toBe("300.00");
        }
        expect(bill!.subtotal).toBe("900.00");
      },
      180_000,
    );

    it(
      "the aggregation statement count is INVARIANT to record count — the " +
        "set-based signature (bm35-spec §4, §9.31)",
      async () => {
        // A tiny account (2 rows) and a large one (1500 rows), same single-line
        // footprint. A per-record implementation would issue ~record-count
        // statements; a set-based one issues the identical, small count.
        const banSmall = await newAccount("StmtSmall");
        const offSmall = await newOffering("StmtSmall Offering");
        const runSmall = "BRN-BM35V-03S";
        await newRun(runSmall);
        const piSmall = "PRDINV-BM35V-S0";
        await newInventory(piSmall, banSmall, offSmall);
        await insertClaimedRows({
          subRef: piSmall,
          runId: runSmall,
          ban: banSmall,
          attempt: 1,
          count: 2,
        });

        const banLarge = await newAccount("StmtLarge");
        const offLarge = await newOffering("StmtLarge Offering");
        const runLarge = "BRN-BM35V-03L";
        await newRun(runLarge);
        const piLarge = "PRDINV-BM35V-L0";
        await newInventory(piLarge, banLarge, offLarge);
        await insertClaimedRows({
          subRef: piLarge,
          runId: runLarge,
          ban: banLarge,
          attempt: 1,
          count: 1500,
        });

        const countSmall = await aggregateCounted(runSmall, banSmall, 1);
        const countLarge = await aggregateCounted(runLarge, banLarge, 1);

        // Both bills are one line — the difference is only cardinality.
        const smallBill = await readBill(runSmall, banSmall);
        const largeBill = await readBill(runLarge, banLarge);
        expect(await readLines(smallBill!.customerBillId)).toHaveLength(1);
        expect(await readLines(largeBill!.customerBillId)).toHaveLength(1);

        // The core proof: a ~750× record difference issues the IDENTICAL,
        // bounded statement count.
        expect(countSmall).toBeGreaterThan(0);
        expect(countLarge).toBe(countSmall);
        expect(countLarge).toBeLessThanOrEqual(MAX_AGGREGATION_STATEMENTS);
      },
      180_000,
    );
  },
);
