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
import type { InvoiceUsageAppendixRow } from "@/types/billing";

// bm45-spec §Implementation / Verification checklist — the DB-gated invoice
// usage appendix regression (the bm42/bm43-pattern flow-double: the same
// `billrun_runtime` SQL the real `bill_run_processing` flow's Aggregation
// stage now performs for the per-polygon appendix snapshot, so the
// behaviour is provable without a live Kestra). Reuses the generic
// scaffolding in `billrun-flow-double-fixtures.ts` AND the capacity-pricing
// scaffolding in `billrun-capacity-pricing-fixtures.ts` (usage_rate +
// commitment only — no motivation needed to prove the appendix join). This
// is the third capacity-pricing flow-double (after bm42/bm43), which is the
// trigger bm43's own round-2 Sonar fix documented for extracting the shared
// file instead of hand-copying the fixture block a third time
// (billmgmt-progress-tracker.md).
//
// It asserts:
//   * the appendix snapshots per-polygon rows grouped state/district,
//     sourced from the ratecard (a fixture whose ratecard state/district
//     differ from anything on `udr_rated` proves the join, not a coincidence
//     — `udr_rated` carries no state/district column at all);
//   * a card-missing polygon (usage, no ratecard row) is surfaced under
//     `state: null, district: null`, never dropped, and the account still
//     bills (no HARD fail from the appendix check, D3);
//   * every appendix row's `amount` sums to the capacity line's
//     `rated_amount` (D1 — the snapshot is Model-1-consistent);
//   * re-versioning the card AFTER aggregation does not change the
//     already-snapshotted line (rerun-stability; documents the D4 residual:
//     a REAL rerun would re-resolve against the new ACTIVE version);
//   * an account whose capacity claim spans > 10,000 distinct polygons
//     HARD-fails `CAPACITY_APPENDIX_OVER_LIMIT` (TC57), never truncating
//     silently.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

