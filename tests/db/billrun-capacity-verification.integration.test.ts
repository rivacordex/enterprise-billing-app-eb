import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billCycle } from "@/db/schema/billing/catalogs";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  runAggregation,
  runVerification,
} from "@/tests/db/helpers/extract-flow-sql";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";
import { createCapacityPricingFixtures } from "@/tests/db/helpers/billrun-capacity-pricing-fixtures";

// bm43-spec §Implementation / Verification checklist — the DB-gated capacity
// VERIFICATION regression (the bm21/bm28/bm29/bm42 flow-double pattern). Drives
// the SAME billrun_runtime SQL the real bill_run_processing flow's
// `verification` step now performs for Target Capacity Pricing: the
// rated_amount-anchored USAGE replay (D1), the capacity-line replay +
// internal identities (D2), the independent Model-2 cross-derivation (D3),
// and the capacity_rate_matching gate shared with aggregation's G2 (D4). It
// asserts:
//   * Model-2 reconciles on the four anchors — INCLUDING the under-target
//     anchors (800/0 EA) that the pre-bm43 gross_amount-anchored replay would
//     have false-failed (D1/D2);
//   * a tampered capacity claim count is caught HARD by the capacity replay,
//     independently of the money-column internal identity check;
//   * a tampered gross_amount (out of step with rated_amount + topUp) is
//     caught HARD by the internal identity check;
//   * a corrupted additional_info.pricing trace, left otherwise consistent,
//     does NOT make Model-2 pass spuriously (it is re-resolved from the
//     catalog, never read back from additional_info) — a passing test here is
//     "Model-2 ignored the lie", not "the lie happened to validate";
//   * gate ON (default): a post-aggregation catalog rate drift makes Model-2
//     disagree with the billed Model-1 figure and HARD-fails
//     CAPACITY_RATE_MISMATCH, naming both figures;
//   * gate OFF: the SAME drift downgrades to a WARN in verification, and (at
//     aggregation) a claimed-row rate mismatch no longer aborts G2 — the
//     account bills Model 1's actual number either way, never silently.
//
// Runs on the superuser DATABASE_URL connection (like the bm28/bm29/bm42
// doubles), so it exercises the verification LOGIC, not the billrun_runtime
// grants — those are proven by billrun-db-roles.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

