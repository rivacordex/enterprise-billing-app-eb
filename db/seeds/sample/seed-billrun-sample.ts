import { eq, inArray, and } from "drizzle-orm";
import postgres from "postgres";

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
// The per-row `RAN_USAGE` amount (distinct from the recurring 199.00 so the
// two are visibly different in the demo). Recurring is bm29 compute derived
// from product_inventory and is NOT rated through udr_rated any more; only
// usage flows through udr_rated now (bm26-spec §Implementation §1, Inv #1).
const SAMPLE_USAGE_AMOUNT = "12.50";

// bm26-spec §Implementation §2 — the `ci` profile: six scenarios covering the
// shapes Collection (bm27) / Aggregation (bm28) / recurring-derivation (bm29) /
// exception surfacing (bm32) must handle. "Recurring" is represented by real
// `product_inventory` subscriptions (via the createOrder → instantiateOrder
// path), NOT by udr_rated rows.
//
// bm35-spec §Implementation §1 — the `volume` profile: from the SAME factory as
// `ci` (`buildSampleUdrRatedRow`, no new factory shape — just higher
// cardinality), a realistic RAN_USAGE load — many usage rows spread across
// accounts, each holding several subscriptions of the ONE `_SAMPLE_` offering.
// Its only visible result is a performance characteristic that needs aggregation
// (bm28) to exist: Aggregation issues a BOUNDED statement count (set-based, not
// one-per-record), and the produced line count tracks product footprint
// (offerings × udr_types) — here a single USAGE line per account — NOT the
// udr_rated record count (bm35-spec §Implementation §4, code-standards §9.31).
// Selected by the profile switch alongside `ci`; every seeded row is still
// `_SAMPLE_`-marked, unclaimed, `RAN_USAGE`, `billrun_ban_id` NULL.
type SeedProfile = "ci" | "volume";
const DEFAULT_PROFILE: SeedProfile = "ci";
const SEED_PROFILES: readonly SeedProfile[] = ["ci", "volume"];

// The `volume` profile's shape (bm35-spec §Implementation §1). Kept modest
// enough to seed quickly yet large enough to make "line count tracks footprint,
// not record count" unmistakable: 12 accounts × 5 subscriptions × 40 usage rows
// = 2,400 RAN_USAGE rows, all on the ONE sample offering, so Aggregation rolls
// each account's 200 rows into exactly ONE USAGE line.
const VOLUME_ACCOUNTS = 12;
const VOLUME_SUBSCRIPTIONS_PER_ACCOUNT = 5;
const VOLUME_USAGE_ROWS_PER_SUBSCRIPTION = 40;

type ScenarioKey =
  | "recurring-and-usage"
  | "multiple-subscriptions"
  | "recurring-only"
  | "no-charges"
  | "partial-period"
  | "bill-notused";

interface ScenarioSpec {
  key: ScenarioKey;
  banName: string;
  isFullPeriod: boolean;
  // product_inventory subscriptions to instantiate on the account (the
  // "recurring" surface — derived by bm29, never rated).
  subscriptionCount: number;
  // RAN_USAGE udr_rated rows per subscription (each wired to that
  // subscription's product_inventory_id so bm27 correlation resolves).
  usageRowsPerSubscription: number;
  // BILL_NOTUSED udr_rated rows on the account (the per-record exception
  // surface, bm32) — wired to the account's first subscription.
  billNotUsedRows: number;
}

const CI_SCENARIOS: readonly ScenarioSpec[] = [
  {
    key: "recurring-and-usage",
    banName: "_SAMPLE_ Billing Account 1 (Recurring + Usage)",
    isFullPeriod: true,
    subscriptionCount: 1,
    usageRowsPerSubscription: 2,
    billNotUsedRows: 0,
  },
  {
    key: "multiple-subscriptions",
    banName: "_SAMPLE_ Billing Account 2 (Multiple Subscriptions)",
    isFullPeriod: true,
    subscriptionCount: 3,
    usageRowsPerSubscription: 1,
    billNotUsedRows: 0,
  },
  {
    key: "recurring-only",
    banName: "_SAMPLE_ Billing Account 3 (Recurring-Only)",
    isFullPeriod: true,
    subscriptionCount: 1,
    usageRowsPerSubscription: 0,
    billNotUsedRows: 0,
  },
  {
    key: "no-charges",
    banName: "_SAMPLE_ Billing Account 4 (No Charges)",
    isFullPeriod: true,
    subscriptionCount: 0,
    usageRowsPerSubscription: 0,
    billNotUsedRows: 0,
  },
  {
    key: "partial-period",
    banName: "_SAMPLE_ Billing Account 5 (Partial Period)",
    isFullPeriod: false,
    subscriptionCount: 1,
    usageRowsPerSubscription: 0,
    billNotUsedRows: 0,
  },
  {
    key: "bill-notused",
    banName: "_SAMPLE_ Billing Account 6 (BILL_NOTUSED)",
    isFullPeriod: true,
    subscriptionCount: 1,
    usageRowsPerSubscription: 0,
    billNotUsedRows: 1,
  },
];

