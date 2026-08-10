import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { capturePayment } from "@/services/accounts/capture-payment";
import { allocatePayment } from "@/services/accounts/allocate-payment";

// ac07-spec §3.10 v08-payment-status.integration.test.ts — V8: a charge
// (fixture A/R transfer, simulating a DBN before ac09 exists) → `due`; full
// allocation → `paid`, derived from the live receivables balance
// (`ledger.repository`, Module Inv. #2), not stored.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V8 — payment_status derivation (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let actorId: string;
    let financialAccountId: string;
    let billingAccountId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

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
        VALUES ('test-user-v08', 'V08 Test User', 'v08@example.com', 'LOCAL', 'ACTIVE')
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

      const [sysRevenue] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('sys.revenue.MYR', 'MYR')
      `;

      const [cycle] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
        VALUES ('V08 Monthly', 'monthly', 1, 30, 'active')
        RETURNING bill_cycle_id AS id
      `;
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES ('V08 Test Corp', 'COMPANY', ${actorId})
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
          statusReason: "V08 payment-status test",
          lastModifiedDatetime: pr!.ts,
        },
        actorId,
      );
      if (!onboarded.ok)
        throw new Error(`onboarding failed: ${onboarded.code}`);
      financialAccountId = onboarded.value.financialAccountId;
      billingAccountId = onboarded.value.billingAccountId;

      // Fixture charge (simulating a DBN before ac09) — sets a real A/R
      // balance, then the BAN is flipped to `due` the way a real DBN post
      // will (ac09), so this test starts from the state V8 actually checks.
      const [recBinding] = await sql<{ pgledger_account_id: string }[]>`
        SELECT pgledger_account_id FROM billing.ledger_binding
        WHERE owner_type = 'billing_account' AND owner_id = ${billingAccountId} AND ledger_role = 'receivables'
      `;
      await sql`
        SELECT * FROM billing.pgledger_create_transfer(
          ${sysRevenue!.id}, ${recBinding!.pgledger_account_id}, 5000.00::numeric, NOW(), '{"doc": "v08-fixture-charge"}'::jsonb
        )
      `;
      await sql`
        UPDATE billing.billing_account SET payment_status = 'due' WHERE billing_account_id = ${billingAccountId}
      `;
    }, 60_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("payment_status is due before the charge is fully paid", async () => {
      const [row] = await sql<{ payment_status: string }[]>`
        SELECT payment_status FROM billing.billing_account WHERE billing_account_id = ${billingAccountId}
      `;
      expect(row!.payment_status).toBe("due");
    });

    it("a full allocation flips payment_status to paid, derived from the live receivables balance", async () => {
      const captured = await capturePayment(
        {
          financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount: "5000.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "V08-CAPTURE" },
          eventAt: new Date("2026-04-01T00:00:00.000Z"),
          entryDate: new Date("2026-04-01T00:00:00.000Z"),
          referenceInfo: "V08 capture",
        },
        actorId,
      );
      expect(captured.ok).toBe(true);

      const allocated = await allocatePayment(
        {
          financialAccountId,
          billingAccountId,
          amount: "5000.00",
          refSettledDocumentId: null,
          eventAt: new Date("2026-04-02T00:00:00.000Z"),
          entryDate: new Date("2026-04-02T00:00:00.000Z"),
          referenceInfo: "V08 allocation",
        },
        actorId,
      );
      expect(allocated.ok).toBe(true);
      if (!allocated.ok) return;
      expect(allocated.value.state).toBe("posted");

      const [row] = await sql<{ payment_status: string }[]>`
        SELECT payment_status FROM billing.billing_account WHERE billing_account_id = ${billingAccountId}
      `;
      expect(row!.payment_status).toBe("paid");
    });

    it("V1 — zero-sum holds after the full allocation", async () => {
      const [sumRow] = await sql<{ total: string | null }[]>`
        SELECT sum(balance)::text AS total FROM billing.pgledger_accounts_view
      `;
      expect(Number(sumRow?.total ?? "0")).toBe(0);
    });
  },
);
