import type postgresjs from "postgres";

import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";

// Shared capacity-pricing fixture scaffolding (usage_rate/capacity_commitment/
// capacity_motivation product_offering_price rows + the matching
// rating.udr_rated claim row) for the Target Capacity Pricing flow-double
// suites. Factored out of billrun-capacity-aggregation.integration.test.ts
// (bm42) and billrun-capacity-verification.integration.test.ts (bm43), whose
// copies were byte-identical bar "BM42"/"BM43" label strings — a duplication
// bm43's own round-2 SonarQube fix (billmgmt-progress-tracker.md) deliberately
// left in place, with the rule that a THIRD capacity-pricing unit needing the
// same fixtures is the trigger to extract this file. bm45
// (billrun-capacity-appendix.integration.test.ts) is that third unit, so bm42
// and bm43 are switched to consume this too. bm28/bm29/bm35 (non-capacity flow
// doubles) are unaffected — see billrun-flow-double-fixtures.ts for that
// separate, more generic scaffolding, which this file's `newOffering`/
// `newProductSpec` deps are expected to come from.
export interface CapacityPricingFixturesDeps {
  // A getter, not the client itself: `sql`/`db` are normally only assigned
  // inside `beforeAll`, so this factory — like `createFlowDoubleFixtures`'s
  // `getActorId`/`getCycleId` — can be created ONCE, synchronously, at
  // describe-body eval time, deferring the actual read until a returned
  // function is invoked from inside a test. That in turn means callers don't
  // need their own lazy-init/memoization boilerplate: this factory already
  // closes over a `seq` counter that must survive across every
  // insertCapacityVolumeRow() call, so a single eagerly-created instance is
  // both simpler and correct, where recreating it per call (as
  // `createFlowDoubleFixtures` deliberately does, having no such state)
  // would silently reset `seq`.
  readonly getSql: () => postgresjs.Sql;
  readonly newOffering: (name: string) => Promise<string>;
  readonly newProductSpec: (
    offeringId: string,
    name: string,
    defaultValue: string,
  ) => Promise<void>;
  // Only used by setupSingleAccountCapacity (bm42/bm43's shape; bm45 has its
  // own differently-shaped setupAccount and never calls it, but still needs
  // to supply these three since the interface is uniform across callers).
  readonly newAccount: (label: string) => Promise<string>;
  readonly newRun: (runId: string) => Promise<void>;
  readonly newInventory: (args: {
    piId: string;
    ban: string;
    offeringId: string;
    quantity: number;
    orderItemId: string;
    status?: string;
  }) => Promise<void>;
  // udr_rated claim window — IN_WINDOW in each caller file.
  readonly claimAt: string;
  // Naming/labeling prefix, e.g. "BM42" (also lower-cased for the udr_key/
  // checksum/batch strings).
  readonly labelPrefix: string;
}