// bm35-spec §Implementation §1 — the `volume` load, generated (not hand-listed):
// N accounts, each with the same several subscriptions of the ONE sample
// offering and many usage rows per subscription. No BILL_NOTUSED rows and every
// account full-period — the point of this profile is aggregation cardinality,
// not the exception/partial shapes the `ci` profile already covers.
const VOLUME_SCENARIOS: readonly ScenarioSpec[] = Array.from(
  { length: VOLUME_ACCOUNTS },
  (_unused, i): ScenarioSpec => ({
    key: "multiple-subscriptions",
    banName: `_SAMPLE_ Volume Billing Account ${i + 1}`,
    isFullPeriod: true,
    subscriptionCount: VOLUME_SUBSCRIPTIONS_PER_ACCOUNT,
    usageRowsPerSubscription: VOLUME_USAGE_ROWS_PER_SUBSCRIPTION,
    billNotUsedRows: 0,
  }),
);

function resolveProfile(profile: SeedProfile): readonly ScenarioSpec[] {
  switch (profile) {
    case "ci":
      return CI_SCENARIOS;
    case "volume":
      return VOLUME_SCENARIOS;
    default: {
      const exhaustive: never = profile;
      throw new Error(
        `db:seed-sample: unknown profile "${String(exhaustive)}".`,
      );
    }
  }
}

// The profile switch (bm35-spec §Implementation §1). Selected by
// `SAMPLE_SEED_PROFILE` (default `ci`); an unknown value fails loud before any
// write rather than silently seeding the default.
function resolveSelectedProfile(): SeedProfile {
  const raw = process.env.SAMPLE_SEED_PROFILE;
  if (raw === undefined || raw === "") {
    return DEFAULT_PROFILE;
  }
  const match = SEED_PROFILES.find((p) => p === raw);
  if (!match) {
    throw new Error(
      `db:seed-sample: unknown SAMPLE_SEED_PROFILE "${raw}". ` +
        `Valid profiles: ${SEED_PROFILES.join(", ")}.`,
    );
  }
  return match;
}

const NON_PROD_HOSTS = new Set(["localhost", "127.0.0.1", "db", "postgres"]);

// Deliberate waiver of the non-prod host check, for a non-local demo box. It
// applies to EVERY connection this seed touches — the app `DATABASE_URL` and the
// privileged `BOOTSTRAP_DATABASE_URL` teardown connection alike.
function isSampleSeedOverride(): boolean {
  return process.env.ALLOW_SAMPLE_SEED === "true";
}

// Refuses a connection string that looks like a production target. Used for BOTH
// `DATABASE_URL` and the privileged `BOOTSTRAP_DATABASE_URL`: the latter drives a
// destructive `DELETE FROM billing.pgledger_accounts`, and is read only via raw
// `process.env` (never in `lib/config`), so it must clear the same gate rather
// than slip past a guard that only ever inspected `DATABASE_URL`.
function assertNonProductionUrl(url: string, label: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(
      `db:seed-sample refused: ${label} could not be parsed as a URL.`,
    );
  }

  if (!NON_PROD_HOSTS.has(host) || config.NODE_ENV === "production") {
    throw new Error(
      `db:seed-sample refused: ${label} looks like a production target ` +
        `(host="${host}", NODE_ENV="${config.NODE_ENV}"). This seed writes and ` +
        `deletes unmistakably-fake "_SAMPLE_" data and must never run against ` +
        `production. Set ALLOW_SAMPLE_SEED=true to override for a deliberate ` +
        `non-local demo box.`,
    );
  }
}

