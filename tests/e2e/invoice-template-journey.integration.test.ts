import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import {
  dropAllSchemas,
  freshDatabase,
  purgeInvoiceBlobs,
  runScript,
} from "@/tests/e2e/helpers/fresh-database";
import { DEFAULT_BILL_CYCLE_NAME } from "@/db/seeds/accounts/seed-bill-cycles";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { parseInvoiceCsv } from "@/tests/helpers/parse-csv";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { decodablePng } from "@/tests/helpers/logo-fixtures";
import {
  runAggregation,
  runCollection,
  runVerification,
} from "@/tests/db/helpers/extract-flow-sql";
import type { InvoiceRenderFixtures } from "@/tests/db/helpers/invoice-render-fixtures";
import type * as ActivateProfileAction from "@/actions/billing/invoice-settings/activate-profile.action";
import type * as ActivateTemplateAction from "@/actions/billing/invoice-settings/activate-template.action";
import type * as SaveProfileDraftAction from "@/actions/billing/invoice-settings/save-profile-draft.action";
import type * as SaveTemplateDraftAction from "@/actions/billing/invoice-settings/save-template-draft.action";
import type * as UploadLogoAction from "@/actions/billing/invoice-settings/upload-logo.action";
import type * as StageCompleteRoute from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";
import type * as StoredInvoiceRoute from "@/app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/route";
import type * as CustomerBillLineRepo from "@/db/repositories/billing/customer-bill-line.repository";
import type * as ApproveRun from "@/services/billing/approve-run";
import type * as InvoiceCsv from "@/services/billing/invoice-template/invoice-csv";
import type * as Load from "@/services/billing/invoice-template/load";
import type * as MaterializeRuns from "@/services/billing/materialize-runs";
import type * as PostRun from "@/services/billing/post-run";
import type * as PostingProgress from "@/services/billing/read/get-posting-progress";
import type * as StoredInvoice from "@/services/billing/read/get-stored-invoice";
import type * as RenderInvoice from "@/services/billing/render-invoice";
import type * as RenderInvoiceTemplate from "@/services/billing/render-invoice-template";
import type * as TriggerRun from "@/services/billing/trigger-run";
import type * as RerunRun from "@/services/billing/rerun-run";
import type * as CaptureStamps from "@/services/billing/capture-template-stamps";
import type * as PreviewAction from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import type * as DraftInvoiceRoute from "@/app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route";
import type * as FlowDoubleFixtures from "@/tests/db/helpers/billrun-flow-double-fixtures";
import type * as PolygonFixtures from "@/tests/db/helpers/capacity-polygon-fixtures";
import { INVOICE_USAGE_ROW_LIMIT } from "@/types/billing";

// bm63-spec §Design D1 — the Invoice Template update's full journey on a FRESH
// database, the one proof no single unit owns (overview Part 2 success
// criteria 1, 2, 5, 6, 7, 8, 9, 10 and the audit half of 11):
//
//   1. fresh setup — the real `db:migrate`, role bootstraps and `db:setup`
//      scripts (incl. `db:seed-invoice-templates`), run as child processes
//      against the throwaway Postgres + Azurite (never `.env`);
//   2. no admin activity — the `_SAMPLE_` `ci` seed processed app-side (the
//      flow's own extracted Collection/Aggregation/Verification SQL, stage
//      signals through the real M2M route), approved by a second user and
//      posted: every account renders from the default, with no issuer or
//      payment block;
//   3. template v2 + profile v1 activated through the SERVER ACTIONS (real
//      `requirePermission`; only the session is faked), then the next run
//      posts under them;
//   4. template v3 + profile v2 activated: the step-3 bill is unchanged
//      (stamps, stored PDF bytes, reprint, `charge_checksum`), a new draft
//      preview uses v3 + profile v2;
//   5. tamper: one byte of v3's `invoice.hbs`, then of the v2 logo — the
//      affected renders park with the typed code, other versions still render;
//   6. CSV of a step-3 bill sums to its subtotal;
//   7. multi-page mechanics: the page footer, repeated header and fixed
//      watermark (bm71 retired the usage-annex half of this step: the
//      per-polygon detail pages, their 10,000-row bound and the
//      ~900-polygon pagination are proven by
//      tests/db/invoice-capacity-detail.integration.test.ts,
//      tests/services/billing/invoice-golden.test.ts and the
//      RUN_CHROMIUM_E2E render);
//   8. audit: one AUDIT_LOG row per save, upload and activation.
//
// No live Kestra is needed: Part 2 changes no flow (workflow rules §1.7), and
// the processing legs are the flow's own SQL (bm40 harness). Runs 2–4 are
// posted through the real `postAccount` on bills built by the bm53/bm54 render
// fixtures (`reset: false`), because the `ci` seed only has one due period.
// Requires DATABASE_URL + BOOTSTRAP_DATABASE_URL + BILLRUN_BLOB_CONNECTION_STRING
// (the throwaway Azurite) + Playwright Chromium.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;
const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;

const SERVICE_TOKEN = "bm63-journey-service-token-".padEnd(40, "x");
const ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? "";

// Fixture runs (BRN + 8 digits, so the session-guarded routes parse them).
const RUN_V2 = "BRN09063001";
const RUN_DRAFT = "BRN09063002";
const RUN_V3 = "BRN09063003";
const RUN_PAGES = "BRN09063004";

const COMPANY_V1 = "Journey Profile One Sdn Bhd";
const COMPANY_V2 = "Journey Profile Two Sdn Bhd";
const ACCOUNT_V2 = "8888-7777-6666";
const LOGO_V1 = decodablePng(320, 320, 0x30);
const LOGO_V2 = decodablePng(340, 340, 0xc0);

// Modules imported after the environment is final (lib/config reads
// BILLRUN_APP_TOKEN at import).
type Services = Pick<typeof MaterializeRuns, "materializeDueRuns"> &
  Pick<typeof TriggerRun, "triggerRun"> &
  Pick<typeof ApproveRun, "approveRun"> &
  Pick<typeof PostRun, "postRun" | "retryRenderInvoice"> &
  Pick<typeof StoredInvoice, "getStoredInvoice"> &
  Pick<typeof PostingProgress, "getPostingProgress"> &
  Pick<typeof RenderInvoiceTemplate, "buildInvoiceHtml"> &
  Pick<typeof RenderInvoice, "renderDraftInvoice"> &
  Pick<typeof InvoiceCsv, "getPostedInvoiceCsv"> &
  Pick<typeof Load, "clearLoadedTemplateMemo"> &
  Pick<typeof SaveTemplateDraftAction, "saveTemplateDraftAction"> &
  Pick<typeof ActivateTemplateAction, "activateTemplateAction"> &
  Pick<typeof SaveProfileDraftAction, "saveProfileDraftAction"> &
  Pick<typeof UploadLogoAction, "uploadLogoAction"> &
  Pick<typeof ActivateProfileAction, "activateProfileAction"> & {
    computeChargeChecksum: (typeof CustomerBillLineRepo)["customerBillLineRepository"]["computeChargeChecksum"];
    stageComplete: (typeof StageCompleteRoute)["POST"];
    storedInvoiceGet: (typeof StoredInvoiceRoute)["GET"];
  };

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () =>
        session.userId ? { user: { id: session.userId } } : null,
      ),
    },
  },
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// One account's five processing stages as the flow runs them: the flow's own
// extracted Collection/Aggregation/Verification SQL, each stage signalled
// through the real M2M route (taxation is a no-op in the flow).
async function processAccountOnFlowSql(
  sql: postgresjs.Sql,
  signal: (
    stage: string,
    ban: string,
    attempt: number,
  ) => Promise<{ status: number }>,
  run: {
    bill_run_id: string;
    period_start: string;
    period_end: string;
    scheduled_run_date: string;
  },
  ban: string,
  attempt: number,
): Promise<void> {
  const runId = run.bill_run_id;
  expect((await signal("validation", ban, attempt)).status).toBe(200);
  await runCollection(sql, { runId, ban, attempt });
  expect((await signal("collection", ban, attempt)).status).toBe(200);
  await runAggregation(sql, {
    runId,
    ban,
    attempt,
    periodStart: run.period_start,
    periodEnd: run.period_end,
    glEventAt: run.scheduled_run_date,
  });
  expect((await signal("aggregation", ban, attempt)).status).toBe(200);
  expect((await signal("taxation", ban, attempt)).status).toBe(200);
  await runVerification(sql, { runId, ban, attempt });
  expect((await signal("verification", ban, attempt)).status).toBe(200);
}

