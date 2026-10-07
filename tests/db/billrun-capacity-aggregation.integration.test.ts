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

// bm42-spec §Implementation / Verification checklist — the DB-gated capacity
// aggregation regression (code-standards §9 items 36-37). The app-repo
// "flow-double" (bm21/bm28/bm29 pattern): drives the SAME `billrun_runtime`
// SQL the real `bill_run_processing` flow's Aggregation stage now performs
// for Target Capacity Pricing — the commitment floor + N-band motivation
// discount as inline SQL CTEs (_bm42_capacity), the six account-level HARD
// `CAPACITY_*` guards, and the `rated_amount`/`additional_info` calc trace —
// so the behaviour is provable without a live Kestra. It asserts:
//   * the four anchors (800/1000/2000/0 EA on a 1000-EA-commitment,
//     >1000-EA@50-motivation offering) bill to 100,000/100,000/net
//     150,000/100,000 (TC14/TC15/TC18);
//   * commitment-only and motivation-only offerings each bill correctly,
//     independently (TC36);
//   * each of the six CAPACITY_* guards fails only its own account, HARD, no
//     bill produced — including the CAPACITY_RATE_MISMATCH NULL-rate case
//     (TC35, IS DISTINCT FROM) and CAPACITY_MULTI_STEP_UNSUPPORTED's
//     capacity_max_bands override (TC52);
//   * a misconfigured account's guard failure never blocks a healthy sibling
//     account's own aggregate() call.
//
// It runs on the superuser DATABASE_URL connection (like the bm28/bm29
// doubles), so it exercises the aggregation LOGIC, not the billrun_runtime
// grants — those are proven by billrun-db-roles.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

