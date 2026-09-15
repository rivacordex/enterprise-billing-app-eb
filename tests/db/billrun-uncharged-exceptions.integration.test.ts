import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { listUncharged as ListUncharged } from "@/services/billing/read/list-uncharged";
import type { listExceptions as ListExceptions } from "@/services/billing/read/list-exceptions";
import type { ratedLinesRepository as RatedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";

// bm32-spec §Guardrails / Verification checklist (guardrails #29/#32). The
// DB-gated regression for the redefined Uncharged read + the per-record
// exception surface. It writes real billing fixtures (a run, per-account status
// rows, customer_bill headers + customer_bill_line rows) and fabricated rating
// rows (the bm27 fixture technique — session_replication_role = replica to
// bypass the cross-schema FK chain), then calls the REAL read services:
//   * `listUncharged` — a billed account is ABSENT (Inv #22); a no-line account
//     and a lines-net-to-zero account are PRESENT (NO_CHARGE_LINES /
//     NETS_TO_ZERO); an EXCLUDED account is ABSENT (Inv #26).
//   * `listExceptions` — a BILL_NOTUSED row and both a resolvable and an
//     unresolvable orphan appear (Inv #25/D32); the resolvable orphan shows its
//     account, the unresolvable one a NULL account; a claimed row and a
//     non-RAN_USAGE row do NOT. Crucially it exercises a `cycle_day != 1` OFFSET
//     window that straddles TWO UTC-month partitions: in-window rows in BOTH
//     buckets appear, and out-of-window rows in a scoped bucket do NOT (the
//     bm32-review window-scoping fix — Inv #25 "never filter silently").
//   * `countOrphansForWindow` — counts exactly the orphans (never blocks).
//
// Services are dynamic-imported inside beforeAll (after the DATABASE_URL skip
// guard) — the established integration-suite pattern — so this file never loads
// @/db/client at module top where the integration config leaves DATABASE_URL
// unset.
const databaseUrl = process.env.DATABASE_URL;

// Test 1 (Uncharged): a calendar-month (cycle_day 1) run.
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const SCHEDULED = "2026-07-01";
const PARTITION = "2026-06-01";

// Test 2 (Exceptions): a cycle_day-15 OFFSET run window straddling two UTC
// months. period_of(start_datetime) buckets IN_JUN→2026-06-01, IN_JUL→2026-07-01.
const OFF_PERIOD_START = "2026-06-15";
const OFF_PERIOD_END = "2026-07-14";
const OFF_SCHEDULED = "2026-07-15";
const IN_JUN = "2026-06-20T00:00:00.000Z"; // in-window, June bucket
const IN_JUL = "2026-07-05T00:00:00.000Z"; // in-window, July bucket
const OUT_JUN = "2026-06-05T00:00:00.000Z"; // BEFORE periodStart, June bucket
const OUT_JUL = "2026-07-20T00:00:00.000Z"; // AFTER periodEnd, July bucket

describe.skipIf(!databaseUrl)(
  "bm32 uncharged redefinition + exception surface (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;
    let seq = 0;
    let listUncharged: typeof ListUncharged;
    let listExceptions: typeof ListExceptions;
    let ratedLinesRepository: typeof RatedLinesRepository;

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

    // A fresh org/party/FA/BAN chain, one active billing account. Returns the
    // account id + its name (the exception surface renders the name).
    async function newAccount(
      label: string,
    ): Promise<{ ban: string; name: string }> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM32-${label}-Customer`,
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
          name: `BM32-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: "MYR",
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const name = `BM32-${label}-BAN`;
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "MYR",
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return { ban: ban!.billingAccountId, name };
    }

    async function newRun(
      periodStart: string,
      periodEnd: string,
      scheduled: string,
    ): Promise<string> {
      const [run] = await db
        .insert(billRun)
        .values({
          refBillCycleId: cycleId,
          periodStart,
          periodEnd,
          scheduledRunDate: scheduled,
          status: "PROCESSED",
          runType: "onCycle",
        })
        .returning({ billRunId: billRun.billRunId });
      return run!.billRunId;
    }

    async function scopeAccount(
      runId: string,
      ban: string,
      status: string,
    ): Promise<void> {
      await db.insert(billRunAccount).values({
        refBillRunId: runId,
        refBillingAccountId: ban,
        periodPartition: PARTITION,
        status,
      });
    }

    // A trial customer_bill header for the account. Returns its id.
    async function newBill(runId: string, ban: string): Promise<string> {
      const [bill] = await db
        .insert(customerBill)
        .values({
          refBillRunId: runId,
          refBillingAccountId: ban,
          periodPartition: PARTITION,
          category: "trial",
          billingPeriodStart: PERIOD_START,
          billingPeriodEnd: PERIOD_END,
          subtotal: "0.00",
          taxTotal: "0.00",
          totalAmount: "0.00",
          paymentDueDate: SCHEDULED,
        })
        .returning({ customerBillId: customerBill.customerBillId });
      return bill!.customerBillId;
    }

    async function addLine(
      billId: string,
      lineNo: number,
      net: string,
    ): Promise<void> {
      await db.insert(customerBillLine).values({
        refCustomerBillId: billId,
        periodPartition: PARTITION,
        lineNo,
        source: "USAGE",
        refProductOfferingId: `_bm32-off-${lineNo}`,
        udrType: "RAN_USAGE",
        grossAmount: net,
        netAmount: net,
        groupingKey: `_bm32-off-${lineNo}:RAN_USAGE`,
        currency: "MYR",
      });
    }

    // Fabricate product_inventory linking a subscriber ref → account, bypassing
    // the ordering/product FK chain (only billing_account_id must be real).
    async function newInventory(piId: string, ban: string): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO inventory.product_inventory
            (product_inventory_id, product_order_item_id, customer_party_role_id,
             billing_account_id, product_offering_id, quantity, status, start_date)
          VALUES
            (${piId}, ${`_bm32-poi-${piId}`}, ${`_bm32-party-${piId}`},
             ${ban}, ${`_bm32-off-${piId}`}, 1, 'ACTIVE', '2026-01-01')
        `;
      });
    }

    // One rating.udr_rated row with a chosen status / claim / subscriber ref /
    // start timestamp (partition_period is derived from it by rating.period_of).
    async function insertRatedRow(args: {
      subRef: string;
      status: string;
      ban: string | null;
      start: string;
      udrType?: string;
    }): Promise<void> {
      seq += 1;
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO rating.udr_rated
            (partition_period, udr_type, start_datetime, end_datetime, status,
             udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
             udr_rate_type, udr_rated_price, udr_rated_price_raw,
             udr_rounding_mode, udr_currency, billrun_ban_id, udr_ref_batch_id,
             udr_source_file, rating_engine_version, rating_flow_revision)
          VALUES
            (rating.period_of(${args.start}::timestamptz), ${args.udrType ?? "RAN_USAGE"},
             ${args.start}::timestamptz, ${args.start}::timestamptz, ${args.status},
             ${args.subRef}, ${`_bm32-key-${seq}`}, '2.000000', 'GB', 'FLAT',
             '7.50', '7.50', 'HALF_UP', 'MYR', ${args.ban}, '_BM32_BATCH',
             '_BM32', '_BM32', 0)
        `;
      });
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

      // Dynamic-import the app read path AFTER the skip guard, so @/db/client is
      // never evaluated at module load when DATABASE_URL is unset.
      ({ listUncharged } =
        await import("@/services/billing/read/list-uncharged"));
      ({ listExceptions } =
        await import("@/services/billing/read/list-exceptions"));
      ({ ratedLinesRepository } =
        await import("@/db/repositories/billing/rated-lines.repository"));

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM32-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM32 Fixture Cycle", lastEditedBy: null })
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
      "Uncharged: a billed account is absent; a no-line and a nets-to-zero " +
        "account are present; an EXCLUDED account is on neither (Inv #22/#26)",
      async () => {
        const runId = await newRun(PERIOD_START, PERIOD_END, SCHEDULED);
        const billed = await newAccount("Billed");
        const noLine = await newAccount("NoLine");
        const netsZero = await newAccount("NetsZero");
        const noBill = await newAccount("NoBill");
        const excluded = await newAccount("Excluded");

        await scopeAccount(runId, billed.ban, "PROCESSED");
        await scopeAccount(runId, noLine.ban, "PROCESSED");
        await scopeAccount(runId, netsZero.ban, "PROCESSED");
        await scopeAccount(runId, noBill.ban, "PROCESSED");
        await scopeAccount(runId, excluded.ban, "EXCLUDED");

        // Billed: a real charge line (net 10.00) → BILLED, not uncharged.
        const billedBill = await newBill(runId, billed.ban);
        await addLine(billedBill, 1, "10.00");
        // NoLine: a header with no lines → uncharged (NO_CHARGE_LINES).
        await newBill(runId, noLine.ban);
        // NetsZero: two lines summing to 0 → uncharged (NETS_TO_ZERO).
        const netsBill = await newBill(runId, netsZero.ban);
        await addLine(netsBill, 1, "5.00");
        await addLine(netsBill, 2, "-5.00");
        // NoBill: no customer_bill at all → uncharged (NO_CHARGE_LINES).
        // Excluded: no bill; must never surface.

        const rows = await listUncharged(runId);
        const byBan = new Map(rows.map((r) => [r.billingAccountId, r]));

        expect(byBan.has(billed.ban)).toBe(false);
        expect(byBan.has(excluded.ban)).toBe(false);
        expect(byBan.get(noLine.ban)?.reason).toBe("NO_CHARGE_LINES");
        expect(byBan.get(noBill.ban)?.reason).toBe("NO_CHARGE_LINES");
        expect(byBan.get(netsZero.ban)?.reason).toBe("NETS_TO_ZERO");
        // Exactly the three uncharged accounts, nothing else.
        expect(rows).toHaveLength(3);
      },
    );

    it(
      "Exceptions (OFFSET window): BILL_NOTUSED + resolvable + unresolvable " +
        "orphans across BOTH month buckets appear; out-of-window rows in a " +
        "scoped bucket, a claimed row, and a non-RAN_USAGE row do not " +
        "(Inv #25/D32, bm32-review window-scoping fix)",
      async () => {
        // A cycle_day-15 run: 2026-06-15 → 2026-07-14, spanning June + July.
        const runId = await newRun(
          OFF_PERIOD_START,
          OFF_PERIOD_END,
          OFF_SCHEDULED,
        );
        const resolvable = await newAccount("OffResolvable");
        await newInventory("PRDINV-BM32-OFF-RES", resolvable.ban);

        // BILL_NOTUSED, in-window, JULY bucket (proves the 2nd partition is read).
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "BILL_NOTUSED",
          ban: null,
          start: IN_JUL,
        });
        // Resolvable orphan, in-window, JUNE bucket.
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "RATED",
          ban: null,
          start: IN_JUN,
        });
        // Unresolvable orphan, in-window, JULY bucket (no product_inventory).
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-UNRESOLVABLE",
          status: "RATED",
          ban: null,
          start: IN_JUL,
        });
        // Out-of-window orphan in a SCOPED bucket (June, BEFORE periodStart) —
        // proves the start_datetime window filter, not just partition pruning.
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "RATED",
          ban: null,
          start: OUT_JUN,
        });
        // Out-of-window orphan (July, AFTER periodEnd).
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "RATED",
          ban: null,
          start: OUT_JUL,
        });
        // A claimed row (BILL_DRAFT, ban set) — NOT an exception, NOT an orphan.
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "BILL_DRAFT",
          ban: resolvable.ban,
          start: IN_JUL,
        });
        // A non-RAN_USAGE unclaimed RATED row — NOT an orphan (udr_type filter).
        await insertRatedRow({
          subRef: "PRDINV-BM32-OFF-RES",
          status: "RATED",
          ban: null,
          start: IN_JUL,
          udrType: "OTHER_USAGE",
        });

        const exceptions = await listExceptions(runId);
        const billNotused = exceptions.filter((e) => e.kind === "BILL_NOTUSED");
        const orphans = exceptions.filter((e) => e.kind === "ORPHAN");

        // 1 BILL_NOTUSED (in-window July) + 2 orphans (in-window June + July);
        // the two out-of-window rows, the claimed row and the non-RAN_USAGE row
        // are excluded → exactly 3 records.
        expect(exceptions).toHaveLength(3);
        expect(billNotused).toHaveLength(1);
        expect(billNotused[0]?.accountName).toBe(resolvable.name);

        expect(orphans).toHaveLength(2);
        const resOrphan = orphans.find(
          (o) => o.subscriberRef === "PRDINV-BM32-OFF-RES",
        );
        const unresOrphan = orphans.find(
          (o) => o.subscriberRef === "PRDINV-BM32-OFF-UNRESOLVABLE",
        );
        expect(resOrphan?.accountName).toBe(resolvable.name);
        expect(unresOrphan?.accountName).toBeNull();

        // The informational orphan count equals the ORPHAN rows the surface
        // lists — over the SAME window (both buckets, both in-window dates).
        const count = await ratedLinesRepository.countOrphansForWindow(db, {
          partitions: ["2026-06-01", "2026-07-01"],
          periodStart: OFF_PERIOD_START,
          periodEnd: OFF_PERIOD_END,
        });
        expect(count).toBe(2);
      },
    );
  },
);
