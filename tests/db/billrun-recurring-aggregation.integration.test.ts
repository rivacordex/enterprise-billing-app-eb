import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { productOffering } from "@/db/schema/product";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/billrun-aggregate";

// bm29-spec §Implementation §6 / Verification checklist — the DB-gated RECURRING
// aggregation regression. The app-repo "flow-double" (bm21/bm28 pattern): it
// performs the SAME `billrun_runtime` writes the real bill_run_processing flow's
// Aggregation stage now performs for the RECURRING source (resolve each ACTIVE
// subscription's flat recurring price as-of the run period via the lead() window,
// COALESCE an order_item_price_override over the catalog amount, × quantity, one
// line per offering rolled across subscriptions; a price snapshot READ-not-re-
// resolved on rerun; the D33 HARD-fail branch), so the behaviour is provable
// without a live Kestra. It asserts:
//   * a recurring-only account bills its subscriptions (× quantity), no usage, and
//     stores the price snapshot on the line;
//   * a mixed account (same offering, usage + recurring) shows exactly 2 lines
//     (USAGE + RECURRING) with a single deterministic line_no across both sources
//     and subtotal = SUM(net_amount) spanning both (§9.2/§9.5);
//   * a rerun after a BACKDATED product_offering_price insert reproduces the
//     ORIGINAL amounts — the snapshot is read, never re-resolved (Inv #20/D19);
//   * an order_item_price_override wins over the catalog amount;
//   * a `tiered` price fails the account HARD (RECURRING_PRICE_UNSUPPORTED) and a
//     missing price fails HARD (RECURRING_PRICE_NOT_FOUND) — no bill produced,
//     never zero-substituted (D33/Inv #28).
//
// It runs on the superuser DATABASE_URL connection (like the bm28 double), so it
// exercises the aggregation LOGIC, not the billrun_runtime grants — those are
// proven by billrun-db-roles.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
const USAGE_PRICE = "10.00";

