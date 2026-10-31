import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgresjs from "postgres";

import type { Database } from "@/db/client";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import * as schema from "@/db/schema";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { billCycle } from "@/db/schema/billing/catalogs";
import { appuser } from "@/db/schema/identity";
import { seedCoa } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { captureTemplateStamps } from "@/services/billing/capture-template-stamps";
import { createCapacityPricingFixtures } from "@/tests/db/helpers/billrun-capacity-pricing-fixtures";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";
import { runAggregation } from "@/tests/db/helpers/extract-flow-sql";
import { buildRawUdrKey } from "@/validation/rating/udr-key";
import { formatUdrResource } from "@/validation/rating/udr-resource.schema";

// rpt08-spec Implementation §4 — the Part D seed. Every invoice is built
// through the real bill-run path, so the `udr_rated` claims and capacity lines
// are the ones production would write and post: rating-shaped claimed rows
// (the rm26 raw `udr_key`, the rm25 `udr_resource`), aggregated by the
// extracted `bill_run_processing` SQL (the bm42 capacity lane: commitment
// floor, N-band motivation discount), template stamps captured by the real
// service, and the bill posted by the real `postAccount` (INV, ledger,
// `posted_attempt`, the finalization latch). The suite mocks the post-commit
// PDF render: posting never depends on it (D10), and the parity case reads the
// capacity detail directly.
//
// One thing is set directly, because posting stamps `now()`: each INV's
// `posted_at` (the PDF's Invoice Date), so the expected files are stable (the
// rpt03 seed's precedent).
//
// Its own seed, not the Part A one: Part C reports every party role with a
// billing account, so adding MNOs there would change rpt05's expected file.
//
// Invoices (posted on 2026-10-05, Asia/Kuala_Lumpur, unless stated):
//   P2 — MNO-P, posted first (the lower INV number): one polygon, 2.5 Mbps,
//        no discount (R08-T7)
//   P1 — MNO-P, another bill run and BAN (R08-T5): polygons 500.00 / 300.00 /
//        200.00 with a 100.00 line discount (R08-T6), and a claimed row in
//        another unit, billed as an ordinary USAGE line (R08-T3)
//   Q1 — MNO-Q, posted 23:59: polygons 100.00 / 125.00, a 5.00 discount that
//        doesn't split evenly (2.22 / 2.78)
//   Q2 — MNO-Q, posted 00:01 on 2026-10-06: not on the 20261005 file (Inv 8)
//   R1 — MNO-R, a polygon row with no polygon_id= key (POLYGON_ID_MISSING)
//   R2 — MNO-R, a polygon row with no commercial_unit= key
//        (COMMERCIAL_UNIT_MISSING); MNO-R gets no file
//   S1 — a party role with no mnoPublicKey1 (MNO_PUBLIC_KEY_MISSING)
//   T1 — MNO-T, a commitment-only capacity line with no usage
//        (NO_POLYGON_LINES)

export const INVOICE_DAY = "20261005";
export const NEXT_DAY = "20261006";

export const MNO = { P: "MNO-P", Q: "MNO-Q", R: "MNO-R", T: "MNO-T" } as const;

const PREFIX = "RPT08";
const PERIOD_START = "2026-09-01";
const PERIOD_END = "2026-09-30";
const CLAIM_AT = "2026-09-10T00:00:00.000Z";
const KEY_COLUMNS = ["commercial_unit", "mno_public_id", "polygon_id"];

export const PRODUCT = {
  embb: "eMBB Wholesale 5G Network",
  fwa: "FWA Wholesale Capacity",
} as const;

export interface PostedInvoice {
  invoiceId: string;
  runId: string;
  banId: string;
  customerBillId: string;
  periodPartition: string;
  attempt: number;
}

export interface InvoiceCsvFixture {
  // By fixture name (P1 … T1).
  invoices: Record<string, PostedInvoice>;
}

interface Polygon {
  polygonId: string | null;
  commercialUnit: string | null;
  ea: number;
  start?: string;
}

