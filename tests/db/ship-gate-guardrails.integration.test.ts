import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
import { productInventory } from "@/db/schema/inventory";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { assertInventoryGapFree } from "@/tests/helpers/assert-inventory-gap-free";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { createOrder as CreateOrder } from "@/services/ordering/create-order";
import type { getOrderDetail as GetOrderDetail } from "@/services/ordering/get-order-detail";
import type { activateOffering as ActivateOffering } from "@/services/product/activate-offering";
import type { suspendSubscription as SuspendSubscription } from "@/services/inventory/suspend-subscription";
import type { resumeSubscription as ResumeSubscription } from "@/services/inventory/resume-subscription";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";

// pm34-spec §Implementation-2, guardrails 16 and 17 — the two Update
// guardrails that need genuinely new live-DB coverage (15/18-structural
// already live permanently in tests/db/ordering-repository-exports.test.ts,
// pm26; 22 already lives in tests/db/review-order.integration.test.ts,
// pm30 — referenced in prodmgmt-code-standards.md §9, not duplicated here).
// `PMSHIPGATE-` prefix convention for every ad hoc name inserted below.
const databaseUrl = process.env.DATABASE_URL;
const NOW = new Date("2026-08-10T00:00:00Z");
const CURRENCY = "MYR";

describe.skipIf(!databaseUrl)(
  "pm34 ship-gate guardrails 16/17 (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createOrder: typeof CreateOrder;
    let getOrderDetail: typeof GetOrderDetail;
    let activateOffering: typeof ActivateOffering;
    let suspendSubscription: typeof SuspendSubscription;
    let resumeSubscription: typeof ResumeSubscription;

    let actorId: string;
    let cycleId: string;

    async function newAppUser(name: string): Promise<string> {
      const [row] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: name,
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      return row!.id;
    }

    async function newPartyRole(orgName: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: orgName,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: actorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      return role!.partyRoleId;
    }

    async function newBillingAccount(partyRoleId: string): Promise<string> {
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "PMSHIPGATE-FA",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "PMSHIPGATE-BAN",
          state: "active",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    // Unlike create-order.integration.test.ts's `newOffering` (which never
    // needs to survive a real `activateOffering` call), this fixture also
    // inserts a resolved mandatory specification — `activateOffering`'s
    // SPECIFICATIONS_NOT_RESOLVED precondition requires at least one, and
    // `branchOfferingAsDraft` clones it onto the branch guardrail 16 activates.
    async function newActiveOfferingWithResolvedSpec(): Promise<string> {
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "PMSHIPGATE-Offering",
          isBundle: false,
          isSellable: true,
          billingOnly: true,
          lifecycleStatus: "ACTIVE",
          version: 1,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;

      await db.insert(productSpecifications).values({
        refProductOfferingId: offeringId,
        name: "SST identifier",
        isMandatory: true,
        isDefault: true,
        defaultValue: "01",
        productSpecCharacteristics: { SST_ID: "01" },
      });

      await db.insert(productOfferingPrice).values({
        productOfferingId: offeringId,
        name: "Monthly Recurring Charge",
        priceType: "recurring",
        amount: "5000.00",
        currency: CURRENCY,
        pricingModel: "flat",
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      });

      return offeringId;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ createOrder } = await import("@/services/ordering/create-order"));
      ({ getOrderDetail } =
        await import("@/services/ordering/get-order-detail"));
      ({ activateOffering } =
        await import("@/services/product/activate-offering"));
      ({ suspendSubscription } =
        await import("@/services/inventory/suspend-subscription"));
      ({ resumeSubscription } =
        await import("@/services/inventory/resume-subscription"));

      actorId = await newAppUser("PMSHIPGATE Submitter");
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "PMSHIPGATE Cycle", lastEditedBy: actorId })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // Guardrail 16 (code-standards §9): activate a new version of the
    // ordered offering through the real catalog services (branch + activate,
    // not a raw SQL status flip — pm26/pm32's own "RETIRED pinned version"
    // tests only ever flipped `lifecycle_status` directly); assert the
    // subscription's pinned `product_offering_id` is unchanged and its
    // `OrderPriceLine`/rating reads still resolve byte-identically from the
    // now-RETIRED version's rows (Inv. #17).
    it("guardrail 16 — grandfathering survives a real catalog activation of a new version", async () => {
      const partyRoleId = await newPartyRole("PMSHIPGATE-Grandfather");
      const banId = await newBillingAccount(partyRoleId);
      const offeringId = await newActiveOfferingWithResolvedSpec();

      const orderInput: CreateOrderInput = {
        customerPartyRoleId: partyRoleId,
        billingAccountId: banId,
        productOfferingId: offeringId,
        quantity: 1,
        startDate: "2026-08-09",
        characteristics: { SST_ID: "01" },
      };
      const orderResult = await createOrder(orderInput, actorId, () => NOW);
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      expect(orderResult.inventoryId).not.toBeNull();
      const inventoryId = orderResult.inventoryId!;

      const before = await getOrderDetail(orderResult.orderId, NOW);
      expect(before).not.toBeNull();
      expect(before!.item.productOfferingId).toBe(offeringId);
      expect(before!.prices.length).toBeGreaterThan(0);

      // Branch a new DRAFT version off the ordered offering, then activate
      // it through the real pm16 service — this is what actually retires
      // the sibling (Inv. #6/#13), not a direct UPDATE.
      const { offeringId: branchedId } = await db.transaction((tx) =>
        productOfferingRepository.branchOfferingAsDraft(tx, offeringId),
      );
      const activateResult = await activateOffering(branchedId, {}, actorId);
      expect(activateResult).toMatchObject({
        ok: true,
        supersededOfferingId: offeringId,
      });

      const [retiredOffering] = await db
        .select({ lifecycleStatus: productOffering.lifecycleStatus })
        .from(productOffering)
        .where(eq(productOffering.productOfferingId, offeringId));
      expect(retiredOffering?.lifecycleStatus).toBe("RETIRED");

      const [subscription] = await db
        .select({ productOfferingId: productInventory.productOfferingId })
        .from(productInventory)
        .where(eq(productInventory.productInventoryId, inventoryId));
      expect(subscription?.productOfferingId).toBe(offeringId);

      const after = await getOrderDetail(orderResult.orderId, NOW);
      expect(after).not.toBeNull();
      expect(after!.item.productOfferingId).toBe(
        before!.item.productOfferingId,
      );
      expect(after!.item.offeringVersion).toBe(before!.item.offeringVersion);
      expect(after!.prices).toEqual(before!.prices);
    });

    // Guardrail 17 (code-standards §9): the pm32 derivability helper
    // (`assertInventoryGapFree`) run across every instance this file created
    // — the standard-order-only instance from guardrail 16 above plus a
    // second instance driven through a suspend+resume cycle here — and a
    // direct proof that transitions never regress in `effective_date` when
    // read in insertion order (the ordering `deriveSuspensionWindows`
    // depends on, findByInventoryId's own `inventoryStatusHistoryId`-order
    // rationale).
    it("guardrail 17 — every instance is gap-free and its history never regresses in effective_date", async () => {
      const partyRoleId = await newPartyRole("PMSHIPGATE-GapFree");
      const banId = await newBillingAccount(partyRoleId);
      const offeringId = await newActiveOfferingWithResolvedSpec();

      const orderResult = await createOrder(
        {
          customerPartyRoleId: partyRoleId,
          billingAccountId: banId,
          productOfferingId: offeringId,
          quantity: 1,
          startDate: "2026-08-09",
          characteristics: { SST_ID: "01" },
        },
        actorId,
        () => NOW,
      );
      expect(orderResult.ok).toBe(true);
      if (!orderResult.ok) return;
      const inventoryId = orderResult.inventoryId!;

      const suspendResult = await suspendSubscription(
        {
          inventoryId,
          effectiveDate: "2026-08-10",
          reason: "PMSHIPGATE sweep fixture",
        },
        actorId,
        () => NOW,
      );
      expect(suspendResult.ok).toBe(true);

      const resumeResult = await resumeSubscription(
        { inventoryId, effectiveDate: "2026-08-20" },
        actorId,
        () => NOW,
      );
      expect(resumeResult.ok).toBe(true);

      // Every product_inventory row this file has created so far — "every
      // seeded + test-created instance" (guardrail 17's own wording) — both
      // this test's own fixture and guardrail 16's grandfathering instance.
      const allInstances = await db
        .select({ id: productInventory.productInventoryId })
        .from(productInventory);
      expect(allInstances.length).toBeGreaterThanOrEqual(2);

      for (const { id } of allInstances) {
        await assertInventoryGapFree(db, id);

        const history =
          await inventoryStatusHistoryRepository.findByInventoryId(db, id);
        expect(history.length).toBeGreaterThanOrEqual(1);
        expect(history[0]!.fromStatus).toBeNull();
        for (let i = 1; i < history.length; i++) {
          expect(
            history[i]!.effectiveDate >= history[i - 1]!.effectiveDate,
          ).toBe(true);
        }
      }

      const thisInstanceHistory =
        await inventoryStatusHistoryRepository.findByInventoryId(
          db,
          inventoryId,
        );
      expect(thisInstanceHistory.map((h) => h.toStatus)).toEqual([
        "ACTIVE",
        "SUSPENDED",
        "ACTIVE",
      ]);
    });
  },
);
