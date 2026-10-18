import { createHash } from "node:crypto";

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
import { udrRated } from "@/db/schema/rating/udr-rated";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  runCollection,
  runValidation,
} from "@/tests/db/helpers/extract-flow-sql";

// bm27-spec §Implementation §6 (guardrail 2) — the DB-gated correlation & claim
// regression. It runs the deployed bill_run_processing flow's OWN Validation
// and Collection heredocs (extract-flow-sql `runValidation` / `runCollection`),
// so the correlation, the window scope and the claim cannot drift from the
// flow, and are provable without a live Kestra. It asserts the spec outcomes
// on a focused fixture:
//   * a resolvable, in-window, currency-matching account is claimed to
//     BILL_DRAFT with its previously-NULL `billrun_ban_id` filled to the RIGHT
//     account (bm26 left it NULL);
//   * an unresolvable-subscriber row is left RATED, unclaimed and untouched
//     (D32/Inv #25) — as is a resolvable but OUT-OF-SCOPE account's row;
//   * a currency-mismatched account is flagged by Validation (HARD);
//   * a row outside the period (dated in the business zone) is left RATED and
//     does not fail the account (bm73 review, 2026-10-18: WINDOW_COVERAGE
//     retired);
//   * a zero-claimable account validates DONE (a zero-charge exception) with no
//     claim.
// It runs on the superuser DATABASE_URL connection, so the
// `billrun_status_guard` trigger and grants are proven separately by
// billrun-db-roles.integration.test.ts.
//
// billrun_ref_id/billrun_ban_id are plain-text keys (no cross-schema FK, Inv #2),
// so the claim needs no `bill_run` row — the correlation target is the set of
// in-scope `billing_account_id`s. Each account is provisioned in isolation.
const databaseUrl = process.env.DATABASE_URL;

// The run window: June 2026 (in-arrears). In-window usage starts mid-June;
// out-of-window usage starts in May (before period_start).
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
const OUT_OF_WINDOW = "2026-05-10T00:00:00.000Z";
// The flow's `business_timezone` input (the app's APP_TIMEZONE). Validation
// dates usage in this zone so it agrees with rating.period_of() (rating X1).
const BUSINESS_TZ = "Asia/Kuala_Lumpur";
// 00:30 on 1 June in Kuala Lumpur (+08) is still 31 May in UTC — the boundary
// the first live run tripped (bm73 manual run, 2026-10-18).
const FIRST_OF_MONTH_EARLY_LOCAL = "2026-05-31T16:30:00.000Z";
// 00:30 on 1 July in Kuala Lumpur — 30 June in UTC, but outside a June window.
const FIRST_OF_NEXT_MONTH_EARLY_LOCAL = "2026-06-30T16:30:00.000Z";

