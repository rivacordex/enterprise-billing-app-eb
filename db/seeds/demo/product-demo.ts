import { eq } from "drizzle-orm";

import { logger } from "@/lib/logger";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
} from "@/db/schema/product";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";
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

interface PriceSeed {
  name: string;
  priceType: "recurring" | "usage" | "once";
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  glCode: string | null;
  startDateTime: Date;
  pricingModel: "flat" | "tiered";
  amount: string | null;
  pricingCharacteristics: unknown;
}

interface OfferingSeed {
  name: string;
  specs: SpecSeed[];
  prices: PriceSeed[];
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
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "5000.00",
        pricingCharacteristics: null,
      },
      {
        // Future-dated successor of the same price_type — pm03's
        // derived-effectivity fixture (pm02-spec §3.7).
        name: "Demo — Monthly Recurring Charge (2027)",
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2027-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "5500.00",
        pricingCharacteristics: null,
      },
      {
        name: "Demo — Activation Fee",
        priceType: "once",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: null,
        glCode: null,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "1000.00",
        pricingCharacteristics: null,
      },
      {
        name: "Demo — Data Overage",
        priceType: "usage",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "tiered",
        amount: null,
        pricingCharacteristics: {
          tiers: [
            { from: 0, to: 1000, rate: "0.05" },
            { from: 1000, to: 10000, rate: "0.04" },
            { from: 10000, to: null, rate: "0.03" },
          ],
        },
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
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        glCode: "GL-4100",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "1200.00",
        pricingCharacteristics: null,
      },
      {
        name: "Demo — Data Usage",
        priceType: "usage",
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: "GB",
        glCode: "GL-4200",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
        pricingModel: "flat",
        amount: "0.02",
        pricingCharacteristics: null,
      },
    ],
  },
];

// Seeds the demo product catalog into the caller's transaction (the
// `db:seed-demo` orchestrator owns the connection + transaction, accounts-seed
// precedent). Idempotent: skips wholesale if the demo 5G offering already
// exists — both demo offerings are inserted in one transaction, so it is never
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
    // the same insert-then-activate pattern pm35 gave the sample seed, not an
    // exemption to the trigger).
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
      const characteristics = priceCharacteristicsSchema.parse({
        pricing_model: priceSeed.pricingModel,
        amount: priceSeed.amount,
        pricing_characteristics: priceSeed.pricingCharacteristics,
      });
      await tx.insert(productOfferingPrice).values({
        productOfferingId: offeringId,
        name: priceSeed.name,
        priceType: priceSeed.priceType,
        recurringChargePeriodLength: priceSeed.recurringChargePeriodLength,
        recurringChargePeriodType: priceSeed.recurringChargePeriodType,
        unitOfMeasure: priceSeed.unitOfMeasure,
        amount: characteristics.amount,
        currency: CURRENCY,
        glCode: priceSeed.glCode,
        pricingModel: characteristics.pricing_model,
        policy: null,
        pricingCharacteristics: characteristics.pricing_characteristics,
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
