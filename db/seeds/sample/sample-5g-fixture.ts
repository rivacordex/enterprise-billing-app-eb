import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
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

// Shared Sample-5G RAN-usage fixture builders (rm18 seed + the rm21 rm07
// integration test). These are the PURE-INSERT cores of the rateable fixture —
// the DRAFT→children→ACTIVE offering (pm36 draft-guard order), the customer +
// MNO key, its RAN_USAGE subscription, and an ACTIVE ratecard. They own no
// idempotency and no prod-guard: `db/seeds/sample/sample-5g-rating.ts` wraps them
// with its get-or-create checks + the non-prod guard for the standalone
// `db:seed-sample-5g` script, and the rm07 test calls them directly with
// per-case parameters. Keeping the insert logic in ONE place means a
// product-model change (a new mandatory spec, a ratecard column, the draft-guard
// rules) is edited once, not forked between the seed and the test.
//
// Every builder takes a `Database` (a live client OR a transaction — both the
// seed's `tx` and the test's `db` satisfy it, same as getOrCreateAppUser) and
// returns the ids the callers thread onward.

export const SAMPLE_5G_CURRENCY = "MYR";
export const SAMPLE_5G_UNIT_OF_MEASURE = "Mbps";
export const SAMPLE_5G_RATE_PER_UNIT = "100.000000";
export const SAMPLE_5G_COMMERCIAL_UNIT = "CU-042";
export const SAMPLE_5G_RATECARD_STATE = "Selangor";
export const SAMPLE_5G_START_DATE = "2026-01-01";
const SAMPLE_5G_START_INSTANT = new Date("2026-01-01T00:00:00Z");

// The three RAN cells one version carries: polygon | district | service_code
// (the shape the ratecard's lkp rows take; used by both callers).
export interface RanLkpRow {
  polygonId: string;
  district: string | null;
  serviceCode: string | null;
}
export const SAMPLE_5G_LKP_ROWS: readonly RanLkpRow[] = [
  { polygonId: "PCU-042_04", district: "DIST-1", serviceCode: "SVL-100" },
  { polygonId: "PCU-042_08", district: "DIST-2", serviceCode: "SVL-101" },
  { polygonId: "PCU-042_15", district: "DIST-3", serviceCode: "SVL-102" },
];

// A DRAFT offering + its three RAN specs + one scalar usage_rate price, then
// promoted to ACTIVE — pm36's draft-guard requires the offering to still be
// DRAFT while its children are written (insert DRAFT, seed children, promote).
export async function insertRanOffering(
  db: Database,
  opts: {
    name: string;
    priceName: string;
    udrTypeValue: string;
    cardName: string;
    ratePerUnit?: string;
    unitOfMeasure?: string;
    currency?: string;
  },
): Promise<{ offeringId: string; priceId: string }> {
  const [offering] = await db
    .insert(productOffering)
    .values({
      name: opts.name,
      isBundle: false,
      isSellable: true,
      billingOnly: false,
      lifecycleStatus: "DRAFT",
      version: 1,
      familyOfferingId: null,
      lastEditedBy: null,
    })
    .returning({ productOfferingId: productOffering.productOfferingId });
  if (!offering)
    throw new Error("insertRanOffering: offering returned no row.");
  const offeringId = offering.productOfferingId;

  const emptyCharacteristics = productSpecCharacteristicsSchema.parse({});
  await db.insert(productSpecifications).values([
    {
      refProductOfferingId: offeringId,
      name: "udrType",
      isMandatory: true,
      isDefault: true,
      defaultValue: opts.udrTypeValue,
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
      defaultValue: opts.cardName,
      productSpecCharacteristics: emptyCharacteristics,
    },
  ]);

  // A plain scalar usage_rate: rateCardLookUp/plaSpecId both null, so the
  // existing usageRateComponentSchema invariant is untouched (the ratecard
  // reference is the productCardLookUp spec above, never a price field).
  const unitOfMeasure = opts.unitOfMeasure ?? SAMPLE_5G_UNIT_OF_MEASURE;
  const priceEnvelope = persistablePricingComponentSchema.parse({
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: null,
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: {
      ratePerUnit: opts.ratePerUnit ?? SAMPLE_5G_RATE_PER_UNIT,
      rateCardLookUp: null,
    },
  });
  const [price] = await db
    .insert(productOfferingPrice)
    .values({
      productOfferingId: offeringId,
      name: opts.priceName,
      componentType: priceEnvelope["@type"],
      priceComponent: priceEnvelope,
      recurringChargePeriodLength: null,
      recurringChargePeriodType: null,
      unitOfMeasure,
      currency: opts.currency ?? SAMPLE_5G_CURRENCY,
      glCode: null,
      policy: null,
      startDateTime: SAMPLE_5G_START_INSTANT,
    })
    .returning({
      productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
    });
  if (!price) throw new Error("insertRanOffering: price returned no row.");

  await db
    .update(productOffering)
    .set({ lifecycleStatus: "ACTIVE" })
    .where(eq(productOffering.productOfferingId, offeringId));

  return { offeringId, priceId: price.productOfferingPriceId };
}

