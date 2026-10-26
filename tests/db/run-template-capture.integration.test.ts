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
import { INVOICE_OPTIONAL_SECTION_KEYS } from "@/types/billing";
import type { Database } from "@/db/client";

// bm65-spec §8 (guardrail 59, capture half of 60; Inv #51, #52, #58) — the
// run-start template stamps on a real database and a real Azurite:
//   1. an activation after the trigger leaves the captured stamps unchanged;
//   2. a rerun re-captures exactly the rerun BAN, and its audit lists it;
//   3. a BAN whose family has no ACTIVE (or default) version is stamped with a
//      NULL version — the trigger succeeds and the BAN is never EXCLUDED (D55).
// bm82 (Inv #54 amended) — capture reads the BAN's TYPE column
// (`billing_account.ref_bill_template_family_id`, NULL = Standard, 0054), so the
// SQL-bound fixtures below set a type id, and a BAN bound through cm23's
// `setBillingAccountTemplate` drafts on its type's layout.
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

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { setBillingAccountTemplate } from "@/services/accounts/set-billing-account-template";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  buildLayoutPackage,
  cleanRender,
  replaceInFile,
} from "@/tests/helpers/layout-package";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { rerunRun } from "@/services/billing/rerun-run";
import { triggerRun } from "@/services/billing/trigger-run";
import { insertTemplateTypeFixture } from "@/tests/db/helpers/template-type-fixtures";

// bm82 — Wholesale's uploaded layout carries a marker the Standard layout lacks,
// so a draft shows which layout it rendered through.
const WHOLESALE_MARKER = "bm82 Wholesale layout";
// Blobs the Wholesale case writes (layout files and its per-type generated path).
const WHOLESALE_BLOB_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "generated/INVOICE/WHOLESALE/",
];