// bm15-spec §Design — the two hard rules that make this data impossible to
// ship to prod: never in `db:setup`, and refuses to run against a production
// target. Aborts loudly, before any write.
function assertNonProductionTarget(): void {
  if (isSampleSeedOverride()) {
    logger.warn(
      "db:seed-sample: ALLOW_SAMPLE_SEED=true — proceeding without the non-prod host check.",
    );
    return;
  }
  assertNonProductionUrl(config.DATABASE_URL, "DATABASE_URL");
}

// bm15-spec §Design "Idempotent + re-runnable" — purges any prior _SAMPLE_*
// graph (keyed on the sample customer's registration number) in FK-safe
// order before rebuilding, so a re-run is clean. A no-op on the first run.
async function purgeSampleGraph(): Promise<void> {
  // pgledger accounts provisioned for the prior run's FAs/BANs during
  // onboarding. Collected inside the teardown transaction; `app_runtime` (this
  // seed's connection) has no privileges on `billing.pgledger_accounts` by
  // design (Inv. #18 — the ledger is write-only via SECURITY DEFINER functions),
  // so they are deleted through a privileged connection. That connection is
  // opened + probed *inside* the transaction (before its deletes commit), so a
  // bad/missing/prod BOOTSTRAP_DATABASE_URL rolls the teardown back instead of
  // stranding the accounts as "unmapped" in `gl_resolution_view`; the open
  // handle is then reused for the delete once the transaction commits.
  // The teardown transaction returns the orphaned pgledger account ids it
  // collected plus the privileged connection it opened + probed — the caller
  // deletes through that connection after commit, then closes it.
  const { orphanLedgerAccountIds, admin } = await db.transaction(async (tx) => {
    let orphanLedgerAccountIds: string[] = [];
    // Privileged teardown connection: opened by openPrivilegedConnection() once
    // we know orphaned accounts exist (before these deletes commit) and reused
    // for the delete after commit. On a mid-teardown throw it is dropped by the
    // process exit in main()'s catch.
    let admin: postgres.Sql | null = null;
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

        // Ledger accounts bound to this sample's FAs/BANs. Owner ids are
        // globally unique (BAN* vs FIN* prefixes), so one lookup covers both.
        const ownerIds = [...banIds, ...faIds];
        if (ownerIds.length > 0) {
          const bound = await tx
            .select({ pgledgerAccountId: ledgerBinding.pgledgerAccountId })
            .from(ledgerBinding)
            .where(inArray(ledgerBinding.ownerId, ownerIds));
          orphanLedgerAccountIds = bound.map((b) => b.pgledgerAccountId);

          // A double-entry ledger is immutable: if a bill run has posted
          // against the prior sample, these accounts carry entries that cannot
          // be torn down without a reversing posting. Refuse (this throw rolls
          // the whole teardown back) rather than silently orphan or corrupt
          // balances.
          if (orphanLedgerAccountIds.length > 0) {
            // pgledger access goes through the accounts ledger repository — the
            // sole sanctioned caller of the pgledger surface (Inv. #4, code-
            // standards §6.3); never raw pgledger SQL from a seed.
            const postedEntryCount =
              await ledgerRepository.countEntriesForAccounts(
                tx,
                orphanLedgerAccountIds,
              );
            if (postedEntryCount > 0) {
              throw new Error(
                "db:seed-sample: the prior _SAMPLE_ run's ledger accounts already " +
                  "carry posted entries (a bill run was executed against them). A " +
                  "double-entry ledger is immutable, so this seed will not tear them " +
                  "down in place — reversing posted entries is itself a posting. " +
                  "Re-seed on a database where no bill run has posted against the " +
                  "prior _SAMPLE_ customer.",
              );
            }

            // Open + probe the privileged connection NOW, before the destructive
            // deletes below commit, so a missing / production / unreachable
            // BOOTSTRAP_DATABASE_URL rolls the whole teardown back instead of
            // stranding these accounts "unmapped" forever (the organization row
            // this purge keys on is deleted below, so no re-run could reach
            // them). The open handle is reused for the delete after commit.
            admin = await openPrivilegedConnection();
          }
        }

        if (banIds.length > 0) {
          const inventories = await tx
            .select({ productInventoryId: productInventory.productInventoryId })
            .from(productInventory)
            .where(inArray(productInventory.billingAccountId, banIds));
          const inventoryIds = inventories.map((i) => i.productInventoryId);

          // bm26: the seed's udr_rated rows now carry a NULL billrun_ban_id
          // (they match rl.py's unclaimed shape), so they can no longer be
          // purged by account. They ARE keyed to the prior run's subscriptions
          // via udr_subscriber_ref_id (= product_inventory_id), which is what
          // bm27 correlates on — so purge by that instead. This also catches a
          // prior bm15-shape run (its rows set both billrun_ban_id AND the same
          // subscriber ref), so the transition is clean. Delete BEFORE the
          // product_inventory rows (no FK — Inv #17 — but the ids are needed).
          if (inventoryIds.length > 0) {
            await tx
              .delete(udrRated)
              .where(inArray(udrRated.udrSubscriberRefId, inventoryIds));
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
              .where(
                inArray(productInventory.productInventoryId, inventoryIds),
              );
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
          eq(
            productOfferingPrice.productOfferingId,
            offering.productOfferingId,
          ),
        );
      await tx
        .delete(productOffering)
        .where(
          eq(productOffering.productOfferingId, offering.productOfferingId),
        );
    }

    return { orphanLedgerAccountIds, admin };
  });

  // The app-side teardown has committed; the collected accounts are now unbound
  // and (guarded above) carry no entries. Delete them through the already-open,
  // already-probed privileged connection, then close it.
  if (orphanLedgerAccountIds.length > 0 && admin) {
    try {
      await deleteOrphanedLedgerAccounts(admin, orphanLedgerAccountIds);
    } finally {
      await admin.end();
    }
  }
}

