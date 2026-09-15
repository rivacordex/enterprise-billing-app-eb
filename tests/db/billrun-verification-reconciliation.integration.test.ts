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
import { runVerification } from "@/tests/db/helpers/billrun-verify";

// bm30-spec §Implementation §4 / Verification checklist — the DB-gated bill↔charge
// reconciliation regression. The app-repo "flow-double" (bm21/bm28/bm29 pattern):
// it drives the SAME billrun_runtime aggregation SQL (tests/db/helpers/
// billrun-aggregate.ts) to produce lines, then the SAME billrun_runtime
// verification SQL (tests/db/helpers/billrun-verify.ts) the real flow's
// `verification` stage now runs — so the detective control is provable without a
// live Kestra. It asserts:
//   * a correctly aggregated USAGE bill reconciles → verification DONE, no HARD;
//   * a deliberately mis-aggregated USAGE line (gross_amount OR udr_count out of
//     step with its claimed udr_rated rows) is caught HARD with
//     RECONCILIATION_MISMATCH — the bill never auto-passes to approval;
//   * a RECURRING line is EXCLUDED from reconciliation (it has no udr_rated source
//     — its correctness is the bm29 price snapshot): a recurring-only bill passes
//     DONE even though replaying it would find 0 vs its gross;
//   * the non-positive-total check stays SOFT (advisory) — a 0.00 bill reaches DONE
//     with a SOFT finding, never a HARD failure (bm07 behaviour preserved).
//
// It runs on the superuser DATABASE_URL connection (like the bm28/bm29 doubles),
// so it exercises the verification LOGIC, not the billrun_runtime grants — those
// are proven by billrun-db-roles.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
const USAGE_PRICE = "10.00";

