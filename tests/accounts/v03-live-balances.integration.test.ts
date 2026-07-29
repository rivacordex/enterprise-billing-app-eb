import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";

// ac05-spec §3.6 — V3 (read half): service balances equal pgledger_accounts_view.
// Uses pgledger_create_transfer directly to create a non-zero A/R balance without
// document posting (ac07), then asserts that getFinancialAccountDetail and
// getBillingAccountDetail read back exactly the same values as the view.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V3 — live balances match pgledger_accounts_view (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let cycleId: string;
    let sysRevenueAccountId: string;
    let financialAccountId: string;
    let billingAccountId: string;

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
        VALUES ('test-user-v03', 'V03 Test User', 'v03@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("appuser insert returned no row");
      appuserId = user.id;

      // Seed sys accounts required for valid double-entry (V1 invariant).
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
        VALUES ('V03 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      if (!cycle) throw new Error("bill_cycle insert returned no row");
      cycleId = cycle.id;

      // Onboard a customer to get FA + BAN + bindings.
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V03 Test Corp', 'COMPANY', ${appuserId})
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
          billCycleId: cycleId,
          currency: "MYR",
          statusReason: "V03 — live balance test",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );
      if (!result.ok) throw new Error(`onboarding failed: ${result.code}`);
      financialAccountId = result.value.financialAccountId;
      billingAccountId = result.value.billingAccountId;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("V3 — FA receivable sum is 0.00 before any transfers", async () => {
      const detail = await getFinancialAccountDetail(financialAccountId);
      expect(detail).not.toBeNull();
      expect(detail!.receivableBalance).toBe("0.00");
    });

    it("V3 — BAN A/R is 0.00 before any transfers", async () => {
      const detail = await getBillingAccountDetail(billingAccountId);
      expect(detail).not.toBeNull();
      expect(detail!.receivableBalance).toBe("0.00");
    });

    it("V3 — after a simulated charge, service balances equal pgledger_accounts_view", async () => {
      // Find the receivables account for the BAN.
      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id
        FROM billing.ledger_binding
        WHERE owner_type = 'billing_account'
          AND owner_id = ${billingAccountId}
          AND ledger_role = 'receivables'
        LIMIT 1
      `;
      if (!recBinding) throw new Error("receivables binding not found");

      // Simulate a DBN charge: debit the BAN's receivables, credit sys.revenue.
      // pgledger_create_transfer(from_account_id, to_account_id, amount, event_at, metadata)
      // From = revenue (credit account reduces), To = receivables (debit account increases).
      await sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${sysRevenueAccountId},
          ${recBinding.pgledger_account_id},
          500.00::numeric,
          NOW(),
          '{"doc": "v03-test-charge"}'::jsonb
        )
      `;

      // Assert the service reads back the same value as the raw view.
      const [viewRow] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance
        FROM billing.pgledger_accounts_view
        WHERE id = ${recBinding.pgledger_account_id}
        LIMIT 1
      `;
      const expectedBalance = viewRow!.balance;

      const banDetail = await getBillingAccountDetail(billingAccountId);
      expect(banDetail).not.toBeNull();
      expect(banDetail!.receivableBalance).toBe(expectedBalance);

      // FA receivable sum = Σ across all BANs → must equal the one BAN's balance.
      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail).not.toBeNull();
      expect(faDetail!.receivableBalance).toBe(expectedBalance);
    });

    it("V3 — unapplied cash and deposit balances are read correctly (remain 0.00)", async () => {
      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail).not.toBeNull();

      // No unapplied/deposit transfers were made — both should be "0.00".
      expect(faDetail!.unappliedCashBalance).toBe("0.00");
      expect(faDetail!.depositBalance).toBe("0.00");
    });

    it("V3 — V1 zero-sum invariant holds after the charge transfer", async () => {
      const [sum] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total
        FROM billing.pgledger_accounts_view
        WHERE currency = 'MYR'
      `;
      expect(Number(sum?.total ?? "0")).toBe(0);
    });

    it("V3 — derivedOverdue is false (no open DBN documents exist yet)", async () => {
      const banDetail = await getBillingAccountDetail(billingAccountId);
      expect(banDetail).not.toBeNull();
      // No documents posted (ac07); openAR > 0 but no charge date → false.
      expect(banDetail!.derivedOverdue).toBe(false);
    });
  },
);