// Opens AND probes the privileged connection used to delete orphaned pgledger
// accounts (`app_runtime` has no DML on `billing.pgledger_accounts`, Inv. #18).
// Called inside the teardown transaction, before its destructive deletes commit,
// so a missing / production / unreachable BOOTSTRAP_DATABASE_URL throws here and
// rolls the teardown back — rather than committing the binding + organization
// deletes and only then discovering the pgledger accounts can't be removed
// (which would strand them "unmapped" forever, the org key being deleted too).
//
// BOOTSTRAP_DATABASE_URL is the superuser/owner DSN used to provision the
// database (the same one `db:setup` and `db:bootstrap-roles` use) — NOT the
// least-privilege app_runtime `DATABASE_URL` that `db:migrate` reads.
async function openPrivilegedConnection(): Promise<postgres.Sql> {
  const url = process.env.BOOTSTRAP_DATABASE_URL;
  if (!url) {
    throw new Error(
      "db:seed-sample: tearing down a prior _SAMPLE_ run requires " +
        "BOOTSTRAP_DATABASE_URL — its pgledger accounts must be deleted through a " +
        "privileged connection (app_runtime has no privileges on " +
        "billing.pgledger_accounts by design, Inv. #18). Set it to the " +
        "superuser/owner DSN used to provision the database (the same one " +
        "db:setup and db:bootstrap-roles use), then re-run.",
    );
  }
  if (!isSampleSeedOverride()) {
    assertNonProductionUrl(url, "BOOTSTRAP_DATABASE_URL");
  }

  const admin = postgres(url, { max: 1 });
  try {
    // Fail fast on an unreachable / bad-credential / wrong-database DSN while the
    // teardown can still roll back; also proves this connection can reach the
    // table it is about to delete from.
    await admin`SELECT 1 FROM billing.pgledger_accounts WHERE false`;
  } catch (err) {
    await admin.end();
    throw new Error(
      "db:seed-sample: could not reach billing.pgledger_accounts through " +
        "BOOTSTRAP_DATABASE_URL to tear down the prior _SAMPLE_ run (the teardown " +
        "was rolled back — nothing deleted). Check the DSN points at this same " +
        "database with sufficient privileges. Underlying error: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  return admin;
}

// Deletes now-unbound pgledger accounts left by a prior sample run, through the
// pre-opened, pre-probed privileged connection (openPrivilegedConnection). Safe:
// callers pass only accounts that are unbound and free of ledger entries, so each
// has a zero balance and no transfer/entry rows reference it. The caller owns the
// connection lifecycle (it is reused from the teardown probe, then closed).
async function deleteOrphanedLedgerAccounts(
  admin: postgres.Sql,
  accountIds: string[],
): Promise<void> {
  const deleted = await admin<{ name: string }[]>`
    DELETE FROM billing.pgledger_accounts
    WHERE id IN ${admin(accountIds)}
    RETURNING name
  `;
  logger.info(
    `db:seed-sample: removed ${deleted.length} orphaned pgledger account(s) from the prior _SAMPLE_ run.`,
  );
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
  scenario: ScenarioSpec;
}

// Customer + accounts (bm26-spec §Implementation §2 — one BAN per `ci`
// scenario). BAN #1 is onboarded through the real wizard path
// (`onboardCustomerAccounts`) so at least one account is provably wired
// end-to-end through it; the remaining BANs are self-provisioned the same way
// `ordering-inventory.ts` does for its own story (no service exists for "add
// another billing account to an existing financial account"), reusing FA #1's
// `unapplied_cash`/`deposits` bindings and adding their own `receivables`
// binding.
async function createSampleCustomerAndAccounts(
  actorId: string,
  scenarios: readonly ScenarioSpec[],
): Promise<{
  partyRoleId: string;
  financialAccountId: string;
  accounts: SampleAccount[];
}> {
  const [firstScenario, ...restScenarios] = scenarios;
  if (!firstScenario) {
    throw new Error("db:seed-sample: the selected profile has no scenarios.");
  }
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

  // onboardCustomerAccounts guards its status transition with an exact-match
  // optimistic lock on the party role's lastModifiedDatetime (the real wizard
  // submits the value it loaded). createCustomer stamps last_modified =
  // created and does not return it, so read the freshly-created row's actual
  // timestamp here — passing `new Date()` would never match and always CONFLICT.
  const [freshRole] = await db
    .select({ lastModifiedDatetime: partyRole.lastModifiedDatetime })
    .from(partyRole)
    .where(eq(partyRole.partyRoleId, partyRoleId))
    .limit(1);
  if (!freshRole) {
    throw new Error(
      `db:seed-sample: party role ${partyRoleId} not found immediately after createCustomer.`,
    );
  }

  const onboardResult = await onboardCustomerAccounts(
    {
      partyRoleId,
      billCycleId,
      currency: CURRENCY,
      statusReason: "_SAMPLE_ billrun scenario onboarding",
      lastModifiedDatetime: freshRole.lastModifiedDatetime,
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
    .set({ name: firstScenario.banName })
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

  // Remaining scenario BANs — self-provisioned onto the same FA (ac04's own
  // step 2b–2d, `ordering-inventory.ts` precedent).
  async function provisionAdditionalBan(name: string): Promise<string> {
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

  const accounts: SampleAccount[] = [
    {
      billingAccountId: banFull1,
      name: firstScenario.banName,
      isFullPeriod: firstScenario.isFullPeriod,
      scenario: firstScenario,
    },
  ];
  for (const scenario of restScenarios) {
    const billingAccountId = await provisionAdditionalBan(scenario.banName);
    accounts.push({
      billingAccountId,
      name: scenario.banName,
      isFullPeriod: scenario.isFullPeriod,
      scenario,
    });
  }

  return { partyRoleId, financialAccountId, accounts };
}

// The subscriptions instantiated on one account (bm26-spec §Implementation §2):
// zero for the no-charges scenario, one for most, several of the same offering
// for the multiple-subscriptions scenario (Aggregation must roll them into one
// line, bm28). Each product_inventory_id is what a RAN_USAGE row's
// udr_subscriber_ref_id points at so bm27's correlation resolves.
interface AccountSubscriptions {
  account: SampleAccount;
  productInventoryIds: string[];
}

// Subscriptions (bm26-spec §Implementation §2). `createOrder` already calls
// `instantiateOrder` internally for a no-override order, so one call creates +
// activates one subscription (one product_inventory row). The count per
// account is scenario-driven. `now` is pinned to each account's own start date
// (the service's documented injection seam, pm28-spec) — a demo period is, by
// construction, older than the `BACKDATING_TOLERANCE_DAYS` real-wall-clock
// window a live submission would allow.
async function createSampleSubscriptions(
  accounts: SampleAccount[],
  partyRoleId: string,
  offeringId: string,
  periodStart: string,
  partialStartDate: string,
  actorId: string,
): Promise<AccountSubscriptions[]> {
  const perAccount: AccountSubscriptions[] = [];

  for (const account of accounts) {
    const startDate = account.isFullPeriod ? periodStart : partialStartDate;
    const [y, m, d] = startDate.split("-").map(Number) as [
      number,
      number,
      number,
    ];
    const now = new Date(Date.UTC(y, m - 1, d));

    const productInventoryIds: string[] = [];
    for (let i = 0; i < account.scenario.subscriptionCount; i++) {
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
      productInventoryIds.push(result.inventoryId);
    }

    perAccount.push({ account, productInventoryIds });
  }

  return perAccount;
}

// Charges (bm26-spec §Implementation §1/§2). udr_rated now carries ONLY
// `RAN_USAGE` (Inv #1) — recurring is NOT rated here (it is bm29 compute
// derived from product_inventory). Every usage row is the exact shape rl.py
// leaves: `udr_type = 'RAN_USAGE'`, `status = 'RATED'`, all four billrun_*
// columns NULL, `_SAMPLE_`-marked, and `udr_subscriber_ref_id` = a real seeded
// product_inventory_id (so bm27's correlation resolves it to the right
// billing_account_id). The BILL_NOTUSED scenario seeds a `status='BILL_NOTUSED'`
// row (the per-record exception surface, bm32), anchored to a real subscription
// so its subscriber ref is equally correlatable. Driven entirely by each
// account's scenario spec.
async function seedSampleCharges(
  accountSubscriptions: AccountSubscriptions[],
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

  const rows: SampleUdrRatedRow[] = [];
  // A monotonic sequence keeps every seeded row's udr_key distinct across the
  // WHOLE period: the live-row uniqueness key is (partition_period,
  // start_datetime, udr_key, is_live) and does NOT include the account, yet
  // every row here shares the same start_datetime — so the disambiguator must
  // be global, not per-account.
  let sequence = 0;

  for (const { account, productInventoryIds } of accountSubscriptions) {
    const { scenario } = account;

    // RAN_USAGE rows: one batch per subscription, wired to that subscription's
    // product_inventory_id.
    for (const productInventoryId of productInventoryIds) {
      for (let u = 0; u < scenario.usageRowsPerSubscription; u++) {
        sequence += 1;
        rows.push(
          buildSampleUdrRatedRow({
            ban: account.billingAccountId,
            subscriberRefId: productInventoryId,
            priceRef,
            startDatetime,
            endDatetime,
            ratedPrice: SAMPLE_USAGE_AMOUNT,
            currency: CURRENCY,
            status: "RATED",
            sequence,
          }),
        );
      }
    }

    // BILL_NOTUSED rows anchor to the account's first subscription so the
    // subscriber ref stays a real product_inventory_id. A scenario asking for
    // them without a subscription to anchor is a spec error.
    if (scenario.billNotUsedRows > 0) {
      const anchorInventoryId = productInventoryIds[0];
      if (!anchorInventoryId) {
        throw new Error(
          `db:seed-sample: scenario "${scenario.key}" requests BILL_NOTUSED rows but has no subscription to anchor them.`,
        );
      }
      for (let b = 0; b < scenario.billNotUsedRows; b++) {
        sequence += 1;
        rows.push(
          buildSampleUdrRatedRow({
            ban: account.billingAccountId,
            subscriberRefId: anchorInventoryId,
            priceRef,
            startDatetime,
            endDatetime,
            ratedPrice: "0.00",
            currency: CURRENCY,
            status: "BILL_NOTUSED",
            sequence,
          }),
        );
      }
    }
  }

  // Insert in chunks so a high-cardinality profile (`volume`, bm35) cannot hit
  // postgres.js's ~65k bind-parameter ceiling as the profile is tuned up — each
  // row carries ~two dozen bound values, so a single `.values(rows)` for the
  // whole set would wall out somewhere past ~2,700 rows. `ci` fits in one chunk.
  const INSERT_CHUNK = 1000;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await db.insert(udrRated).values(rows.slice(i, i + INSERT_CHUNK));
  }
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

  const selectedProfile = resolveSelectedProfile();
  const scenarios = resolveProfile(selectedProfile);

  const { partyRoleId, accounts } = await createSampleCustomerAndAccounts(
    actorId,
    scenarios,
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

  const accountSubscriptions = await createSampleSubscriptions(
    accounts,
    partyRoleId,
    offeringId,
    periodStart,
    partialStartDate,
    actorId,
  );

  const chargeCount = await seedSampleCharges(
    accountSubscriptions,
    priceId,
    periodStart,
    periodEnd,
  );

  logger.info("db:seed-sample: _SAMPLE_ billrun scenario seeded.", {
    profile: selectedProfile,
    partyRoleId,
    accounts: accounts.map((a) => ({
      ban: a.billingAccountId,
      scenario: a.scenario.key,
    })),
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
