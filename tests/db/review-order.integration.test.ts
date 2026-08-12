import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import * as auditRepository from "@/db/repositories/audit.repository";
import { appuser } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { roleAssign } from "@/db/schema/role-assign";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import { productOrder, productOrderItem } from "@/db/schema/ordering";
import { productInventory } from "@/db/schema/inventory";
import { auditLog } from "@/db/schema/audit";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { approveOrder as ApproveOrder } from "@/services/ordering/review-order";
import type { rejectOrder as RejectOrder } from "@/services/ordering/review-order";
import type { createOrder as CreateOrder } from "@/services/ordering/create-order";

// pm30-spec §3 — live-DB integration + concurrency proof for `approveOrder` /
// `rejectOrder`. Happy approve (instantiation + reviewed stamps), reject
// (terminal, no inventory), the SELF_REVIEW service guard AND the DB CHECK,
// NOT_MANAGER with live role resolution, the stale-approval re-validation, and
// the approve-vs-approve / approve-vs-reject races run repeatedly. Every ad hoc
// name carries the `PMREVVERIFY-` prefix (spec verification-checklist
// convention).
const databaseUrl = process.env.DATABASE_URL;

// Pinned so the fixture's flat recurring price (effective 2026-01-01) and the
// order start dates below stay inside the 3-day backdating tolerance.
const NOW = new Date("2026-08-10T00:00:00Z");
const CURRENCY = "MYR";
const RACE_RUNS = 4; // spec: run each race ≥ 4× with consistent outcomes

