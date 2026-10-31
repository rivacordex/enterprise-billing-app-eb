import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allocatePayment } from "@/services/accounts/allocate-payment";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  dropAppSchemas,
  parseKestraLines,
  parseReportCsv,
  REPORTING_CONTRACTS_DIR,
  reportingDbEnv,
  reportingRuntimeReady,
  resetReportingDatabase,
  runReport,
  runReportingPython,
  spawnReportingPython,
} from "@/tests/helpers/reporting-harness";
import type { ReportRun } from "@/tests/helpers/reporting-harness";
import {
  klDay,
  MNO,
  seedSettlementFixture,
} from "@/tests/fixtures/reporting/settlement-seed";
import type { SettlementFixture } from "@/tests/fixtures/reporting/settlement-seed";

// rpt03-spec Tests — the settlement reports (Part A) against a seeded LIVE
// database (plan §A.4 T1–T16, T18, T20, T21; R03-T1, R03-T2, R03-T4). The
// runtime runs as a subprocess, connected as `reporting_runtime`
// (tests/helpers/reporting-harness.ts); the seed posts every document through
// the real Accounts services (tests/fixtures/reporting/settlement-seed.ts).
// The Kestra cases (T17, T19, the WARNING path) are
// rpt03-settlement-flow.live.test.ts; R03-T3 is rpt03-guardrails.test.ts and
// R03-T5 is tests/db/reporting-db-roles.integration.test.ts.
//
// DATABASE_URL must be a SUPERUSER connection on a THROWAWAY cluster: the
// suite drops and re-migrates every schema and sets reporting_runtime's
// password to a test value (roles are cluster-level).
const databaseUrl = process.env.DATABASE_URL;
const ready = reportingRuntimeReady();

const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/settlement/expected",
);
const TS = "2026-10-26T01:30:15Z"; // 20261026093015 in Asia/Kuala_Lumpur
const STAMP = "20261026093015";
const INVOICE_FILE = `Reporting_dnb_settlement_invoice_${STAMP}.csv`;
const PAYMENT_FILE = `Reporting_dnb_settlement_invoice_payment_${STAMP}.csv`;

// §A.1 — exact headers.
const INVOICE_HEADER =
  "mno_id,invoice_entry_date,invoice_id,invoice_amount,invoice_due_date,invoice_open_amount";
const PAYMENT_HEADER =
  "mno_id,payment_transaction_no,type_of_payment,payment_amount,invoice_id,payment_reference,cheque_realization_date,comment";

const expectedFile = (name: string) =>
  readFileSync(join(EXPECTED, name), "utf8");

type Row = Record<string, string>;
function rows(text: string): Row[] {
  const [header, ...data] = parseReportCsv(text);
  return data.map((r) =>
    Object.fromEntries(header!.map((name, i) => [name, r[i]!])),
  );
}

