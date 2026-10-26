import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

// bm66-spec §6 (Inv #51 draft half, #53, #58 draft half; D55) — a draft
// PRO-FORMA renders the BAN's captured `bill_run_account` stamps, on a real
// database and a real Azurite:
//   1. capture, then activate a new generated version: the draft keeps the
//      captured version (its bound `template.version` and structure), while
//      the Standard live preview (`preview-family`) shows the new one;
//   2. an EXCLUDED account's draft is 404;
//   3. a BAN captured with a NULL version (its family has no ACTIVE version)
//      gets 422 `TEMPLATE_VERSION_NOT_FOUND` — never the default.
// The bills are fixture rows (no workflow engine here); the fixture captures
// each row with the real `captureTemplateStamps` (bm65), exactly as a trigger
// does. The route runs for real behind a mocked session (no Chromium is
// launched on the 404/422 paths).

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => ({ user: { id: "u" } })) } },
}));
vi.mock("@/auth/resolver", () => ({
  findActiveUserById: vi.fn(async () => ({ id: "u" })),
  resolveEffectivePermissions: vi.fn(async () => ({ billrun_view: "READ" })),
}));
vi.mock("@/lib/rate-limit", () => ({ isRateLimited: vi.fn(() => false) }));

import { GET as draftInvoiceRoute } from "@/app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { captureTemplateStamps } from "@/services/billing/capture-template-stamps";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { INVOICE_OPTIONAL_SECTION_KEYS } from "@/types/billing";
import { insertTemplateTypeFixture } from "@/tests/db/helpers/template-type-fixtures";

const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

// A well-formed id: the route validates `^BRN\d{8}$` before any read.
const RUN = "BRN06600001";
const STANDARD = "BTF00000001";
// bm72 — the footnote the mid-run activation introduces.
const NEW_FOOTNOTE_LINE = "Footnote activated mid-run (bm72)";