// An organization + its party_role carrying the MNO-key specification. The spec
// object is inserted verbatim — the caller decides whether to validate it
// through mnoKeySpecSchema (the production seed does; a test may pass a raw or
// empty spec to exercise the resolver).
export async function insertRanCustomer(
  db: Database,
  opts: {
    organizationName: string;
    registrationNumber: string;
    partyRoleSpecification: Record<string, unknown>;
    actorId: string;
  },
): Promise<string> {
  const [org] = await db
    .insert(organization)
    .values({
      name: opts.organizationName,
      organizationType: "COMPANY",
      registrationNumber: opts.registrationNumber,
      status: "ACTIVE",
      lastModifiedBy: opts.actorId,
    })
    .returning({ organizationId: organization.organizationId });
  if (!org) throw new Error("insertRanCustomer: organization returned no row.");

  const [role] = await db
    .insert(partyRole)
    .values({
      engagedParty: org.organizationId,
      status: "ACTIVE",
      partyRoleSpecification: opts.partyRoleSpecification,
      lastModifiedBy: opts.actorId,
    })
    .returning({ partyRoleId: partyRole.partyRoleId });
  if (!role) throw new Error("insertRanCustomer: party_role returned no row.");
  return role.partyRoleId;
}

export async function insertRanBillCycle(
  db: Database,
  opts: { name: string; description: string; actorId: string },
): Promise<string> {
  const [cycle] = await db
    .insert(billCycle)
    .values({
      name: opts.name,
      description: opts.description,
      frequency: "monthly",
      cycleDay: 1,
      paymentDueDays: 30,
      state: "active",
      lastEditedBy: opts.actorId,
    })
    .returning({ billCycleId: billCycle.billCycleId });
  if (!cycle)
    throw new Error("insertRanBillCycle: bill_cycle returned no row.");
  return cycle.billCycleId;
}

// A financial account + its billing account. No ledger/pgledger wiring — the
// fixture is rating-only, never billed.
export async function insertRanBillingAccount(
  db: Database,
  opts: {
    financialAccountName: string;
    billingAccountName: string;
    partyRoleId: string;
    billCycleId: string;
    actorId: string;
    currency?: string;
  },
): Promise<string> {
  const currency = opts.currency ?? SAMPLE_5G_CURRENCY;
  const [fa] = await db
    .insert(financialAccount)
    .values({
      name: opts.financialAccountName,
      refPartyRoleId: opts.partyRoleId,
      currency,
      lastEditedBy: opts.actorId,
    })
    .returning({ financialAccountId: financialAccount.financialAccountId });
  if (!fa) {
    throw new Error(
      "insertRanBillingAccount: financial_account returned no row.",
    );
  }

  const [ban] = await db
    .insert(billingAccount)
    .values({
      name: opts.billingAccountName,
      refPartyRoleId: opts.partyRoleId,
      refFinancialAccountId: fa.financialAccountId,
      currency,
      refBillCycleId: opts.billCycleId,
      lastEditedBy: opts.actorId,
    })
    .returning({ billingAccountId: billingAccount.billingAccountId });
  if (!ban) {
    throw new Error(
      "insertRanBillingAccount: billing_account returned no row.",
    );
  }
  return ban.billingAccountId;
}

