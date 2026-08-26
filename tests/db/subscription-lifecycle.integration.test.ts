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
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import { orderItemPriceOverride } from "@/db/schema/ordering";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";
import { inventoryStatusHistoryRepository } from "@/db/repositories/inventory/inventory-status-history.repository";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { assertInventoryGapFree } from "@/tests/helpers/assert-inventory-gap-free";
import type { createOrder as CreateOrder } from "@/services/ordering/create-order";
import type { CreateOrderInput } from "@/validation/ordering/create-order.schema";
import type { suspendSubscription as SuspendSubscription } from "@/services/inventory/suspend-subscription";
import type { resumeSubscription as ResumeSubscription } from "@/services/inventory/resume-subscription";
import type { terminateSubscription as TerminateSubscription } from "@/services/inventory/terminate-subscription";
import type { updateInstanceCharacteristics as UpdateInstanceCharacteristics } from "@/services/inventory/update-instance-characteristics";
import type { listSubscriptions as ListSubscriptions } from "@/services/inventory/list-subscriptions";
import type { getSubscriptionDetail as GetSubscriptionDetail } from "@/services/inventory/get-subscription-detail";

// pm32-spec §3 — live-DB integration + concurrency proof for the four
// lifecycle write services plus the two read services. `PMSUBVERIFY-` prefix
// convention (spec verification-checklist) is carried by every ad hoc name
// inserted below.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";
const RACE_RUNS = 4; // spec: run each race ≥ 4× with consistent outcomes

