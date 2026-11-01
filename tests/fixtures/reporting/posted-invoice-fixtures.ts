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

// Posted capacity invoices built through the real bill-run path, shared by the
// Part D seed (rpt08, invoice-csv-seed.ts) and the Part E seed (rpt09,
// gl-feed-seed.ts). Every invoice is rating-shaped claimed rows (the rm26 raw
// `udr_key`, the rm25 `udr_resource`), aggregated by the extracted
// `bill_run_processing` SQL (the bm42 capacity lane: commitment floor, N-band
// motivation discount), template stamps captured by the real service, and the
// bill posted by the real `postAccount` (INV, ledger, `posted_attempt`, the
// finalization latch). Callers mock the post-commit PDF render: posting never
// depends on it (D10).
//
// One thing is set directly, because posting stamps `now()`: each INV's
// `posted_at` (the PDF's Invoice Date), so the expected files are stable (the
// rpt03 seed's precedent).

const KEY_COLUMNS = ["commercial_unit", "mno_public_id", "polygon_id"];

export interface PostedInvoice {
  invoiceId: string;
  runId: string;
  banId: string;
  customerBillId: string;
  periodPartition: string;
  attempt: number;
  usageRatePriceId: string | null;
}

export interface Polygon {
  polygonId: string | null;
  commercialUnit: string | null;
  ea: number;
  start?: string;
}

export type CapacityOffering = Parameters<
  ReturnType<typeof createCapacityPricingFixtures>["newCapacityOffering"]
>[1];

export async function createPostedInvoiceFixtures(
  sql: postgresjs.Sql,
  opts: {
    prefix: string;
    periodStart: string;
    periodEnd: string;
    claimAt: string;
  },
) {
  const { prefix, periodStart, periodEnd } = opts;
  const db = drizzle(sql, { schema });
  const appDb = db as unknown as Database;
  const [actor] = await db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName: `${prefix}-fixture-operator`,
      userEmail: `${crypto.randomUUID()}@example.invalid`,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  const actorId = actor!.id;
  const [cycle] = await db
    .insert(billCycle)
    .values({ name: `${prefix} Fixture Cycle`, lastEditedBy: null })
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
    periodStart,
    periodEnd,
    labelPrefix: prefix,
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
    claimAt: opts.claimAt,
    labelPrefix: prefix,
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

  async function offeringOf(piId: string): Promise<string | undefined> {
    const [row] = await sql<{ id: string }[]>`
      SELECT product_offering_id AS id FROM inventory.product_inventory
      WHERE product_inventory_id = ${piId}
    `;
    return row?.id;
  }

  // One BAN with one capacity subscription on its own bill run: the claimed
  // rows, the real aggregation, the template capture, then the real post.
  async function postedInvoice(args: {
    label: string;
    mno: string | null;
    product: string;
    offering: CapacityOffering;
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
      periodStart,
      periodEnd,
      glEventAt: periodStart,
    });
    await db.insert(billRunAccount).values({
      refBillRunId: runId,
      refBillingAccountId: ban,
      periodPartition: periodStart,
      status: "PROCESSED",
      attemptCount: 1,
    });
    await captureTemplateStamps(appDb, runId, [ban], periodStart);
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
      usageRatePriceId,
    };
  }

  return {
    db,
    appDb,
    actorId,
    cycleId,
    flow,
    capacity,
    bindLedger,
    setKey,
    postedInvoice,
  };
}