// Today in Asia/Kuala_Lumpur, YYYYMMDD.
function businessToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}${get("month")}${get("day")}`;
}

describe.skipIf(!databaseUrl || !ready)(
  "rpt03 settlement reports (requires a superuser DATABASE_URL and the reporting runtime)",
  { timeout: 60_000 },
  () => {
    let sql: postgresjs.Sql;
    let fx: SettlementFixture;
    let env: Record<string, string>;
    let main: ReportRun; // the default run: 202609, as of 20261031

    const settle = (
      billingPeriod: string,
      asOfDate: string,
      extra: { ts?: string; env?: Record<string, string> } = {},
    ) =>
      runReport(
        "settlement_invoice",
        [
          `--billing-period=${billingPeriod}`,
          `--as-of-date=${asOfDate}`,
          `--ts=${extra.ts ?? TS}`,
        ],
        { ...env, ...extra.env },
      );

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await resetReportingDatabase(databaseUrl as string, sql);
      fx = await seedSettlementFixture(sql);
      env = reportingDbEnv(databaseUrl as string);
      main = settle("202609", "20261031");
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        await dropAppSchemas(sql);
        await sql.end();
      }
    }, 120_000);

    const invoiceRows = () => rows(main.files[INVOICE_FILE]!);
    const paymentRows = () => rows(main.files[PAYMENT_FILE]!);
    const invoiceRow = (name: string) =>
      invoiceRows().find((r) => r.invoice_id === fx.invoices[name]);
    const paymentRowsOf = (name: string) =>
      paymentRows().filter((r) => r.invoice_id === fx.invoices[name]);
    const row = (mno: string, txn: string, invoiceId = "") =>
      paymentRows().filter(
        (r) =>
          r.mno_id === mno &&
          r.payment_transaction_no === txn &&
          r.invoice_id === invoiceId,
      );

    it("the default run (202609, as of 20261031) ends WARNING with both files, matching the expected CSVs row for row (only <ts> ignored)", () => {
      expect(main.status, main.stderr).toBe(0);
      expect(Object.keys(main.files).sort()).toEqual(
        [INVOICE_FILE, PAYMENT_FILE].sort(),
      );
      expect(main.files[INVOICE_FILE]).toBe(
        expectedFile("Reporting_dnb_settlement_invoice.csv"),
      );
      expect(main.files[PAYMENT_FILE]).toBe(
        expectedFile("Reporting_dnb_settlement_invoice_payment.csv"),
      );
      expect(main.outputs).toMatchObject({
        invoice_file: INVOICE_FILE,
        payment_file: PAYMENT_FILE,
        skipped_invoices: 1,
        status: "WARNING",
      });
    });

    it("T1 — no payments: open = invoice amount, no invoice-linked rows", () => {
      expect(invoiceRow("A1")).toMatchObject({
        invoice_amount: "1000.00",
        invoice_open_amount: "1000.00",
        invoice_entry_date: "20261005",
        invoice_due_date: "20261104",
      });
      expect(paymentRowsOf("A1")).toEqual([]);
    });

    it("T2 — zero balance: open 0.00, the row is still present", () => {
      expect(invoiceRow("A2")?.invoice_open_amount).toBe("0.00");
      expect(paymentRowsOf("A2")).toEqual([
        expect.objectContaining({
          payment_transaction_no: fx.documents.payA2,
          type_of_payment: "PAY",
          payment_amount: "500.00",
        }),
      ]);
    });

    it("T3 — partial payment: open 500.00", () => {
      expect(invoiceRow("A3")?.invoice_open_amount).toBe("500.00");
    });

    it("T4 — split receipt: two PAY rows, each with its own invoice_id; both open 0.00", () => {
      expect(paymentRowsOf("B1")).toEqual([
        expect.objectContaining({
          payment_transaction_no: fx.documents.payB1,
          type_of_payment: "PAY",
          payment_amount: "200.00",
        }),
      ]);
      expect(paymentRowsOf("B2")).toEqual([
        expect.objectContaining({
          payment_transaction_no: fx.documents.payB2,
          type_of_payment: "PAY",
          payment_amount: "300.00",
        }),
      ]);
      expect(invoiceRow("B1")?.invoice_open_amount).toBe("0.00");
      expect(invoiceRow("B2")?.invoice_open_amount).toBe("0.00");
    });

    it("T5 — allocation reversed: PAY +400.00 and REV −400.00 on the same invoice_id; open 400.00", () => {
      expect(
        paymentRowsOf("A4").map((r) => [
          r.payment_transaction_no,
          r.type_of_payment,
          r.payment_amount,
        ]),
      ).toEqual([
        [fx.documents.payA4, "PAY", "400.00"],
        [fx.documents.revA4, "REV", "-400.00"],
      ]);
      expect(invoiceRow("A4")?.invoice_open_amount).toBe("400.00");
    });

    it("T6 — refund of an allocation: REV −300.00 with invoice_id traced; open 300.00", () => {
      expect(row(MNO.B, fx.documents.refundB3!, fx.invoices.B3)).toEqual([
        expect.objectContaining({
          type_of_payment: "REV",
          payment_amount: "-300.00",
          payment_reference: "Refund to customer",
        }),
      ]);
      expect(invoiceRow("B3")?.invoice_open_amount).toBe("300.00");
    });

    it("T7 — account-level items: four rows with blank invoice_id (CRN +100, DBN −50, ADJ +20, PAY +70); open amounts unchanged", () => {
      const accountLevel = paymentRows().filter(
        (r) =>
          r.mno_id === MNO.A &&
          r.invoice_id === "" &&
          r.type_of_payment !== "UNAPPLIED",
      );
      expect(
        accountLevel.map((r) => [
          r.payment_transaction_no,
          r.type_of_payment,
          r.payment_amount,
        ]),
      ).toEqual([
        [fx.documents.adjA, "ADJ", "20.00"],
        [fx.documents.crnA, "CRN", "100.00"],
        [fx.documents.dbnA, "DBN", "-50.00"],
        [fx.documents.payA0, "PAY", "70.00"],
      ]);
      // No MNO-A invoice is reduced by them (T1–T3, T5, T10 opens above).
      expect(invoiceRow("A1")?.invoice_open_amount).toBe("1000.00");
    });

    it("T8 — unapplied cash: one UNAPPLIED +400.00 row, blank payment_transaction_no and invoice_id", () => {
      expect(
        paymentRows().filter(
          (r) => r.mno_id === MNO.A && r.type_of_payment === "UNAPPLIED",
        ),
      ).toEqual([
        {
          mno_id: MNO.A,
          payment_transaction_no: "",
          type_of_payment: "UNAPPLIED",
          payment_amount: "400.00",
          invoice_id: "",
          payment_reference: "",
          cheque_realization_date: "",
          comment: "",
        },
      ]);
    });

    it("T9 — no UNAPPLIED row for MNO-B (fully allocated) nor for MNO-D (unapplied cash, no 202609 invoice)", () => {
      expect(
        paymentRows().filter(
          (r) => r.mno_id === MNO.B && r.type_of_payment === "UNAPPLIED",
        ),
      ).toEqual([]);
      expect(paymentRows().filter((r) => r.mno_id === MNO.D)).toEqual([]);
    });

    it("T10 — cut-off: a PAY with entry_date 20261105 is excluded; open 300.00", () => {
      expect(paymentRows().map((r) => r.payment_transaction_no)).not.toContain(
        fx.documents.payA5,
      );
      expect(invoiceRow("A5")?.invoice_open_amount).toBe("300.00");
    });

    it("T11 — a PAY in pending_approval dated before the cut-off is excluded", () => {
      expect(paymentRows().map((r) => r.payment_transaction_no)).not.toContain(
        fx.documents.pendingA,
      );
    });

    it("T12 — neither the 202608 INV nor the unposted 202609 bill appears", () => {
      expect(invoiceRows().map((r) => r.invoice_id)).not.toContain(
        fx.invoices.D_aug,
      );
      expect(invoiceRows().filter((r) => r.mno_id === MNO.D)).toEqual([]);
    });

    it("T13 — missing MNO key: the invoice and every MNO-C row are absent; SKIPPED line; skipped_invoices=1; WARNING", () => {
      const ids = [...invoiceRows(), ...paymentRows()].flatMap((r) => [
        r.invoice_id,
        r.payment_transaction_no,
      ]);
      for (const id of [
        fx.invoices.C1,
        fx.documents.payC1,
        fx.documents.crnC,
        fx.documents.captureC,
      ])
        expect(ids).not.toContain(id);
      expect(main.logs).toEqual([
        {
          level: "WARN",
          message: `SKIPPED ${fx.invoices.C1} MNO_PUBLIC_KEY_MISSING`,
        },
      ]);
      expect(main.outputs.skipped_invoices).toBe(1);
      expect(main.outputs.status).toBe("WARNING");
    });

    it("an INV with no posted_at is skipped INVOICE_POSTED_AT_MISSING, with the run WARNING (SR27)", () => {
      const run = settle("202607", "20261031");
      expect(run.status, run.stderr).toBe(0);
      expect(run.logs).toEqual([
        {
          level: "WARN",
          message: `SKIPPED ${fx.invoices.A_jul_fault} INVOICE_POSTED_AT_MISSING`,
        },
      ]);
      expect(rows(run.files[INVOICE_FILE]!).map((r) => r.invoice_id)).toEqual([
        fx.invoices.A_jul,
      ]);
      expect(run.outputs).toMatchObject({
        skipped_invoices: 1,
        status: "WARNING",
      });
    });

    describe("T14 — per-invoice check (SR19)", () => {
      it("holds for every invoice: amount − Σ invoice-linked payment_amount = open", () => {
        const paid = new Map<string, number>();
        for (const r of paymentRows())
          if (r.invoice_id)
            paid.set(
              r.invoice_id,
              (paid.get(r.invoice_id) ?? 0) +
                Math.round(Number(r.payment_amount) * 100),
            );
        for (const r of invoiceRows())
          expect(
            Math.round(Number(r.invoice_amount) * 100) -
              (paid.get(r.invoice_id!) ?? 0),
            r.invoice_id,
          ).toBe(Math.round(Number(r.invoice_open_amount) * 100));
      });

      it("a deliberately corrupted open amount fails OUTPUT_CONTRACT_VIOLATION … PER_INVOICE_CHECK and writes no file", () => {
        const outDir = mkdtempSync(join(tmpdir(), "rpt03-t14-"));
        const run = runReportingPython(
          [
            "-c",
            `import sys
