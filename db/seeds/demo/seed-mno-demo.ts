import { and, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import * as schema from "@/db/schema";
import { logger } from "@/lib/logger";
import { db } from "@/db/client";
import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billingAccount } from "@/db/schema/billing/accounts";
import {
  productOffering,
  productSpecifications,
  productOfferingPrice,
} from "@/db/schema/product";
import { productOrderItem } from "@/db/schema/ordering";
import {
  productInventory,
  inventoryStatusHistory,
} from "@/db/schema/inventory";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { loadBootstrapAdminConfig } from "@/db/seeds/seed-admin.config";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import {
  assertNonProductionUrl,
  type NonProdGuardContext,
} from "@/db/seeds/lib/non-prod-guard";
import {
  buildPriceEnvelope,
  toRowColumns,
  RAN_USAGE_CARD_NAME,
  type PriceSeed,
  type SpecSeed,
} from "@/db/seeds/demo/product-demo";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";
import { mnoKeySpecSchema } from "@/validation/customer/party-role-specification.schema";
import { createCustomerSchema } from "@/validation/customer/create-customer.schema";
import { addContactSchema } from "@/validation/customer/add-contact.schema";
import { transitionOrganizationStatusSchema } from "@/validation/customer/transition-organization-status.schema";
import { transitionCustomerStatusSchema } from "@/validation/customer/transition-customer-status.schema";
import { updatePartyRoleSpecificationSchema } from "@/validation/customer/update-party-role-specification.schema";
import { onboardCustomerAccountsSchema } from "@/validation/accounts/onboard-customer-accounts.schema";
import { createOrderSchema } from "@/validation/ordering/create-order.schema";
import {
  BACKDATING_TOLERANCE_DAYS,
  ISO_DATE_REGEX,
} from "@/validation/backdating-tolerance";
import { createCustomer } from "@/services/customer/create-customer";
import { addContact } from "@/services/customer/contact-mutations";
import { transitionOrganizationStatus } from "@/services/customer/transition-organization-status";
import { transitionCustomerStatus } from "@/services/customer/transition-customer-status";
import { updatePartyRoleSpecification } from "@/services/customer/update-party-role-specification";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { createOrder } from "@/services/ordering/create-order";

// Standalone script (`npm run db:seed-mno-demo`) — never imported by application
// code, never part of `db:setup` (demo data is opt-in). Stands up the standard
// MNO invoice-generation demo in one go, so it never has to be re-keyed by hand
// after a database reset:
//
//   1. Two ACTIVE offerings — "eMBB Wholesale 5G Network" (the RAN_USAGE
//      card-driven capacity plan the `rating-engine-ran-usage` flow is pinned
//      to) and "5G Private Network" (a flat monthly fee).
//   2. Four Telecommunication customers (Maxis, CelcomDigi, Telekom, YTL), each
//      carrying its `mnoPublicKey1` (MAXIS/CELCOM/TM/YTL), a contact, a Financial +
//      Master Billing Account on the demo bill cycle, and activated.
//   3. One COMPLETED order (→ ACTIVE subscription) per customer per offering.
//
// The offerings are inserted directly (product-demo.ts precedent — DRAFT →
// children → ACTIVE under pm36's draft-guard trigger) because their prices must
// be effective from the demo start date, which is usually further back than
// `insertPrice`'s 3-day tolerance allows. Everything on the customer side goes
// through the REAL services (createCustomer, addContact,
// onboardCustomerAccounts, transitionOrganizationStatus/transitionCustomerStatus,
// createOrder): the rows, status flow, ledger bindings and audit trail are
// exactly what the UI would have produced. Orders are then backdated to the demo
// start date in place when that date is outside the ordering tolerance — the
// same manual step the demo used to need, now done by the script. That one step
// writes columns the app role is deliberately write-once on (`app_runtime` has
// no UPDATE on `ordering.product_order_item` / `inventory.inventory_status_history`),
// so it runs on `BOOTSTRAP_DATABASE_URL` (the superuser/owner DSN the bootstrap
// scripts use) when that is set, else on `DATABASE_URL`; the privilege is
// checked BEFORE anything is written, so a wrong DSN fails with nothing to undo.
//
// Idempotent and resumable: every step is get-or-create on a stable key (the
// offering name, the organization's registration number, the party role's
// status, the (BAN, offering) subscription), so a re-run after a partial
// failure completes the remaining steps and a full re-run changes nothing. A
// re-run with an EARLIER `DEMO_START_DATE` moves the demo back: subscriptions
// and prices that start after the new date are moved to it (through the
// privileged connection; prices need the draft-guard trigger bypassed), and an
// existing customer whose MNO key differs from the fixture is re-keyed. Nothing
// is ever moved forward.
//
// Options (environment):
//   DEMO_START_DATE          subscription + price effective date, YYYY-MM-DD.
//                            Default: the 1st of the previous calendar month
//                            (the period the next bill run bills).
//   DEMO_BILL_CYCLE          bill cycle name for the BANs. Default: the
//                            baseline "Monthly – Day 1".
//   DEMO_PRIVATE_NETWORK_FEE monthly flat fee of "5G Private Network" (MYR,
//                            plain decimal). Default: 50000.00.
//   BOOTSTRAP_DATABASE_URL   superuser/owner DSN for the backdate step (see
//                            above). Falls back to DATABASE_URL.
//   ALLOW_MNO_DEMO_SEED=true waive the non-prod host check.
//
// Prerequisites: `db:setup` (baseline seeds — the bootstrap admin is stamped as
// the actor, the default bill cycle is the BANs' cycle). The rate card is NOT
// uploaded here (its polygons belong to the UDR feed, not this fixture): upload
// `RATECARD_RAN_USAGE_LKP` through the Rate Card screen afterwards, with each
// row's Subscriber Reference ID set to the party-role id this script prints.

