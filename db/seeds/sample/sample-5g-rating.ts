import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
  ratecardVersion,
  ratecardRanUsageLkp,
} from "@/db/schema/product";
import { productOrder, productOrderItem } from "@/db/schema/ordering";
import {
  productInventory,
  inventoryStatusHistory,
} from "@/db/schema/inventory";
import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import { mnoKeySpecSchema } from "@/validation/customer/party-role-specification.schema";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import {
  assertNonProductionUrl,
  type NonProdGuardContext,
} from "@/db/seeds/lib/non-prod-guard";
import * as schema from "@/db/schema";
import type { Database } from "@/db/client";

// rm18-spec. Standalone seed script (`npm run db:seed-sample-5g`) — **never**
// added to `db:setup` (sample data is opt-in, dev/test/demo only, same
// convention as `sample/seed-billrun-sample.ts`). Seeds one end-to-end
// rateable Sample 5G dataset — offering + three specs + a scalar usage_rate
// price, a customer whose party_role carries the MNO key, its single
// RAN_USAGE subscription, and an active ratecard whose lkp_subscriber_ref_id
// points at that customer — so rm19-rm21 can resolve and rate a real record.
//
// Direct Drizzle inserts in one transaction (not the real-service
// orchestration `seed-billrun-sample.ts` uses) — rm18-spec §Design's
// dependency-ordered insert list is table-level, not service-level, matching
// the `demo/product-demo.ts` + `demo/ordering-demo.ts` precedent.

const CURRENCY = "MYR" as const;
const SAMPLE_5G_REGISTRATION_NUMBER = "_SAMPLE_-5G-0001";
const SAMPLE_5G_CUSTOMER_NAME = "_SAMPLE_ 5G RAN Subscriber";
const SAMPLE_5G_BAN_NAME = "_SAMPLE_ 5G Billing Account";
const SAMPLE_5G_BILL_CYCLE_NAME = "_SAMPLE_ 5G Monthly Cycle";
const SAMPLE_OFFERING_NAME = "Sample 5G Services";
const SAMPLE_PRICE_NAME = "Sample 5G Usage Rate";
const SAMPLE_USAGE_RATE_PER_UNIT = "100.000000";
const MNO_PUBLIC_KEY = "MNO-001";
const COMMERCIAL_UNIT_PUBLIC_KEY = "CU-042";
const RATECARD_CARD_NAME = "RATECARD_RAN_USAGE_LKP";
const RATECARD_STATE = "Selangor";

// Shared prod-write guard context (db/seeds/lib/non-prod-guard.ts).
const SAMPLE_5G_GUARD: NonProdGuardContext = {
  seedScript: "db:seed-sample-5g",
  overrideEnv: "ALLOW_SAMPLE_5G_SEED",
  action: `writes a "Sample 5G" rateable fixture (offering, customer, ratecard)`,
};

function isSampleSeedOverride(): boolean {
  return process.env.ALLOW_SAMPLE_5G_SEED === "true";
}

function assertNonProductionTarget(): void {
  if (isSampleSeedOverride()) {
    logger.warn(
      "db:seed-sample-5g: ALLOW_SAMPLE_5G_SEED=true — proceeding without the non-prod host check.",
    );
    return;
  }
  assertNonProductionUrl(config.DATABASE_URL, "DATABASE_URL", SAMPLE_5G_GUARD);
}