describe.skipIf(!databaseUrl)(
  "bm27 collection correlation & claim (requires DATABASE_URL)",
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

    // A fresh org/party/FA/BAN chain, one active billing account in the given
    // currency on the shared cycle. Returns the account id.
    async function newAccount(
      label: string,
      currency: string,
    ): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM27-${label}-Customer`,
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
          name: `BM27-${label}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM27-${label}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency,
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    // A product_inventory row linking a chosen product_inventory_id → account.
    // Only billing_account_id needs to be real (the correlation joins on it);
    // the ordering/product/party FKs are irrelevant to the correlation, so the
    // insert runs with FK triggers off (session_replication_role = replica,
    // SET LOCAL inside one transaction so it stays on a single pinned
    // connection) and fabricates them — the same fixture technique the e2e
    // suite uses to bypass immutability triggers.
    async function newInventory(piId: string, ban: string): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO inventory.product_inventory
            (product_inventory_id, product_order_item_id, customer_party_role_id,
             billing_account_id, product_offering_id, quantity, status, start_date)
          VALUES
            (${piId}, ${`_bm27-poi-${piId}`}, ${`_bm27-party-${piId}`},
             ${ban}, ${`_bm27-off-${piId}`}, 1, 'ACTIVE', '2026-01-01')
        `;
      });
    }

    // One UNCLAIMED RAN_USAGE rated row (status RATED, all four claim columns
    // NULL — the shape bm26's seed and rl.py both leave). `udr_key` varies by a
    // global sequence so the live-row UNIQUE never collides. Returns the udr_id.
    async function insertRatedRow(args: {
      subRef: string;
      currency: string;
      start: string;
    }): Promise<string> {
      seq += 1;
      const [row] = await sql<{ udr_id: string }[]>`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw,
           udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
           rating_engine_version, rating_flow_revision)
        VALUES
          (rating.period_of(${args.start}::timestamptz), 'RAN_USAGE',
           ${args.start}::timestamptz, ${args.start}::timestamptz, 'RATED',
           ${args.subRef}, ${`_bm27-key-${seq}`}, '1.000000', 'EA', 'FLAT',
           '10.00', '10.00', 'HALF_UP', ${args.currency}, '_BM27_BATCH',
           '_BM27', '_BM27', 0)
        RETURNING udr_id
      `;
      return row!.udr_id;
    }

    // The flow's OWN Collection claim for one account, then the ids it
    // claimed for this run.
    async function collect(
      runId: string,
      banId: string,
      attempt: number,
    ): Promise<string[]> {
      await runCollection(sql, {
        runId,
        ban: banId,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        businessTimezone: BUSINESS_TZ,
      });
      const rows = await sql<{ udr_id: string }[]>`
        SELECT udr_id FROM rating.udr_rated
        WHERE  billrun_ref_id = ${runId} AND billrun_ban_id = ${banId}
      `;
      return rows.map((r) => r.udr_id);
    }

    // The flow's OWN Validation heredoc (extract-flow-sql), bound to this
    // test's account, the June window and the business time zone.
    const validate = (banId: string) =>
      runValidation(sql, {
        ban: banId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        businessTimezone: BUSINESS_TZ,
      });

    async function ratedRow(udrId: string) {
      const [row] = await db
        .select({
          status: udrRated.status,
          billrunRefId: udrRated.billrunRefId,
          billrunBanId: udrRated.billrunBanId,
          billrunAttempt: udrRated.billrunAttempt,
          billrunChecksum: udrRated.billrunChecksum,
        })
        .from(udrRated)
        .where(eq(udrRated.udrId, udrId));
      return row!;
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

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM27-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM27 Fixture Cycle", lastEditedBy: null })
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
      "claims a resolvable account's previously-NULL rows to BILL_DRAFT, " +
        "stamping the RESOLVED billrun_ban_id; leaves an orphan and an " +
        "out-of-scope account's rows RATED and untouched (bm27-spec §1/§3, D32)",
      async () => {
        const banA = await newAccount("Resolvable", "MYR");
        const banD = await newAccount("OutOfScope", "MYR");
        const piA = "PRDINV-BM27-A";
        const piD = "PRDINV-BM27-D";
        await newInventory(piA, banA);
        await newInventory(piD, banD);

        // Account A: two resolvable, in-window, currency-matching usage rows.
        const a1 = await insertRatedRow({
          subRef: piA,
          currency: "MYR",
          start: IN_WINDOW,
        });
        const a2 = await insertRatedRow({
          subRef: piA,
          currency: "MYR",
          start: IN_WINDOW,
        });
        // An orphan: its subscriber ref resolves to NO product_inventory row.
        const orphan = await insertRatedRow({
          subRef: "PRDINV-BM27-ORPHAN",
          currency: "MYR",
          start: IN_WINDOW,
        });
        // Account D resolves, but is OUT OF SCOPE (not in the run's ban_ids).
        const d1 = await insertRatedRow({
          subRef: piD,
          currency: "MYR",
          start: IN_WINDOW,
        });

        // All four rows start RATED with NULL claim columns.
        for (const id of [a1, a2, orphan, d1]) {
          const before = await ratedRow(id);
          expect(before.status).toBe("RATED");
          expect(before.billrunBanId).toBeNull();
        }

        const runId = "BRN-BM27-01";
        const claimed = await collect(runId, banA, 3);

        // Only A's two rows were claimed.
        expect(claimed.sort()).toEqual([a1, a2].sort());

        for (const id of [a1, a2]) {
          const after = await ratedRow(id);
          expect(after.status).toBe("BILL_DRAFT");
          expect(after.billrunRefId).toBe(runId);
          expect(after.billrunBanId).toBe(banA); // the resolved account
          expect(after.billrunAttempt).toBe(3);
          expect(after.billrunChecksum).toBe(
            createHash("md5").update(`${id}|${runId}`).digest("hex"),
          );
        }

        // The orphan and the out-of-scope account are left RATED, unclaimed and
        // untouched (D32/Inv #25) — never filtered out, never claimed.
        for (const id of [orphan, d1]) {
          const after = await ratedRow(id);
          expect(after.status).toBe("RATED");
          expect(after.billrunRefId).toBeNull();
          expect(after.billrunBanId).toBeNull();
          expect(after.billrunAttempt).toBeNull();
        }
      },
      120_000,
    );

    it(
      "Validation flags a currency-mismatched account HARD (udr_currency <> " +
        "account_currency), the _CURRENCY_SQL check (bm27-spec §2)",
      async () => {
        const banB = await newAccount("Mismatch", "MYR");
        const piB = "PRDINV-BM27-B";
        await newInventory(piB, banB);
        // A resolvable, in-window row — but rated in USD against a MYR account.
        await insertRatedRow({
          subRef: piB,
          currency: "USD",
          start: IN_WINDOW,
        });

        await expect(validate(banB)).rejects.toThrow(
          /CURRENCY_MISMATCH \(HARD\): 1 correlated row/,
        );
      },
      120_000,
    );

    it(
      "a row outside [period_start, period_end] is left RATED and does not " +
        "fail the account; a currency mismatch on it is not checked (bm73 " +
        "review: Validation and Collection are scoped to the period)",
      async () => {
        const banE = await newAccount("Window", "MYR");
        const piE = "PRDINV-BM27-E";
        await newInventory(piE, banE);
        const inWindow = await insertRatedRow({
          subRef: piE,
          currency: "MYR",
          start: IN_WINDOW,
        });
        // Last month's leftover, rated in a foreign currency: neither counts.
        const leftover = await insertRatedRow({
          subRef: piE,
          currency: "USD",
          start: OUT_OF_WINDOW,
        });

        await expect(validate(banE)).resolves.toBeUndefined();
        expect(await collect("BRN-BM27-E", banE, 1)).toEqual([inWindow]);

        const after = await ratedRow(leftover);
        expect(after.status).toBe("RATED");
        expect(after.billrunRefId).toBeNull();
      },
      120_000,
    );

    it(
      "the period is dated in the business time zone: 00:30 +08 on the 1st " +
        "is claimed, 00:30 +08 on the next month's 1st is left RATED (rating X1)",
      async () => {
        const banK = await newAccount("BusinessTz", "MYR");
        const piK = "PRDINV-BM27-K";
        await newInventory(piK, banK);
        // UTC dating would put this row in May, outside the June window.
        const firstOfMonth = await insertRatedRow({
          subRef: piK,
          currency: "MYR",
          start: FIRST_OF_MONTH_EARLY_LOCAL,
        });
        // UTC dating would put this row on 30 June, inside the window.
        const firstOfNextMonth = await insertRatedRow({
          subRef: piK,
          currency: "MYR",
          start: FIRST_OF_NEXT_MONTH_EARLY_LOCAL,
        });

        await expect(validate(banK)).resolves.toBeUndefined();
        expect(await collect("BRN-BM27-K", banK, 1)).toEqual([firstOfMonth]);
        expect((await ratedRow(firstOfNextMonth)).status).toBe("RATED");
      },
      120_000,
    );

    it(
      "a zero-claimable account validates DONE (zero-charge, not an error) and " +
        "the claim touches nothing (bm27-spec §2 zero-claimable)",
      async () => {
        const banC = await newAccount("ZeroClaimable", "MYR");
        const piC = "PRDINV-BM27-C";
        await newInventory(piC, banC); // has inventory but NO rated usage

        // Zero claimable ⇒ validation DONE, zero-charge.
        await expect(validate(banC)).resolves.toBeUndefined();

        const claimed = await collect("BRN-BM27-ZC", banC, 1);
        expect(claimed).toEqual([]);
      },
      120_000,
    );
  },
);
