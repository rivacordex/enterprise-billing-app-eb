import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { customerBillLineRepository } from "@/db/repositories/billing/customer-bill-line.repository";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { retryRenderInvoice } from "@/services/billing/post-run";
import { getStoredInvoice } from "@/services/billing/read/get-stored-invoice";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  GENERATED_FIXTURE_FILES,
  insertGeneratedTemplateFixture,
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";

// Guardrail 46 (bm54-spec §Tests; code-standards Part 2 §9 item 46, Inv #41–
// #43). Account A is posted through the REAL posting transaction under a
// fixture generated v2 (ACTIVE row + uploaded, checksum-indexed blob) and a
// fixture company profile v1 (with a logo). Then a newer generated v3 is made
// ACTIVE (retiring v2) and a profile v2 is made ACTIVE — DB fixtures, because
// the activation actions (bm58/bm61) are not built yet. After that:
//   * A's four stamps are unchanged (0033 froze them at posting);
//   * A's stored PDF (`getStoredInvoice`, md5-verified) is byte-equal to before
//     — a reprint is the stored bytes, never a re-render (Inv #43);
//   * A's `charge_checksum` still recomputes from its lines;
//   * a parked twin posted alongside A re-renders through `retryRenderInvoice`
//     with v2 + profile v1 (its stamps), never the current ACTIVE (Inv #42);
//   * a NEW draft preview of account B uses v3 + profile v2.
//
// The fixture versions are byte-copies of the seeded default v1 with a marker
// on the title element and `template.version` printed in the footer, so the
// rendered HTML shows which version ran. `.integration.test.ts` (not the
// spec's `.test.ts`): it drops schemas, so it runs under the destructive-DB
// preflight (bm50/bm53 precedent). Requires DATABASE_URL +
// BILLRUN_BLOB_CONNECTION_STRING (Azurite) + Playwright Chromium.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN = "BRN-BM54-G46";
const RUN_DRAFT = "BRN-BM54-G46-DRAFT";
const SUFFIX = Date.now().toString(36);
const LOGO_PATH = `it-bm54-${SUFFIX}/v1/logo.png`;
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function profileRows(companyName: string): Record<string, string> {
  return {
    company_name: companyName,
    registration_no: "202001000001",
    tin: "C12345678901",
    address_line1: "Level 10, Menara Billing",
    postcode: "50450",
    city: "Kuala Lumpur",
    state_code: "14",
    phone: "+60 3-2000 0000",
    email: "billing@digital-billing.example",
    brand_color: "#2E45A9",
    accent_color: "#006975",
    bank_name: "Maybank Berhad",
    bank_account_name: companyName,
    bank_account_no: "5140-1234-5678",
    swift: "MBBEMYKL",
    remittance_email: "ar@digital-billing.example",
    payment_terms_days: "30",
    logo_asset_version_id: "INVASV00000001",
  };
}
const COMPANY_V1 = "Pinned Profile One Sdn Bhd";
const COMPANY_V2 = "Newer Profile Two Sdn Bhd";

interface Stamps {
  ref_bill_format_id: string | null;
  ref_bill_template_version_id: string | null;
  ref_invoice_profile_version: number | null;
  ref_csv_template_version_id: string | null;
  charge_checksum: string | null;
  customer_bill_id: string;
  period_partition: string;
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "guardrail 46 — a posted invoice stays pinned to the versions it was posted under",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const uploadedTemplateDirs: string[] = [];
    let banA = "";
    let banTwin = "";
    let banDraft = "";

    async function insertGenerated(
      id: string,
      versionNo: number,
    ): Promise<void> {
      const { dir } = await insertGeneratedTemplateFixture(sql, {
        id,
        versionNo,
        dirTag: `it-bm54-${SUFFIX}`,
      });
      uploadedTemplateDirs.push(dir);
    }

