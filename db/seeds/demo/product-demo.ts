import { eq } from "drizzle-orm";

import { logger } from "@/lib/logger";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
} from "@/db/schema/product";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import {
  persistablePricingComponentSchema,
  type PersistablePricingComponent,
  type Step,
} from "@/validation/product/pricing-component.schema";
import type {
  RecurringPeriodLength,
  RecurringPeriodType,
  UnitOfMeasure,
} from "@/types/product";
import type { Database } from "@/db/client";
import { db as appDb } from "@/db/client";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import { ratecardRepository } from "@/db/repositories/ratecard";
import { uploadRatecardVersion } from "@/services/product/ratecard/upload-version";
import { activateRatecardVersion } from "@/services/product/ratecard/activate-version";
import {
  RATE_CARD_FILE_HEADERS,
  RATE_CARD_HEADER_MAP,
  type RateCardTableColumn,
} from "@/validation/product/ratecard.schema";

const CURRENCY = "MYR"; // SYSTEM_CONFIG.default_currency (0005 seed)

// The demo 5G offering's display name. `ordering-demo.ts` looks the offering up
// by this exact string, so it is exported to keep the two demo seeds in lockstep
// (a rename here is a rename there).
export const DEMO_5G_OFFERING_NAME = "Demo — 5G Nationwide Service Plan";

interface SpecSeed {
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: Record<string, string>;
}

// -- Price fixtures (pm48-spec D3/D4) ---------------------------------------
//
// Each fixture carries exactly what its `component_type` branch needs — the
// discriminated shape mirrors `validation/product/price-input.schema.ts`'s own
// branches (pm47 D7): `unitOfMeasure` and the recurring pair appear only on
// the branch that allows them. `buildPriceEnvelope`/`toRowColumns` below
// derive the rest of the eight-field envelope and the row columns; every
// write still parses through `persistablePricingComponentSchema` before it
// reaches the database (Inv. #31) — seeds are held to the same Zod union and
// the same DB CHECKs as user input (code-standards §1.7).

interface PriceSeedCore {
  name: string;
  glCode: string | null;
  startDateTime: Date;
}

interface UsageRatePriceSeed extends PriceSeedCore {
  componentType: "usage_rate";
  unitOfMeasure: UnitOfMeasure;
  params: { ratePerUnit: string; rateCardLookUp: string | null };
}

interface FlatFeeRecurringPriceSeed extends PriceSeedCore {
  componentType: "flat_fee";
  priceType: "recurring";
  recurringChargePeriodLength: RecurringPeriodLength;
  recurringChargePeriodType: RecurringPeriodType;
  params: { amount: string };
}

interface FlatFeeOneTimePriceSeed extends PriceSeedCore {
  componentType: "flat_fee";
  priceType: "oneTime";
  params: { amount: string };
}

interface CapacityCommitmentPriceSeed extends PriceSeedCore {
  componentType: "capacity_commitment";
  unitOfMeasure: UnitOfMeasure;
  params: { committedQuantity: number };
}

interface CapacityMotivationPriceSeed extends PriceSeedCore {
  componentType: "capacity_motivation";
  unitOfMeasure: UnitOfMeasure;
  params: { steps: Step[] };
}

type PriceSeed =
  | UsageRatePriceSeed
  | FlatFeeRecurringPriceSeed
  | FlatFeeOneTimePriceSeed
  | CapacityCommitmentPriceSeed
  | CapacityMotivationPriceSeed;

interface OfferingSeed {
  name: string;
  specs: SpecSeed[];
  prices: PriceSeed[];
}

