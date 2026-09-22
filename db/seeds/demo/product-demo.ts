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
