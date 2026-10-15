import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { INVOICE_COLUMN_KEYS, INVOICE_SECTION_KEYS } from "@/types/billing";
import type { Database } from "@/db/client";

// bm65-spec §8 (guardrail 59, capture half of 60; Inv #51, #52, #58) — the
// run-start template stamps on a real database and a real Azurite:
//   1. an activation after the trigger leaves the captured stamps unchanged;
//   2. a rerun re-captures exactly the rerun BAN, and its audit lists it;
//   3. a BAN whose family has no ACTIVE (or default) version is stamped with a
//      NULL version — the trigger succeeds and the BAN is never EXCLUDED (D55).
// The services use the `@/db/client` singleton, so it is replaced with one
// built on the test client (the activate-template precedent). Activation is
// the real service, so it writes template blobs to Azurite.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;
const CURRENCY = "MYR";
const ACTOR = "bm65-actor";
const STANDARD = "BTF00000001";

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { rerunRun } from "@/services/billing/rerun-run";
import { triggerRun } from "@/services/billing/trigger-run";

function structure(notes: boolean) {
  return {
    sections: {
      ...Object.fromEntries(INVOICE_SECTION_KEYS.map((k) => [k, true])),
      notes,
    },
    columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
  } as Parameters<typeof saveTemplateDraft>[0]["structure"];
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm65 run-start template capture (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let drizzleDb: ReturnType<typeof drizzle<typeof schema>>;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const templates = () => service!.getContainerClient("invoice-templates");

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    async function newCycle(name: string): Promise<string> {
      const [cycle] = await drizzleDb
        .insert(billCycle)
        .values({ name, lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      return cycle!.billCycleId;
    }

    async function newBillingAccount(cycleId: string): Promise<string> {
      const [org] = await drizzleDb
        .insert(organization)
        .values({
          name: "BM65VERIFY-Customer",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await drizzleDb
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: ACTOR,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await drizzleDb
        .insert(financialAccount)
        .values({
          name: "BM65VERIFY-FA",
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: ACTOR,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await drizzleDb
        .insert(billingAccount)
        .values({
          name: "BM65VERIFY-BAN",
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: ACTOR,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

    async function newScheduledRun(cycleId: string): Promise<string> {
      const [row] = await drizzleDb
        .insert(billRun)
        .values({
          refBillCycleId: cycleId,
          periodStart: "2026-06-01",
          periodEnd: "2026-06-30",
          scheduledRunDate: "2026-07-01",
          status: "SCHEDULED",
          runType: "onCycle",
        })
        .returning({ billRunId: billRun.billRunId });
      return row!.billRunId;
    }

    // Save a draft and activate it through the real services; returns the id.
    async function activateNewStandardVersion(note: string): Promise<string> {
      const saved = await saveTemplateDraft(
        { structure: structure(false), expectedDraftToken: null },
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      const activated = await activateTemplate(
        {
          draftId: saved.versionId,
          expectedDraftToken: saved.draftToken,
          changeNote: note,
        },
        ACTOR,
      );
      if (!activated.ok) throw new Error(`activate failed: ${activated.code}`);
      return saved.versionId;
    }

    async function stamps(runId: string) {
      const rows = await sql<
        {
          ref_billing_account_id: string;
          status: string;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
          template_captured_at: string | null;
        }[]
      >`
        SELECT ref_billing_account_id, status, ref_bill_template_family_id,
               ref_bill_template_version_id, template_captured_at
        FROM billing.bill_run_account WHERE ref_bill_run_id = ${runId}`;
      return new Map(rows.map((r) => [r.ref_billing_account_id, r]));
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The cleanup below deletes blobs, so guard the blob store like the DB.
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 8, onnotice: () => {} });
      await dropAll();
      drizzleDb = drizzle(sql, { schema });
      await migrate(drizzleDb, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Capture Admin', 'capture-admin@example.com', 'LOCAL', 'ACTIVE')`;
      // Layout v1 and the default generated v1 must exist for activation.
      await seedInvoiceTemplates(db);
      clearLoadedTemplateMemo();
    }, 180_000);

    afterAll(async () => {
      if (service) {
        for await (const b of templates().listBlobsFlat({
          prefix: "generated/INVOICE/v",
        })) {
          // Keep the seeded default (`v1/`); remove what these tests wrote.
          if (!b.name.startsWith("generated/INVOICE/v1/")) {
            await templates()
              .deleteBlob(b.name)
              .catch(() => undefined);
          }
        }
      }
      clearLoadedTemplateMemo();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("1. an activation after the trigger leaves the captured stamps unchanged", async () => {
      const cycleId = await newCycle("BM65VERIFY Activation Cycle");
      const ban = await newBillingAccount(cycleId);
      const runId = await newScheduledRun(cycleId);

      expect((await triggerRun(runId, ACTOR, "2026-07-01")).ok).toBe(true);
      const before = (await stamps(runId)).get(ban)!;
      expect(before).toMatchObject({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id: "BTV00000002",
      });

      const activated = await activateNewStandardVersion("bm65 activation");
      expect(activated).not.toBe("BTV00000002");

      const after = (await stamps(runId)).get(ban)!;
      expect(after).toEqual(before);
    });

    it("2. a rerun re-captures exactly the rerun BAN, and the rerun audit lists it", async () => {
      const cycleId = await newCycle("BM65VERIFY Rerun Cycle");
      const rerunBan = await newBillingAccount(cycleId);
      const otherBan = await newBillingAccount(cycleId);
      const runId = await newScheduledRun(cycleId);

      expect((await triggerRun(runId, ACTOR, "2026-07-01")).ok).toBe(true);
      const before = await stamps(runId);
      const capturedVersion =
        before.get(rerunBan)!.ref_bill_template_version_id;
      expect(before.get(otherBan)!.ref_bill_template_version_id).toBe(
        capturedVersion,
      );

      const newer = await activateNewStandardVersion("bm65 rerun");
      expect(newer).not.toBe(capturedVersion);

      // Pre-approval: the processor would have driven the run to PROCESSED.
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${runId}`;
      await sql`UPDATE billing.bill_run_account SET status = 'PROCESSED' WHERE ref_bill_run_id = ${runId}`;

      const rerun = await rerunRun(
        {
          billRunId: runId,
          accountIds: [rerunBan],
          fromStage: "validation",
          reason: "bm65 re-capture",
        },
        ACTOR,
      );
      expect(rerun.ok).toBe(true);

      const after = await stamps(runId);
      expect(after.get(rerunBan)).toMatchObject({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id: newer,
      });
      expect(
        Date.parse(after.get(rerunBan)!.template_captured_at!),
      ).toBeGreaterThan(
        Date.parse(before.get(rerunBan)!.template_captured_at!),
      );
      // The BAN not in the rerun keeps its original capture (its status was
      // moved to PROCESSED above, so only the stamp columns are compared).
      const { status: _before, ...otherBefore } = before.get(otherBan)!;
      const { status: _after, ...otherAfter } = after.get(otherBan)!;
      expect(otherAfter).toEqual(otherBefore);

      const [audit] = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'BILL_RUN_RERUN' AND target_id = ${runId}`;
      expect(audit?.after_data.templateStamps).toEqual([
        { banId: rerunBan, familyId: STANDARD, versionId: newer },
      ]);
    });

    it("3. a family with no ACTIVE version stamps a NULL version; the trigger succeeds and the BAN is never EXCLUDED (D55)", async () => {
      // A second, non-default family (test-only) holding just a RETIRED
      // generated version, and a BAN bound to that version by SQL — bypassing
      // assertBindableTemplate, which accepts NULL only today.
      await sql`
        INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind)
        VALUES ('BTF00000099', 'BM65-EMPTY', 'Empty family', 'generated')`;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime, retired_datetime)
        SELECT 'BTV00000099', 'INVOICE', 'generated', 99, 'RETIRED', false,
               'BTV00000001', 'BTF00000099', structure, 'invoice-templates/generated/INVOICE/v99/',
               ${"9".repeat(64)}, 'sha256', 'bm65 retired fixture', now(), now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      const cycleId = await newCycle("BM65VERIFY Empty Family Cycle");
      const boundBan = await newBillingAccount(cycleId);
      const standardBan = await newBillingAccount(cycleId);
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_version_id = 'BTV00000099'
        WHERE billing_account_id = ${boundBan}`;
      const runId = await newScheduledRun(cycleId);

      const result = await triggerRun(runId, ACTOR, "2026-07-01");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.banCount).toBe(2);
      expect(result.value.excludedCount).toBe(0);

      const rows = await stamps(runId);
      expect(rows.get(boundBan)).toMatchObject({
        status: "PENDING",
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: null,
      });
      expect(rows.get(boundBan)!.template_captured_at).not.toBeNull();
      // A Standard BAN in the same run still gets Standard's current version.
      expect(rows.get(standardBan)).toMatchObject({
        ref_bill_template_family_id: STANDARD,
      });
      expect(
        rows.get(standardBan)!.ref_bill_template_version_id,
      ).not.toBeNull();

      const [audit] = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'BILL_RUN_TRIGGERED' AND target_id = ${runId}`;
      expect(audit?.after_data.templateStamps).toEqual(
        expect.arrayContaining([
          { banId: boundBan, familyId: "BTF00000099", versionId: null },
        ]),
      );
    });
  },
);
