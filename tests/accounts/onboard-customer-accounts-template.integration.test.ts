import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";

// cm18-spec §3.6 — onboarding writes ref_bill_template_version_id = NULL on
// the new BAN and records it in ACCOUNTS_ONBOARDED.afterData; a non-NULL id is
// refused before any write (Inv. #18, D13). Same fresh-migrate setup as
// v07-onboarding-atomicity.integration.test.ts.
const databaseUrl = process.env.DATABASE_URL;

const SCHEMAS = [
  "inventory",
  "ordering",
  "billing",
  "customer",
  "product",
  "rating",
  "core",
  "partman",
  "drizzle",
];

describe.skipIf(!databaseUrl)(
  "cm18 onboarding invoice template binding (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;
    let cycleId: string;

    async function seedInitializedCustomer(
      name: string,
    ): Promise<{ id: string; ts: Date }> {
      const [org] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES (${name}, 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!org) throw new Error("organization insert failed");

      const [pr] = await sql<{ id: string; ts: Date }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${org.id}, 'INITIALIZED', ${appuserId})
        RETURNING party_role_id AS id, last_modified_datetime AS ts
      `;
      if (!pr) throw new Error("party_role insert failed");
      return pr;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Migrate on a short-lived connection (migrate()-poisons-connection
      // quirk, see v07), then read on a fresh one.
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      try {
        for (const s of SCHEMAS) {
          await migrateSql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
        }
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
        VALUES ('test-user-cm18', 'cm18 Test User', 'cm18@example.com', 'LOCAL', 'ACTIVE')
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
      for (const s of SCHEMAS) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
      await sql.end();
    });

    it("onboarding leaves the BAN with ref_bill_template_version_id IS NULL and records it in the audit", async () => {
      const pr = await seedInitializedCustomer("cm18 Org A");

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          billTemplateVersionId: null,
          statusReason: "cm18 template binding test",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const [ban] = await sql<{ ref: string | null }[]>`
        SELECT ref_bill_template_version_id AS ref
        FROM billing.billing_account
        WHERE billing_account_id = ${result.value.billingAccountId}
      `;
      expect(ban).toBeDefined();
      expect(ban?.ref).toBeNull();

      const [audit] = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data
        FROM core.audit_log
        WHERE event_type = 'ACCOUNTS_ONBOARDED'
          AND target_id = ${result.value.financialAccountId}
      `;
      expect(audit?.after_data).toHaveProperty(
        "refBillTemplateVersionId",
        null,
      );
    });

    it("a non-NULL id leaves the customer INITIALIZED and creates no FA/BAN", async () => {
      const pr = await seedInitializedCustomer("cm18 Org B");

      const result = await onboardCustomerAccounts(
        {
          partyRoleId: pr.id,
          billCycleId: cycleId,
          currency: "MYR",
          billTemplateVersionId: "BTV00000002",
          statusReason: "cm18 template binding test",
          lastModifiedDatetime: pr.ts,
        },
        appuserId,
      );
      expect(result).toEqual({ ok: false, code: "TEMPLATE_NOT_BINDABLE" });

      const [status] = await sql<{ status: string }[]>`
        SELECT status FROM customer.party_role WHERE party_role_id = ${pr.id}
      `;
      expect(status?.status).toBe("INITIALIZED");

      const [fa] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.financial_account
        WHERE ref_party_role_id = ${pr.id}
      `;
      expect(Number(fa?.count)).toBe(0);

      const [ban] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count
        FROM billing.billing_account
        WHERE ref_party_role_id = ${pr.id}
      `;
      expect(Number(ban?.count)).toBe(0);
    });
  },
);