describe.skipIf(!databaseUrl)(
  "bm30 verification bill↔charge reconciliation (requires DATABASE_URL)",
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
          name: `BM30-${label}-Customer`,
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
          name: `BM30-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM30-${label}-BAN`,
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
        .values({ name: `BM30 Run Cycle ${runId}`, lastEditedBy: null })
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

    async function newRecurringPrice(
      offeringId: string,
      amount: string,
      startIso: string,
    ): Promise<string> {
      const [row] = await sql<{ product_offering_price_id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, recurring_charge_period_length,
           recurring_charge_period_type, amount, currency, pricing_model, start_date_time)
        VALUES
          (${offeringId}, 'BM30 Recurring', 'recurring', 1, 'months',
           ${amount}, 'MYR', 'flat', ${startIso}::timestamptz)
        RETURNING product_offering_price_id
      `;
      return row!.product_offering_price_id;
    }

    // A subscription (product_inventory). FK triggers off (bm27/bm28/bm29 technique).
    async function newInventory(args: {
      piId: string;
      ban: string;
      offeringId: string;
      quantity: number;
      orderItemId: string;
    }): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO inventory.product_inventory
            (product_inventory_id, product_order_item_id, customer_party_role_id,
             billing_account_id, product_offering_id, quantity, status, start_date)
          VALUES
            (${args.piId}, ${args.orderItemId}, ${`_bm30-party-${args.piId}`},
             ${args.ban}, ${args.offeringId}, ${args.quantity},
             'ACTIVE', '2026-01-01')
        `;
      });
    }

    // One CLAIMED RAN_USAGE row (the shape Collection leaves before Aggregation).
    async function insertClaimedRow(args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
      price?: string;
    }): Promise<void> {
      seq += 1;
      const price = args.price ?? USAGE_PRICE;
      await sql`
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
           ${args.subRef}, ${`_bm30-key-${seq}`}, '1.000000', 'EA', 'FLAT',
           ${price}, ${price}, 'HALF_UP', 'MYR', '_BM30_BATCH',
           '_BM30', '_BM30', 0,
           ${args.runId}, ${args.ban}, ${args.attempt}, 'bm30-claim', now())
      `;
    }

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

    async function verify(runId: string, ban: string, attempt: number) {
      return runVerification(sql, { runId, ban, attempt });
    }

    async function readBill(runId: string, ban: string) {
      const [bill] = await db
        .select({
          customerBillId: customerBill.customerBillId,
          subtotal: customerBill.subtotal,
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
          customerBillLineId: customerBillLine.customerBillLineId,
          lineNo: customerBillLine.lineNo,
          source: customerBillLine.source,
          grossAmount: customerBillLine.grossAmount,
          udrCount: customerBillLine.udrCount,
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

      // billrun_delete_trial_bill is created by db/bootstrap/billrun-db-roles.sql
      // (not a migration); create it here for the flow-double (verbatim, like bm29).
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
          userName: "BM30-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM30 Fixture Cycle", lastEditedBy: null })
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
      "a correctly aggregated USAGE bill reconciles: verification is DONE with no " +
        "HARD finding and no SOFT finding (positive total) (bm30-spec §9)",
      async () => {
        const ban = await newAccount("Ok");
        const off = await newOffering("Usage Offering");
        const runId = "BRN-BM30-01";
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM30-K0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm30-oi-K0",
        });
        // 3 claimed usage records @ 10.00 → a 30.00 USAGE line.
        for (let i = 0; i < 3; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM30-K0",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        expect(bill!.subtotal).toBe("30.00");

        const outcome = await verify(runId, ban, 1);
        expect(outcome.stageStatus).toBe("DONE");
        expect(outcome.softFinding).toBeNull();
      },
      120_000,
    );

    it(
      "[CRITICAL] a mis-aggregated USAGE line (gross_amount out of step with its " +
        "claimed udr_rated rows) is caught HARD with RECONCILIATION_MISMATCH — the " +
        "bill never auto-passes to approval (bm30-spec §9)",
      async () => {
        const ban = await newAccount("BadSum");
        const off = await newOffering("BadSum Offering");
        const runId = "BRN-BM30-02";
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM30-B0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm30-oi-B0",
        });
        for (let i = 0; i < 3; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM30-B0",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
        expect(line!.source).toBe("USAGE");
        expect(line!.grossAmount).toBe("30.00");

        // Deliberately mis-aggregate: claim 100.00 over rows that sum to 30.00.
        await sql`
          UPDATE billing.customer_bill_line
          SET    gross_amount = '100.00', net_amount = '100.00'
          WHERE  customer_bill_line_id = ${line!.customerBillLineId}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(
          /RECONCILIATION_MISMATCH/,
        );
        // The finding names the ACCOUNT (not just the surrogate line id) so an
        // operator can identify which BAN failed in a multi-account run.
        await expect(verify(runId, ban, 1)).rejects.toThrow(
          new RegExp(`account ${ban}`),
        );
      },
      120_000,
    );

    it(
      "[CRITICAL] a mis-counted USAGE line (udr_count out of step with the replay " +
        "COUNT) is caught HARD even when the sum matches (bm30-spec §Design — the " +
        "count guards a coincidental sum)",
      async () => {
        const ban = await newAccount("BadCount");
        const off = await newOffering("BadCount Offering");
        const runId = "BRN-BM30-03";
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM30-C0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm30-oi-C0",
        });
        for (let i = 0; i < 3; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM30-C0",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
        expect(line!.udrCount).toBe(3);

        // Sum stays correct (30.00) but the count is wrong → still a mismatch.
        await sql`
          UPDATE billing.customer_bill_line
          SET    udr_count = 4
          WHERE  customer_bill_line_id = ${line!.customerBillLineId}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(
          /RECONCILIATION_MISMATCH/,
        );
      },
      120_000,
    );

    it(
      "a RECURRING line is EXCLUDED from reconciliation (its correctness is the " +
        "bm29 price snapshot, not a udr_rated replay): a recurring-only bill passes " +
        "verification DONE (bm30-spec §Design / Verification checklist)",
      async () => {
        const ban = await newAccount("RecOnly");
        const off = await newOffering("Recurring Offering");
        const runId = "BRN-BM30-04";
        await newRecurringPrice(off, "60.00", "2026-01-01T00:00:00Z");
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM30-R0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm30-oi-R0",
        });

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const lines = await readLines(bill!.customerBillId);
        // One RECURRING line with a 60.00 gross and NO udr_rated source — if it were
        // reconciled, the replay (0.00) would mismatch its gross. It must not be.
        expect(lines).toHaveLength(1);
        expect(lines[0]!.source).toBe("RECURRING");
        expect(bill!.subtotal).toBe("60.00");

        const outcome = await verify(runId, ban, 1);
        expect(outcome.stageStatus).toBe("DONE");
        expect(outcome.softFinding).toBeNull();
      },
      120_000,
    );

    it(
      "RECURRING exclusion is LOAD-BEARING: a mixed account (a reconciling USAGE " +
        "line + a RECURRING line that would mismatch if replayed) passes DONE — the " +
        "USAGE line proves reconciliation runs non-vacuously while the RECURRING line " +
        "is ignored (bm30-spec §Design)",
      async () => {
        const ban = await newAccount("Mixed");
        const recOff = await newOffering("Priced Offering");
        const useOff = await newOffering("Metered Offering"); // no recurring price
        const runId = "BRN-BM30-06";
        await newRecurringPrice(recOff, "15.00", "2026-01-01T00:00:00Z");
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM30-MR",
          ban,
          offeringId: recOff,
          quantity: 1,
          orderItemId: "_bm30-oi-MR",
        });
        await newInventory({
          piId: "PRDINV-BM30-MU",
          ban,
          offeringId: useOff,
          quantity: 1,
          orderItemId: "_bm30-oi-MU",
        });
        // 2 claimed usage records @ 10.00 → a reconciling 20.00 USAGE line.
        for (let i = 0; i < 2; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM30-MU",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const lines = await readLines(bill!.customerBillId);
        // Two lines: a RECURRING (15.00, NO udr_rated source) and a USAGE (20.00).
        // If the RECURRING line were reconciled, its replay (0.00) ≠ 15.00 would
        // throw; verification must pass because it is EXCLUDED.
        expect(lines).toHaveLength(2);
        const bySource = Object.fromEntries(lines.map((l) => [l.source, l]));
        expect(bySource.RECURRING!.grossAmount).toBe("15.00");
        expect(bySource.USAGE!.grossAmount).toBe("20.00");
        expect(bill!.subtotal).toBe("35.00");

        const outcome = await verify(runId, ban, 1);
        expect(outcome.stageStatus).toBe("DONE");
        expect(outcome.softFinding).toBeNull();
      },
      120_000,
    );

    it(
      "the non-positive-total check stays SOFT: a zero-charge (0.00) bill reaches " +
        "DONE with a SOFT advisory finding, never a HARD failure (bm07 preserved)",
      async () => {
        const ban = await newAccount("ZeroCharge");
        const runId = "BRN-BM30-05";
        await newRun(runId);
        // No inventory, no claimed usage → a subtotal-0.00 header (the deferred
        // zero-charge limitation). Nothing to reconcile; the SOFT check fires.

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        expect(bill!.totalAmount).toBe("0.00");

        const outcome = await verify(runId, ban, 1);
        expect(outcome.stageStatus).toBe("DONE");
        expect(outcome.softFinding).toMatch(/NON_POSITIVE_TOTAL \(SOFT\)/);
      },
      120_000,
    );
  },
);
