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
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/billrun-aggregate";

// bm28-spec §Implementation §6 / Verification checklist — the DB-gated
// aggregation regression. This is the app-repo "flow-double" (bm21 pattern): it
// performs the SAME `billrun_runtime` writes the real bill_run_processing flow's
// Aggregation stage performs (group claimed BILL_DRAFT usage into
// `customer_bill_line` at (product_offering_id, udr_type) grain rolled ACROSS
// subscriptions; whole-account replace via `billrun_delete_trial_bill` + INSERT;
// `customer_bill.subtotal = SUM(net_amount)`; deterministic `line_no` ordered on
// grouping_key), so the behaviour is provable without a live Kestra. It asserts:
//   * grain (§9.4): 3 subscriptions of one offering + N of another → exactly 2
//     lines, not 3+N, each with the rolled-up udr_count + grouping_key;
//   * SUM(net_amount) = subtotal (§9.5); net = gross (discount 0.00 this phase);
//   * deterministic line_no reproduced identically on a re-run, and the re-run
//     is a whole-account replace (a fresh customer_bill, still exactly 2 lines).
//
// It runs on the superuser DATABASE_URL connection (like the bm27 correlation
// double), so it exercises the aggregation LOGIC, not the billrun_runtime grants
// — those are proven by billrun-db-roles.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
const UNIT_PRICE = "10.00";

