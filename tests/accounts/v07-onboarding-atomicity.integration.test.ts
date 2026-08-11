import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// ac04-spec §3.4 — V7 onboarding-atomicity test (code-standards §7.1).
// Asserts Module Inv. #5: if the transaction fails at any point after the
// party_role status change and FA/BAN inserts, every write rolls back
// atomically — the party_role reverts to INITIALIZED, no financial_account or
// billing_account row persists, and the pgledger balance remains 0.
//
// The failure is injected by spying on ledgerRepository.createAccount to throw
// after the FA/BAN inserts have been written (step 2c), exercising the
// production db.transaction path owned by onboardCustomerAccounts.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Onboarding atomicity — V7 (Module Inv. #5, requires DATABASE_URL)",
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
        VALUES ('test-user-v07', 'V07 Test User', 'v07@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      appuserId = user.id;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('Monthly – Day 1', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("bill_cycle insert returned no row");
      cycleId = cycle.id;
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

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

    it("V7 — failure at ledger creation rolls back party_role status, FA, and BAN", async () => {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V07 Test Org', 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert failed");

      // Inject failure at step 2c: ledgerRepository.createAccount throws on its
      // first call (after FA/BAN inserts have been written inside the service's
      // own db.transaction), triggering a rollback of all prior writes.
      vi.spyOn(ledgerRepository, "createAccount").mockRejectedValueOnce(
        new Error("V07 injected ledger failure"),
      );

      await expect(
        onboardCustomerAccounts(
          {
            partyRoleId: pr.id,
            billCycleId: cycleId,
            currency: "MYR",
            statusReason: "V07 atomicity test",
            lastModifiedDatetime: pr.ts,
          },
          appuserId,
        ),
      ).rejects.toThrow("V07 injected ledger failure");

      // V7 headline: the transaction rolled back all prior writes.

      // party_role is still INITIALIZED.
      const [status] = await sql<{ status: string }[]>`
        SELECT status FROM customer.party_role WHERE party_role_id = ${pr.id}
      `;
      expect(status?.status).toBe("INITIALIZED");

      // No financial_account row.
      const [faCheck] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.financial_account
        WHERE ref_party_role_id = ${pr.id}
      `;
      expect(Number(faCheck?.count)).toBe(0);

      // No billing_account row.
      const [banCheck] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.billing_account
        WHERE ref_party_role_id = ${pr.id}
      `;
      expect(Number(banCheck?.count)).toBe(0);

      // No ledger_binding rows.
      const [bindingCheck] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.ledger_binding
      `;
      expect(Number(bindingCheck?.count)).toBe(0);
    });

    it("V7 — V1 zero-sum holds after a rolled-back onboarding attempt", async () => {
      // pgledger_create_account was never called in the failed attempt above
      // (the spy threw before any ledger account was committed), so the balance
      // check is trivially satisfied. This assertion makes the invariant explicit.
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });
  },
);