// Offering + three specs + scalar usage_rate price (rm18-spec §Implementation
// §3). pm36's DRAFT-guard trigger requires the offering to still be DRAFT
// while its children (specs/price) are written — insert DRAFT, seed
// children, then promote to ACTIVE (pm50/pm51 precedent, repo memory
// `pm36-draft-guard-trigger-fixture-ripple`). Idempotent: an existing
// offering (by name) is returned as-is.
async function ensureSampleOffering(
  tx: Database,
): Promise<{ offeringId: string; priceId: string }> {
  const [existing] = await tx
    .select({ productOfferingId: productOffering.productOfferingId })
    .from(productOffering)
    .where(eq(productOffering.name, SAMPLE_OFFERING_NAME))
    .limit(1);
  if (existing) {
    const [existingPrice] = await tx
      .select({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      })
      .from(productOfferingPrice)
      .where(
        eq(productOfferingPrice.productOfferingId, existing.productOfferingId),
      )
      .limit(1);
    if (!existingPrice) {
      throw new Error(
        `db:seed-sample-5g: "${SAMPLE_OFFERING_NAME}" already exists but carries no price row.`,
      );
    }
    return {
      offeringId: existing.productOfferingId,
      priceId: existingPrice.productOfferingPriceId,
    };
  }

  const [offering] = await tx
    .insert(productOffering)
    .values({
      name: SAMPLE_OFFERING_NAME,
      isBundle: false,
      isSellable: true,
      billingOnly: false,
      lifecycleStatus: "DRAFT",
      version: 1,
      familyOfferingId: null,
      lastEditedBy: null,
    })
    .returning({ productOfferingId: productOffering.productOfferingId });
  if (!offering) {
    throw new Error(
      `db:seed-sample-5g: "${SAMPLE_OFFERING_NAME}" insert returned no row.`,
    );
  }
  const offeringId = offering.productOfferingId;

  const emptyCharacteristics = productSpecCharacteristicsSchema.parse({});
  await tx.insert(productSpecifications).values([
    {
      refProductOfferingId: offeringId,
      name: "udrType",
      isMandatory: true,
      isDefault: true,
      defaultValue: "RAN_USAGE",
      productSpecCharacteristics: emptyCharacteristics,
    },
    {
      refProductOfferingId: offeringId,
      name: "singleSubInstPerCust",
      isMandatory: true,
      isDefault: false,
      defaultValue: "true",
      productSpecCharacteristics: emptyCharacteristics,
    },
    {
      refProductOfferingId: offeringId,
      name: "productCardLookUp",
      isMandatory: true,
      isDefault: false,
      defaultValue: RATECARD_CARD_NAME,
      productSpecCharacteristics: emptyCharacteristics,
    },
  ]);

  // rm18-spec §Design — a plain scalar usage_rate: rateCardLookUp/plaSpecId
  // both null, so the existing usageRateComponentSchema invariant is
  // untouched (the ratecard reference is the productCardLookUp spec above,
  // never a price field).
  const priceEnvelope = persistablePricingComponentSchema.parse({
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: null,
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure: "Mbps" },
    params: { ratePerUnit: SAMPLE_USAGE_RATE_PER_UNIT, rateCardLookUp: null },
  });

  const [price] = await tx
    .insert(productOfferingPrice)
    .values({
      productOfferingId: offeringId,
      name: SAMPLE_PRICE_NAME,
      componentType: priceEnvelope["@type"],
      priceComponent: priceEnvelope,
      recurringChargePeriodLength: null,
      recurringChargePeriodType: null,
      unitOfMeasure: "Mbps",
      currency: CURRENCY,
      glCode: null,
      policy: null,
      startDateTime: new Date("2026-01-01T00:00:00Z"),
    })
    .returning({
      productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
    });
  if (!price) {
    throw new Error(
      `db:seed-sample-5g: "${SAMPLE_PRICE_NAME}" insert returned no row.`,
    );
  }

  await tx
    .update(productOffering)
    .set({ lifecycleStatus: "ACTIVE" })
    .where(eq(productOffering.productOfferingId, offeringId));

  return { offeringId, priceId: price.productOfferingPriceId };
}