export function createCapacityPricingFixtures(
  deps: CapacityPricingFixturesDeps,
) {
  const {
    getSql,
    newOffering,
    newProductSpec,
    newAccount,
    newRun,
    newInventory,
    claimAt,
    labelPrefix,
  } = deps;
  const lower = labelPrefix.toLowerCase();
  let seq = 0;

  // Shared by newUsageRate/newCapacityCommitment/newCapacityMotivation: the
  // one `product_offering_price` insert shape all three pricing components
  // share, differing only by name/component-type/envelope.
  async function insertOfferingPrice(
    offeringId: string,
    name: string,
    componentType: string,
    envelope: Record<string, unknown>,
    unitOfMeasure: string,
    currency: string,
    startIso: string,
  ): Promise<string> {
    const sql = getSql();
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

  // A usage_rate component — the capacity base rate (PC4 Option A: resolved
  // by the SAME offering + unit_of_measure, no price-id pointer, TC32).
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
      `${labelPrefix} Usage Rate`,
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
      `${labelPrefix} Capacity Commitment`,
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
      `${labelPrefix} Capacity Motivation`,
      "capacity_motivation",
      envelope,
      unitOfMeasure,
      currency,
      startIso,
    );
  }

  // A full capacity offering: usage_rate (unless omitted, for
  // G-BASE_RATE_NOT_FOUND) + an optional commitment + an optional motivation
  // schedule + an optional udrType spec (unless omitted, for
  // G-UDR_TYPE_MISMATCH's no-spec case).
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
    if (
      opts.committedQuantity !== null &&
      opts.committedQuantity !== undefined
    ) {
      await newCapacityCommitment(
        offeringId,
        unit,
        opts.committedQuantity,
        "2026-01-01T00:00:00Z",
        currency,
      );
    }
    if (opts.steps !== null && opts.steps !== undefined) {
      await newCapacityMotivation(
        offeringId,
        unit,
        opts.steps,
        "2026-01-01T00:00:00Z",
        currency,
      );
    }
    return { offeringId, usageRatePriceId };
  }

  // Shared single-account capacity fixture: account + offering + run +
  // inventory, keyed off `label` (bm42/bm43's shape — reduces the setup
  // duplication that recurs across their own anchor/guard test cases; bm45
  // has its own differently-shaped setupAccount, which also seeds the
  // ratecard-lookup specs this one doesn't, and doesn't call this).
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
    const runId = `BRN-${labelPrefix}-${label.toUpperCase()}`;
    const piId = `PRDINV-${labelPrefix}-${label.toUpperCase()}`;
    await newRun(runId);
    await newInventory({
      piId,
      ban,
      offeringId,
      quantity: 1,
      orderItemId: `_${lower}-oi-${label.toLowerCase()}`,
    });
    return { ban, offeringId, usageRatePriceId, runId, piId };
  }

  // One claimed capacity-volume row (the PER_UNIT shape G2 requires). A
  // single row of `quantityEa` (rather than N 1-EA rows, the seed's shape) is
  // equivalent for the aggregation SQL — it only SUMs — and far faster for a
  // DB-gated unit test. `rate`/`priceRef` NULL exercises TC35 (a NULL/non-
  // PER_UNIT row must still count as a CAPACITY_RATE_MISMATCH via IS DISTINCT
  // FROM, never slip past three-valued SQL logic). `udrKey` defaults to a
  // per-call sequence key; bm45's appendix join needs a caller-supplied
  // canonical cell key instead, so it's an override, not a fixed shape.
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
    udrKey?: string;
  }): Promise<void> {
    seq += 1;
    const unit = args.unit ?? "EA";
    const udrType = args.udrType ?? "RAN_USAGE";
    const udrKey = args.udrKey ?? `_${lower}-key-${seq}`;
    const rateType = args.rate !== null ? "PER_UNIT" : "FLAT";
    const ratedPrice =
      args.rate !== null
        ? (args.quantityEa * Number(args.rate)).toFixed(2)
        : "0.00";
    const sql = getSql();
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
        (rating.period_of(${claimAt}::timestamptz), ${udrType},
         ${claimAt}::timestamptz, ${claimAt}::timestamptz, 'BILL_DRAFT',
         ${args.subRef}, ${udrKey}, ${args.quantityEa.toFixed(6)},
         ${unit}, ${rateType}, ${args.rate}, ${args.priceRef}, ${ratedPrice},
         ${ratedPrice}, 'HALF_UP', 'MYR', ${`_${labelPrefix}_BATCH`},
         ${`_${labelPrefix}`}, ${`_${labelPrefix}`}, 0,
         ${args.runId}, ${args.ban}, ${args.attempt}, ${`${lower}-claim`}, now())
    `;
  }

  return {
    insertOfferingPrice,
    newUsageRate,
    newCapacityCommitment,
    newCapacityMotivation,
    newCapacityOffering,
    setupSingleAccountCapacity,
    insertCapacityVolumeRow,
  };
}