describe.skipIf(!databaseUrl)(
  "subscription lifecycle + read services (pm32-spec §3, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let suspendSubscription: typeof SuspendSubscription;
    let resumeSubscription: typeof ResumeSubscription;
    let terminateSubscription: typeof TerminateSubscription;
    let updateInstanceCharacteristics: typeof UpdateInstanceCharacteristics;
    let listSubscriptions: typeof ListSubscriptions;
    let getSubscriptionDetail: typeof GetSubscriptionDetail;
    let createOrder: typeof CreateOrder;

    let actorId: string;
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

    async function newPartyRole(): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: "PMSUBVERIFY-Customer",
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
          name: "PMSUBVERIFY-FA",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "PMSUBVERIFY-BAN",
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

    async function newOffering(
      lifecycleStatus: "ACTIVE" | "RETIRED" = "ACTIVE",
    ): Promise<string> {
      const [offering] = await db
        .insert(productOffering)
        .values({
          name: "PMSUBVERIFY-Offering",
          isBundle: false,
          isSellable: true,
          billingOnly: true,
          lifecycleStatus,
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

    // A fresh ACTIVE subscription (its own party + BAN so races never
    // collide), standard (no-override) path — auto-completes and instantiates.
    async function newSubscription(opts?: {
      startDate?: string;
      now?: Date;
      offeringId?: string;
    }): Promise<string> {
      const startDate = opts?.startDate ?? "2026-08-01";
      const partyRoleId = await newPartyRole();
      const banId = await newBillingAccount(partyRoleId);
      const input: CreateOrderInput = {
        customerPartyRoleId: partyRoleId,
        billingAccountId: banId,
        productOfferingId: opts?.offeringId ?? goodOfferingId,
        quantity: 1,
        startDate,
        characteristics: { SST_ID: "01" },
      };
      const result = await createOrder(
        input,
        actorId,
        () => opts?.now ?? new Date(`${startDate}T00:00:00Z`),
      );
      if (!result.ok || result.status !== "COMPLETED" || !result.inventoryId) {
        throw new Error(
          `fixture subscription did not instantiate: ${JSON.stringify(result)}`,
        );
      }
      return result.inventoryId;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
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

      // Real services use their own @/db/client pool — dynamic import after
      // confirming DATABASE_URL (create-order.integration precedent).
      const suspendMod =
        await import("@/services/inventory/suspend-subscription");
      suspendSubscription = suspendMod.suspendSubscription;
      const resumeMod =
        await import("@/services/inventory/resume-subscription");
      resumeSubscription = resumeMod.resumeSubscription;
      const terminateMod =
        await import("@/services/inventory/terminate-subscription");
      terminateSubscription = terminateMod.terminateSubscription;
      const updateCharMod =
        await import("@/services/inventory/update-instance-characteristics");
      updateInstanceCharacteristics =
        updateCharMod.updateInstanceCharacteristics;
      const listMod = await import("@/services/inventory/list-subscriptions");
      listSubscriptions = listMod.listSubscriptions;
      const detailMod =
        await import("@/services/inventory/get-subscription-detail");
      getSubscriptionDetail = detailMod.getSubscriptionDetail;
      const createOrderMod = await import("@/services/ordering/create-order");
      createOrder = createOrderMod.createOrder;

      actorId = await newAppUser("PMSUBVERIFY Actor");

      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "PMSUBVERIFY Cycle", lastEditedBy: actorId })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;

      goodOfferingId = await newOffering();
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

    describe("suspend + resume", () => {
      it("suspend 08-10 + resume 08-20 → exactly two history rows; suspensionWindows [{from,to}]", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });

        const suspendResult = await suspendSubscription(
          {
            inventoryId,
            effectiveDate: "2026-08-10",
            reason: "PMSUBVERIFY suspend",
          },
          actorId,
          () => new Date("2026-08-10T00:00:00Z"),
        );
        expect(suspendResult).toEqual({
          ok: true,
          inventoryId,
          status: "SUSPENDED",
        });
        await assertInventoryGapFree(db, inventoryId);

        const resumeResult = await resumeSubscription(
          { inventoryId, effectiveDate: "2026-08-20" },
          actorId,
          () => new Date("2026-08-20T00:00:00Z"),
        );
        expect(resumeResult).toEqual({
          ok: true,
          inventoryId,
          status: "ACTIVE",
        });
        await assertInventoryGapFree(db, inventoryId);

        const history =
          await inventoryStatusHistoryRepository.findByInventoryId(
            db,
            inventoryId,
          );
        // Genesis row (from=null,to=ACTIVE) + suspend + resume.
        expect(history).toHaveLength(3);
        expect(history.map((h) => h.toStatus)).toEqual([
          "ACTIVE",
          "SUSPENDED",
          "ACTIVE",
        ]);

        const detail = await getSubscriptionDetail(inventoryId);
        expect(detail?.suspensionWindows).toEqual([
          { from: "2026-08-10", to: "2026-08-20" },
        ]);
      });

      it("an unresumed suspension leaves an open window (to: null)", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });

        await suspendSubscription(
          {
            inventoryId,
            effectiveDate: "2026-08-10",
            reason: "PMSUBVERIFY open suspend",
          },
          actorId,
          () => new Date("2026-08-10T00:00:00Z"),
        );
        await assertInventoryGapFree(db, inventoryId);

        const detail = await getSubscriptionDetail(inventoryId);
        expect(detail?.status).toBe("SUSPENDED");
        expect(detail?.suspensionWindows).toEqual([
          { from: "2026-08-10", to: null },
        ]);
      });
    });

    describe("illegal transitions", () => {
      it("resume on an ACTIVE subscription is rejected", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });
        const result = await resumeSubscription(
          { inventoryId, effectiveDate: "2026-08-01" },
          actorId,
          () => new Date("2026-08-01T00:00:00Z"),
        );
        expect(result).toEqual({ ok: false, code: "INVALID_TRANSITION" });
        await assertInventoryGapFree(db, inventoryId);
      });

      it("suspend, resume, terminate, and edit-characteristics are all rejected on a TERMINATED subscription", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });
        const terminateResult = await terminateSubscription(
          {
            inventoryId,
            endDate: "2026-08-05",
            reason: "PMSUBVERIFY terminate",
          },
          actorId,
          () => new Date("2026-08-05T00:00:00Z"),
        );
        expect(terminateResult.ok).toBe(true);
        await assertInventoryGapFree(db, inventoryId);

        expect(
          await suspendSubscription(
            { inventoryId, effectiveDate: "2026-08-05", reason: "x" },
            actorId,
            () => new Date("2026-08-05T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "INVALID_TRANSITION" });
        expect(
          await resumeSubscription(
            { inventoryId, effectiveDate: "2026-08-05" },
            actorId,
            () => new Date("2026-08-05T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "INVALID_TRANSITION" });
        expect(
          await terminateSubscription(
            { inventoryId, endDate: "2026-08-06", reason: "x" },
            actorId,
            () => new Date("2026-08-06T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "INVALID_TRANSITION" });
        expect(
          await updateInstanceCharacteristics(
            { inventoryId, characteristics: { SST_ID: "02" } },
            actorId,
          ),
        ).toEqual({ ok: false, code: "SUBSCRIPTION_TERMINATED" });

        await assertInventoryGapFree(db, inventoryId);
      });

      it("SUBSCRIPTION_NOT_FOUND on an unknown id", async () => {
        expect(
          await suspendSubscription(
            {
              inventoryId: "PRDINV99999999",
              effectiveDate: "2026-08-01",
              reason: "x",
            },
            actorId,
            () => new Date("2026-08-01T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "SUBSCRIPTION_NOT_FOUND" });
      });
    });

    describe("date rules", () => {
      it("backdate > 3 days rejected on suspend/resume/terminate", async () => {
        const suspendTarget = await newSubscription({
          startDate: "2026-08-01",
        });
        expect(
          await suspendSubscription(
            {
              inventoryId: suspendTarget,
              effectiveDate: "2026-08-01",
              reason: "x",
            },
            actorId,
            () => new Date("2026-08-10T00:00:00Z"), // 9 days past effectiveDate
          ),
        ).toEqual({ ok: false, code: "BACKDATED_EFFECTIVE_TOO_FAR" });
        await assertInventoryGapFree(db, suspendTarget);

        const resumeTarget = await newSubscription({ startDate: "2026-08-01" });
        await suspendSubscription(
          {
            inventoryId: resumeTarget,
            effectiveDate: "2026-08-01",
            reason: "x",
          },
          actorId,
          () => new Date("2026-08-01T00:00:00Z"),
        );
        expect(
          await resumeSubscription(
            { inventoryId: resumeTarget, effectiveDate: "2026-08-05" },
            actorId,
            () => new Date("2026-08-15T00:00:00Z"), // 10 days past effectiveDate
          ),
        ).toEqual({ ok: false, code: "BACKDATED_EFFECTIVE_TOO_FAR" });
        await assertInventoryGapFree(db, resumeTarget);

        const terminateTarget = await newSubscription({
          startDate: "2026-08-01",
        });
        expect(
          await terminateSubscription(
            {
              inventoryId: terminateTarget,
              endDate: "2026-08-02",
              reason: "x",
            },
            actorId,
            () => new Date("2026-08-12T00:00:00Z"), // 10 days past endDate
          ),
        ).toEqual({ ok: false, code: "BACKDATED_EFFECTIVE_TOO_FAR" });
        await assertInventoryGapFree(db, terminateTarget);
      });

      it("EFFECTIVE_DATE_BEFORE_PRIOR rejected — a new transition can't precede the latest history row", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });
        await suspendSubscription(
          { inventoryId, effectiveDate: "2026-08-10", reason: "x" },
          actorId,
          () => new Date("2026-08-10T00:00:00Z"),
        );
        // A resume dated before the suspend's own effective date.
        expect(
          await resumeSubscription(
            { inventoryId, effectiveDate: "2026-08-08" },
            actorId,
            () => new Date("2026-08-08T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "EFFECTIVE_DATE_BEFORE_PRIOR" });
        await assertInventoryGapFree(db, inventoryId);
      });

      it("END_BEFORE_START rejected — terminate can't precede the subscription's own start_date", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-15" });
        expect(
          await terminateSubscription(
            { inventoryId, endDate: "2026-08-10", reason: "x" },
            actorId,
            () => new Date("2026-08-10T00:00:00Z"),
          ),
        ).toEqual({ ok: false, code: "END_BEFORE_START" });
        await assertInventoryGapFree(db, inventoryId);
      });
    });

    describe("edit instance characteristics", () => {
      it("updates the record and audits before/after, without touching status/dates", async () => {
        const inventoryId = await newSubscription({ startDate: "2026-08-01" });
        const result = await updateInstanceCharacteristics(
          { inventoryId, characteristics: { SST_ID: "02", NOTE: "updated" } },
          actorId,
        );
        expect(result).toEqual({ ok: true, inventoryId });

        const row = await productInventoryRepository.findById(db, inventoryId);
        expect(row?.instanceCharacteristics).toEqual({
          SST_ID: "02",
          NOTE: "updated",
        });
        expect(row?.status).toBe("ACTIVE");
        expect(row?.startDate).toBe("2026-08-01");
      });
    });

    describe("concurrency (pm16 discipline — run repeatedly)", () => {
      it("two concurrent suspends on the same ACTIVE subscription → one SUSPENDED, one INVALID_TRANSITION", async () => {
        for (let run = 0; run < RACE_RUNS; run++) {
          const inventoryId = await newSubscription({
            startDate: "2026-08-01",
          });

          const [a, b] = await Promise.all([
            suspendSubscription(
              {
                inventoryId,
                effectiveDate: "2026-08-10",
                reason: "race a",
              },
              actorId,
              () => new Date("2026-08-10T00:00:00Z"),
            ),
            suspendSubscription(
              {
                inventoryId,
                effectiveDate: "2026-08-10",
                reason: "race b",
              },
              actorId,
              () => new Date("2026-08-10T00:00:00Z"),
            ),
          ]);

          const outcomes = [a, b];
          expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
          expect(
            outcomes.filter((r) => !r.ok && r.code === "INVALID_TRANSITION"),
          ).toHaveLength(1);

          const row = await productInventoryRepository.findById(
            db,
            inventoryId,
          );
          expect(row?.status).toBe("SUSPENDED");
          await assertInventoryGapFree(db, inventoryId);

          const history =
            await inventoryStatusHistoryRepository.findByInventoryId(
              db,
              inventoryId,
            );
          expect(history.map((h) => h.toStatus)).toEqual([
            "ACTIVE",
            "SUSPENDED",
          ]);
        }
      });

      it("suspend vs terminate on the same ACTIVE subscription → terminate always wins eventually, history stays gap-free", async () => {
        for (let run = 0; run < RACE_RUNS; run++) {
          const inventoryId = await newSubscription({
            startDate: "2026-08-01",
          });

          const [suspendResult, terminateResult] = await Promise.all([
            suspendSubscription(
              { inventoryId, effectiveDate: "2026-08-10", reason: "race" },
              actorId,
              () => new Date("2026-08-10T00:00:00Z"),
            ),
            terminateSubscription(
              { inventoryId, endDate: "2026-08-10", reason: "race" },
              actorId,
              () => new Date("2026-08-10T00:00:00Z"),
            ),
          ]);

          // Terminate is legal from either ACTIVE or SUSPENDED, so it always
          // succeeds regardless of lock order; suspend only succeeds if it
          // wins the row lock ahead of terminate, else TERMINATED (terminal)
          // rejects it.
          expect(terminateResult.ok).toBe(true);
          if (!suspendResult.ok) {
            expect(suspendResult.code).toBe("INVALID_TRANSITION");
          }

          const row = await productInventoryRepository.findById(
            db,
            inventoryId,
          );
          expect(row?.status).toBe("TERMINATED");
          await assertInventoryGapFree(db, inventoryId);

          const history =
            await inventoryStatusHistoryRepository.findByInventoryId(
              db,
              inventoryId,
            );
          // Never both a suspend win AND an out-of-order/contradictory row:
          // either [ACTIVE, TERMINATED] (terminate won the lock) or
          // [ACTIVE, SUSPENDED, TERMINATED] (suspend won it first).
          const toStatuses = history.map((h) => h.toStatus);
          expect(toStatuses.length === 2 || toStatuses.length === 3).toBe(true);
          expect(toStatuses[toStatuses.length - 1]).toBe("TERMINATED");
        }
      });
    });

    describe("read services", () => {
      it("listSubscriptions reflects hasOverride via the order item's override rows", async () => {
        const plainId = await newSubscription({ startDate: "2026-08-01" });
        const overriddenId = await newSubscription({ startDate: "2026-08-01" });

        const overriddenRow = await productInventoryRepository.findById(
          db,
          overriddenId,
        );
        // Direct fixture insert (not the real approval flow) — proves the
        // repository's correlated-exists join alone, per pm32-spec's
        // disclosed additive `hasOverride` field.
        await db.insert(orderItemPriceOverride).values({
          productOrderItemId: overriddenRow!.productOrderItemId,
          priceType: "recurring",
          amount: "420.00",
          currency: CURRENCY,
        });

        const page = await listSubscriptions({
          q: "PMSUBVERIFY",
          status: null,
          sort: "-start_date",
          page: 1,
          subscription: null,
        });
        const plainRow = page.rows.find((r) => r.inventoryId === plainId);
        const overriddenListRow = page.rows.find(
          (r) => r.inventoryId === overriddenId,
        );
        expect(plainRow?.hasOverride).toBe(false);
        expect(overriddenListRow?.hasOverride).toBe(true);
      });

      it("a pinned RETIRED offering version still lists and details (Inv. #17)", async () => {
        const retiredOfferingId = await newOffering("ACTIVE");
        // A distinctive far-future start date so this row sorts to page 1's
        // top under the list's default `-start_date` sort, regardless of how
        // many other fixture subscriptions this file has already created.
        const inventoryId = await newSubscription({
          startDate: "2026-12-31",
          offeringId: retiredOfferingId,
        });
        await db
          .update(productOffering)
          .set({ lifecycleStatus: "RETIRED" })
          .where(eq(productOffering.productOfferingId, retiredOfferingId));

        const page = await listSubscriptions({
          q: "",
          status: null,
          sort: "-start_date",
          page: 1,
          subscription: null,
        });
        expect(page.rows.some((r) => r.inventoryId === inventoryId)).toBe(true);

        const detail = await getSubscriptionDetail(inventoryId);
        expect(detail?.offeringVersion).toBe(1);
      });

      it("getSubscriptionDetail returns null for an unknown id", async () => {
        expect(await getSubscriptionDetail("PRDINV99999999")).toBeNull();
      });
    });
  },
);
