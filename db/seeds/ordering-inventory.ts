import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";
import { rolePermissionAssign } from "@/db/schema/role-permission-assign";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
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
import type { Database } from "@/db/client";

const CURRENCY = "MYR"; // SYSTEM_CONFIG.default_currency (0005 seed)

// Every fixture row this seed creates carries the go-live-removable prefix
// (code-standards §1.8) so a data migration can find and drop them; no
// production code may depend on them existing.
const PREFIX = "TOREMOVE-Template-";

// pm25-spec §3: MANAGER/ADMIN hold EDIT on both ordering permissions, USER
// holds READ. Idempotent per grant.
async function grantOrderingPermissions(tx: Database): Promise<void> {
  const roleRows = await tx
    .select({ roleId: roles.roleId, roleName: roles.roleName })
    .from(roles);
  const roleId = (name: string): string => {
    const row = roleRows.find((r) => r.roleName === name);
    if (!row) {
      throw new Error(`${name} role not found. Run db:seed-rbac first.`);
    }
    return row.roleId;
  };
  const managerRoleId = roleId("MANAGER");
  const userRoleId = roleId("USER");
  const adminRoleId = roleId("ADMIN");

  const grantsByPermission: {
    permissionName: "product_orders" | "product_inventory";
    grants: { roleId: string; permissionType: "READ" | "EDIT" }[];
  }[] = [
    {
      permissionName: "product_orders",
      grants: [
        { roleId: managerRoleId, permissionType: "EDIT" },
        { roleId: userRoleId, permissionType: "READ" },
        { roleId: adminRoleId, permissionType: "EDIT" },
      ],
    },
    {
      permissionName: "product_inventory",
      grants: [
        { roleId: managerRoleId, permissionType: "EDIT" },
        { roleId: userRoleId, permissionType: "READ" },
        { roleId: adminRoleId, permissionType: "EDIT" },
      ],
    },
  ];

  for (const { permissionName, grants } of grantsByPermission) {
    const [permission] = await tx
      .select({ permissionId: permissions.permissionId })
      .from(permissions)
      .where(eq(permissions.permissionName, permissionName))
      .limit(1);
    if (!permission) {
      throw new Error(
        `${permissionName} permission not found. Run db:migrate first.`,
      );
    }
    for (const grant of grants) {
      const [existing] = await tx
        .select({
          rolePermissionId: rolePermissionAssign.rolePermissionId,
          permissionType: rolePermissionAssign.permissionType,
        })
        .from(rolePermissionAssign)
        .where(
          and(
            eq(rolePermissionAssign.refRoleId, grant.roleId),
            eq(rolePermissionAssign.refPermissionId, permission.permissionId),
          ),
        )
        .limit(1);
      if (!existing) {
        await tx.insert(rolePermissionAssign).values({
          refRoleId: grant.roleId,
          refPermissionId: permission.permissionId,
          permissionType: grant.permissionType,
        });
      } else if (existing.permissionType !== grant.permissionType) {
        // Reconcile a changed grant level on rerun (accounts-seed precedent);
        // matching grants are left untouched, keeping reruns idempotent.
        await tx
          .update(rolePermissionAssign)
          .set({
            permissionType: grant.permissionType,
            lastModifiedDatetime: new Date(),
          })
          .where(
            eq(
              rolePermissionAssign.rolePermissionId,
              existing.rolePermissionId,
            ),
          );
      }
    }
  }
}

async function getOrCreateAppUser(
  tx: Database,
  userName: string,
  userEmail: string,
): Promise<string> {
  const [existing] = await tx
    .select({ id: appuser.id })
    .from(appuser)
    .where(eq(appuser.userEmail, userEmail))
    .limit(1);
  if (existing) return existing.id;
  const [inserted] = await tx
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName,
      userEmail,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  return inserted!.id;
}

// The plan's sample story needs seeded party/BAN/offering ids resolved at
// runtime (spec §5, "never hardcode ids"). No customer/accounts *data* seed
// exists anywhere in db/seeds, so this seed self-provisions its own
// TOREMOVE-Template- prerequisites (org → party_role → financial_account →
// billing_account) idempotently, and looks up the offering created by
// db:seed-product. Two template appusers give a submitter ≠ reviewer pair for
// the approval CHECK (architecture Inv. #22).
async function resolvePrerequisites(tx: Database): Promise<{
  submitterId: string;
  reviewerId: string;
  partyRoleId: string;
  billingAccountId: string;
  offeringId: string;
}> {
  const submitterId = await getOrCreateAppUser(
    tx,
    `${PREFIX}Order-Submitter`,
    "toremove-template-order-submitter@example.invalid",
  );
  const reviewerId = await getOrCreateAppUser(
    tx,
    `${PREFIX}Order-Reviewer`,
    "toremove-template-order-reviewer@example.invalid",
  );

  const orgName = `${PREFIX}Ordering-Org`;
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

  const cycleName = `${PREFIX}Monthly-Cycle`;
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
        description: "Template monthly cycle for the ordering sample story.",
        frequency: "monthly",
        cycleDay: 1,
        paymentDueDays: 30,
        state: "active",
        lastEditedBy: submitterId,
      })
      .returning({ billCycleId: billCycle.billCycleId });
  }
  const billCycleId = cycle!.billCycleId;

  const faName = `${PREFIX}Financial-Account`;
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

  const banName = `${PREFIX}Billing-Account`;
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

  // The offering db:seed-product creates (ACTIVE). Its list recurring price is
  // 5000.00 — the story's overrides (420.00 / 399.00) undercut it.
  const [offering] = await tx
    .select({ productOfferingId: productOffering.productOfferingId })
    .from(productOffering)
    .where(eq(productOffering.name, `${PREFIX}5G-Nationwide-Service-Plan`))
    .limit(1);
  if (!offering) {
    throw new Error(
      "Seeded product offering not found. Run db:seed-product first.",
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

// Standalone script (`npm run db:seed-ordering`) — never imported by
// application code. Depends on `seed-rbac.ts` (roles) and `seed-product.ts`
// (the referenced offering). Idempotent: grants are checked per-row; the
// sample story is skipped wholesale if any product_order row already exists.
// Every JSONB payload is parsed through the validation schemas before insert
// (code-standards §1.7, Inv. #4) — a bad payload throws and nothing lands.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  // Full schema (not a narrow subset) so the transaction handle matches the
  // `Database` type the helpers above accept (seed-accounts precedent).
  const db = drizzle(sql, { schema });

  try {
    await db.transaction(async (tx) => {
      await grantOrderingPermissions(tx);

      const [existingOrder] = await tx
        .select({ productOrderId: productOrder.productOrderId })
        .from(productOrder)
        .limit(1);
      if (existingOrder) {
        logger.info("Ordering sample story already seeded, skipping data.");
        return;
      }

      const ctx = await resolvePrerequisites(tx);
      await seedStory(tx, ctx);
    });

    logger.info("Ordering & inventory seeded successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Ordering & inventory seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