describe.skipIf(!databaseUrl)(
  "bm45 invoice usage appendix snapshot (requires DATABASE_URL)",
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
        labelPrefix: "BM45",
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
    const readBill = (runId: string, ban: string) =>
      fixtures().readBill(runId, ban);
    const readLines = (customerBillId: string) =>
      fixtures().readLines(customerBillId);

    // The shared capacity-pricing fixture scaffolding (newUsageRate/
    // newCapacityCommitment/insertCapacityVolumeRow — bm45 needs no
    // newCapacityMotivation/newCapacityOffering/setupSingleAccountCapacity,
    // the appendix join being orthogonal to the band math, and has its own
    // differently-shaped setupAccount below) — see
    // billrun-capacity-pricing-fixtures.ts for why this is factored out of
    // this file and bm42's/bm43's (this is the documented third-occurrence
    // trigger). Created ONCE, eagerly: `getSql` defers the actual `sql` read
    // to invocation time (same trick `fixtures()` above uses for
    // actorId/cycleId), so — unlike `fixtures()`, which is recreated per call
    // because it has no state — this factory can be a single instance for
    // the whole file. It must be: it closes over a `seq` counter that has to
    // stay unique across every insertCapacityVolumeRow() call here.
    const capacityFixtures = createCapacityPricingFixtures({
      getSql: () => sql,
      newOffering,
      newProductSpec,
      newAccount,
      newRun,
      newInventory,
      claimAt: IN_WINDOW,
      labelPrefix: "BM45",
    });
    const newUsageRate = (
      offeringId: string,
      unitOfMeasure: string,
      ratePerUnit: string,
    ) =>
      capacityFixtures.newUsageRate(
        offeringId,
        unitOfMeasure,
        ratePerUnit,
        "2026-01-01T00:00:00Z",
      );
    const newCapacityCommitment = (
      offeringId: string,
      unitOfMeasure: string,
      committedQuantity: number,
    ) =>
      capacityFixtures.newCapacityCommitment(
        offeringId,
        unitOfMeasure,
        committedQuantity,
        "2026-01-01T00:00:00Z",
      );

    // A minimal capacity offering (usage_rate + commitment, no motivation —
    // the appendix join is orthogonal to the band math) carrying the three
    // specs a capacity offering requires: `udrType`, `singleSubInstPerCust`
    // and `productCardLookUp` (D4 — names the ratecard this account's
    // appendix resolves against).
    async function newAppendixCapacityOffering(
      name: string,
      cardName: string,
      committedQuantity: number,
    ): Promise<{ offeringId: string; usageRatePriceId: string }> {
      const offeringId = await newOffering(name);
      await newProductSpec(offeringId, "udrType", "RAN_USAGE");
      await newProductSpec(offeringId, "singleSubInstPerCust", "true");
      await newProductSpec(offeringId, "productCardLookUp", cardName);
      const usageRatePriceId = await newUsageRate(offeringId, "EA", "100");
      await newCapacityCommitment(offeringId, "EA", committedQuantity);
      return { offeringId, usageRatePriceId };
    }

    // An ACTIVE ratecard version + its lkp rows (D-A9 natural key: version +
    // mno + commercial unit + polygon). `status` passed through so a test can
    // seed a SUPERSEDED prior version for the rerun-stability case.
    async function insertRatecardVersion(
      cardName: string,
      versionNum: number,
      status: "ACTIVE" | "SUPERSEDED",
      rows: readonly {
        polygonId: string;
        state: string | null;
        district: string | null;
      }[],
    ): Promise<string> {
      const [version] = await sql<{ ratecard_version_id: string }[]>`
        INSERT INTO product.ratecard_version
          (card_name, version_num, status, snapshot_date, source_file, row_count)
        VALUES (${cardName}, ${versionNum}, ${status}, '2026-01-01', '_BM45_FIXTURE', ${rows.length})
        RETURNING ratecard_version_id
      `;
      const ratecardVersionId = version!.ratecard_version_id;
      for (const row of rows) {
        await sql`
          INSERT INTO product.ratecard_ran_usage_lkp
            (ratecard_version_id, mno_public_key, commercial_unit_public_key,
             polygon_id, polygon_start_date, state, district, lkp_subscriber_ref_id)
          VALUES
            (${ratecardVersionId}, ${APPENDIX_MNO}, ${APPENDIX_COMMERCIAL_UNIT},
             ${row.polygonId}, '2020-01-01', ${row.state}, ${row.district}, '_BM45_FIXTURE')
        `;
      }
      return ratecardVersionId;
    }

    async function supersedeRatecardVersion(
      ratecardVersionId: string,
    ): Promise<void> {
      await sql`
        UPDATE product.ratecard_version SET status = 'SUPERSEDED'
        WHERE ratecard_version_id = ${ratecardVersionId}
      `;
    }

    const APPENDIX_MNO = "MNO-BM45";
    const APPENDIX_COMMERCIAL_UNIT = "CU-BM45";

    // D2 canonical cell: sorted key names, lower+trim values, `|`-joined —
    // the EXACT string the aggregation flow's join reconstructs from the
    // ratecard columns. Built here (not stored by `udr_rated` itself, which
    // carries no polygon column) so a row's cell identity is fully caller-
    // controlled for the test.
    function canonicalUdrKey(polygonId: string): string {
      return (
        `commercial_unit=${APPENDIX_COMMERCIAL_UNIT.toLowerCase()}` +
        `|mno_public_id=${APPENDIX_MNO.toLowerCase()}` +
        `|polygon_id=${polygonId.toLowerCase()}`
      );
    }

    const insertCapacityVolumeRow = (args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
      quantityEa: number;
      rate: string;
      priceRef: string;
      polygonId: string;
    }) =>
      capacityFixtures.insertCapacityVolumeRow({
        subRef: args.subRef,
        runId: args.runId,
        ban: args.ban,
        attempt: args.attempt,
        quantityEa: args.quantityEa,
        rate: args.rate,
        priceRef: args.priceRef,
        udrKey: canonicalUdrKey(args.polygonId),
      });

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

    // The product schema requires a capacity commitment > 0, so a scenario that
    // is not about the floor uses the smallest valid target. It must stay well
    // below the scenario's usage so the commitment floor is never engaged.
    const MIN_COMMITMENT = 1;

    async function setupAccount(
      label: string,
      cardName: string,
      committedQuantity: number,
    ): Promise<{
      ban: string;
      runId: string;
      piId: string;
      usageRatePriceId: string;
    }> {
      const ban = await newAccount(label);
      const { usageRatePriceId, offeringId } =
        await newAppendixCapacityOffering(
          `BM45 Offering ${label}`,
          cardName,
          committedQuantity,
        );
      const runId = `BRN-BM45-${label.toUpperCase()}`;
      const piId = `PRDINV-BM45-${label.toUpperCase()}`;
      await newRun(runId);
      await newInventory({
        piId,
        ban,
        offeringId,
        quantity: 1,
        orderItemId: `_bm45-oi-${label.toLowerCase()}`,
      });
      return { ban, runId, piId, usageRatePriceId };
    }

    function findAppendixRow(
      appendix: InvoiceUsageAppendixRow[],
      polygon: string,
    ): InvoiceUsageAppendixRow | undefined {
      return appendix.find((r) => r.polygon === polygon);
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
          userName: "BM45-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM45 Fixture Cycle", lastEditedBy: null })
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
      "[CRITICAL] snapshots a per-polygon appendix grouped state/district, " +
        "sourced from the ratecard — never dropping a card-missing polygon (D1/D2/D3)",
      async () => {
        const cardName = "BM45 Card — multi-polygon";
        const { ban, runId, piId, usageRatePriceId } = await setupAccount(
          "MULTI",
          cardName,
          1000,
        );

        // Ratecard state/district deliberately spell nothing `udr_rated`
        // itself carries — proving the appendix's state/district are
        // CARD-sourced, not somehow derived from the claimed row.
        await insertRatecardVersion(cardName, 1, "ACTIVE", [
          { polygonId: "POLY-A1", state: "Selangor", district: "Petaling" },
          { polygonId: "POLY-A2", state: "Selangor", district: "Klang" },
          { polygonId: "POLY-B1", state: "Johor", district: "Johor Bahru" },
          // POLY-UNMAPPED is deliberately absent from the card.
        ]);

        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 400,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          polygonId: "POLY-A1",
        });
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 300,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          polygonId: "POLY-A2",
        });
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 200,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          polygonId: "POLY-B1",
        });
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 100,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          polygonId: "POLY-UNMAPPED",
        });

        // No HARD fail from a card-missing polygon (D3) — the account bills.
        await aggregate(runId, ban);

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);
        expect(lines).toHaveLength(1);
        const line = lines[0]!;
        expect(line.ratedAmount).toBe("100000.00");

        const appendix = line.additionalInfo!
          .appendix as InvoiceUsageAppendixRow[];
        expect(appendix).toHaveLength(4);

        const a1 = findAppendixRow(appendix, "POLY-A1");
        expect(a1).toMatchObject({
          state: "Selangor",
          district: "Petaling",
          volume: "400.000000",
          amount: "40000.00",
        });
        const b1 = findAppendixRow(appendix, "POLY-B1");
        expect(b1).toMatchObject({
          state: "Johor",
          district: "Johor Bahru",
          volume: "200.000000",
          amount: "20000.00",
        });

        // The card-missing polygon is surfaced, not dropped — state/district
        // null (the render layer groups these as "Unmapped"). Its id is
        // recovered from the CANONICAL udr_key, which rating lower-cases
        // (`polygon_id=poly-unmapped`; the original case is unrecoverable),
        // whereas a mapped polygon carries the ratecard's own casing.
        const unmapped = findAppendixRow(appendix, "poly-unmapped");
        expect(unmapped).toMatchObject({
          state: null,
          district: null,
          volume: "100.000000",
          amount: "10000.00",
        });

        // D1 — the snapshot's rows reconcile to the line's rated_amount.
        const sumAmount = appendix.reduce(
          (total, row) => total + Number(row.amount),
          0,
        );
        expect(sumAmount.toFixed(2)).toBe(line.ratedAmount);
      },
    );

    it(
      "re-versioning the card AFTER aggregation does not change the " +
        "already-snapshotted line (rerun-stability; documents the D4 residual)",
      async () => {
        const cardName = "BM45 Card — rerun stability";
        const { ban, runId, piId, usageRatePriceId } = await setupAccount(
          "RERUN",
          cardName,
          MIN_COMMITMENT, // usage is 50 EA, far above it: no floor top-up
        );

        const v1 = await insertRatecardVersion(cardName, 1, "ACTIVE", [
          { polygonId: "POLY-R1", state: "Selangor", district: "Shah Alam" },
        ]);
        await insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: 50,
          rate: "100.000000",
          priceRef: usageRatePriceId,
          polygonId: "POLY-R1",
        });

        await aggregate(runId, ban);

        const bill = await readBill(runId, ban);
        const before = (await readLines(bill!.customerBillId))[0]!;
        const appendixBefore = before.additionalInfo!
          .appendix as InvoiceUsageAppendixRow[];
        expect(findAppendixRow(appendixBefore, "POLY-R1")).toMatchObject({
          state: "Selangor",
          district: "Shah Alam",
        });

        // Re-version the SAME card name with a DIFFERENT state/district for
        // the same polygon — simulating a mid-cycle card re-version (the D4
        // residual this unit documents rather than fixes).
        await supersedeRatecardVersion(v1);
        await insertRatecardVersion(cardName, 2, "ACTIVE", [
          { polygonId: "POLY-R1", state: "Perak", district: "Ipoh" },
        ]);

        // No re-aggregation — the already-written bill line must be
        // byte-identical. A rerun (a NEW aggregate() call) would re-resolve
        // against the new ACTIVE version and so would NOT reproduce this —
        // that drift is the documented D4 residual, not asserted here.
        const after = (await readLines(bill!.customerBillId))[0]!;
        expect(after.additionalInfo).toEqual(before.additionalInfo);
      },
    );

    it(
      "[CRITICAL] HARD-fails CAPACITY_APPENDIX_OVER_LIMIT (never a silent " +
        "truncation) once an account's claimed polygon count exceeds 10,000 (TC57)",
      async () => {
        const cardName = "BM45 Card — over limit";
        const { ban, runId, piId, usageRatePriceId } = await setupAccount(
          "OVERLIMIT",
          cardName,
          MIN_COMMITMENT, // 10,001 rows of usage: no floor top-up
        );

        // Bulk-insert 10,001 distinct-polygon BILL_DRAFT rows in one
        // INSERT...SELECT (far faster than 10,001 round-trips) — each row 1
        // EA at the base rate, a distinct canonical udr_key per polygon.
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
            'commercial_unit=' || lower(${APPENDIX_COMMERCIAL_UNIT}) ||
              '|mno_public_id=' || lower(${APPENDIX_MNO}) ||
              '|polygon_id=poly-over-' || g.i,
            '1.000000', 'EA', 'PER_UNIT', '100.000000', ${usageRatePriceId},
            '100.00', '100.00', 'HALF_UP', 'MYR', '_BM45_BATCH', '_BM45', '_BM45', 0,
            ${runId}, ${ban}, 1, 'bm45-overlimit-claim', now()
          FROM generate_series(1, 10001) AS g(i)
        `;

        await expect(aggregate(runId, ban)).rejects.toThrow(
          /CAPACITY_APPENDIX_OVER_LIMIT.*10001/,
        );
        expect(await readBill(runId, ban)).toBeUndefined();
      },
      60_000,
    );
  },
);