const CURRENCY = "MYR"; // SYSTEM_CONFIG.default_currency (0005 seed)
const INDUSTRY = "Telecommunication";
const UNIT = "Mbps";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const EMBB_OFFERING_NAME = "eMBB Wholesale 5G Network";
export const PRIVATE_NETWORK_OFFERING_NAME = "5G Private Network";
const DEFAULT_PRIVATE_NETWORK_FEE = "50000.00";

// The four MNO customers. `registrationNumber` is the idempotency key (unique
// in `customer.organization`); the `mnoPublicKey1` value is what the rating
// resolver matches the UDR feed's MNO column against (prp.py, rm21 §2), so it
// must equal the `mno_public_id` the usage files and the rate card's MNO Name
// column carry: MAXIS/CELCOM/TM/YTL, the keys the demo UDR feed and rate card
// CSVs are built with (the `MNOn` fixture convention applies to test fixtures,
// not to this demo). An existing customer whose key differs is re-keyed on the
// re-run (ensureMnoKey).
interface MnoCustomerSeed {
  mnoPublicKey: string;
  name: string;
  registrationNumber: string;
  contactName: string;
  contactEmail: string;
}

export const MNO_CUSTOMERS: readonly MnoCustomerSeed[] = [
  {
    mnoPublicKey: "MAXIS",
    name: "Maxis Sdn Bhd",
    registrationNumber: "DEMO-MNO1",
    contactName: "Maxis Wholesale Billing",
    contactEmail: "wholesale-billing@maxis.example",
  },
  {
    mnoPublicKey: "CELCOM",
    name: "CelcomDigi Sdn Bhd",
    registrationNumber: "DEMO-MNO2",
    contactName: "CelcomDigi Wholesale Billing",
    contactEmail: "wholesale-billing@celcomdigi.example",
  },
  {
    mnoPublicKey: "TM",
    name: "Telekom Sdn Bhd",
    registrationNumber: "DEMO-MNO3",
    contactName: "Telekom Wholesale Billing",
    contactEmail: "wholesale-billing@telekom.example",
  },
  {
    mnoPublicKey: "YTL",
    name: "YTL Communication Sdn Bhd",
    registrationNumber: "DEMO-MNO4",
    contactName: "YTL Wholesale Billing",
    contactEmail: "wholesale-billing@ytl.example",
  },
];

// -- Prod guard ---------------------------------------------------------------

const MNO_DEMO_GUARD: NonProdGuardContext = {
  seedScript: "db:seed-mno-demo",
  overrideEnv: "ALLOW_MNO_DEMO_SEED",
  action:
    "writes the MNO invoice-generation demo (customers, offerings, orders)",
};

function assertNonProductionTarget(backdateUrl: string): void {
  if (process.env.ALLOW_MNO_DEMO_SEED === "true") {
    logger.warn(
      "db:seed-mno-demo: ALLOW_MNO_DEMO_SEED=true — proceeding without the non-prod host check.",
    );
    return;
  }
  assertNonProductionUrl(config.DATABASE_URL, "DATABASE_URL", MNO_DEMO_GUARD);
  if (backdateUrl !== config.DATABASE_URL) {
    assertNonProductionUrl(
      backdateUrl,
      "BOOTSTRAP_DATABASE_URL",
      MNO_DEMO_GUARD,
    );
  }
}