    async function insertProfile(version: number, company: string) {
      for (const [key, value] of Object.entries(profileRows(company))) {
        await sql`
          INSERT INTO core.system_config
            (config_group, config_version, config_key, config_value, is_secret, status)
          VALUES ('invoice.profile', ${version}, ${key}, ${value}, false, 'ACTIVE')`;
      }
    }

    async function readStamps(banId: string): Promise<Stamps> {
      const [row] = await sql<Stamps[]>`
        SELECT ref_bill_format_id, ref_bill_template_version_id,
               ref_invoice_profile_version, ref_csv_template_version_id,
               charge_checksum, customer_bill_id, period_partition::text
        FROM billing.customer_bill
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banId}`;
      return row!;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM54G46");
      await fx.seedPostingGl();
      await seedInvoiceTemplates(fx.db);
      clearLoadedTemplateMemo();

      // Profile v1 with a logo + generated v2, both ACTIVE.
      const assets = service!.getContainerClient("invoice-assets");
      await assets.createIfNotExists();
      await assets.getBlockBlobClient(LOGO_PATH).uploadData(LOGO);
      await sql`INSERT INTO billing.bill_asset (bill_asset_id, kind, name) VALUES ('INVAST00000001', 'logo', 'Company logo')`;
      await sql`
        INSERT INTO billing.bill_asset_version
          (bill_asset_version_id, ref_bill_asset_id, version_no, mime, width, height, byte_size,
           blob_ref, checksum, checksum_algorithm)
        VALUES ('INVASV00000001', 'INVAST00000001', 1, 'image/png', 1, 1, ${LOGO.length},
                ${`invoice-assets/${LOGO_PATH}`},
                ${createHash("sha256").update(LOGO).digest("hex")}, 'sha256')`;
      await insertProfile(1, COMPANY_V1);
      await insertGenerated("BTV00000010", 2);

      // Post A and its twin through the real posting transaction. Both render
      // + store after commit (production path).
      await fx.newRun(RUN);
      ({ banId: banA } = await fx.postableBill({ label: "A", runId: RUN }));
      ({ banId: banTwin } = await fx.postableBill({
        label: "TWIN",
        runId: RUN,
      }));
      for (const ban of [banA, banTwin]) {
        const result = await fx.post(RUN, ban);
        expect(result.status).toBe("invoiced");
      }

      // Park the twin: remove its stored artifact (row + PDF blob) so it is
      // render-pending — the D10 state `retryRenderInvoice` recovers. The
      // `bill_run_invoices` immutability trigger (0036) is bypassed for this
      // test-only teardown write (e2e happy-path precedent).
      const [twinStored] = await sql<{ blob_ref: string }[]>`
        SELECT blob_ref FROM billing.bill_run_invoices
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banTwin}`;
      expect(twinStored).toBeDefined();
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`DELETE FROM billing.bill_run_invoices WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banTwin}`;
      });
      const { path } = blobStore.parseBlobRef(twinStored!.blob_ref);
      await service!.getContainerClient("invoices").deleteBlob(path);

      await fx.newRun(RUN_DRAFT);
      ({ banId: banDraft } = await fx.draftBill({
        label: "B",
        runId: RUN_DRAFT,
      }));
    }, 300_000);

    afterAll(async () => {
      const templates = service?.getContainerClient("invoice-templates");
      for (const dir of uploadedTemplateDirs) {
        for (const name of GENERATED_FIXTURE_FILES) {
          await templates?.deleteBlob(`${dir}${name}`).catch(() => undefined);
        }
      }
      await service
        ?.getContainerClient("invoice-assets")
        .deleteBlob(LOGO_PATH)
        .catch(() => undefined);
      clearLoadedTemplateMemo();
      if (sql) {
        // `dropAll` resets `document_inv_seq`, so the next run re-posts
        // INV00000001; `putInvoice` is write-once and would adopt this run's
        // stored PDFs. Delete them (blob_refs read before the rows go).
        const stored = await sql<{ blob_ref: string }[]>`
          SELECT blob_ref FROM billing.bill_run_invoices
          WHERE ref_bill_run_id IN (${RUN}, ${RUN_DRAFT})`.catch(() => []);
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

    it("A is stamped with the versions current at posting: generated v2, profile v1, the default CSV", async () => {
      expect(await readStamps(banA)).toMatchObject({
        ref_bill_format_id: "INVOICE",
        ref_bill_template_version_id: "BTV00000010",
        ref_invoice_profile_version: 1,
        ref_csv_template_version_id: "BTV00000003",
      });
    });

    it("[CRITICAL] activating generated v3 + profile v2 changes neither A's stamps, nor its stored PDF bytes, nor its charge_checksum", async () => {
      const stampsBefore = await readStamps(banA);
      const storedBefore = await getStoredInvoice(RUN, banA);

      // Activation by DB fixture (bm58/bm61 not built): retire v2, insert v3
      // ACTIVE (the one-ACTIVE index allows only one), and a newer profile.
      await sql`
        UPDATE billing.bill_template_version
        SET status = 'RETIRED', retired_datetime = now()
        WHERE bill_template_version_id = 'BTV00000010'`;
      await insertGenerated("BTV00000011", 3);
      await insertProfile(2, COMPANY_V2);
      clearLoadedTemplateMemo();

      const stampsAfter = await readStamps(banA);
      expect(stampsAfter).toEqual(stampsBefore);

      const storedAfter = await getStoredInvoice(RUN, banA);
      expect(storedAfter.pdf.equals(storedBefore.pdf)).toBe(true);
      expect(storedAfter.checksum).toBe(storedBefore.checksum);
      // A reprint never re-renders: the artifact is already stored.
      expect(await retryRenderInvoice(RUN, banA)).toEqual({
        ok: false,
        code: "ALREADY_STORED",
      });

      // Inv #35/#43 — the checksum still recomputes equal from the lines.
      const recomputed = await customerBillLineRepository.computeChargeChecksum(
        fx.db,
        stampsAfter.customer_bill_id,
        stampsAfter.period_partition,
      );
      expect(recomputed).toBe(stampsAfter.charge_checksum);
    });

    it("[CRITICAL] the parked twin re-renders with its stamps (v2 + profile v1), never the newly ACTIVE versions", async () => {
      const final = await buildInvoiceHtml({
        runId: RUN,
        banId: banTwin,
        mode: "final",
        invoiceNo: (
          await sql<{ ref_inv_document_id: string }[]>`
          SELECT ref_inv_document_id FROM billing.customer_bill
          WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banTwin}`
        )[0]!.ref_inv_document_id,
      });
      expect(final.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000010",
      );
      expect(final.resolved.profileVersion).toBe(1);
      expect(final.html).toContain('data-tpl="PIN-MARK-V2"');
      expect(final.html).toContain(COMPANY_V1);
      expect(final.html).not.toContain(COMPANY_V2);
      expect(final.footerHtml).toContain("Template v2");

      const retried = await retryRenderInvoice(RUN, banTwin);
      expect(retried).toMatchObject({ ok: true });
      const stored = await getStoredInvoice(RUN, banTwin);
      expect(stored.pdf.subarray(0, 4).toString()).toBe("%PDF");
    }, 120_000);

    it("a NEW draft preview of account B uses the newly ACTIVE v3 + profile v2", async () => {
      const draft = await buildInvoiceHtml({
        runId: RUN_DRAFT,
        banId: banDraft,
        mode: "draft",
      });
      expect(draft.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000011",
      );
      expect(draft.resolved.profileVersion).toBe(2);
      expect(draft.html).toContain('data-tpl="PIN-MARK-V3"');
      expect(draft.html).toContain(COMPANY_V2);
      expect(draft.footerHtml).toContain("Template v3");
    });
  },
);