// Chromium PDFs write one `/Type /Page` dictionary per page.
function pdfPageCount(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? [])
    .length;
}

// bm72 — versions differ by their footnote (Notes & terms is gone).
const FOOTNOTE_V2 = "Journey footnote v2";
const FOOTNOTE_V3 = "Journey footnote v3";
function structure(footnoteLine: string) {
  return {
    sections: { payment: true },
    columns: {},
    footnote: [footnoteLine],
  };
}

function profileFields(companyName: string): Record<string, string> {
  return {
    company_name: companyName,
    registration_no: "202001000063",
    tin: "C12345678901",
    address_line1: "Level 63, Menara Journey",
    postcode: "50450",
    city: "Kuala Lumpur",
    state_code: "14",
    phone: "+60 3-2000 0063",
    email: "billing@journey.example",
    brand_color: "#2E45A9",
    accent_color: "#006975",
    bank_name: "Maybank Berhad",
    bank_account_name: companyName,
    bank_account_no: "5140-1234-5678",
    swift: "MBBEMYKL",
    remittance_email: "ar@journey.example",
    payment_terms_days: "30",
  };
}

describe.skipIf(!databaseUrl || !blobConnection || !bootstrapUrl)(
  "bm63 D1 — the Invoice Template journey on a fresh database",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;

    let svc: Services;

    let adminId = "";
    let approverId = "";
    let ciRunId = "";
    let ciPosted: string[] = [];
    let v2Id = "";
    let v3Id = "";
    let profileV2LogoRef = "";
    let banA = "";
    let banTwin = "";
    let banC = "";

    async function stageSignal(
      runId: string,
      stage: string,
      ban: string,
      attempt: number,
    ): Promise<{ status: number; data: unknown }> {
      const response = await svc.stageComplete(
        new Request(
          `http://localhost/api/billrun/${runId}/stage/${stage}/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${SERVICE_TOKEN}`,
            },
            body: JSON.stringify({ ban_id: ban, attempt, status: "DONE" }),
          },
        ),
        { params: Promise.resolve({ runId, stage }) },
      );
      return { status: response.status, data: await response.json() };
    }

    function blobClient(blobRef: string) {
      const slash = blobRef.indexOf("/");
      return service!
        .getContainerClient(blobRef.slice(0, slash))
        .getBlockBlobClient(blobRef.slice(slash + 1));
    }

    // Overwrites one byte of a stored blob and returns the original bytes.
    async function tamper(blobRef: string): Promise<Buffer> {
      const client = blobClient(blobRef);
      const original = await client.downloadToBuffer();
      const tampered = Buffer.from(original);
      tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
      await client.uploadData(tampered);
      return original;
    }

    async function storedRow(runId: string, banId: string) {
      const [row] = await sql<{ blob_ref: string }[]>`
        SELECT blob_ref FROM billing.bill_run_invoices
        WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
      return row;
    }

    async function stamps(runId: string, banId: string) {
      const [row] = await sql<
        {
          ref_bill_format_id: string | null;
          ref_bill_template_version_id: string | null;
          ref_invoice_profile_version: number | null;
          ref_csv_template_version_id: string | null;
          charge_checksum: string | null;
          customer_bill_id: string;
          period_partition: string;
          subtotal: string;
        }[]
      >`
        SELECT ref_bill_format_id, ref_bill_template_version_id,
               ref_invoice_profile_version, ref_csv_template_version_id,
               charge_checksum, customer_bill_id, period_partition::text,
               subtotal::text
        FROM billing.customer_bill
        WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
      return row!;
    }

    async function activateTemplate(footnoteLine: string, note: string) {
      const saved = await svc.saveTemplateDraftAction({
        structure: structure(footnoteLine),
        expectedDraftToken: null,
      });
      if (!saved.ok) throw new Error(`save draft: ${saved.code}`);
      const activated = await svc.activateTemplateAction({
        draftId: saved.versionId,
        expectedDraftToken: saved.draftToken,
        changeNote: note,
      });
      if (!activated.ok) throw new Error(`activate: ${activated.code}`);
      svc.clearLoadedTemplateMemo();
      return activated;
    }

    async function activateProfile(
      fields: Record<string, string>,
      logo: Buffer,
      note: string,
    ) {
      const saved = await svc.saveProfileDraftAction({
        fields,
        expectedDraftToken: null,
      });
      if (!saved.ok) throw new Error(`save profile: ${saved.code}`);
      const form = new FormData();
      form.set(
        "file",
        new File([new Uint8Array(logo)], "logo.png", { type: "image/png" }),
      );
      form.set("expectedDraftToken", saved.draftToken);
      const uploaded = await svc.uploadLogoAction(form);
      if (!uploaded.ok) throw new Error(`upload: ${JSON.stringify(uploaded)}`);
      const activated = await svc.activateProfileAction({
        configVersion: saved.versionNo,
        expectedDraftToken: uploaded.draftToken,
        changeNote: note,
      });
      if (!activated.ok) throw new Error(`activate profile: ${activated.code}`);
      return { ...activated, assetVersionId: uploaded.assetVersionId };
    }

    // A posted fixture bill whose single line is a (non-capacity) USAGE line rated at
    // `rows` × 1.00, plus `rows` billed `udr_rated` rows (state → district,
    // every 7th row with no geo) claimed for the run/account/attempt 1.
    async function usageBill(runId: string, label: string, rows: number) {
      const { banId, customerBillId } = await fx.postableBill({
        label,
        runId,
      });
      const total = `${rows}.00`;
      await sql`DELETE FROM billing.customer_bill_line
                WHERE ref_customer_bill_id = ${customerBillId}`;
      await sql`
        INSERT INTO billing.customer_bill_line
          (ref_customer_bill_id, period_partition, line_no, source,
           ref_product_offering_id, udr_type, gross_amount, discount_amount,
           net_amount, rated_amount, grouping_key, currency, description,
           quantity, unit)
        VALUES (${customerBillId}, '2026-06-01', 1, 'USAGE', 'POF-BM63',
                'RAN_USAGE', ${total}, '0.00', ${total}, ${total},
                'POF-BM63:RAN_USAGE', 'MYR', 'RAN usage', ${`${rows}.000000`}, 'EA')`;
      await sql`
        UPDATE billing.customer_bill SET subtotal = ${total}, total_amount = ${total}
        WHERE customer_bill_id = ${customerBillId}`;
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw, udr_rounding_mode,
           udr_currency, udr_ref_batch_id, udr_source_file, rating_engine_version,
           rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
           billrun_checksum, upsert_datetime, state, district)
        SELECT
          rating.period_of('2026-06-10T00:00:00Z'::timestamptz), 'RAN_USAGE',
          '2026-06-10T00:00:00Z'::timestamptz, '2026-06-10T00:00:00Z'::timestamptz,
          'BILL_DRAFT', '_bm63-sub',
          'commercial_unit=cu-bm63|mno_public_id=mno-bm63|polygon_id=' || ${label.toLowerCase()} || '-' || g.i,
          '1.000000', 'EA', 'PER_UNIT', '1.00', '1.00', 'HALF_UP', 'MYR',
          '_BM63_BATCH', '_BM63', '_BM63', 0, ${runId}, ${banId}, 1, 'bm63',
          now(),
          CASE WHEN g.i % 7 = 0 THEN NULL ELSE 'State-' || (g.i % 3) END,
          CASE WHEN g.i % 7 = 0 THEN NULL ELSE 'District-' || (g.i % 5) END
        FROM generate_series(1, ${rows}) AS g(i)`;
      return { banId, customerBillId };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The setup deletes blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      process.env.BILLRUN_APP_TOKEN = SERVICE_TOKEN;
      sql = postgres(databaseUrl as string, { max: 5 });

      // ── Step 1: a fresh database through the real setup scripts.
      await freshDatabase(sql, service!);
      runScript("db/seeds/sample/seed-billrun-sample.ts", {
        SAMPLE_SEED_PROFILE: "ci",
      });

      svc = {
        ...(await import("@/services/billing/materialize-runs")),
        ...(await import("@/services/billing/trigger-run")),
        ...(await import("@/services/billing/approve-run")),
        ...(await import("@/services/billing/post-run")),
        ...(await import("@/services/billing/read/get-stored-invoice")),
        ...(await import("@/services/billing/read/get-posting-progress")),
        ...(await import("@/services/billing/render-invoice-template")),
        ...(await import("@/services/billing/render-invoice")),
        ...(await import("@/services/billing/invoice-template/invoice-csv")),
        ...(await import("@/services/billing/invoice-template/load")),
        computeChargeChecksum: (
          await import("@/db/repositories/billing/customer-bill-line.repository")
        ).customerBillLineRepository.computeChargeChecksum,
        stageComplete: (
          await import("@/app/api/billrun/[runId]/stage/[stage]/complete/route")
        ).POST,
        storedInvoiceGet: (
          await import("@/app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/route")
        ).GET,
        ...(await import("@/actions/billing/invoice-settings/save-template-draft.action")),
        ...(await import("@/actions/billing/invoice-settings/activate-template.action")),
        ...(await import("@/actions/billing/invoice-settings/save-profile-draft.action")),
        ...(await import("@/actions/billing/invoice-settings/upload-logo.action")),
        ...(await import("@/actions/billing/invoice-settings/activate-profile.action")),
      };
      svc.clearLoadedTemplateMemo();

      const [admin] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM core.appuser WHERE user_email = ${ADMIN_EMAIL}`;
      adminId = admin!.user_id;
      session.userId = adminId;
      approverId = crypto.randomUUID();
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${approverId}, 'BM63 Approver', 'bm63-approver@example.invalid', 'LOCAL', 'ACTIVE')`;

      const { setupInvoiceRenderFixtures } =
        await import("@/tests/db/helpers/invoice-render-fixtures");
      fx = await setupInvoiceRenderFixtures(sql, "BM63", { reset: false });
    }, 900_000);

    afterAll(async () => {
      svc?.clearLoadedTemplateMemo();
      if (service) await purgeInvoiceBlobs(service).catch(() => undefined);
      if (sql) {
        await dropAllSchemas(sql).catch(() => undefined);
        await sql.end();
      }
    }, 120_000);

    it("step 1 — fresh setup: one bill format, ACTIVE defaults, seed blobs verify (criterion 2)", async () => {
      const formats = await sql<{ bill_format_id: string }[]>`
        SELECT bill_format_id FROM billing.bill_format`;
      expect(formats.map((f) => f.bill_format_id)).toEqual(["INVOICE"]);
      const defaults = await sql<
        { bill_template_version_id: string; kind: string; status: string }[]
      >`
        SELECT bill_template_version_id, kind, status
        FROM billing.bill_template_version WHERE is_default ORDER BY kind`;
      expect(defaults).toEqual([
        {
          bill_template_version_id: "BTV00000003",
          kind: "csv",
          status: "ACTIVE",
        },
        {
          bill_template_version_id: "BTV00000002",
          kind: "generated",
          status: "ACTIVE",
        },
        {
          bill_template_version_id: "BTV00000001",
          kind: "layout",
          status: "ACTIVE",
        },
      ]);
      const { loadGenerated, loadCsvMap, loadLayout } =
        await import("@/services/billing/invoice-template/load");
      const rows = await sql<{ bill_template_version_id: string }[]>`
        SELECT bill_template_version_id FROM billing.bill_template_version
        ORDER BY bill_template_version_id`;
      const { billTemplateVersionRepository } =
        await import("@/db/repositories/billing/bill-template-version");
      const { db } = await import("@/db/client");
      for (const { bill_template_version_id: id } of rows) {
        const row = (await billTemplateVersionRepository.findById(db, id))!;
        if (row.kind === "generated") await loadGenerated(row);
        if (row.kind === "csv") await loadCsvMap(row);
        if (row.kind === "layout") await loadLayout(row);
      }
    });

    it("step 2 — no admin activity: the ci run posts and every account renders from the default with no issuer or payment block (criteria 1, 8)", async () => {
      await svc.materializeDueRuns();
      const [run] = await sql<
        {
          bill_run_id: string;
          period_start: string;
          period_end: string;
          scheduled_run_date: string;
        }[]
      >`
        SELECT r.bill_run_id, r.period_start::text, r.period_end::text,
               r.scheduled_run_date::text
        FROM billing.bill_run r
        JOIN billing.bill_cycle c ON c.bill_cycle_id = r.ref_bill_cycle_id
        WHERE r.status = 'SCHEDULED' AND c.name = ${DEFAULT_BILL_CYCLE_NAME}`;
      // The `ci` seed's cycle only: the render fixtures' own active cycle also
      // materializes a (empty) SCHEDULED run.
      expect(run).toBeDefined();
      ciRunId = run!.bill_run_id;
      const triggered = await svc.triggerRun(
        ciRunId,
        adminId,
        run!.scheduled_run_date,
      );
      expect(triggered.ok).toBe(true);

      const scoped = await sql<
        { ref_billing_account_id: string; status: string }[]
      >`
        SELECT ref_billing_account_id, status FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${ciRunId} ORDER BY ref_billing_account_id`;
      for (const { ref_billing_account_id: ban, status } of scoped) {
        if (status !== "PENDING") continue;
        await processAccountOnFlowSql(
          sql,
          (stage, b, attempt) => stageSignal(ciRunId, stage, b, attempt),
          run!,
          ban,
          1,
        );
      }

      const approved = await svc.approveRun(ciRunId, approverId);
      expect(approved.ok).toBe(true);
      const posted = await svc.postRun(ciRunId, approverId);
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      ciPosted = posted.value.results
        .filter((r) => r.result.status === "invoiced")
        .map((r) => r.billingAccountId);
      // The ci seed's four billable scenarios (the bm38 live run posted the
      // same four INV documents).
      expect(ciPosted).toHaveLength(4);

      for (const ban of ciPosted) {
        // Rendered and stored from the default, never parked.
        expect(await storedRow(ciRunId, ban)).toBeDefined();
        const s = await stamps(ciRunId, ban);
        expect(s).toMatchObject({
          ref_bill_format_id: "INVOICE",
          ref_bill_template_version_id: "BTV00000002",
          ref_invoice_profile_version: null,
          ref_csv_template_version_id: "BTV00000003",
        });
        // Σ net_amount = subtotal, compared as SQL text (criterion 1).
        const [sum] = await sql<{ net: string; n: number }[]>`
          SELECT COALESCE(SUM(net_amount), 0)::numeric(18,2)::text AS net,
                 count(*) FILTER (WHERE line_type = 'charge')::int AS n
          FROM billing.customer_bill_line
          WHERE ref_customer_bill_id = ${s.customer_bill_id}`;
        expect(sum!.net).toBe(s.subtotal);

        const { html } = await svc.buildInvoiceHtml({
          runId: ciRunId,
          banId: ban,
          mode: "final",
        });
        // The ci seed bills no capacity line, so every charge line is an
        // "Other charges" row and no detail page prints (bm70/bm71).
        const otherRows = (html.match(/<div class="svc-row"><span>/g) ?? [])
          .length;
        expect(otherRows).toBe(sum!.n);
        expect(html).not.toContain('class="detail-type"');
        // G15 A — no issuer or payment block without a profile.
        expect(html).not.toContain("sec--payment");
        expect(html).not.toContain('class="issuer"');
      }
      // bm71 — the State-District labels ("Unassigned region" included)
      // are proven by tests/db/invoice-capacity-detail.integration.test.ts.
    }, 600_000);

    it("step 3 — template v2 + profile v1 through the actions; the next run is stamped v2 / profile 1", async () => {
      ({ versionId: v2Id } = await activateTemplate(FOOTNOTE_V2, "journey v2"));
      const profile1 = await activateProfile(
        profileFields(COMPANY_V1),
        LOGO_V1,
        "journey profile v1",
      );
      expect(profile1.configVersion).toBe(1);

      await fx.newRun(RUN_V2);
      ({ banId: banA } = await fx.postableBill({ label: "A", runId: RUN_V2 }));
      ({ banId: banTwin } = await fx.postableBill({
        label: "TWIN",
        runId: RUN_V2,
      }));
      for (const ban of [banA, banTwin]) {
        expect((await fx.post(RUN_V2, ban)).status).toBe("invoiced");
        expect(await stamps(RUN_V2, ban)).toMatchObject({
          ref_bill_template_version_id: v2Id,
          ref_invoice_profile_version: 1,
          ref_csv_template_version_id: "BTV00000003",
        });
        expect(await storedRow(RUN_V2, ban)).toBeDefined();
      }

      // Park the twin (test-only: drop its stored artifact) so step 5 can
      // re-render it under its v2 stamps.
      const twin = await storedRow(RUN_V2, banTwin);
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`DELETE FROM billing.bill_run_invoices
                 WHERE ref_bill_run_id = ${RUN_V2} AND ref_billing_account_id = ${banTwin}`;
      });
      await blobClient(twin!.blob_ref).delete();
    }, 300_000);

    it("step 4 — template v3 + profile v2: the step-3 bill is unchanged, reprint is byte-identical, a new draft uses v3 + profile v2 (criteria 5, 10)", async () => {
      const before = await stamps(RUN_V2, banA);
      const storedBefore = await svc.getStoredInvoice(RUN_V2, banA);

      ({ versionId: v3Id } = await activateTemplate(FOOTNOTE_V3, "journey v3"));
      const profile2 = await activateProfile(
        { ...profileFields(COMPANY_V2), bank_account_no: ACCOUNT_V2 },
        LOGO_V2,
        "journey profile v2",
      );
      expect(profile2.configVersion).toBe(2);
      const [logo] = await sql<{ blob_ref: string }[]>`
        SELECT blob_ref FROM billing.bill_asset_version
        WHERE bill_asset_version_id = ${profile2.assetVersionId}`;
      profileV2LogoRef = logo!.blob_ref;

      expect(await stamps(RUN_V2, banA)).toEqual(before);
      const storedAfter = await svc.getStoredInvoice(RUN_V2, banA);
      expect(storedAfter.pdf.equals(storedBefore.pdf)).toBe(true);

      // Reprint through the session-guarded route: the stored bytes.
      const reprint = await svc.storedInvoiceGet({} as never, {
        params: Promise.resolve({ runId: RUN_V2, banId: banA }),
      });
      expect(reprint.status).toBe(200);
      expect(
        Buffer.from(await reprint.arrayBuffer()).equals(storedBefore.pdf),
      ).toBe(true);

      // Criterion 10 — charge_checksum recomputes equal from the lines.
      const { db } = await import("@/db/client");
      expect(
        await svc.computeChargeChecksum(
          db,
          before.customer_bill_id,
          before.period_partition,
        ),
      ).toBe(before.charge_checksum);

      // A new draft preview uses v3 (its footnote) and profile v2.
      await fx.newRun(RUN_DRAFT);
      const { banId: banDraft } = await fx.draftBill({
        label: "DRAFT",
        runId: RUN_DRAFT,
      });
      const draft = await svc.buildInvoiceHtml({
        runId: RUN_DRAFT,
        banId: banDraft,
        mode: "draft",
      });
      expect(draft.resolved.generated.billTemplateVersionId).toBe(v3Id);
      expect(draft.html).toContain(FOOTNOTE_V3);
      expect(draft.html).not.toContain(FOOTNOTE_V2);
      expect(draft.html).toContain(COMPANY_V2);
      expect(draft.html).toContain(ACCOUNT_V2);
      expect(draft.html).not.toContain(COMPANY_V1);
    }, 300_000);

    it("step 5 — tamper: v3's invoice.hbs and then the v2 logo park their renders with the typed code; v2 still renders (criterion 6)", async () => {
      const [v3] = await sql<{ blob_ref: string }[]>`
        SELECT blob_ref FROM billing.bill_template_version
        WHERE bill_template_version_id = ${v3Id}`;
      const hbsRef = `${v3!.blob_ref.replace(/\/?$/, "/")}invoice.hbs`;
      // Every tamper is undone in a `finally`: step 7 posts under v3 + the
      // profile-v2 logo, so a failure here must not leave them corrupted.
      const originalHbs = await tamper(hbsRef);
      try {
        svc.clearLoadedTemplateMemo();

        await fx.newRun(RUN_V3);
        ({ banId: banC } = await fx.postableBill({
          label: "C",
          runId: RUN_V3,
        }));
        expect((await fx.post(RUN_V3, banC)).status).toBe("invoiced");
        expect(await stamps(RUN_V3, banC)).toMatchObject({
          ref_bill_template_version_id: v3Id,
          ref_invoice_profile_version: 2,
        });
        // Parked: posted, no stored PDF, on the exception surface.
        expect(await storedRow(RUN_V3, banC)).toBeUndefined();
        const progress = await svc.getPostingProgress(RUN_V3);
        expect(
          progress!.rows.find((r) => r.billingAccountId === banC),
        ).toMatchObject({ status: "invoiced", hasStoredInvoice: false });
        expect(await svc.retryRenderInvoice(RUN_V3, banC)).toEqual({
          ok: false,
          code: "RENDER_FAILED",
          detail: "TEMPLATE_CHECKSUM_MISMATCH",
        });

        // The twin is pinned to v2 + profile v1: it still renders.
        const twin = await svc.retryRenderInvoice(RUN_V2, banTwin);
        expect(twin.ok).toBe(true);
      } finally {
        await blobClient(hbsRef).uploadData(originalHbs);
        svc.clearLoadedTemplateMemo();
      }

      // The template is restored; tamper the profile-v2 logo instead.
      const originalLogo = await tamper(profileV2LogoRef);
      try {
        expect(await svc.retryRenderInvoice(RUN_V3, banC)).toEqual({
          ok: false,
          code: "RENDER_FAILED",
          detail: "ASSET_CHECKSUM_MISMATCH",
        });
      } finally {
        await blobClient(profileV2LogoRef).uploadData(originalLogo);
      }
      // Both restored: C renders.
      expect((await svc.retryRenderInvoice(RUN_V3, banC)).ok).toBe(true);
    }, 300_000);

    it("step 6 — the CSV of a step-3 bill has one row per line and sums to its subtotal (criterion 9)", async () => {
      const s = await stamps(RUN_V2, banA);
      const { csv } = await svc.getPostedInvoiceCsv({
        runId: RUN_V2,
        banId: banA,
      });
      // RFC 4180 (quoted commas in names/descriptions), never a raw split.
      const [header, ...rows] = parseInvoiceCsv(csv);
      const [lines] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${s.customer_bill_id}`;
      expect(rows).toHaveLength(lines!.n);
      const col = header!.indexOf("net_amount");
      const [sum] = await sql<{ total: string }[]>`
        SELECT SUM(v::numeric)::text AS total
        FROM unnest(${rows.map((r) => r[col]!)}::text[]) AS v`;
      expect(sum!.total).toBe(s.subtotal);
    });

    it("step 7 — the page footer, repeated header and fixed watermark on a posted and a draft bill (criterion 7)", async () => {
      // bm71 — a non-capacity usage line prints no detail page; the
      // ~900-polygon pagination, the 10,000-row bound and the over-limit
      // park are proven by invoice-capacity-detail.integration.test.ts,
      // invoice-golden.test.ts (guardrail 64) and the Chromium e2e.
      await fx.newRun(RUN_PAGES);
      const { banId: banPages } = await usageBill(RUN_PAGES, "PAGES", 10);
      expect((await fx.post(RUN_PAGES, banPages)).status).toBe("invoiced");
      const stored = await svc.getStoredInvoice(RUN_PAGES, banPages);
      expect(pdfPageCount(stored.pdf)).toBeGreaterThanOrEqual(1);

      const final = await svc.buildInvoiceHtml({
        runId: RUN_PAGES,
        banId: banPages,
        mode: "final",
      });
      // "Page X of Y" on every page, bottom-right: Chromium's footer
      // template, filled per page from these spans (R5), with the
      // header/footer band enabled.
      expect(final.pageSetup.displayHeaderFooter).toBe(true);
      expect(final.footerHtml).toMatch(
        /<span style="text-align: right;">Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/,
      );
      expect(final.html).toContain("thead { display: table-header-group; }");
      expect(final.html).toContain("tr { break-inside: avoid; }");

      // The watermark is a fixed full-page layer inside the body (never in
      // the footer margin).
      const { banId: banDraftPages } = await usageBill(
        RUN_PAGES,
        "PAGESDRAFT",
        10,
      );
      const draftPdf = await svc.renderDraftInvoice({
        runId: RUN_PAGES,
        banId: banDraftPages,
      });
      expect(pdfPageCount(draftPdf)).toBeGreaterThanOrEqual(1);
      const draft = await svc.buildInvoiceHtml({
        runId: RUN_PAGES,
        banId: banDraftPages,
        mode: "draft",
      });
      expect(draft.html).toMatch(
        /\.watermark \{\s*position: fixed;\s*inset: 0;/,
      );
      const body = draft.html.slice(draft.html.indexOf("<body"));
      expect(body).toContain('class="watermark"');
      expect(draft.footerHtml).not.toContain("watermark");
    }, 600_000);

    it("step 8 — every save, upload and activation wrote exactly one AUDIT_LOG row of its type (criterion 11)", async () => {
      const counts = await sql<{ event_type: string; n: number }[]>`
        SELECT event_type, count(*)::int AS n FROM core.audit_log
        WHERE event_type LIKE 'INVOICE_%'
        GROUP BY event_type ORDER BY event_type`;
      expect(
        Object.fromEntries(counts.map((c) => [c.event_type, c.n])),
      ).toEqual({
        INVOICE_LOGO_UPLOADED: 2,
        INVOICE_PROFILE_ACTIVATED: 2,
        INVOICE_PROFILE_DRAFT_SAVED: 2,
        INVOICE_TEMPLATE_ACTIVATED: 2,
        INVOICE_TEMPLATE_DRAFT_SAVED: 2,
      });
    });
  },
);