from decimal import Decimal
from runtime.reporting.common import receivables
from runtime.reporting.settlement_invoice import __main__ as m
orig = receivables.open_amount
def corrupt(amount, effects):
    value = orig(amount, effects)
    return value + Decimal("0.01") if amount == Decimal("1000.00") else value
receivables.open_amount = corrupt
sys.exit(m.main(sys.argv[1:]))`,
            "--billing-period=202609",
            "--as-of-date=20261031",
            `--ts=${TS}`,
            `--out-dir=${outDir}`,
            `--contracts-dir=${REPORTING_CONTRACTS_DIR}`,
          ],
          { cwd: outDir, env },
        );
        expect(run.status).toBe(1);
        expect(parseKestraLines(run.stdout).logs).toContainEqual({
          level: "ERROR",
          // A1 sorts first: file line 2.
          message: `OUTPUT_CONTRACT_VIOLATION ${INVOICE_FILE} 2 invoice_open_amount PER_INVOICE_CHECK`,
        });
        expect(readdirSync(outDir)).toEqual([]);
      });
    });

    it("T15 — empty period: FAILED NO_INVOICES_FOR_PERIOD 203001; no files", () => {
      // The runtime directly: through the flow, 203001 fails INVALID_AS_OF_DATE
      // at validate_period until 2030 (as_of can't be in the future, nor
      // before the period's first day — SR25), so the flow-reachable empty
      // period is a past one (below).
      const run = settle("203001", "20300131");
      expect(run.status).toBe(1);
      expect(run.logs).toEqual([
        { level: "ERROR", message: "NO_INVOICES_FOR_PERIOD 203001" },
      ]);
      expect(run.files).toEqual({});
      const past = settle("202501", "20261031");
      expect(past.status).toBe(1);
      expect(past.logs).toEqual([
        { level: "ERROR", message: "NO_INVOICES_FOR_PERIOD 202501" },
      ]);
      expect(past.files).toEqual({});
    });

    it("T16 — all skipped: a period whose only invoices belong to MNO-C fails ALL_INVOICES_EXCEPTED; no files", () => {
      const run = settle("202605", "20261031");
      expect(run.status).toBe(1);
      expect(run.logs).toEqual([
        {
          level: "WARN",
          message: `SKIPPED ${fx.invoices.C_may} MNO_PUBLIC_KEY_MISSING`,
        },
        { level: "ERROR", message: "ALL_INVOICES_EXCEPTED" },
      ]);
      expect(run.files).toEqual({});
    });

    describe("T18 — output format", () => {
      it("exact headers and order; YYYYMMDD; 2 dp; no spaces after commas; a payment_reference with a comma is quoted", () => {
        const invoice = main.files[INVOICE_FILE]!;
        const payment = main.files[PAYMENT_FILE]!;
        expect(invoice.split("\n")[0]).toBe(INVOICE_HEADER);
        expect(payment.split("\n")[0]).toBe(PAYMENT_HEADER);
        for (const text of [invoice, payment]) {
          // The writer adds no space after a separator: no unquoted field
          // starts with one (the quoted references keep their own).
          for (const line of text.split("\n").filter(Boolean))
            for (const field of line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/))
              expect(field.startsWith(" "), line).toBe(false);
          expect(text).not.toContain("\r");
          expect(text.charCodeAt(0)).not.toBe(0xfeff);
          expect(text.endsWith("\n")).toBe(true);
        }
        for (const r of invoiceRows()) {
          expect(r.invoice_entry_date).toMatch(/^\d{8}$/);
          expect(r.invoice_amount).toMatch(/^-?\d+\.\d{2}$/);
        }
        expect(payment).toContain(
          `${MNO.B},${fx.documents.payB1},PAY,200.00,${fx.invoices.B1},"Receipt 889, part 1",,\n`,
        );
      });

      it("exactly two files sharing one <ts>; no exceptions file", () => {
        expect(Object.keys(main.files).sort()).toEqual(
          [
            `Reporting_dnb_settlement_invoice_${STAMP}.csv`,
            `Reporting_dnb_settlement_invoice_payment_${STAMP}.csv`,
          ].sort(),
        );
      });

      it("a clean run reports skipped_invoices=0 and SUCCESS", () => {
        const run = settle("202606", "20260731");
        expect(run.status, run.stderr).toBe(0);
        expect(run.logs).toEqual([]);
        expect(run.outputs).toMatchObject({
          skipped_invoices: 0,
          status: "SUCCESS",
        });
      });
    });

    it("R03-T1 — for every line in the seed, the receivables effect has the sign the plan's SR18 table predicts (reversed allocation, refund release, DBN with tax, rounding both ways)", () => {
      const bans = Object.values(fx.accounts).map((a) => a.billingAccountId);
      const fas = Object.values(fx.accounts).map((a) => a.financialAccountId);
      const run = runReportingPython(
        [
          "-c",
          `import json, sys
