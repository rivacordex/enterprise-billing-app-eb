import { eq } from "drizzle-orm";

import { logger } from "@/lib/logger";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { productOffering } from "@/db/schema/product";
import {
  productOrder,
  productOrderItem,
  orderItemPriceOverride,
} from "@/db/schema/ordering";
import {
  productInventory,
  inventoryStatusHistory,
} from "@/db/schema/inventory";
import { characteristicsRecordSchema } from "@/validation/characteristics.schema";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import type { Database } from "@/db/client";

import { DEMO_5G_OFFERING_NAME } from "./product-demo";

const CURRENCY = "MYR"; // SYSTEM_CONFIG.default_currency (0005 seed)

// Human-readable "example data" prefix (D1) for every fixture row this demo
// story provisions. Formerly a go-live-removable prefix carried inline in
// `db/seeds/ordering-inventory.ts`; moved here with the story so the mandatory
// chain seeds none of it.
const PREFIX = "Demo — ";

// The demo story needs seeded party/BAN/offering ids resolved at runtime (spec
// §5, "never hardcode ids"). No customer/accounts *data* seed exists anywhere in
// db/seeds, so this seed self-provisions its own `Demo — ` prerequisites
// (org → party_role → financial_account → billing_account) idempotently, and
// looks up the offering created by `product-demo.ts`. Two demo appusers give a
// submitter ≠ reviewer pair for the approval CHECK (architecture Inv. #22).
async function resolvePrerequisites(tx: Database): Promise<{
  submitterId: string;
  reviewerId: string;
  partyRoleId: string;
  billingAccountId: string;
  offeringId: string;
}> {
  const submitterId = await getOrCreateAppUser(
    tx,
    `${PREFIX}Order Submitter`,
    "demo-order-submitter@example.invalid",
  );
  const reviewerId = await getOrCreateAppUser(
    tx,
    `${PREFIX}Order Reviewer`,
    "demo-order-reviewer@example.invalid",
  );

  const orgName = `${PREFIX}Ordering Org`;
  let [org] = await tx
    .select({ organizationId: organization.organizationId })
    .from(organization)
    .where(eq(organization.name, orgName))
    .limit(1);
  if (!org) {
    [org] = await tx
      .insert(organization)
      .values({
        name: orgName,
        organizationType: "COMPANY",
        status: "ACTIVE",
        lastModifiedBy: submitterId,
      })
      .returning({ organizationId: organization.organizationId });
  }
  const organizationId = org!.organizationId;

  let [role] = await tx
    .select({ partyRoleId: partyRole.partyRoleId })
    .from(partyRole)
    .where(eq(partyRole.engagedParty, organizationId))
    .limit(1);
  if (!role) {
    [role] = await tx
      .insert(partyRole)
      .values({
        engagedParty: organizationId,
        status: "ACTIVE",
        lastModifiedBy: submitterId,
      })
      .returning({ partyRoleId: partyRole.partyRoleId });
  }
  const partyRoleId = role!.partyRoleId;

  const cycleName = `${PREFIX}Monthly Cycle`;
  let [cycle] = await tx
    .select({ billCycleId: billCycle.billCycleId })
    .from(billCycle)
    .where(eq(billCycle.name, cycleName))
    .limit(1);
  if (!cycle) {
    [cycle] = await tx
      .insert(billCycle)
      .values({
        name: cycleName,
        description: "Demo monthly cycle for the ordering sample story.",
        frequency: "monthly",
        cycleDay: 1,
        paymentDueDays: 30,
        state: "active",
        lastEditedBy: submitterId,
      })
      .returning({ billCycleId: billCycle.billCycleId });
  }
  const billCycleId = cycle!.billCycleId;

  const faName = `${PREFIX}Financial Account`;
  let [fa] = await tx
    .select({ financialAccountId: financialAccount.financialAccountId })
    .from(financialAccount)
    .where(eq(financialAccount.name, faName))
    .limit(1);
  if (!fa) {
    [fa] = await tx
      .insert(financialAccount)
      .values({
        name: faName,
        refPartyRoleId: partyRoleId,
        currency: CURRENCY,
        lastEditedBy: submitterId,
      })
      .returning({ financialAccountId: financialAccount.financialAccountId });
  }
  const financialAccountId = fa!.financialAccountId;

  const banName = `${PREFIX}Billing Account`;
  let [ban] = await tx
    .select({ billingAccountId: billingAccount.billingAccountId })
    .from(billingAccount)
    .where(eq(billingAccount.name, banName))
    .limit(1);
  if (!ban) {
    [ban] = await tx
      .insert(billingAccount)
      .values({
        name: banName,
        refPartyRoleId: partyRoleId,
        refFinancialAccountId: financialAccountId,
        currency: CURRENCY,
        refBillCycleId: billCycleId,
        lastEditedBy: submitterId,
      })
      .returning({ billingAccountId: billingAccount.billingAccountId });
  }
  const billingAccountId = ban!.billingAccountId;

  // The onboarding flow (services/accounts/onboard-customer-accounts.ts)
  // provisions each FA/BAN's pgledger accounts + `ledger_binding` rows; the
  // accounts read path (getBillingAccountDetail §2.5) hard-requires the BAN's
  // `receivables` binding and throws without it. Since this seed self-creates
  // its FA/BAN (no onboarding service is invoked), it must mirror steps 2c/2d
  // here, or every order review panel for this BAN 500s. Idempotent: each
  // (owner, role) triple is created only when its binding is absent, so a
  // re-run never double-provisions or orphans a pgledger account.
  const ensureBinding = async (
    ownerType: "financial_account" | "billing_account",
    ownerId: string,
    ledgerRole: "unapplied_cash" | "deposits" | "receivables",
    accountName: string,
  ): Promise<void> => {
    const existing = await ledgerBindingRepository.findByOwner(
      tx,
      ownerType,
      ownerId,
    );
    if (existing.some((b) => b.ledgerRole === ledgerRole)) return;

    const account = await ledgerRepository.createAccount(
      tx,
      accountName,
      CURRENCY,
    );
    await ledgerBindingRepository.insert(tx, {
      ownerType,
      ownerId,
      ledgerRole,
      pgledgerAccountId: account.id,
      lastEditedBy: submitterId,
    });
  };

  await ensureBinding(
    "financial_account",
    financialAccountId,
    "unapplied_cash",
    `fa.${financialAccountId}.unapplied_cash`,
  );
  await ensureBinding(
    "financial_account",
    financialAccountId,
    "deposits",
    `fa.${financialAccountId}.deposits`,
  );
  await ensureBinding(
    "billing_account",
    billingAccountId,
    "receivables",
    `ban.${billingAccountId}.receivables`,
  );

  // The offering db:seed-demo creates (ACTIVE). Its list recurring price is
  // 5000.00 — the story's overrides (420.00 / 399.00) undercut it.
  const [offering] = await tx
    .select({ productOfferingId: productOffering.productOfferingId })
    .from(productOffering)
    .where(eq(productOffering.name, DEMO_5G_OFFERING_NAME))
    .limit(1);
  if (!offering) {
    throw new Error(
      "Demo product offering not found. product-demo must seed before ordering-demo.",
    );
  }

  return {
    submitterId,
    reviewerId,
    partyRoleId,
    billingAccountId,
    offeringId: offering.productOfferingId,
  };
}

