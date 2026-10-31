import { readFileSync } from "node:fs";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "@/db/client";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  dropAppSchemas,
  parseReportCsv,
  reportingDbEnv,
  reportingRuntimeReady,
  resetReportingDatabase,
  runReport,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";
import type { ReportRun } from "@/tests/helpers/reporting-harness";
import {
  INVOICE_DAY,
  MNO,
  NEXT_DAY,
  PRODUCT,
  seedInvoiceCsvFixture,
} from "@/tests/fixtures/reporting/invoice-csv-seed";
import type {
  InvoiceCsvFixture,
  PostedInvoice,
} from "@/tests/fixtures/reporting/invoice-csv-seed";

// Posting's post-commit PDF render is a separate step that never affects the
// posted rows (bm19 D10); the seed doesn't need it, and the parity case reads
// the capacity detail directly.
vi.mock("@/services/billing/render-invoice", () => ({
  renderFinalInvoice: vi.fn(async () => {
    throw new Error("rpt08 seed: invoice PDFs are not rendered");
  }),
}));

// rpt08-spec Tests — the invoice CSV (Part D) against a seeded LIVE database:
// R08-T1 (parity with the PDF's capacity detail, guardrail 6), R08-T3, R08-T5,
// R08-T6, R08-T7, and the IC1/IC4/IC14–IC17 behaviour of the runtime. The
// seed builds every invoice through the real bill-run path
// (tests/fixtures/reporting/invoice-csv-seed.ts). R08-T2, R08-T8, R08-T9 and the
// builder's other skip reasons are DB-free (rpt08-guardrails.test.ts); R08-T4
// is in tests/db/reporting-db-roles.integration.test.ts; the flow cases are
// rpt08-invoice-csv-flow.live.test.ts.
//
// DATABASE_URL must be a SUPERUSER connection on a THROWAWAY cluster: the
// suite drops and re-migrates every schema and sets reporting_runtime's
// password to a test value (roles are cluster-level).
const databaseUrl = process.env.DATABASE_URL;
const ready = reportingRuntimeReady();

const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/invoice-csv/expected",
);
const fileName = (mno: string, day: string) => `R${mno}${day}.csv`;
const P_FILE = fileName(MNO.P, INVOICE_DAY);
const Q_FILE = fileName(MNO.Q, INVOICE_DAY);

const HEADER = [
  "MNO_ID",
  "Commercial Unit",
  "Polygon Public Key",
  "Usage Amount",
  "Polygon Subscription Date",
  "Invoice reference Number",
  "Transaction Entry Date",
  "Invoice Amount",
  "Product Type",
  "Usage_Mbps",
];

const errors = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "ERROR").map((l) => l.message);
const warnings = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "WARN").map((l) => l.message);

// A file's data rows (header dropped).
const rows = (run: ReportRun, name: string) =>
  parseReportCsv(run.files[name]!).slice(1);

// The rows of one invoice: [polygon, usage amount, mbps].
function invoiceRows(run: ReportRun, name: string, invoiceId: string) {
  return rows(run, name)
    .filter((r) => r[5] === invoiceId)
    .map((r) => [r[2], r[3], r[9]]);
}

// common/polygon_lines.py's rows for one bill, as reporting_runtime.
const POLYGON_LINES = `import json, sys
from datetime import date
from runtime.reporting.common import db, polygon_lines
run, ban, attempt, bill, partition = sys.argv[1:6]
scope = polygon_lines.BillScope(run, ban, int(attempt), bill, date.fromisoformat(partition))
with db.read_snapshot() as conn:
    rows = polygon_lines.read_polygon_lines(conn, [scope])
print(json.dumps([{"udrId": r.udr_id, "polygonId": r.polygon_id,
                   "polygonStartDate": r.polygon_start_date,
                   "capacityMbps": str(r.capacity_mbps), "amount": str(r.amount)} for r in rows]))`;

