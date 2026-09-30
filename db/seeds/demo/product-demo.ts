import { and, eq, ne } from "drizzle-orm";

import { logger } from "@/lib/logger";
import { buildCsv } from "@/lib/csv";
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
import { appuser } from "@/db/schema/identity";
import { loadBootstrapAdminConfig } from "@/db/seeds/seed-admin.config";
import { ratecardRepository } from "@/db/repositories/ratecard";
import { uploadRatecardVersion } from "@/services/product/ratecard/upload-version";
import { activateRatecardVersion } from "@/services/product/ratecard/activate-version";
import {
  RATE_CARD_FILE_HEADERS,
  RATE_CARD_HEADER_MAP,
  RATE_CARD_TABLE_COLUMNS,
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

// A demo upload row keyed by TABLE COLUMN (the values of pm58's
// RATE_CARD_HEADER_MAP). Every field is a string exactly as a CSV cell is; an
// empty optional cell is "" and stays "" through the row schema (→ NULL at the
// service, never `0` — Inv. #51).
export type DemoRateCardRow = Record<RateCardTableColumn, string>;

// A demo row is authored as ONE `|`-delimited cell string in D0 column order
// (`RATE_CARD_TABLE_COLUMNS` — the same order the upload CSV uses); an empty
// cell is an empty field ("" → NULL at the service, never `0`). Kept dense on
// purpose — one line per row, so the fixture reads like the CSV it becomes and
// carries no repeated per-field boilerplate (this is also why SonarQube no
// longer sees seven identical multi-line call blocks). `demoRow` splits and
// maps to the typed record; a miscounted row fails LOUDLY at module load via
// the length check, and the integration test pins each column's value. No demo
// value contains a "|".
const DEMO_CELL_DELIMITER = "|";

function demoRow(cells: string): DemoRateCardRow {
  const parts = cells.split(DEMO_CELL_DELIMITER);
  if (parts.length !== RATE_CARD_TABLE_COLUMNS.length) {
    throw new Error(
      `demoRow: "${cells}" has ${parts.length} cells, expected ${RATE_CARD_TABLE_COLUMNS.length} (D0 order).`,
    );
  }
  const [
    mno = "",
    cu = "",
    poly = "",
    start = "",
    end = "",
    state = "",
    district = "",
    sub = "",
    svc = "",
    rate = "",
  ] = parts;
  return {
    mno_public_key: mno,
    commercial_unit_public_key: cu,
    polygon_id: poly,
    polygon_start_date: start,
    polygon_end_date: end,
    state,
    district,
    lkp_subscriber_ref_id: sub,
    service_code: svc,
    rate_per_unit: rate,
  };
}

// Small and honest about being small (D4) — seven rows covering the interesting
// shapes, NOT 5,400 (volume is proved by pm60/pm61's live-DB tests, not here).
// Row key is (mno_public_key, commercial_unit_public_key, polygon_id) (RV2);
// `lkp_subscriber_ref_id` values are `PRDINV`+8-digit shaped but carry no
// referential meaning (D-A1). Column order per row string:
//   MNO Name | Commercial Unit ID | Polygon ID | Polygon Start Date |
//   Polygon End Date | State | District | Subscriber Reference ID |
//   Service Code | Rate per Unit
export const RAN_USAGE_V1_ROWS: DemoRateCardRow[] = [
  "MNO-1|CU-1001|POLY-0001|2026-01-01||||PRDINV00000001||", // plain mapping — all optionals empty (empty ≠ 0)
  "MNO-1|CU-1001|POLY-0002|2026-01-01|2026-12-31|State-1|District-A|PRDINV00000002|SVC-DATA|0.050000", // fully described (D-A9/D-A10)
  "MNO-1|CU-1002|POLY-0003|2026-02-01||||PRDINV00000003||", // empty-descriptive counterpart (empty-cell hygiene)
  "MNO-2|CU-2001|POLY-0101|2026-03-01||||PRDINV00000010|SVC-VOICE|", // service_code pair A — code set
  "MNO-2|CU-2001|POLY-0102|2026-03-01||||PRDINV00000010||", // service_code pair B — else identical, code empty (D-A6)
  "MNO-3|CU-3001|POLY-0201|2026-04-01||||PRDINV00000020||1.250000", // rate_per_unit populated, else empty (D-A2)
  "MNO-3|CU-3001|POLY-0202|2026-05-01|2027-06-30|State-2|District-B|PRDINV00000021|SVC-DATA|2.000000", // REMOVED in v2 (D6)
].map(demoRow);

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

// Builds the upload CSV bytes for a set of demo rows. Field escaping and
// assembly go through the shared `lib/csv.ts` (`buildCsv` → `csvField`, RFC-4180
// + formula-injection hardening) so the seed's wire format is identical to every
// other CSV the app emits and the escaping rule lives in exactly one place —
// rather than a second private quoter. The header is built from pm58's
// `RATE_CARD_FILE_HEADERS` / `RATE_CARD_HEADER_MAP`, IMPORTED (I2, §2.24): each
// column's cell is read by mapping the file header back to its table column, so
// header order and header↔column mapping have one source of truth. `buildCsv`
// emits RFC-4180 CRLF line endings, which the pinned parser (pm59) accepts.
export function buildRateCardDemoCsv(rows: DemoRateCardRow[]): Buffer {
  const dataRows = rows.map((row) =>
    RATE_CARD_FILE_HEADERS.map((header) => row[RATE_CARD_HEADER_MAP[header]]),
  );
  return Buffer.from(buildCsv(RATE_CARD_FILE_HEADERS, dataRows), "utf8");
}

// Upload a version through pm61's service, then activate it through pm63's —
// the real path (D2). A refusal at either step is a bug in the FIXTURE (a seed
// is held to the same Zod + guards as user input, D1), surfaced loudly rather
// than swallowed. Returns the new version's id.
async function uploadAndActivateDemoVersion(
  rows: DemoRateCardRow[],
  sourceFile: string,
  actorId: string,
): Promise<string> {
  const uploaded = await uploadRatecardVersion({
    cardName: RAN_USAGE_CARD_NAME,
    bytes: buildRateCardDemoCsv(rows),
    sourceFile,
    uploadedBy: actorId,
    // The REAL clock at the moment of THIS upload (D6): each version reads its
    // own instant, so `uploaded_at` differs between v1 and v2 and genuinely
    // "tells them apart" (D6) — v2 is uploaded after v1's full upload+activate
    // round-trip, so v2.uploaded_at is strictly later, and the version list's
    // "newest first" order holds by real time, not just the id tiebreak. NOT
    // pm61's fixed-instant test parameter (pm61 D4): backdating would show a
    // history that never happened and put a clock override into non-test code.
    // pm61 derives `snapshot_date` from this same instant, so both versions
    // still show the one seed-run calendar date (D-A8) in a single run.
    uploadedAt: new Date(),
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
// this AFTER the product/ordering transaction has committed. Requires the
// system/ADMIN user (`db:seed`) to exist — it is stamped as the actor (D2, see
// below) and refused loudly if absent. Idempotent: it only treats the exact
// complete demo shape (1 ACTIVE + 1 SUPERSEDED) as "already seeded"; any other
// pre-existing state is left untouched and reported (see the guard below).
export async function seedRateCardDemo(): Promise<void> {
  const existing = await ratecardRepository.listVersions(
    appDb,
    RAN_USAGE_CARD_NAME,
  );
  if (existing.length > 0) {
    // Distinguish the COMPLETED demo dataset — exactly one ACTIVE + one
    // SUPERSEDED version, the shape this seed produces — from any other
    // pre-existing state: a partial/failed prior run, or versions a real user
    // created through the UI. Only the complete-and-matching case is a genuine
    // "already seeded" skip. Anything else is left UNTOUCHED (this seed never
    // deletes a version, so unrelated user data is preserved) and reported
    // WITHOUT claiming success, so a half-seeded card is never silently
    // mistaken for a finished one. We do not auto-resume a partial state: a
    // stray DRAFT would need the replace-on-reupload path and a human's
    // judgement, so the safe minimum is to surface it loudly.
    const activeCount = existing.filter((v) => v.status === "ACTIVE").length;
    const supersededCount = existing.filter(
      (v) => v.status === "SUPERSEDED",
    ).length;
    const isCompleteDemo =
      existing.length === 2 && activeCount === 1 && supersededCount === 1;
    if (isCompleteDemo) {
      logger.info(
        "db:seed-demo: rate-card demo (RAN_USAGE) already seeded, skipping.",
      );
    } else {
      logger.warn(
        `db:seed-demo: RAN_USAGE already has ${existing.length} version(s) ` +
          `(${activeCount} ACTIVE, ${supersededCount} SUPERSEDED) — not the ` +
          `expected demo shape (1 ACTIVE + 1 SUPERSEDED). Leaving them ` +
          `untouched and NOT seeding the demo card; resolve manually if this ` +
          `is a partial seed run.`,
      );
    }
    return;
  }

  // Attribution (D2): stamp `uploaded_by` / `activated_by` with the EXISTING
  // system/ADMIN break-glass user — `System Administrator`, created by `db:seed`
  // (seed-admin.ts) at BOOTSTRAP_ADMIN_EMAIL — not an invented operator, so the
  // version provenance and audit trail name the real principal `db/seeds/`
  // provisions before the demo runs ("do not invent an id"). `db:seed` is
  // therefore a prerequisite of `db:seed-demo`; provisioning that admin on an
  // empty database is a SEPARATE concern (the standard `db:setup` chain seeds it
  // before any demo; the integration test provisions it in its own setup), not
  // this seed's job. If it is absent we refuse loudly rather than inventing a
  // stand-in.
  const { BOOTSTRAP_ADMIN_EMAIL } = loadBootstrapAdminConfig();
  const [admin] = await appDb
    .select({ id: appuser.id })
    .from(appuser)
    .where(
      and(
        eq(appuser.userEmail, BOOTSTRAP_ADMIN_EMAIL),
        ne(appuser.status, "DELETED"),
      ),
    )
    .limit(1);
  if (!admin) {
    throw new Error(
      "db:seed-demo: the system/ADMIN user was not found — run `db:seed` (bootstrap admin) before `db:seed-demo`.",
    );
  }
  const actorId = admin.id;

  // v1 is uploaded+activated first, then v2 (which supersedes it). Each reads
  // its own real-clock instant inside uploadAndActivateDemoVersion (D6) — see
  // the note there — so uploaded_at differs between the two and orders them by
  // real time, while both keep the one seed-run snapshot_date.
  const supersededVersionId = await uploadAndActivateDemoVersion(
    RAN_USAGE_V1_ROWS,
    "demo-ran-usage-v1.csv",
    actorId,
  );
  const activeVersionId = await uploadAndActivateDemoVersion(
    RAN_USAGE_V2_ROWS,
    "demo-ran-usage-v2.csv",
    actorId,
  );

  logger.info(
    `db:seed-demo: rate-card demo seeded — RAN_USAGE ${supersededVersionId} (SUPERSEDED) → ${activeVersionId} (ACTIVE).`,
  );
}