// One RAN_USAGE subscription (order → item → inventory + its genesis status
// row), pinned to the offering. `singleSubInstPerCust` blocks a second one at
// the ordering layer (seed-discipline this phase).
export async function insertRanSubscription(
  db: Database,
  opts: {
    partyRoleId: string;
    billingAccountId: string;
    offeringId: string;
    actorId: string;
    reason: string;
    startDate?: string;
  },
): Promise<string> {
  const startDate = opts.startDate ?? SAMPLE_5G_START_DATE;
  const [order] = await db
    .insert(productOrder)
    .values({
      customerPartyRoleId: opts.partyRoleId,
      billingAccountId: opts.billingAccountId,
      status: "COMPLETED",
      failureReason: null,
      submittedBy: opts.actorId,
      submittedAt: SAMPLE_5G_START_INSTANT,
      reviewedBy: null,
      reviewedAt: null,
      completedAt: SAMPLE_5G_START_INSTANT,
    })
    .returning({ productOrderId: productOrder.productOrderId });
  if (!order)
    throw new Error("insertRanSubscription: product_order returned no row.");

  const [item] = await db
    .insert(productOrderItem)
    .values({
      productOrderId: order.productOrderId,
      productOfferingId: opts.offeringId,
      quantity: 1,
      startDate,
      orderedCharacteristics: {},
    })
    .returning({ productOrderItemId: productOrderItem.productOrderItemId });
  if (!item) {
    throw new Error(
      "insertRanSubscription: product_order_item returned no row.",
    );
  }

  const [inventory] = await db
    .insert(productInventory)
    .values({
      productOrderItemId: item.productOrderItemId,
      customerPartyRoleId: opts.partyRoleId,
      billingAccountId: opts.billingAccountId,
      productOfferingId: opts.offeringId,
      quantity: 1,
      instanceCharacteristics: {},
      status: "ACTIVE",
      startDate,
      endDate: null,
    })
    .returning({ productInventoryId: productInventory.productInventoryId });
  if (!inventory) {
    throw new Error(
      "insertRanSubscription: product_inventory returned no row.",
    );
  }

  await db.insert(inventoryStatusHistory).values({
    productInventoryId: inventory.productInventoryId,
    fromStatus: null,
    toStatus: "ACTIVE",
    effectiveDate: startDate,
    reason: opts.reason,
    changedBy: opts.actorId,
  });

  return inventory.productInventoryId;
}

// An ACTIVE ratecard version + its lkp rows. `lkpSubscriberRefId = party_role_id`
// (the customer), NOT product_inventory_id — the factor-2 ref that stays stable
// across re-subscribe (pm57a). Plain text, no FK (RC14).
export async function insertRanRatecard(
  db: Database,
  opts: {
    cardName: string;
    mnoPublicKey: string;
    lkpSubscriberRefId: string;
    rows: readonly RanLkpRow[];
    actorId: string;
    commercialUnitPublicKey?: string;
    state?: string | null;
    snapshotDate?: string;
    sourceFile?: string;
  },
): Promise<void> {
  const snapshotDate = opts.snapshotDate ?? SAMPLE_5G_START_DATE;
  const [version] = await db
    .insert(ratecardVersion)
    .values({
      cardName: opts.cardName,
      versionNum: 1,
      status: "ACTIVE",
      snapshotDate,
      sourceFile: opts.sourceFile ?? "_SAMPLE_5G Seed",
      fileChecksum: null,
      rowCount: opts.rows.length,
      uploadedBy: opts.actorId,
      activatedBy: opts.actorId,
      activatedAt: SAMPLE_5G_START_INSTANT,
      supersededByVersionId: null,
      rejectSummary: null,
    })
    .returning({ ratecardVersionId: ratecardVersion.ratecardVersionId });
  if (!version)
    throw new Error("insertRanRatecard: ratecard_version returned no row.");

  await db.insert(ratecardRanUsageLkp).values(
    opts.rows.map((row) => ({
      ratecardVersionId: version.ratecardVersionId,
      mnoPublicKey: opts.mnoPublicKey,
      commercialUnitPublicKey:
        opts.commercialUnitPublicKey ?? SAMPLE_5G_COMMERCIAL_UNIT,
      polygonId: row.polygonId,
      polygonStartDate: snapshotDate,
      polygonEndDate: null,
      state: opts.state === undefined ? SAMPLE_5G_RATECARD_STATE : opts.state,
      district: row.district,
      lkpSubscriberRefId: opts.lkpSubscriberRefId,
      serviceCode: row.serviceCode,
      ratePerUnit: null,
    })),
  );
}