describe.skipIf(!databaseUrl || !ready)(
  "rpt08 invoice CSV (requires a superuser DATABASE_URL and the reporting runtime)",
  { timeout: 60_000 },
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceCsvFixture;
    let env: Record<string, string>;
    let empty: ReportRun; // before the seed
    let main: ReportRun; // 20261005

    const invoiceCsv = (day: string, extra: Record<string, string> = {}) =>
      runReport("invoice_csv", [`--invoice-date=${day}`], {
        ...env,
        ...extra,
      });
    const inv = (name: string) => fx.invoices[name]!.invoiceId;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await resetReportingDatabase(databaseUrl as string, sql);
      env = reportingDbEnv(databaseUrl as string);
      empty = invoiceCsv(INVOICE_DAY);
      fx = await seedInvoiceCsvFixture(sql);
      main = invoiceCsv(INVOICE_DAY);
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        if (!process.env.RPT08_KEEP_SEED) await dropAppSchemas(sql);
        await sql.end();
      }
    }, 120_000);

    it("20261005 ends WARNING with one file per MNO (P, Q), each matching the expected CSV byte for byte", () => {
      expect(main.status, main.stderr).toBe(0);
      expect(errors(main)).toEqual([]);
      expect(Object.keys(main.files).sort()).toEqual([P_FILE, Q_FILE]);
      for (const name of [P_FILE, Q_FILE]) {
        expect(main.files[name], name).toBe(
          readFileSync(join(EXPECTED, name), "utf8"),
        );
        expect(parseReportCsv(main.files[name]!)[0]).toEqual(HEADER);
      }
      expect(main.outputs).toEqual({
        files: [P_FILE, Q_FILE],
        files_written: 2,
        invoices: 3,
        skipped_invoices: 4,
        status: "WARNING",
      });
    });

    it("IC15/IC16 — one SKIPPED line per skipped invoice, in invoice order; an MNO with every invoice skipped (MNO-R, MNO-T) gets no file", () => {
      const expected = [
        [inv("R1"), "POLYGON_ID_MISSING"],
        [inv("R2"), "COMMERCIAL_UNIT_MISSING"],
        [inv("S1"), "MNO_PUBLIC_KEY_MISSING"],
        [inv("T1"), "NO_POLYGON_LINES"],
      ]
        .sort(([a], [b]) => (a! < b! ? -1 : 1))
        .map(([id, reason]) => `SKIPPED ${id} ${reason}`);
      expect(warnings(main)).toEqual(expected);
      const all = Object.values(main.files).join("");
      for (const name of ["R1", "R2", "S1", "T1"])
        expect(all, name).not.toContain(inv(name));
    });

    it("R08-T1 — [guardrail 6, R-T12] for each seeded posted bill, polygon_lines.py's rows equal ratedLinesRepository.listCapacityDetailForInvoice", async () => {
      const db = drizzle(sql, { schema }) as unknown as Database;
      const counts: Record<string, number> = {};
      for (const [name, bill] of Object.entries(fx.invoices)) {
        const ts = await ratedLinesRepository.listCapacityDetailForInvoice(db, {
          ...scope(bill),
          limit: 10_000,
        });
        if (ts.overLimit) throw new Error(`${name}: over the limit`);
        counts[name] = ts.rows.length;
        const py = runReportingPython(
          [
            "-c",
            POLYGON_LINES,
            bill.runId,
            bill.banId,
            String(bill.attempt),
            bill.customerBillId,
            bill.periodPartition,
          ],
          { env },
        );
        expect(py.status, py.stderr).toBe(0);
        const byUdr = (list: { udrId: string }[]) =>
          [...list].sort((a, b) => (a.udrId < b.udrId ? -1 : 1));
        expect(byUdr(JSON.parse(py.stdout)), name).toEqual(
          byUdr(
            ts.rows.map((r) => ({
              udrId: r.udrId,
              polygonId: r.polygonId,
              polygonStartDate: r.polygonStartDate,
              capacityMbps: r.capacityMbps,
              amount: r.amount,
            })),
          ),
        );
      }
      // Not vacuous: every bill but T1 has polygon rows (P1's GB row is not one).
      expect(counts).toEqual({
        P2: 1,
        P1: 3,
        Q1: 2,
        Q2: 1,
        R1: 1,
        R2: 1,
        S1: 1,
        T1: 0,
      });
    });

    it('R08-T3 — a claimed row billed on an ordinary USAGE line ("Other charges") gets no row', async () => {
      const [other] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${fx.invoices.P1!.customerBillId}
          AND line_type = 'charge' AND grouping_key NOT LIKE '%:CAPACITY:%' AND unit = 'GB'`;
      expect(other?.n).toBe(1);
      expect(main.files[P_FILE]).not.toContain("PCU-OTHER-GB");
      expect(main.files[P_FILE]).not.toContain("CU-OTHER");
    });

    it("R08-T5 — two bill runs, one MNO, one day: one file, invoices sorted by Invoice reference Number, then Polygon Public Key", () => {
      expect(fx.invoices.P1!.runId).not.toBe(fx.invoices.P2!.runId);
      const ids = rows(main, P_FILE).map((r) => r[5]);
      expect([...new Set(ids)]).toEqual([inv("P2"), inv("P1")]);
      expect(inv("P2") < inv("P1")).toBe(true);
      // P2's only polygon (PCU-P-0004) sorts after P1's: the invoice comes first.
      expect(rows(main, P_FILE)[0]![2]).toBe("PCU-P-0004");
    });

    it("R08-T6 — a 100.00 line discount over 500.00 / 300.00 / 200.00: each usage row followed by its discount row, -50.00 / -30.00 / -20.00, Usage_Mbps blank", async () => {
      const [line] = await sql<
        { discount_amount: string; rated_amount: string }[]
      >`
        SELECT discount_amount::text, rated_amount::text FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${fx.invoices.P1!.customerBillId}
          AND grouping_key LIKE '%:CAPACITY:%'`;
      expect(line).toEqual({
        discount_amount: "100.00",
        rated_amount: "1000.00",
      });
      expect(invoiceRows(main, P_FILE, inv("P1"))).toEqual([
        ["PCU-P-0001", "500.00", "5.00"],
        ["PCU-P-0001", "-50.00", ""],
        ["PCU-P-0002", "300.00", "3.00"],
        ["PCU-P-0002", "-30.00", ""],
        ["PCU-P-0003", "200.00", "2.00"],
        ["PCU-P-0003", "-20.00", ""],
      ]);
      // The discount row repeats every other column of its usage row.
      const p1 = rows(main, P_FILE).filter((r) => r[5] === inv("P1"));
      for (let i = 0; i < p1.length; i += 2) {
        const pick = (r: string[]) => [0, 1, 2, 4, 5, 6, 7, 8].map((c) => r[c]);
        expect(pick(p1[i + 1]!)).toEqual(pick(p1[i]!));
      }
    });

    it("R08-T7 — a capacity line with discount_amount 0.00 gives usage rows only", async () => {
      const [line] = await sql<{ discount_amount: string }[]>`
        SELECT discount_amount::text FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${fx.invoices.P2!.customerBillId}
          AND grouping_key LIKE '%:CAPACITY:%'`;
      expect(line?.discount_amount).toBe("0.00");
      expect(invoiceRows(main, P_FILE, inv("P2"))).toEqual([
        ["PCU-P-0004", "250.00", "2.50"],
      ]);
    });

    it("rpt08 D8 — a discount that doesn't split evenly is apportioned half-up with the remainder on the last polygon, adding up to the line's discount", () => {
      expect(invoiceRows(main, Q_FILE, inv("Q1"))).toEqual([
        ["PCU-Q-0001", "100.00", "1.00"],
        ["PCU-Q-0001", "-2.22", ""],
        ["PCU-Q-0002", "125.00", "1.25"],
        ["PCU-Q-0002", "-2.78", ""],
      ]);
    });

    it("IC7–IC10 — MNO_ID, Invoice Amount (the INV's total_amount on every row), Transaction Entry Date, Product Type, Polygon Subscription Date", async () => {
      const totals = await sql<{ document_id: string; total_amount: string }[]>`
        SELECT document_id, total_amount::text FROM billing.document
        WHERE document_id = ANY(${sql.array([inv("P1"), inv("P2"), inv("Q1")])})`;
      const total = Object.fromEntries(
        totals.map((t) => [t.document_id, t.total_amount]),
      );
      for (const [name, mno] of [
        [P_FILE, MNO.P],
        [Q_FILE, MNO.Q],
      ] as const) {
        for (const r of rows(main, name)) {
          expect(r[0]).toBe(mno);
          expect(r[6]).toBe(INVOICE_DAY);
          expect(r[7]).toBe(total[r[5]!]);
        }
      }
      const p = rows(main, P_FILE);
      expect(p.find((r) => r[5] === inv("P2"))![8]).toBe(PRODUCT.fwa);
      expect(p.find((r) => r[5] === inv("P1"))![8]).toBe(PRODUCT.embb);
      expect(p.find((r) => r[2] === "PCU-P-0002")![4]).toBe("20250415");
      expect(p.find((r) => r[2] === "PCU-P-0001")![1]).toBe("CU-P-1");
    });

    describe("[Inv 8] an invoice posted 23:59 and one posted 00:01 Asia/Kuala_Lumpur fall on different invoice dates, whatever the session time zone", () => {
      for (const tz of ["UTC", "Asia/Kuala_Lumpur", "Pacific/Kiritimati"]) {
        it(`PGTZ=${tz}`, () => {
          const on = invoiceCsv(INVOICE_DAY, { PGTZ: tz });
          const next = invoiceCsv(NEXT_DAY, { PGTZ: tz });
          expect(on.files[Q_FILE]).toBe(main.files[Q_FILE]);
          expect(on.files[Q_FILE]).toContain(inv("Q1"));
          expect(on.files[Q_FILE]).not.toContain(inv("Q2"));
          expect(next.status, next.stderr).toBe(0);
          expect(Object.keys(next.files)).toEqual([fileName(MNO.Q, NEXT_DAY)]);
          expect(
            invoiceRows(next, fileName(MNO.Q, NEXT_DAY), inv("Q2")),
          ).toEqual([["PCU-Q-0003", "100.00", "1.00"]]);
          expect(next.outputs).toMatchObject({
            skipped_invoices: 0,
            status: "SUCCESS",
          });
        });
      }
    });

    it("IC17 — no invoices that day: no files, INFO NO_INVOICES_ON <invoice_date>, SUCCESS (before the seed, and on a day nothing was posted)", () => {
      for (const [run, day] of [
        [empty, INVOICE_DAY],
        [invoiceCsv("20261004"), "20261004"],
      ] as const) {
        expect(run.status, run.stderr).toBe(0);
        expect(run.files).toEqual({});
        expect(run.logs).toContainEqual({
          level: "INFO",
          message: `NO_INVOICES_ON ${day}`,
        });
        expect(run.outputs).toEqual({
          files: [],
          files_written: 0,
          invoices: 0,
          skipped_invoices: 0,
          status: "SUCCESS",
        });
      }
    });

    it("IC17 — invoices exist but all are skipped: WARNING, no files", async () => {
      const keyed = [fx.invoices.P1!, fx.invoices.P2!, fx.invoices.Q1!];
      const before = await sql<{ id: string; spec: Record<string, string> }[]>`
        SELECT pr.party_role_id AS id, pr.party_role_specification AS spec
        FROM customer.party_role pr
        JOIN billing.billing_account ba ON ba.ref_party_role_id = pr.party_role_id
        WHERE ba.billing_account_id = ANY(${sql.array(keyed.map((b) => b.banId))})`;
      try {
        for (const { id } of before)
          await sql`UPDATE customer.party_role SET party_role_specification = '{}'::jsonb WHERE party_role_id = ${id}`;
        const run = invoiceCsv(INVOICE_DAY);
        expect(run.status, run.stderr).toBe(0);
        expect(run.files).toEqual({});
        expect(run.outputs).toEqual({
          files: [],
          files_written: 0,
          invoices: 0,
          skipped_invoices: 7,
          status: "WARNING",
        });
      } finally {
        for (const { id, spec } of before)
          await sql`UPDATE customer.party_role SET party_role_specification = ${JSON.stringify(spec)}::jsonb WHERE party_role_id = ${id}`;
      }
    });

    it("Inv 7 — two runs for the same date give byte-identical files", () => {
      const again = invoiceCsv(INVOICE_DAY);
      expect(again.files).toEqual(main.files);
    });

    it("IC14 — a malformed date fails INVALID_INVOICE_DATE and writes nothing", () => {
      const run = invoiceCsv("20261332");
      expect(run.status).not.toBe(0);
      expect(errors(run)).toEqual(["INVALID_INVOICE_DATE 20261332"]);
      expect(run.files).toEqual({});
    });
  },
);

function scope(bill: PostedInvoice) {
  return {
    runId: bill.runId,
    banId: bill.banId,
    attempt: bill.attempt,
    customerBillId: bill.customerBillId,
    periodPartition: bill.periodPartition,
  };
}
