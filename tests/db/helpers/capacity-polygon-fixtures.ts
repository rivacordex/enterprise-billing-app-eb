import type { drizzle } from "drizzle-orm/postgres-js";
import type postgresjs from "postgres";

import type * as schema from "@/db/schema";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { runAggregation } from "@/tests/db/helpers/extract-flow-sql";
import { createCapacityPricingFixtures } from "@/tests/db/helpers/billrun-capacity-pricing-fixtures";
import type { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";
import { buildRawUdrKey } from "@/validation/rating/udr-key";
import { formatUdrResource } from "@/validation/rating/udr-resource.schema";

// bm71 guardrail 63 / bm73-spec §Implementation §2 — capacity bills on
// rating-shaped `udr_rated` rows (rating Phase H: the rm26 raw `udr_key`,
// `name=value` joined by `|`, and the rm25 `udr_resource`
// `state|district|YYYY-MM-DD`), aggregated by the extracted
// `bill_run_processing` SQL. Shared by the capacity detail suite and the
// Phase 3 journey's ~900-polygon BAN (`regionPolygons(9, 100)`).

const KEY_COLUMNS = ["commercial_unit", "mno_public_id", "polygon_id"];

export interface CapacityPolygon {
  polygonId: string | null; // null → a key with no polygon_id= segment
  udrResource: string | null;
  ea: number;
  status?: "BILL_DRAFT" | "BILL_NOTUSED";
  attempt?: number;
}

export function polygonResource(
  state: string | null,
  district: string | null,
  date = "2025-03-01",
): string {
  return formatUdrResource({ state, district, polygonStartDate: date });
}

// `regions` State-District groups of `perRegion` 1-EA polygons each.
export function regionPolygons(
  regions: number,
  perRegion: number,
  prefix = "PCU",
): CapacityPolygon[] {
  const polygons: CapacityPolygon[] = [];
  for (let r = 1; r <= regions; r++) {
    const udrResource = polygonResource(`STATE-${r}`, `DISTRICT-${r}`);
    for (let i = 1; i <= perRegion; i++) {
      polygons.push({
        polygonId: `${prefix}-${r}-${String(i).padStart(4, "0")}`,
        udrResource,
        ea: 1,
      });
    }
  }
  return polygons;
}

export interface CapacityPolygonFixturesDeps {
  // Getters: a suite opens its connection in `beforeAll`.
  readonly getSql: () => postgresjs.Sql;
  readonly getDb: () => ReturnType<typeof drizzle<typeof schema>>;
  readonly flowDouble: () => ReturnType<typeof createFlowDoubleFixtures>;
  readonly labelPrefix: string;
  readonly claimAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly glEventAt: string;
}

export function createCapacityPolygonFixtures(
  deps: CapacityPolygonFixturesDeps,
) {
  const { getSql, getDb, flowDouble, labelPrefix, claimAt } = deps;

  const capacityFixtures = createCapacityPricingFixtures({
    getSql,
    newOffering: (name) => flowDouble().newOffering(name),
    newProductSpec: (offeringId, name, defaultValue) =>
      flowDouble().newProductSpec(offeringId, name, defaultValue),
    newAccount: (label) => flowDouble().newAccount(label),
    newRun: (runId) => flowDouble().newRun(runId),
    newInventory: (args) => flowDouble().newInventory(args),
    claimAt,
    labelPrefix,
  });

  const OFFERING_OPTS = {
    baseRate: "100",
    committedQuantity: 1000,
    steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
    udrType: "RAN_USAGE",
  } as const;

  // A rating-shaped claimed row at RM100/Mbps. The commercial unit is per
  // subscription, so the same polygon id under two types has two keys (the
  // live-row unique constraint is on `udr_key`).
  async function insertPolygon(args: {
    piId: string;
    runId: string;
    ban: string;
    cu: string;
    priceRef: string | null;
    polygon: CapacityPolygon;
  }): Promise<void> {
    const sql = getSql();
    const { polygon } = args;
    const columns: Record<string, string> = {
      commercial_unit: args.cu,
      mno_public_id: `MNO-${labelPrefix}`,
    };
    const keyColumns = KEY_COLUMNS.filter(
      (c) => c !== "polygon_id" || polygon.polygonId !== null,
    );
    if (polygon.polygonId !== null) columns.polygon_id = polygon.polygonId;
    // 100 per EA, as a 2-dp money string (also valid for a fractional EA).
    const price = (polygon.ea * 100).toFixed(2);
    await sql`
      INSERT INTO rating.udr_rated
        (partition_period, udr_type, start_datetime, end_datetime, status,
         udr_subscription_ref_id, udr_key, udr_resource, udr_usage_quantity,
         udr_usage_unit, udr_rate_type, udr_usage_rate, udr_price_ref,
         udr_rated_price, udr_rated_price_raw, udr_rounding_mode, udr_currency,
         udr_ref_batch_id, udr_source_file, rating_engine_version,
         rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
         billrun_checksum, upsert_datetime)
      VALUES
        (rating.period_of(${claimAt}::timestamptz), 'RAN_USAGE',
         ${claimAt}::timestamptz, ${claimAt}::timestamptz,
         ${polygon.status ?? "BILL_DRAFT"}, ${args.piId},
         ${buildRawUdrKey(columns, keyColumns)}, ${polygon.udrResource},
         ${polygon.ea.toFixed(6)}, 'EA', 'PER_UNIT', '100.000000',
         ${args.priceRef}, ${price}, ${price}, 'HALF_UP', 'MYR',
         ${`_${labelPrefix}_BATCH`}, ${`_${labelPrefix}`}, ${`_${labelPrefix}`},
         0, ${args.runId}, ${args.ban}, ${polygon.attempt ?? 1},
         ${`${labelPrefix.toLowerCase()}-claim`}, now())
    `;
  }

  // One BAN with one capacity subscription per entry of `types` (label →
  // its polygons), aggregated by the extracted flow SQL for `attempt`, on its
  // own fixture run; the run row is PROCESSED.
  async function capacityBill(
    label: string,
    types: Record<string, CapacityPolygon[]>,
    attempt = 1,
  ): Promise<{ runId: string; ban: string; offerings: string[] }> {
    const entries = Object.entries(types);
    const first = await capacityFixtures.setupSingleAccountCapacity(
      label,
      entries[0]![0],
      OFFERING_OPTS,
    );
    const { ban, runId } = first;
    const subs = [
      {
        offeringId: first.offeringId,
        priceRef: first.usageRatePriceId,
        piId: first.piId,
      },
    ];
    for (const [i, [name]] of entries.slice(1).entries()) {
      const { offeringId, usageRatePriceId } =
        await capacityFixtures.newCapacityOffering(name, OFFERING_OPTS);
      const piId = `${first.piId}-${i + 2}`;
      await flowDouble().newInventory({
        piId,
        ban,
        offeringId,
        quantity: 1,
        orderItemId: `_${labelPrefix.toLowerCase()}-oi-${label.toLowerCase()}-${i + 2}`,
      });
      subs.push({ offeringId, priceRef: usageRatePriceId, piId });
    }
    for (const [i, [, polygons]] of entries.entries()) {
      for (const polygon of polygons) {
        await insertPolygon({
          piId: subs[i]!.piId,
          runId,
          ban,
          cu: `CU-${labelPrefix}-${label}-${i + 1}`,
          priceRef: subs[i]!.priceRef,
          polygon,
        });
      }
    }
    await runAggregation(getSql(), {
      runId,
      ban,
      attempt,
      periodStart: deps.periodStart,
      periodEnd: deps.periodEnd,
      glEventAt: deps.glEventAt,
    });
    await getDb().insert(billRunAccount).values({
      refBillRunId: runId,
      refBillingAccountId: ban,
      periodPartition: deps.periodStart,
      status: "PROCESSED",
      attemptCount: attempt,
    });
    return { runId, ban, offerings: subs.map((s) => s.offeringId) };
  }

  return {
    capacityBill,
    insertPolygon,
    capacityFixtures,
    offeringOpts: OFFERING_OPTS,
  };
}