describe.skipIf(!databaseUrl)(
  "bm43 capacity verification: rated_amount replay, Model-2 & the gate (requires DATABASE_URL)",
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
        labelPrefix: "BM43",
      });
    }
    const dropAll = (client: postgresjs.Sql) => fixtures().dropAll(client);
    const newAccount = (label: string) => fixtures().newAccount(label);
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
    }) => fixtures().newInventory(args);
    const readBill = (runId: string, ban: string) => fixtures().readBill(runId, ban);
    const readLines = (customerBillId: string) => fixtures().readLines(customerBillId);

    // The shared capacity-pricing fixture scaffolding (insertOfferingPrice/
    // newUsageRate/newCapacityCommitment/newCapacityMotivation/
    // newCapacityOffering/insertCapacityVolumeRow) — see
    // billrun-capacity-pricing-fixtures.ts for why this is factored out of
    // this file and bm42's (byte-identical bar "BM42"/"BM43" label strings;
    // bm45 needing the same fixtures a third time was the documented trigger
    // — billmgmt-progress-tracker.md). Memoized (unlike `fixtures()` above):
    // the factory closes over a `seq` counter that must stay unique across
    // every insertCapacityVolumeRow() call in this file, not reset per call.
    // Only `newCapacityOffering`/`insertCapacityVolumeRow` are exposed here
    // — this file never calls newUsageRate/newCapacityCommitment/
    // newCapacityMotivation directly, only through newCapacityOffering's own
    // (shared-factory-internal) composition.
    let capacityFixturesInstance:
      | ReturnType<typeof createCapacityPricingFixtures>
      | undefined;
    function capacityFixtures() {
      return (capacityFixturesInstance ??= createCapacityPricingFixtures({
        sql,
        newOffering,
        newProductSpec,
        claimAt: IN_WINDOW,
        labelPrefix: "BM43",
      }));
    }
    const newCapacityOffering = (
      name: string,
      opts: Parameters<
        ReturnType<typeof createCapacityPricingFixtures>["newCapacityOffering"]
      >[1],
    ) => capacityFixtures().newCapacityOffering(name, opts);
    const insertCapacityVolumeRow = (
      args: Parameters<
        ReturnType<typeof createCapacityPricingFixtures>["insertCapacityVolumeRow"]
      >[0],
    ) => capacityFixtures().insertCapacityVolumeRow(args);

    async function aggregate(
      runId: string,
      ban: string,
      attempt: number,
      opts?: { capacityMaxBands?: number; capacityRateMatching?: boolean },
    ): Promise<void> {
      await runAggregation(sql, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
        ...(opts?.capacityMaxBands !== undefined && { capacityMaxBands: opts.capacityMaxBands }),
        ...(opts?.capacityRateMatching !== undefined && {
          capacityRateMatching: opts.capacityRateMatching,
        }),
      });
    }

    async function verify(
      runId: string,
      ban: string,
      attempt: number,
      capacityRateMatching?: boolean,
    ) {
      return runVerification(sql, {
        runId,
        ban,
        attempt,
        ...(capacityRateMatching !== undefined && { capacityRateMatching }),
      });
    }

    // The shared flow-double fixtures' readLines() (billrun-flow-double-
    // fixtures.ts) doesn't project customer_bill_line_id — this file's tamper
    // tests need it to target the UPDATE, so a small local read.
    async function firstLineId(customerBillId: string): Promise<string> {
      const [row] = await sql<{ customer_bill_line_id: string }[]>`
        SELECT customer_bill_line_id FROM billing.customer_bill_line
        WHERE  ref_customer_bill_id = ${customerBillId}
        ORDER  BY line_no
        LIMIT  1
      `;
      return row!.customer_bill_line_id;
    }

    // Single-account capacity fixture (account + offering + run + inventory),
    // mirroring bm42's setupSingleAccountCapacity.
    async function setupSingleAccountCapacity(
      label: string,
      offeringName: string,
      offeringOpts: Parameters<typeof newCapacityOffering>[1],
    ): Promise<{
      ban: string;
      offeringId: string;
      usageRatePriceId: string | null;
      runId: string;
      piId: string;
    }> {
      const ban = await newAccount(label);
      const { offeringId, usageRatePriceId } = await newCapacityOffering(
        offeringName,
        offeringOpts,
      );
      const runId = `BRN-BM43-${label.toUpperCase()}`;
      const piId = `PRDINV-BM43-${label.toUpperCase()}`;
      await newRun(runId);
      await newInventory({
        piId,
        ban,
        offeringId,
        quantity: 1,
        orderItemId: `_bm43-oi-${label.toLowerCase()}`,
      });
      return { ban, offeringId, usageRatePriceId, runId, piId };
    }

    // Shared single-line fixture: setupSingleAccountCapacity() + a single
    // insertCapacityVolumeRow() + aggregate(), returning the resulting bill
    // and its one line — reduces the setup duplication that recurs across
    // the tamper/rate-drift guard test cases below (same SonarQube
    // "Duplicated Lines" pattern bm42's own setupSingleAccountCapacity
    // extraction addressed; see billmgmt-progress-tracker.md round 1).
    async function setupAndAggregateSingleLine(
      label: string,
      offeringName: string,
      opts?: {
        rate?: string;
        aggregateOpts?: Parameters<typeof aggregate>[3];
      },
    ): Promise<{
      ban: string;
      usageRatePriceId: string | null;
      runId: string;
      piId: string;
      bill: NonNullable<Awaited<ReturnType<typeof readBill>>>;
      line: Awaited<ReturnType<typeof readLines>>[number] | undefined;
    }> {
      const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
        label,
        offeringName,
        { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
      );
      await insertCapacityVolumeRow({
        subRef: piId,
        runId,
        ban,
        attempt: 1,
        quantityEa: 500,
        rate: opts?.rate ?? "100.000000",
        priceRef: usageRatePriceId,
      });
      await aggregate(runId, ban, 1, opts?.aggregateOpts);
      const bill = await readBill(runId, ban);
      const [line] = await readLines(bill!.customerBillId);
      return { ban, usageRatePriceId, runId, piId, bill: bill!, line };
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
          userName: "BM43-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM43 Fixture Cycle", lastEditedBy: null })
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
      "[CRITICAL] Model-2 reconciles on the four anchors (TC50), INCLUDING the " +
        "under-target anchors (800/0 EA) that the pre-bm43 gross_amount-anchored " +
        "replay would have false-failed (D1/D2)",
      async () => {
        const anchors = [800, 1000, 2000, 0];
        for (const ea of anchors) {
          const label = `Anchor${ea}`;
          const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
            label,
            `Verify Anchor Offering ${ea}`,
            {
              baseRate: "100",
              committedQuantity: 1000,
              steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
              udrType: "RAN_USAGE",
            },
          );
          if (ea > 0) {
            await insertCapacityVolumeRow({
              subRef: piId,
              runId,
              ban,
              attempt: 1,
              quantityEa: ea,
              rate: "100.000000",
              priceRef: usageRatePriceId,
            });
          }
          await aggregate(runId, ban, 1);
          const outcome = await verify(runId, ban, 1);
          expect(outcome.stageStatus).toBe("DONE");
        }
      },
      180_000,
    );

    it(
      "[CRITICAL] a tampered claimed-row count (udr_count) on a capacity line is " +
        "caught HARD by the capacity replay, independently of the money-column " +
        "internal identity check",
      async () => {
        const { ban, runId, bill, line } = await setupAndAggregateSingleLine(
          "BadCount",
          "Verify BadCount Offering",
        );
        expect(line!.udrCount).toBe(1);

        // Money columns stay correct — only the claimed-row count is tampered.
        await sql`
          UPDATE billing.customer_bill_line
          SET    udr_count = 2
          WHERE  customer_bill_line_id = ${await firstLineId(bill.customerBillId)}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(/RECONCILIATION_MISMATCH/);
      },
      120_000,
    );

    it(
      "[CRITICAL] a tampered gross_amount (out of step with rated_amount + topUp) " +
        "is caught HARD by the internal identity check",
      async () => {
        const { ban, runId, bill, line } = await setupAndAggregateSingleLine(
          "BadGross",
          "Verify BadGross Offering",
        );
        expect(line!.grossAmount).toBe("100000.00");

        await sql`
          UPDATE billing.customer_bill_line
          SET    gross_amount = '999999.00', net_amount = '999999.00'
          WHERE  customer_bill_line_id = ${await firstLineId(bill.customerBillId)}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(/RECONCILIATION_MISMATCH/);
      },
      120_000,
    );

    it(
      "a corrupted additional_info.pricing trace, left otherwise consistent, does " +
        "NOT make Model-2 pass spuriously — it is re-resolved from the catalog, " +
        "never read back from additional_info",
      async () => {
        const { ban, runId, bill } = await setupAndAggregateSingleLine(
          "LiedTrace",
          "Verify LiedTrace Offering",
        );

        // Lie about the resolved rate in the STORED trace only — the money
        // columns (gross/net/discount/rated) and the calc.total op are left
        // untouched, so the internal identity check still passes.
        await sql`
          UPDATE billing.customer_bill_line
          SET    additional_info = jsonb_set(additional_info, '{pricing,usageRate,ratePerUnit}', '999'::jsonb)
          WHERE  customer_bill_line_id = ${await firstLineId(bill.customerBillId)}
        `;

        const outcome = await verify(runId, ban, 1);
        expect(outcome.stageStatus).toBe("DONE");
      },
      120_000,
    );

    it(
      "[CRITICAL] gate ON (default): a catalog usage_rate drift after aggregation " +
        "makes Model-2 disagree with the billed Model-1 figure, HARD-failing " +
        "CAPACITY_RATE_MISMATCH and naming both figures (Inv #29/#30)",
      async () => {
        const { ban, usageRatePriceId, runId, line } = await setupAndAggregateSingleLine(
          "RateDrift",
          "Verify RateDrift Offering",
        );
        expect(line!.grossAmount).toBe("100000.00"); // Model 1, billed at rate 100

        // The rate card changes AFTER aggregation ran — Model-2 (verification)
        // re-resolves the CURRENT catalog, Model 1 (already billed) does not.
        await sql`
          UPDATE product.product_offering_price
          SET    price_component = jsonb_set(price_component, '{params,ratePerUnit}', '"120"')
          WHERE  product_offering_price_id = ${usageRatePriceId}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(/CAPACITY_RATE_MISMATCH/);
        await expect(verify(runId, ban, 1)).rejects.toThrow(/Model 1 \(billed\)/);
        await expect(verify(runId, ban, 1)).rejects.toThrow(/Model 2 \(re-resolved\)/);
      },
      120_000,
    );

    it(
      "gate OFF: the SAME rate drift downgrades to a WARN in verification — the " +
        "account's stage reaches DONE and the stored (Model-1) figure is untouched " +
        "(verification never writes)",
      async () => {
        const { ban, usageRatePriceId, runId } = await setupAndAggregateSingleLine(
          "RateDriftOff",
          "Verify RateDriftOff Offering",
        );

        await sql`
          UPDATE product.product_offering_price
          SET    price_component = jsonb_set(price_component, '{params,ratePerUnit}', '"120"')
          WHERE  product_offering_price_id = ${usageRatePriceId}
        `;

        const outcome = await verify(runId, ban, 1, false);
        expect(outcome.stageStatus).toBe("DONE");

        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
        expect(line!.grossAmount).toBe("100000.00"); // Model 1's figure, unchanged
      },
      120_000,
    );

    it(
      "[CRITICAL] gate OFF at aggregation (G2): a claimed row's rate disagreement " +
        "no longer aborts the account — it bills Model 1's actual number instead " +
        "of HARD-failing (Inv #29/#30)",
      async () => {
        // Claimed row rated at 85, resolved base_rate is 100 — would HARD-fail
        // CAPACITY_RATE_MISMATCH under the default gate (proven by bm42's own
        // G2 test); here the gate is OFF.
        const { ban, runId, bill, line } = await setupAndAggregateSingleLine(
          "G2Off",
          "Verify G2Off Offering",
          { rate: "85.000000", aggregateOpts: { capacityRateMatching: false } },
        );
        expect(bill).toBeDefined();
        // rated = 500 * 85 = 42,500 (the ACTUAL claimed price, never
        // substituted); topUp uses the RESOLVED base_rate (100), not the
        // mismatched claimed rate: (1000-500)*100 = 50,000. gross = 92,500.
        expect(line!.ratedAmount).toBe("42500.00");
        expect(line!.grossAmount).toBe("92500.00");
        expect(line!.netAmount).toBe("92500.00");

        // Verification (gate OFF too) also passes DONE, never silent — the
        // relaxed state is what the NOTICE/execution-input record (D5)
        // documents, not asserted here (no per-call NOTICE hook, same
        // limitation runVerification's softFinding reconstruction notes).
        const outcome = await verify(runId, ban, 1, false);
        expect(outcome.stageStatus).toBe("DONE");
      },
      120_000,
    );
  },
);