export async function seedInvoiceCsvFixture(
  sql: postgresjs.Sql,
): Promise<InvoiceCsvFixture> {
  const db = drizzle(sql, { schema });
  const appDb = db as unknown as Database;
  const [actor] = await db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName: `${PREFIX}-fixture-operator`,
      userEmail: `${crypto.randomUUID()}@example.invalid`,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  const actorId = actor!.id;
  const [cycle] = await db
    .insert(billCycle)
    .values({ name: `${PREFIX} Fixture Cycle`, lastEditedBy: null })
    .returning({ billCycleId: billCycle.billCycleId });
  const cycleId = cycle!.billCycleId;

  // The Accounts GL seeds real posting needs.
  await seedSysAccounts(appDb);
  await seedCoa(appDb);
  await seedGlMappings(appDb);
  await seedReasonCodes(appDb);

  const flow = createFlowDoubleFixtures({
    sql,
    db,
    getActorId: () => actorId,
    getCycleId: () => cycleId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    labelPrefix: PREFIX,
    scheduledRunDate: "2026-10-01",
  });
  const capacity = createCapacityPricingFixtures({
    getSql: () => sql,
    newOffering: (name) => flow.newOffering(name),
    newProductSpec: (offeringId, name, value) =>
      flow.newProductSpec(offeringId, name, value),
    newAccount: (label) => flow.newAccount(label),
    newRun: (runId) => flow.newRun(runId),
    newInventory: (args) => flow.newInventory(args),
    claimAt: CLAIM_AT,
    labelPrefix: PREFIX,
  });

  // The per-FA / BAN ledger accounts and bindings onboarding would create.
  async function bindLedger(banId: string): Promise<void> {
    const [ban] = await db
      .select({
        faId: billingAccount.refFinancialAccountId,
        currency: billingAccount.currency,
      })
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, banId));
    const { faId, currency } = ban!;
    for (const [ownerType, ownerId, ledgerRole, key] of [
      [
        "financial_account",
        faId,
        "unapplied_cash",
        `fa.${faId}.unapplied_cash`,
      ],
      ["financial_account", faId, "deposits", `fa.${faId}.deposits`],
      ["billing_account", banId, "receivables", `ban.${banId}.receivables`],
    ] as const) {
      const account = await ledgerRepository.createAccount(
        appDb,
        key,
        currency,
      );
      await ledgerBindingRepository.insert(appDb, {
        ownerType,
        ownerId,
        ledgerRole,
        pgledgerAccountId: account.id,
        lastEditedBy: actorId,
      });
    }
  }

  async function setKey(banId: string, mno: string | null): Promise<void> {
    // A JSON string cast in SQL: drizzle's driver (above) replaces the
    // client's serializers, so `sql.json` no longer applies to this client.
    const spec = mno === null ? {} : { mnoPublicKey1: mno };
    await sql`
      UPDATE customer.party_role SET party_role_specification = ${JSON.stringify(spec)}::jsonb
      WHERE party_role_id = (
        SELECT ref_party_role_id FROM billing.billing_account WHERE billing_account_id = ${banId})
    `;
  }

  // One BAN with one capacity subscription on its own bill run: the claimed
  // rows, the real aggregation, the template capture, then the real post.
  async function postedInvoice(args: {
    label: string;
    mno: string | null;
    product: string;
    offering: Parameters<typeof capacity.newCapacityOffering>[1];
    polygons: Polygon[];
    otherUnitGb?: number; // a claimed row in GB: an ordinary USAGE line
    postedAt: string;
  }): Promise<PostedInvoice> {
    const { ban, runId, piId, usageRatePriceId } =
      await capacity.setupSingleAccountCapacity(
        args.label,
        args.product,
        args.offering,
      );
    await setKey(ban, args.mno);
    for (const polygon of args.polygons) {
      const columns: Record<string, string> = {
        mno_public_id: args.mno ?? "UNKEYED",
      };
      if (polygon.commercialUnit !== null)
        columns.commercial_unit = polygon.commercialUnit;
      if (polygon.polygonId !== null) columns.polygon_id = polygon.polygonId;
      await capacity.insertCapacityVolumeRow({
        subRef: piId,
        runId,
        ban,
        attempt: 1,
        quantityEa: polygon.ea,
        rate: "100",
        priceRef: usageRatePriceId,
        udrKey: buildRawUdrKey(
          columns,
          KEY_COLUMNS.filter((c) => c in columns),
        ),
        udrResource: formatUdrResource({
          state: "SELANGOR",
          district: "PETALING",
          polygonStartDate: polygon.start ?? "2025-03-01",
        }),
      });
    }
    if (args.otherUnitGb !== undefined) {
      const gbRate = await capacity.newUsageRate(
        (await offeringOf(piId))!,
        "GB",
        "2",
        "2026-01-01T00:00:00Z",
      );
      await capacity.insertCapacityVolumeRow({
        subRef: piId,
        runId,
        ban,
        attempt: 1,
        quantityEa: args.otherUnitGb,
        rate: "2",
        priceRef: gbRate,
        unit: "GB",
        udrKey: buildRawUdrKey(
          {
            commercial_unit: "CU-OTHER",
            mno_public_id: args.mno ?? "UNKEYED",
            polygon_id: "PCU-OTHER-GB",
          },
          KEY_COLUMNS,
        ),
      });
    }
    await runAggregation(sql, {
      runId,
      ban,
      attempt: 1,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      glEventAt: PERIOD_START,
    });
    await db.insert(billRunAccount).values({
      refBillRunId: runId,
      refBillingAccountId: ban,
      periodPartition: PERIOD_START,
      status: "PROCESSED",
      attemptCount: 1,
    });
    await captureTemplateStamps(appDb, runId, [ban], PERIOD_START);
    await bindLedger(ban);

    const { postAccount } = await import("@/services/billing/post-run");
    const [run] = await db
      .select()
      .from(billRun)
      .where(eq(billRun.billRunId, runId));
    const result = await postAccount(
      { ...run!, approvedBy: actorId },
      ban,
      actorId,
    );
    if (result.status !== "invoiced") {
      throw new Error(
        `seed: ${args.label} not invoiced: ${JSON.stringify(result)}`,
      );
    }
    await sql`
      UPDATE billing.document SET posted_at = ${args.postedAt}::timestamptz
      WHERE document_id = ${result.invoiceId}
    `;
    const [bill] = await sql<
      {
        customer_bill_id: string;
        period_partition: string;
        posted_attempt: number;
      }[]
    >`
      SELECT customer_bill_id, period_partition::text AS period_partition, posted_attempt
      FROM billing.customer_bill WHERE ref_inv_document_id = ${result.invoiceId}
    `;
    return {
      invoiceId: result.invoiceId,
      runId,
      banId: ban,
      customerBillId: bill!.customer_bill_id,
      periodPartition: bill!.period_partition,
      attempt: bill!.posted_attempt,
    };
  }

  async function offeringOf(piId: string): Promise<string | undefined> {
    const [row] = await sql<{ id: string }[]>`
      SELECT product_offering_id AS id FROM inventory.product_inventory
      WHERE product_inventory_id = ${piId}
    `;
    return row?.id;
  }

  // A capacity offering is one with a commitment or motivation component
  // (bm42, Inv #32); a band no fixture reaches gives a 0.00 line discount.
  const usageOnly = {
    baseRate: "100",
    committedQuantity: null,
    steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
  };
  const at = (time: string) => `2026-10-05T${time}+08:00`;
  const invoices: Record<string, PostedInvoice> = {};

  invoices.P2 = await postedInvoice({
    label: "P2",
    mno: MNO.P,
    product: PRODUCT.fwa,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-P-0004", commercialUnit: "CU-P-2", ea: 2.5 }],
    postedAt: at("09:00:00"),
  });
  invoices.P1 = await postedInvoice({
    label: "P1",
    mno: MNO.P,
    product: PRODUCT.embb,
    // 10 Mbps: the 5 above 5 at RM80 instead of RM100, a 100.00 line discount.
    offering: {
      baseRate: "100",
      committedQuantity: null,
      steps: [{ aboveQuantity: 5, ratePerUnit: "80" }],
    },
    polygons: [
      { polygonId: "PCU-P-0001", commercialUnit: "CU-P-1", ea: 5 },
      {
        polygonId: "PCU-P-0002",
        commercialUnit: "CU-P-1",
        ea: 3,
        start: "2025-04-15",
      },
      { polygonId: "PCU-P-0003", commercialUnit: "CU-P-1", ea: 2 },
    ],
    otherUnitGb: 4,
    postedAt: at("10:00:00"),
  });
  invoices.Q1 = await postedInvoice({
    label: "Q1",
    mno: MNO.Q,
    product: PRODUCT.embb,
    // 0.25 Mbps above 2 at RM80: a 5.00 line discount over 100.00 / 125.00.
    offering: {
      baseRate: "100",
      committedQuantity: null,
      steps: [{ aboveQuantity: 2, ratePerUnit: "80" }],
    },
    polygons: [
      { polygonId: "PCU-Q-0001", commercialUnit: "CU-Q-1", ea: 1 },
      { polygonId: "PCU-Q-0002", commercialUnit: "CU-Q-1", ea: 1.25 },
    ],
    postedAt: at("23:59:00"),
  });
  invoices.Q2 = await postedInvoice({
    label: "Q2",
    mno: MNO.Q,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-Q-0003", commercialUnit: "CU-Q-2", ea: 1 }],
    postedAt: "2026-10-06T00:01:00+08:00",
  });
  invoices.R1 = await postedInvoice({
    label: "R1",
    mno: MNO.R,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: null, commercialUnit: "CU-R-1", ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.R2 = await postedInvoice({
    label: "R2",
    mno: MNO.R,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-R-0002", commercialUnit: null, ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.S1 = await postedInvoice({
    label: "S1",
    mno: null,
    product: PRODUCT.embb,
    offering: usageOnly,
    polygons: [{ polygonId: "PCU-S-0001", commercialUnit: "CU-S-1", ea: 1 }],
    postedAt: at("09:00:00"),
  });
  invoices.T1 = await postedInvoice({
    label: "T1",
    mno: MNO.T,
    product: PRODUCT.embb,
    // The commitment floor alone: a capacity line, no claimed row.
    offering: { baseRate: "100", committedQuantity: 2, steps: null },
    polygons: [],
    postedAt: at("09:00:00"),
  });
  return { invoices };
}
