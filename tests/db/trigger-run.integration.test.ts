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
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";

// bm03-spec §Design/§9 — live-DB proof of the trigger transaction: the
// row-locked double-trigger guard, the scoping snapshot write, and the
// PROCESSING + gl_event_at stamp. Runs with no BILLRUN_ENGINE_URL configured
// (this suite's env), so the trigger drives the real stub engine client
// end-to-end — the mocked-engine ENGINE_UNREACHABLE rollback path is proven
// at the unit level (trigger-run.service.test.ts), where the failure can be
// injected deterministically.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";

describe.skipIf(!databaseUrl)(
  "triggerRun (bm03-spec §Design/§9, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql | undefined;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let triggerRun: typeof TriggerRun;
    let actorId: string;
    let cycleId: string;

    async function newAppUser(name: string): Promise<string> {
      const [row] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: name,
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      return row!.id;
    }

    async function newBillingAccount(): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: "BM03VERIFY-Customer",
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
          name: "BM03VERIFY-FA",
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: actorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "BM03VERIFY-BAN",
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newScheduledRun(overrides: {
      periodStart: string;
      periodEnd: string;
      scheduledRunDate: string;
    }): Promise<string> {
      const [row] = await db
        .insert(billRun)
        .values({
          refBillCycleId: cycleId,
          periodStart: overrides.periodStart,
          periodEnd: overrides.periodEnd,
          scheduledRunDate: overrides.scheduledRunDate,
          status: "SCHEDULED",
          runType: "onCycle",
        })
        .returning({ billRunId: billRun.billRunId });
      return row!.billRunId;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      // The default (unpartitioned) partition created by the migration is
      // enough for this suite — pg_partman registration is a superuser-only
      // step (db:setup-partman-billing), not exercised here.

      ({ triggerRun } = await import("@/services/billing/trigger-run"));

      actorId = await newAppUser("BM03VERIFY-actor");
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM03VERIFY Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("snapshots the cycle's active accounts, flips PROCESSING, and stamps gl_event_at", async () => {
      const banId = await newBillingAccount();
      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });

      const result = await triggerRun(runId, actorId, "2026-07-01");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.banCount).toBe(1);
      expect(result.value.excludedCount).toBe(0);

      const [updated] = await db
        .select()
        .from(billRun)
        .where(eq(billRun.billRunId, runId));
      expect(updated?.status).toBe("PROCESSING");
      expect(updated?.glEventAt).toBe("2026-07-01");
      expect(updated?.triggeredBy).toBe(actorId);
      expect(updated?.processingExecutionId).toBe(`stub-exec-${runId}`);

      const snapshotRows = await db
        .select()
        .from(billRunAccount)
        .where(eq(billRunAccount.refBillRunId, runId));
      expect(snapshotRows).toHaveLength(1);
      expect(snapshotRows[0]?.refBillingAccountId).toBe(banId);
      expect(snapshotRows[0]?.status).toBe("PENDING");
      expect(snapshotRows[0]?.periodPartition).toBe("2026-06-01");
    });

    it("rejects a second trigger while the run is already PROCESSING (double-trigger guard)", async () => {
      await newBillingAccount();
      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });

      const first = await triggerRun(runId, actorId, "2026-07-01");
      expect(first.ok).toBe(true);

      const second = await triggerRun(runId, actorId, "2026-07-01");
      expect(second).toEqual({ ok: false, code: "NOT_OPERABLE" });

      const snapshotRows = await db
        .select()
        .from(billRunAccount)
        .where(eq(billRunAccount.refBillRunId, runId));
      // Exactly the first trigger's one-account snapshot — the rejected second
      // call wrote nothing further.
      expect(snapshotRows).toHaveLength(1);
    });

    it("returns NO_ELIGIBLE_ACCOUNTS and writes no snapshot rows when the cycle has no active accounts", async () => {
      const [emptyCycle] = await db
        .insert(billCycle)
        .values({ name: "BM03VERIFY Empty Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      const previousCycleId = cycleId;
      cycleId = emptyCycle!.billCycleId;

      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });
      cycleId = previousCycleId;

      const result = await triggerRun(runId, actorId, "2026-07-01");

      expect(result).toEqual({ ok: false, code: "NO_ELIGIBLE_ACCOUNTS" });

      const [afterAttempt] = await db
        .select()
        .from(billRun)
        .where(eq(billRun.billRunId, runId));
      expect(afterAttempt?.status).toBe("SCHEDULED");

      const snapshotRows = await db
        .select()
        .from(billRunAccount)
        .where(eq(billRunAccount.refBillRunId, runId));
      expect(snapshotRows).toHaveLength(0);
    });
  },
);