function routeCtx(runId: string, banId: string) {
  return { params: Promise.resolve({ runId, banId }) };
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm66 a draft renders the run's captured template (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    let actorId = "";
    let capturedBan = "";
    let newVersionId = "";
    let newVersionNo = 0;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The cleanup deletes template blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 5, onnotice: () => {} });
      fx = await setupInvoiceRenderFixtures(sql, "BM66");
      await seedInvoiceTemplates(fx.db);
      clearLoadedTemplateMemo();
      const [actor] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM core.appuser LIMIT 1`;
      actorId = actor!.user_id;

      // 1. Capture first: the BAN's row is stamped with the seeded default.
      await fx.newRun(RUN);
      ({ banId: capturedBan } = await fx.draftBill({
        label: "CAP",
        runId: RUN,
      }));

      // …then activate a new Standard version with a changed footnote (bm72).
      const structure = {
        sections: Object.fromEntries(
          INVOICE_OPTIONAL_SECTION_KEYS.map((k) => [k, true]),
        ),
        columns: {},
        footnote: [NEW_FOOTNOTE_LINE],
      } as Parameters<typeof saveTemplateDraft>[0]["structure"];
      const saved = await saveTemplateDraft(
        { structure, expectedDraftToken: null, familyId: "BTF00000001" },
        actorId,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      const activated = await activateTemplate(
        {
          draftId: saved.versionId,
          expectedDraftToken: saved.draftToken,
          changeNote: "bm66 mid-run activation",
          familyId: "BTF00000001",
        },
        actorId,
      );
      if (!activated.ok) throw new Error(`activate failed: ${activated.code}`);
      newVersionId = activated.versionId;
      newVersionNo = activated.versionNo;
      clearLoadedTemplateMemo();
    }, 240_000);

    afterAll(async () => {
      if (service) {
        const templates = service.getContainerClient("invoice-templates");
        for await (const b of templates.listBlobsFlat({
          prefix: "generated/INVOICE/v",
        })) {
          // Keep the seeded default (`v1/`); remove what this suite wrote.
          if (!b.name.startsWith("generated/INVOICE/v1/")) {
            await templates.deleteBlob(b.name).catch(() => undefined);
          }
        }
      }
      clearLoadedTemplateMemo();
      if (sql) {
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("1. after a mid-run activation the draft keeps the captured version; the Standard live preview shows the new one", async () => {
      const [stamp] = await sql<
        { ref_bill_template_version_id: string | null }[]
      >`
        SELECT ref_bill_template_version_id FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${capturedBan}`;
      expect(stamp?.ref_bill_template_version_id).toBe("BTV00000002");

      const draft = await buildInvoiceHtml({
        runId: RUN,
        banId: capturedBan,
        mode: "draft",
      });
      // The bound `template.version` comes from `resolved.generated`.
      expect(draft.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000002",
      );
      expect(draft.resolved.generated.versionNo).toBe(1);
      expect(draft.resolved.generated.versionNo).not.toBe(newVersionNo);
      // The captured v1 prints its own footnote, not the new version's.
      expect(draft.html).toContain("Calculations are done in Mbps");
      expect(draft.html).not.toContain(NEW_FOOTNOTE_LINE);

      const live = await resolveTemplate(fx.db, {
        kind: "preview-family",
        familyId: STANDARD,
      });
      expect(live.generated.billTemplateVersionId).toBe(newVersionId);
      expect(live.generated.versionNo).toBe(newVersionNo);
    }, 120_000);

    it("2. an EXCLUDED account's draft is 404 (never captured, never rendered)", async () => {
      const { banId } = await fx.draftBill({ label: "EXC", runId: RUN });
      await sql`
        UPDATE billing.bill_run_account
        SET status = 'EXCLUDED', error_code = 'PARTIAL_PERIOD',
            ref_bill_template_family_id = NULL, ref_bill_template_version_id = NULL,
            ref_invoice_profile_version = NULL, ref_csv_template_version_id = NULL,
            template_captured_at = NULL
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banId}`;

      const response = await draftInvoiceRoute(
        {} as never,
        routeCtx(RUN, banId),
      );
      expect(response.status).toBe(404);
    });

    it("3. a NULL-version capture (family with no ACTIVE version) is 422 TEMPLATE_VERSION_NOT_FOUND, never the default", async () => {
      // bm65 §8 case 3's fixture: a second, non-default family holding only a
      // RETIRED generated version, and a BAN bound to it by SQL.
      // bm74 — the type needs its own layout (btv_pair_same_type_fk).
      await insertTemplateTypeFixture(sql, {
        typeId: "BTF00000099",
        code: "BM66_EMPTY",
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
               ${"9".repeat(64)}, 'sha256', 'bm66 retired fixture', now(), now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      const { banId } = await fx.draftBill({ label: "NUL", runId: RUN });
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_family_id = 'BTF00000099'
        WHERE billing_account_id = ${banId}`;
      // Re-capture, as a rerun would: the family has no ACTIVE version.
      await captureTemplateStamps(fx.db, RUN, [banId], "2026-06-01");
      const [row] = await sql<
        {
          status: string;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
        }[]
      >`
        SELECT status, ref_bill_template_family_id, ref_bill_template_version_id
        FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${RUN} AND ref_billing_account_id = ${banId}`;
      expect(row).toMatchObject({
        status: "PROCESSED",
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: null,
      });

      await expect(
        buildInvoiceHtml({ runId: RUN, banId, mode: "draft" }),
      ).rejects.toMatchObject({
        code: "TEMPLATE_VERSION_NOT_FOUND",
        detail: {
          reason: "FAMILY_HAS_NO_ACTIVE_VERSION",
          familyId: "BTF00000099",
        },
      });

      const response = await draftInvoiceRoute(
        {} as never,
        routeCtx(RUN, banId),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "TEMPLATE_VERSION_NOT_FOUND" },
      });
    });
  },
);
