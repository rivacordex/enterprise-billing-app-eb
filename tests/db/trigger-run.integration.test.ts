import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { PROCESSING_FLOW_ID } from "@/services/billing/engine-client";
import { engineRegistry } from "@/services/billing/engine-registry";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";
import type * as ScopeAccountsModule from "@/services/billing/scope-accounts";

// bm03-spec §Design/§9 — live-DB proof of the trigger transaction: the
// row-locked double-trigger guard, the scoping snapshot write, and the
// PROCESSING + gl_event_at stamp. Runs with no BILLRUN_ENGINE_URL configured
// (this suite's env), so the trigger drives the real stub engine client
// end-to-end — the mocked-engine ENGINE_UNREACHABLE rollback path is proven
// at the unit level (trigger-run.service.test.ts), where the failure can be
// injected deterministically.
//
// bm65-spec §8 — the run-start template capture: every non-EXCLUDED row is
// stamped with Standard and its current version, the profile/CSV versions and
// a capture time; EXCLUDED rows stay NULL; the trigger audit lists the stamps;
// a cancelled-then-re-triggered run carries no stale stamps.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";

// bm65 — Scoping excludes an account only for a partial-period subscription,
// which needs a full order/offering/product-inventory chain. The real
// `scopeAccounts` runs; the BANs listed here are moved to EXCLUDED on the way
// out (the e2e journey's simulated-exclusion precedent).
const hoisted = vi.hoisted(() => ({ forceExcluded: new Set<string>() }));
vi.mock("@/services/billing/scope-accounts", async (importActual) => {
  const actual = await importActual<typeof ScopeAccountsModule>();
  return {
    scopeAccounts: async (...args: Parameters<typeof actual.scopeAccounts>) => {
      const { pending, excluded } = await actual.scopeAccounts(...args);
      const moved = pending.filter((p) =>
        hoisted.forceExcluded.has(p.refBillingAccountId),
      );
      return {
        pending: pending.filter(
          (p) => !hoisted.forceExcluded.has(p.refBillingAccountId),
        ),
        excluded: [
          ...excluded,
          ...moved.map((m) => ({
            ...m,
            status: "EXCLUDED",
            errorCode: "PARTIAL_PERIOD",
          })),
        ],
      };
    },
  };
});

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
      // bm16/bm20 — the stub execution id is `stub-exec-<flowId>-<runId>`
      // (the flowId was added when the engine gained a second flow).
      expect(updated?.processingExecutionId).toBe(
        `stub-exec-${PROCESSING_FLOW_ID}-${runId}`,
      );

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
      // bm21-spec Phase-2 review fold T7 (#4b) — a DISTINCT period from the
      // previous case's (same shared `cycleId`, only one `beforeAll`/
      // `afterAll` for the whole file, no per-test reset): reusing
      // "2026-06-01" here collided with that case's own row on
      // `bill_run_cycle_period_unique` (ref_bill_cycle_id, period_start),
      // failing this test with a duplicate-key violation before it ever
      // reached the double-trigger guard under test.
      const runId = await newScheduledRun({
        periodStart: "2026-07-01",
        periodEnd: "2026-07-31",
        scheduledRunDate: "2026-08-01",
      });

      const first = await triggerRun(runId, actorId, "2026-08-01");
      expect(first.ok).toBe(true);

      // The scoping snapshot the first (successful) trigger wrote for THIS run.
      // The suite shares one cycle across cases, so its active-account count is
      // not fixed — assert the DELTA (the rejected second call adds nothing),
      // not a hard-coded 1.
      const afterFirst = await db
        .select()
        .from(billRunAccount)
        .where(eq(billRunAccount.refBillRunId, runId));
      expect(afterFirst.length).toBeGreaterThanOrEqual(1);

      const second = await triggerRun(runId, actorId, "2026-08-01");
      expect(second).toEqual({ ok: false, code: "NOT_OPERABLE" });

      const afterSecond = await db
        .select()
        .from(billRunAccount)
        .where(eq(billRunAccount.refBillRunId, runId));
      // The rejected second call wrote nothing further.
      expect(afterSecond).toHaveLength(afterFirst.length);
    });

    async function newCycle(name: string): Promise<string> {
      const [cycle] = await db
        .insert(billCycle)
        .values({ name, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      return cycle!.billCycleId;
    }

    async function stampRows(runId: string) {
      return sql!<
        {
          ref_billing_account_id: string;
          status: string;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
          ref_invoice_profile_version: number | null;
          ref_csv_template_version_id: string | null;
          template_captured_at: string | null;
        }[]
      >`
        SELECT ref_billing_account_id, status, ref_bill_template_family_id,
               ref_bill_template_version_id, ref_invoice_profile_version,
               ref_csv_template_version_id, template_captured_at
        FROM billing.bill_run_account WHERE ref_bill_run_id = ${runId}
        ORDER BY ref_billing_account_id`;
    }

    async function triggerAudit(runId: string) {
      const [row] = await sql!<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'BILL_RUN_TRIGGERED' AND target_id = ${runId}
        ORDER BY created_datetime DESC LIMIT 1`;
      return row?.after_data;
    }

    it("bm65 — stamps every PENDING row with Standard + current versions; EXCLUDED rows stay NULL; the audit lists the stamps", async () => {
      const previousCycleId = cycleId;
      cycleId = await newCycle("BM65VERIFY Capture Cycle");
      const billed = await newBillingAccount();
      const excluded = await newBillingAccount();
      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });
      cycleId = previousCycleId;
      hoisted.forceExcluded.add(excluded);

      try {
        const result = await triggerRun(runId, actorId, "2026-07-01");
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.excludedCount).toBe(1);
      } finally {
        hoisted.forceExcluded.delete(excluded);
      }

      const rows = await stampRows(runId);
      const byBan = new Map(rows.map((r) => [r.ref_billing_account_id, r]));
      expect(byBan.get(billed)).toMatchObject({
        status: "PENDING",
        ref_bill_template_family_id: "BTF00000001",
        // No activation in this suite: the current Standard version is the
        // seeded default.
        ref_bill_template_version_id: "BTV00000002",
        // Migrations seed no ACTIVE invoice.profile version (G15 A).
        ref_invoice_profile_version: null,
        ref_csv_template_version_id: "BTV00000003",
      });
      expect(byBan.get(billed)?.template_captured_at).not.toBeNull();
      expect(byBan.get(excluded)).toMatchObject({
        status: "EXCLUDED",
        ref_bill_template_family_id: null,
        ref_bill_template_version_id: null,
        ref_invoice_profile_version: null,
        ref_csv_template_version_id: null,
        template_captured_at: null,
      });

      expect(await triggerAudit(runId)).toMatchObject({
        banCount: 1,
        excludedCount: 1,
        templateStamps: [
          { banId: billed, familyId: "BTF00000001", versionId: "BTV00000002" },
        ],
      });
    });

    it("bm65 — a cancelled-then-re-triggered run carries fresh stamps, never the killed attempt's", async () => {
      const { cancelRun } = await import("@/services/billing/cancel-run");
      const previousCycleId = cycleId;
      cycleId = await newCycle("BM65VERIFY Re-trigger Cycle");
      const ban = await newBillingAccount();
      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });
      cycleId = previousCycleId;

      expect((await triggerRun(runId, actorId, "2026-07-01")).ok).toBe(true);
      const [first] = await stampRows(runId);
      expect(first?.ref_bill_template_version_id).toBe("BTV00000002");

      expect((await cancelRun(runId, actorId)).ok).toBe(true);
      // A new Standard version becomes current while the run sits CANCELLED
      // (inserted by SQL: activation itself is covered by the bm65 capture
      // suite). The re-trigger must pick it up, not keep the killed stamp.
      await sql!`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime)
        SELECT 'BTV00000065', 'INVOICE', 'generated', 65, 'ACTIVE', false,
               'BTV00000001', 'BTF00000001', structure, 'invoice-templates/generated/INVOICE/v65/',
               ${"6".repeat(64)}, 'sha256', 'bm65 re-trigger fixture', now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      try {
        expect((await triggerRun(runId, actorId, "2026-07-01")).ok).toBe(true);
        const rows = await stampRows(runId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          ref_billing_account_id: ban,
          ref_bill_template_family_id: "BTF00000001",
          ref_bill_template_version_id: "BTV00000065",
        });
        expect(Date.parse(rows[0]!.template_captured_at!)).toBeGreaterThan(
          Date.parse(first!.template_captured_at!),
        );
        expect(await triggerAudit(runId)).toMatchObject({
          templateStamps: [
            { banId: ban, familyId: "BTF00000001", versionId: "BTV00000065" },
          ],
        });
      } finally {
        // Retire the fixture so later cases resolve the seeded default again.
        await sql!`
          UPDATE billing.bill_template_version SET status = 'RETIRED', retired_datetime = now()
          WHERE bill_template_version_id = 'BTV00000065'`;
      }
    });

    // bm65 checklist ("a forced engine failure leaves no stamps") — the
    // capture runs inside the trigger transaction, so the rollback removes it.
    it("bm65 — an engine failure rolls the capture back with the snapshot: no row, no stamp", async () => {
      const previousCycleId = cycleId;
      cycleId = await newCycle("BM65VERIFY Engine-down Cycle");
      await newBillingAccount();
      const runId = await newScheduledRun({
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        scheduledRunDate: "2026-07-01",
      });
      cycleId = previousCycleId;

      const spy = vi
        .spyOn(engineRegistry, "trigger")
        .mockRejectedValueOnce(new Error("engine down"));
      try {
        const result = await triggerRun(runId, actorId, "2026-07-01");
        expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
      } finally {
        spy.mockRestore();
      }

      expect(await stampRows(runId)).toEqual([]);
      const [run] = await db
        .select()
        .from(billRun)
        .where(eq(billRun.billRunId, runId));
      expect(run?.status).toBe("SCHEDULED");
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
