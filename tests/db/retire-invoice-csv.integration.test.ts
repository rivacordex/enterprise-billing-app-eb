import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgresjs from "postgres";

import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import {
  applyRealMigrations,
  CSV_ROW,
  setupPre0055Database,
  STANDARD,
  stampCsvOnBill,
  stampCsvOnRunAccount,
  teardownCsvRetireDatabase,
} from "@/tests/db/helpers/csv-retire-fixtures";
import type { InvoiceRenderFixtures } from "@/tests/db/helpers/invoice-render-fixtures";

// bm88-spec §9 "New" (D2, D3) — `0055` retires the bm62 invoice CSV on a
// POPULATED database. The suite migrates to 0054, seeds a posted bill and an
// open run whose rows carry CSV stamps (BTV00000003), then applies the real
// folder and asserts: both stamp columns and the CSV index are gone; no
// `kind = 'csv'` row remains and BTV00000001–2 are intact; a csv row fails
// `btv_kind_check` and a typeless row `btv_has_family`; the version DELETE
// guard is re-enabled (VERSION_DELETE_FORBIDDEN); and the open run's account
// still drafts and posts. The draft render loads the seeded templates from
// blob, so the suite needs the throwaway Azurite as well as the database.
// Fixtures go through the shared bm88 csv-retire fixtures (the bm53/bm54
// render fixtures, `reset: false`) and raw SQL, the
// invoice-template-types-catalog precedent.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

