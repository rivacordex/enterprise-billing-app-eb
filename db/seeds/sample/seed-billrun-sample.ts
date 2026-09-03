import { eq, inArray, and } from "drizzle-orm";

import { db } from "@/db/client";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { todayInZone } from "@/lib/timezone";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { ledgerBinding } from "@/db/schema/billing/ledger-binding";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import {
  productOrder,
  productOrderItem,
  orderItemPriceOverride,
} from "@/db/schema/ordering";
import {
  productInventory,
  inventoryStatusHistory,
} from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { billingAccountRepository } from "@/db/repositories/accounts/billing-account.repository";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import { createCustomer } from "@/services/customer/create-customer";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { transitionCustomerStatus } from "@/services/customer/transition-customer-status";
import { createOrder } from "@/services/ordering/create-order";
import { currentDuePeriod } from "@/services/billing/derive-periods";
import {
  buildSampleUdrRatedRow,
  type SampleUdrRatedRow,
} from "@/db/seeds/sample/udr-rated-sample";
import { getOrCreateAppUser } from "@/db/seeds/sample/get-or-create-appuser";

// bm15-spec. Standalone seed script (`npm run db:seed-sample`) — **never**
// added to `db:setup` (D32: sample data is opt-in, dev/test/demo only). Own
// `main()`, uses the app's own `@/db/client` singleton (unlike its
// data-fixture siblings) because it deliberately drives the real
// createCustomer → onboardCustomerAccounts → createOrder service path so the
// fixture can't drift out of shape with what the app actually produces
// (bm15-spec §Design "Composed from real services").

const CURRENCY = "MYR" as const;
const SAMPLE_REGISTRATION_NUMBER = "_SAMPLE_-BILLRUN-0001";
const SAMPLE_CUSTOMER_NAME = "_SAMPLE_ Nusantara Demo Sdn Bhd";
const SAMPLE_OFFERING_NAME = "_SAMPLE_ 5G Demo Plan";
const SAMPLE_PRICE_NAME = "_SAMPLE_ Monthly Recurring Charge";
const SAMPLE_RECURRING_AMOUNT = "199.00";

// bm15-spec §Design — the two hard rules that make this data impossible to
// ship to prod: never in `db:setup`, and refuses to run against a production
// target. Aborts loudly, before any write.
function assertNonProductionTarget(): void {
  if (process.env.ALLOW_SAMPLE_SEED === "true") {
    logger.warn(
      "db:seed-sample: ALLOW_SAMPLE_SEED=true — proceeding without the non-prod host check.",
    );
    return;
  }

  const NON_PROD_HOSTS = new Set(["localhost", "127.0.0.1", "db", "postgres"]);
  let host: string;
  try {
    host = new URL(config.DATABASE_URL).hostname;
  } catch {
    throw new Error(
      "db:seed-sample refused: DATABASE_URL could not be parsed as a URL.",
    );
  }

  const isNonProdHost = NON_PROD_HOSTS.has(host);
  const isNonProdEnv = config.NODE_ENV !== "production";

  if (!isNonProdHost || !isNonProdEnv) {
    throw new Error(
      `db:seed-sample refused: this looks like a production target ` +
        `(host="${host}", NODE_ENV="${config.NODE_ENV}"). This seed writes ` +
        `unmistakably-fake "_SAMPLE_" billing data and must never run ` +
        `against production. Set ALLOW_SAMPLE_SEED=true to override for a ` +
        `deliberate non-local demo box.`,
    );
  }
}