describe.skipIf(!databaseUrl)(
  "bm29 recurring aggregation into customer_bill_line (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;
    let seq = 0;

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    async function newAccount(label: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM29-${label}-Customer`,
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
          name: `BM29-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM29-${label}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "MYR",
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newRun(runId: string): Promise<void> {
      const [runCycle] = await db
        .insert(billCycle)
        .values({ name: `BM29 Run Cycle ${runId}`, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      await db.insert(billRun).values({
        billRunId: runId,
        refBillCycleId: runCycle!.billCycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        scheduledRunDate: "2026-07-01",
        status: "PROCESSING",
        runType: "onCycle",
      });
    }

    async function newOffering(name: string): Promise<string> {
      const [off] = await db
        .insert(productOffering)
        .values({
          name,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      return off!.productOfferingId;
    }

    // A flat recurring catalog price effective from `startIso` (monthly period).
    async function newRecurringPrice(
      offeringId: string,
      amount: string,
      startIso: string,
    ): Promise<string> {
      const [row] = await sql<{ product_offering_price_id: string }[]>`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, recurring_charge_period_length,
           recurring_charge_period_type, amount, currency, pricing_model, start_date_time)
        VALUES
          (${offeringId}, 'BM29 Recurring', 'recurring', 1, 'months',
           ${amount}, 'MYR', 'flat', ${startIso}::timestamptz)
        RETURNING product_offering_price_id
      `;
      return row!.product_offering_price_id;
    }

    // A tiered recurring price (amount NULL by the amount_xor_tiers CHECK) — the
    // flat resolver cannot rate it (D33 → RECURRING_PRICE_UNSUPPORTED).
    async function newTieredPrice(offeringId: string): Promise<void> {
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, recurring_charge_period_length,
           recurring_charge_period_type, amount, currency, pricing_model,
           pricing_characteristics, start_date_time)
        VALUES
          (${offeringId}, 'BM29 Tiered', 'recurring', 1, 'months',
           NULL, 'MYR', 'tiered', ${JSON.stringify({ tiers: [] })}::jsonb, '2026-01-01T00:00:00Z'::timestamptz)
      `;
    }

    // A subscription (product_inventory) linking a chosen id → (account, offering)
    // with a settable quantity + order-item ref (for the override join). Only
    // billing_account_id / product_offering_id / quantity / product_order_item_id
    // / status matter here, so FK triggers are off (session_replication_role =
    // replica) — the bm27/bm28 fixture technique.
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
            (${args.piId}, ${args.orderItemId}, ${`_bm29-party-${args.piId}`},
             ${args.ban}, ${args.offeringId}, ${args.quantity},
             ${args.status ?? "ACTIVE"}, '2026-01-01')
        `;
      });
    }

    // An insert-only per-(item, price_type) override (FK to product_order_item off).
    async function newOverride(
      orderItemId: string,
      amount: string,
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO ordering.order_item_price_override
            (product_order_item_id, price_type, amount, currency)
          VALUES (${orderItemId}, 'recurring', ${amount}, 'MYR')
        `;
      });
    }

    // One CLAIMED RAN_USAGE row (the shape Collection leaves before Aggregation),
    // for the mixed-source case. `udr_key` varies by a global sequence.
    async function insertClaimedRow(args: {
      subRef: string;
      runId: string;
      ban: string;
      attempt: number;
    }): Promise<void> {
      seq += 1;
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw,
           udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
           rating_engine_version, rating_flow_revision,
           billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
           upsert_datetime)
        VALUES
          (rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
           ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
           ${args.subRef}, ${`_bm29-key-${seq}`}, '1.000000', 'EA', 'FLAT',
           ${USAGE_PRICE}, ${USAGE_PRICE}, 'HALF_UP', 'MYR', '_BM29_BATCH',
           '_BM29', '_BM29', 0,
           ${args.runId}, ${args.ban}, ${args.attempt}, 'bm29-claim', now())
      `;
    }

    // The flow-double: drive the SHARED aggregation helper (tests/db/helpers/
    // billrun-aggregate.ts) — the SAME billrun_runtime SQL the flow runs, so this
    // double and the bm28 USAGE double never drift from each other or the flow. A
    // D33 RAISE rejects the promise, rolling the whole account back (no bill).
    async function aggregate(
      runId: string,
      ban: string,
      attempt: number,
    ): Promise<void> {
      await runAggregation(sql, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
    }

    async function readBill(runId: string, ban: string) {
      const [bill] = await db
        .select({
          customerBillId: customerBill.customerBillId,
          subtotal: customerBill.subtotal,
          taxTotal: customerBill.taxTotal,
          totalAmount: customerBill.totalAmount,
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
          lineType: customerBillLine.lineType,
          offeringId: customerBillLine.refProductOfferingId,
          udrType: customerBillLine.udrType,
          description: customerBillLine.description,
          quantity: customerBillLine.quantity,
          unit: customerBillLine.unit,
          grossAmount: customerBillLine.grossAmount,
          discountAmount: customerBillLine.discountAmount,
          netAmount: customerBillLine.netAmount,
          udrCount: customerBillLine.udrCount,
          groupingKey: customerBillLine.groupingKey,
          currency: customerBillLine.currency,
          snapshotPriceRef: customerBillLine.snapshotPriceRef,
          snapshotUnitPrice: customerBillLine.snapshotUnitPrice,
          snapshotQuantity: customerBillLine.snapshotQuantity,
          snapshotEffectiveDate: customerBillLine.snapshotEffectiveDate,
        })
        .from(customerBillLine)
        .where(eq(customerBillLine.refCustomerBillId, customerBillId))
        .orderBy(asc(customerBillLine.lineNo));
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // `billrun_delete_trial_bill` is created by db/bootstrap/billrun-db-roles.sql
      // (not a migration), so create it here for the flow-double (verbatim). The
      // SECURITY DEFINER + grant boundary is proven separately by
      // billrun-db-roles.integration.test.ts.
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION "billing".billrun_delete_trial_bill(p_run text, p_ban text)
        RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = billing AS $$
          WITH d AS (
            DELETE FROM billing.customer_bill
             WHERE ref_bill_run_id = p_run
               AND ref_billing_account_id = p_ban
               AND ref_inv_document_id IS NULL
            RETURNING 1
          )
          SELECT count(*)::integer FROM d;
        $$;
      `);

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM29-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM29 Fixture Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "bills a recurring-only account (× quantity, rolled across subscriptions), " +
        "stores the price snapshot, and writes no usage line (bm29-spec §9.1/§9.2)",
      async () => {
        const ban = await newAccount("RecOnly");
        const off = await newOffering("Recurring Offering");
        const runId = "BRN-BM29-01";
        const priceId = await newRecurringPrice(
          off,
          "20.00",
          "2026-01-01T00:00:00Z",
        );
        await newRun(runId);

        // 2 subscriptions of the offering, quantities 1 and 2 → 3 units × 20.00.
        await newInventory({
          piId: "PRDINV-BM29-R0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm29-oi-R0",
        });
        await newInventory({
          piId: "PRDINV-BM29-R1",
          ban,
          offeringId: off,
          quantity: 2,
          orderItemId: "_bm29-oi-R1",
        });

        await aggregate(runId, ban, 1);

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);

        // Exactly one RECURRING line (rolled across the 2 subscriptions), no usage.
        expect(lines).toHaveLength(1);
        const [line] = lines;
        expect(line!.source).toBe("RECURRING");
        expect(line!.lineType).toBe("charge");
        expect(line!.udrType).toBeNull();
        expect(line!.udrCount).toBeNull();
        expect(line!.offeringId).toBe(off);
        expect(line!.groupingKey).toBe(`${off}:RECURRING`);
        expect(line!.description).toBe("Recurring Offering");
        expect(line!.currency).toBe("MYR");

        // 3 units × 20.00 = 60.00; no discount → net = gross.
        expect(line!.grossAmount).toBe("60.00");
        expect(line!.discountAmount).toBe("0.00");
        expect(line!.netAmount).toBe("60.00");
        expect(bill!.subtotal).toBe("60.00");
        expect(bill!.totalAmount).toBe("60.00");

        // The price snapshot is stored (the reviewer's evidence + rerun authority).
        expect(line!.snapshotPriceRef).toBe(priceId);
        expect(Number(line!.snapshotUnitPrice)).toBe(20);
        expect(Number(line!.snapshotQuantity)).toBe(3);
        expect(line!.snapshotEffectiveDate).toBe("2026-01-01");
      },
      120_000,
    );

    it(
      "a mixed account (same offering: usage + recurring) shows exactly 2 lines " +
        "with one deterministic line_no across both sources; subtotal = SUM(net) " +
        "(bm29-spec §9.2/§9.5)",
      async () => {
        const ban = await newAccount("Mixed");
        const off = await newOffering("Mixed Offering");
        const runId = "BRN-BM29-02";
        await newRecurringPrice(off, "15.00", "2026-01-01T00:00:00Z");
        await newRun(runId);

        // One subscription (quantity 1) that both carries recurring AND has usage.
        await newInventory({
          piId: "PRDINV-BM29-M0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm29-oi-M0",
        });
        // 3 claimed usage records @ 10.00 → a 30.00 USAGE line.
        for (let i = 0; i < 3; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM29-M0",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);

        const bill = await readBill(runId, ban);
        const lines = await readLines(bill!.customerBillId);

        // Two lines: USAGE (grouping "off:RAN_USAGE") + RECURRING ("off:RECURRING").
        // 'A' < 'E' lexicographically → RAN_USAGE is line_no 1, RECURRING is 2.
        expect(lines).toHaveLength(2);
        const [usage, recurring] = lines;
        expect(usage!.lineNo).toBe(1);
        expect(usage!.source).toBe("USAGE");
        expect(usage!.udrType).toBe("RAN_USAGE");
        expect(usage!.udrCount).toBe(3);
        expect(usage!.netAmount).toBe("30.00");

        expect(recurring!.lineNo).toBe(2);
        expect(recurring!.source).toBe("RECURRING");
        expect(recurring!.udrType).toBeNull();
        expect(recurring!.netAmount).toBe("15.00");

        // subtotal spans BOTH sources.
        expect(bill!.subtotal).toBe("45.00");
        expect(bill!.totalAmount).toBe("45.00");
      },
      120_000,
    );

    it(
      "a rerun after a BACKDATED product_offering_price insert reproduces the " +
        "ORIGINAL amounts — the snapshot is read, never re-resolved (Inv #20/D19)",
      async () => {
        const ban = await newAccount("Snapshot");
        const off = await newOffering("Snapshot Offering");
        const runId = "BRN-BM29-03";
        const originalPriceId = await newRecurringPrice(
          off,
          "20.00",
          "2026-01-01T00:00:00Z",
        );
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM29-S0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm29-oi-S0",
        });

        await aggregate(runId, ban, 1);
        const first = await readBill(runId, ban);
        const firstLines = await readLines(first!.customerBillId);
        expect(firstLines).toHaveLength(1);
        expect(firstLines[0]!.netAmount).toBe("20.00");
        expect(firstLines[0]!.snapshotPriceRef).toBe(originalPriceId);

        // The re-pricing hazard: a price row inserted LATER with an EARLIER start
        // shifts the lead() window, so a naive re-resolution as-of 2026-06-01 would
        // now pick 99.00. The snapshot must win.
        await newRecurringPrice(off, "99.00", "2026-03-01T00:00:00Z");

        await aggregate(runId, ban, 1);
        const second = await readBill(runId, ban);
        const secondLines = await readLines(second!.customerBillId);

        // A fresh header (whole-account replace), still one recurring line, and the
        // ORIGINAL amount + original snapshot ref — NOT the backdated 99.00.
        expect(second!.customerBillId).not.toBe(first!.customerBillId);
        expect(secondLines).toHaveLength(1);
        expect(secondLines[0]!.netAmount).toBe("20.00");
        expect(secondLines[0]!.snapshotPriceRef).toBe(originalPriceId);
        expect(second!.subtotal).toBe("20.00");
      },
      120_000,
    );

    it("an order_item_price_override wins over the catalog amount (bm29-spec §Design)", async () => {
      const ban = await newAccount("Override");
      const off = await newOffering("Override Offering");
      const runId = "BRN-BM29-04";
      await newRecurringPrice(off, "20.00", "2026-01-01T00:00:00Z");
      await newRun(runId);
      await newInventory({
        piId: "PRDINV-BM29-O0",
        ban,
        offeringId: off,
        quantity: 1,
        orderItemId: "_bm29-oi-O0",
      });
      // The override (5.00) is COALESCE'd OVER the catalog amount (20.00).
      await newOverride("_bm29-oi-O0", "5.00");

      await aggregate(runId, ban, 1);
      const bill = await readBill(runId, ban);
      const lines = await readLines(bill!.customerBillId);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.netAmount).toBe("5.00");
      expect(Number(lines[0]!.snapshotUnitPrice)).toBe(5);
      expect(bill!.subtotal).toBe("5.00");
    }, 120_000);

    it(
      "[CRITICAL] a tiered price fails the account HARD (RECURRING_PRICE_UNSUPPORTED) " +
        "and produces no bill; a missing price fails HARD (RECURRING_PRICE_NOT_FOUND) " +
        "(D33/Inv #28)",
      async () => {
        // Tiered → UNSUPPORTED.
        const tieredBan = await newAccount("Tiered");
        const tieredOff = await newOffering("Tiered Offering");
        const tieredRun = "BRN-BM29-05";
        await newTieredPrice(tieredOff);
        await newRun(tieredRun);
        await newInventory({
          piId: "PRDINV-BM29-T0",
          ban: tieredBan,
          offeringId: tieredOff,
          quantity: 1,
          orderItemId: "_bm29-oi-T0",
        });
        await expect(aggregate(tieredRun, tieredBan, 1)).rejects.toThrow(
          /RECURRING_PRICE_UNSUPPORTED/,
        );
        // No bill produced — the transaction rolled back (never zero-substituted).
        expect(await readBill(tieredRun, tieredBan)).toBeUndefined();

        // No AS-OF price → NOT_FOUND. The offering INTENDS a recurring charge (it
        // has a recurring price) but that price is FUTURE-dated (starts after the
        // run period), so no price resolves as-of period_start — a broken/missing
        // as-of price, HARD-failed (distinct from a usage-only offering, below).
        const missingBan = await newAccount("Missing");
        const missingOff = await newOffering("Future-Priced Offering");
        const missingRun = "BRN-BM29-06";
        await newRecurringPrice(missingOff, "20.00", "2026-09-01T00:00:00Z"); // > period
        await newRun(missingRun);
        await newInventory({
          piId: "PRDINV-BM29-N0",
          ban: missingBan,
          offeringId: missingOff,
          quantity: 1,
          orderItemId: "_bm29-oi-N0",
        });
        await expect(aggregate(missingRun, missingBan, 1)).rejects.toThrow(
          /RECURRING_PRICE_NOT_FOUND/,
        );
        expect(await readBill(missingRun, missingBan)).toBeUndefined();
      },
      120_000,
    );

    it(
      "[CRITICAL] a usage-only subscription (offering with NO recurring price and " +
        "no override) does NOT trip D33 — it bills its USAGE and writes no RECURRING " +
        "line (recurring is not mandatory, Inv #22)",
      async () => {
        const ban = await newAccount("UsageOnly");
        const off = await newOffering("Usage-Only Offering"); // no recurring price
        const runId = "BRN-BM29-07";
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM29-U0",
          ban,
          offeringId: off,
          quantity: 1,
          orderItemId: "_bm29-oi-U0",
        });
        // 2 claimed usage records @ 10.00 → a 20.00 USAGE line, no recurring.
        for (let i = 0; i < 2; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM29-U0",
            runId,
            ban,
            attempt: 1,
          });
        }

        // Must NOT throw — a metered-only subscription has no recurring charge.
        await aggregate(runId, ban, 1);

        const bill = await readBill(runId, ban);
        expect(bill).toBeDefined();
        const lines = await readLines(bill!.customerBillId);
        expect(lines).toHaveLength(1);
        expect(lines[0]!.source).toBe("USAGE");
        expect(lines[0]!.netAmount).toBe("20.00");
        expect(bill!.subtotal).toBe("20.00");
      },
      120_000,
    );

    it(
      "a mixed account with a usage-only offering AND a recurring offering bills " +
        "both (a USAGE line for the metered offering, a RECURRING line for the " +
        "priced one) with no D33 failure",
      async () => {
        const ban = await newAccount("MixedUsageOnly");
        const recOff = await newOffering("Priced Offering");
        const useOff = await newOffering("Metered Offering"); // no recurring price
        const runId = "BRN-BM29-08";
        await newRecurringPrice(recOff, "15.00", "2026-01-01T00:00:00Z");
        await newRun(runId);
        await newInventory({
          piId: "PRDINV-BM29-MR",
          ban,
          offeringId: recOff,
          quantity: 1,
          orderItemId: "_bm29-oi-MR",
        });
        await newInventory({
          piId: "PRDINV-BM29-MU",
          ban,
          offeringId: useOff,
          quantity: 1,
          orderItemId: "_bm29-oi-MU",
        });
        for (let i = 0; i < 2; i += 1) {
          await insertClaimedRow({
            subRef: "PRDINV-BM29-MU",
            runId,
            ban,
            attempt: 1,
          });
        }

        await aggregate(runId, ban, 1);

        const bill = await readBill(runId, ban);
        const lines = await readLines(bill!.customerBillId);
        expect(lines).toHaveLength(2);
        const bySource = Object.fromEntries(lines.map((l) => [l.source, l]));
        expect(bySource.USAGE!.offeringId).toBe(useOff);
        expect(bySource.USAGE!.netAmount).toBe("20.00");
        expect(bySource.RECURRING!.offeringId).toBe(recOff);
        expect(bySource.RECURRING!.netAmount).toBe("15.00");
        expect(bill!.subtotal).toBe("35.00");
      },
      120_000,
    );
  },
);
