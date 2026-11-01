import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  dropAppSchemas,
  parseReportCsv,
  reportingDbEnv,
  reportingRuntimeReady,
  resetReportingDatabase,
  runReport,
} from "@/tests/helpers/reporting-harness";
import type { ReportRun } from "@/tests/helpers/reporting-harness";
import {
  EMPTY_DAY,
  GL_DAY,
  MNO,
  NEXT_DAY,
  PRICE_GL,
  seedGlFeedFixture,
} from "@/tests/fixtures/reporting/gl-feed-seed";
import type { GlFeedFixture } from "@/tests/fixtures/reporting/gl-feed-seed";

// Posting's post-commit PDF render is a separate step that never affects the
// posted rows (bm19 D10); the seed doesn't need it.
vi.mock("@/services/billing/render-invoice", () => ({
  renderFinalInvoice: vi.fn(async () => {
    throw new Error("rpt09 seed: invoice PDFs are not rendered");
  }),
}));

// rpt09-spec Tests — the GL feed (Part E) against a seeded LIVE database:
// G-T1–G-T13, G-T16–G-T18, G-T20 and R09-T2–R09-T6 (G-T14, G-T15, G-T19's
// folder half and the WARNING path through Kestra are
// rpt09-gl-feed-flow.live.test.ts; R09-T1, R09-T7's runtime half, R09-T8 and
// the report checks' failure paths are DB-free, rpt09-guardrails.test.ts;
// R09-T9 is in tests/db/reporting-db-roles.integration.test.ts). The seed is
// tests/fixtures/reporting/gl-feed-seed.ts. The runtime writes the plain CSV
// that the flow then encrypts (D6), so the file is compared as it sits inside
// the zip.
//
// DATABASE_URL must be a SUPERUSER connection on a THROWAWAY cluster: the
// suite drops and re-migrates every schema and sets reporting_runtime's
// password to a test value (roles are cluster-level).
const databaseUrl = process.env.DATABASE_URL;
const ready = reportingRuntimeReady();

const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/gl-feed/expected",
);
const fileName = (day: string) => `GLFEED_ORAFIN_${day}.csv`;
const FILE = fileName(GL_DAY);
const OCC = "MNO_SIGNUP_FEE,LATE_PAYMENT_CHARGE,INTEGRATION_CHARGE";

// Column positions (contracts/gl_feed.yaml, §E.2).
const C = {
  mno: 0,
  cu: 1,
  polygon: 2,
  service: 3,
  amount: 4,
  gl: 5,
  start: 6,
  mode: 7,
  ref: 8,
  discount: 9,
  invoice: 10,
  entry: 11,
  invoiceAmount: 12,
  open: 13,
  product: 14,
  indicator: 15,
} as const;

const errors = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "ERROR").map((l) => l.message);
const warnings = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "WARN").map((l) => l.message);
const rows = (run: ReportRun, day = GL_DAY) =>
  parseReportCsv(run.files[fileName(day)]!).slice(1);
const cents = (amount: string) => Math.round(Number(amount) * 100);
const sum = (list: string[][]) =>
  list.reduce((total, r) => total + cents(r[C.amount]!), 0);