// Customer whose party_role carries the MNO key (rm18-spec §Implementation
// §4). Direct insert (org → party_role), mirroring `demo/ordering-demo.ts`'s
// self-provisioning precedent. Idempotent by the organization's
// registration number.
async function ensureSampleCustomer(
  tx: Database,
  actorId: string,
): Promise<string> {
  const [existingOrg] = await tx
    .select({ organizationId: organization.organizationId })
    .from(organization)
    .where(eq(organization.registrationNumber, SAMPLE_5G_REGISTRATION_NUMBER))
    .limit(1);
  if (existingOrg) {
    const [existingRole] = await tx
      .select({ partyRoleId: partyRole.partyRoleId })
      .from(partyRole)
      .where(eq(partyRole.engagedParty, existingOrg.organizationId))
      .limit(1);
    if (!existingRole) {
      throw new Error(
        `db:seed-sample-5g: organization ${existingOrg.organizationId} exists but carries no party_role.`,
      );
    }
    return existingRole.partyRoleId;
  }

  const [org] = await tx
    .insert(organization)
    .values({
      name: SAMPLE_5G_CUSTOMER_NAME,
      organizationType: "COMPANY",
      registrationNumber: SAMPLE_5G_REGISTRATION_NUMBER,
      status: "ACTIVE",
      lastModifiedBy: actorId,
    })
    .returning({ organizationId: organization.organizationId });
  if (!org) {
    throw new Error("db:seed-sample-5g: organization insert returned no row.");
  }

  // rm18-spec §Implementation §2/§4 — the MNO-key shape, validated through
  // mnoKeySpecSchema before it ever reaches the database.
  const spec = mnoKeySpecSchema.parse({ mnoPublicKey1: MNO_PUBLIC_KEY });

  const [role] = await tx
    .insert(partyRole)
    .values({
      engagedParty: org.organizationId,
      status: "ACTIVE",
      partyRoleSpecification: spec,
      lastModifiedBy: actorId,
    })
    .returning({ partyRoleId: partyRole.partyRoleId });
  if (!role) {
    throw new Error("db:seed-sample-5g: party_role insert returned no row.");
  }
  return role.partyRoleId;
}

// Self-provisioned bill cycle (no dependency on db:seed-accounts having run —
// rm18-spec Dependencies: "None"). Idempotent by name (unique in schema).
async function ensureSampleBillCycle(
  tx: Database,
  actorId: string,
): Promise<string> {
  const [existing] = await tx
    .select({ billCycleId: billCycle.billCycleId })
    .from(billCycle)
    .where(eq(billCycle.name, SAMPLE_5G_BILL_CYCLE_NAME))
    .limit(1);
  if (existing) return existing.billCycleId;

  const [cycle] = await tx
    .insert(billCycle)
    .values({
      name: SAMPLE_5G_BILL_CYCLE_NAME,
      description: "Sample 5G rating fixture bill cycle (rm18).",
      frequency: "monthly",
      cycleDay: 1,
      paymentDueDays: 30,
      state: "active",
      lastEditedBy: actorId,
    })
    .returning({ billCycleId: billCycle.billCycleId });
  if (!cycle) {
    throw new Error("db:seed-sample-5g: bill_cycle insert returned no row.");
  }
  return cycle.billCycleId;
}

// Financial account + billing account (rm18-spec §Implementation §4). No
// ledger/pgledger wiring — this fixture is rating-only, never billed or read
// through the accounts UI. Idempotent by the billing account's name.
async function ensureSampleBillingAccount(
  tx: Database,
  actorId: string,
  partyRoleId: string,
  billCycleId: string,
): Promise<string> {
  const [existingBan] = await tx
    .select({ billingAccountId: billingAccount.billingAccountId })
    .from(billingAccount)
    .where(eq(billingAccount.name, SAMPLE_5G_BAN_NAME))
    .limit(1);
  if (existingBan) return existingBan.billingAccountId;

  const [fa] = await tx
    .insert(financialAccount)
    .values({
      name: `${SAMPLE_5G_BAN_NAME} — Financial Account`,
      refPartyRoleId: partyRoleId,
      currency: CURRENCY,
      lastEditedBy: actorId,
    })
    .returning({ financialAccountId: financialAccount.financialAccountId });
  if (!fa) {
    throw new Error(
      "db:seed-sample-5g: financial_account insert returned no row.",
    );
  }

  const [ban] = await tx
    .insert(billingAccount)
    .values({
      name: SAMPLE_5G_BAN_NAME,
      refPartyRoleId: partyRoleId,
      refFinancialAccountId: fa.financialAccountId,
      currency: CURRENCY,
      refBillCycleId: billCycleId,
      lastEditedBy: actorId,
    })
    .returning({ billingAccountId: billingAccount.billingAccountId });
  if (!ban) {
    throw new Error(
      "db:seed-sample-5g: billing_account insert returned no row.",
    );
  }
  return ban.billingAccountId;
}

