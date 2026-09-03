import { sql, type SQL } from "drizzle-orm";

import { udrRateDetailSchema } from "@/validation/rating/udr-rate-detail.schema";
import type { UdrRatedInsert } from "@/db/schema/rating/udr-rated";

// bm15-spec §Implementation §2 — the D28 stand-in for rating's own
// `udr_rated` row-factory (not yet exposed at runtime): billing-owned,
// **sample-seed-only**. Swap the body for rating's real factory if/when it
// lands; nothing outside `db/seeds/sample/**` may import this file (it
// produces intentionally-fake charges, never a real rated usage record).
export const SAMPLE_UDR_SOURCE_FILE = "_SAMPLE_billrun";
const SAMPLE_PROVENANCE_SENTINEL = "_SAMPLE_";
const SAMPLE_BATCH_REF = "_SAMPLE_BATCH";

export interface SampleChargeSpec {
  ban: string;
  subscriberRefId: string; // the product_inventory id the charge rates
  priceRef: string; // the product_offering_price id the charge prices against
  startDatetime: Date;
  endDatetime: Date;
  ratedPrice: string; // 2dp money string
  currency: string;
  status?: "RATED" | "BILL_NOTUSED";
  sequence: number; // disambiguates udr_key across rows for the same account/period
}

// A row shaped exactly like `UdrRatedInsert` except `partitionPeriod`, which
// is computed by calling rating's own `IMMUTABLE rating.period_of()` helper
// (bm15-spec §Implementation §2) rather than re-derived in JS — the table's
// own CHECK re-derives it the same way, so the two can never drift.
export type SampleUdrRatedRow = Omit<UdrRatedInsert, "partitionPeriod"> & {
  partitionPeriod: SQL;
};

// Sorted-key, fixed-format `udr_key` (rm01-spec D5 precedent: half the
// table's natural key). JSON.stringify on an object literal with keys
// already declared in alphabetical order is deterministic across engines —
// no external sort routine is needed for a four-field key.
function buildUdrKey(spec: SampleChargeSpec): string {
  return JSON.stringify({
    ban: spec.ban,
    priceRef: spec.priceRef,
    seq: spec.sequence,
    startIso: spec.startDatetime.toISOString(),
  });
}

export function buildSampleUdrRatedRow(
  spec: SampleChargeSpec,
): SampleUdrRatedRow {
  const rateDetail = udrRateDetailSchema.parse({ rateType: "FLAT" });

  return {
    partitionPeriod: sql`rating.period_of(${spec.startDatetime.toISOString()}::timestamptz)`,
    udrType: "SUBSCRIPTION_RECURRING",
    startDatetime: spec.startDatetime,
    endDatetime: spec.endDatetime,
    status: spec.status ?? "RATED",
    udrSubscriberRefId: spec.subscriberRefId,
    udrKey: buildUdrKey(spec),
    udrUsageQuantity: "1.000000",
    udrUsageUnit: "EA",
    udrRateType: "FLAT",
    udrRateDetail: rateDetail,
    udrRatedPrice: spec.ratedPrice,
    udrRatedPriceRaw: spec.ratedPrice,
    udrRoundingMode: "HALF_UP",
    udrCurrency: spec.currency,
    udrPriceRef: spec.priceRef,
    // Unclaimed (bm15-spec §Implementation §2): ban is set so the processor's
    // Collection stage can find it, ref/attempt stay NULL until claimed.
    billrunBanId: spec.ban,
    billrunRefId: null,
    billrunAttempt: null,
    billrunChecksum: null,
    udrRefBatchId: SAMPLE_BATCH_REF,
    udrSourceFile: SAMPLE_UDR_SOURCE_FILE,
    ratingEngineVersion: SAMPLE_PROVENANCE_SENTINEL,
    ratingFlowRevision: 0,
  };
}