// Well-formed ids: BRN + 8 digits.
const RUN_POSTED = "BRN08800001";
const RUN_OPEN = "BRN08800002";

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm88 0055 retires the invoice CSV on a populated database (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    let guarded = false;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    let postedBan = "";
    let postedBillId = "";
    let openBan = "";
    let openBillId = "";
    let appliedBefore = 0;
    let kindCheckBefore: string[] = [];
    let versionsBefore: unknown[] = [];

    async function appliedCount(): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      return row!.n;
    }

    async function columnExists(
      table: string,
      column: string,
    ): Promise<boolean> {
      const rows = await sql`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'billing' AND table_name = ${table} AND column_name = ${column}`;
      return rows.length > 0;
    }

    async function btvConstraints(): Promise<string[]> {
      const rows = await sql<{ conname: string }[]>`
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'billing.bill_template_version'::regclass AND contype = 'c'
        ORDER BY conname`;
      return rows.map((r) => r.conname);
    }

    async function seededVersions(): Promise<unknown[]> {
      const rows = await sql<{ r: unknown }[]>`
        SELECT to_jsonb(v) AS r FROM billing.bill_template_version v
        WHERE bill_template_version_id IN ('BTV00000001', 'BTV00000002')
        ORDER BY bill_template_version_id`;
      return rows.map((row) => row.r);
    }

    beforeAll(async () => {
      // 1. A database at 0054.
      ({ sql, fx } = await setupPre0055Database({
        databaseUrl: databaseUrl as string,
        blobConnection: blobConnection as string,
        service: service!,
        prefix: "BM88R",
      }));
      guarded = true;

      // 2. A posted bill whose run row and bill carry the CSV stamp. The bill
      //    is stamped while still a trial bill (before the 0033 latch), as
      //    pre-bm88 posting left it.
      await fx.newRun(RUN_POSTED);
      ({ banId: postedBan, customerBillId: postedBillId } =
        await fx.postableBill({ label: "POSTED", runId: RUN_POSTED }));
      await stampCsvOnRunAccount(sql, RUN_POSTED, postedBan);
      await stampCsvOnBill(sql, postedBillId);
      expect((await fx.post(RUN_POSTED, postedBan)).status).toBe("invoiced");

      // 3. An open run: one account captured (with the CSV stamp) but not posted.
      await fx.newRun(RUN_OPEN);
      ({ banId: openBan, customerBillId: openBillId } = await fx.postableBill({
        label: "OPEN",
        runId: RUN_OPEN,
      }));
      await stampCsvOnRunAccount(sql, RUN_OPEN, openBan);

      const stamped = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_run_account
        WHERE ref_csv_template_version_id = ${CSV_ROW}`;
      expect(stamped[0]!.n).toBe(2);
      const [posted] = await sql<
        { ref_csv_template_version_id: string; ref_inv_document_id: string }[]
      >`
        SELECT ref_csv_template_version_id, ref_inv_document_id
        FROM billing.customer_bill WHERE customer_bill_id = ${postedBillId}`;
      expect(posted?.ref_csv_template_version_id).toBe(CSV_ROW);
      expect(posted?.ref_inv_document_id).not.toBeNull();

      kindCheckBefore = await btvConstraints();
      versionsBefore = await seededVersions();

      // 4. Apply the real folder: 0055 only.
      appliedBefore = await appliedCount();
      await applyRealMigrations(sql);
    }, 300_000);

    afterAll(async () => {
      await teardownCsvRetireDatabase(sql, service, guarded);
    }, 60_000);

    it("applies exactly one migration (0055)", async () => {
      expect(await appliedCount()).toBe(appliedBefore + 1);
    });

    it("drops both CSV stamp columns and the customer_bill CSV index", async () => {
      expect(
        await columnExists("customer_bill", "ref_csv_template_version_id"),
      ).toBe(false);
      expect(
        await columnExists("bill_run_account", "ref_csv_template_version_id"),
      ).toBe(false);
      const indexes = await sql`
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'billing'
          AND indexname IN ('customer_bill_ref_csv_template_version_id_idx',
                            'btv_version_csv_uq', 'btv_one_active_uq')`;
      expect(indexes).toHaveLength(0);
    });

    it("deletes every csv row and leaves BTV00000001–2 intact", async () => {
      const csv = await sql`
        SELECT 1 FROM billing.bill_template_version WHERE kind = 'csv'`;
      expect(csv).toHaveLength(0);
      const rows = await sql<{ bill_template_version_id: string }[]>`
        SELECT bill_template_version_id FROM billing.bill_template_version
        ORDER BY bill_template_version_id`;
      expect(rows.map((r) => r.bill_template_version_id)).toEqual([
        "BTV00000001",
        "BTV00000002",
      ]);
      expect(await seededVersions()).toEqual(versionsBefore);
    });

    it("replaces the 0046 inline kind check and the 0053 CSV checks with btv_kind_check + btv_has_family", async () => {
      // The pre-0055 names, confirmed on the 0054 database.
      expect(kindCheckBefore).toEqual(
        expect.arrayContaining([
          "bill_template_version_kind_check",
          "btv_csv_has_no_family",
          "btv_draft_not_csv",
          "btv_type_scoped_has_family",
        ]),
      );
      const after = await btvConstraints();
      for (const gone of [
        "bill_template_version_kind_check",
        "btv_csv_has_no_family",
        "btv_draft_not_csv",
        "btv_type_scoped_has_family",
      ]) {
        expect(after).not.toContain(gone);
      }
      expect(after).toEqual(
        expect.arrayContaining(["btv_has_family", "btv_kind_check"]),
      );
    });

    it("refuses a csv row (btv_kind_check)", async () => {
      // A type is given, so only the kind check can object.
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           ref_bill_template_family_id, blob_ref, checksum, checksum_algorithm,
           change_note, activated_datetime)
        VALUES ('BTV00000881', 'INVOICE', 'csv', 2, 'ACTIVE', ${STANDARD},
           'invoice-templates/system/csv/v2/', ${"c".repeat(64)}, 'sha256', 'bm88 row', now())
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "btv_kind_check",
      });
    });

    it("refuses a layout or generated row with no type (btv_has_family)", async () => {
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           layout_code, page_setup, blob_ref, checksum, checksum_algorithm,
           change_note, activated_datetime)
        VALUES ('BTV00000882', 'INVOICE', 'layout', 88, 'ACTIVE',
           'INVTPL-STD-A4', '{}'::jsonb, 'invoice-templates/layouts/INVTPL-STD-A4/v88/',
           ${"d".repeat(64)}, 'sha256', 'bm88 row', now())
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "btv_has_family",
      });
      await expect(sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           ref_layout_version_id, structure)
        SELECT 'BTV00000883', 'INVOICE', 'generated', 88, 'DRAFT', 'BTV00000001', structure
        FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'
      `).rejects.toMatchObject({
        code: "23514",
        constraint_name: "btv_has_family",
      });
    });

    it("re-enables the version guard: a DELETE still raises VERSION_DELETE_FORBIDDEN", async () => {
      const [trg] = await sql<{ tgenabled: string }[]>`
        SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'bill_template_version_guard_trg'`;
      expect(trg?.tgenabled).toBe("O");
      for (const id of ["BTV00000001", "BTV00000002"]) {
        await expect(sql`
          DELETE FROM billing.bill_template_version WHERE bill_template_version_id = ${id}
        `).rejects.toThrow(/VERSION_DELETE_FORBIDDEN/);
      }
    });

    it("keeps the posted bill and its other stamps", async () => {
      const [bill] = await sql<
        {
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
          ref_inv_document_id: string | null;
        }[]
      >`
        SELECT ref_bill_template_family_id, ref_bill_template_version_id, ref_inv_document_id
        FROM billing.customer_bill WHERE customer_bill_id = ${postedBillId}`;
      expect(bill).toMatchObject({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id: "BTV00000002",
      });
      expect(bill?.ref_inv_document_id).not.toBeNull();
    });

    it("the open run's account still drafts and posts after 0055", async () => {
      const draft = await buildInvoiceHtml({
        runId: RUN_OPEN,
        banId: openBan,
        mode: "draft",
      });
      expect(draft.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000002",
      );
      expect(draft.resolved.layout.billTemplateVersionId).toBe("BTV00000001");
      expect(draft.resolved).not.toHaveProperty("csv");
      expect(draft.html).toContain("Calculations are done in Mbps");

      const result = await fx.post(RUN_OPEN, openBan);
      expect(result.status).toBe("invoiced");
      const [bill] = await sql<
        {
          ref_bill_template_family_id: string | null;
          ref_bill_template_version_id: string | null;
          ref_inv_document_id: string | null;
        }[]
      >`
        SELECT ref_bill_template_family_id, ref_bill_template_version_id, ref_inv_document_id
        FROM billing.customer_bill WHERE customer_bill_id = ${openBillId}`;
      expect(bill).toEqual({
        ref_bill_template_family_id: STANDARD,
        ref_bill_template_version_id: "BTV00000002",
        ref_inv_document_id:
          result.status === "invoiced" ? result.invoiceId : "",
      });
    }, 180_000);
  },
);
