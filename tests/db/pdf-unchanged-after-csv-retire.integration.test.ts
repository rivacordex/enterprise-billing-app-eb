import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgresjs from "postgres";

import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { previewInvoiceTemplate } from "@/services/billing/invoice-template/preview";
import { getStoredInvoice } from "@/services/billing/read/get-stored-invoice";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  applyRealMigrations,
  setupPre0055Database,
  STANDARD,
  stampCsvOnBill,
  stampCsvOnRunAccount,
  teardownCsvRetireDatabase,
} from "@/tests/db/helpers/csv-retire-fixtures";
import type { InvoiceRenderFixtures } from "@/tests/db/helpers/invoice-render-fixtures";
import type { InvoiceTemplateStructure } from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm88-spec §9 "New" (D1, the user's condition: "without impacting the PDF").
// On a database at 0054 whose rows carry CSV stamps, render through the
// existing entry points:
//   (a) a posted bill        — `buildInvoiceHtml` mode `final`;
//   (b) a run draft          — `buildInvoiceHtml` mode `draft` (`run` mode);
//   (c) a family preview     — `previewInvoiceTemplate` (`preview-family`), of
//                              the sample bill and of the unposted bill;
// capture the HTML, apply the real `0055`, re-render the same four and assert
// identical HTML. The posted bill's stored PDF (written once at posting, never
// re-rendered) must read back with the same digest. Real database, real
// Azurite, real Chromium (the posting render).
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN_POSTED = "BRN08800011";
const RUN_OPEN = "BRN08800012";

interface Renders {
  final: string;
  finalFooter: string;
  draft: string;
  draftFooter: string;
  previewSample: string;
  previewBill: string;
}

interface StoredPdf {
  blobRef: string;
  checksum: string;
  sha256: string;
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm88 the PDF path is unchanged by 0055 (requires DATABASE_URL + Azurite + Chromium)",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    let guarded = false;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    let postedBan = "";
    let invoiceNo = "";
    let openBan = "";
    let openBillId = "";
    let structure: InvoiceTemplateStructure;
    let before: Renders;
    let after: Renders;
    let storedBefore: StoredPdf;
    let storedAfter: StoredPdf;

    async function renderAll(): Promise<Renders> {
      // Never a memoized template: each pass loads from blob.
      clearLoadedTemplateMemo();
      const final = await buildInvoiceHtml({
        runId: RUN_POSTED,
        banId: postedBan,
        mode: "final",
        invoiceNo,
      });
      const draft = await buildInvoiceHtml({
        runId: RUN_OPEN,
        banId: openBan,
        mode: "draft",
      });
      const previewSample = await previewInvoiceTemplate({
        structure,
        source: "sample",
        familyId: STANDARD,
      });
      const previewBill = await previewInvoiceTemplate({
        structure,
        source: { billId: openBillId },
        familyId: STANDARD,
      });
      return {
        final: final.html,
        finalFooter: final.footerHtml,
        draft: draft.html,
        draftFooter: draft.footerHtml,
        previewSample: previewSample.html,
        previewBill: previewBill.html,
      };
    }

    async function readStoredPdf(): Promise<StoredPdf> {
      const stored = await getStoredInvoice(RUN_POSTED, postedBan);
      return {
        blobRef: stored.blobRef,
        checksum: stored.checksum,
        sha256: createHash("sha256").update(stored.pdf).digest("hex"),
      };
    }

    beforeAll(async () => {
      // A database at 0054 with the seeded templates in blob.
      ({ sql, fx } = await setupPre0055Database({
        databaseUrl: databaseUrl as string,
        blobConnection: blobConnection as string,
        service: service!,
        prefix: "BM88P",
      }));
      guarded = true;

      // (a) A posted bill carrying the CSV stamp on its run row and its bill
      //     (stamped before the 0033 latch, as pre-bm88 posting left it). The
      //     posting render stores its PDF.
      await fx.newRun(RUN_POSTED);
      const posted = await fx.postableBill({
        label: "POSTED",
        runId: RUN_POSTED,
      });
      postedBan = posted.banId;
      await stampCsvOnRunAccount(sql, RUN_POSTED, postedBan);
      await stampCsvOnBill(sql, posted.customerBillId);
      const result = await fx.post(RUN_POSTED, postedBan);
      if (result.status !== "invoiced") {
        throw new Error(`posting failed: ${JSON.stringify(result)}`);
      }
      invoiceNo = result.invoiceId;

      // (b) An open run's captured account (CSV-stamped), not posted.
      await fx.newRun(RUN_OPEN);
      ({ banId: openBan, customerBillId: openBillId } = await fx.draftBill({
        label: "OPEN",
        runId: RUN_OPEN,
      }));
      await stampCsvOnRunAccount(sql, RUN_OPEN, openBan);

      // (c) Standard's current structure, as the settings page would submit it.
      const [row] = await sql<{ structure: unknown }[]>`
        SELECT structure FROM billing.bill_template_version
        WHERE bill_template_version_id = 'BTV00000002'`;
      structure = invoiceTemplateStructureSchema.parse(row!.structure);

      before = await renderAll();
      storedBefore = await readStoredPdf();

      await applyRealMigrations(sql);
      const [col] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'billing' AND column_name = 'ref_csv_template_version_id'`;
      if (col!.n !== 0) throw new Error("0055 did not apply");

      after = await renderAll();
      storedAfter = await readStoredPdf();
    }, 300_000);

    afterAll(async () => {
      await teardownCsvRetireDatabase(sql, service, guarded);
    }, 60_000);

    it("(a) a posted bill's final render is identical HTML before and after 0055", () => {
      expect(before.final).toContain(invoiceNo);
      expect(after.final).toBe(before.final);
      expect(after.finalFooter).toBe(before.finalFooter);
    });

    it("(b) a run draft's render is identical HTML before and after 0055", () => {
      expect(before.draft).toContain("Calculations are done in Mbps");
      expect(after.draft).toBe(before.draft);
      expect(after.draftFooter).toBe(before.draftFooter);
    });

    it("(c) the preview-family preview (sample and unposted bill) is identical HTML before and after 0055", () => {
      expect(before.previewSample.length).toBeGreaterThan(0);
      expect(after.previewSample).toBe(before.previewSample);
      expect(after.previewBill).toBe(before.previewBill);
    });

    it("the posted bill's stored PDF blob is unchanged (same ref, checksum and digest)", () => {
      expect(storedBefore.blobRef).not.toBe("");
      expect(storedAfter).toEqual(storedBefore);
    });
  },
);
