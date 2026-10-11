import { BlobServiceClient } from "@azure/storage-blob";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { getPostedInvoiceCsv } from "@/services/billing/invoice-template/invoice-csv";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { parseInvoiceCsv } from "@/tests/helpers/parse-csv";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  FIXTURE_PARTITION,
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";

// Guardrail 55 (bm62-spec §Tests §Design D3; code-standards Part 2 §9 item
// 55, Inv #39, overview success criterion 9). For every posted bill of the
// run, the downloaded CSV has one row per `customer_bill_line`, and the SQL
// `SUM` of its `net_amount` column — loaded into a temp table, never summed in
// JS — equals `customer_bill.subtotal`, compared as text. Also: a bill stamped
// with a fixture CSV v2 gets v2's columns; a NULL stamp (pre-bm54) gets the
// default map; a tampered map blob fails `TEMPLATE_CHECKSUM_MISMATCH` (the
// route's 500); an unposted bill is not found (404); an unbalanced bill fails
// `INVOICE_RECONCILIATION_FAILED` (409).
//
// The posted bills are written directly (`postedBill`, the bm53 read-side
// fixture): this environment has no workflow engine to produce a `ci` run's
// bills, and the CSV path only reads the posted rows. Requires DATABASE_URL +
// BILLRUN_BLOB_CONNECTION_STRING (the throwaway Azurite).
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN = "BRN-BM62-G55";
const RUN_EDGE = "BRN-BM62-EDGE";
const CSV_V2 = "BTV00090062";
const CSV_TAMPERED = "BTV00090063";
const DIR_TAG = `bm62-${Date.now()}`;

const V2_COLUMNS = [
  { header: "invoice", path: "invoice.number" },
  { header: "line", path: "line.lineNo" },
  { header: "net_amount", path: "line.netAmount" },
];

interface LineSpec {
  lineNo: number;
  source: "RECURRING" | "USAGE" | "OCC";
  gross: string;
  discount: string;
  net: string;
  description: string;
}

// A deliberately awkward bill: a discount, a sub-cent-sized usage line, a
// negative credit with a formula-leading description, and a large amount.
const MULTI_LINES: LineSpec[] = [
  {
    lineNo: 1,
    source: "RECURRING",
    gross: "1300.00",
    discount: "65.50",
    net: "1234.50",
    description: "Fibre 1Gbps, monthly",
  },
  {
    lineNo: 2,
    source: "USAGE",
    gross: "0.01",
    discount: "0.00",
    net: "0.01",
    description: "Usage",
  },
  {
    lineNo: 3,
    source: "OCC",
    gross: "-12.50",
    discount: "0.00",
    net: "-12.50",
    description: '=HYPERLINK("http://evil.example","credit")',
  },
  {
    lineNo: 4,
    source: "RECURRING",
    gross: "99999.99",
    discount: "0.00",
    net: "99999.99",
    description: 'Dark fibre "core" lease',
  },
];

