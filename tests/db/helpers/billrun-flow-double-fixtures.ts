import { and, asc, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import type postgresjs from "postgres";

import type * as schema from "@/db/schema";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { productOffering } from "@/db/schema/product";

// Shared scaffolding for the "flow-double" DB-gated integration suites (the
// bm21/bm28/bm29 pattern — tests/db/billrun-*-aggregation.integration.test.ts):
// an account/run/offering/inventory builder plus bill/line readers, factored
// out of billrun-capacity-aggregation.integration.test.ts (bm42) to stop that
// file's copy of this boilerplate from re-tripping SonarQube's duplicated-
// lines-on-new-code check. bm28/bm29/bm35's own copies are untouched — this
// is additive, not a cross-file rename — but a future flow-double suite
// (bm43/bm44/bm45) can adopt this instead of re-pasting the block again.
export interface FlowDoubleFixturesDeps {
  readonly sql: postgresjs.Sql;
  readonly db: ReturnType<typeof drizzle<typeof schema>>;
  readonly getActorId: () => string;
  readonly getCycleId: () => string;
  readonly periodStart: string;
  readonly periodEnd: string;
  // Org/FA/BAN/run-cycle naming prefix, e.g. "BM42" (also lower-cased for the
  // fabricated inventory party ref).
  readonly labelPrefix: string;
  // onCycle constraint (0026): scheduled_run_date = period_end + 1.
  readonly scheduledRunDate?: string;
}

export function createFlowDoubleFixtures(deps: FlowDoubleFixturesDeps) {
  const {
    sql,
    db,
    getActorId,
    getCycleId,
    periodStart,
    periodEnd,
    labelPrefix,
  } = deps;
  const scheduledRunDate = deps.scheduledRunDate ?? "2026-07-01";

  async function dropAll(client: postgresjs.Sql): Promise<void> {
    await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
    await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
  }

  async function newAccount(label: string, currency = "MYR"): Promise<string> {
    const actorId = getActorId();
    const [org] = await db
      .insert(organization)
      .values({
        name: `${labelPrefix}-${label}-Customer`,
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
    const [fa] = await db
      .insert(financialAccount)
      .values({
        name: `${labelPrefix}-${label}-FA`,
        refPartyRoleId: role!.partyRoleId,
        currency,
        lastEditedBy: actorId,
      })
      .returning({ financialAccountId: financialAccount.financialAccountId });
    const [ban] = await db
      .insert(billingAccount)
      .values({
        name: `${labelPrefix}-${label}-BAN`,
        state: "active",
        refPartyRoleId: role!.partyRoleId,
        refFinancialAccountId: fa!.financialAccountId,
        currency,
        refBillCycleId: getCycleId(),
        lastEditedBy: actorId,
      })
      .returning({ billingAccountId: billingAccount.billingAccountId });
    return ban!.billingAccountId;
  }

  // A real bill_run row so the customer_bill FK (ref_bill_run_id -> bill_run)
  // is satisfied — the flow's aggregation always runs against a triggered
  // run. Each run gets its own throwaway cycle so the `(ref_bill_cycle_id,
  // period_start)` uniqueness never collides across tests.
  async function newRun(runId: string): Promise<void> {
    const [runCycle] = await db
      .insert(billCycle)
      .values({ name: `${labelPrefix} Run Cycle ${runId}`, lastEditedBy: null })
      .returning({ billCycleId: billCycle.billCycleId });
    await db.insert(billRun).values({
      billRunId: runId,
      refBillCycleId: runCycle!.billCycleId,
      periodStart,
      periodEnd,
      scheduledRunDate,
      status: "PROCESSING",
      runType: "onCycle",
    });
  }

  async function newOffering(
    name: string,
    opts?: { isBundle?: boolean; isSellable?: boolean; billingOnly?: boolean },
  ): Promise<string> {
    const [off] = await db
      .insert(productOffering)
      .values({
        name,
        isBundle: opts?.isBundle ?? false,
        isSellable: opts?.isSellable ?? true,
        billingOnly: opts?.billingOnly ?? false,
      })
      .returning({ productOfferingId: productOffering.productOfferingId });
    return off!.productOfferingId;
  }

  async function newProductSpec(
    offeringId: string,
    name: string,
    defaultValue: string,
  ): Promise<void> {
    await sql`
      INSERT INTO product.product_specifications
        (ref_product_offering_id, name, is_mandatory, is_default, default_value, product_spec_characteristics)
      VALUES (${offeringId}, ${name}, true, true, ${defaultValue}, '{}'::jsonb)
    `;
  }

  // A product_inventory row linking a chosen product_inventory_id →
  // (account, offering), with FK triggers off (session_replication_role =
  // replica) so the unrelated ordering/party FKs can be fabricated — the
  // bm27 fixture technique.
  async function newInventory(args: {
    piId: string;
    ban: string;
    offeringId: string;
    quantity: number;
    orderItemId: string;
    status?: string;
  }): Promise<void> {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`
        INSERT INTO inventory.product_inventory
          (product_inventory_id, product_order_item_id, customer_party_role_id,
           billing_account_id, product_offering_id, quantity, status, start_date)
        VALUES
          (${args.piId}, ${args.orderItemId}, ${`_${labelPrefix.toLowerCase()}-party-${args.piId}`},
           ${args.ban}, ${args.offeringId}, ${args.quantity},
           ${args.status ?? "ACTIVE"}, '2026-01-01')
      `;
    });
  }

  async function readBill(runId: string, ban: string) {
    const [bill] = await db
      .select({
        customerBillId: customerBill.customerBillId,
        subtotal: customerBill.subtotal,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, runId),
          eq(customerBill.refBillingAccountId, ban),
        ),
      );
    return bill;
  }

  async function readLines(customerBillId: string) {
    return db
      .select({
        lineNo: customerBillLine.lineNo,
        source: customerBillLine.source,
        offeringId: customerBillLine.refProductOfferingId,
        udrType: customerBillLine.udrType,
        quantity: customerBillLine.quantity,
        unit: customerBillLine.unit,
        grossAmount: customerBillLine.grossAmount,
        discountAmount: customerBillLine.discountAmount,
        netAmount: customerBillLine.netAmount,
        udrCount: customerBillLine.udrCount,
        ratedAmount: customerBillLine.ratedAmount,
        discountAmountRaw: customerBillLine.discountAmountRaw,
        additionalInfo: customerBillLine.additionalInfo,
      })
      .from(customerBillLine)
      .where(eq(customerBillLine.refCustomerBillId, customerBillId))
      .orderBy(asc(customerBillLine.lineNo));
  }

  return {
    dropAll,
    newAccount,
    newRun,
    newOffering,
    newProductSpec,
    newInventory,
    readBill,
    readLines,
  };
}