// The connection the backdate step runs on (see the header): the bootstrap
// superuser/owner DSN when set, else the app DSN.
function resolveBackdateUrl(): string {
  return process.env.BOOTSTRAP_DATABASE_URL?.trim() || config.DATABASE_URL;
}

// Fails BEFORE any write when the backdate connection cannot update the three
// write-once tables the step touches — a wrong DSN then leaves nothing behind.
async function assertCanBackdate(backdateDb: Database): Promise<void> {
  const rows = (await backdateDb.execute(sql`
    SELECT has_table_privilege('ordering.product_order_item', 'UPDATE') AS item,
           has_table_privilege('inventory.product_inventory', 'UPDATE') AS inventory,
           has_table_privilege('inventory.inventory_status_history', 'UPDATE') AS history
  `)) as unknown as { item: boolean; inventory: boolean; history: boolean }[];
  const privileges = rows[0];
  if (!privileges?.item || !privileges.inventory || !privileges.history) {
    throw new Error(
      "db:seed-mno-demo: the demo start date is outside the ordering backdating tolerance, so " +
        "subscriptions must be backdated in place, but the backdate connection lacks UPDATE on " +
        "ordering.product_order_item / inventory.product_inventory / inventory.inventory_status_history. " +
        "Set BOOTSTRAP_DATABASE_URL to the superuser/owner DSN (README Part 1) and re-run.",
    );
  }
}

// -- Options ------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function utcMidnight(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return (
    parsed.getUTCFullYear() === y &&
    parsed.getUTCMonth() === m - 1 &&
    parsed.getUTCDate() === d
  );
}

interface DemoOptions {
  startDate: string; // YYYY-MM-DD
  billCycleName: string;
  privateNetworkFee: string;
}

function resolveOptions(): DemoOptions {
  const rawStart = process.env.DEMO_START_DATE?.trim();
  let startDate: string;
  if (rawStart) {
    if (!isRealIsoDate(rawStart)) {
      throw new Error(
        `db:seed-mno-demo: DEMO_START_DATE="${rawStart}" is not a real YYYY-MM-DD date.`,
      );
    }
    startDate = rawStart;
  } else {
    const now = new Date();
    startDate = toIsoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  }

  const privateNetworkFee =
    process.env.DEMO_PRIVATE_NETWORK_FEE?.trim() || DEFAULT_PRIVATE_NETWORK_FEE;
  if (!/^\d+(\.\d+)?$/.test(privateNetworkFee)) {
    throw new Error(
      `db:seed-mno-demo: DEMO_PRIVATE_NETWORK_FEE="${privateNetworkFee}" must be a plain decimal amount.`,
    );
  }

  return {
    startDate,
    billCycleName:
      process.env.DEMO_BILL_CYCLE?.trim() || DEFAULT_BILL_CYCLE_NAME,
    privateNetworkFee,
  };
}

// -- Actor --------------------------------------------------------------------

// The system/ADMIN break-glass user (`db:seed`) is the actor on every row and
// audit event — the real principal the baseline provisions, never an invented
// one (ratecard-demo precedent). Refused loudly if absent.
async function resolveActorId(): Promise<string> {
  const { BOOTSTRAP_ADMIN_EMAIL } = loadBootstrapAdminConfig();
  const [admin] = await db
    .select({ id: appuser.id })
    .from(appuser)
    .where(
      and(
        eq(appuser.userEmail, BOOTSTRAP_ADMIN_EMAIL),
        ne(appuser.status, "DELETED"),
      ),
    )
    .limit(1);
  if (!admin) {
    throw new Error(
      "db:seed-mno-demo: the system/ADMIN user was not found — run `db:seed` (bootstrap admin) first.",
    );
  }
  return admin.id;
}

// -- Offerings ----------------------------------------------------------------

interface OfferingSeed {
  name: string;
  specs: SpecSeed[];
  prices: PriceSeed[];
}

// The RAN_USAGE spec trio the pre-rating processor resolves a subscription by
// (prp.py: `udrType`, `productCardLookUp`; `singleSubInstPerCust` is the
// one-subscription-per-customer discipline). Same names and flags as the
// Sample-5G fixture (sample-5g-fixture.ts), which the worker is tested against.
function ranUsageSpecs(): SpecSeed[] {
  return [
    {
      name: "udrType",
      isMandatory: true,
      isDefault: true,
      defaultValue: "RAN_USAGE",
      characteristics: {},
    },
    {
      name: "productCardLookUp",
      isMandatory: true,
      isDefault: false,
      defaultValue: RAN_USAGE_CARD_NAME,
      characteristics: {},
    },
    {
      name: "singleSubInstPerCust",
      isMandatory: true,
      isDefault: false,
      defaultValue: "true",
      characteristics: {},
    },
  ];
}