describe.skipIf(!databaseUrl)(
  "bm28 aggregation into customer_bill_line (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
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
          name: `BM28-${label}-Customer`,
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
          name: `BM28-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM28-${label}-BAN`,
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

    // A real bill_run row so the customer_bill FK (ref_bill_run_id -> bill_run)
    // is satisfied — the flow's aggregation always runs against a triggered run.
    // Each run gets its own throwaway cycle so the `(ref_bill_cycle_id,
    // period_start)` uniqueness never collides across tests (the run's cycle is
    // unrelated to the account's cycle — aggregation joins account -> its cycle
    // for the payment term, never run -> cycle).
    async function newRun(runId: string): Promise<void> {
      const [runCycle] = await db
        .insert(billCycle)
        .values({ name: `BM28 Run Cycle ${runId}`, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      await db.insert(billRun).values({
        billRunId: runId,
        refBillCycleId: runCycle!.billCycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        // onCycle constraint (0026): scheduled_run_date = period_end + 1. The
        // aggregation flow-double reads its own `gl_event_at` input, not this.
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

    // A product_inventory row linking a chosen product_inventory_id →
    // (account, offering). Only billing_account_id + product_offering_id matter
    // to Aggregation (it joins on both); the ordering/party FKs are irrelevant,
    // so the insert runs with FK triggers off (session_replication_role =
    // replica) and fabricates them — the bm27 fixture technique.
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
            (${piId}, ${`_bm28-poi-${piId}`}, ${`_bm28-party-${piId}`},
             ${ban}, ${offeringId}, 1, 'ACTIVE', '2026-01-01')
        `;
      });
    }

    // One CLAIMED RAN_USAGE row (status BILL_DRAFT, the six claim columns
    // stamped — the shape the flow's Collection stage leaves before Aggregation
    // reads it). `udr_key` varies by a global sequence so the live-row UNIQUE
    // never collides.
    async function insertClaimedRow(args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
    }): Promise<string> {
      seq += 1;
      const [row] = await sql<{ udr_id: string }[]>`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw,
           udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
           rating_engine_version, rating_flow_revision,
           billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
           upsert_datetime)
        VALUES
          (rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
           ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
           ${args.subRef}, ${`_bm28-key-${seq}`}, '1.000000', 'EA', 'FLAT',
           ${UNIT_PRICE}, ${UNIT_PRICE}, 'HALF_UP', 'MYR', '_BM28_BATCH',
           '_BM28', '_BM28', 0,
           ${args.runId}, ${args.ban}, ${args.attempt}, 'bm28-claim', now())
        RETURNING udr_id
      `;
      return row!.udr_id;
    }

    // The flow-double: drive the SHARED aggregation helper (tests/db/helpers/
    // billrun-aggregate.ts) — the SAME billrun_runtime SQL the flow runs (USAGE
    // rollup + the bm29 RECURRING resolver). These fixtures use usage-only
    // offerings (no recurring price), so the recurring path resolves to nothing
    // (a usage-only offering is not a D33 failure) and the result is the pure
    // USAGE rollup this suite asserts.
    async function aggregate(
      runId: string,
      ban: string,
      attempt: number,
    ): Promise<void> {
      await runAggregation(sql, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
    }

    async function readBill(runId: string, ban: string) {
      const [bill] = await db
        .select({
          customerBillId: customerBill.customerBillId,
          subtotal: customerBill.subtotal,
          taxTotal: customerBill.taxTotal,
          totalAmount: customerBill.totalAmount,
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
          lineType: customerBillLine.lineType,
          offeringId: customerBillLine.refProductOfferingId,
          udrType: customerBillLine.udrType,
          description: customerBillLine.description,
          grossAmount: customerBillLine.grossAmount,
          discountAmount: customerBillLine.discountAmount,
          netAmount: customerBillLine.netAmount,
          udrCount: customerBillLine.udrCount,
          groupingKey: customerBillLine.groupingKey,
          currency: customerBillLine.currency,
        })
        .from(customerBillLine)
        .where(eq(customerBillLine.refCustomerBillId, customerBillId))
        .orderBy(asc(customerBillLine.lineNo));
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

      // `billrun_delete_trial_bill` (the whole-account replace's deletion path)
      // is created by db/bootstrap/billrun-db-roles.sql Step 6b, NOT a migration,
      // so create it here for the flow-double (verbatim from that file). The
      // SECURITY DEFINER + grant boundary around it is proven separately by
      // billrun-db-roles.integration.test.ts; this double exercises only the
      // aggregation LOGIC (it runs as the superuser DATABASE_URL).
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
          userName: "BM28-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM28 Fixture Cycle", lastEditedBy: null })
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
      "rolls usage across subscriptions to one line per (offering, udr_type): " +
        "3 subs of offering A + 20 of B → exactly 2 lines (not 23); " +
        "SUM(net_amount) = subtotal, net = gross (bm28-spec §9.4/§9.5)",
      async () => {
        const ban = await newAccount("Grain");
        const offA = await newOffering("Offering A");
        const offB = await newOffering("Offering B");
        const runId = "BRN-BM28-01";
        const attempt = 1;
        await newRun(runId);

        const SUBS_A = 3;
        const SUBS_B = 20;
        for (let i = 0; i < SUBS_A; i += 1) {
          const pi = `PRDINV-BM28-A${i}`;
          await newInventory(pi, ban, offA);
          await insertClaimedRow({ subRef: pi, runId, ban, attempt });
        }
        for (let i = 0; i < SUBS_B; i += 1) {
          const pi = `PRDINV-BM28-B${i}`;
          await newInventory(pi, ban, offB);
          await insertClaimedRow({ subRef: pi, runId, ban, attempt });
        }

        await aggregate(runId, ban, attempt);

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);

        // Grain: exactly 2 lines, not 3 + 20 = 23.
        expect(lines).toHaveLength(2);

        // Ordered by grouping_key = "<offeringId>:RAN_USAGE"; offering ids are
        // monotonic so A precedes B (line_no 1, 2) — deterministic (Inv #21).
        const [lineA, lineB] = lines;
        expect(lineA!.lineNo).toBe(1);
        expect(lineB!.lineNo).toBe(2);
        expect(lineA!.offeringId).toBe(offA);
        expect(lineB!.offeringId).toBe(offB);
        expect(lineA!.groupingKey).toBe(`${offA}:RAN_USAGE`);
        expect(lineB!.groupingKey).toBe(`${offB}:RAN_USAGE`);

        // Every line is a USAGE charge in the account's currency.
        for (const line of lines) {
          expect(line.source).toBe("USAGE");
          expect(line.lineType).toBe("charge");
          expect(line.udrType).toBe("RAN_USAGE");
          expect(line.currency).toBe("MYR");
          // No discount this phase → net = gross.
          expect(line.discountAmount).toBe("0.00");
          expect(line.netAmount).toBe(line.grossAmount);
        }

        // udr_count reflects the rolled-up subscription/record count per line.
        expect(lineA!.udrCount).toBe(SUBS_A);
        expect(lineB!.udrCount).toBe(SUBS_B);
        expect(lineA!.description).toBe("Offering A");
        expect(lineB!.description).toBe("Offering B");

        // Money: each row priced 10.00 → A = 30.00, B = 200.00, subtotal 230.00.
        expect(lineA!.netAmount).toBe("30.00");
        expect(lineB!.netAmount).toBe("200.00");
        expect(bill!.subtotal).toBe("230.00");
        // §9.5 — SUM(net_amount) = subtotal.
        const sumNet = lines.reduce(
          (acc, l) => acc + Math.round(Number(l.netAmount) * 100),
          0,
        );
        expect(sumNet).toBe(Math.round(Number(bill!.subtotal) * 100));
        // Taxation hasn't run in this double → total = subtotal, tax 0.00.
        expect(bill!.taxTotal).toBe("0.00");
        expect(bill!.totalAmount).toBe("230.00");

        // Code-review fix #2 — the drill-down read is scoped to a line's grain
        // (product_offering_id, udr_type): offering A's disclosure returns
        // exactly A's 3 claimed records and B's exactly B's 20, NEVER the merged
        // account-wide set (both offerings are RAN_USAGE, so a udrType-only
        // filter would return all 23 for every line). Each matches the line's
        // udr_count, so the drill-down reconciles to its line.
        const drillA = await ratedLinesRepository.listClaimedForLine(
          db,
          runId,
          ban,
          offA,
          "RAN_USAGE",
        );
        const drillB = await ratedLinesRepository.listClaimedForLine(
          db,
          runId,
          ban,
          offB,
          "RAN_USAGE",
        );
        expect(drillA).toHaveLength(SUBS_A);
        expect(drillB).toHaveLength(SUBS_B);
        expect(drillA).toHaveLength(lineA!.udrCount!);
        expect(drillB).toHaveLength(lineB!.udrCount!);
      },
      120_000,
    );

    it(
      "re-running aggregation is a whole-account replace: a fresh customer_bill, " +
        "still exactly 2 lines (not 4), and identical deterministic line_no " +
        "(bm28-spec §9.9 / Inv #21)",
      async () => {
        const ban = await newAccount("Rerun");
        const offA = await newOffering("Rerun Offering A");
        const offB = await newOffering("Rerun Offering B");
        const runId = "BRN-BM28-02";
        const attempt = 1;
        await newRun(runId);

        for (const [off, prefix] of [
          [offA, "RA"],
          [offB, "RB"],
        ] as const) {
          for (let i = 0; i < 2; i += 1) {
            const pi = `PRDINV-BM28-${prefix}${i}`;
            await newInventory(pi, ban, off);
            await insertClaimedRow({ subRef: pi, runId, ban, attempt });
          }
        }

        await aggregate(runId, ban, attempt);
        const first = await readBill(runId, ban);
        const firstLines = await readLines(first!.customerBillId);
        expect(firstLines).toHaveLength(2);
        const firstShape = firstLines.map((l) => ({
          lineNo: l.lineNo,
          groupingKey: l.groupingKey,
          netAmount: l.netAmount,
        }));

        // Re-derive: the whole-account replace drops the prior bill (lines
        // cascade) and re-inserts.
        await aggregate(runId, ban, attempt);
        const second = await readBill(runId, ban);
        const secondLines = await readLines(second!.customerBillId);

        // A fresh header (whole-account replace, not an in-place update).
        expect(second!.customerBillId).not.toBe(first!.customerBillId);
        // Still exactly 2 lines — never 4 (no per-line accumulation).
        expect(secondLines).toHaveLength(2);
        // Deterministic line_no + grouping_key + amounts reproduced identically.
        const secondShape = secondLines.map((l) => ({
          lineNo: l.lineNo,
          groupingKey: l.groupingKey,
          netAmount: l.netAmount,
        }));
        expect(secondShape).toEqual(firstShape);

        // Exactly one customer_bill remains for the (run, account).
        const bills = await db
          .select({ id: customerBill.customerBillId })
          .from(customerBill)
          .where(
            and(
              eq(customerBill.refBillRunId, runId),
              eq(customerBill.refBillingAccountId, ban),
            ),
          );
        expect(bills).toHaveLength(1);
      },
      120_000,
    );
  },
);
