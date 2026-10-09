import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { retryRenderInvoice } from "@/services/billing/post-run";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";

// Guardrail 47, first half (bm53-spec §Tests; code-standards Part 2 §9 item
// 47, Inv #45). One changed byte in the STORED default `generated/INVOICE/v1/
// invoice.hbs`, on a cold memo, parks every affected account's final render
// with `TEMPLATE_CHECKSUM_MISMATCH`: the INV stays posted, no PDF and no
// `bill_run_invoices` row is produced, and no legacy/unverified render happens
// (guardrail 44 proves no other render path exists). Each account parks on its
// own — one account's failure does not stop the next. A tampered logo on a
// fixture ACTIVE profile parks with `ASSET_CHECKSUM_MISMATCH`. (The "a bill
// pinned to a different version still renders" half lands with bm54's pins.)
//
// The tamper is a test-only raw SDK overwrite of the real seeded path
// (bypassing write-once); `afterAll` ALWAYS restores the original bytes. Run
// against a throwaway Azurite where possible — if this suite is killed mid-run
// on a shared one, `db:seed-invoice-templates` reports `SEED_BLOB_CONFLICT`
// for that path until it is restored. `.integration.test.ts` for the same
// reason as guardrail 45. Requires DATABASE_URL + BILLRUN_BLOB_CONNECTION_STRING.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN = "BRN-BM53-G47";
const TEMPLATE_PATH = "generated/INVOICE/v1/invoice.hbs";
const LOGO_PATH = `it-${Date.now().toString(36)}/v1/logo.png`;
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const PROFILE_ROWS: Record<string, string> = {
  company_name: "Digital Billing Sdn Bhd",
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
  bank_account_name: "Digital Billing Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  remittance_email: "ar@digital-billing.example",
  payment_terms_days: "30",
  logo_asset_version_id: "INVASV00000001",
};

describe.skipIf(!databaseUrl || !blobConnection)(
  "guardrail 47 — a tampered stored template or logo parks the render",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    let original: Buffer | null = null;
    const accounts: { banId: string; invoiceNo: string }[] = [];

    function rawBlob(container: string, path: string) {
      return service!.getContainerClient(container).getBlockBlobClient(path);
    }

    async function assertParked(
      banId: string,
      invoiceNo: string,
      code: string,
    ): Promise<void> {
      expect(await retryRenderInvoice(RUN, banId)).toEqual({
        ok: false,
        code: "RENDER_FAILED",
        detail: code,
      });
      const [doc] = await sql<{ state: string }[]>`
        SELECT state FROM billing.document WHERE document_id = ${invoiceNo}`;
      expect(doc?.state).toBe("posted");
      const stored = await sql`
        SELECT 1 FROM billing.bill_run_invoices
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banId}`;
      expect(stored).toHaveLength(0);
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM53G47");
      await seedInvoiceTemplates(fx.db);
      original = await blobStore.getObject("invoice-templates", TEMPLATE_PATH);

      await fx.newRun(RUN);
      for (const n of [1, 2]) {
        const invoiceNo = `INV9100000${n}`;
        const { banId } = await fx.postedBill({
          label: `T${n}`,
          runId: RUN,
          invoiceNo,
        });
        accounts.push({ banId, invoiceNo });
      }
    }, 180_000);

    afterAll(async () => {
      // ALWAYS restore the seeded bytes (raw overwrite, bypassing write-once).
      if (original) {
        await rawBlob("invoice-templates", TEMPLATE_PATH).uploadData(original, {
          blobHTTPHeaders: {
            blobContentType: "text/x-handlebars-template; charset=utf-8",
          },
        });
      }
      await service
        ?.getContainerClient("invoice-assets")
        .deleteBlob(LOGO_PATH)
        .catch(() => undefined);
      clearLoadedTemplateMemo();
      if (sql) {
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("one changed byte in the stored invoice.hbs (cold memo) parks every affected account with TEMPLATE_CHECKSUM_MISMATCH", async () => {
      const tampered = Buffer.from(original!);
      tampered[0] = tampered[0]! ^ 0x01;
      await rawBlob("invoice-templates", TEMPLATE_PATH).uploadData(tampered);
      clearLoadedTemplateMemo();

      // Each account parks independently — the first failure does not stop
      // the second.
      for (const { banId, invoiceNo } of accounts) {
        await assertParked(banId, invoiceNo, "TEMPLATE_CHECKSUM_MISMATCH");
      }
    });

    it("a tampered logo on a fixture ACTIVE profile parks with ASSET_CHECKSUM_MISMATCH", async () => {
      // Template restored → only the logo is wrong.
      await rawBlob("invoice-templates", TEMPLATE_PATH).uploadData(original!);
      clearLoadedTemplateMemo();

      const assets = service!.getContainerClient("invoice-assets");
      await assets.createIfNotExists();
      await sql`INSERT INTO billing.bill_asset (bill_asset_id, kind, name) VALUES ('INVAST00000001', 'logo', 'Company logo')`;
      await sql`
        INSERT INTO billing.bill_asset_version
          (bill_asset_version_id, ref_bill_asset_id, version_no, mime, width, height, byte_size,
           blob_ref, checksum, checksum_algorithm)
        VALUES ('INVASV00000001', 'INVAST00000001', 1, 'image/png', 1, 1, ${LOGO.length},
                ${`invoice-assets/${LOGO_PATH}`},
                ${createHash("sha256").update(LOGO).digest("hex")}, 'sha256')`;
      for (const [key, value] of Object.entries(PROFILE_ROWS)) {
        await sql`
          INSERT INTO core.system_config
            (config_group, config_version, config_key, config_value, is_secret, status)
          VALUES ('invoice.profile', 1, ${key}, ${value}, false, 'ACTIVE')`;
      }
      const tamperedLogo = Buffer.from(LOGO);
      tamperedLogo[tamperedLogo.length - 1] =
        tamperedLogo[tamperedLogo.length - 1]! ^ 0x01;
      await assets.getBlockBlobClient(LOGO_PATH).uploadData(tamperedLogo);

      // A bill carrying a profile stamp (the bm54 shape) resolves profile v1.
      const invoiceNo = "INV91000009";
      const { banId } = await fx.postedBill({
        label: "LOGO",
        runId: RUN,
        invoiceNo,
        refInvoiceProfileVersion: 1,
      });
      await assertParked(banId, invoiceNo, "ASSET_CHECKSUM_MISMATCH");
    });
  },
);