// Prices are effective from the day BEFORE the demo start date (00:00Z), so
// the first local-time hours of the start date (MYT is UTC+8) are already
// priced when usage for that date is rated.
function priceStartFor(startDate: string): Date {
  return new Date(utcMidnight(startDate) - MS_PER_DAY);
}

function offeringSeeds(opts: DemoOptions): OfferingSeed[] {
  const priceStart = priceStartFor(opts.startDate);

  return [
    {
      name: EMBB_OFFERING_NAME,
      specs: ranUsageSpecs(),
      prices: [
        {
          // Base usage rate, card-driven: `rateCardLookUp` names the card the
          // `productCardLookUp` spec points at, so the envelope carries
          // PLA_USAGE_RATE (buildPriceEnvelope). The rating plane rates it at
          // `ratePerUnit` while the ACTIVE card carries no rate_per_unit (rm30).
          name: "Monthly Recurring Usage Rate",
          componentType: "usage_rate",
          unitOfMeasure: UNIT,
          glCode: "4000",
          startDateTime: priceStart,
          params: { ratePerUnit: "100", rateCardLookUp: RAN_USAGE_CARD_NAME },
        },
        {
          name: "Recurring Usage Target Capacity Commitment",
          componentType: "capacity_commitment",
          unitOfMeasure: UNIT,
          glCode: null,
          startDateTime: priceStart,
          params: { committedQuantity: 30000 },
        },
        {
          // "base 100; above 30000: 50" — the base is the usage rate above;
          // this is the single step past the committed capacity.
          name: "Recurring Usage (Additional) Target Capacity Motivation",
          componentType: "capacity_motivation",
          unitOfMeasure: UNIT,
          glCode: null,
          startDateTime: priceStart,
          params: { steps: [{ aboveQuantity: 30000, ratePerUnit: "50" }] },
        },
      ],
    },
    {
      name: PRIVATE_NETWORK_OFFERING_NAME,
      specs: [],
      prices: [
        {
          name: "Monthly Recurring Charge",
          componentType: "flat_fee",
          priceType: "recurring",
          recurringChargePeriodLength: 1,
          recurringChargePeriodType: "months",
          glCode: "4000",
          startDateTime: priceStart,
          params: { amount: opts.privateNetworkFee },
        },
      ],
    },
  ];
}

// Get-or-create by (name, ACTIVE). Inserted DRAFT, children written, then
// released to ACTIVE in one transaction (pm36 draft-guard order). Orderable
// requires `billing_only` + `is_sellable` (order-preconditions.ts Q16).
async function ensureOffering(
  tx: Database,
  seed: OfferingSeed,
  actorId: string,
): Promise<{ offeringId: string; created: boolean }> {
  const [existing] = await tx
    .select({ productOfferingId: productOffering.productOfferingId })
    .from(productOffering)
    .where(
      and(
        eq(productOffering.name, seed.name),
        eq(productOffering.lifecycleStatus, "ACTIVE"),
      ),
    )
    .limit(1);
  if (existing) {
    return { offeringId: existing.productOfferingId, created: false };
  }

  const [inserted] = await tx
    .insert(productOffering)
    .values({
      name: seed.name,
      isBundle: false,
      isSellable: true,
      billingOnly: true,
      lifecycleStatus: "DRAFT",
      version: 1,
      familyOfferingId: null,
      lastEditedBy: actorId,
    })
    .returning({ productOfferingId: productOffering.productOfferingId });
  if (!inserted) {
    throw new Error(`Offering '${seed.name}' was not inserted as expected.`);
  }
  const offeringId = inserted.productOfferingId;

  for (const spec of seed.specs) {
    await tx.insert(productSpecifications).values({
      refProductOfferingId: offeringId,
      name: spec.name,
      isMandatory: spec.isMandatory,
      isDefault: spec.isDefault,
      defaultValue: spec.defaultValue,
      productSpecCharacteristics: productSpecCharacteristicsSchema.parse(
        spec.characteristics,
      ),
    });
  }

  for (const price of seed.prices) {
    // Every payload goes through the same Zod union as user input before it
    // reaches the database (code-standards §1.7) — a bad fixture throws here.
    const parsed = persistablePricingComponentSchema.parse(
      buildPriceEnvelope(price),
    );
    const columns = toRowColumns(price);
    await tx.insert(productOfferingPrice).values({
      productOfferingId: offeringId,
      name: price.name,
      componentType: parsed["@type"],
      priceComponent: parsed,
      currency: CURRENCY,
      unitOfMeasure: columns.unitOfMeasure,
      recurringChargePeriodLength: columns.recurringChargePeriodLength,
      recurringChargePeriodType: columns.recurringChargePeriodType,
      glCode: price.glCode,
      policy: null,
      startDateTime: price.startDateTime,
    });
  }

  await tx
    .update(productOffering)
    .set({ lifecycleStatus: "ACTIVE", lastEditedBy: actorId })
    .where(eq(productOffering.productOfferingId, offeringId));

  return { offeringId, created: true };
}

