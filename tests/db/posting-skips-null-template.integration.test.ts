import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

// Guardrail item 60, posting half (bm67-spec §5; D58, Inv #58, Inv #7). A BAN
// captured with a NULL template version (its family had no ACTIVE version at
// run start, bm65 D55) goes through approve and the REAL `postRun`:
//   * it ends `SKIPPED` with `TEMPLATE_VERSION_NOT_FOUND`, holds no
//     `billing.document` row, and its `customer_bill.ref_inv_document_id`
//     stays NULL;
//   * no invoice number is consumed — the siblings' INV numbers are
//     consecutive, with no gap;
//   * the siblings are `INVOICED` and the run reaches `INVOICED`.
// The automatic distribution trigger runs after the run is INVOICED; it is
// stubbed here so the run's state can be asserted at INVOICED (distribution is
// not this unit's boundary). The post-commit render is the production one, so
// the suite needs the throwaway Azurite for the stored PDFs.

vi.mock("@/services/billing/distribute-run", () => ({
  triggerDistribution: vi.fn(async () => ({ ok: true })),
}));

import { blobStore } from "@/services/billing/blob-store";
import { captureTemplateStamps } from "@/services/billing/capture-template-stamps";
import { triggerDistribution } from "@/services/billing/distribute-run";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { postRun } from "@/services/billing/post-run";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { BlobServiceClient } from "@azure/storage-blob";
import { insertTemplateTypeFixture } from "@/tests/db/helpers/template-type-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN = "BRN06700001";

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm67 posting skips a NULL-version capture before the INV (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    let actorId = "";
    let nullBan = "";
    const siblings: string[] = [];

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The cleanup deletes stored invoice blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 5, onnotice: () => {} });
      fx = await setupInvoiceRenderFixtures(sql, "BM67");
      await fx.seedPostingGl();
      await seedInvoiceTemplates(fx.db);
      clearLoadedTemplateMemo();
      const [actor] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM core.appuser LIMIT 1`;
      actorId = actor!.user_id;

      // bm65 §8 case 3's fixture: a second, non-default family holding only a
      // RETIRED generated version.
      // bm74 — the type needs its own layout (btv_pair_same_type_fk).
      await insertTemplateTypeFixture(sql, {
        typeId: "BTF00000099",
        code: "BM67_EMPTY",
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
               ${"9".repeat(64)}, 'sha256', 'bm67 retired fixture', now(), now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      await fx.newRun(RUN);
      // Sibling, NULL-stamp BAN, sibling — the skip sits between two posts, so
      // a consumed number would show as a gap.
      siblings.push((await fx.postableBill({ label: "S1", runId: RUN })).banId);
      ({ banId: nullBan } = await fx.postableBill({
        label: "NUL",
        runId: RUN,
      }));
      siblings.push((await fx.postableBill({ label: "S2", runId: RUN })).banId);
      // Bind the BAN to the empty family by SQL (bypassing
      // assertBindableTemplate, which refuses a type with no ACTIVE version;
      // bm82: the type column) and re-capture, as a
      // trigger would: the family has no ACTIVE version → NULL version (D55).
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000099'
        WHERE billing_account_id = ${nullBan}`;
      await captureTemplateStamps(fx.db, RUN, [nullBan], "2026-06-01");

      // The run finished processing. Approval is driven by raw SQL below: the
      // blocking `template_versions_captured` check (review fix) refuses the
      // real approve for this run — asserted in its own case — and this suite
      // proves posting's D58 skip still holds as the backstop.
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${RUN}`;
    }, 240_000);

    async function approveBySql(): Promise<void> {
      await sql`
        UPDATE billing.bill_run SET status = 'APPROVED', approved_by = ${actorId},
               approved_at = now(), gl_event_at = scheduled_run_date
        WHERE bill_run_id = ${RUN}`;
    }

    afterAll(async () => {
      clearLoadedTemplateMemo();
      if (sql) {
        // `dropAll` resets `document_inv_seq`; delete this run's stored PDFs so
        // a later suite's INV00000001 is not adopted (write-once).
        const stored = await sql<{ blob_ref: string }[]>`
          SELECT blob_ref FROM billing.bill_run_invoices
          WHERE ref_bill_run_id = ${RUN}`.catch(() => []);
        for (const { blob_ref } of stored) {
          const { container, path } = blobStore.parseBlobRef(blob_ref);
          await service
            ?.getContainerClient(container)
            .deleteBlob(path)
            .catch(() => undefined);
        }
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("the NULL-version BAN is captured with its family and a NULL version, and is PROCESSED before posting", async () => {
      const [row] = await sql<
        {
          status: string;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
        }[]
      >`
        SELECT status, ref_bill_template_family_id, ref_bill_template_version_id
        FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${nullBan}`;
      expect(row).toEqual({
        status: "PROCESSED",
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: null,
      });
    });

    it("[CRITICAL] review fix — the blocking template_versions_captured check refuses approval while the NULL-version account is PROCESSED", async () => {
      const run = await billRunRepository.findByIdForUpdate(fx.db, RUN);
      const checks = await runPreApprovalChecks(fx.db, run!, actorId);
      const check = checks.find(
        (c) => c.check === "template_versions_captured",
      );
      expect(check).toMatchObject({ pass: false });
      expect(check?.informational).toBeUndefined();
      expect(check?.remediation).toContain(
        "1 account has no invoice template version",
      );
    });

    it("[CRITICAL] D58 backstop — postRun skips it before the INV — SKIPPED / TEMPLATE_VERSION_NOT_FOUND, no document, no gap; siblings and the run are INVOICED", async () => {
      await approveBySql();
      const result = await postRun(RUN, actorId);
      expect(result.ok).toBe(true);

      const accounts = await sql<
        {
          ref_billing_account_id: string;
          status: string;
          error_code: string | null;
        }[]
      >`
        SELECT ref_billing_account_id, status, error_code
        FROM billing.bill_run_account WHERE ref_bill_run_id = ${RUN}`;
      const byBan = new Map(accounts.map((a) => [a.ref_billing_account_id, a]));
      expect(byBan.get(nullBan)).toMatchObject({
        status: "SKIPPED",
        error_code: "TEMPLATE_VERSION_NOT_FOUND",
      });
      for (const ban of siblings) {
        expect(byBan.get(ban)?.status, ban).toBe("INVOICED");
      }

      // No INV for the skipped BAN, and its bill is not finalized.
      const docs = await sql<{ document_id: string }[]>`
        SELECT document_id FROM billing.document
        WHERE ref_billing_account_id = ${nullBan}`;
      expect(docs).toEqual([]);
      const [nullBill] = await sql<{ ref_inv_document_id: string | null }[]>`
        SELECT ref_inv_document_id FROM billing.customer_bill
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${nullBan}`;
      expect(nullBill?.ref_inv_document_id).toBeNull();

      // Inv #7 — the two siblings hold consecutive INV numbers: the skip
      // consumed none.
      const invs = await sql<{ document_id: string }[]>`
        SELECT document_id FROM billing.document
        WHERE doc_type = 'INV' AND reference_info = ${`Bill run ${RUN}`}
        ORDER BY document_id`;
      expect(invs).toHaveLength(2);
      const numbers = invs.map((d) => Number(d.document_id.replace(/\D/g, "")));
      expect(numbers[1]! - numbers[0]!).toBe(1);

      const [run] = await sql<{ status: string }[]>`
        SELECT status FROM billing.bill_run WHERE bill_run_id = ${RUN}`;
      expect(run?.status).toBe("INVOICED");
      expect(vi.mocked(triggerDistribution)).toHaveBeenCalledWith(RUN, null);

      // Review fix §24a (general §1.7) — the skip is audited with the change.
      const audit = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = 'BILL_RUN_ACCOUNT_SKIPPED' AND target_id = ${RUN}`;
      expect(audit.map((a) => a.after_data)).toEqual([
        expect.objectContaining({
          banId: nullBan,
          status: "SKIPPED",
          code: "TEMPLATE_VERSION_NOT_FOUND",
          familyId: "BTF00000099",
        }),
      ]);
    }, 180_000);

    it("the siblings' bills carry the Standard family and its captured version", async () => {
      const bills = await sql<
        {
          ref_billing_account_id: string;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
        }[]
      >`
        SELECT ref_billing_account_id, ref_bill_template_family_id, ref_bill_template_version_id
        FROM billing.customer_bill
        WHERE ref_bill_run_id = ${RUN} AND ref_inv_document_id IS NOT NULL`;
      expect(bills.map((b) => b.ref_billing_account_id).sort()).toEqual(
        [...siblings].sort(),
      );
      for (const b of bills) {
        expect(b.ref_bill_template_family_id).toBe("BTF00000001");
        expect(b.ref_bill_template_version_id).toBe("BTV00000002");
      }
    });
  },
);