// bm72 — a new Standard version differs from v1 by its footnote.
function structure(footnoteLine: string) {
  return {
    sections: Object.fromEntries(
      INVOICE_OPTIONAL_SECTION_KEYS.map((k) => [k, true]),
    ),
    columns: {},
    footnote: [footnoteLine],
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
        {
          structure: structure("bm65 activation footnote"),
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      const activated = await activateTemplate(
        {
          draftId: saved.versionId,
          expectedDraftToken: saved.draftToken,
          changeNote: note,
          familyId: "BTF00000001",
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
        for (const prefix of WHOLESALE_BLOB_PREFIXES) {
          for await (const b of templates().listBlobsFlat({ prefix })) {
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

    it("0051 stores template_captured_at at millisecond precision (timestamptz(3), Data rule 4)", async () => {
      const [col] = await sql<{ datetime_precision: number }[]>`
        SELECT datetime_precision FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = 'bill_run_account'
          AND column_name = 'template_captured_at'`;
      expect(col?.datetime_precision).toBe(3);
    });

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
      // generated version, and a BAN bound to that TYPE by SQL — bypassing
      // assertBindableTemplate, which refuses a type with no ACTIVE version.
      // bm74 — the type needs its own layout (btv_pair_same_type_fk).
      await insertTemplateTypeFixture(sql, {
        typeId: "BTF00000099",
        code: "BM65_EMPTY",
        name: "Empty family",
        layoutVersionId: "BTV00000097",
      });
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime, retired_datetime)
        SELECT 'BTV00000099', 'INVOICE', 'generated', 99, 'RETIRED', false,
               'BTV00000097', 'BTF00000099', structure, 'invoice-templates/generated/INVOICE/v99/',
               ${"9".repeat(64)}, 'sha256', 'bm65 retired fixture', now(), now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      const cycleId = await newCycle("BM65VERIFY Empty Family Cycle");
      const boundBan = await newBillingAccount(cycleId);
      const standardBan = await newBillingAccount(cycleId);
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000099'
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

    // Review fixes (2026-10-16, known-issues §24c/§24d/§24e).
    it("4. a second family: Standard activation never retires its ACTIVE version; a retired family captures a NULL version", async () => {
      // bm74 — the type needs its own layout (btv_pair_same_type_fk).
      await insertTemplateTypeFixture(sql, {
        typeId: "BTF00000088",
        code: "BM65_SECOND",
        name: "Second family",
        layoutVersionId: "BTV00000087",
      });
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime)
        SELECT 'BTV00000088', 'INVOICE', 'generated', 88, 'ACTIVE', false,
               'BTV00000087', 'BTF00000088', structure, 'invoice-templates/generated/INVOICE/v88/',
               ${"8".repeat(64)}, 'sha256', 'bm65 second-family fixture', now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      // §24c — activating a Standard version retires only Standard's ACTIVE.
      await activateNewStandardVersion("bm65 second-family activation");
      const [second] = await sql<{ status: string }[]>`
        SELECT status FROM billing.bill_template_version
        WHERE bill_template_version_id = 'BTV00000088'`;
      expect(second?.status).toBe("ACTIVE");

      // A BAN bound to the second type captures its ACTIVE version.
      const cycleId = await newCycle("BM65VERIFY Second Family Cycle");
      const ban = await newBillingAccount(cycleId);
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000088'
        WHERE billing_account_id = ${ban}`;
      const runId = await newScheduledRun(cycleId);
      expect((await triggerRun(runId, ACTOR, "2026-07-01")).ok).toBe(true);
      expect((await stamps(runId)).get(ban)).toMatchObject({
        ref_bill_template_family_id: "BTF00000088",
        ref_bill_template_version_id: "BTV00000088",
      });

      // §24d (D44) — once the family is retired it is not usable: a rerun
      // re-captures the family with a NULL version, though its version stays
      // ACTIVE.
      await sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE bill_template_family_id = 'BTF00000088'`;
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${runId}`;
      await sql`UPDATE billing.bill_run_account SET status = 'PROCESSED' WHERE ref_bill_run_id = ${runId}`;
      const rerun = await rerunRun(
        {
          billRunId: runId,
          accountIds: [ban],
          fromStage: "validation",
          reason: "bm65 retired family",
        },
        ACTOR,
      );
      expect(rerun.ok).toBe(true);
      expect((await stamps(runId)).get(ban)).toMatchObject({
        ref_bill_template_family_id: "BTF00000088",
        ref_bill_template_version_id: null,
      });
    });

    // bm78-spec §13 (guardrail 70) — an uploaded, not yet activated type: its
    // only versions are a layout DRAFT and the settings DRAFT pointing at it.
    // A BAN bound to that type (by SQL; bm82: the type column) is stamped with
    // the type and a NULL version at capture — never a DRAFT id.
    it("6. a type whose only versions are DRAFTs stamps a NULL version, never a DRAFT id (bm78)", async () => {
      await sql`
        INSERT INTO billing.bill_template_family
          (bill_template_family_id, code, name, layout_code, kind)
        VALUES ('BTF00000077', 'BM78_DRAFTS', 'Drafts only', 'INVTPL-BM78_DRAFTS', 'generated')`;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_bill_template_family_id, layout_code, page_setup, blob_ref, checksum,
           checksum_algorithm, created_by, last_modified_by)
        SELECT 'BTV00000076', 'INVOICE', 'layout', 1, 'DRAFT', false,
               'BTF00000077', 'INVTPL-BM78_DRAFTS', page_setup,
               'invoice-templates/layouts/INVTPL-BM78_DRAFTS/v1-000000000000/',
               ${"7".repeat(64)}, 'sha256', ${ACTOR}, ${ACTOR}
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000001'`;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, created_by,
           last_modified_by)
        SELECT 'BTV00000077', 'INVOICE', 'generated', 1, 'DRAFT', false,
               'BTV00000076', 'BTF00000077', structure, ${ACTOR}, ${ACTOR}
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      const draftIds = ["BTV00000076", "BTV00000077"];

      const cycleId = await newCycle("BM78VERIFY Drafts Only Cycle");
      const ban = await newBillingAccount(cycleId);
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000077'
        WHERE billing_account_id = ${ban}`;
      const runId = await newScheduledRun(cycleId);

      const result = await triggerRun(runId, ACTOR, "2026-07-01");
      expect(result.ok).toBe(true);
      const row = (await stamps(runId)).get(ban);
      expect(row).toMatchObject({
        status: "PENDING",
        ref_bill_template_family_id: "BTF00000077",
        ref_bill_template_version_id: null,
      });
      expect(row?.template_captured_at).not.toBeNull();

      // No stamp anywhere in the run, nor the audit, names a DRAFT.
      const [drafted] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_run_account
        WHERE ref_bill_template_version_id = ANY(${draftIds})`;
      expect(drafted!.n).toBe(0);
      const [audit] = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'BILL_RUN_TRIGGERED' AND target_id = ${runId}`;
      expect(audit?.after_data.templateStamps).toEqual([
        { banId: ban, familyId: "BTF00000077", versionId: null },
      ]);
    });

    // bm82 — replaces the "non-generated version → NULL family" case, which a
    // type reference cannot express: a BAN bound (by SQL) to a new, empty type
    // with no generated version at all captures that type with a NULL version,
    // and the blocking `template_versions_captured` check refuses approval.
    it("5. a BAN bound to an empty type (no generated version) captures the type with a NULL version, and approval is blocked", async () => {
      await sql`
        INSERT INTO billing.bill_template_family
          (bill_template_family_id, code, name, layout_code, kind)
        VALUES ('BTF00000066', 'BM82_EMPTY', 'Empty type', 'INVTPL-BM82_EMPTY', 'generated')`;
      const cycleId = await newCycle("BM82VERIFY Empty Type Cycle");
      const ban = await newBillingAccount(cycleId);
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000066'
        WHERE billing_account_id = ${ban}`;
      const runId = await newScheduledRun(cycleId);

      const result = await triggerRun(runId, ACTOR, "2026-07-01");
      expect(result.ok).toBe(true);
      const row = (await stamps(runId)).get(ban);
      expect(row).toMatchObject({
        status: "PENDING",
        ref_bill_template_family_id: "BTF00000066",
        ref_bill_template_version_id: null,
      });
      expect(row?.template_captured_at).not.toBeNull();

      // The processor would have driven the run to PROCESSED.
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${runId}`;
      await sql`UPDATE billing.bill_run_account SET status = 'PROCESSED' WHERE ref_bill_run_id = ${runId}`;
      const run = await billRunRepository.findByIdForUpdate(db, runId);
      const checks = await runPreApprovalChecks(db, run!, "bm82-approver");
      expect(
        checks.find((c) => c.check === "template_versions_captured"),
      ).toMatchObject({ pass: false });
    });

    // bm82 — the visible result (with cm23): a BAN bound to Wholesale through
    // the real bind service drafts on Wholesale at the next Run; a NULL BAN in
    // the same run stays on Standard.
    it("7. a BAN bound to Wholesale via setBillingAccountTemplate captures Wholesale v1 and its draft renders through Wholesale's layout; a NULL BAN stays on Standard", async () => {
      // Create "Wholesale", upload its layout and activate settings v1 through
      // the bm77–bm79 services (stage 7's Chromium probe is stubbed clean).
      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      const wholesaleId = created.typeId;
      const uploaded = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: buildLayoutPackage({
            layoutCode: created.layoutCode,
            layoutVersion: 1,
            edit: (f) =>
              replaceInFile(
                f,
                "partials/header.hbs",
                "<h1>Invoice</h1>",
                `<h1>Invoice</h1><div class="bm82-marker">${WHOLESALE_MARKER}</div>`,
              ),
          }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      if (!uploaded.ok) throw new Error(`upload failed: ${uploaded.code}`);
      const draft = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId: wholesaleId,
      });
      if (!draft) throw new Error("no Wholesale settings draft");
      const activated = await activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: "bm82 Wholesale v1",
          familyId: wholesaleId,
        },
        ACTOR,
        { render: cleanRender() },
      );
      if (!activated.ok) throw new Error(`activate failed: ${activated.code}`);
      expect(activated.versionNo).toBe(1);
      clearLoadedTemplateMemo();

      // Bind BAN A through cm23's service; BAN B stays NULL (Standard).
      const cycleId = await newCycle("BM82VERIFY Wholesale Cycle");
      const banA = await newBillingAccount(cycleId);
      const banB = await newBillingAccount(cycleId);
      const [banRow] = await sql<
        { ref_party_role_id: string; last_modified: Date }[]
      >`
        SELECT ref_party_role_id, last_modified FROM billing.billing_account
        WHERE billing_account_id = ${banA}`;
      const bound = await setBillingAccountTemplate(
        {
          partyRoleId: banRow!.ref_party_role_id,
          billingAccountId: banA,
          typeId: wholesaleId,
          lastModified: new Date(banRow!.last_modified),
        },
        ACTOR,
      );
      expect(bound).toMatchObject({ ok: true, value: { changed: true } });

      const [standardCurrent] = await sql<
        { bill_template_version_id: string }[]
      >`
        SELECT bill_template_version_id FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${STANDARD} AND kind = 'generated'
          AND status = 'ACTIVE' AND NOT is_default`;

      const runId = await newScheduledRun(cycleId);
      expect((await triggerRun(runId, ACTOR, "2026-07-01")).ok).toBe(true);
      const rows = await stamps(runId);
      expect(rows.get(banA)).toMatchObject({
        ref_bill_template_family_id: wholesaleId,
        ref_bill_template_version_id: activated.versionId,
      });
      expect(rows.get(banB)).toMatchObject({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id:
          standardCurrent?.bill_template_version_id ?? "BTV00000002",
      });

      // The processor would have produced a trial bill per account; insert one
      // (the invoice-render-fixtures shape) so each draft can render.
      await sql`UPDATE billing.bill_run_account SET status = 'PROCESSED' WHERE ref_bill_run_id = ${runId}`;
      for (const ban of [banA, banB]) {
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          const [cb] = await tx<{ customer_bill_id: string }[]>`
            INSERT INTO billing.customer_bill
              (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
               billing_period_start, billing_period_end, subtotal, tax_total, total_amount,
               payment_due_date)
            VALUES (${runId}, ${ban}, '2026-06-01', 'trial', 'new',
                    '2026-06-01', '2026-06-30', '150.00', '0.00', '150.00', '2026-07-15')
            RETURNING customer_bill_id`;
          await tx`
            INSERT INTO billing.customer_bill_line
              (ref_customer_bill_id, period_partition, line_no, source, ref_product_offering_id,
               gross_amount, discount_amount, net_amount, grouping_key, currency, description,
               quantity, unit)
            VALUES (${cb!.customer_bill_id}, '2026-06-01', 1, 'RECURRING', 'POF-BM82',
                    '150.00', '0.00', '150.00', 'POF-BM82', 'MYR', 'BM82 Fibre',
                    '1.000000', 'EA')`;
        });
      }

      const draftA = await buildInvoiceHtml({
        runId,
        banId: banA,
        mode: "draft",
      });
      expect(draftA.resolved.generated.billTemplateVersionId).toBe(
        activated.versionId,
      );
      expect(draftA.resolved.layout.layoutCode).toBe(created.layoutCode);
      expect(draftA.html).toContain(WHOLESALE_MARKER);

      const draftB = await buildInvoiceHtml({
        runId,
        banId: banB,
        mode: "draft",
      });
      expect(draftB.resolved.layout.layoutCode).toBe("INVTPL-STD-A4");
      expect(draftB.html).not.toContain(WHOLESALE_MARKER);
    }, 180_000);
  },
);