// Characteristics matching the seeded offering's mandatory spec (SST_ID/SD_ID).
const STORY_CHARACTERISTICS = characteristicsRecordSchema.parse({
  SST_ID: "01",
  SD_ID: "A0C4E2",
});

async function seedStory(
  tx: Database,
  ctx: {
    submitterId: string;
    reviewerId: string;
    partyRoleId: string;
    billingAccountId: string;
    offeringId: string;
  },
): Promise<void> {
  const { submitterId, reviewerId, partyRoleId, billingAccountId, offeringId } =
    ctx;

  // Helper: create an order + one item, returning the item id.
  async function createOrderWithItem(order: {
    status: "COMPLETED" | "PENDING" | "REJECTED";
    reviewedBy: string | null;
    reviewedAt: Date | null;
    completedAt: Date | null;
    failureReason: string | null;
    submittedAt: Date;
    startDate: string;
  }): Promise<string> {
    const [insertedOrder] = await tx
      .insert(productOrder)
      .values({
        customerPartyRoleId: partyRoleId,
        billingAccountId,
        status: order.status,
        failureReason: order.failureReason,
        submittedBy: submitterId,
        submittedAt: order.submittedAt,
        reviewedBy: order.reviewedBy,
        reviewedAt: order.reviewedAt,
        completedAt: order.completedAt,
      })
      .returning({ productOrderId: productOrder.productOrderId });
    const productOrderId = insertedOrder!.productOrderId;

    const [insertedItem] = await tx
      .insert(productOrderItem)
      .values({
        productOrderId,
        productOfferingId: offeringId,
        quantity: 1,
        startDate: order.startDate,
        orderedCharacteristics: STORY_CHARACTERISTICS,
      })
      .returning({ productOrderItemId: productOrderItem.productOrderItemId });
    return insertedItem!.productOrderItemId;
  }

  // 1) COMPLETED order with a negotiated override (recurring 420.00 vs list
  //    5000.00) + its ACTIVE inventory with 3 history rows (create/suspend/
  //    resume) — the plan's headline sample story.
  const item1 = await createOrderWithItem({
    status: "COMPLETED",
    reviewedBy: reviewerId,
    reviewedAt: new Date("2026-02-25T09:00:00Z"),
    completedAt: new Date("2026-03-01T00:00:00Z"),
    failureReason: null,
    submittedAt: new Date("2026-02-24T09:00:00Z"),
    startDate: "2026-03-01",
  });
  await tx.insert(orderItemPriceOverride).values({
    productOrderItemId: item1,
    priceType: "recurring",
    amount: "420.00",
    currency: CURRENCY,
  });
  const [inv1] = await tx
    .insert(productInventory)
    .values({
      productOrderItemId: item1,
      customerPartyRoleId: partyRoleId,
      billingAccountId,
      productOfferingId: offeringId,
      quantity: 1,
      instanceCharacteristics: STORY_CHARACTERISTICS,
      status: "ACTIVE",
      startDate: "2026-03-01",
      endDate: null,
    })
    .returning({ productInventoryId: productInventory.productInventoryId });
  const inventory1Id = inv1!.productInventoryId;
  await tx.insert(inventoryStatusHistory).values([
    {
      productInventoryId: inventory1Id,
      fromStatus: null,
      toStatus: "ACTIVE",
      effectiveDate: "2026-03-01",
      reason: "Subscription instantiated on order completion.",
      changedBy: submitterId,
    },
    {
      productInventoryId: inventory1Id,
      fromStatus: "ACTIVE",
      toStatus: "SUSPENDED",
      effectiveDate: "2026-05-01",
      reason: "Customer requested temporary suspension.",
      changedBy: reviewerId,
    },
    {
      productInventoryId: inventory1Id,
      fromStatus: "SUSPENDED",
      toStatus: "ACTIVE",
      effectiveDate: "2026-06-01",
      reason: "Customer resumed service.",
      changedBy: reviewerId,
    },
  ]);

  // 2) Standard COMPLETED order (no override, no approval) + a TERMINATED
  //    inventory. Gap-free history: create → terminate (Inv. #18).
  const item2 = await createOrderWithItem({
    status: "COMPLETED",
    reviewedBy: null,
    reviewedAt: null,
    completedAt: new Date("2026-02-01T00:00:00Z"),
    failureReason: null,
    submittedAt: new Date("2026-01-31T09:00:00Z"),
    startDate: "2026-02-01",
  });
  const [inv2] = await tx
    .insert(productInventory)
    .values({
      productOrderItemId: item2,
      customerPartyRoleId: partyRoleId,
      billingAccountId,
      productOfferingId: offeringId,
      quantity: 1,
      instanceCharacteristics: STORY_CHARACTERISTICS,
      status: "TERMINATED",
      startDate: "2026-02-01",
      endDate: "2026-07-31",
    })
    .returning({ productInventoryId: productInventory.productInventoryId });
  const inventory2Id = inv2!.productInventoryId;
  await tx.insert(inventoryStatusHistory).values([
    {
      productInventoryId: inventory2Id,
      fromStatus: null,
      toStatus: "ACTIVE",
      effectiveDate: "2026-02-01",
      reason: "Subscription instantiated on order completion.",
      changedBy: submitterId,
    },
    {
      productInventoryId: inventory2Id,
      fromStatus: "ACTIVE",
      toStatus: "TERMINATED",
      effectiveDate: "2026-07-31",
      reason: "Contract ended.",
      changedBy: reviewerId,
    },
  ]);

  // 3) PENDING order with an override, awaiting manager review — provably has
  //    zero inventory rows (verification checklist).
  const item3 = await createOrderWithItem({
    status: "PENDING",
    reviewedBy: null,
    reviewedAt: null,
    completedAt: null,
    failureReason: null,
    submittedAt: new Date("2026-08-01T09:00:00Z"),
    startDate: "2026-09-01",
  });
  await tx.insert(orderItemPriceOverride).values({
    productOrderItemId: item3,
    priceType: "recurring",
    amount: "399.00",
    currency: CURRENCY,
  });

  // 4) REJECTED order (reviewer ≠ submitter, CHECK-backed). No inventory.
  await createOrderWithItem({
    status: "REJECTED",
    reviewedBy: reviewerId,
    reviewedAt: new Date("2026-08-02T09:00:00Z"),
    completedAt: null,
    failureReason: "Negotiated price below floor; not approved.",
    submittedAt: new Date("2026-08-01T10:00:00Z"),
    startDate: "2026-09-01",
  });
}

// Seeds the demo ordering/inventory story into the caller's transaction (the
// `db:seed-demo` orchestrator owns the connection + transaction). Depends on
// `seedProductDemo` having run first in the same transaction (the referenced
// offering). Idempotent: prerequisites are get-or-create and also provision the
// FA/BAN `ledger_binding` rows the accounts read path requires — so they run
// unconditionally; the story is skipped wholesale if the demo BAN already has an
// order. Every JSONB payload is parsed through the validation schemas before
// insert (code-standards §1.7, Inv. #4) — a bad payload throws and nothing lands.
export async function seedOrderingDemo(tx: Database): Promise<void> {
  const ctx = await resolvePrerequisites(tx);

  const [existingOrder] = await tx
    .select({ productOrderId: productOrder.productOrderId })
    .from(productOrder)
    .where(eq(productOrder.billingAccountId, ctx.billingAccountId))
    .limit(1);
  if (existingOrder) {
    logger.info("db:seed-demo: ordering demo story already seeded, skipping.");
    return;
  }

  await seedStory(tx, ctx);
  logger.info("db:seed-demo: ordering demo story seeded.");
}