// bm15-spec §Design "Idempotent + re-runnable" — purges any prior _SAMPLE_*
// graph (keyed on the sample customer's registration number) in FK-safe
// order before rebuilding, so a re-run is clean. A no-op on the first run.
async function purgeSampleGraph(): Promise<void> {
  await db.transaction(async (tx) => {
    const [org] = await tx
      .select({ organizationId: organization.organizationId })
      .from(organization)
      .where(eq(organization.registrationNumber, SAMPLE_REGISTRATION_NUMBER))
      .limit(1);

    if (org) {
      const [role] = await tx
        .select({ partyRoleId: partyRole.partyRoleId })
        .from(partyRole)
        .where(eq(partyRole.engagedParty, org.organizationId))
        .limit(1);

      if (role) {
        const bans = await tx
          .select({ billingAccountId: billingAccount.billingAccountId })
          .from(billingAccount)
          .where(eq(billingAccount.refPartyRoleId, role.partyRoleId));
        const banIds = bans.map((b) => b.billingAccountId);

        const fas = await tx
          .select({ financialAccountId: financialAccount.financialAccountId })
          .from(financialAccount)
          .where(eq(financialAccount.refPartyRoleId, role.partyRoleId));
        const faIds = fas.map((f) => f.financialAccountId);

        if (banIds.length > 0) {
          await tx.delete(udrRated).where(inArray(udrRated.billrunBanId, banIds));

          const inventories = await tx
            .select({ productInventoryId: productInventory.productInventoryId })
            .from(productInventory)
            .where(inArray(productInventory.billingAccountId, banIds));
          const inventoryIds = inventories.map((i) => i.productInventoryId);
          if (inventoryIds.length > 0) {
            await tx
              .delete(inventoryStatusHistory)
              .where(
                inArray(
                  inventoryStatusHistory.productInventoryId,
                  inventoryIds,
                ),
              );
            await tx
              .delete(productInventory)
              .where(inArray(productInventory.productInventoryId, inventoryIds));
          }

          const orders = await tx
            .select({ productOrderId: productOrder.productOrderId })
            .from(productOrder)
            .where(inArray(productOrder.billingAccountId, banIds));
          const orderIds = orders.map((o) => o.productOrderId);
          if (orderIds.length > 0) {
            const items = await tx
              .select({
                productOrderItemId: productOrderItem.productOrderItemId,
              })
              .from(productOrderItem)
              .where(inArray(productOrderItem.productOrderId, orderIds));
            const itemIds = items.map((i) => i.productOrderItemId);
            if (itemIds.length > 0) {
              await tx
                .delete(orderItemPriceOverride)
                .where(
                  inArray(orderItemPriceOverride.productOrderItemId, itemIds),
                );
            }
            await tx
              .delete(productOrderItem)
              .where(inArray(productOrderItem.productOrderId, orderIds));
            await tx
              .delete(productOrder)
              .where(inArray(productOrder.productOrderId, orderIds));
          }

          await tx
            .delete(ledgerBinding)
            .where(
              and(
                eq(ledgerBinding.ownerType, "billing_account"),
                inArray(ledgerBinding.ownerId, banIds),
              ),
            );
          await tx
            .delete(billingAccount)
            .where(inArray(billingAccount.billingAccountId, banIds));
        }

        if (faIds.length > 0) {
          await tx
            .delete(ledgerBinding)
            .where(
              and(
                eq(ledgerBinding.ownerType, "financial_account"),
                inArray(ledgerBinding.ownerId, faIds),
              ),
            );
          await tx
            .delete(financialAccount)
            .where(inArray(financialAccount.financialAccountId, faIds));
        }

        await tx
          .delete(partyRole)
          .where(eq(partyRole.partyRoleId, role.partyRoleId));
      }

      await tx
        .delete(organization)
        .where(eq(organization.organizationId, org.organizationId));

      logger.info("db:seed-sample: purged prior _SAMPLE_ billrun graph.");
    }

    const [offering] = await tx
      .select({ productOfferingId: productOffering.productOfferingId })
      .from(productOffering)
      .where(eq(productOffering.name, SAMPLE_OFFERING_NAME))
      .limit(1);
    if (offering) {
      await tx
        .delete(productOfferingPrice)
        .where(
          eq(productOfferingPrice.productOfferingId, offering.productOfferingId),
        );
      await tx
        .delete(productOffering)
        .where(eq(productOffering.productOfferingId, offering.productOfferingId));
    }
  });
}