// An existing offering re-run with an EARLIER demo start: any price that would
// start after the new price start is moved back to it (never forward — the
// same rule as subscriptions). Prices of an ACTIVE offering are immutable to
// the app (pm36's draft-guard trigger refuses the UPDATE), so this runs on the
// privileged connection with the trigger bypassed for this one transaction
// (`session_replication_role = replica`, superuser only).
async function realignPrices(
  backdateDb: Database,
  offering: { offeringId: string; name: string },
  priceStart: Date,
): Promise<void> {
  const late = await db
    .select({
      productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      name: productOfferingPrice.name,
    })
    .from(productOfferingPrice)
    .where(
      and(
        eq(productOfferingPrice.productOfferingId, offering.offeringId),
        gt(productOfferingPrice.startDateTime, priceStart),
      ),
    );
  if (late.length === 0) return;

  try {
    await backdateDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
      await tx
        .update(productOfferingPrice)
        .set({ startDateTime: priceStart })
        .where(
          and(
            eq(productOfferingPrice.productOfferingId, offering.offeringId),
            gt(productOfferingPrice.startDateTime, priceStart),
          ),
        );
    });
  } catch (err) {
    throw new Error(
      `db:seed-mno-demo: could not move ${late.length} price(s) of "${offering.name}" back to ${priceStart.toISOString()} ` +
        `(needs the superuser DSN in BOOTSTRAP_DATABASE_URL — the draft-guard trigger blocks the app role): ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  logger.info(
    `db:seed-mno-demo: "${offering.name}" price start moved back to ${priceStart.toISOString()} for ${late.map((p) => p.name).join(", ")}.`,
  );
}

// -- Customers ----------------------------------------------------------------

async function resolveBillCycleId(name: string): Promise<string> {
  const [cycle] = await db
    .select({ billCycleId: billCycle.billCycleId, state: billCycle.state })
    .from(billCycle)
    .where(eq(billCycle.name, name))
    .limit(1);
  if (!cycle) {
    throw new Error(
      `db:seed-mno-demo: bill cycle "${name}" not found — run \`db:seed-accounts\` or set DEMO_BILL_CYCLE.`,
    );
  }
  if (cycle.state !== "active") {
    throw new Error(`db:seed-mno-demo: bill cycle "${name}" is not active.`);
  }
  return cycle.billCycleId;
}

async function loadPartyRole(partyRoleId: string) {
  const role = await partyRoleRepository.findById(db, partyRoleId);
  if (!role) {
    throw new Error(`db:seed-mno-demo: party role ${partyRoleId} vanished.`);
  }
  return role;
}

// Get-or-create by registration number, through `createCustomer` (cm07). The
// MNO key is validated through mnoKeySpecSchema before it becomes the
// specification JSON.
async function ensureCustomer(
  seed: MnoCustomerSeed,
  actorId: string,
): Promise<{ organizationId: string; partyRoleId: string; created: boolean }> {
  const [existingOrg] = await db
    .select({ organizationId: organization.organizationId })
    .from(organization)
    .where(eq(organization.registrationNumber, seed.registrationNumber))
    .limit(1);
  if (existingOrg) {
    const [role] = await db
      .select({ partyRoleId: partyRole.partyRoleId })
      .from(partyRole)
      .where(
        and(
          eq(partyRole.engagedParty, existingOrg.organizationId),
          ne(partyRole.status, "CLOSED"),
        ),
      )
      .limit(1);
    if (!role) {
      throw new Error(
        `db:seed-mno-demo: organization ${existingOrg.organizationId} (${seed.name}) has no open party role.`,
      );
    }
    await ensureMnoKey(seed, role.partyRoleId, actorId);
    return {
      organizationId: existingOrg.organizationId,
      partyRoleId: role.partyRoleId,
      created: false,
    };
  }

  const specification = mnoKeySpecSchema.parse({
    mnoPublicKey1: seed.mnoPublicKey,
  });
  const input = createCustomerSchema.parse({
    name: seed.name,
    organizationType: "COMPANY",
    registrationNumber: seed.registrationNumber,
    industry: INDUSTRY,
    specificationRaw: JSON.stringify(specification),
    confirmed: true, // a re-run with a similar-but-different name is deliberate
  });
  const result = await createCustomer(input, actorId);
  if (!result.ok) {
    throw new Error(
      `db:seed-mno-demo: createCustomer(${seed.name}) was refused (${result.code}).`,
    );
  }
  return { ...result.value, created: true };
}

