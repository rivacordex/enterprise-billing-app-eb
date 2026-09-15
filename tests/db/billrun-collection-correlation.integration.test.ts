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

// bm27-spec §Implementation §6 (guardrail 2) — the DB-gated correlation & claim
// regression. This is the app-repo "flow-double" (bm21 pattern): it performs the
// SAME `billrun_runtime` writes the real bill_run_processing flow's Validation +
// Collection stages perform (the `_CURRENCY_SQL`-shaped subscriber→account join,
// then the `RATED → BILL_DRAFT` claim stamping the resolved `billrun_ban_id`),
// so the correlation/claim is provable without a live Kestra. It asserts the
// four spec outcomes on a focused fixture:
//   * a resolvable, in-window, currency-matching account is claimed to
//     BILL_DRAFT with its previously-NULL `billrun_ban_id` filled to the RIGHT
//     account (bm26 left it NULL);
//   * an unresolvable-subscriber row is left RATED, unclaimed and untouched
//     (D32/Inv #25) — as is a resolvable but OUT-OF-SCOPE account's row;
//   * a currency-mismatched account is flagged by Validation (HARD);
//   * a zero-claimable account validates DONE (a zero-charge exception) with no
//     claim.
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
           udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
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

    // The flow-double: correlate ONCE (Inv #24) then claim RATED → BILL_DRAFT,
    // stamping the six columns incl. the resolved billrun_ban_id. Uses the same
    // correlation join + claim shape as the local-dev flow's collection SQL
    // (set-based over the in-scope ban_ids). NOTE: it runs on the superuser
    // DATABASE_URL connection, so it exercises the correlation/claim LOGIC, not
    // the `billrun_status_guard` trigger or the exact checksum expression —
    // those are proven separately by billrun-db-roles.integration.test.ts
    // (the trigger permits exactly RATED → BILL_DRAFT). Returns the claimed ids.
    async function correlateAndClaim(
      runId: string,
      banIds: string[],
      attempt: number,
    ): Promise<string[]> {
      const rows = await sql<{ udr_id: string }[]>`
        WITH correlated AS (
          SELECT ur.udr_id, ur.partition_period, pi.billing_account_id
          FROM   rating.udr_rated ur
          JOIN   inventory.product_inventory pi
                 ON pi.product_inventory_id = ur.udr_subscriber_ref_id
          WHERE  ur.is_live AND ur.status = 'RATED'
            AND  ur.udr_type = 'RAN_USAGE'
            AND  pi.billing_account_id = ANY(${banIds})
        )
        UPDATE rating.udr_rated ur
        SET    status           = 'BILL_DRAFT',
               billrun_ref_id   = ${runId},
               billrun_ban_id   = c.billing_account_id,
               billrun_attempt  = ${attempt},
               billrun_checksum = 'bm27-claim-checksum',
               upsert_datetime  = now()
        FROM   correlated c
        WHERE  ur.udr_id = c.udr_id AND ur.partition_period = c.partition_period
          AND  ur.status = 'RATED'
        RETURNING ur.udr_id
      `;
      return rows.map((r) => r.udr_id);
    }

    // Validation's assertion counts against the SAME correlated set.
    async function validate(banId: string): Promise<{
      claimable: number;
      currency_mismatch: number;
      out_of_window: number;
    }> {
      const [row] = await sql<
        {
          claimable: number;
          currency_mismatch: number;
          out_of_window: number;
        }[]
      >`
        WITH correlated AS (
          SELECT ur.udr_currency, ur.start_datetime,
                 pi.billing_account_id, ba.currency AS account_currency
          FROM   rating.udr_rated ur
          JOIN   inventory.product_inventory pi
                 ON pi.product_inventory_id = ur.udr_subscriber_ref_id
          JOIN   billing.billing_account ba
                 ON ba.billing_account_id = pi.billing_account_id
          WHERE  ur.is_live AND ur.status = 'RATED'
            AND  ur.udr_type = 'RAN_USAGE'
            AND  pi.billing_account_id = ${banId}
        )
        SELECT count(*)::int AS claimable,
               count(*) FILTER (WHERE udr_currency <> account_currency)::int
                 AS currency_mismatch,
               count(*) FILTER (
                 WHERE (start_datetime AT TIME ZONE 'UTC')::date < ${PERIOD_START}::date
                    OR (start_datetime AT TIME ZONE 'UTC')::date > ${PERIOD_END}::date)::int
                 AS out_of_window
        FROM   correlated
      `;
      return row!;
    }

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
        const claimed = await correlateAndClaim(runId, [banA], 3);

        // Only A's two rows were claimed.
        expect(claimed.sort()).toEqual([a1, a2].sort());

        for (const id of [a1, a2]) {
          const after = await ratedRow(id);
          expect(after.status).toBe("BILL_DRAFT");
          expect(after.billrunRefId).toBe(runId);
          expect(after.billrunBanId).toBe(banA); // the resolved account
          expect(after.billrunAttempt).toBe(3);
          expect(after.billrunChecksum).toBe("bm27-claim-checksum");
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

        const v = await validate(banB);
        expect(v.claimable).toBe(1);
        expect(v.currency_mismatch).toBe(1); // ⇒ HARD CURRENCY_MISMATCH
        expect(v.out_of_window).toBe(0);
      },
      120_000,
    );

    it(
      "Validation flags an out-of-window row HARD (start_datetime outside " +
        "[period_start, period_end]) — WINDOW_COVERAGE (bm27-spec §2)",
      async () => {
        const banE = await newAccount("Window", "MYR");
        const piE = "PRDINV-BM27-E";
        await newInventory(piE, banE);
        await insertRatedRow({
          subRef: piE,
          currency: "MYR",
          start: OUT_OF_WINDOW,
        });

        const v = await validate(banE);
        expect(v.claimable).toBe(1);
        expect(v.currency_mismatch).toBe(0);
        expect(v.out_of_window).toBe(1); // ⇒ HARD WINDOW_COVERAGE
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

        const v = await validate(banC);
        expect(v.claimable).toBe(0); // ⇒ validation DONE, zero-charge
        expect(v.currency_mismatch).toBe(0);
        expect(v.out_of_window).toBe(0);

        const claimed = await correlateAndClaim("BRN-BM27-ZC", [banC], 1);
        expect(claimed).toEqual([]);
      },
      120_000,
    );
  },
);