// A dedicated `_SAMPLE_` offering — the seeded catalog offerings
// (`db:seed-product`) are all `billingOnly: false`, which fails
// `createOrder`'s ORDERABLE precondition, so this seed is self-contained
// rather than depending on the catalog's shape (bm15-spec §Implementation §1
// footnote "or existing catalog"). Inserted directly (product.ts precedent),
// not via `createOffering`/a price-add service — neither exists as a single
// atomic "create an ACTIVE, priced, orderable offering" call.
async function ensureSampleOffering(): Promise<{
  offeringId: string;
  priceId: string;
}> {
  return db.transaction(async (tx) => {
    const [offering] = await tx
      .insert(productOffering)
      .values({
        name: SAMPLE_OFFERING_NAME,
        isBundle: false,
        isSellable: true,
        billingOnly: true,
        lifecycleStatus: "ACTIVE",
        version: 1,
        lastEditedBy: null,
      })
      .returning({ productOfferingId: productOffering.productOfferingId });
    if (!offering) {
      throw new Error("_SAMPLE_ offering insert returned no row");
    }

    const [price] = await tx
      .insert(productOfferingPrice)
      .values({
        productOfferingId: offering.productOfferingId,
        name: SAMPLE_PRICE_NAME,
        priceType: "recurring",
        recurringChargePeriodLength: 1,
        recurringChargePeriodType: "months",
        unitOfMeasure: null,
        amount: SAMPLE_RECURRING_AMOUNT,
        currency: CURRENCY,
        glCode: "GL-4100",
        pricingModel: "flat",
        policy: null,
        pricingCharacteristics: null,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      })
      .returning({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      });
    if (!price) {
      throw new Error("_SAMPLE_ offering price insert returned no row");
    }

    return {
      offeringId: offering.productOfferingId,
      priceId: price.productOfferingPriceId,
    };
  });
}

interface SampleAccount {
  billingAccountId: string;
  name: string;
  isFullPeriod: boolean;
}