// bm73-spec §Design "The journey" — Invoice Template Phase 3 (the bill run
// uses the BAN's template) on its own FRESH database, steps 1–6 and 8 (step
// 7, the SFTP/loopback hop, stays with the distribution suites and the manual
// run on the owner's data):
//
//   1. trigger the `ci` run: every non-EXCLUDED BAN is stamped with the
//      Standard family + its ACTIVE version, and the trigger audit lists the
//      stamps (criterion 1);
//   2. drafts for every BAN render page 1 and the last page; a ~900-polygon
//      BAN paginates its detail pages with the group label and column header
//      repeated in each `thead`, and "Page X of Y" bottom-right (criteria 5,
//      7, 8, 10);
//   3. an Admin edits footnote line 2 → preview → save draft → Activate: a
//      new version on v1's layout; the default v1 stays ACTIVE (criterion 11);
//   4. the drafts still print the old footnote: the run is frozen
//      (criterion 2);
//   5. rerun one BAN with a reason: only it re-captures, the rerun audit
//      lists it, and its draft prints the new footnote (criterion 3);
//   6. a newer version is activated, then a second user approves and the run
//      posts: every bill's stamps equal its run stamps plus the family, and
//      each stored PDF exists for the version it was frozen on — never the
//      live ACTIVE one (criteria 2, 4);
//   8. negative fixtures, each on its own fixture run: a NULL family version
//      (draft 422, posting SKIPPED with no INV), a negative Utilised, missing
//      polygon data and 10,001 detail rows each fail loud with their code
//      (criteria 6, 9); then the NULL-version recovery: an ACTIVE version in
//      that family plus a rerun bills the BAN (Inv #58, criterion 1).
//
// The ~900-polygon and negative capacity BANs are built by
// `tests/db/helpers/capacity-polygon-fixtures.ts` on fixture runs (the `ci`
// seed bills no capacity line) and captured with the real
// `captureTemplateStamps`, as a trigger does.
// invoice-render-fixtures.ts FIXTURE_PERIOD_START/END (not imported: that
// module loads lib/config before BILLRUN_APP_TOKEN is set).
const FIXTURE_PERIOD_START = "2026-06-01";
const FIXTURE_PERIOD_END = "2026-06-30";
const PHASE3_RUN_NULL = "BRN09073801";
const PHASE3_EDITED_LINE_2 = "Journey: billed inclusive of USP from this run";
const PHASE3_LINE_V3 = "Journey: activated after the rerun";

