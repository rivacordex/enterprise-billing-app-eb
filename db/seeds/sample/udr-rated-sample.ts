import { sql, type SQL } from "drizzle-orm";

import { udrRateDetailSchema } from "@/validation/rating/udr-rate-detail.schema";
import { toScaled } from "@/validation/rating/decimal-string";
import type { UdrRatedInsert } from "@/db/schema/rating/udr-rated";
import {
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_RATECARD_STATE,
} from "@/db/seeds/sample/sample-5g-fixture";

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
  // bm26-spec §Implementation §1 — usage is the only thing udr_rated carries
  // into billing now (Inv #1). Recurring is billing compute (bm29), derived
  // from inventory.product_inventory, never rated — so this defaults to
  // 'RAN_USAGE' and SUBSCRIPTION_RECURRING is retired from the factory.
  udrType?: string;
  sequence: number; // disambiguates udr_key across rows for the same account/period
  // bm42-spec §Implementation §7 — the capacity profile's PER_UNIT shape (the
  // factory extension): a capacity volume row must be rated PER_UNIT, not
  // FLAT, so G2 (CAPACITY_RATE_MISMATCH) passes. Every field below defaults to
  // today's FLAT shape untouched — only a caller passing `rateType: "PER_UNIT"`
  // takes this branch.
  usageQuantity?: number; // EA (or usageUnit) metered on this row; default 1
  usageRate?: string; // per-unit rate (money string), required with PER_UNIT
  rateType?: "FLAT" | "PER_UNIT";
  usageUnit?: string; // default "EA"
  // bm45-spec §Implementation §4 (D2) — when present, `udr_key` is built as
  // the CANONICAL cell `commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>`
  // (lower+trim, sorted key names) instead of the generic JSON shape — the
  // format the invoice-appendix join reconstructs from the ratecard columns
  // and matches against this exact string. Capacity-profile PER_UNIT rows
  // always supply this; every other caller (FLAT `ci`/`volume` rows) omits it
  // and keeps the untouched JSON `udr_key`.
  polygonCell?: {
    mnoPublicKey: string;
    commercialUnitPublicKey: string;
    polygonId: string;
  };
  // bm48-spec §Implementation §5 — the geo labels rating freezes onto a RAN row
  // from its matched card cell. Default NULL: a row rated before bm48, or one
  // whose cell is not on any card.
  state?: string | null;
  district?: string | null;
}

// bm48-spec §Implementation §5 — the Sample-5G card's own labels (state + the
// three cell districts), so seeded RAN rows carry the same geo real rating
// would have stamped from that card. Lives here, not in seed-billrun-sample.ts,
// because the pm67 seed-boundary guardrail forbids that file from naming the
// card module.
export const SAMPLE_RAN_GEO_LABELS: readonly {
  state: string;
  district: string | null;
}[] = SAMPLE_5G_LKP_ROWS.map((row) => ({
  state: SAMPLE_5G_RATECARD_STATE,
  district: row.district,
}));

// A row shaped exactly like `UdrRatedInsert` except `partitionPeriod`, which
// is computed by calling rating's own `IMMUTABLE rating.period_of()` helper
// (bm15-spec §Implementation §2) rather than re-derived in JS — the table's
// own CHECK re-derives it the same way, so the two can never drift.
export type SampleUdrRatedRow = Omit<UdrRatedInsert, "partitionPeriod"> & {
  partitionPeriod: SQL;
};

// Sorted-key, fixed-format `udr_key`. Two shapes:
//  - the CANONICAL RAN_USAGE cell (`spec.polygonCell` present) — sorted key
//    names `commercial_unit|mno_public_id|polygon_id`, values
//    `lower(trim(...))`, `|`-joined — exactly the string the aggregation
//    flow's D2 join reconstructs from the ratecard columns and matches
//    against (bm45-spec §Implementation §4).
//  - the pre-bm45 generic shape (rm01-spec D5 precedent: half the table's
//    natural key) for every other caller — JSON.stringify on an object
//    literal with keys already declared in alphabetical order is
//    deterministic across engines, no external sort routine needed.
function buildUdrKey(spec: SampleChargeSpec): string {
  if (spec.polygonCell) {
    const normalise = (value: string) => value.trim().toLowerCase();
    return (
      `commercial_unit=${normalise(spec.polygonCell.commercialUnitPublicKey)}` +
      `|mno_public_id=${normalise(spec.polygonCell.mnoPublicKey)}` +
      `|polygon_id=${normalise(spec.polygonCell.polygonId)}`
    );
  }
  return JSON.stringify({
    ban: spec.ban,
    priceRef: spec.priceRef,
    seq: spec.sequence,
    startIso: spec.startDatetime.toISOString(),
  });
}