// Re-keys an existing customer whose `mnoPublicKey1` differs from the fixture,
// through the specification service (cm10) so the change is audited. Other keys
// in the specification are kept.
async function ensureMnoKey(
  seed: MnoCustomerSeed,
  partyRoleId: string,
  actorId: string,
): Promise<void> {
  const role = await loadPartyRole(partyRoleId);
  const current = role.partyRoleSpecification;
  if (current["mnoPublicKey1"] === seed.mnoPublicKey) return;

  const specification = mnoKeySpecSchema.parse({
    ...current,
    mnoPublicKey1: seed.mnoPublicKey,
  });
  const input = updatePartyRoleSpecificationSchema.parse({
    partyRoleId,
    specificationRaw: JSON.stringify(specification),
    lastModifiedDatetime: role.lastModifiedDatetime,
  });
  const result = await updatePartyRoleSpecification(input, actorId);
  if (!result.ok) {
    throw new Error(
      `db:seed-mno-demo: updatePartyRoleSpecification(${seed.name}) was refused (${result.code}).`,
    );
  }
  logger.info(
    `db:seed-mno-demo: ${seed.name} mnoPublicKey1 ${String(current["mnoPublicKey1"])} → ${seed.mnoPublicKey}.`,
  );
}

// First contact only when the customer has none (addContact also makes it the
// preferred contact, cm11).
async function ensureContact(
  seed: MnoCustomerSeed,
  partyRoleId: string,
  actorId: string,
): Promise<void> {
  const existing = await contactMediumRepository.findByPartyRoleId(
    db,
    partyRoleId,
  );
  if (existing.length > 0) return;

  const role = await loadPartyRole(partyRoleId);
  const input = addContactSchema.parse({
    partyRoleId,
    contactName: seed.contactName,
    contactRole: "Billing",
    emailAddress: seed.contactEmail,
    lastModifiedDatetime: role.lastModifiedDatetime,
  });
  const result = await addContact(input, actorId);
  if (!result.ok) {
    throw new Error(
      `db:seed-mno-demo: addContact(${seed.name}) was refused (${result.code}).`,
    );
  }
}

// INITIALIZED → VALIDATED + FA + Master BAN + the three ledger bindings, through
// the onboarding service (ac04). A customer already past INITIALIZED keeps the
// BAN it has.
async function ensureAccounts(
  seed: MnoCustomerSeed,
  partyRoleId: string,
  billCycleId: string,
  actorId: string,
): Promise<string> {
  const role = await loadPartyRole(partyRoleId);
  if (role.status === "INITIALIZED") {
    const input = onboardCustomerAccountsSchema.parse({
      partyRoleId,
      billCycleId,
      currency: CURRENCY,
      statusReason: "Accounts onboarded by db:seed-mno-demo.",
      lastModifiedDatetime: role.lastModifiedDatetime,
    });
    const result = await onboardCustomerAccounts(input, actorId);
    if (!result.ok) {
      throw new Error(
        `db:seed-mno-demo: onboardCustomerAccounts(${seed.name}) was refused (${result.code}).`,
      );
    }
    return result.value.billingAccountId;
  }

  const [ban] = await db
    .select({ billingAccountId: billingAccount.billingAccountId })
    .from(billingAccount)
    .where(
      and(
        eq(billingAccount.refPartyRoleId, partyRoleId),
        ne(billingAccount.state, "closed"),
      ),
    )
    .orderBy(billingAccount.billingAccountId)
    .limit(1);
  if (!ban) {
    throw new Error(
      `db:seed-mno-demo: ${seed.name} (${partyRoleId}) is ${role.status} but has no open billing account.`,
    );
  }
  return ban.billingAccountId;
}