// Customer + accounts (bm15-spec §Implementation §1 steps 3–4). BAN #1 is
// onboarded through the real wizard path (`onboardCustomerAccounts`) so at
// least one account is provably wired end-to-end through it; BAN #2/#3 are
// self-provisioned the same way `ordering-inventory.ts` does for its own
// story (no service exists for "add another billing account to an existing
// financial account"), reusing FA #1's `unapplied_cash`/`deposits` bindings
// and adding their own `receivables` binding.
async function createSampleCustomerAndAccounts(actorId: string): Promise<{
  partyRoleId: string;
  financialAccountId: string;
  accounts: SampleAccount[];
}> {
  const [cycle] = await db
    .select({ billCycleId: billCycle.billCycleId })
    .from(billCycle)
    .where(eq(billCycle.name, DEFAULT_BILL_CYCLE_NAME))
    .limit(1);
  if (!cycle) {
    throw new Error(
      `db:seed-sample: bill cycle "${DEFAULT_BILL_CYCLE_NAME}" not found. Run db:seed-accounts first.`,
    );
  }
  const billCycleId = cycle.billCycleId;

  const customerResult = await createCustomer(
    {
      name: SAMPLE_CUSTOMER_NAME,
      tradingName: null,
      organizationType: "COMPANY",
      registrationNumber: SAMPLE_REGISTRATION_NUMBER,
      taxId: null,
      industry: "Telecommunications",
      specificationRaw: "{}",
      confirmed: true,
    },
    actorId,
  );
  if (!customerResult.ok) {
    throw new Error(
      `db:seed-sample: createCustomer failed with code ${customerResult.code}`,
    );
  }
  const { partyRoleId } = customerResult.value;

  const onboardResult = await onboardCustomerAccounts(
    {
      partyRoleId,
      billCycleId,
      currency: CURRENCY,
      statusReason: "_SAMPLE_ billrun scenario onboarding",
      lastModifiedDatetime: new Date(),
    },
    actorId,
  );
  if (!onboardResult.ok) {
    throw new Error(
      `db:seed-sample: onboardCustomerAccounts failed with code ${onboardResult.code}`,
    );
  }
  const { financialAccountId, billingAccountId: banFull1 } =
    onboardResult.value;

  // Real wizard path can't parametrize FA/BAN names — fix them up to carry
  // the visible `_SAMPLE_` marker (D32) without re-deriving the pgledger
  // wiring it already did correctly.
  await db
    .update(financialAccount)
    .set({ name: "_SAMPLE_ Financial Account" })
    .where(eq(financialAccount.financialAccountId, financialAccountId));
  await db
    .update(billingAccount)
    .set({ name: "_SAMPLE_ Billing Account 1 (Full Period)" })
    .where(eq(billingAccount.billingAccountId, banFull1));

  const activateResult = await transitionCustomerStatus(
    {
      partyRoleId,
      targetStatus: "ACTIVE",
      statusReason: "_SAMPLE_ billrun scenario activation",
      lastModifiedDatetime: onboardResult.value.lastModifiedDatetime,
    },
    actorId,
  );
  if (!activateResult.ok) {
    throw new Error(
      `db:seed-sample: transitionCustomerStatus failed with code ${activateResult.code}`,
    );
  }

  // BAN #2 (full-period) and #3 (partial-period) — self-provisioned onto the
  // same FA (ac04's own step 2b–2d, `ordering-inventory.ts` precedent).
  async function provisionAdditionalBan(
    name: string,
  ): Promise<string> {
    return db.transaction(async (tx) => {
      const ban = await billingAccountRepository.insert(tx, {
        name,
        refPartyRoleId: partyRoleId,
        refFinancialAccountId: financialAccountId,
        currency: CURRENCY,
        ratingType: "postpaid",
        paymentStatus: "paid",
        refBillCycleId: billCycleId,
        lastEditedBy: actorId,
      });

      const recAccount = await ledgerRepository.createAccount(
        tx,
        `ban.${ban.billingAccountId}.receivables`,
        CURRENCY,
      );
      await ledgerBindingRepository.insert(tx, {
        ownerType: "billing_account",
        ownerId: ban.billingAccountId,
        ledgerRole: "receivables",
        pgledgerAccountId: recAccount.id,
        lastEditedBy: actorId,
      });

      return ban.billingAccountId;
    });
  }

  const banFull2 = await provisionAdditionalBan(
    "_SAMPLE_ Billing Account 2 (Full Period)",
  );
  const banPartial = await provisionAdditionalBan(
    "_SAMPLE_ Billing Account 3 (Partial Period)",
  );

  return {
    partyRoleId,
    financialAccountId,
    accounts: [
      {
        billingAccountId: banFull1,
        name: "_SAMPLE_ Billing Account 1 (Full Period)",
        isFullPeriod: true,
      },
      {
        billingAccountId: banFull2,
        name: "_SAMPLE_ Billing Account 2 (Full Period)",
        isFullPeriod: true,
      },
      {
        billingAccountId: banPartial,
        name: "_SAMPLE_ Billing Account 3 (Partial Period)",
        isFullPeriod: false,
      },
    ],
  };
}

interface Subscription {
  billingAccountId: string;
  productInventoryId: string;
  startDate: string;
  isFullPeriod: boolean;
}

// Subscriptions (bm15-spec §Implementation §1 step 4). `createOrder` already
// calls `instantiateOrder` internally for a no-override order, so one call
// per account creates + activates the subscription. `now` is pinned to each
// account's own start date (the service's documented injection seam,
// pm28-spec) — a demo period is, by construction, older than the
// `BACKDATING_TOLERANCE_DAYS` real-wall-clock window a live submission would
// allow.
async function createSampleSubscriptions(
  accounts: SampleAccount[],
  partyRoleId: string,
  offeringId: string,
  periodStart: string,
  partialStartDate: string,
  actorId: string,
): Promise<Subscription[]> {
  const subscriptions: Subscription[] = [];

  for (const account of accounts) {
    const startDate = account.isFullPeriod ? periodStart : partialStartDate;
    const [y, m, d] = startDate.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    const now = new Date(Date.UTC(y, m - 1, d));

    const result = await createOrder(
      {
        customerPartyRoleId: partyRoleId,
        billingAccountId: account.billingAccountId,
        productOfferingId: offeringId,
        quantity: 1,
        startDate,
      },
      actorId,
      () => now,
    );
    if (!result.ok || result.inventoryId === null) {
      throw new Error(
        `db:seed-sample: createOrder failed for ${account.billingAccountId} (code=${result.ok ? "NO_INVENTORY" : result.code})`,
      );
    }

    subscriptions.push({
      billingAccountId: account.billingAccountId,
      productInventoryId: result.inventoryId,
      startDate,
      isFullPeriod: account.isFullPeriod,
    });
  }

  return subscriptions;
}

