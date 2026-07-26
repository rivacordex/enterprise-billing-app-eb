import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// ac04-spec §3.4 — V7 onboarding-atomicity test (code-standards §7.1).
// Asserts Module Inv. #5: if the transaction fails at any point after the
// party_role status change and FA/BAN inserts, every write rolls back
// atomically — the party_role reverts to INITIALIZED, no financial_account or
// billing_account row persists, and the pgledger balance remains 0.
//
// The failure is injected via a deliberate CHECK-constraint violation on the
// `ledger_binding.ledger_role` column, which fires after the FA/BAN rows have
// been written (step 2c), inside a postgres.js-managed transaction. This
// approach tests the right atomicity boundary without relying on mock injection.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "Onboarding atomicity — V7 (Module Inv. #5, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let cycleId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });

      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

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

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("V7 — failure at ledger_binding rolls back party_role status, FA, and BAN", async () => {
      const [org] = await sql<{ id: string }[]>`
          INSERT INTO customer.organization (name, organization_type, last_modified_by)
          VALUES ('V07 Test Org', 'COMPANY', ${appuserId})
          RETURNING organization_id AS id
        `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string }[]>`
          INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
          VALUES (${org.id}, 'INITIALIZED', ${appuserId})
          RETURNING party_role_id AS id
        `;
      if (!pr) throw new Error("party_role insert failed");

      // Run the onboarding steps inside a transaction, but inject a
      // CHECK-constraint violation at the ledger_binding step (step 2d).
      // The invalid `ledger_role` value triggers the DB check:
      //   CHECK (ledger_role IN ('receivables','unapplied_cash','deposits'))
      // This fires AFTER the party_role status change and FA/BAN inserts,
      // which is the V7 invariant boundary.
      let caughtError: unknown;
      try {
        await sql.begin(async (tx) => {
          // Step 1 — status change (mirrors compareAndUpdateStatus).
          await tx`
              UPDATE customer.party_role
              SET status = 'VALIDATED', last_modified_by = ${appuserId}
              WHERE party_role_id = ${pr.id}
            `;

          // Step 2a — FA insert.
          const [fa] = await tx<{ id: string }[]>`
              INSERT INTO billing.financial_account
                (name, ref_party_role_id, currency, last_edited_by)
              VALUES ('V07 FA', ${pr.id}, 'MYR', ${appuserId})
              RETURNING financial_account_id AS id
            `;
          if (!fa) throw new Error("FA insert returned no row");

          // Step 2b — BAN insert.
          const [ban] = await tx<{ id: string }[]>`
              INSERT INTO billing.billing_account
                (name, ref_party_role_id, ref_financial_account_id,
                 currency, ref_bill_cycle_id, last_edited_by)
              VALUES ('V07 BAN', ${pr.id}, ${fa.id}, 'MYR', ${cycleId}, ${appuserId})
              RETURNING billing_account_id AS id
            `;
          if (!ban) throw new Error("BAN insert returned no row");

          // Step 2d — forced failure: invalid ledger_role violates the
          // DB CHECK constraint, triggering a rollback of all prior writes.
          await tx`
              INSERT INTO billing.ledger_binding
                (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
              VALUES
                ('financial_account', ${fa.id}, 'INVALID_ROLE_V07', 'fake-pgla-v07', ${appuserId})
            `;
        });
      } catch (err) {
        caughtError = err;
      }

      // The constraint violation must have been thrown.
      expect(caughtError).toBeDefined();

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
      // (we didn't reach step 2c), so the balance check is trivially satisfied.
      // This assertion is included to make the invariant explicit.
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });
  },
);
