import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import {
  getLedgerAccount,
  getTransferLegs,
  listTransfersForAccount,
  resolveLedgerAccountLabel,
  searchLedgerAccounts,
  zeroSumByCurrency,
} from "@/services/accounts/ledger-explorer";

// ac06-spec §3.4 — Ledger Explorer guardrail tests: V1 surfaced live in the
// UI (reacts, not hard-green), end-to-end trace (pick → grid → drawer with
// correct signed legs + running balances), and picker/grid mechanics (kind
// chips, event_at + metadata filters, URL sort, server pagination). Fixture
// transfers are created directly via `pgledger_create_transfer` (test code,
// not application code — module inv. #4 only restricts app code, matching
// v03's precedent) since document posting doesn't exist until ac07.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Ledger Explorer — trace, filters, sort, pagination, V1-in-UI (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let financialAccountId: string;
    let billingAccountId: string;
    let receivablesAccountId: string;
    let unappliedCashAccountId: string;
    let sysRevenueAccountId: string;
    let transferChargeA: string; // 100.00, 2026-01-05
    let transferChargeB: string; // 250.00, 2026-03-10
    let transferChargeC: string; // 50.00,  2026-06-20

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Schema drop + `migrate()` run on their own short-lived connection,
      // then closed before opening `sql` fresh. `drizzle-orm`'s migrator
      // running many raw DDL statements over a `postgres.js` connection
      // leaves that connection's built-in type-OID cache poisoned — every
      // later `timestamp(tz)` column reads back as a raw string instead of a
      // parsed `Date` (reproduces independently of this unit's code; a
      // driver/environment quirk, not a app-layer bug). A fresh connection
      // for all actual test queries avoids it.
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(migrateSql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await migrateSql.end();

      sql = postgres(databaseUrl as string, { max: 1 });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-ac06', 'AC06 Test User', 'ac06@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      appuserId = user.id;

      const sysNames = [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.revenue_adj.MYR",
        "sys.write_off.MYR",
        "sys.rounding.MYR",
        "sys.tax_payable.MYR",
      ];
      for (const name of sysNames) {
        const [row] = await sql<{ id: string }[]>`
          SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')
        `;
        if (name === "sys.revenue.MYR") sysRevenueAccountId = row!.id;
      }

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('AC06 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("bill_cycle insert returned no row");

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('AC06 Test Corp', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert returned no row");

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycle.id,
          currency: "MYR",
          statusReason: "ac06 — ledger explorer test",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
      billingAccountId = result.value.billingAccountId;

      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId}
          AND ledger_role = 'receivables'
        LIMIT 1
      `;
      const [ucBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId}
          AND ledger_role = 'unapplied_cash'
        LIMIT 1
      `;
      if (!recBinding || !ucBinding) {
        throw new Error("expected onboarding bindings not found");
      }
      receivablesAccountId = recBinding.pgledger_account_id;
      unappliedCashAccountId = ucBinding.pgledger_account_id;

      // Three sys.revenue → receivables charges, inserted in this order so
      // the running previous/current balances are deterministic: 0→100,
      // 100→350, 350→400. event_at is deliberately NOT insertion order, so
      // the -event_at sort test proves it sorts by event_at, not creation
      // order.
      const [tA] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_transfer(
          ${sysRevenueAccountId}, ${receivablesAccountId}, 100.00::numeric,
          '2026-01-05T00:00:00Z'::timestamptz,
          ${sql.json({ doc: "DBN000001", ban: billingAccountId, type: "charge" })}
        )
      `;
      const [tB] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_transfer(
          ${sysRevenueAccountId}, ${receivablesAccountId}, 250.00::numeric,
          '2026-03-10T00:00:00Z'::timestamptz,
          ${sql.json({ doc: "DBN000002", ban: billingAccountId, type: "charge" })}
        )
      `;
      const [tC] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_transfer(
          ${sysRevenueAccountId}, ${receivablesAccountId}, 50.00::numeric,
          '2026-06-20T00:00:00Z'::timestamptz,
          ${sql.json({ doc: "PAY000001", ban: billingAccountId, type: "capture" })}
        )
      `;
      transferChargeA = tA!.id;
      transferChargeB = tB!.id;
      transferChargeC = tC!.id;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("kind chips: ban.*/fa.*/sys.* resolve to the correct kind + TMF owner label", async () => {
      const receivables = await getLedgerAccount(receivablesAccountId);
      expect(receivables?.label.kind).toBe("ban");
      expect(receivables?.label.ownerId).toBe(billingAccountId);
      expect(receivables?.label.ownerLabel).toBe("Master Billing Account");

      const unapplied = await getLedgerAccount(unappliedCashAccountId);
      expect(unapplied?.label.kind).toBe("fa");
      expect(unapplied?.label.ownerId).toBe(financialAccountId);
      expect(unapplied?.label.ownerLabel).toBe("Financial Account");

      const sysRevenue = await resolveLedgerAccountLabel(
        sysRevenueAccountId,
        "sys.revenue.MYR",
      );
      expect(sysRevenue.kind).toBe("sys");
      expect(sysRevenue.ownerId).toBeNull();
      expect(sysRevenue.ownerLabel).toBeNull();
    });

    it("account picker: searchLedgerAccounts finds accounts by name convention with correct kinds", async () => {
      const banResults = await searchLedgerAccounts(".receivables", 10);
      expect(banResults.some((r) => r.id === receivablesAccountId)).toBe(true);
      expect(
        banResults.find((r) => r.id === receivablesAccountId)?.label.kind,
      ).toBe("ban");

      const sysResults = await searchLedgerAccounts("sys.", 10);
      expect(sysResults.length).toBeGreaterThanOrEqual(6);
      expect(sysResults.every((r) => r.label.kind === "sys")).toBe(true);
    });

    it("trace end-to-end: transfers grid lists the receivables account's transfers, most recent first by default", async () => {
      const page = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: null,
        eventTo: null,
        metadataQuery: "",
        sort: "-event_at",
        page: 1,
        pageSize: 20,
      });
      expect(page.total).toBe(3);
      expect(page.rows.map((r) => r.id)).toEqual([
        transferChargeC,
        transferChargeB,
        transferChargeA,
      ]);
      expect(page.rows[0]?.fromLabel.kind).toBe("sys");
      expect(page.rows[0]?.toLabel.kind).toBe("ban");
      expect(page.rows[0]?.toLabel.ownerLabel).toBe("Master Billing Account");
    });

    it("trace end-to-end: drawer shows both signed legs with correct previous/current balances", async () => {
      const detail = await getTransferLegs(transferChargeC);
      expect(detail).not.toBeNull();
      expect(detail!.legs).toHaveLength(2);

      const receivableLeg = detail!.legs.find(
        (l) => l.accountId === receivablesAccountId,
      );
      expect(receivableLeg?.amount).toBe("50.00");
      expect(receivableLeg?.accountPreviousBalance).toBe("350.00");
      expect(receivableLeg?.accountCurrentBalance).toBe("400.00");
      expect(receivableLeg?.label.kind).toBe("ban");

      const revenueLeg = detail!.legs.find(
        (l) => l.accountId === sysRevenueAccountId,
      );
      expect(revenueLeg?.amount).toBe("-50.00");
      expect(revenueLeg?.label.kind).toBe("sys");

      // The two legs net to zero (double-entry, module inv. #1).
      expect(Number(receivableLeg?.amount) + Number(revenueLeg?.amount)).toBe(
        0,
      );
    });

    it("event_at range filter narrows the grid", async () => {
      const fromMarch = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: new Date("2026-03-01T00:00:00Z"),
        eventTo: null,
        metadataQuery: "",
        sort: "event_at",
        page: 1,
        pageSize: 20,
      });
      expect(fromMarch.total).toBe(2);
      expect(fromMarch.rows.map((r) => r.id)).toEqual([
        transferChargeB,
        transferChargeC,
      ]);

      const afterJune = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: new Date("2026-07-01T00:00:00Z"),
        eventTo: null,
        metadataQuery: "",
        sort: "event_at",
        page: 1,
        pageSize: 20,
      });
      expect(afterJune.total).toBe(0);
    });

    it("metadata search (doc/ban/type) narrows the grid", async () => {
      const dbnOnly = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: null,
        eventTo: null,
        metadataQuery: "DBN",
        sort: "event_at",
        page: 1,
        pageSize: 20,
      });
      expect(dbnOnly.total).toBe(2);
      expect(dbnOnly.rows.every((r) => r.metadataDoc?.startsWith("DBN"))).toBe(
        true,
      );

      const payOnly = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: null,
        eventTo: null,
        metadataQuery: "PAY000001",
        sort: "event_at",
        page: 1,
        pageSize: 20,
      });
      expect(payOnly.total).toBe(1);
      expect(payOnly.rows[0]?.id).toBe(transferChargeC);
    });

    it("sort is a URL param: amount ascending and descending round-trip correctly", async () => {
      const asc = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: null,
        eventTo: null,
        metadataQuery: "",
        sort: "amount",
        page: 1,
        pageSize: 20,
      });
      expect(asc.rows.map((r) => r.id)).toEqual([
        transferChargeC,
        transferChargeA,
        transferChargeB,
      ]);

      const desc = await listTransfersForAccount(receivablesAccountId, {
        eventFrom: null,
        eventTo: null,
        metadataQuery: "",
        sort: "-amount",
        page: 1,
        pageSize: 20,
      });
      expect(desc.rows.map((r) => r.id)).toEqual([
        transferChargeB,
        transferChargeA,
        transferChargeC,
      ]);
    });

    it("server pagination: pageSize=1 walks all three transfers without duplicates", async () => {
      const seen: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const result = await listTransfersForAccount(receivablesAccountId, {
          eventFrom: null,
          eventTo: null,
          metadataQuery: "",
          sort: "-event_at",
          page,
          pageSize: 1,
        });
        expect(result.total).toBe(3);
        expect(result.rows).toHaveLength(1);
        seen.push(result.rows[0]!.id);
      }
      expect(seen).toEqual([transferChargeC, transferChargeB, transferChargeA]);
    });

    it("V1 in the UI: zeroSumByCurrency reads Σ=0 for MYR after the fixture charges", async () => {
      const rows = await zeroSumByCurrency();
      const myr = rows.find((r) => r.currency === "MYR");
      expect(myr).toBeDefined();
      expect(myr!.ok).toBe(true);
      expect(myr!.total).toBe("0.00");
    });

    it("V1 in the UI: a deliberately imbalanced fixture flips the indicator to broken (it reacts, not hard-green)", async () => {
      // Test-only direct write, bypassing pgledger_create_transfer entirely
      // (module inv. #4 restricts application code, not fixtures) — proves
      // zeroSumByCurrency actually recomputes rather than being hard-coded.
      await sql`
        UPDATE billing.pgledger_accounts
        SET balance = balance + 1
        WHERE name = 'sys.rounding.MYR'
      `;

      const rows = await zeroSumByCurrency();
      const myr = rows.find((r) => r.currency === "MYR");
      expect(myr).toBeDefined();
      expect(myr!.ok).toBe(false);
      expect(myr!.total).toBe("1.00");
    });
  },
);