// The single RAN_USAGE subscription (rm18-spec §Implementation §4,
// `singleSubInstPerCust`). Direct order/item/inventory insert, mirroring
// `demo/ordering-demo.ts`'s pattern. Idempotent: an existing ACTIVE inventory
// on this billing account + offering is returned as-is.
async function ensureSampleSubscription(
  tx: Database,
  actorId: string,
  partyRoleId: string,
  billingAccountId: string,
  offeringId: string,
): Promise<string> {
  const [existingInventory] = await tx
    .select({ productInventoryId: productInventory.productInventoryId })
    .from(productInventory)
    .where(
      and(
        eq(productInventory.billingAccountId, billingAccountId),
        eq(productInventory.productOfferingId, offeringId),
      ),
    )
    .limit(1);
  if (existingInventory) return existingInventory.productInventoryId;

  const startDate = "2026-01-01";
  const now = new Date("2026-01-01T00:00:00Z");

  const [order] = await tx
    .insert(productOrder)
    .values({
      customerPartyRoleId: partyRoleId,
      billingAccountId,
      status: "COMPLETED",
      failureReason: null,
      submittedBy: actorId,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      completedAt: now,
    })
    .returning({ productOrderId: productOrder.productOrderId });
  if (!order) {
    throw new Error("db:seed-sample-5g: product_order insert returned no row.");
  }

  const [item] = await tx
    .insert(productOrderItem)
    .values({
      productOrderId: order.productOrderId,
      productOfferingId: offeringId,
      quantity: 1,
      startDate,
      orderedCharacteristics: {},
    })
    .returning({ productOrderItemId: productOrderItem.productOrderItemId });
  if (!item) {
    throw new Error(
      "db:seed-sample-5g: product_order_item insert returned no row.",
    );
  }

  const [inventory] = await tx
    .insert(productInventory)
    .values({
      productOrderItemId: item.productOrderItemId,
      customerPartyRoleId: partyRoleId,
      billingAccountId,
      productOfferingId: offeringId,
      quantity: 1,
      instanceCharacteristics: {},
      status: "ACTIVE",
      startDate,
      endDate: null,
    })
    .returning({ productInventoryId: productInventory.productInventoryId });
  if (!inventory) {
    throw new Error(
      "db:seed-sample-5g: product_inventory insert returned no row.",
    );
  }

  await tx.insert(inventoryStatusHistory).values({
    productInventoryId: inventory.productInventoryId,
    fromStatus: null,
    toStatus: "ACTIVE",
    effectiveDate: startDate,
    reason: "Sample 5G RAN_USAGE subscription instantiated by the rm18 seed.",
    changedBy: actorId,
  });

  return inventory.productInventoryId;
}