describe.skipIf(!databaseUrl || !blobConnection)(
  "guardrail 55 — the invoice CSV's net_amount column sums exactly to customer_bill.subtotal",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const uploaded: string[] = [];
    let banNullStamp = "";
    let banMulti = "";
    let banV2 = "";
    let banDraft = "";
    let banUnbalanced = "";
    let banTampered = "";

    // Inserts a RETIRED csv version (a stamped id need not be ACTIVE) and
    // uploads its map + checksums.json index; returns its blob directory.
    async function insertCsvVersion(
      id: string,
      versionNo: number,
      columns: { header: string; path: string }[],
    ): Promise<string> {
      const dir = `system/csv/${DIR_TAG}-v${versionNo}/`;
      const map = Buffer.from(
        `${JSON.stringify(
          {
            templateId: "INVTPL-CSV-LINES",
            version: versionNo,
            rowSource: "lines",
            encoding: "utf-8-bom",
            lineEnding: "CRLF",
            columns,
          },
          null,
          2,
        )}\n`,
      );
      const index = Buffer.from(
        `${JSON.stringify(
          {
            algorithm: "sha256",
            files: {
              "invoice.csv.columns.json": createHash("sha256")
                .update(map)
                .digest("hex"),
            },
          },
          null,
          2,
        )}\n`,
      );
      for (const [name, bytes] of [
        ["invoice.csv.columns.json", map],
        ["checksums.json", index],
      ] as const) {
        await blobStore.putObject(
          "invoice-templates",
          `${dir}${name}`,
          bytes,
          "application/json",
          { writeOnce: true, checksumAlgorithm: "sha256" },
        );
        uploaded.push(`${dir}${name}`);
      }
      await sql`
        INSERT INTO billing.bill_template_version
          (bill_template_version_id, ref_bill_format_id, kind, version_no, status,
           is_default, blob_ref, checksum, checksum_algorithm, change_note,
           activated_datetime, retired_datetime)
        VALUES (${id}, 'INVOICE', 'csv', ${versionNo}, 'RETIRED', false,
                ${`invoice-templates/${dir}`},
                ${createHash("sha256").update(index).digest("hex")}, 'sha256',
                ${`bm62 fixture csv v${versionNo}`}, now(), now())`;
      return dir;
    }

    // Test-only rewrite of a POSTED bill (the finalization guard is bypassed
    // with `session_replication_role = replica`, the fixtures' precedent):
    // replace its lines, set the CSV stamp, and set subtotal/total to the SQL
    // SUM of the lines (or to an explicit unbalanced value).
    async function rewritePostedBill(
      customerBillId: string,
      args: {
        lines?: LineSpec[];
        csvStamp?: string | null;
        subtotal?: string;
      },
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        if (args.lines) {
          await tx`
            DELETE FROM billing.customer_bill_line
            WHERE ref_customer_bill_id = ${customerBillId}
              AND period_partition = ${FIXTURE_PARTITION}`;
          for (const l of args.lines) {
            await tx`
              INSERT INTO billing.customer_bill_line
                (ref_customer_bill_id, period_partition, line_no, source,
                 ref_product_offering_id, gross_amount, discount_amount, net_amount,
                 grouping_key, currency, description, quantity, unit, udr_type)
              VALUES (${customerBillId}, ${FIXTURE_PARTITION}, ${l.lineNo}, ${l.source},
                      ${`POF-BM62-${l.lineNo}`}, ${l.gross}, ${l.discount}, ${l.net},
                      ${`POF-BM62-${l.lineNo}`}, 'MYR', ${l.description},
                      '1.000000', 'EA', ${l.source === "USAGE" ? "RAN_USAGE" : null})`;
          }
        }
        if (args.csvStamp !== undefined) {
          await tx`
            UPDATE billing.customer_bill
            SET ref_csv_template_version_id = ${args.csvStamp}
            WHERE customer_bill_id = ${customerBillId}`;
        }
        if (args.subtotal !== undefined) {
          await tx`
            UPDATE billing.customer_bill
            SET subtotal = ${args.subtotal}, total_amount = ${args.subtotal}
            WHERE customer_bill_id = ${customerBillId}`;
        } else if (args.lines) {
          await tx`
            UPDATE billing.customer_bill cb
            SET subtotal = s.net, total_amount = s.net
            FROM (SELECT SUM(net_amount) AS net FROM billing.customer_bill_line
                  WHERE ref_customer_bill_id = ${customerBillId}
                    AND period_partition = ${FIXTURE_PARTITION}) s
            WHERE cb.customer_bill_id = ${customerBillId}`;
        }
      });
    }

    async function errorOf(p: Promise<unknown>): Promise<unknown> {
      try {
        await p;
      } catch (err) {
        return err;
      }
      return undefined;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The cleanup deletes fixture template blobs: throwaway Azurite only.
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM62G55");
      await seedInvoiceTemplates(fx.db);
      clearLoadedTemplateMemo();

      await insertCsvVersion(CSV_V2, 2, V2_COLUMNS);
      const tamperedDir = await insertCsvVersion(CSV_TAMPERED, 3, V2_COLUMNS);
      // Overwrite the verified map after its row recorded the checksum.
      await service!
        .getContainerClient("invoice-templates")
        .getBlockBlobClient(`${tamperedDir}invoice.csv.columns.json`)
        .upload("{}", 2, {
          blobHTTPHeaders: { blobContentType: "application/json" },
        });

      await fx.newRun(RUN);
      // Pre-bm54: every stamp NULL → the default CSV map.
      ({ banId: banNullStamp } = await fx.postedBill({
        label: "NULLSTAMP",
        runId: RUN,
        invoiceNo: "INV00062001",
      }));
      const multi = await fx.postedBill({
        label: "MULTI",
        runId: RUN,
        invoiceNo: "INV00062002",
      });
      banMulti = multi.banId;
      await rewritePostedBill(multi.customerBillId, {
        lines: MULTI_LINES,
        csvStamp: "BTV00000003",
      });
      const v2 = await fx.postedBill({
        label: "V2",
        runId: RUN,
        invoiceNo: "INV00062003",
      });
      banV2 = v2.banId;
      await rewritePostedBill(v2.customerBillId, {
        lines: MULTI_LINES.slice(0, 3),
        csvStamp: CSV_V2,
      });

      // Bills that must NOT download, on their own run.
      await fx.newRun(RUN_EDGE);
      ({ banId: banDraft } = await fx.draftBill({
        label: "DRAFT",
        runId: RUN_EDGE,
      }));
      const unbalanced = await fx.postedBill({
        label: "UNBAL",
        runId: RUN_EDGE,
        invoiceNo: "INV00062004",
      });
      banUnbalanced = unbalanced.banId;
      await rewritePostedBill(unbalanced.customerBillId, {
        subtotal: "151.00",
      });
      const tampered = await fx.postedBill({
        label: "TAMPER",
        runId: RUN_EDGE,
        invoiceNo: "INV00062005",
      });
      banTampered = tampered.banId;
      await rewritePostedBill(tampered.customerBillId, {
        csvStamp: CSV_TAMPERED,
      });
    }, 300_000);

    afterAll(async () => {
      clearLoadedTemplateMemo();
      if (service) {
        const container = service.getContainerClient("invoice-templates");
        for (const path of uploaded) {
          await container.deleteBlob(path).catch(() => undefined);
        }
      }
      if (sql) {
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("[CRITICAL] for every posted bill: one row per line, and SUM(net_amount) as text equals subtotal", async () => {
      const posted = await sql<
        {
          ref_billing_account_id: string;
          customer_bill_id: string;
          subtotal: string;
          line_count: number;
        }[]
      >`
        SELECT cb.ref_billing_account_id, cb.customer_bill_id, cb.subtotal::text AS subtotal,
               (SELECT count(*)::int FROM billing.customer_bill_line l
                WHERE l.ref_customer_bill_id = cb.customer_bill_id
                  AND l.period_partition = cb.period_partition) AS line_count
        FROM billing.customer_bill cb
        WHERE cb.ref_bill_run_id = ${RUN} AND cb.ref_inv_document_id IS NOT NULL
        ORDER BY cb.ref_billing_account_id`;
      expect(posted).toHaveLength(3);

      for (const bill of posted) {
        const { csv } = await getPostedInvoiceCsv({
          runId: RUN,
          banId: bill.ref_billing_account_id,
        });
        const [header, ...rows] = parseInvoiceCsv(csv);
        expect(rows).toHaveLength(bill.line_count);

        const netCol = header!.indexOf("net_amount");
        expect(netCol).toBeGreaterThanOrEqual(0);
        const [sum] = await sql.begin(async (tx) => {
          await tx`CREATE TEMP TABLE csv_net (net_amount text) ON COMMIT DROP`;
          for (const row of rows) {
            await tx`INSERT INTO csv_net (net_amount) VALUES (${row[netCol]!})`;
          }
          return tx<{ total: string }[]>`
            SELECT SUM(net_amount::numeric)::text AS total FROM csv_net`;
        });
        expect(sum!.total).toBe(bill.subtotal);
      }
    });

    it("keeps raw amounts and neutralises formula text in the multi-line bill", async () => {
      const { invoiceNumber, csv } = await getPostedInvoiceCsv({
        runId: RUN,
        banId: banMulti,
      });
      expect(invoiceNumber).toBe("INV00062002");
      const [header, ...rows] = parseInvoiceCsv(csv);
      const col = (h: string) => header!.indexOf(h);
      expect(rows.map((r) => r[col("line_no")])).toEqual(["1", "2", "3", "4"]);
      expect(rows.map((r) => r[col("net_amount")])).toEqual([
        "1234.50",
        "0.01",
        "-12.50",
        "99999.99",
      ]);
      expect(rows[2]![col("description")]).toBe(
        `'=HYPERLINK("http://evil.example","credit")`,
      );
      expect(rows[3]![col("description")]).toBe('Dark fibre "core" lease');
      expect(rows[0]![col("invoice_number")]).toBe("INV00062002");
      // No per-line tax column (Inv #50).
      expect(header!.some((h) => /tax/i.test(h))).toBe(false);
    });

    it("a pre-bm54 bill with a NULL stamp uses the default (v1) map", async () => {
      const { csv } = await getPostedInvoiceCsv({
        runId: RUN,
        banId: banNullStamp,
      });
      const [header] = parseInvoiceCsv(csv);
      expect(header).toHaveLength(26);
      expect(header![0]).toBe("invoice_number");
    });

    it("a bill stamped with a fixture CSV v2 uses v2's columns", async () => {
      const { csv } = await getPostedInvoiceCsv({ runId: RUN, banId: banV2 });
      const [header, ...rows] = parseInvoiceCsv(csv);
      expect(header).toEqual(V2_COLUMNS.map((c) => c.header));
      expect(rows).toEqual([
        ["INV00062003", "1", "1234.50"],
        ["INV00062003", "2", "0.01"],
        ["INV00062003", "3", "-12.50"],
      ]);
    });

    it("a tampered map blob fails TEMPLATE_CHECKSUM_MISMATCH (the route's 500)", async () => {
      const err = await errorOf(
        getPostedInvoiceCsv({ runId: RUN_EDGE, banId: banTampered }),
      );
      expect(err).toBeInstanceOf(InvoiceRenderError);
      expect((err as InvoiceRenderError).code).toBe(
        "TEMPLATE_CHECKSUM_MISMATCH",
      );
    });

    it("an unposted bill is not found (the route's 404)", async () => {
      expect(
        await errorOf(
          getPostedInvoiceCsv({ runId: RUN_EDGE, banId: banDraft }),
        ),
      ).toBeInstanceOf(FinalInvoiceNotFoundError);
      expect(
        await errorOf(
          getPostedInvoiceCsv({ runId: RUN_EDGE, banId: "BAN99999999" }),
        ),
      ).toBeInstanceOf(FinalInvoiceNotFoundError);
    });

    it("an unbalanced bill fails INVOICE_RECONCILIATION_FAILED, never adjusted (the route's 409)", async () => {
      const err = await errorOf(
        getPostedInvoiceCsv({ runId: RUN_EDGE, banId: banUnbalanced }),
      );
      expect(err).toBeInstanceOf(InvoiceRenderError);
      expect((err as InvoiceRenderError).code).toBe(
        "INVOICE_RECONCILIATION_FAILED",
      );
    });
  },
);