from datetime import date
from decimal import Decimal
from runtime.reporting.common import db, receivables
bans, fas = json.loads(sys.argv[1]), json.loads(sys.argv[2])
end = date(9999, 12, 31)
with db.read_snapshot() as conn:
    snap = receivables.read_ledger(conn, bans, fas)
effects = {}
for e in receivables.receivables_effects(snap, bans, end):
    effects[e.line.document_line_id] = effects.get(e.line.document_line_id, Decimal("0")) + e.amount
out = []
for line in snap.lines:
    alone = receivables.LedgerSnapshot((line,), snap.receivables_accounts, snap.unapplied_accounts)
    out.append({"doc": line.document_id, "doc_type": line.doc_type, "line_kind": line.line_kind,
                "reversal_of": line.reversal_of, "amount": str(line.amount),
                "payment": str(receivables.payment_amount(effects.get(line.document_line_id, Decimal("0")))),
                "held": str(receivables.unapplied_held(alone, fas, end))})
print(json.dumps(out))`,
          JSON.stringify(bans),
          JSON.stringify(fas),
        ],
        { env },
      );
      expect(run.status, run.stderr).toBe(0);
      const lines = JSON.parse(run.stdout) as {
        doc: string;
        doc_type: string;
        line_kind: string;
        reversal_of: string | null;
        amount: string;
        payment: string;
        held: string;
      }[];

      // SR18's table, as the expected result (rpt03 D1) — payment_amount sign
      // per (doc_type, line_kind); INV (not in the table) raises what is owed.
      const PAYMENT_SIGN: Record<string, number> = {
        "INV:charge": -1,
        "INV:release": -1,
        "PAY:capture": 0,
        "PAY:allocation": 1,
        "PAY:release": -1,
        "PAY:refund": 0,
        "CRN:charge": 1,
        "DBN:charge": -1,
        "DBN:release": -1,
        "ADJ:charge": 1,
        "ADJ:release": -1,
      };
      // Unapplied cash held: captures add, allocations apply, a refund's
      // release returns cash to the pool and its payout pays it out.
      const HELD_SIGN: Record<string, number> = {
        "PAY:capture": 1,
        "PAY:allocation": -1,
        "PAY:release": 1,
        "PAY:refund": -1,
      };
      const sign = (s: string) => Math.sign(Number(s));
      for (const l of lines) {
        const key = `${l.doc_type}:${l.line_kind}`;
        const flip = l.reversal_of ? -1 : 1; // REV: opposite of what it reverses
        const expectedPayment = (PAYMENT_SIGN[key] ?? 0) * flip;
        const expectedHeld = (HELD_SIGN[key] ?? 0) * flip;
        expect(sign(l.payment), `${l.doc} ${key} payment`).toBe(
          expectedPayment,
        );
        expect(sign(l.held), `${l.doc} ${key} held`).toBe(expectedHeld);
        if (expectedPayment !== 0)
          expect(Math.abs(Number(l.payment)), l.doc).toBe(Number(l.amount));
        if (expectedHeld !== 0)
          expect(Math.abs(Number(l.held)), l.doc).toBe(Number(l.amount));
      }
      // The seed covers every case the spec names.
      const has = (doc: string, kind: string) =>
        lines.some((l) => l.doc === doc && l.line_kind === kind);
      expect(has(fx.documents.revA4!, "allocation")).toBe(true); // reversed allocation
      expect(has(fx.documents.refundB3!, "release")).toBe(true); // refund release
      expect(has(fx.documents.dbnE!, "release")).toBe(true); // DBN tax line
      expect(has(fx.documents.roundE_up!, "release")).toBe(true); // rounding up
      expect(has(fx.documents.roundE_down!, "charge")).toBe(true); // rounding down
    });

    it("R03-T2 — two runs with the same inputs produce identical files apart from <ts>", () => {
      const again = settle("202609", "20261031", {
        ts: "2026-10-27T03:00:00Z",
      });
      expect(again.status, again.stderr).toBe(0);
      expect(
        again.files["Reporting_dnb_settlement_invoice_20261027110000.csv"],
      ).toBe(main.files[INVOICE_FILE]);
      expect(
        again.files[
          "Reporting_dnb_settlement_invoice_payment_20261027110000.csv"
        ],
      ).toBe(main.files[PAYMENT_FILE]);
    });

    it("R03-T4 — [guardrail 4] INVs posted 23:59 and 00:01 Asia/Kuala_Lumpur get different invoice_entry_dates, under session time zones UTC and Asia/Kuala_Lumpur", () => {
      const results: string[] = [];
      for (const tz of ["UTC", "Asia/Kuala_Lumpur"]) {
        const shown = runReportingPython(
          [
            "-c",
            "from runtime.reporting.common import db\nwith db.read_snapshot() as c:\n    print(c.execute('SHOW TimeZone').fetchone()[0])",
          ],
          { env: { ...env, PGTZ: tz } },
        );
        expect(shown.stdout.trim(), shown.stderr).toBe(tz);
        const run = settle("202606", "20260731", { env: { PGTZ: tz } });
        expect(run.status, run.stderr).toBe(0);
        const byId = Object.fromEntries(
          rows(run.files[INVOICE_FILE]!).map((r) => [
            r.invoice_id,
            r.invoice_entry_date,
          ]),
        );
        expect(byId[fx.invoices.B_late!], tz).toBe("20260704");
        expect(byId[fx.invoices.B_early!], tz).toBe("20260705");
        results.push(run.files[INVOICE_FILE]!);
      }
      expect(results[0]).toBe(results[1]);
    });

    it("T21 — as_of_date = today: each MNO's UNAPPLIED amount equals −balance of its unapplied_cash account in pgledger_accounts_view (MNOs with no document dated after today)", async () => {
      const today = businessToday();
      const run = settle("202609", today);
      expect(run.status, run.stderr).toBe(0);
      const unapplied = new Map(
        rows(run.files[PAYMENT_FILE]!)
          .filter((r) => r.type_of_payment === "UNAPPLIED")
          .map((r) => [r.mno_id, r.payment_amount]),
      );
      let compared = 0;
      for (const [key, mno] of [
        ["A", MNO.A],
        ["B", MNO.B],
        ["E", MNO.E],
      ] as const) {
        const fa = fx.accounts[key].financialAccountId;
        const [state] = await sql<{ later: number; held: string }[]>`
          SELECT (SELECT count(*)::int FROM billing.document d
                  WHERE d.ref_financial_account_id = ${fa}
                    AND (d.entry_date AT TIME ZONE 'Asia/Kuala_Lumpur')::date > to_date(${today}, 'YYYYMMDD')) AS later,
                 (SELECT (-a.balance)::numeric(18,2)::text FROM billing.ledger_binding lb
                  JOIN billing.pgledger_accounts_view a ON a.id = lb.pgledger_account_id
                  WHERE lb.owner_type = 'financial_account' AND lb.owner_id = ${fa}
                    AND lb.ledger_role = 'unapplied_cash') AS held
        `;
        if (state!.later > 0) continue; // backdated-after-today documents (T10's)
        expect(unapplied.get(mno) ?? "0.00", mno).toBe(
          state!.held === "-0.00" ? "0.00" : state!.held,
        );
        compared += 1;
      }
      // MNO-E holds 49.99, so the comparison is never only 0 = 0.
      expect(unapplied.get(MNO.E)).toBe("49.99");
      expect(compared).toBeGreaterThanOrEqual(2);
    });

    // Last: it posts a document, which the cases above must not see.
    it("T20 — consistent read: a PAY posted from a second connection while extract runs appears in neither file; a later run shows it in both", async () => {
      const outDir = mkdtempSync(join(tmpdir(), "rpt03-t20-"));
      const gate = join(outDir, "..", `rpt03-t20-gate-${Date.now()}`);
      // Holds the run inside its snapshot (after the invoice query, before
      // the ledger read) until the gate file exists.
      const child = spawnReportingPython(
        [
          "-c",
          `import sys, time
