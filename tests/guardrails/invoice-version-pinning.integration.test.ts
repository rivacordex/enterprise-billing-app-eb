import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { customerBillLineRepository } from "@/db/repositories/billing/customer-bill-line.repository";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { activateProfile } from "@/services/billing/invoice-profile/activate-profile";
import { saveProfileDraft } from "@/services/billing/invoice-profile/save-profile-draft";
import { uploadLogo } from "@/services/billing/invoice-profile/upload-logo";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { retryRenderInvoice } from "@/services/billing/post-run";
import { getStoredInvoice } from "@/services/billing/read/get-stored-invoice";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { decodablePng } from "@/tests/helpers/logo-fixtures";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";
import { INVOICE_COLUMN_KEYS, INVOICE_SECTION_KEYS } from "@/types/billing";
import type { SaveProfileDraftInput } from "@/validation/billing/invoice-profile.schema";

// Guardrail 46 (bm54-spec §Tests; code-standards Part 2 §9 item 46, Inv #41–
// #43). Account A is posted through the REAL posting transaction under a
// generated v2 and a fixture company profile v1 (with a logo). Then a newer
// generated v3 is made ACTIVE (retiring v2) and a profile v2 is made ACTIVE.
// bm58: the generated versions are now created by the REAL save-draft and
// activate services (a real generated, test-rendered, checksum-indexed blob
// write and a real retire + promote). bm61: the company profiles are now REAL
// activations too (save draft → upload logo → activate), so v1 is retired
// when v2 is promoted. After that:
//   * A's four stamps are unchanged (0033 froze them at posting);
//   * A's stored PDF (`getStoredInvoice`, md5-verified) is byte-equal to before
//     — a reprint is the stored bytes, never a re-render (Inv #43);
//   * A's `charge_checksum` still recomputes from its lines;
//   * a parked twin posted alongside A re-renders through `retryRenderInvoice`
//     with v2 + profile v1 (its stamps), never the current ACTIVE (Inv #42);
//   * a NEW draft preview of account B uses v3 + profile v2 (its issuer block,
//     bank details and the v2 logo inlined);
//   * the NEXT posting (account C) stamps profile v2.
//
// The two real versions differ in structure (v2 shows Notes & terms, v3 hides
// it), so the rendered HTML shows which version ran (`sec--notes`). `.integration.test.ts` (not the
// spec's `.test.ts`): it drops schemas, so it runs under the destructive-DB
// preflight (bm50/bm53 precedent). Requires DATABASE_URL +
// BILLRUN_BLOB_CONNECTION_STRING (Azurite) + Playwright Chromium.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN = "BRN-BM54-G46";
const RUN_DRAFT = "BRN-BM54-G46-DRAFT";
const RUN_NEXT = "BRN-BM61-G46-NEXT";
const APPROVER = "bm61-g46-approver";
// Two decodable logos (the render inlines them; Chromium displays them).
const LOGO_V1 = decodablePng(320, 320, 0x20);
const LOGO_V2 = decodablePng(330, 330, 0xd0);

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
  };
}
const COMPANY_V1 = "Pinned Profile One Sdn Bhd";
const COMPANY_V2 = "Newer Profile Two Sdn Bhd";
const ACCOUNT_V2 = "8888-7777-6666";

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
    let banA = "";
    let actorId = "";
    let v2Id = "";
    let v3Id = "";
    let banTwin = "";
    let banDraft = "";

    // A real activation: save the working draft, then activate it.
    async function activateGenerated(
      notesShown: boolean,
      note: string,
    ): Promise<{ versionId: string; versionNo: number }> {
      const structure = {
        sections: {
          ...Object.fromEntries(INVOICE_SECTION_KEYS.map((k) => [k, true])),
          notes: notesShown,
        },
        columns: Object.fromEntries(INVOICE_COLUMN_KEYS.map((k) => [k, true])),
      } as Parameters<typeof saveTemplateDraft>[0]["structure"];
      const saved = await saveTemplateDraft(
        { structure, expectedDraftToken: null },
        actorId,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      const activated = await activateTemplate(
        {
          draftId: saved.versionId,
          expectedDraftToken: saved.draftToken,
          changeNote: note,
        },
        actorId,
      );
      if (!activated.ok) {
        throw new Error(`activation failed: ${activated.code}`);
      }
      clearLoadedTemplateMemo();
      return { versionId: activated.versionId, versionNo: activated.versionNo };
    }

    // bm61 — a REAL profile activation: the working draft is saved and its
    // logo uploaded by `actorId`; another EDIT user activates it (any EDIT
    // user may, the editor included: no four-eyes, G14 decided 2026-10-11).
    async function activateProfileVersion(
      fields: Record<string, string>,
      logo: Buffer,
      note: string,
    ): Promise<{ version: number; logoId: string }> {
      const saved = await saveProfileDraft(
        {
          fields,
          expectedDraftToken: null,
        } as unknown as SaveProfileDraftInput,
        actorId,
      );
      if (!saved.ok)
        throw new Error(`save profile draft failed: ${saved.code}`);
      const uploaded = await uploadLogo(
        {
          bytes: logo,
          declaredMime: "image/png",
          expectedDraftToken: saved.draftToken,
        },
        actorId,
      );
      if (!uploaded.ok) {
        throw new Error(`logo upload failed: ${JSON.stringify(uploaded)}`);
      }
      const activated = await activateProfile(
        {
          configVersion: saved.versionNo,
          expectedDraftToken: uploaded.draftToken,
          changeNote: note,
        },
        APPROVER,
      );
      if (!activated.ok) {
        throw new Error(`profile activation failed: ${activated.code}`);
      }
      return {
        version: activated.configVersion,
        logoId: uploaded.assetVersionId,
      };
    }

    async function clearLogoBlobs(): Promise<void> {
      const assets = service!.getContainerClient("invoice-assets");
      await assets.createIfNotExists();
      for await (const b of assets.listBlobsFlat({ prefix: "INVAST" })) {
        await assets.deleteBlob(b.name).catch(() => undefined);
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
      // The cleanup deletes stored invoice and logo blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM54G46");
      await fx.seedPostingGl();
      await seedInvoiceTemplates(fx.db);
      clearLoadedTemplateMemo();

      // Profile v1 (a real activation, with a real logo) + generated v2.
      // Asset ids restart per migrate, so clear an earlier run's logo blobs.
      await clearLogoBlobs();
      const [actor] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM core.appuser LIMIT 1`;
      actorId = actor!.user_id;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${APPROVER}, 'G46 Approver', 'g46-approver@example.com', 'LOCAL', 'ACTIVE')`;
      const profileV1 = await activateProfileVersion(
        profileRows(COMPANY_V1),
        LOGO_V1,
        "pin test profile v1",
      );
      expect(profileV1.version).toBe(1);
      ({ versionId: v2Id } = await activateGenerated(true, "pin test v2"));

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
      if (service) await clearLogoBlobs();
      clearLoadedTemplateMemo();
      if (sql) {
        // `dropAll` resets `document_inv_seq`, so the next run re-posts
        // INV00000001; `putInvoice` is write-once and would adopt this run's
        // stored PDFs. Delete them (blob_refs read before the rows go).
        const stored = await sql<{ blob_ref: string }[]>`
          SELECT blob_ref FROM billing.bill_run_invoices
          WHERE ref_bill_run_id IN (${RUN}, ${RUN_DRAFT}, ${RUN_NEXT})`.catch(
          () => [],
        );
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
        ref_bill_template_version_id: v2Id,
        ref_invoice_profile_version: 1,
        ref_csv_template_version_id: "BTV00000003",
      });
    });

    it("[CRITICAL] activating generated v3 + profile v2 changes neither A's stamps, nor its stored PDF bytes, nor its charge_checksum", async () => {
      const stampsBefore = await readStamps(banA);
      const storedBefore = await getStoredInvoice(RUN, banA);

      // bm58: a REAL activation retires v2 and promotes v3. bm61: a REAL
      // profile activation retires profile v1 and promotes v2 (new name, new
      // bank account, new logo).
      ({ versionId: v3Id } = await activateGenerated(false, "pin test v3"));
      const profileV2 = await activateProfileVersion(
        { ...profileRows(COMPANY_V2), bank_account_no: ACCOUNT_V2 },
        LOGO_V2,
        "pin test profile v2",
      );
      expect(profileV2.version).toBe(2);
      const [v1Status] = await sql<{ status: string }[]>`
        SELECT DISTINCT status FROM core.system_config
        WHERE config_group = 'invoice.profile' AND config_version = 1`;
      expect(v1Status?.status).toBe("RETIRED");
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
    }, 120_000);

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
      expect(final.resolved.generated.billTemplateVersionId).toBe(v2Id);
      expect(final.resolved.profileVersion).toBe(1);
      expect(final.html).toContain("sec--notes");
      expect(final.html).toContain(COMPANY_V1);
      expect(final.html).not.toContain(COMPANY_V2);

      const retried = await retryRenderInvoice(RUN, banTwin);
      expect(retried).toMatchObject({ ok: true });
      const stored = await getStoredInvoice(RUN, banTwin);
      expect(stored.pdf.subarray(0, 4).toString()).toBe("%PDF");
    }, 120_000);

    it("a NEW draft preview of account B uses the newly ACTIVE v3 + profile v2: its issuer block, bank details and logo", async () => {
      const draft = await buildInvoiceHtml({
        runId: RUN_DRAFT,
        banId: banDraft,
        mode: "draft",
      });
      expect(draft.resolved.generated.billTemplateVersionId).toBe(v3Id);
      expect(draft.resolved.profileVersion).toBe(2);
      expect(draft.html).not.toContain("sec--notes");
      expect(draft.html).toContain(COMPANY_V2);
      expect(draft.html).toContain(ACCOUNT_V2);
      expect(draft.html).not.toContain(COMPANY_V1);
      // The v2 logo, inlined from its verified bytes. Handlebars escapes the
      // `=` padding in the attribute value (`&#x3D;`).
      const inlined = (logo: Buffer) =>
        `data:image/png;base64,${logo.toString("base64").replaceAll("=", "&#x3D;")}`;
      expect(draft.html).toContain(inlined(LOGO_V2));
      expect(draft.html).not.toContain(inlined(LOGO_V1));
    });

    it("the NEXT posting (account C) stamps profile v2", async () => {
      await fx.newRun(RUN_NEXT);
      const { banId: banNext } = await fx.postableBill({
        label: "C",
        runId: RUN_NEXT,
      });
      const result = await fx.post(RUN_NEXT, banNext);
      expect(result.status).toBe("invoiced");
      const [row] = await sql<{ ref_invoice_profile_version: number }[]>`
        SELECT ref_invoice_profile_version FROM billing.customer_bill
        WHERE ref_bill_run_id = ${RUN_NEXT} AND ref_billing_account_id = ${banNext}`;
      expect(row?.ref_invoice_profile_version).toBe(2);
    }, 120_000);
  },
);