describe.skipIf(!databaseUrl)(
  "approveOrder / rejectOrder (pm30-spec §3, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let approveOrder: typeof ApproveOrder;
    let rejectOrder: typeof RejectOrder;
    let createOrder: typeof CreateOrder;

    let submitterId: string; // never holds MANAGER
    let managerId: string; // holds MANAGER, ≠ submitter
    let managerRoleId: string;
    let cycleId: string;
    let goodOfferingId: string; // ACTIVE, billing-only, sellable; flat recurring price

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

    async function assignManager(userId: string): Promise<void> {
      await db
        .insert(roleAssign)
        .values({ refUserId: userId, refRoleId: managerRoleId })
        .onConflictDoNothing();
    }

    async function revokeManager(userId: string): Promise<void> {
      await db
        .delete(roleAssign)
        .where(
          and(
            eq(roleAssign.refUserId, userId),
            eq(roleAssign.refRoleId, managerRoleId),
          ),
        );
    }

    async function newPartyRole(orgName: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: orgName,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: submitterId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: submitterId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      return role!.partyRoleId;
    }

    async function newBillingAccount(partyRoleId: string): Promise<string> {
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "PMREVVERIFY-FA",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: submitterId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "PMREVVERIFY-BAN",
          state: "active",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: submitterId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newOffering(): Promise<string> {
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "PMREVVERIFY-Offering",
          isBundle: false,
          isSellable: true,
          billingOnly: true,
          lifecycleStatus: "ACTIVE",
          version: 1,
          lastEditedBy: null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;
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

    // A fresh PENDING override order (its own party + BAN so races never
    // collide), submitted by `submittedBy`.
    async function newPendingOrder(
      submittedBy: string,
    ): Promise<{ orderId: string; partyRoleId: string }> {
      const partyRoleId = await newPartyRole("PMREVVERIFY-Customer");
      const banId = await newBillingAccount(partyRoleId);
      const result = await createOrder(
        {
          customerPartyRoleId: partyRoleId,
          billingAccountId: banId,
          productOfferingId: goodOfferingId,
          quantity: 1,
          startDate: "2026-08-09",
          characteristics: { SST_ID: "01" },
          overrides: [
            { priceType: "recurring", amount: "420.00", currency: CURRENCY },
          ],
        },
        submittedBy,
        () => NOW,
      );
      if (!result.ok) {
        throw new Error(`fixture order did not park PENDING: ${result.code}`);
      }
      expect(result.status).toBe("PENDING");
      return { orderId: result.orderId, partyRoleId };
    }

    async function orderStatus(orderId: string): Promise<string | undefined> {
      const [row] = await db
        .select({ status: productOrder.status })
        .from(productOrder)
        .where(eq(productOrder.productOrderId, orderId));
      return row?.status;
    }

    async function inventoryCountForOrder(orderId: string): Promise<number> {
      const [row] = await db
        .select({ total: count() })
        .from(productInventory)
        .innerJoin(
          productOrderItem,
          eq(
            productOrderItem.productOrderItemId,
            productInventory.productOrderItemId,
          ),
        )
        .where(eq(productOrderItem.productOrderId, orderId));
      return row?.total ?? 0;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Real services use their own @/db/client pool — dynamic import after
      // confirming DATABASE_URL (create-order.integration precedent).
      const reviewMod = await import("@/services/ordering/review-order");
      approveOrder = reviewMod.approveOrder;
      rejectOrder = reviewMod.rejectOrder;
      const createMod = await import("@/services/ordering/create-order");
      createOrder = createMod.createOrder;

      submitterId = await newAppUser("PMREVVERIFY Submitter");
      managerId = await newAppUser("PMREVVERIFY Manager");

      const [role] = await db
        .insert(roles)
        .values({ roleName: "MANAGER", roleDescr: "PMREVVERIFY manager role" })
        .returning({ roleId: roles.roleId });
      managerRoleId = role!.roleId;
      await assignManager(managerId);

      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "PMREVVERIFY Cycle", lastEditedBy: submitterId })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;

      goodOfferingId = await newOffering();
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    describe("approve (happy path)", () => {
      it("instantiates the subscription, completes the order, stamps reviewed_by/at, writes 3 audit rows", async () => {
        const { orderId } = await newPendingOrder(submitterId);

        // Capture audit emission (call) order. The ULID `audit_id` is not
        // monotonic within a transaction (48-bit ms + 80-bit random) and
        // `created_datetime` is the shared tx-start instant, so DB row order
        // can't prove sequencing — the spy on the write itself can. `spyOn`
        // calls through by default, so the real audit rows are still written.
        const auditSpy = vi.spyOn(auditRepository, "insertAuditEvent");

        const result = await approveOrder(orderId, managerId, () => NOW);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.status).toBe("COMPLETED");
        expect(result.inventoryId).not.toBeNull();

        const [order] = await db
          .select()
          .from(productOrder)
          .where(eq(productOrder.productOrderId, orderId));
        expect(order?.status).toBe("COMPLETED");
        expect(order?.reviewedBy).toBe(managerId);
        expect(order?.reviewedAt).not.toBeNull();
        expect(order?.completedAt).not.toBeNull();

        const [inventory] = await db
          .select()
          .from(productInventory)
          .where(eq(productInventory.productInventoryId, result.inventoryId!));
        expect(inventory?.status).toBe("ACTIVE");
        expect(inventory?.instanceCharacteristics).toEqual({ SST_ID: "01" });

        expect(await inventoryCountForOrder(orderId)).toBe(1);

        const orderEvents = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, orderId));
        // CREATED + PENDING_APPROVAL (from submission) then APPROVED + COMPLETED.
        expect(orderEvents.map((e) => e.eventType)).toContain(
          "PRODUCT_ORDER_APPROVED",
        );
        expect(orderEvents.map((e) => e.eventType)).toContain(
          "PRODUCT_ORDER_COMPLETED",
        );

        // Emission order within the approval transaction: APPROVED is written
        // before instantiation's INVENTORY_CREATED and the order's COMPLETED.
        expect(auditSpy.mock.calls.map((call) => call[1].eventType)).toEqual([
          "PRODUCT_ORDER_APPROVED",
          "PRODUCT_INVENTORY_CREATED",
          "PRODUCT_ORDER_COMPLETED",
        ]);

        const inventoryEvents = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, result.inventoryId!));
        expect(inventoryEvents.map((e) => e.eventType)).toEqual([
          "PRODUCT_INVENTORY_CREATED",
        ]);
      });
    });

    describe("reject (terminal, no inventory)", () => {
      it("sets REJECTED with the reason and reviewed stamps, instantiates nothing", async () => {
        const { orderId } = await newPendingOrder(submitterId);

        const result = await rejectOrder(
          orderId,
          managerId,
          "Price not approved by finance",
          () => NOW,
        );
        expect(result).toMatchObject({
          ok: true,
          status: "REJECTED",
          inventoryId: null,
        });

        const [order] = await db
          .select()
          .from(productOrder)
          .where(eq(productOrder.productOrderId, orderId));
        expect(order?.status).toBe("REJECTED");
        expect(order?.failureReason).toBe("Price not approved by finance");
        expect(order?.reviewedBy).toBe(managerId);
        expect(order?.reviewedAt).not.toBeNull();
        expect(order?.completedAt).toBeNull();

        expect(await inventoryCountForOrder(orderId)).toBe(0);

        const events = await db
          .select({ eventType: auditLog.eventType })
          .from(auditLog)
          .where(eq(auditLog.targetId, orderId));
        expect(events.map((e) => e.eventType)).toContain(
          "PRODUCT_ORDER_REJECTED",
        );
        expect(events.map((e) => e.eventType)).not.toContain(
          "PRODUCT_ORDER_COMPLETED",
        );
      });
    });

    describe("self-review", () => {
      it("SELF_REVIEW — the submitter (who happens to hold MANAGER) cannot review their own order; order stays PENDING", async () => {
        // Grant MANAGER to a submitter just for this case, then submit + try to
        // self-approve.
        const selfManagerId = await newAppUser("PMREVVERIFY SelfManager");
        await assignManager(selfManagerId);
        const { orderId } = await newPendingOrder(selfManagerId);

        const result = await approveOrder(orderId, selfManagerId, () => NOW);
        expect(result).toEqual({ ok: false, code: "SELF_REVIEW" });
        expect(await orderStatus(orderId)).toBe("PENDING");
        expect(await inventoryCountForOrder(orderId)).toBe(0);
      });

      it("the DB CHECK reviewed_by <> submitted_by rejects a direct SQL self-review write", async () => {
        const { orderId } = await newPendingOrder(submitterId);
        await expect(
          db
            .update(productOrder)
            .set({ reviewedBy: submitterId })
            .where(eq(productOrder.productOrderId, orderId)),
        ).rejects.toThrow();
      });
    });

    describe("role authority (live per-request resolution, platform Inv. #15)", () => {
      it("NOT_MANAGER — a caller without the MANAGER role is refused, and a grant/revoke takes effect on the very next call", async () => {
        const roamingId = await newAppUser("PMREVVERIFY Roaming");

        // No MANAGER grant yet → refused before any transaction opens.
        const first = await newPendingOrder(submitterId);
        expect(await approveOrder(first.orderId, roamingId, () => NOW)).toEqual(
          {
            ok: false,
            code: "NOT_MANAGER",
          },
        );
        expect(await orderStatus(first.orderId)).toBe("PENDING");

        // Grant MANAGER → the next call passes the role gate and approves.
        await assignManager(roamingId);
        const second = await newPendingOrder(submitterId);
        const granted = await approveOrder(
          second.orderId,
          roamingId,
          () => NOW,
        );
        expect(granted.ok).toBe(true);

        // Revoke MANAGER → refused again on the next call, no caching.
        await revokeManager(roamingId);
        const third = await newPendingOrder(submitterId);
        expect(await approveOrder(third.orderId, roamingId, () => NOW)).toEqual(
          {
            ok: false,
            code: "NOT_MANAGER",
          },
        );
        expect(await orderStatus(third.orderId)).toBe("PENDING");
      });
    });

    describe("guards", () => {
      it("ORDER_NOT_FOUND — unknown order id", async () => {
        expect(
          await approveOrder("PRDORD99999999", managerId, () => NOW),
        ).toEqual({ ok: false, code: "ORDER_NOT_FOUND" });
      });

      it("ORDER_NOT_PENDING — approving an already-COMPLETED order", async () => {
        const { orderId } = await newPendingOrder(submitterId);
        expect((await approveOrder(orderId, managerId, () => NOW)).ok).toBe(
          true,
        );
        // A second approval finds it COMPLETED.
        expect(await approveOrder(orderId, managerId, () => NOW)).toEqual({
          ok: false,
          code: "ORDER_NOT_PENDING",
        });
      });
    });

    describe("stale approval (re-validation under locks, architecture Inv. #19)", () => {
      it("a party suspended after submission fails CUSTOMER_NOT_ACTIVE; order stays PENDING, zero inventory", async () => {
        const { orderId, partyRoleId } = await newPendingOrder(submitterId);

        // The party goes bad between submission and approval.
        await db
          .update(partyRole)
          .set({ status: "SUSPENDED" })
          .where(eq(partyRole.partyRoleId, partyRoleId));

        expect(await approveOrder(orderId, managerId, () => NOW)).toEqual({
          ok: false,
          code: "CUSTOMER_NOT_ACTIVE",
        });
        expect(await orderStatus(orderId)).toBe("PENDING");
        expect(await inventoryCountForOrder(orderId)).toBe(0);
      });
    });

    describe("concurrency (pm16 discipline — run repeatedly)", () => {
      it("two concurrent approves → exactly one COMPLETED + one ORDER_NOT_PENDING, exactly one inventory row", async () => {
        for (let run = 0; run < RACE_RUNS; run++) {
          const { orderId } = await newPendingOrder(submitterId);

          const [a, b] = await Promise.all([
            approveOrder(orderId, managerId, () => NOW),
            approveOrder(orderId, managerId, () => NOW),
          ]);

          const outcomes = [a, b];
          const winners = outcomes.filter((r) => r.ok);
          const losers = outcomes.filter(
            (r) => !r.ok && r.code === "ORDER_NOT_PENDING",
          );
          expect(winners).toHaveLength(1);
          expect(losers).toHaveLength(1);
          expect(await orderStatus(orderId)).toBe("COMPLETED");
          expect(await inventoryCountForOrder(orderId)).toBe(1);
        }
      });

      it("approve vs reject → exactly one winner, never both effects", async () => {
        for (let run = 0; run < RACE_RUNS; run++) {
          const { orderId } = await newPendingOrder(submitterId);

          const [approveRes, rejectRes] = await Promise.all([
            approveOrder(orderId, managerId, () => NOW),
            rejectOrder(orderId, managerId, "raced reject", () => NOW),
          ]);

          const outcomes = [approveRes, rejectRes];
          expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
          expect(
            outcomes.filter((r) => !r.ok && r.code === "ORDER_NOT_PENDING"),
          ).toHaveLength(1);

          const finalStatus = await orderStatus(orderId);
          const inventory = await inventoryCountForOrder(orderId);
          if (finalStatus === "COMPLETED") {
            expect(approveRes.ok).toBe(true);
            expect(inventory).toBe(1);
          } else {
            expect(finalStatus).toBe("REJECTED");
            expect(rejectRes.ok).toBe(true);
            expect(inventory).toBe(0);
          }
        }
      });
    });
  },
);