describe.skipIf(!databaseUrl || !ready)(
  "rpt09 GL feed (requires a superuser DATABASE_URL and the reporting runtime)",
  { timeout: 120_000 },
  () => {
    let sql: postgresjs.Sql;
    let fx: GlFeedFixture;
    let env: Record<string, string>;
    let empty: ReportRun; // before the seed
    let main: ReportRun; // 20261026

    const glFeed = (
      day: string,
      extra: Record<string, string> = {},
      occ = OCC,
    ) =>
      runReport(
        "gl_feed",
        [`--posting-date=${day}`, `--occ-reason-codes=${occ}`],
        {
          ...env,
          ...extra,
        },
      );
    const doc = (name: string) => fx.documents[name]!;
    // An invoice's rows: every row carrying it as the Invoice Reference
    // Number (no payment settles the day's invoices in the fixture).
    const ofDoc = (run: ReportRun, id: string) =>
      rows(run).filter((r) => r[C.invoice] === id);
    const find = (run: ReportRun, pred: (r: string[]) => boolean) =>
      rows(run).filter(pred);
    // Captures, payouts and deposits: not receivables (GL20(b)).
    const receivablesRows = (run: ReportRun, mno: string) =>
      rows(run).filter(
        (r) =>
          r[C.mno] === mno &&
          !(["1050", "2400"].includes(r[C.gl]!) && r[C.invoice] === ""),
      );

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await resetReportingDatabase(databaseUrl as string, sql);
      env = reportingDbEnv(databaseUrl as string);
      empty = glFeed(GL_DAY);
      fx = await seedGlFeedFixture(sql);
      main = glFeed(GL_DAY);
    }, 600_000);

    afterAll(async () => {
      if (sql) {
        if (!process.env.RPT09_KEEP_SEED) await dropAppSchemas(sql);
        await sql.end();
      }
    }, 120_000);

    it("20261026 ends WARNING (one GL code fallback) with GLFEED_ORAFIN_20261026.csv matching the expected CSV byte for byte", () => {
      expect(main.status, main.stderr).toBe(0);
      expect(errors(main)).toEqual([]);
      expect(Object.keys(main.files)).toEqual([FILE]);
      expect(main.files[FILE]).toBe(readFileSync(join(EXPECTED, FILE), "utf8"));
      expect(main.outputs).toEqual({
        file: FILE,
        rows: rows(main).length,
        gl_code_fallbacks: 1,
        status: "WARNING",
      });
    });

    it("G-T16 — the header is exactly GL10; UTF-8 without BOM, LF, no spaces after commas, 2 dp amounts, YYYYMMDD dates", () => {
      const text = main.files[FILE]!;
      expect(text.split("\n")[0]).toBe(
        "MNO Public Key,Commercial Unit,Polygon ID,Service Public Key,Amount,Rev_GLCODE,Polygon Subscription Date,Payment mode,payment ref,Discounted_Amount,Invoice Reference Number,Invoice/Transaction entry date,Invoice Amount,Invoice Amount-Open,Product Code,Indicator",
      );
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(text).not.toContain("\r");
      expect(text).not.toMatch(/, /);
      for (const r of rows(main)) {
        expect(r).toHaveLength(16);
        for (const c of [C.amount, C.discount, C.invoiceAmount, C.open])
          if (r[c] !== "") expect(r[c]).toMatch(/^-?\d+\.\d{2}$/);
        for (const c of [C.start, C.entry])
          if (r[c] !== "") expect(r[c]).toMatch(/^\d{8}$/);
        expect(r[C.service]).toBe(""); // GL11
      }
    });

    it("GL13 — sorted by MNO Public Key, then the document's posted_at", () => {
      const mnos = rows(main).map((r) => r[C.mno]!);
      expect(mnos).toEqual([...mnos].sort());
      expect([...new Set(mnos)]).toEqual([MNO.J, MNO.K, MNO.L, MNO.M, MNO.N]);
    });

    it("G-T1 / D1 — J1's three polygons: I rows, Amount net of the apportioned discount (450.00 / 270.00 / 180.00), Discounted_Amount 50.00 / 30.00 / 20.00, Product Code, Polygon ID, Polygon Subscription Date and the price GL filled", async () => {
      const j1 = fx.capacity.J1;
      const polygons = ofDoc(main, j1.invoiceId).filter((r) => r[C.polygon]);
      expect(
        polygons.map((r) => [
          r[C.cu],
          r[C.polygon],
          r[C.amount],
          r[C.discount],
          r[C.start],
          r[C.gl],
          r[C.indicator],
        ]),
      ).toEqual([
        [
          "CU-J-1",
          "PCU-J-0001",
          "450.00",
          "50.00",
          "20250301",
          PRICE_GL.capacity,
          "I",
        ],
        [
          "CU-J-1",
          "PCU-J-0002",
          "270.00",
          "30.00",
          "20250415",
          PRICE_GL.capacity,
          "I",
        ],
        [
          "CU-J-1",
          "PCU-J-0003",
          "180.00",
          "20.00",
          "20250301",
          PRICE_GL.capacity,
          "I",
        ],
      ]);
      const [offering] = await sql<{ id: string }[]>`
        SELECT ref_product_offering_id AS id FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${j1.customerBillId} AND grouping_key LIKE '%:CAPACITY:%'`;
      for (const r of polygons) expect(r[C.product]).toBe(offering!.id);
    });

    it("R09-T2 — the invoice CSV's discount rows and the GL feed's Discounted_Amount give identical per-polygon figures", () => {
      const csv = runReport("invoice_csv", [`--invoice-date=${GL_DAY}`], env);
      expect(csv.status, csv.stderr).toBe(0);
      const invoiceRows = parseReportCsv(csv.files[`R${MNO.J}${GL_DAY}.csv`]!)
        .slice(1)
        .filter((r) => r[5] === fx.capacity.J1.invoiceId && r[9] === "");
      const fromInvoiceCsv = invoiceRows.map((r) => [
        r[2],
        (-Number(r[3])).toFixed(2),
      ]);
      const fromGl = ofDoc(main, fx.capacity.J1.invoiceId)
        .filter((r) => r[C.discount] !== "")
        .map((r) => [r[C.polygon], r[C.discount]]);
      expect(fromGl).toEqual(fromInvoiceCsv);
      expect(fromGl).toHaveLength(3);
    });

    it("R09-T3 / G-T11 — N1's commitment top-up: one row, polygon columns blank; the line's rows add up to its net_amount; no product GL code → 4000 and GL_CODE_FALLBACK", async () => {
      const n1 = fx.capacity.N1;
      const [line] = await sql<
        {
          id: string;
          offering: string;
          net: string;
          gross: string;
          rated: string;
        }[]
      >`
        SELECT customer_bill_line_id AS id, ref_product_offering_id AS offering,
               net_amount::text AS net, gross_amount::text AS gross, rated_amount::text AS rated
        FROM billing.customer_bill_line
        WHERE ref_customer_bill_id = ${n1.customerBillId} AND grouping_key LIKE '%:CAPACITY:%'`;
      expect(line).toMatchObject({
        gross: "500.00",
        rated: "250.00",
        net: "500.00",
      });
      const n1Rows = ofDoc(main, n1.invoiceId);
      const topUps = n1Rows.filter((r) => r[C.polygon] === "");
      expect(
        topUps.map((r) => [
          r[C.cu],
          r[C.start],
          r[C.discount],
          r[C.amount],
          r[C.product],
        ]),
      ).toEqual([["", "", "", "250.00", line!.offering]]);
      expect(sum(n1Rows)).toBe(cents(line!.net));
      for (const r of n1Rows) expect(r[C.gl]).toBe("4000");
      expect(warnings(main)).toEqual([
        `GL_CODE_FALLBACK ${n1.invoiceId} ${line!.offering}`,
      ]);
    });

    it("G-T5 — the 1,500.00 capture: P, −1500.00, GL 1050 (sys.cash), Payment mode and payment ref filled, no Invoice Reference Number", () => {
      expect(find(main, (r) => r[C.amount] === "-1500.00")).toEqual([
        [
          MNO.J,
          "",
          "",
          "",
          "-1500.00",
          "1050",
          "",
          "bank_transfer",
          "TT-57001",
          "",
          "",
          GL_DAY,
          "",
          "",
          "",
          "P",
        ],
      ]);
    });

    it("G-T2 / G-T3 / G-T4 / R09-T6 — one payment across two invoices: two P allocation rows with the same payment ref, GL 1200, Payment mode blank; partial leaves 400.00 open, full leaves 0.00; the backdated one keeps its entry date", () => {
      const allocations = find(
        main,
        (r) => r[C.mno] === MNO.J && r[C.gl] === "1200",
      );
      expect(
        allocations.map((r) => [
          r[C.amount],
          r[C.mode],
          r[C.ref],
          r[C.invoice],
          r[C.entry],
          r[C.invoiceAmount],
          r[C.open],
          r[C.indicator],
        ]),
      ).toEqual([
        [
          "-600.00",
          "",
          "TT-57001",
          doc("J_old1"),
          GL_DAY,
          "1000.00",
          "400.00",
          "P",
        ],
        [
          "-400.00",
          "",
          "TT-57001",
          doc("J_old2"),
          "20261021",
          "400.00",
          "0.00",
          "P",
        ],
      ]);
    });

    it("G-T6 — the reversal of a 300.00 allocation: P, +300.00, the original's GL (1200), its invoice traced through the original line, still open 300.00", () => {
      expect(
        find(
          main,
          (r) => r[C.mno] === MNO.K && r[C.ref] === "Reversal - TT returned",
        ),
      ).toEqual([
        [
          MNO.K,
          "",
          "",
          "",
          "300.00",
          "1200",
          "",
          "",
          "Reversal - TT returned",
          "",
          doc("K_old"),
          GL_DAY,
          "300.00",
          "300.00",
          "",
          "P",
        ],
      ]);
    });

    it("a cash refund of an allocation: the release (+200.00, GL 1200, its invoice) and the payout (+200.00, GL 1050), both P", () => {
      expect(
        find(main, (r) => r[C.ref] === "Refund to customer").map((r) => [
          r[C.amount],
          r[C.gl],
          r[C.invoice],
          r[C.open],
          r[C.indicator],
        ]),
      ).toEqual([
        ["200.00", "1200", doc("K_old2"), "200.00", "P"],
        ["200.00", "1050", "", "", "P"],
      ]);
    });

    it("G-T7 — CRN, DBN MANUAL_CHARGE and ADJ write-off: A rows with signs −, +, − and GLs 4090, 4000, 6100; Discounted_Amount and Invoice Reference Number blank", () => {
      const adjustments = find(
        main,
        (r) => r[C.mno] === MNO.J && r[C.indicator] === "A",
      ).map((r) => [
        r[C.amount],
        r[C.gl],
        r[C.discount],
        r[C.invoice],
        r[C.entry],
      ]);
      expect(adjustments).toEqual([
        ["-75.00", "4090", "", "", GL_DAY],
        ["50.00", "4000", "", "", GL_DAY],
        ["-20.00", "6100", "", "", GL_DAY],
        ["-10.00", "4090", "", "", GL_DAY], // G-T17's 23:59 credit
      ]);
    });

    it("G-T8 — with MANUAL_CHARGE in occ_reason_codes, the DBN is an I row (positive, revenue GL)", () => {
      const run = glFeed(GL_DAY, {}, "MANUAL_CHARGE");
      expect(run.status, run.stderr).toBe(0);
      expect(
        rows(run).filter(
          (r) =>
            r[C.gl] === "4000" && r[C.mno] === MNO.J && r[C.invoice] === "",
        ),
      ).toEqual([
        [
          MNO.J,
          "",
          "",
          "",
          "50.00",
          "4000",
          "",
          "",
          "",
          "",
          "",
          GL_DAY,
          "",
          "",
          "",
          "I",
        ],
      ]);
    });

    it("G-T9 — a deposit (−5000.00, GL 2400, P, its payment mode and ref); a deposit released to account (+1000.00, GL 2400) and refunded (+1000.00, GL 1050 — a payout, owner 2026-11-01)", () => {
      expect(
        find(main, (r) => r[C.mno] === MNO.J && r[C.gl] === "2400"),
      ).toEqual([
        [
          MNO.J,
          "",
          "",
          "",
          "-5000.00",
          "2400",
          "",
          "bank_transfer",
          "TT-57010",
          "",
          "",
          GL_DAY,
          "",
          "",
          "",
          "P",
        ],
      ]);
      expect(
        find(
          main,
          (r) =>
            r[C.mno] === MNO.K &&
            ["Deposit released to account", "TT-58020"].includes(r[C.ref]!),
        ).map((r) => [
          r[C.amount],
          r[C.gl],
          r[C.mode],
          r[C.ref],
          r[C.indicator],
        ]),
      ).toEqual([
        ["1000.00", "2400", "", "Deposit released to account", "P"],
        ["1000.00", "1050", "bank_transfer", "TT-58020", "P"],
      ]);
    });

    it("G-T10 — K1, an invoice on an annually billed account: every row P with a positive Amount (recurring GL 4020, tax 2200)", () => {
      expect(
        ofDoc(main, doc("K1")).map((r) => [
          r[C.amount],
          r[C.gl],
          r[C.product] !== "",
          r[C.indicator],
        ]),
      ).toEqual([
        ["12000.00", PRICE_GL.recurring, true, "P"],
        ["960.00", "2200", false, "P"],
      ]);
    });

    it("G-T20 — L1: a recurring I row and a one-time I row with polygon columns blank and their price GLs, a tax I row with GL 2200, adding up to the invoice's total", () => {
      const l1 = ofDoc(main, doc("L1"));
      expect(
        l1.map((r) => [
          r[C.polygon],
          r[C.amount],
          r[C.gl],
          r[C.product] !== "",
          r[C.invoiceAmount],
          r[C.indicator],
        ]),
      ).toEqual([
        ["", "300.00", PRICE_GL.recurring, true, "378.00", "I"],
        ["", "50.00", PRICE_GL.oneTime, true, "378.00", "I"],
        ["", "28.00", "2200", false, "378.00", "I"],
      ]);
      expect(sum(l1)).toBe(cents("378.00"));
    });

    it("ADJ rounding through its release leg: +0.02, GL 6900, A", () => {
      expect(
        find(main, (r) => r[C.mno] === MNO.M && r[C.gl] === "6900").map((r) => [
          r[C.amount],
          r[C.indicator],
        ]),
      ).toEqual([["0.02", "A"]]);
    });

    it("G-T18 — per invoice, Σ Amount = Invoice Amount; per MNO, Σ Amount over receivables rows = the receivables effects of the transfers the ledger created that day", async () => {
      for (const id of [
        fx.capacity.J1.invoiceId,
        fx.capacity.N1.invoiceId,
        doc("K1"),
        doc("L1"),
      ]) {
        const list = ofDoc(main, id);
        expect(list.length, id).toBeGreaterThan(0);
        expect(sum(list), id).toBe(cents(list[0]![C.invoiceAmount]!));
      }
      // The ledger's own day, read here as the superuser, independently.
      const ledger = await sql<{ mno: string; effect: string }[]>`
        WITH rec AS (
          SELECT lb.pgledger_account_id AS account,
                 pr.party_role_specification ->> 'mnoPublicKey1' AS mno
          FROM billing.ledger_binding lb
          JOIN billing.billing_account ba ON ba.billing_account_id = lb.owner_id
          JOIN customer.party_role pr ON pr.party_role_id = ba.ref_party_role_id
          WHERE lb.owner_type = 'billing_account' AND lb.ledger_role = 'receivables'
        )
        SELECT rec.mno, sum(CASE WHEN t.to_account_id = rec.account THEN t.amount ELSE -t.amount END)::text AS effect
        FROM billing.pgledger_transfers t
        JOIN rec ON rec.account IN (t.from_account_id, t.to_account_id)
        WHERE (t.created_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = '2026-10-26'
        GROUP BY rec.mno ORDER BY rec.mno`;
      for (const { mno, effect } of ledger)
        expect(sum(receivablesRows(main, mno)), mno).toBe(cents(effect));
      expect(ledger.map((l) => l.mno)).toEqual([
        MNO.J,
        MNO.K,
        MNO.L,
        MNO.M,
        MNO.N,
      ]);
    });

    it("G-T18 — the tie to Part C holds for an MNO with nothing backdated (K, L, M, N), and not for MNO10, whose 400.00 allocation was entered 2026-10-21", () => {
      const partC = (day: string) => {
        const run = runReport(
          "mno_outstanding",
          [`--outstanding-date=${day}`],
          env,
        );
        expect(run.status, run.stderr).toBe(0);
        // Positional, no header: outstanding_date, mno_public_key, amount.
        return Object.fromEntries(
          parseReportCsv(Object.values(run.files)[0]!).map((r) => [
            r[1],
            cents(r[2]!),
          ]),
        );
      };
      const before = partC(EMPTY_DAY);
      const after = partC(GL_DAY);
      const receivables = (mno: string) => sum(receivablesRows(main, mno));
      for (const mno of [MNO.K, MNO.L, MNO.M, MNO.N])
        expect(after[mno]! - before[mno]!, mno).toBe(receivables(mno));
      expect(after[MNO.J]! - before[MNO.J]!).toBe(
        receivables(MNO.J) + cents("400.00"),
      );
    });

    it("R09-T5 — each non-INV row's Rev_GLCODE is gl_resolution_view's code for its GL-side account; a gl_mapping change is picked up with no code change", async () => {
      const view = await sql<{ name: string; gl: string }[]>`
        SELECT a.name, v.gl_code AS gl FROM billing.gl_resolution_view v
        JOIN billing.pgledger_accounts_view a ON a.id = v.pgledger_account_id
        WHERE a.name IN ('sys.cash.MYR', 'sys.revenue_adj.MYR', 'sys.write_off.MYR', 'sys.rounding.MYR', 'sys.tax_payable.MYR')
           OR a.name LIKE 'ban.%.receivables' OR a.name LIKE 'fa.%.deposits'`;
      const gl = (name: string) => view.find((v) => v.name === name)!.gl;
      expect(new Set(rows(main).map((r) => r[C.gl]))).toEqual(
        new Set([
          PRICE_GL.capacity,
          PRICE_GL.recurring,
          PRICE_GL.oneTime,
          "4000",
          gl("sys.cash.MYR"),
          gl("sys.revenue_adj.MYR"),
          gl("sys.write_off.MYR"),
          gl("sys.rounding.MYR"),
          gl("sys.tax_payable.MYR"),
          view.find((v) => v.name.startsWith("ban."))!.gl,
          view.find((v) => v.name.startsWith("fa."))!.gl,
        ]),
      );
      const [{ code } = { code: "" }] = await sql<{ code: string }[]>`
        SELECT ref_gl_code AS code FROM billing.gl_mapping
        WHERE selector_type = 'ledger_role' AND selector = 'receivables'`;
      try {
        await sql`UPDATE billing.gl_mapping SET ref_gl_code = '1000'
                  WHERE selector_type = 'ledger_role' AND selector = 'receivables'`;
        const run = glFeed(GL_DAY);
        expect(run.status, run.stderr).toBe(0);
        expect(
          rows(run)
            .filter(
              (r) =>
                r[C.mno] === MNO.J &&
                r[C.ref] === "TT-57001" &&
                r[C.invoice] !== "",
            )
            .map((r) => r[C.gl]),
        ).toEqual(["1000", "1000"]);
      } finally {
        await sql`UPDATE billing.gl_mapping SET ref_gl_code = ${code}
                  WHERE selector_type = 'ledger_role' AND selector = 'receivables'`;
      }
    });

    describe("G-T17 — a document posted 23:59 and one posted 00:01 (Asia/Kuala_Lumpur) fall in their own day's file, whatever the session time zone", () => {
      for (const tz of ["UTC", "Asia/Kuala_Lumpur"]) {
        it(`PGTZ=${tz}`, () => {
          const on = glFeed(GL_DAY, { PGTZ: tz });
          const next = glFeed(NEXT_DAY, { PGTZ: tz });
          expect(on.files[FILE]).toBe(main.files[FILE]);
          expect(on.files[FILE]).toContain("-10.00,4090");
          expect(on.files[FILE]).not.toContain("-5.00,4090");
          expect(next.status, next.stderr).toBe(0);
          expect(rows(next, NEXT_DAY)).toEqual([
            [
              MNO.J,
              "",
              "",
              "",
              "-5.00",
              "4090",
              "",
              "",
              "",
              "",
              "",
              NEXT_DAY,
              "",
              "",
              "",
              "A",
            ],
          ]);
          expect(next.outputs).toMatchObject({
            rows: 1,
            gl_code_fallbacks: 0,
            status: "SUCCESS",
          });
        });
      }
    });

    it("G-T13 — nothing posted that day: a header-only file, SUCCESS (before the seed, and on a day nothing was posted)", () => {
      for (const [run, day] of [
        [empty, GL_DAY],
        [glFeed(EMPTY_DAY), EMPTY_DAY],
      ] as const) {
        expect(run.status, run.stderr).toBe(0);
        expect(Object.keys(run.files)).toEqual([fileName(day)]);
        expect(parseReportCsv(run.files[fileName(day)]!)).toHaveLength(1);
        expect(run.outputs).toEqual({
          file: fileName(day),
          rows: 0,
          gl_code_fallbacks: 0,
          status: "SUCCESS",
        });
      }
    });

    it("G-T12 — a missing MNO key, missing polygon data and an unmappable line: FAILED, no file, one GL_ROW_INVALID line per problem", async () => {
      const [role] = await sql<{ id: string; spec: Record<string, string> }[]>`
        SELECT pr.party_role_id AS id, pr.party_role_specification AS spec
        FROM customer.party_role pr
        JOIN billing.billing_account ba ON ba.ref_party_role_id = pr.party_role_id
        WHERE ba.billing_account_id = ${fx.accounts.L.billingAccountId}`;
      const [udr] = await sql<{ id: string; key: string }[]>`
        SELECT udr_id::text AS id, udr_key AS key FROM rating.udr_rated
        WHERE billrun_ref_id = ${fx.capacity.J1.runId} AND udr_key LIKE '%PCU-J-0002%'`;
      const [crnLine] = await sql<{ id: string }[]>`
        SELECT document_line_id AS id FROM billing.document_line WHERE ref_document_id = ${doc("crnJ")}`;
      try {
        await sql`UPDATE customer.party_role SET party_role_specification = '{}'::jsonb WHERE party_role_id = ${role!.id}`;
        await sql`UPDATE rating.udr_rated SET udr_key = ${udr!.key.replace(/polygon_id=[^|]*\|?/, "")} WHERE udr_id::text = ${udr!.id}`;
        await sql`UPDATE billing.document_line SET line_kind = 'release' WHERE document_line_id = ${crnLine!.id}`;
        const run = glFeed(GL_DAY);
        expect(run.status).not.toBe(0);
        expect(run.files).toEqual({});
        expect(errors(run).sort()).toEqual(
          [
            `GL_ROW_INVALID ${fx.capacity.J1.invoiceId} POLYGON_ID_MISSING`,
            `GL_ROW_INVALID ${doc("crnJ")} UNMAPPED_DOCUMENT`,
            `GL_ROW_INVALID ${doc("L1")} MNO_PUBLIC_KEY_MISSING`,
          ].sort(),
        );
      } finally {
        await sql`UPDATE customer.party_role SET party_role_specification = ${JSON.stringify(role!.spec)}::jsonb WHERE party_role_id = ${role!.id}`;
        await sql`UPDATE rating.udr_rated SET udr_key = ${udr!.key} WHERE udr_id::text = ${udr!.id}`;
        await sql`UPDATE billing.document_line SET line_kind = 'charge' WHERE document_line_id = ${crnLine!.id}`;
      }
    });

    it("R09-T4 — a capacity line whose polygons don't add up to its rated_amount fails CAPACITY_LINE_MISMATCH, and writes nothing", async () => {
      const j1 = fx.capacity.J1;
      try {
        await sql`UPDATE billing.customer_bill_line SET rated_amount = rated_amount + 1
                  WHERE ref_customer_bill_id = ${j1.customerBillId} AND grouping_key LIKE '%:CAPACITY:%'`;
        const run = glFeed(GL_DAY);
        expect(run.status).not.toBe(0);
        expect(errors(run)).toEqual([
          `GL_ROW_INVALID ${j1.invoiceId} CAPACITY_LINE_MISMATCH`,
        ]);
        expect(run.files).toEqual({});
      } finally {
        await sql`UPDATE billing.customer_bill_line SET rated_amount = rated_amount - 1
                  WHERE ref_customer_bill_id = ${j1.customerBillId} AND grouping_key LIKE '%:CAPACITY:%'`;
      }
    });

    it("Inv 7 — two runs for the same date give byte-identical files (and the fixture is restored after the mutation cases)", () => {
      expect(glFeed(GL_DAY).files).toEqual(main.files);
    });

    it("GL3 — a malformed date fails INVALID_POSTING_DATE and writes nothing", () => {
      const run = glFeed("20261332");
      expect(run.status).not.toBe(0);
      expect(errors(run)).toEqual(["INVALID_POSTING_DATE 20261332"]);
      expect(run.files).toEqual({});
    });
  },
);