// Active ratecard version + three lkp rows (rm18-spec §Implementation §5).
// `lkp_subscriber_ref_id = party_role_id` (the customer), NOT
// `product_inventory_id` — the update's change (pm57a banner) that keeps
// factor-2 stable across re-subscribe. Idempotent by (card_name,
// version_num): a pre-existing version is assumed complete and left alone.
async function ensureSampleRatecard(
  tx: Database,
  actorId: string,
  partyRoleId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ ratecardVersionId: ratecardVersion.ratecardVersionId })
    .from(ratecardVersion)
    .where(
      and(
        eq(ratecardVersion.cardName, RATECARD_CARD_NAME),
        eq(ratecardVersion.versionNum, 1),
      ),
    )
    .limit(1);
  if (existing) return;

  const snapshotDate = "2026-01-01";
  const [version] = await tx
    .insert(ratecardVersion)
    .values({
      cardName: RATECARD_CARD_NAME,
      versionNum: 1,
      status: "ACTIVE",
      snapshotDate,
      sourceFile: "_SAMPLE_5G Seed",
      fileChecksum: null,
      rowCount: 3,
      uploadedBy: actorId,
      activatedBy: actorId,
      activatedAt: new Date("2026-01-01T00:00:00Z"),
      supersededByVersionId: null,
      rejectSummary: null,
    })
    .returning({ ratecardVersionId: ratecardVersion.ratecardVersionId });
  if (!version) {
    throw new Error(
      "db:seed-sample-5g: ratecard_version insert returned no row.",
    );
  }

  await tx.insert(ratecardRanUsageLkp).values([
    {
      ratecardVersionId: version.ratecardVersionId,
      mnoPublicKey: MNO_PUBLIC_KEY,
      commercialUnitPublicKey: COMMERCIAL_UNIT_PUBLIC_KEY,
      polygonId: "PCU-042_04",
      polygonStartDate: snapshotDate,
      polygonEndDate: null,
      state: RATECARD_STATE,
      district: "DIST-1",
      lkpSubscriberRefId: partyRoleId,
      serviceCode: "SVL-100",
      ratePerUnit: null,
    },
    {
      ratecardVersionId: version.ratecardVersionId,
      mnoPublicKey: MNO_PUBLIC_KEY,
      commercialUnitPublicKey: COMMERCIAL_UNIT_PUBLIC_KEY,
      polygonId: "PCU-042_08",
      polygonStartDate: snapshotDate,
      polygonEndDate: null,
      state: RATECARD_STATE,
      district: "DIST-2",
      lkpSubscriberRefId: partyRoleId,
      serviceCode: "SVL-101",
      ratePerUnit: null,
    },
    {
      ratecardVersionId: version.ratecardVersionId,
      mnoPublicKey: MNO_PUBLIC_KEY,
      commercialUnitPublicKey: COMMERCIAL_UNIT_PUBLIC_KEY,
      polygonId: "PCU-042_15",
      polygonStartDate: snapshotDate,
      polygonEndDate: null,
      state: RATECARD_STATE,
      district: "DIST-3",
      lkpSubscriberRefId: partyRoleId,
      serviceCode: "SVL-102",
      ratePerUnit: null,
    },
  ]);
}

async function main(): Promise<void> {
  assertNonProductionTarget();

  const client = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      const actorId = await getOrCreateAppUser(
        tx,
        "_SAMPLE_5G Seed Actor",
        "sample-5g-seed@example.invalid",
      );

      const { offeringId } = await ensureSampleOffering(tx);
      const partyRoleId = await ensureSampleCustomer(tx, actorId);
      const billCycleId = await ensureSampleBillCycle(tx, actorId);
      const billingAccountId = await ensureSampleBillingAccount(
        tx,
        actorId,
        partyRoleId,
        billCycleId,
      );
      await ensureSampleSubscription(
        tx,
        actorId,
        partyRoleId,
        billingAccountId,
        offeringId,
      );
      await ensureSampleRatecard(tx, actorId, partyRoleId);

      logger.info("db:seed-sample-5g: Sample 5G rating fixture seeded.", {
        partyRoleId,
        billingAccountId,
        offeringId,
      });
    });
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error("db:seed-sample-5g failed.", {
      message: err instanceof Error ? err.message : "Unknown error",
    });
    process.exit(1);
  });