from pathlib import Path
from runtime.reporting.common import receivables
from runtime.reporting.settlement_invoice import __main__ as m
gate = Path(sys.argv[1])
orig = receivables.read_ledger
def gated(conn, *args, **kwargs):
    print("::GATE::", flush=True)
    for _ in range(1200):
        if gate.exists():
            break
        time.sleep(0.05)
    return orig(conn, *args, **kwargs)
receivables.read_ledger = gated
sys.exit(m.main(sys.argv[2:]))`,
          gate,
          "--billing-period=202609",
          "--as-of-date=20261031",
          `--ts=${TS}`,
          `--out-dir=${outDir}`,
          `--contracts-dir=${REPORTING_CONTRACTS_DIR}`,
        ],
        { cwd: outDir, env },
      );
      let stdout = "";
      let stderr = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const exited = new Promise<number | null>((resolve) =>
        child.on("close", resolve),
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d: Buffer) => {
          stdout += d.toString();
          if (stdout.includes("::GATE::")) resolve();
        });
        child.on("close", () =>
          reject(new Error(`runtime exited before the gate: ${stderr}`)),
        );
      });

      const posted = await allocatePayment(
        {
          financialAccountId: fx.accounts.A.financialAccountId,
          billingAccountId: fx.accounts.A.billingAccountId,
          amount: "250.00",
          refSettledDocumentId: fx.invoices.A1!,
          eventAt: klDay("2026-10-21"),
          entryDate: klDay("2026-10-21"),
          referenceInfo: "T20 concurrent PAY",
        },
        fx.actorId,
      );
      expect(posted.ok).toBe(true);
      if (!posted.ok) return;
      expect(posted.value.state).toBe("posted");
      writeFileSync(gate, "");
      expect(await exited, stderr).toBe(0);

      const during = Object.fromEntries(
        readdirSync(outDir).map((n) => [
          n,
          readFileSync(join(outDir, n), "utf8"),
        ]),
      );
      expect(during[PAYMENT_FILE]).not.toContain(posted.value.documentId);
      expect(
        rows(during[INVOICE_FILE]!).find((r) => r.invoice_id === fx.invoices.A1)
          ?.invoice_open_amount,
      ).toBe("1000.00");

      const after = settle("202609", "20261031");
      expect(after.status, after.stderr).toBe(0);
      expect(
        rows(after.files[PAYMENT_FILE]!).filter(
          (r) => r.payment_transaction_no === posted.value.documentId,
        ),
      ).toEqual([
        expect.objectContaining({
          invoice_id: fx.invoices.A1,
          payment_amount: "250.00",
        }),
      ]);
      expect(
        rows(after.files[INVOICE_FILE]!).find(
          (r) => r.invoice_id === fx.invoices.A1,
        )?.invoice_open_amount,
      ).toBe("750.00");
    }, 120_000);
  },
);
