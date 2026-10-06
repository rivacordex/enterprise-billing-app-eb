import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billCycle } from "@/db/schema/billing/catalogs";
import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  runAggregation,
  runVerification,
} from "@/tests/db/helpers/extract-flow-sql";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";

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
    let seq = 0;

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

    // Same pricing-component shapes as billrun-capacity-aggregation
    // (bm42) — this flow-double is self-contained (bm42's own convention: see
    // that file's SonarQube round-2 note on why the scaffolding, not the
    // capacity-specific fixture shapes, was factored out).
    async function insertOfferingPrice(
      offeringId: string,
      name: string,
      componentType: string,
      envelope: Record<string, unknown>,
      unitOfMeasure: string,
      currency: string,
      startIso: string,
    ): Promise<string> {
      const [row] = await sql<{ product_offering_price_id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component, unit_of_measure, currency, start_date_time)
        VALUES
          (${offeringId}, ${name}, ${componentType}, ${JSON.stringify(persistablePricingComponentSchema.parse(envelope))}::jsonb,
           ${unitOfMeasure}, ${currency}, ${startIso}::timestamptz)
        RETURNING product_offering_price_id
      `;
      return row!.product_offering_price_id;
    }

    async function newUsageRate(
      offeringId: string,
      unitOfMeasure: string,
      ratePerUnit: string,
      startIso: string,
      currency = "MYR",
    ): Promise<string> {
      const envelope = {
        "@type": "usage_rate",
        specVersion: 1,
        plaSpecId: null,
        priceType: "usage",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { unitOfMeasure },
        params: { ratePerUnit, rateCardLookUp: null },
      };
      return insertOfferingPrice(
        offeringId,
        "BM43 Usage Rate",
        "usage_rate",
        envelope,
        unitOfMeasure,
        currency,
        startIso,
      );
    }

    async function newCapacityCommitment(
      offeringId: string,
      unitOfMeasure: string,
      committedQuantity: number,
      startIso: string,
      currency = "MYR",
    ): Promise<string> {
      const envelope = {
        "@type": "capacity_commitment",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_COMMITMENT",
        priceType: "commitment",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure },
        params: { committedQuantity },
      };
      return insertOfferingPrice(
        offeringId,
        "BM43 Capacity Commitment",
        "capacity_commitment",
        envelope,
        unitOfMeasure,
        currency,
        startIso,
      );
    }

    async function newCapacityMotivation(
      offeringId: string,
      unitOfMeasure: string,
      steps: readonly { aboveQuantity: number; ratePerUnit: string }[],
      startIso: string,
      currency = "MYR",
    ): Promise<string> {
      const envelope = {
        "@type": "capacity_motivation",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_MOTIVATION",
        priceType: "discount",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure },
        params: { steps },
      };
      return insertOfferingPrice(
        offeringId,
        "BM43 Capacity Motivation",
        "capacity_motivation",
        envelope,
        unitOfMeasure,
        currency,
        startIso,
      );
    }

    async function newCapacityOffering(
      name: string,
      opts: {
        unit?: string;
        currency?: string;
        baseRate?: string | null;
        committedQuantity?: number | null;
        steps?: readonly { aboveQuantity: number; ratePerUnit: string }[] | null;
        udrType?: string | null;
      },
    ): Promise<{ offeringId: string; usageRatePriceId: string | null }> {
      const unit = opts.unit ?? "EA";
      const currency = opts.currency ?? "MYR";
      const offeringId = await newOffering(name);
      if (opts.udrType !== null) {
        await newProductSpec(offeringId, "udrType", opts.udrType ?? "RAN_USAGE");
      }
      const usageRatePriceId =
        opts.baseRate === null
          ? null
          : await newUsageRate(
              offeringId,
              unit,
              opts.baseRate ?? "100",
              "2026-01-01T00:00:00Z",
              currency,
            );
      if (opts.committedQuantity !== null && opts.committedQuantity !== undefined) {
        await newCapacityCommitment(
          offeringId,
          unit,
          opts.committedQuantity,
          "2026-01-01T00:00:00Z",
          currency,
        );
      }
      if (opts.steps !== null && opts.steps !== undefined) {
        await newCapacityMotivation(offeringId, unit, opts.steps, "2026-01-01T00:00:00Z", currency);
      }
      return { offeringId, usageRatePriceId };
    }

    async function insertCapacityVolumeRow(args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
      quantityEa: number;
      rate: string | null;
      priceRef: string | null;
      unit?: string;
      udrType?: string;
    }): Promise<void> {
      seq += 1;
      const unit = args.unit ?? "EA";
      const udrType = args.udrType ?? "RAN_USAGE";
      const rateType = args.rate !== null ? "PER_UNIT" : "FLAT";
      const ratedPrice =
        args.rate !== null ? (args.quantityEa * Number(args.rate)).toFixed(2) : "0.00";
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_usage_rate, udr_price_ref, udr_rated_price,
           udr_rated_price_raw, udr_rounding_mode, udr_currency, udr_ref_batch_id,
           udr_source_file, rating_engine_version, rating_flow_revision,
           billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
           upsert_datetime)
        VALUES
          (rating.period_of(${IN_WINDOW}::timestamptz), ${udrType},
           ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
           ${args.subRef}, ${`_bm43-key-${seq}`}, ${args.quantityEa.toFixed(6)},
           ${unit}, ${rateType}, ${args.rate}, ${args.priceRef}, ${ratedPrice},
           ${ratedPrice}, 'HALF_UP', 'MYR', '_BM43_BATCH', '_BM43', '_BM43', 0,
           ${args.runId}, ${args.ban}, ${args.attempt}, 'bm43-claim', now())
      `;
    }

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
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "BadCount",
          "Verify BadCount Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
        expect(line!.udrCount).toBe(1);

        // Money columns stay correct — only the claimed-row count is tampered.
        await sql`
          UPDATE billing.customer_bill_line
          SET    udr_count = 2
          WHERE  customer_bill_line_id = ${await firstLineId(bill!.customerBillId)}
        `;

        await expect(verify(runId, ban, 1)).rejects.toThrow(/RECONCILIATION_MISMATCH/);
      },
      120_000,
    );

    it(
      "[CRITICAL] a tampered gross_amount (out of step with rated_amount + topUp) " +
        "is caught HARD by the internal identity check",
      async () => {
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "BadGross",
          "Verify BadGross Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
        expect(line!.grossAmount).toBe("100000.00");

        await sql`
          UPDATE billing.customer_bill_line
          SET    gross_amount = '999999.00', net_amount = '999999.00'
          WHERE  customer_bill_line_id = ${await firstLineId(bill!.customerBillId)}
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
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "LiedTrace",
          "Verify LiedTrace Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);

        // Lie about the resolved rate in the STORED trace only — the money
        // columns (gross/net/discount/rated) and the calc.total op are left
        // untouched, so the internal identity check still passes.
        await sql`
          UPDATE billing.customer_bill_line
          SET    additional_info = jsonb_set(additional_info, '{pricing,usageRate,ratePerUnit}', '999'::jsonb)
          WHERE  customer_bill_line_id = ${await firstLineId(bill!.customerBillId)}
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
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "RateDrift",
          "Verify RateDrift Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(runId, ban, 1);
        const bill = await readBill(runId, ban);
        const [line] = await readLines(bill!.customerBillId);
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
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "RateDriftOff",
          "Verify RateDriftOff Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
        await aggregate(runId, ban, 1);

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
        const { ban, usageRatePriceId, runId, piId } = await setupSingleAccountCapacity(
          "G2Off",
          "Verify G2Off Offering",
          { baseRate: "100", committedQuantity: 1000, steps: null, udrType: "RAN_USAGE" },
        );
        // Claimed row rated at 85, resolved base_rate is 100 — would HARD-fail
        // CAPACITY_RATE_MISMATCH under the default gate (proven by bm42's own
        // G2 test); here the gate is OFF.
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 500,
          rate: "85.000000",
          priceRef: usageRatePriceId,
        });

        await aggregate(runId, ban, 1, { capacityRateMatching: false });

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const [line] = await readLines(bill!.customerBillId);
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