interface Phase3Run {
  bill_run_id: string;
  period_start: string;
  period_end: string;
  scheduled_run_date: string;
}

describe.skipIf(!databaseUrl || !blobConnection || !bootstrapUrl)(
  "bm73 — the Invoice Template Phase 3 journey on a fresh database",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    let svc: Services;
    let rerunRun: (typeof RerunRun)["rerunRun"];
    let previewAction: (typeof PreviewAction)["previewInvoiceTemplateAction"];
    let draftRoute: (typeof DraftInvoiceRoute)["GET"];
    let capture: (typeof CaptureStamps)["captureTemplateStamps"];
    let polygonFx: ReturnType<
      (typeof PolygonFixtures)["createCapacityPolygonFixtures"]
    >;
    let flowDouble: () => ReturnType<
      (typeof FlowDoubleFixtures)["createFlowDoubleFixtures"]
    >;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;

    let adminId = "";
    let approverId = "";
    let run: Phase3Run;
    let processed: string[] = [];
    let rerunBan = "";
    let v2Id = "";
    let v3Id = "";
    let polyRunId = "";
    let polyBan = "";
    let seededFootnote: readonly string[] = [];

    async function signal(
      stage: string,
      ban: string,
      attempt: number,
    ): Promise<{ status: number }> {
      const response = await svc.stageComplete(
        new Request(
          `http://localhost/api/billrun/${run.bill_run_id}/stage/${stage}/complete`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${SERVICE_TOKEN}`,
            },
            body: JSON.stringify({ ban_id: ban, attempt, status: "DONE" }),
          },
        ),
        { params: Promise.resolve({ runId: run.bill_run_id, stage }) },
      );
      return { status: response.status };
    }

    async function runStamps(runId: string) {
      const rows = await sql<
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
               ref_csv_template_version_id, template_captured_at::text
        FROM billing.bill_run_account
        WHERE ref_bill_run_id = ${runId} ORDER BY ref_billing_account_id`;
      return new Map(rows.map((r) => [r.ref_billing_account_id, r]));
    }

    async function runStatus(runId: string): Promise<string | undefined> {
      const [row] = await sql<{ status: string }[]>`
        SELECT status FROM billing.bill_run WHERE bill_run_id = ${runId}`;
      return row?.status;
    }

    async function auditAfterData(eventType: string, runId: string) {
      const [row] = await sql<{ after_data: Record<string, unknown> }[]>`
        SELECT after_data FROM core.audit_log
        WHERE event_type = ${eventType} AND target_id = ${runId}
        ORDER BY created_datetime DESC LIMIT 1`;
      return row?.after_data;
    }

    function draftHtml(runId: string, banId: string) {
      return svc.buildInvoiceHtml({ runId, banId, mode: "draft" });
    }

    function editedStructure(line2: string) {
      return {
        sections: { payment: true },
        columns: {},
        footnote: [seededFootnote[0]!, line2],
      };
    }

    // Edits footnote line 2 through the server actions and activates it.
    async function activateFootnote(
      line2: string,
      note: string,
    ): Promise<string> {
      const saved = await svc.saveTemplateDraftAction({
        structure: editedStructure(line2),
        expectedDraftToken: null,
      });
      if (!saved.ok) throw new Error(`save draft: ${saved.code}`);
      const activated = await svc.activateTemplateAction({
        draftId: saved.versionId,
        expectedDraftToken: saved.draftToken,
        changeNote: note,
      });
      if (!activated.ok) throw new Error(`activate: ${activated.code}`);
      svc.clearLoadedTemplateMemo();
      return activated.versionId;
    }

    // A fixture BAN on its own run, captured as a trigger would.
    async function captured(runId: string, banId: string): Promise<void> {
      await capture(fx.db, runId, [banId], FIXTURE_PERIOD_START);
    }

    async function markProcessed(runId: string, banId: string) {
      await sql`
        INSERT INTO billing.bill_run_account
          (ref_bill_run_id, ref_billing_account_id, period_partition, status, attempt_count)
        VALUES (${runId}, ${banId}, ${FIXTURE_PERIOD_START}, 'PROCESSED', 1)`;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The setup deletes blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      process.env.BILLRUN_APP_TOKEN = SERVICE_TOKEN;
      sql = postgres(databaseUrl as string, { max: 5, onnotice: () => {} });

      await freshDatabase(sql, service!);
      runScript("db/seeds/sample/seed-billrun-sample.ts", {
        SAMPLE_SEED_PROFILE: "ci",
      });

      svc = {
        ...(await import("@/services/billing/materialize-runs")),
        ...(await import("@/services/billing/trigger-run")),
        ...(await import("@/services/billing/approve-run")),
        ...(await import("@/services/billing/post-run")),
        ...(await import("@/services/billing/read/get-stored-invoice")),
        ...(await import("@/services/billing/read/get-posting-progress")),
        ...(await import("@/services/billing/render-invoice-template")),
        ...(await import("@/services/billing/render-invoice")),
        ...(await import("@/services/billing/invoice-template/invoice-csv")),
        ...(await import("@/services/billing/invoice-template/load")),
        computeChargeChecksum: (
          await import("@/db/repositories/billing/customer-bill-line.repository")
        ).customerBillLineRepository.computeChargeChecksum,
        stageComplete: (
          await import("@/app/api/billrun/[runId]/stage/[stage]/complete/route")
        ).POST,
        storedInvoiceGet: (
          await import("@/app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/route")
        ).GET,
        ...(await import("@/actions/billing/invoice-settings/save-template-draft.action")),
        ...(await import("@/actions/billing/invoice-settings/activate-template.action")),
        ...(await import("@/actions/billing/invoice-settings/save-profile-draft.action")),
        ...(await import("@/actions/billing/invoice-settings/upload-logo.action")),
        ...(await import("@/actions/billing/invoice-settings/activate-profile.action")),
      };
      ({ rerunRun } = await import("@/services/billing/rerun-run"));
      ({ previewInvoiceTemplateAction: previewAction } =
        await import("@/actions/billing/invoice-settings/preview-invoice-template.action"));
      ({ GET: draftRoute } =
        await import("@/app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route"));
      ({ captureTemplateStamps: capture } =
        await import("@/services/billing/capture-template-stamps"));
      ({ SEEDED_FOOTNOTE: seededFootnote } =
        await import("@/tests/helpers/seeded-invoice-template"));
      svc.clearLoadedTemplateMemo();

      const [admin] = await sql<{ user_id: string }[]>`
        SELECT user_id FROM core.appuser WHERE user_email = ${ADMIN_EMAIL}`;
      adminId = admin!.user_id;
      session.userId = adminId;
      approverId = crypto.randomUUID();
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${approverId}, 'BM73 Approver', 'bm73-approver@example.invalid', 'LOCAL', 'ACTIVE')`;

      const { setupInvoiceRenderFixtures } =
        await import("@/tests/db/helpers/invoice-render-fixtures");
      fx = await setupInvoiceRenderFixtures(sql, "BM73", { reset: false });
      await fx.seedPostingGl();

      // The capacity fixtures run on their own operator cycle (the
      // flow-double shape).
      const { createFlowDoubleFixtures } =
        await import("@/tests/db/helpers/billrun-flow-double-fixtures");
      const { createCapacityPolygonFixtures } =
        await import("@/tests/db/helpers/capacity-polygon-fixtures");
      const [cycle] = await sql<{ bill_cycle_id: string }[]>`
        INSERT INTO billing.bill_cycle (name) VALUES ('BM73 Capacity Fixture Cycle')
        RETURNING bill_cycle_id`;
      const flowDoubleFixtures = createFlowDoubleFixtures({
        sql,
        db: fx.db as never,
        getActorId: () => adminId,
        getCycleId: () => cycle!.bill_cycle_id,
        periodStart: FIXTURE_PERIOD_START,
        periodEnd: FIXTURE_PERIOD_END,
        labelPrefix: "BM73",
      });
      flowDouble = () => flowDoubleFixtures;
      polygonFx = createCapacityPolygonFixtures({
        getSql: () => sql,
        getDb: () => fx.db as never,
        flowDouble,
        labelPrefix: "BM73",
        claimAt: "2026-06-10T00:00:00.000Z",
        periodStart: FIXTURE_PERIOD_START,
        periodEnd: FIXTURE_PERIOD_END,
        glEventAt: FIXTURE_PERIOD_START,
      });
    }, 900_000);

    afterAll(async () => {
      svc?.clearLoadedTemplateMemo();
      if (service) await purgeInvoiceBlobs(service).catch(() => undefined);
      if (sql) {
        await dropAllSchemas(sql).catch(() => undefined);
        await sql.end();
      }
    }, 120_000);

    it("step 1 — the trigger stamps every non-EXCLUDED BAN with Standard + its ACTIVE version and the audit lists the stamps (criterion 1)", async () => {
      await svc.materializeDueRuns();
      const [found] = await sql<Phase3Run[]>`
        SELECT r.bill_run_id, r.period_start::text, r.period_end::text,
               r.scheduled_run_date::text
        FROM billing.bill_run r
        JOIN billing.bill_cycle c ON c.bill_cycle_id = r.ref_bill_cycle_id
        WHERE r.status = 'SCHEDULED' AND c.name = ${DEFAULT_BILL_CYCLE_NAME}`;
      expect(found).toBeDefined();
      run = found!;
      const triggered = await svc.triggerRun(
        run.bill_run_id,
        adminId,
        run.scheduled_run_date,
      );
      expect(triggered.ok).toBe(true);

      const stamps = await runStamps(run.bill_run_id);
      const pending = [...stamps.values()].filter(
        (s) => s.status !== "EXCLUDED",
      );
      expect(pending.length).toBeGreaterThan(0);
      for (const s of stamps.values()) {
        if (s.status === "EXCLUDED") {
          expect(s.ref_bill_template_version_id).toBeNull();
          expect(s.template_captured_at).toBeNull();
          continue;
        }
        expect(s).toMatchObject({
          ref_bill_template_family_id: "BTF00000001",
          ref_bill_template_version_id: "BTV00000002",
          ref_csv_template_version_id: "BTV00000003",
        });
        expect(s.template_captured_at).not.toBeNull();
      }
      const audit = await auditAfterData("BILL_RUN_TRIGGERED", run.bill_run_id);
      expect(audit?.templateStamps).toHaveLength(pending.length);
      expect(audit?.templateStamps).toEqual(
        expect.arrayContaining(
          pending.map((s) => ({
            banId: s.ref_billing_account_id,
            familyId: "BTF00000001",
            versionId: "BTV00000002",
          })),
        ),
      );

      for (const s of pending) {
        await processAccountOnFlowSql(
          sql,
          signal,
          run,
          s.ref_billing_account_id,
          1,
        );
      }
      processed = pending.map((s) => s.ref_billing_account_id);
      expect(await runStatus(run.bill_run_id)).toBe("PROCESSED");

      // The ~900-polygon BAN: 9 State-District groups × 100 polygons, on its
      // own fixture run, captured before any activation.
      const { regionPolygons } =
        await import("@/tests/db/helpers/capacity-polygon-fixtures");
      ({ runId: polyRunId, ban: polyBan } = await polygonFx.capacityBill(
        "POLY900",
        { "RAN Target Capacity": regionPolygons(9, 100) },
      ));
      await captured(polyRunId, polyBan);
      expect((await runStamps(polyRunId)).get(polyBan)).toMatchObject({
        ref_bill_template_family_id: "BTF00000001",
        ref_bill_template_version_id: "BTV00000002",
      });
    }, 600_000);

    it("step 2 — drafts render page 1 and the last page; the ~900-polygon BAN paginates with repeated label + header and Page X of Y (criteria 5, 7, 8, 10)", async () => {
      for (const ban of processed) {
        const { html } = await draftHtml(run.bill_run_id, ban);
        for (const block of [
          "sec--identification",
          "sec--billTo",
          "sec--chargeSummary",
          "sec--amountDue",
        ]) {
          expect(html).toContain(block);
        }
        expect(html).toContain('class="total-amount-page"');
        for (const line of seededFootnote) expect(html).toContain(line);
      }

      const poly = await draftHtml(polyRunId, polyBan);
      expect(poly.html.match(/<td class="mono">PCU-/g)).toHaveLength(900);
      // One table per State-District group, each repeating its group label
      // and column header in a `thead` on every page it spans (D48).
      expect(
        poly.html.match(
          /<table class="detail-group">\s*<thead>\s*<tr class="group-label">/g,
        ),
      ).toHaveLength(9);
      expect(poly.html).toContain("thead { display: table-header-group; }");
      // The last page follows the last detail row.
      expect(poly.html.indexOf('class="total-amount-page"')).toBeGreaterThan(
        poly.html.lastIndexOf('<td class="mono">PCU-'),
      );
      expect(poly.pageSetup.displayHeaderFooter).toBe(true);
      expect(poly.footerHtml).toMatch(
        /<span style="text-align: right;">Page <span class="pageNumber"><\/span> of <span class="totalPages"><\/span>/,
      );
      const pdf = await svc.renderDraftInvoice({
        runId: polyRunId,
        banId: polyBan,
      });
      expect(pdfPageCount(pdf)).toBeGreaterThan(10);
    }, 600_000);

    it("step 3 — footnote line 2 edited, previewed, saved and activated: a new version on v1's layout; the default v1 stays ACTIVE (criterion 11)", async () => {
      const preview = await previewAction({
        familyId: "BTF00000001",
        structure: editedStructure(PHASE3_EDITED_LINE_2),
        source: "sample",
      });
      expect(preview.ok).toBe(true);
      if (preview.ok) expect(preview.html).toContain(PHASE3_EDITED_LINE_2);

      v2Id = await activateFootnote(PHASE3_EDITED_LINE_2, "journey bm73 v2");
      const versions = await sql<
        {
          bill_template_version_id: string;
          status: string;
          is_default: boolean;
          ref_layout_version_id: string | null;
          ref_bill_template_family_id: string | null;
        }[]
      >`
        SELECT bill_template_version_id, status, is_default,
               ref_layout_version_id, ref_bill_template_family_id
        FROM billing.bill_template_version
        WHERE bill_template_version_id IN ('BTV00000002', ${v2Id})
        ORDER BY bill_template_version_id`;
      expect(versions).toEqual([
        {
          bill_template_version_id: "BTV00000002",
          status: "ACTIVE",
          is_default: true,
          ref_layout_version_id: "BTV00000001",
          ref_bill_template_family_id: "BTF00000001",
        },
        {
          bill_template_version_id: v2Id,
          status: "ACTIVE",
          is_default: false,
          ref_layout_version_id: "BTV00000001",
          ref_bill_template_family_id: "BTF00000001",
        },
      ]);
    }, 300_000);

    it("step 4 — re-opened drafts still print the old footnote: the run is frozen (criterion 2)", async () => {
      const drafts: (readonly [string, string])[] = [
        ...processed.map((ban) => [run.bill_run_id, ban] as const),
        [polyRunId, polyBan] as const,
      ];
      for (const [runId, ban] of drafts) {
        const draft = await draftHtml(runId, ban);
        expect(draft.resolved.generated.billTemplateVersionId).toBe(
          "BTV00000002",
        );
        expect(draft.html).toContain(seededFootnote[1]!);
        expect(draft.html).not.toContain(PHASE3_EDITED_LINE_2);
      }
    }, 600_000);

    it("step 5 — rerunning one BAN re-captures only it; the rerun audit lists it and its draft prints the new footnote (criterion 3)", async () => {
      rerunBan = processed[0]!;
      const before = await runStamps(run.bill_run_id);
      const rerun = await rerunRun(
        {
          billRunId: run.bill_run_id,
          accountIds: [rerunBan],
          fromStage: "validation",
          reason: "bm73 journey: pick up the new footnote",
        },
        adminId,
      );
      expect(rerun.ok).toBe(true);
      if (!rerun.ok) return;

      const after = await runStamps(run.bill_run_id);
      expect(after.get(rerunBan)).toMatchObject({
        ref_bill_template_family_id: "BTF00000001",
        ref_bill_template_version_id: v2Id,
      });
      expect(
        Date.parse(after.get(rerunBan)!.template_captured_at!),
      ).toBeGreaterThan(
        Date.parse(before.get(rerunBan)!.template_captured_at!),
      );
      for (const ban of processed.slice(1)) {
        const { status: _was, ...stampsBefore } = before.get(ban)!;
        const { status: _now, ...stampsAfter } = after.get(ban)!;
        expect(stampsAfter).toEqual(stampsBefore);
      }
      expect(
        await auditAfterData("BILL_RUN_RERUN", run.bill_run_id),
      ).toMatchObject({
        templateStamps: [
          { banId: rerunBan, familyId: "BTF00000001", versionId: v2Id },
        ],
      });

      await processAccountOnFlowSql(
        sql,
        signal,
        run,
        rerunBan,
        rerun.value.attempt,
      );
      expect(await runStatus(run.bill_run_id)).toBe("PROCESSED");

      const draft = await draftHtml(run.bill_run_id, rerunBan);
      expect(draft.resolved.generated.billTemplateVersionId).toBe(v2Id);
      expect(draft.html).toContain(PHASE3_EDITED_LINE_2);
      expect(draft.html).not.toContain(seededFootnote[1]!);
    }, 600_000);

    it("step 6 — a newer version goes ACTIVE, then a second user approves and the run posts: bill stamps = run stamps + family, stored PDFs follow the frozen versions (criteria 2, 4)", async () => {
      // The live ACTIVE now differs from every captured version, so a
      // posting that resolved live would stamp it.
      v3Id = await activateFootnote(PHASE3_LINE_V3, "journey bm73 v3");
      const frozen = await runStamps(run.bill_run_id);

      const approved = await svc.approveRun(run.bill_run_id, approverId);
      expect(approved.ok).toBe(true);
      const posted = await svc.postRun(run.bill_run_id, approverId);
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      const invoiced = posted.value.results
        .filter((r) => r.result.status === "invoiced")
        .map((r) => r.billingAccountId);
      expect(invoiced).toContain(rerunBan);
      expect(invoiced.length).toBeGreaterThan(1);

      for (const ban of invoiced) {
        const [bill] = await sql<
          {
            ref_bill_template_family_id: string | null;
            ref_bill_template_version_id: string | null;
            ref_invoice_profile_version: number | null;
            ref_csv_template_version_id: string | null;
          }[]
        >`
          SELECT ref_bill_template_family_id, ref_bill_template_version_id,
                 ref_invoice_profile_version, ref_csv_template_version_id
          FROM billing.customer_bill
          WHERE ref_bill_run_id = ${run.bill_run_id}
            AND ref_billing_account_id = ${ban}`;
        const s = frozen.get(ban)!;
        expect(bill).toEqual({
          ref_bill_template_family_id: s.ref_bill_template_family_id,
          ref_bill_template_version_id: s.ref_bill_template_version_id,
          ref_invoice_profile_version: s.ref_invoice_profile_version,
          ref_csv_template_version_id: s.ref_csv_template_version_id,
        });
        expect(bill!.ref_bill_template_version_id).not.toBe(v3Id);

        const stored = await svc.getStoredInvoice(run.bill_run_id, ban);
        expect(pdfPageCount(stored.pdf)).toBeGreaterThanOrEqual(1);
        const final = await svc.buildInvoiceHtml({
          runId: run.bill_run_id,
          banId: ban,
          mode: "final",
        });
        expect(final.resolved.generated.billTemplateVersionId).toBe(
          s.ref_bill_template_version_id,
        );
        expect(final.html).not.toContain(PHASE3_LINE_V3);
        expect(final.html).toContain(
          ban === rerunBan ? PHASE3_EDITED_LINE_2 : seededFootnote[1]!,
        );
      }
    }, 900_000);

    it("step 8a — a NULL family version: the draft is 422 and posting SKIPs it before any INV (criterion 6)", async () => {
      // A second, non-default family holding only a RETIRED version (bm65 §8
      // case 3's fixture), bound by SQL: the capture stamps a NULL version.
      await sql`
        INSERT INTO billing.bill_template_family (bill_template_family_id, code, name, kind)
        VALUES ('BTF00000099', 'BM73-EMPTY', 'Empty family', 'generated')`;
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime, retired_datetime)
        SELECT 'BTV00000099', 'INVOICE', 'generated', 99, 'RETIRED', false,
               'BTV00000001', 'BTF00000099', structure, 'invoice-templates/generated/INVOICE/v99/',
               ${"9".repeat(64)}, 'sha256', 'bm73 retired fixture', now(), now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
      await fx.newRun(PHASE3_RUN_NULL);
      const { banId: sibling } = await fx.postableBill({
        label: "SIB",
        runId: PHASE3_RUN_NULL,
      });
      const { banId: nullBan, customerBillId } = await fx.postableBill({
        label: "NUL",
        runId: PHASE3_RUN_NULL,
      });
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_version_id = 'BTV00000099'
        WHERE billing_account_id = ${nullBan}`;
      await captured(PHASE3_RUN_NULL, nullBan);
      expect((await runStamps(PHASE3_RUN_NULL)).get(nullBan)).toMatchObject({
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: null,
      });

      const response = await draftRoute({} as never, {
        params: Promise.resolve({ runId: PHASE3_RUN_NULL, banId: nullBan }),
      });
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "TEMPLATE_VERSION_NOT_FOUND" },
      });

      // The blocking pre-approval check refuses the real approve (D58a);
      // posting's D58 skip is the backstop, reached past it by SQL.
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${PHASE3_RUN_NULL}`;
      expect((await svc.approveRun(PHASE3_RUN_NULL, approverId)).ok).toBe(
        false,
      );
      await sql`
        UPDATE billing.bill_run SET status = 'APPROVED', approved_by = ${approverId},
               approved_at = now(), gl_event_at = scheduled_run_date
        WHERE bill_run_id = ${PHASE3_RUN_NULL}`;
      expect((await svc.postRun(PHASE3_RUN_NULL, approverId)).ok).toBe(true);
      const rows = await runStamps(PHASE3_RUN_NULL);
      expect(rows.get(nullBan)?.status).toBe("SKIPPED");
      expect(rows.get(sibling)?.status).toBe("INVOICED");
      const [bill] = await sql<{ ref_inv_document_id: string | null }[]>`
        SELECT ref_inv_document_id FROM billing.customer_bill
        WHERE customer_bill_id = ${customerBillId}`;
      expect(bill!.ref_inv_document_id).toBeNull();
    }, 300_000);

    it("step 8b — a negative Utilised fails INVOICE_NEGATIVE_UTILISED, never printed (criterion 6)", async () => {
      const ban = await flowDouble().newAccount("Negative");
      const runId = "BRN-BM73-NEGATIVE";
      await flowDouble().newRun(runId);
      await markProcessed(runId, ban);
      // gross 100,000, rated 10,000, discount 20,000 → net 80,000;
      // Unutilised = 90,000, Utilised = 80,000 − 90,000 = −10,000.
      const [bill] = await sql<{ id: string }[]>`
        INSERT INTO billing.customer_bill
          (ref_bill_run_id, ref_billing_account_id, period_partition, category,
           state, billing_period_start, billing_period_end, subtotal, tax_total,
           total_amount, payment_due_date)
        VALUES
          (${runId}, ${ban}, ${FIXTURE_PERIOD_START}, 'trial', 'new',
           ${FIXTURE_PERIOD_START}, ${FIXTURE_PERIOD_END}, 80000.00, 0.00,
           80000.00, '2026-07-15')
        RETURNING customer_bill_id AS id`;
      await sql`
        INSERT INTO billing.customer_bill_line
          (ref_customer_bill_id, period_partition, line_no, source, line_type,
           description, ref_product_offering_id, udr_type, gross_amount,
           discount_amount, net_amount, rated_amount, grouping_key, currency)
        VALUES
          (${bill!.id}, ${FIXTURE_PERIOD_START}, 1, 'USAGE', 'charge',
           'Negative Capacity', 'POF-BM73-NEG', 'RAN_USAGE', 100000.00,
           20000.00, 80000.00, 10000.00, 'POF-BM73-NEG:CAPACITY:EA', 'MYR')`;
      await captured(runId, ban);
      await expect(draftHtml(runId, ban)).rejects.toMatchObject({
        code: "INVOICE_NEGATIVE_UTILISED",
      });
    }, 300_000);

    it("step 8c — a polygon row with no polygon_id fails INVOICE_POLYGON_DATA_MISSING (criterion 9)", async () => {
      const { polygonResource } =
        await import("@/tests/db/helpers/capacity-polygon-fixtures");
      const { runId, ban } = await polygonFx.capacityBill("NOPOLY", {
        "Kappa Capacity": [
          {
            polygonId: null,
            udrResource: polygonResource("Selangor", "Petaling"),
            ea: 1,
          },
        ],
      });
      await captured(runId, ban);
      await expect(draftHtml(runId, ban)).rejects.toMatchObject({
        code: "INVOICE_POLYGON_DATA_MISSING",
      });
    }, 300_000);

    it(`step 8d — ${INVOICE_USAGE_ROW_LIMIT + 1} detail rows fail INVOICE_USAGE_OVER_LIMIT (criterion 9)`, async () => {
      const { ban, usageRatePriceId, runId, piId } =
        await polygonFx.capacityFixtures.setupSingleAccountCapacity(
          "OVER",
          "Lambda Capacity",
          polygonFx.offeringOpts,
        );
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_resource, udr_usage_quantity,
           udr_usage_unit, udr_rate_type, udr_usage_rate, udr_price_ref,
           udr_rated_price, udr_rated_price_raw, udr_rounding_mode, udr_currency,
           udr_ref_batch_id, udr_source_file, rating_engine_version,
           rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
           billrun_checksum, upsert_datetime)
        SELECT
          rating.period_of('2026-06-10T00:00:00Z'::timestamptz), 'RAN_USAGE',
          '2026-06-10T00:00:00Z'::timestamptz, '2026-06-10T00:00:00Z'::timestamptz,
          'BILL_DRAFT', ${piId},
          'commercial_unit=CU-BM73-OVER|mno_public_id=MNO-BM73|polygon_id=PCU-' || g.i,
          'Selangor|Petaling|2025-03-01', '1.000000', 'EA', 'PER_UNIT',
          '100.000000', ${usageRatePriceId}, '100.00', '100.00', 'HALF_UP',
          'MYR', '_BM73_BATCH', '_BM73', '_BM73', 0, ${runId}, ${ban}, 1,
          'bm73-claim', now()
        FROM generate_series(1, ${INVOICE_USAGE_ROW_LIMIT + 1}) AS g(i)`;
      await runAggregation(sql, {
        runId,
        ban,
        attempt: 1,
        periodStart: FIXTURE_PERIOD_START,
        periodEnd: FIXTURE_PERIOD_END,
        glEventAt: FIXTURE_PERIOD_START,
      });
      await markProcessed(runId, ban);
      await captured(runId, ban);
      await expect(draftHtml(runId, ban)).rejects.toMatchObject({
        code: "INVOICE_USAGE_OVER_LIMIT",
      });
    }, 300_000);

    it("step 8e — recovery: once its family has an ACTIVE version, rerunning the NULL-version BAN re-captures it, its draft renders, approval passes and it posts (Inv #58, guardrail 60)", async () => {
      // Step 8a left BTF00000099 with no ACTIVE version. A fresh run captures
      // a NULL version for a BAN bound to it, as in step 8a.
      const runId = "BRN09073802";
      await fx.newRun(runId);
      const { banId } = await fx.postableBill({ label: "REC", runId });
      await sql`
        UPDATE billing.billing_account SET ref_bill_template_version_id = 'BTV00000099'
        WHERE billing_account_id = ${banId}`;
      await captured(runId, banId);
      expect((await runStamps(runId)).get(banId)).toMatchObject({
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: null,
      });
      await sql`UPDATE billing.bill_run SET status = 'PROCESSED' WHERE bill_run_id = ${runId}`;

      // The fix: the family gets an ACTIVE version. It reuses v1's stored,
      // checksum-verified files (the empty family has no editor; the editor
      // works on Standard only, D45).
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
           ref_layout_version_id, ref_bill_template_family_id, structure, blob_ref, checksum,
           checksum_algorithm, change_note, activated_datetime)
        SELECT 'BTV00000098', 'INVOICE', 'generated', 98, 'ACTIVE', false,
               'BTV00000001', 'BTF00000099', structure, blob_ref, checksum,
               checksum_algorithm, 'bm73 recovery fixture', now()
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;

      const rerun = await rerunRun(
        {
          billRunId: runId,
          accountIds: [banId],
          fromStage: "validation",
          reason: "bm73 journey: the family has an ACTIVE version again",
        },
        adminId,
      );
      expect(rerun.ok).toBe(true);
      expect((await runStamps(runId)).get(banId)).toMatchObject({
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: "BTV00000098",
      });
      expect(await auditAfterData("BILL_RUN_RERUN", runId)).toMatchObject({
        templateStamps: [
          {
            banId,
            familyId: "BTF00000099",
            versionId: "BTV00000098",
          },
        ],
      });

      // The re-triggered processing settles (fixture shortcut: the trial bill
      // is the fixture's, so the account and run are marked PROCESSED).
      await sql`
        UPDATE billing.bill_run_account SET status = 'PROCESSED'
        WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
      // A real trigger records the GL event date (`period_open` reads it).
      await sql`
        UPDATE billing.bill_run SET status = 'PROCESSED', gl_event_at = scheduled_run_date
        WHERE bill_run_id = ${runId}`;

      const draft = await draftHtml(runId, banId);
      expect(draft.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000098",
      );
      expect((await svc.approveRun(runId, approverId)).ok).toBe(true);
      expect((await svc.postRun(runId, approverId)).ok).toBe(true);
      expect((await runStamps(runId)).get(banId)?.status).toBe("INVOICED");
      const [bill] = await sql<
        {
          ref_inv_document_id: string | null;
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
        }[]
      >`
        SELECT ref_inv_document_id, ref_bill_template_family_id,
               ref_bill_template_version_id
        FROM billing.customer_bill
        WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
      expect(bill!.ref_inv_document_id).not.toBeNull();
      expect(bill).toMatchObject({
        ref_bill_template_family_id: "BTF00000099",
        ref_bill_template_version_id: "BTV00000098",
      });
    }, 300_000);
  },
);