describe.skipIf(!databaseUrl)(
  "bm42 capacity aggregation into customer_bill_line (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;

    // The shared flow-double scaffolding (dropAll/newAccount/newRun/
    // newOffering/newProductSpec/newInventory/readBill/readLines) — see
    // billrun-flow-double-fixtures.ts for why this is factored out instead of
    // the bm28/bm29/bm35 hand-copy. `sql`/`db` are closed over directly
    // (fixtures() is only ever called after beforeAll assigns them);
    // actorId/cycleId are read through getters since they're assigned later.
    function fixtures() {
      return createFlowDoubleFixtures({
        sql,
        db,
        getActorId: () => actorId,
        getCycleId: () => cycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        labelPrefix: "BM42",
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

    // The shared capacity-pricing fixture scaffolding (insertOfferingPrice/
    // newUsageRate/newCapacityCommitment/newCapacityMotivation/
    // newCapacityOffering/insertCapacityVolumeRow) — see
    // billrun-capacity-pricing-fixtures.ts for why this is factored out of
    // this file and bm43's (byte-identical bar "BM42"/"BM43" label strings;
    // bm45 needing the same fixtures a third time was the documented trigger
    // — billmgmt-progress-tracker.md). Unlike `fixtures()` above, this IS
    // memoized: the factory closes over a `seq` counter that must stay
    // unique across every insertCapacityVolumeRow() call in this file, not
    // reset per call. Only `newCapacityOffering`/`insertCapacityVolumeRow`
    // are exposed here — this file never calls newUsageRate/
    // newCapacityCommitment/newCapacityMotivation directly, only through
    // newCapacityOffering's own (shared-factory-internal) composition.
    let capacityFixturesInstance:
      | ReturnType<typeof createCapacityPricingFixtures>
      | undefined;
    function capacityFixtures() {
      return (capacityFixturesInstance ??= createCapacityPricingFixtures({
        sql,
        newOffering,
        newProductSpec,
        claimAt: IN_WINDOW,
        labelPrefix: "BM42",
      }));
    }
    const newCapacityOffering = (
      name: string,
      opts: Parameters<
        ReturnType<typeof createCapacityPricingFixtures>["newCapacityOffering"]
      >[1],
    ) => capacityFixtures().newCapacityOffering(name, opts);

    const newInventory = (args: {
      piId: string;
      ban: string;
      offeringId: string;
      quantity: number;
      orderItemId: string;
      status?: string;
    }) => fixtures().newInventory(args);

    const insertCapacityVolumeRow = (
      args: Parameters<
        ReturnType<typeof createCapacityPricingFixtures>["insertCapacityVolumeRow"]
      >[0],
    ) => capacityFixtures().insertCapacityVolumeRow(args);

    async function aggregate(
      runId: string,
      ban: string,
      attempt: number,
      capacityMaxBands?: number,
    ): Promise<void> {
      await runAggregation(sql, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
        ...(capacityMaxBands !== undefined && { capacityMaxBands }),
      });
    }

    const readBill = (runId: string, ban: string) => fixtures().readBill(runId, ban);

    // Shared single-account capacity fixture: account + offering + run +
    // inventory, keyed off `label` (reduces the setup duplication that
    // recurs across the anchor/guard test cases below).
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
      const runId = `BRN-BM42-${label.toUpperCase()}`;
      const piId = `PRDINV-BM42-${label.toUpperCase()}`;
      await newRun(runId);
      await newInventory({
        piId,
        ban,
        offeringId,
        quantity: 1,
        orderItemId: `_bm42-oi-${label.toLowerCase()}`,
      });
      return { ban, offeringId, usageRatePriceId, runId, piId };
    }

    // A HARD guard must fail aggregate() for its account and leave no bill.
    async function expectGuardRejection(
      runId: string,
      ban: string,
      pattern: RegExp,
    ): Promise<void> {
      await expect(aggregate(runId, ban, 1)).rejects.toThrow(pattern);
      expect(await readBill(runId, ban)).toBeUndefined();
    }

    const readLines = (customerBillId: string) => fixtures().readLines(customerBillId);

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
          userName: "BM42-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM42 Fixture Cycle", lastEditedBy: null })
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
      "[CRITICAL] the four anchors — 800/1000/2000/0 EA on a 1000-EA commitment " +
        "+ >1000-EA@50 motivation offering — bill to 100,000 / 100,000 / net " +
        "150,000 (gross 200,000 − discount 50,000) / 100,000 (TC14/TC15/TC18)",
      async () => {
        const anchors = [
          { label: "A800", ea: 800, gross: "100000.00", discount: "0.00", net: "100000.00", rated: "80000.00", udrCount: 1 },
          { label: "A1000", ea: 1000, gross: "100000.00", discount: "0.00", net: "100000.00", rated: "100000.00", udrCount: 1 },
          { label: "A2000", ea: 2000, gross: "200000.00", discount: "50000.00", net: "150000.00", rated: "200000.00", udrCount: 1 },
          { label: "A0", ea: 0, gross: "100000.00", discount: "0.00", net: "100000.00", rated: "0.00", udrCount: 0 },
        ];

        for (const a of anchors) {
          const { ban, offeringId, usageRatePriceId, runId, piId } =
            await setupSingleAccountCapacity(a.label, `Anchor Offering ${a.label}`, {
              baseRate: "100",
              committedQuantity: 1000,
              steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
              udrType: "RAN_USAGE",
            });
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

          await aggregate(runId, ban, 1);

          const bill = await readBill(runId, ban);
          expect(bill).toBeDefined();
          const lines = await readLines(bill!.customerBillId);
          expect(lines).toHaveLength(1);
          const line = lines[0]!;
          expect(line.source).toBe("USAGE");
          expect(line.offeringId).toBe(offeringId);
          expect(line.udrType).toBe("RAN_USAGE");
          expect(line.quantity).toBe(`${a.ea}.000000`);
          expect(line.udrCount).toBe(a.udrCount);
          expect(line.ratedAmount).toBe(a.rated);
          expect(line.grossAmount).toBe(a.gross);
          expect(line.discountAmount).toBe(a.discount);
          expect(line.netAmount).toBe(a.net);
          expect(bill!.subtotal).toBe(a.net);
          // the calc trace's total identity matches the stored money columns
          // exactly (Inv #34 — no ±0.01 tolerance on an integer anchor).
          const calc = (line.additionalInfo?.calc ?? []) as Array<{
            op: string;
            gross?: string;
            discount?: string;
            net?: string;
          }>;
          const total = calc.find((op) => op.op === "total");
          expect(total).toBeDefined();
          expect(String(total!.gross)).toBe(a.gross);
          expect(String(total!.discount)).toBe(a.discount);
          expect(String(total!.net)).toBe(a.net);
        }
      },
      180_000,
    );

    it(
      "commitment-only (floor, discount 0) and motivation-only (topUp 0, discount " +
        "applied) offerings each bill correctly, independently (TC36)",
      async () => {
        const cases = [
          {
            label: "CommitOnly",
            offeringName: "Commitment-Only Offering",
            // Commitment-only: no motivation component. 500 EA < 1000 EA target.
            opts: {
              baseRate: "100",
              committedQuantity: 1000,
              steps: null,
              udrType: "RAN_USAGE",
            },
            quantityEa: 500,
            // rated 500×100=50,000 + topUp (1000-500)×100=50,000 = gross
            // 100,000; no motivation component ⇒ discount 0.
            rated: "50000.00",
            gross: "100000.00",
            discount: "0.00",
            net: "100000.00",
          },
          {
            label: "MotivOnly",
            offeringName: "Motivation-Only Offering",
            // Motivation-only: no commitment component. 1500 EA, step above 1000 @ 50.
            opts: {
              baseRate: "100",
              committedQuantity: null,
              steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
              udrType: "RAN_USAGE",
            },
            quantityEa: 1500,
            // rated 1500×100=150,000; no commitment ⇒ topUp 0 ⇒ gross
            // 150,000; 500 EA above the 1000 threshold × (100-50) = 25,000
            // discount.
            rated: "150000.00",
            gross: "150000.00",
            discount: "25000.00",
            net: "125000.00",
          },
        ] as const;

        for (const c of cases) {
          const { ban, usageRatePriceId, runId, piId } =
            await setupSingleAccountCapacity(c.label, c.offeringName, c.opts);
          await insertCapacityVolumeRow({
            subRef: piId,
            runId,
            ban,
            attempt: 1,
            quantityEa: c.quantityEa,
            rate: "100.000000",
            priceRef: usageRatePriceId,
          });
          await aggregate(runId, ban, 1);
          const bill = await readBill(runId, ban);
          const lines = await readLines(bill!.customerBillId);
          expect(lines).toHaveLength(1);
          expect(lines[0]!.ratedAmount).toBe(c.rated);
          expect(lines[0]!.grossAmount).toBe(c.gross);
          expect(lines[0]!.discountAmount).toBe(c.discount);
          expect(lines[0]!.netAmount).toBe(c.net);
        }
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_MULTIPLE_SUBSCRIPTIONS fails only its account; a " +
        "healthy sibling account still bills (Inv #32/#37)",
      async () => {
        const badBan = await newAccount("MultiSub");
        const { offeringId } = await newCapacityOffering("Multi-Sub Offering", {
          baseRate: "100",
          committedQuantity: 1000,
          steps: null,
          udrType: "RAN_USAGE",
        });
        const badRun = "BRN-BM42-MULTISUB";
        await newRun(badRun);
        await newInventory({
          piId: "PRDINV-BM42-MS0",
          ban: badBan,
          offeringId,
          quantity: 1,
          orderItemId: "_bm42-oi-ms0",
        });
        await newInventory({
          piId: "PRDINV-BM42-MS1",
          ban: badBan,
          offeringId,
          quantity: 1,
          orderItemId: "_bm42-oi-ms1",
        });
        await expect(aggregate(badRun, badBan, 1)).rejects.toThrow(
          /CAPACITY_MULTIPLE_SUBSCRIPTIONS/,
        );
        expect(await readBill(badRun, badBan)).toBeUndefined();

        // Sibling, same run, healthy capacity offering — unaffected.
        const goodBan = await newAccount("MultiSubSibling");
        const { offeringId: goodOff, usageRatePriceId } =
          await newCapacityOffering("Multi-Sub Sibling Offering", {
            baseRate: "100",
            committedQuantity: 1000,
            steps: null,
            udrType: "RAN_USAGE",
          });
        const goodPi = "PRDINV-BM42-MSG0";
        await newInventory({
          piId: goodPi,
          ban: goodBan,
          offeringId: goodOff,
          quantity: 1,
          orderItemId: "_bm42-oi-msg0",
        });
        await insertCapacityVolumeRow({
          subRef: goodPi,
          runId: badRun,
          ban: goodBan,
          attempt: 1,
          quantityEa: 1000,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(badRun, goodBan, 1);
        expect(await readBill(badRun, goodBan)).toBeDefined();
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_BASE_RATE_NOT_FOUND — a commitment/motivation with no " +
        "same-unit usage_rate fails HARD, no bill produced (Inv #32)",
      async () => {
        const { ban, runId } = await setupSingleAccountCapacity(
          "NoBaseRate",
          "No-Base-Rate Offering",
          { baseRate: null, committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await expectGuardRejection(runId, ban, /CAPACITY_BASE_RATE_NOT_FOUND/);
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_UDR_TYPE_MISMATCH — a claimed row off-type from the " +
        "offering's spec udrType fails HARD, no bill produced (Inv #32)",
      async () => {
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "UdrTypeMismatch",
          "UDR-Type-Mismatch Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        // Claimed row carries a DIFFERENT udr_type than the offering's spec.
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          udrType: "OTHER_USAGE",
        });
        await expectGuardRejection(runId, ban, /CAPACITY_UDR_TYPE_MISMATCH/);
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_RATE_MISMATCH (G2) — a mismatched rate AND a NULL-rate " +
        "/non-PER_UNIT row both fail HARD, no bill produced (IS DISTINCT FROM, TC35)",
      async () => {
        // A row rated at 85 instead of the resolved base_rate 100.
        const {
          ban: mismatchBan,
          usageRatePriceId: mismatchPriceId,
          runId: mismatchRun,
          piId: mismatchPi,
        } = await setupSingleAccountCapacity("RateMismatch", "Rate-Mismatch Offering", {
          baseRate: "100",
          committedQuantity: 1000,
          steps: null,
          udrType: "RAN_USAGE",
        });
        await insertCapacityVolumeRow({
          subRef: mismatchPi,
          runId: mismatchRun,
          ban: mismatchBan,
          attempt: 1,
          quantityEa: 500,
          rate: "85.000000",
          priceRef: mismatchPriceId,
        });
        await expectGuardRejection(mismatchRun, mismatchBan, /CAPACITY_RATE_MISMATCH/);

        // A NULL-rate (non-PER_UNIT, e.g. a FLAT row) must COUNT as a
        // mismatch — IS DISTINCT FROM, not <> (TC35).
        const {
          ban: nullRateBan,
          runId: nullRateRun,
          piId: nullRatePi,
        } = await setupSingleAccountCapacity(
          "NullRateMismatch",
          "Null-Rate-Mismatch Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: nullRatePi,
          runId: nullRateRun,
          ban: nullRateBan,
          attempt: 1,
          quantityEa: 500,
          rate: null,
          priceRef: null,
        });
        await expectGuardRejection(nullRateRun, nullRateBan, /CAPACITY_RATE_MISMATCH/);
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_MULTI_STEP_UNSUPPORTED — a 2-band schedule fails HARD " +
        "under the default capacity_max_bands=1, and raising the input to 2 lets " +
        "it through (TC52)",
      async () => {
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "MultiStep",
          "Multi-Step Offering",
          {
            baseRate: "100",
            committedQuantity: null,
            steps: [
              { aboveQuantity: 1000, ratePerUnit: "50" },
              { aboveQuantity: 2000, ratePerUnit: "25" },
            ],
            udrType: "RAN_USAGE",
          },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 2500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });

        // Default capacity_max_bands (1) rejects a 2-band schedule.
        await expectGuardRejection(runId, ban, /CAPACITY_MULTI_STEP_UNSUPPORTED/);

        // Raising the input to 2 is a config change, not a pricing-SQL edit —
        // the SAME account now bills. rated 2500×100=250,000; band1 (1000-2000)
        // 1000×(100-50)=50,000; band2 (>2000) 500×(100-25)=37,500; discount
        // 87,500; gross 250,000; net 162,500.
        await aggregate(runId, ban, 1, 2);
        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);
        expect(lines).toHaveLength(1);
        expect(lines[0]!.ratedAmount).toBe("250000.00");
        expect(lines[0]!.grossAmount).toBe("250000.00");
        expect(lines[0]!.discountAmount).toBe("87500.00");
        expect(lines[0]!.netAmount).toBe("162500.00");
      },
      120_000,
    );

    it(
      "[CRITICAL] CAPACITY_CURRENCY_MISMATCH (G3) — a component priced in a " +
        "currency other than the account's fails HARD, no bill produced",
      async () => {
        // account currency MYR; offering priced in USD.
        const { ban, runId } = await setupSingleAccountCapacity(
          "CurrencyMismatch",
          "Currency-Mismatch Offering",
          {
            baseRate: "100",
            committedQuantity: 1000,
            steps: null,
            udrType: "RAN_USAGE",
            currency: "USD",
          },
        );
        await expectGuardRejection(runId, ban, /CAPACITY_CURRENCY_MISMATCH/);
      },
      120_000,
    );

    it(
      "a capacity offering's usage in a DIFFERENT unit stays an ordinary USAGE " +
        "line, and the capacity volume is not double-counted there",
      async () => {
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "DifferentUnit",
          "Different-Unit Offering",
          {
            unit: "EA",
            baseRate: "100",
            committedQuantity: 1000,
            steps: null,
            udrType: "RAN_USAGE",
          },
        );
        // Capacity volume in EA (the capacity unit).
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          unit: "EA",
        });
        // Separate usage on the SAME offering in a DIFFERENT unit (Mbps) —
        // ordinary USAGE line, never matched against _bm42_capacity (unit
        // differs), never guard-checked.
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 10,
          rate: null,
          priceRef: null,
          unit: "Mbps",
        });

        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);
        expect(lines).toHaveLength(2);
        const byUnit = Object.fromEntries(lines.map((l) => [l.unit, l]));
        // EA line is the capacity line (floor applies: 500 < 1000 target).
        expect(byUnit.EA!.ratedAmount).toBe("50000.00");
        expect(byUnit.EA!.grossAmount).toBe("100000.00");
        // Mbps line is an ordinary USAGE line (gross = SUM(udr_rated_price) = 0.00
        // for this fixture's unrated row; the point is its EXISTENCE and grain,
        // not its amount).
        expect(byUnit.Mbps!.source).toBe("USAGE");
        expect(byUnit.Mbps!.udrCount).toBe(1);
      },
      120_000,
    );
  },
);
