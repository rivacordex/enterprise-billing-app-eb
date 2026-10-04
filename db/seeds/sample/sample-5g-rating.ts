import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billingAccount } from "@/db/schema/billing/accounts";
import {
  productOffering,
  productOfferingPrice,
  ratecardVersion,
} from "@/db/schema/product";
import { productInventory } from "@/db/schema/inventory";
import { mnoKeySpecSchema } from "@/validation/customer/party-role-specification.schema";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import {
  assertNonProductionUrl,
  type NonProdGuardContext,
} from "@/db/seeds/lib/non-prod-guard";
import {
  insertRanOffering,
  insertRanCustomer,
  insertRanBillCycle,
  insertRanBillingAccount,
  insertRanSubscription,
  insertRanRatecard,
  SAMPLE_5G_LKP_ROWS,
} from "@/db/seeds/sample/sample-5g-fixture";
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
// The pure-insert logic lives in `sample-5g-fixture.ts` and is SHARED with the
// rm21 rm07 integration test (rm21 code-review fix — one source of truth for the
// fixture's shape). This script keeps the get-or-create idempotency checks, the
// non-prod guard, the single transaction, and the fixed Sample-5G identity
// values; the test calls the same builders with per-case parameters.

const SAMPLE_5G_REGISTRATION_NUMBER = "_SAMPLE_-5G-0001";
const SAMPLE_5G_CUSTOMER_NAME = "_SAMPLE_ 5G RAN Subscriber";
const SAMPLE_5G_BAN_NAME = "_SAMPLE_ 5G Billing Account";
const SAMPLE_5G_BILL_CYCLE_NAME = "_SAMPLE_ 5G Monthly Cycle";
const SAMPLE_OFFERING_NAME = "Sample 5G Services";
const SAMPLE_PRICE_NAME = "Sample 5G Usage Rate";
const MNO_PUBLIC_KEY = "MNO-001";
const RATECARD_CARD_NAME = "RATECARD_RAN_USAGE_LKP";

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
// §3), via the shared builder. Idempotent: an existing offering (by name) is
// returned as-is.
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

  return insertRanOffering(tx, {
    name: SAMPLE_OFFERING_NAME,
    priceName: SAMPLE_PRICE_NAME,
    udrTypeValue: "RAN_USAGE",
    cardName: RATECARD_CARD_NAME,
  });
}

// Customer whose party_role carries the MNO key (rm18-spec §Implementation
// §4). Idempotent by the organization's registration number. The MNO-key shape
// is validated through mnoKeySpecSchema before it reaches the database.
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

  return insertRanCustomer(tx, {
    organizationName: SAMPLE_5G_CUSTOMER_NAME,
    registrationNumber: SAMPLE_5G_REGISTRATION_NUMBER,
    partyRoleSpecification: mnoKeySpecSchema.parse({
      mnoPublicKey1: MNO_PUBLIC_KEY,
    }),
    actorId,
  });
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

  return insertRanBillCycle(tx, {
    name: SAMPLE_5G_BILL_CYCLE_NAME,
    description: "Sample 5G rating fixture bill cycle (rm18).",
    actorId,
  });
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

  return insertRanBillingAccount(tx, {
    financialAccountName: `${SAMPLE_5G_BAN_NAME} — Financial Account`,
    billingAccountName: SAMPLE_5G_BAN_NAME,
    partyRoleId,
    billCycleId,
    actorId,
  });
}

// The single RAN_USAGE subscription (rm18-spec §Implementation §4,
// `singleSubInstPerCust`). Idempotent: an existing inventory on this billing
// account + offering is returned as-is.
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

  return insertRanSubscription(tx, {
    partyRoleId,
    billingAccountId,
    offeringId,
    actorId,
    reason: "Sample 5G RAN_USAGE subscription instantiated by the rm18 seed.",
  });
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

  await insertRanRatecard(tx, {
    cardName: RATECARD_CARD_NAME,
    mnoPublicKey: MNO_PUBLIC_KEY,
    lkpSubscriberRefId: partyRoleId,
    rows: SAMPLE_5G_LKP_ROWS,
    actorId,
  });
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