// Organization REGISTERED → ACTIVE (cm09) and customer VALIDATED → ACTIVE
// (cm10) — ordering admits ACTIVE customers only (order-preconditions.ts Q14).
async function ensureActive(
  seed: MnoCustomerSeed,
  organizationId: string,
  partyRoleId: string,
  actorId: string,
): Promise<void> {
  const org = await organizationRepository.findById(db, organizationId);
  if (!org) {
    throw new Error(
      `db:seed-mno-demo: organization ${organizationId} vanished.`,
    );
  }
  if (org.status === "REGISTERED") {
    const role = await loadPartyRole(partyRoleId);
    const input = transitionOrganizationStatusSchema.parse({
      organizationId,
      partyRoleId,
      targetStatus: "ACTIVE",
      statusReason: "Activated by db:seed-mno-demo.",
      lastModifiedDatetime: role.lastModifiedDatetime,
    });
    const result = await transitionOrganizationStatus(input, actorId);
    if (!result.ok) {
      throw new Error(
        `db:seed-mno-demo: transitionOrganizationStatus(${seed.name}) was refused (${result.code}).`,
      );
    }
  }

  const role = await loadPartyRole(partyRoleId);
  if (role.status === "ACTIVE") return;
  if (role.status !== "VALIDATED") {
    throw new Error(
      `db:seed-mno-demo: ${seed.name} (${partyRoleId}) is ${role.status}; expected VALIDATED or ACTIVE.`,
    );
  }
  const input = transitionCustomerStatusSchema.parse({
    partyRoleId,
    targetStatus: "ACTIVE",
    statusReason: "Activated by db:seed-mno-demo.",
    lastModifiedDatetime: role.lastModifiedDatetime,
  });
  const result = await transitionCustomerStatus(input, actorId);
  if (!result.ok) {
    throw new Error(
      `db:seed-mno-demo: transitionCustomerStatus(${seed.name}) was refused (${result.code}).`,
    );
  }
}

// -- Orders -------------------------------------------------------------------

// `createOrder` admits a start date at most BACKDATING_TOLERANCE_DAYS in the
// past (pm28). A demo start further back is submitted for today and then moved
// to the demo date in place — the subscription window is what billing and
// rating read; the order's submitted/completed instants stay truthful.
function orderStartDate(
  demoStartDate: string,
  now: Date,
): { submitAs: string; backdateTo: string | null } {
  const nowUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const daysInPast = Math.round(
    (nowUtcMidnight - utcMidnight(demoStartDate)) / MS_PER_DAY,
  );
  if (daysInPast > BACKDATING_TOLERANCE_DAYS) {
    return { submitAs: toIsoDate(now), backdateTo: demoStartDate };
  }
  return { submitAs: demoStartDate, backdateTo: null };
}

async function ensureSubscription(
  seed: MnoCustomerSeed,
  partyRoleId: string,
  billingAccountId: string,
  offering: { offeringId: string; name: string },
  demoStartDate: string,
  actorId: string,
  backdateDb: Database,
): Promise<{ inventoryId: string; created: boolean }> {
  const [existing] = await db
    .select({
      productInventoryId: productInventory.productInventoryId,
    })
    .from(productInventory)
    .where(
      and(
        eq(productInventory.billingAccountId, billingAccountId),
        eq(productInventory.productOfferingId, offering.offeringId),
        ne(productInventory.status, "TERMINATED"),
      ),
    )
    .limit(1);
  if (existing) {
    // An interrupted earlier run can leave the subscription at its submitted
    // (today's) start date — finish that backdate; never move one forward.
    const previousStartDate = await backdateSubscription(
      backdateDb,
      existing.productInventoryId,
      demoStartDate,
    );
    if (previousStartDate !== null) {
      logger.info(
        `db:seed-mno-demo: ${seed.name} × "${offering.name}" start moved ${previousStartDate} → ${demoStartDate}.`,
      );
    }
    return { inventoryId: existing.productInventoryId, created: false };
  }

  const { submitAs, backdateTo } = orderStartDate(demoStartDate, new Date());
  const input = createOrderSchema.parse({
    customerPartyRoleId: partyRoleId,
    billingAccountId,
    productOfferingId: offering.offeringId,
    quantity: 1,
    startDate: submitAs,
  });
  const result = await createOrder(input, actorId);
  if (!result.ok) {
    throw new Error(
      `db:seed-mno-demo: createOrder(${seed.name}, ${offering.name}) was refused (${result.code}).`,
    );
  }
  if (result.status !== "COMPLETED" || result.inventoryId === null) {
    throw new Error(
      `db:seed-mno-demo: order ${result.orderId} did not complete (${result.status}).`,
    );
  }
  const inventoryId = result.inventoryId;

  if (backdateTo !== null) {
    await backdateSubscription(backdateDb, inventoryId, backdateTo);
  }
  return { inventoryId, created: true };
}