// Charges (bm15-spec §Implementation §1 step 5 / §2). Only the two
// full-period accounts get `udr_rated` rows — the partial-period account
// stays uncharged by design (it demonstrates Scoping `EXCLUDED`, not
// Collection). One of the two full-period accounts also gets two
// `BILL_NOTUSED` rows (the "deliberately not charged" surface, bm07).
async function seedSampleCharges(
  subscriptions: Subscription[],
  priceRef: string,
  periodStart: string,
  periodEnd: string,
): Promise<number> {
  const [startY, startM, startD] = periodStart.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const [endY, endM, endD] = periodEnd.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const startDatetime = new Date(Date.UTC(startY, startM - 1, startD));
  const endDatetime = new Date(Date.UTC(endY, endM - 1, endD, 23, 59, 59));

  const fullPeriodSubs = subscriptions.filter((sub) => sub.isFullPeriod);

  const rows: SampleUdrRatedRow[] = [];
  fullPeriodSubs.forEach((sub, accountIdx) => {
    rows.push(
      buildSampleUdrRatedRow({
        ban: sub.billingAccountId,
        subscriberRefId: sub.productInventoryId,
        priceRef,
        startDatetime,
        endDatetime,
        ratedPrice: SAMPLE_RECURRING_AMOUNT,
        currency: CURRENCY,
        status: "RATED",
        sequence: accountIdx * 10 + 1,
      }),
    );

    // Only the first full-period account also gets the BILL_NOTUSED pair.
    if (accountIdx === 0) {
      for (let i = 0; i < 2; i++) {
        rows.push(
          buildSampleUdrRatedRow({
            ban: sub.billingAccountId,
            subscriberRefId: sub.productInventoryId,
            priceRef,
            startDatetime,
            endDatetime,
            ratedPrice: "0.00",
            currency: CURRENCY,
            status: "BILL_NOTUSED",
            sequence: accountIdx * 10 + 2 + i,
          }),
        );
      }
    }
  });

  await db.insert(udrRated).values(rows);
  return rows.length;
}

async function main(): Promise<void> {
  assertNonProductionTarget();

  await purgeSampleGraph();

  const actorId = await getOrCreateAppUser(
    db,
    "_SAMPLE_ Seed Actor",
    "sample-billrun-seed@example.invalid",
  );

  const { offeringId, priceId } = await ensureSampleOffering();

  const { partyRoleId, accounts } = await createSampleCustomerAndAccounts(
    actorId,
  );

  const today = todayInZone(new Date(), config.APP_TIMEZONE);
  const period = currentDuePeriod(1, today);
  if (!period) {
    throw new Error(
      "db:seed-sample: could not derive a due period for the Monthly – Day 1 cycle.",
    );
  }
  const { periodStart, periodEnd } = period;
  const [py, pm] = periodStart.split("-").map(Number) as [number, number];
  const partialStartDate = `${String(py).padStart(4, "0")}-${String(
    pm,
  ).padStart(2, "0")}-16`;

  const subscriptions = await createSampleSubscriptions(
    accounts,
    partyRoleId,
    offeringId,
    periodStart,
    partialStartDate,
    actorId,
  );

  const chargeCount = await seedSampleCharges(
    subscriptions,
    priceId,
    periodStart,
    periodEnd,
  );

  logger.info("db:seed-sample: _SAMPLE_ billrun scenario seeded.", {
    partyRoleId,
    accounts: accounts.map((a) => a.billingAccountId),
    chargeCount,
    demoPeriod: { periodStart, periodEnd },
  });
  logger.info(
    `db:seed-sample: trigger a bill run for period ${periodStart}..${periodEnd} against the "${DEFAULT_BILL_CYCLE_NAME}" cycle to run the demo.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    logger.error("db:seed-sample failed.", {
      message: err instanceof Error ? err.message : "Unknown error",
    });
    process.exit(1);
  });