// Builds the full eight-field envelope from a fixture. Row-level data
// (currency, unit, period) never enters `params` (code-standards §1.25) —
// this function derives only the envelope's own fields; `toRowColumns` below
// derives the row columns from the same fixture.
function buildPriceEnvelope(seed: PriceSeed): PersistablePricingComponent {
  switch (seed.componentType) {
    case "usage_rate":
      return {
        "@type": "usage_rate",
        specVersion: 1,
        // D4's cross-field refinement (pricing-component.schema.ts): a
        // card-driven rate carries PLA_USAGE_RATE, a plain scalar carries null.
        plaSpecId:
          seed.params.rateCardLookUp !== null ? "PLA_USAGE_RATE" : null,
        priceType: "usage",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { unitOfMeasure: seed.unitOfMeasure },
        params: seed.params,
      };
    case "flat_fee":
      return {
        "@type": "flat_fee",
        specVersion: 1,
        plaSpecId: null,
        priceType: seed.priceType,
        appliesAt: "billing",
        basis: "flat",
        boundTo: null,
        params: seed.params,
      };
    case "capacity_commitment":
      return {
        "@type": "capacity_commitment",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_COMMITMENT",
        priceType: "commitment",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: seed.unitOfMeasure },
        params: seed.params,
      };
    case "capacity_motivation":
      return {
        "@type": "capacity_motivation",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_MOTIVATION",
        priceType: "discount",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: seed.unitOfMeasure },
        params: seed.params,
      };
    default: {
      const exhaustive: never = seed;
      throw new Error(
        `Unhandled price seed componentType: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// The row columns a fixture's branch allows — a `usage_rate`/capacity
// component always carries its unit and never a period; a `flat_fee` carries
// the period pair iff `recurring` and never a unit (pm46 §3.3 completeness).
function toRowColumns(seed: PriceSeed): {
  unitOfMeasure: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
} {
  switch (seed.componentType) {
    case "usage_rate":
    case "capacity_commitment":
    case "capacity_motivation":
      return {
        unitOfMeasure: seed.unitOfMeasure,
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
      };
    case "flat_fee":
      return seed.priceType === "recurring"
        ? {
            unitOfMeasure: null,
            recurringChargePeriodLength: seed.recurringChargePeriodLength,
            recurringChargePeriodType: seed.recurringChargePeriodType,
          }
        : {
            unitOfMeasure: null,
            recurringChargePeriodLength: null,
            recurringChargePeriodType: null,
          };
    default: {
      const exhaustive: never = seed;
      throw new Error(
        `Unhandled price seed componentType: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// Demo catalog — human-readable "example data" rows (D1). Formerly the demo
// fixtures carried inline in `db/seeds/product.ts`; moved here so the mandatory
// `db:setup` chain seeds zero demo rows and this catalog is loaded only by the
// opt-in `db:seed-demo`.
const OFFERING_SEEDS: OfferingSeed[] = [
  {
    name: DEMO_5G_OFFERING_NAME,
    specs: [
      {
        name: "Demo — Network Slice eMBB",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { SST_ID: "01", SD_ID: "A0C4E2" },
      },
      {
        name: "Demo — QoS Profile",
        isMandatory: false,
        isDefault: false,
        defaultValue: "standard",
        characteristics: { "5QI": "9", ARP: "8" },
      },
    ],
    prices: [
      {
        name: "Demo — Monthly Recurring Charge",
        componentType: "flat_fee",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { amount: "5000.00" },
      },
      {
        // Future-dated successor of the same lane — pm03's derived-
        // effectivity fixture (pm02-spec §3.7), kept: it now also proves
        // per-(component_type, unit) succession (pm48-spec D3).
        name: "Demo — Monthly Recurring Charge (2027)",
        componentType: "flat_fee",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        glCode: "GL-4100",
        startDateTime: new Date("2027-01-01T00:00:00Z"),
        params: { amount: "5500.00" },
      },
      {
        // startDateTime deliberately offset from the recurring charge above
        // (empirically forced, not in the D3 table's literal wording): pm46's
        // rekeyed uniqueness constraint is `NULLS NOT DISTINCT` on
        // (offering, component_type, unit_of_measure, start_date_time), and
        // BOTH flat_fee variants share `unit_of_measure = NULL` — the old
        // price_type ('recurring' vs 'once') is no longer part of the key, so
        // two flat_fee rows on the same offering at the same start_date_time
        // collide regardless of their envelope priceType (G-F; the same
        // rejection pm46's own constraint suite asserts). One calendar day
        // apart keeps both rows and both demo behaviours intact.
        name: "Demo — Activation Fee",
        componentType: "flat_fee",
        priceType: "oneTime",
        glCode: null,
        startDateTime: new Date("2026-01-02T00:00:00Z"),
        params: { amount: "1000.00" },
      },
      {
        // Re-keyed from `usage` `tiered` (3 tiers) to `usage_rate` (pm48-spec
        // D3): the graduated shape is gone with `tiered` (PC8) and is
        // deliberately NOT reconstructed as a `capacity_motivation` here —
        // that would silently invent a discount policy. The demo's own
        // capacity story is the new "Demo — Enterprise Capacity Plan" offering
        // below. This collapse drops the old middle/top tier rates (0.04 above
        // 1,000 GB, 0.03 above 10,000 GB); only the first tier's rate survives
        // as the flat usage_rate.
        name: "Demo — Data Overage",
        componentType: "usage_rate",
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { ratePerUnit: "0.05", rateCardLookUp: null },
      },
    ],
  },
  {
    name: "Demo — Enterprise IoT Access",
    specs: [
      {
        name: "Demo — Network Slice mMTC",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { SST_ID: "03", SD_ID: "B1D2E3" },
      },
    ],
    prices: [
      {
        name: "Demo — Monthly Recurring Charge",
        componentType: "flat_fee",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { amount: "1200.00" },
      },
      {
        name: "Demo — Data Usage",
        componentType: "usage_rate",
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { ratePerUnit: "0.02", rateCardLookUp: null },
      },
    ],
  },
  {
    // pm48-spec D4 — the worked capacity-plan scenario, seeded: one offering
    // carrying all four component types on one version, everything the later
    // authoring/rendering/sweep units (pm51-56) need to demonstrate against.
    name: "Demo — Enterprise Capacity Plan",
    specs: [
      {
        name: "Demo — Capacity Plan Profile",
        isMandatory: true,
        isDefault: true,
        defaultValue: null,
        characteristics: { PLAN_TIER: "ENTERPRISE" },
      },
    ],
    prices: [
      {
        // Non-null rateCardLookUp is deliberate (D4): it exercises the
        // conditional plaSpecId and gives the absent-rate-card warning
        // something to attach to, while resolving to nothing (no rate-card
        // table exists yet, Inv. #42).
        name: "Demo — Enterprise Base Usage Rate",
        componentType: "usage_rate",
        unitOfMeasure: "EA",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { ratePerUnit: "100", rateCardLookUp: "ENTERPRISE_EA_CARD" },
      },
      {
        name: "Demo — Enterprise Capacity Commitment",
        componentType: "capacity_commitment",
        unitOfMeasure: "EA",
        glCode: null,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { committedQuantity: 1000 },
      },
      {
        name: "Demo — Enterprise Capacity Motivation",
        componentType: "capacity_motivation",
        unitOfMeasure: "EA",
        glCode: null,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: {
          steps: [
            { aboveQuantity: 1000, ratePerUnit: "50" },
            { aboveQuantity: 2000, ratePerUnit: "25" },
          ],
        },
      },
      {
        name: "Demo — Enterprise Platform Fee",
        componentType: "flat_fee",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        params: { amount: "2000.00" },
      },
    ],
  },
];

// Seeds the demo product catalog into the caller's transaction (the
// `db:seed-demo` orchestrator owns the connection + transaction, accounts-seed
// precedent). Idempotent: skips wholesale if the demo 5G offering already
// exists — every demo offering is inserted in one transaction, so it is never
// half-present. Every JSONB/price payload is parsed through the validation
// schemas before insert (code-standards §1.7) — a bad payload throws and
// nothing lands.
export async function seedProductDemo(tx: Database): Promise<void> {
  const [existing] = await tx
    .select({ productOfferingId: productOffering.productOfferingId })
    .from(productOffering)
    .where(eq(productOffering.name, DEMO_5G_OFFERING_NAME))
    .limit(1);
  if (existing) {
    logger.info("db:seed-demo: product demo catalog already seeded, skipping.");
    return;
  }

  for (const offeringSeed of OFFERING_SEEDS) {
    // Inserted DRAFT, priced and specced below, then flipped to ACTIVE:
    // pm36's DRAFT-guard trigger (0040) refuses a specification or price write
    // once the parent offering leaves DRAFT, so the offering must be authored
    // while DRAFT and activated only after its children exist (pm36-spec I6 —
    // the same insert-then-activate pattern pm35 gave the sample seed, and the
    // pm35 D6-way this unit's D4 capacity offering also follows).
    const [insertedOffering] = await tx
      .insert(productOffering)
      .values({
        name: offeringSeed.name,
        isBundle: false,
        isSellable: true,
        billingOnly: false,
        lifecycleStatus: "DRAFT",
        version: 1,
        lastEditedBy: null,
      })
      .returning({
        productOfferingId: productOffering.productOfferingId,
      });

    if (!insertedOffering) {
      throw new Error(
        `Offering '${offeringSeed.name}' was not inserted as expected.`,
      );
    }
    const offeringId = insertedOffering.productOfferingId;

    for (const specSeed of offeringSeed.specs) {
      const characteristics = productSpecCharacteristicsSchema.parse(
        specSeed.characteristics,
      );
      await tx.insert(productSpecifications).values({
        refProductOfferingId: offeringId,
        name: specSeed.name,
        isMandatory: specSeed.isMandatory,
        isDefault: specSeed.isDefault,
        defaultValue: specSeed.defaultValue,
        productSpecCharacteristics: characteristics,
      });
    }

    for (const priceSeed of offeringSeed.prices) {
      const parsed = persistablePricingComponentSchema.parse(
        buildPriceEnvelope(priceSeed),
      );
      const {
        unitOfMeasure,
        recurringChargePeriodLength,
        recurringChargePeriodType,
      } = toRowColumns(priceSeed);
      await tx.insert(productOfferingPrice).values({
        productOfferingId: offeringId,
        name: priceSeed.name,
        componentType: parsed["@type"],
        priceComponent: parsed,
        currency: CURRENCY,
        unitOfMeasure,
        recurringChargePeriodLength,
        recurringChargePeriodType,
        glCode: priceSeed.glCode,
        policy: null,
        startDateTime: priceSeed.startDateTime,
      });
    }

    // Now that every specification and price row exists, release the offering
    // to ACTIVE (pm36 trigger — see the DRAFT insert above).
    await tx
      .update(productOffering)
      .set({ lifecycleStatus: "ACTIVE" })
      .where(eq(productOffering.productOfferingId, offeringId));
  }

  logger.info("db:seed-demo: product demo catalog seeded.");
}

// ---------------------------------------------------------------------------
// pm67 — the Phase 1 seed of the ONE tracked rate card (`RAN_USAGE`).
//
// This seeds ONE `ACTIVE` and one `SUPERSEDED` version of the single seeded
// card (D-A5), created **through the real upload + activate services** (D2) —
// pm61's `uploadRatecardVersion` and pm63's `activateRatecardVersion`, called
// as SERVICES (no `requirePermission`: a seed runs with full DB access, not a
// user session). A seed that hand-wrote `status = 'ACTIVE'` would pass every
// test here and prove nothing about the system it seeds. Every write is parsed
// through the SAME Zod as a user upload (Inv. #4, D1), so a malformed fixture
// fails at Zod before any insert; the card guards, the one-ACTIVE-per-card
// index and the four audit events are all exercised by the seed itself.
//
// It stands up data, not a consumer (§3.7): nothing reads the table.
// ---------------------------------------------------------------------------

// The single tracked card (D-A5). There is no surface to create a second card.
export const RAN_USAGE_CARD_NAME = "RAN_USAGE";

// The get-or-created principal whose id stamps `uploaded_by` / `activated_by`
// on every version and every audit row (plan v2:269 resolved here). A real,
// already-seeded appuser rather than NULL (D2) — self-provisioned via the
// shared seed helper (the `ordering-demo` / sample precedent) so
// `db:migrate && db:seed-demo` works on a GENUINELY EMPTY database (I3.1): the
// break-glass admin from `db:seed` is not created by `migrate`, so this seed
// names and ensures its own operator rather than looking one up that may not
// exist.
export const RATE_CARD_DEMO_OPERATOR = {
  userName: "Demo — Rate Card Operator",
  userEmail: "demo-ratecard-operator@example.invalid",
} as const;

// A demo upload row keyed by TABLE COLUMN (the values of pm58's
// RATE_CARD_HEADER_MAP). Every field is a string exactly as a CSV cell is; an
// empty optional cell is "" and stays "" through the row schema (→ NULL at the
// service, never `0` — Inv. #51).
export type DemoRateCardRow = Record<RateCardTableColumn, string>;

function demoRow(
  mnoPublicKey: string,
  commercialUnitPublicKey: string,
  polygonId: string,
  polygonStartDate: string,
  polygonEndDate: string,
  state: string,
  district: string,
  lkpSubscriberRefId: string,
  serviceCode: string,
  ratePerUnit: string,
): DemoRateCardRow {
  return {
    mno_public_key: mnoPublicKey,
    commercial_unit_public_key: commercialUnitPublicKey,
    polygon_id: polygonId,
    polygon_start_date: polygonStartDate,
    polygon_end_date: polygonEndDate,
    state,
    district,
    lkp_subscriber_ref_id: lkpSubscriberRefId,
    service_code: serviceCode,
    rate_per_unit: ratePerUnit,
  };
}

// Small and honest about being small (D4) — seven rows covering the interesting
// shapes, NOT 5,400 (volume is proved by pm60/pm61's live-DB tests, not here).
// Row key is (mno_public_key, commercial_unit_public_key, polygon_id) (RV2);
// `lkp_subscriber_ref_id` values are `PRDINV`+8-digit shaped but carry no
// referential meaning (D-A1).
export const RAN_USAGE_V1_ROWS: DemoRateCardRow[] = [
  // A plain mapping — the ordinary case: no validity/geo, no service code, no
  // rate. Empty optional cells stay empty (→ NULL, never 0).
  demoRow(
    "MNO-1",
    "CU-1001",
    "POLY-0001",
    "2026-01-01",
    "",
    "",
    "",
    "PRDINV00000001",
    "",
    "",
  ),
  // The descriptive columns populated (polygon_end_date / state / district)
  // AND a service code AND a rate — the fully-described shape (D-A9/D-A10).
  demoRow(
    "MNO-1",
    "CU-1001",
    "POLY-0002",
    "2026-01-01",
    "2026-12-31",
    "State-1",
    "District-A",
    "PRDINV00000002",
    "SVC-DATA",
    "0.050000",
  ),
  // The empty-descriptive counterpart: same validity start, geo/end left empty
  // — empty-cell hygiene alongside the populated row above.
  demoRow(
    "MNO-1",
    "CU-1002",
    "POLY-0003",
    "2026-02-01",
    "",
    "",
    "",
    "PRDINV00000003",
    "",
    "",
  ),
  // service_code pair (A): a row carrying a service code ...
  demoRow(
    "MNO-2",
    "CU-2001",
    "POLY-0101",
    "2026-03-01",
    "",
    "",
    "",
    "PRDINV00000010",
    "SVC-VOICE",
    "",
  ),
  // ... and (B) one identical in EVERY non-key column but with `service_code`
  // empty — proof that service_code is a plain, optional column and not part of
  // the row key (D-A6). Only the mandatory key component (polygon_id) differs.
  demoRow(
    "MNO-2",
    "CU-2001",
    "POLY-0102",
    "2026-03-01",
    "",
    "",
    "",
    "PRDINV00000010",
    "",
    "",
  ),
  // rate_per_unit populated on an otherwise empty-descriptive row (a plain
  // nullable column, D-A2) — empty vs populated proves empty-cell-≠-zero.
  demoRow(
    "MNO-3",
    "CU-3001",
    "POLY-0201",
    "2026-04-01",
    "",
    "",
    "",
    "PRDINV00000020",
    "",
    "1.250000",
  ),
  // A fully-populated row REMOVED in v2 (the one removed key of D6): present in
  // the SUPERSEDED version, absent from the ACTIVE one, never carried forward
  // (D-A7).
  demoRow(
    "MNO-3",
    "CU-3001",
    "POLY-0202",
    "2026-05-01",
    "2027-06-30",
    "State-2",
    "District-B",
    "PRDINV00000021",
    "SVC-DATA",
    "2.000000",
  ),
];

// The one key removed between v1 and v2 (D6). Named explicitly so the diff's
// `removed = 1` is checkable by eye and the removal is unambiguous.
export const RAN_USAGE_REMOVED_KEY = {
  mno_public_key: "MNO-3",
  commercial_unit_public_key: "CU-3001",
  polygon_id: "POLY-0202",
} as const;

// v2 is v1 with EXACTLY ONE key removed and nothing else changed, so the diff
// against the outgoing ACTIVE reports removed = 1, added = 0, changed = 0. The
// newer version's stored row count equals its file's `row_count` — the removed
// key adds nothing to it (D6 / RV3).
export const RAN_USAGE_V2_ROWS: DemoRateCardRow[] = RAN_USAGE_V1_ROWS.filter(
  (row) =>
    !(
      row.mno_public_key === RAN_USAGE_REMOVED_KEY.mno_public_key &&
      row.commercial_unit_public_key ===
        RAN_USAGE_REMOVED_KEY.commercial_unit_public_key &&
      row.polygon_id === RAN_USAGE_REMOVED_KEY.polygon_id
    ),
);

// RFC-4180 minimal quoting. None of the demo cells need it today (no comma,
// quote or newline in any value), but quote defensively so a future edit that
// introduces one cannot silently misalign a row — which the parser would then
// reject outright (`relax_column_count` is off by design, pm59).
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Builds the upload CSV bytes for a set of demo rows. The header line is built
// from pm58's `RATE_CARD_FILE_HEADERS` / `RATE_CARD_HEADER_MAP`, IMPORTED — the
// ten header strings are never re-typed here (I2, §2.24). Each column's cell is
// read by mapping the file header back to its table column, so header order and
// header↔column mapping have exactly one source of truth.
export function buildRateCardDemoCsv(rows: DemoRateCardRow[]): Buffer {
  const headerLine = RATE_CARD_FILE_HEADERS.map(csvCell).join(",");
  const dataLines = rows.map((row) =>
    RATE_CARD_FILE_HEADERS.map((header) =>
      csvCell(row[RATE_CARD_HEADER_MAP[header]]),
    ).join(","),
  );
  return Buffer.from([headerLine, ...dataLines].join("\n") + "\n", "utf8");
}

// Upload a version through pm61's service, then activate it through pm63's —
// the real path (D2). A refusal at either step is a bug in the FIXTURE (a seed
// is held to the same Zod + guards as user input, D1), surfaced loudly rather
// than swallowed. Returns the new version's id.
async function uploadAndActivateDemoVersion(
  rows: DemoRateCardRow[],
  sourceFile: string,
  actorId: string,
  uploadedAt: Date,
): Promise<string> {
  const uploaded = await uploadRatecardVersion({
    cardName: RAN_USAGE_CARD_NAME,
    bytes: buildRateCardDemoCsv(rows),
    sourceFile,
    uploadedBy: actorId,
    uploadedAt,
  });
  if (!uploaded.ok) {
    throw new Error(
      `db:seed-demo: rate-card upload of ${sourceFile} was refused (${uploaded.code}).`,
    );
  }

  const activated = await activateRatecardVersion(uploaded.versionId, actorId);
  if (!activated.ok) {
    throw new Error(
      `db:seed-demo: activation of ${uploaded.versionId} was refused (${activated.code}).`,
    );
  }

  return uploaded.versionId;
}

// Seeds ONE `ACTIVE` + one `SUPERSEDED` version of `RAN_USAGE` through the real
// upload + activate path (D2), for the rows of D4, with exactly one key removed
// between the two (D6).
//
// Runs on the application `@/db/client` pool, NOT the caller's transaction: the
// upload/activate services open their OWN transactions on that pool, and the
// `appuser` they FK-reference must be COMMITTED before they run — a different
// connection cannot see an uncommitted outer transaction. `seed-demo.ts` calls
// this AFTER the product/ordering transaction has committed. Idempotent: skips
// wholesale if `RAN_USAGE` already has any version (mirrors the catalog seed's
// existence check).
export async function seedRateCardDemo(): Promise<void> {
  const existing = await ratecardRepository.listVersions(
    appDb,
    RAN_USAGE_CARD_NAME,
  );
  if (existing.length > 0) {
    logger.info(
      "db:seed-demo: rate-card demo (RAN_USAGE) already seeded, skipping.",
    );
    return;
  }

  const actorId = await getOrCreateAppUser(
    appDb,
    RATE_CARD_DEMO_OPERATOR.userName,
    RATE_CARD_DEMO_OPERATOR.userEmail,
  );

  // The REAL clock (D6), captured ONCE so both versions record the same
  // seed-run `snapshot_date` in the app timezone (D-A8). Deliberately NOT
  // pm61's fixed-instant test parameter (pm61 D4): backdating v1 would show a
  // history that never happened and put a clock override into non-test code.
  const uploadedAt = new Date();

  const supersededVersionId = await uploadAndActivateDemoVersion(
    RAN_USAGE_V1_ROWS,
    "demo-ran-usage-v1.csv",
    actorId,
    uploadedAt,
  );
  const activeVersionId = await uploadAndActivateDemoVersion(
    RAN_USAGE_V2_ROWS,
    "demo-ran-usage-v2.csv",
    actorId,
    uploadedAt,
  );

  logger.info(
    `db:seed-demo: rate-card demo seeded — RAN_USAGE ${supersededVersionId} (SUPERSEDED) → ${activeVersionId} (ACTIVE).`,
  );
}