// Moves the subscription window (order item, inventory, genesis status row) to
// the demo start date in one transaction on the privileged connection.
async function backdateSubscription(
  backdateDb: Database,
  inventoryId: string,
  startDate: string,
): Promise<string | null> {
  return backdateDb.transaction(async (tx) => {
    const [inventory] = await tx
      .select({
        productOrderItemId: productInventory.productOrderItemId,
        startDate: productInventory.startDate,
      })
      .from(productInventory)
      .where(eq(productInventory.productInventoryId, inventoryId))
      .for("update");
    if (!inventory) {
      throw new Error(`db:seed-mno-demo: inventory ${inventoryId} vanished.`);
    }
    if (inventory.startDate <= startDate) return null;

    await tx
      .update(productOrderItem)
      .set({ startDate })
      .where(
        eq(productOrderItem.productOrderItemId, inventory.productOrderItemId),
      );
    await tx
      .update(productInventory)
      .set({ startDate })
      .where(eq(productInventory.productInventoryId, inventoryId));
    await tx
      .update(inventoryStatusHistory)
      .set({ effectiveDate: startDate })
      .where(
        and(
          eq(inventoryStatusHistory.productInventoryId, inventoryId),
          isNull(inventoryStatusHistory.fromStatus),
          gt(inventoryStatusHistory.effectiveDate, startDate),
        ),
      );
    return inventory.startDate;
  });
}

// -- Main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const backdateUrl = resolveBackdateUrl();
  assertNonProductionTarget(backdateUrl);
  const opts = resolveOptions();
  logger.info("db:seed-mno-demo: starting.", {
    startDate: opts.startDate,
    billCycle: opts.billCycleName,
    privateNetworkFee: opts.privateNetworkFee,
  });

  const backdateClient = postgres(backdateUrl, { max: 1 });
  const backdateDb = drizzle(backdateClient, { schema });

  try {
    // Pre-flight, before any write: the backdate step needs UPDATE on
    // write-once tables whenever the demo start is outside the tolerance.
    if (orderStartDate(opts.startDate, new Date()).backdateTo !== null) {
      await assertCanBackdate(backdateDb);
    }

    const actorId = await resolveActorId();
    const billCycleId = await resolveBillCycleId(opts.billCycleName);

    // 1. Offerings — one transaction, so neither can be left half-authored.
    const offerings = await db.transaction(async (tx) => {
      const out: { offeringId: string; name: string; created: boolean }[] = [];
      for (const seed of offeringSeeds(opts)) {
        const { offeringId, created } = await ensureOffering(tx, seed, actorId);
        logger.info(
          `db:seed-mno-demo: offering "${seed.name}" ${created ? "created" : "already ACTIVE"} (${offeringId}).`,
        );
        out.push({ offeringId, name: seed.name, created });
      }
      return out;
    });
    for (const offering of offerings) {
      if (!offering.created) {
        await realignPrices(
          backdateDb,
          offering,
          priceStartFor(opts.startDate),
        );
      }
    }

    // 2 + 3. Customers, accounts, activation, orders — through the services.
    const summary: Record<string, unknown>[] = [];
    for (const seed of MNO_CUSTOMERS) {
      const customer = await ensureCustomer(seed, actorId);
      await ensureContact(seed, customer.partyRoleId, actorId);
      const billingAccountId = await ensureAccounts(
        seed,
        customer.partyRoleId,
        billCycleId,
        actorId,
      );
      await ensureActive(
        seed,
        customer.organizationId,
        customer.partyRoleId,
        actorId,
      );

      const subscriptions: Record<string, string> = {};
      for (const offering of offerings) {
        const { inventoryId, created } = await ensureSubscription(
          seed,
          customer.partyRoleId,
          billingAccountId,
          offering,
          opts.startDate,
          actorId,
          backdateDb,
        );
        subscriptions[offering.name] = inventoryId;
        logger.info(
          `db:seed-mno-demo: ${seed.name} × "${offering.name}" → ${inventoryId} ${created ? "created" : "already subscribed"}.`,
        );
      }

      summary.push({
        mno: seed.mnoPublicKey,
        customer: seed.name,
        organizationId: customer.organizationId,
        partyRoleId: customer.partyRoleId,
        billingAccountId,
        ...subscriptions,
      });
    }

    logger.info("db:seed-mno-demo: MNO demo seeded.", {
      startDate: opts.startDate,
      offerings,
      customers: summary,
    });
    logger.info(
      `db:seed-mno-demo: next, upload the ${RAN_USAGE_CARD_NAME} rate card with each row's Subscriber Reference ID = the customer's partyRoleId above (MAXIS/CELCOM/TM/YTL in the MNO Name column).`,
    );
  } finally {
    // One-shot script on the shared application pool: close it (and the
    // backdate client) so the process exits promptly (seed-demo.ts precedent).
    await backdateClient.end({ timeout: 5 }).catch(() => {});
    await db.$client.end({ timeout: 5 }).catch(() => {});
  }
}

void main().catch((err: unknown) => {
  logger.error("MNO demo seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
