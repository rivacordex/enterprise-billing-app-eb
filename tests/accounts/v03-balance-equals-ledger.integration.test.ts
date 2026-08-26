import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { capturePayment } from "@/services/accounts/capture-payment";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { getBillingAccountDetail } from "@/services/accounts/get-billing-account-detail";
import { getFinancialAccountDetail } from "@/services/accounts/get-financial-account-detail";

// ac07-spec §3.10 v03-balance-equals-ledger.integration.test.ts — the plan
// §2 story reproduced end to end through the real posting path (not a
// simulated `pgledger_create_transfer` fixture, unlike v03-live-balances):
// capture 5,400 → unapplied −5,400 (held); allocate → A/R 0, unapplied 0.
// Overview/service balances match `pgledger_accounts_view` throughout (V3).
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V3 — capture + allocation move balances through the real posting path (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let actorId: string;
    let financialAccountId: string;
    let billingAccountId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await migrateSql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
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
        VALUES ('test-user-v03b', 'V03b Test User', 'v03b@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      actorId = user!.id;

      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.MYR', 'MYR')`;

      await sql`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
        VALUES
          ('CUST_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('ADVANCE_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
          ('PAYMENT_REFUND', 'PAY', 'cash', 0.00, 'active')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V03b Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;

      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V03b Test Corp', 'COMPANY', ${actorId})
        RETURNING organization_id AS id
      `;
      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org!.id}, 'INITIALIZED', ${actorId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;

      const onboarded = await onboardCustomerAccounts(
        {
          partyRoleId: pr!.id,
          billCycleId: cycle!.id,
          currency: "MYR",
          statusReason: "V03b capture+allocate test",
          lastModifiedDatetime: pr!.ts,
        },
        actorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      // A fixture A/R charge, simulating a DBN (ac09) — direct
      // `pgledger_create_transfer`, matching v03-live-balances' precedent
      // (document-based charging doesn't exist until ac09).
      const [sysRevenue] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
      `;
      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      await sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${sysRevenue!.id}, ${recBinding!.pgledger_account_id}, 5400.00::numeric, NOW(), '{"doc": "v03b-fixture-charge"}'::jsonb
        )
      `;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("BAN A/R is 5400.00 before any payment", async () => {
      const detail = await getBillingAccountDetail(billingAccountId);
      expect(detail!.receivableBalance).toBe("5400.00");
    });

    it("capturing 5400 posts and holds it in unapplied_cash, matching pgledger_accounts_view", async () => {
      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "5400.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V03B-CAPTURE" },
          eventAt: new Date("2026-03-01T00:00:00.000Z"),
          entryDate: new Date("2026-03-01T00:00:00.000Z"),
          referenceInfo: "V03b capture",
        },
        actorId,
      );
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      expect(captured.value.state).toBe("posted");

      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail!.unappliedCashBalance).toBe("-5400.00");

      const [ucBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'financial_account' AND owner_id = ${financialAccountId} AND ledger_role = 'unapplied_cash'
      `;
      const [viewRow] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance FROM billing.pgledger_accounts_view WHERE id = ${ucBinding!.pgledger_account_id}
      `;
      expect(viewRow!.balance).toBe("-5400.00");
    });

    it("allocating 5400 to the BAN clears A/R and unapplied cash, matching pgledger_accounts_view (V3)", async () => {
      const allocated = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "5400.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-03-02T00:00:00.000Z"),
          entryDate: new Date("2026-03-02T00:00:00.000Z"),
          referenceInfo: "V03b allocation",
        },
        actorId,
      );
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;
      expect(allocated.value.state).toBe("posted");

      const banDetail = await getBillingAccountDetail(billingAccountId);
      expect(banDetail!.receivableBalance).toBe("0.00");

      const faDetail = await getFinancialAccountDetail(financialAccountId);
      expect(faDetail!.unappliedCashBalance).toBe("0.00");

      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      const [viewRow] = await sql<{ balance: string }[]>`
        SELECT balance::text AS balance FROM billing.pgledger_accounts_view WHERE id = ${recBinding!.pgledger_account_id}
      `;
      expect(viewRow!.balance).toBe("0.00");
    });

    it("V1 — zero-sum holds after capture + allocation", async () => {
      const [sumRow] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      expect(Number(sumRow?.total ?? "0")).toBe(0);
    });
  },
);