// Exact bigint-scaled amountRaw = ratePerUnit × quantity (never float —
// mirrors validation/rating/decimal-string.ts's own superRefine check so a
// PER_UNIT row is guaranteed to pass udrRateDetailSchema).
function computePerUnitAmountRaw(ratePerUnit: string, quantity: string): string {
  const scaledAmount = (toScaled(ratePerUnit) * toScaled(quantity)) / 1_000_000n;
  const sign = scaledAmount < 0n ? "-" : "";
  const abs = scaledAmount < 0n ? -scaledAmount : scaledAmount;
  const digits = abs.toString().padStart(7, "0");
  return `${sign}${digits.slice(0, -6)}.${digits.slice(-6)}`;
}

export function buildSampleUdrRatedRow(
  spec: SampleChargeSpec,
): SampleUdrRatedRow {
  const rateType = spec.rateType ?? "FLAT";
  const usageUnit = spec.usageUnit ?? "EA";
  const usageQuantity = spec.usageQuantity ?? 1;
  const usageQuantityStr = usageQuantity.toFixed(6);

  if (rateType === "PER_UNIT" && spec.usageRate === undefined) {
    throw new Error(
      "buildSampleUdrRatedRow: rateType 'PER_UNIT' requires usageRate.",
    );
  }
  const rateDetail =
    rateType === "PER_UNIT" && spec.usageRate !== undefined
      ? udrRateDetailSchema.parse({
          rateType: "PER_UNIT",
          ratePerUnit: spec.usageRate,
          quantity: usageQuantityStr,
          amountRaw: computePerUnitAmountRaw(spec.usageRate, usageQuantityStr),
        })
      : udrRateDetailSchema.parse({ rateType: "FLAT" });

  return {
    partitionPeriod: sql`rating.period_of(${spec.startDatetime.toISOString()}::timestamptz)`,
    udrType: spec.udrType ?? "RAN_USAGE",
    startDatetime: spec.startDatetime,
    endDatetime: spec.endDatetime,
    status: spec.status ?? "RATED",
    udrSubscriptionRefId: spec.subscriberRefId,
    udrKey: buildUdrKey(spec),
    udrUsageQuantity: usageQuantityStr,
    udrUsageUnit: usageUnit,
    udrRateType: rateType,
    udrRateDetail: rateDetail,
    udrRatedPrice: spec.ratedPrice,
    udrRatedPriceRaw: spec.ratedPrice,
    udrRoundingMode: "HALF_UP",
    udrCurrency: spec.currency,
    udrPriceRef: spec.priceRef,
    udrUsageRate: rateType === "PER_UNIT" ? spec.usageRate ?? null : null,
    // Fully unclaimed & unattributed (bm26-spec §Implementation §1) — all FOUR
    // billrun_* columns NULL, byte-for-byte the shape rl.py's build_chunk_rows
    // leaves (it writes none of them; they default NULL). billrun_ban_id was
    // the account id under bm15; NULLing it is the single change that unblocks
    // bm27 Collection — a row Collection can resolve is one that does not
    // already carry its account. Collection re-derives the account by joining
    // udr_subscription_ref_id → inventory.product_inventory → billing_account_id.
    billrunBanId: null,
    billrunRefId: null,
    billrunAttempt: null,
    billrunChecksum: null,
    udrRefBatchId: SAMPLE_BATCH_REF,
    udrSourceFile: SAMPLE_UDR_SOURCE_FILE,
    ratingEngineVersion: SAMPLE_PROVENANCE_SENTINEL,
    ratingFlowRevision: 0,
    state: spec.state ?? null,
    district: spec.district ?? null,
  };
}
