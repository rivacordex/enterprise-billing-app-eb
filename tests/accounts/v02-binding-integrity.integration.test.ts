import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// ac04-spec §3.4 — V2 binding-integrity test (code-standards §7.1).
// Asserts Module Inv. #9: onboarding a customer creates exactly one
// receivables binding on the BAN, one unapplied_cash binding on the FA, and
// one deposits binding on the FA — all in MYR — and that attempting a second
// onboarding of the same party role is blocked (INVALID_TRANSITION), leaving
// the binding count unchanged.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Binding integrity — V2 (Module Inv. #9, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let cycleId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Migrate on a short-lived connection, then close it and open a fresh one
      // for reads: migrate() poisons the connection's type-OID cache so later
      // timestamptz reads on it return raw strings (module Key Decision —
      // "migrate()-poisons-connection quirk").
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      try {
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
        await migrate(drizzle(migrateSql), {
          migrationsFolder: "./db/migrations",
          migrationsSchema: "drizzle",
        });
      } finally {
        await migrateSql.end();
      }

      sql = postgres(databaseUrl as string, { max: 1 });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v02', 'V02 Test User', 'v02@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      appuserId = user.id;

      // Sys pgledger accounts needed for the V1 zero-sum assertion at the end.
      for (const name of [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.revenue_adj.MYR",
        "sys.write_off.MYR",
        "sys.rounding.MYR",
        "sys.tax_payable.MYR",
      ]) {
        await sql`SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')`;
      }

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('Monthly – Day 1', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("bill_cycle insert returned no row");
      cycleId = cycle.id;
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

    it("V2 — onboarding creates exactly three bindings with correct roles and owner types", async () => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V02 Test Org A', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert failed");

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          statusReason: "V02 — binding integrity",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { financialAccountId, billingAccountId } = result.value;

      const bindings = await sql<
        { owner_type: string; owner_id: string; ledger_role: string }[]
      >`
        SELECT owner_type, owner_id, ledger_role
        FROM billing.ledger_binding
        WHERE
          (owner_type = 'financial_account' AND owner_id = ${financialAccountId})
          OR (owner_type = 'billing_account'  AND owner_id = ${billingAccountId})
        ORDER BY owner_type, ledger_role
      `;

      expect(bindings).toHaveLength(3);

      const tags = bindings.map((b) => `${b.owner_type}:${b.ledger_role}`);
      expect(tags).toContain("billing_account:receivables");
      expect(tags).toContain("financial_account:deposits");
      expect(tags).toContain("financial_account:unapplied_cash");
    });

    it("V2 — all three pgledger accounts are MYR and binding currency = owner currency = ledger currency", async () => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V02 Test Org B', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert failed");

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          statusReason: "V02 — currency invariant",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const { financialAccountId, billingAccountId } = result.value;

      // Each binding's pgledger_account_id resolves to a MYR ledger account.
      // Owner FA and BAN are also MYR. All three columns in every binding row
      // must agree — Module Inv. #9 (currency triple-lock).
      const rows = await sql<
        {
          ledger_role: string;
          ledger_currency: string;
          owner_currency: string;
        }[]
      >`
        SELECT
          lb.ledger_role,
          pav.currency                                    AS ledger_currency,
          CASE lb.owner_type
            WHEN 'financial_account' THEN fa.currency
            WHEN 'billing_account'   THEN ban.currency
          END                                             AS owner_currency
        FROM billing.ledger_binding lb
        JOIN billing.pgledger_accounts_view pav ON pav.id = lb.pgledger_account_id
        LEFT JOIN billing.financial_account fa
               ON fa.financial_account_id = lb.owner_id
              AND lb.owner_type = 'financial_account'
        LEFT JOIN billing.billing_account ban
               ON ban.billing_account_id = lb.owner_id
              AND lb.owner_type = 'billing_account'
        WHERE
          (lb.owner_type = 'financial_account' AND lb.owner_id = ${financialAccountId})
          OR (lb.owner_type = 'billing_account'  AND lb.owner_id = ${billingAccountId})
      `;

      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.ledger_currency, `${row.ledger_role} ledger_currency`).toBe(
          "MYR",
        );
        expect(row.owner_currency, `${row.ledger_role} owner_currency`).toBe(
          "MYR",
        );
      }
    });

    it("V2 — second onboarding of the same party role returns INVALID_TRANSITION and creates no new bindings", async () => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V02 Test Org C', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert failed");

      const first = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          statusReason: "V02 — second-attempt guard (first)",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );

      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // Second attempt: party_role is now VALIDATED — pre-check catches it.
      const second = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          statusReason: "V02 — second-attempt guard (second)",
          lastModifiedDatetime: first.value.lastModifiedDatetime,
        },
        appuserId,
      );

      expect(second).toEqual({ ok: false, code: "INVALID_TRANSITION" });

      // No duplicate bindings — still exactly 3 for this FA/BAN pair.
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.ledger_binding
        WHERE
          (owner_type = 'financial_account' AND owner_id = ${first.value.financialAccountId})
          OR (owner_type = 'billing_account'  AND owner_id = ${first.value.billingAccountId})
      `;
      expect(Number(row?.count)).toBe(3);
    });

    it("V2 — V1 zero-sum: sum of all MYR pgledger balances remains 0 after onboarding", async () => {
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
        WHERE currency = 'MYR'
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });
  },
);
