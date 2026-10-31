import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";
import type postgresjs from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
  MNO,
  seedSettlementFixture,
} from "@/tests/fixtures/reporting/settlement-seed";
import type { SettlementFixture } from "@/tests/fixtures/reporting/settlement-seed";

// rpt05-spec Tests — MNO outstanding (Part C) against a seeded LIVE database:
// plan §C.4 MO-T1–MO-T13, MO-T15, MO-T16 and the runtime half of MO-T14;
// R05-T1–R05-T4. The runtime runs as a subprocess connected as
// `reporting_runtime` (tests/helpers/reporting-harness.ts) over the Part A seed
// extended for Part C (tests/fixtures/reporting/settlement-seed.ts). The flow
// cases (MO-T14's today/tomorrow, the WARNING path) are
// rpt05-mno-outstanding-flow.live.test.ts; guardrail 5 (one sign rule) covers
// the new package through rpt03-guardrails.test.ts.
//
// DATABASE_URL must be a SUPERUSER connection on a THROWAWAY cluster: the
// suite drops and re-migrates every schema and sets reporting_runtime's
// password to a test value (roles are cluster-level).
const databaseUrl = process.env.DATABASE_URL;
const ready = reportingRuntimeReady();

const EXPECTED = join(
  process.cwd(),
  "tests/fixtures/reporting/mno-outstanding/expected",
);
const fileName = (day: string) => `Reporting_dnb_settlement_mno_${day}.csv`;
const MAIN_DATE = "20261027";
const MAIN_FILE = fileName(MAIN_DATE);

const errors = (r: ReportRun) =>
  r.logs.filter((l) => l.level === "ERROR").map((l) => l.message);

// MNO → amount, from a run's file.
function amounts(run: ReportRun, day: string): Record<string, string> {
  return Object.fromEntries(
    parseReportCsv(run.files[fileName(day)]!).map((r) => [r[1]!, r[2]!]),
  );
}

// Yesterday in Asia/Kuala_Lumpur, YYYYMMDD.
function businessYesterday(): string {
  const kl = new Date(Date.now() + 8 * 3_600_000 - 86_400_000);
  return kl.toISOString().slice(0, 10).replaceAll("-", "");
}

describe.skipIf(!databaseUrl || !ready)(
  "rpt05 MNO outstanding (requires a superuser DATABASE_URL and the reporting runtime)",
  { timeout: 60_000 },
  () => {
    let sql: postgresjs.Sql;
    let fx: SettlementFixture;
    let env: Record<string, string>;
    let empty: ReportRun; // MO-T15: run before the seed
    let main: ReportRun; // the default run: 20261027

    const outstanding = (day: string, extra: Record<string, string> = {}) =>
      runReport("mno_outstanding", [`--outstanding-date=${day}`], {
        ...env,
        ...extra,
      });

    // Each MNO's billing accounts and financial account.
    const mnoAccounts = () =>
      ({
        [MNO.A]: [fx.accounts.A],
        [MNO.B]: [fx.accounts.B],
        [MNO.D]: [fx.accounts.D],
        [MNO.E]: [fx.accounts.E],
        [MNO.F]: [fx.accounts.F],
        [MNO.G]: [fx.accounts.G, fx.accounts.G2],
        [MNO.H]: [fx.accounts.H],
        [MNO.I]: [fx.accounts.I],
      }) as const;

    // Runs `body` with party-role specifications changed, restoring them after.
    async function withSpecs(
      changes: Record<string, Record<string, string>>,
      body: () => void | Promise<void>,
    ): Promise<void> {
      const before = await sql<{ id: string; spec: Record<string, string> }[]>`
        SELECT party_role_id AS id, party_role_specification AS spec
        FROM customer.party_role WHERE party_role_id = ANY(${sql.array(Object.keys(changes))})
      `;
      try {
        for (const [id, spec] of Object.entries(changes))
          await sql`UPDATE customer.party_role SET party_role_specification = ${sql.json(spec)} WHERE party_role_id = ${id}`;
        await body();
      } finally {
        for (const { id, spec } of before)
          await sql`UPDATE customer.party_role SET party_role_specification = ${sql.json(spec)} WHERE party_role_id = ${id}`;
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1, onnotice: () => {} });
      await resetReportingDatabase(databaseUrl as string, sql);
      env = reportingDbEnv(databaseUrl as string);
      empty = outstanding(MAIN_DATE);
      fx = await seedSettlementFixture(sql);
      main = outstanding(MAIN_DATE);
    }, 300_000);

    afterAll(async () => {
      if (sql) {
        await dropAppSchemas(sql);
        await sql.end();
      }
    }, 120_000);

    it("the default run (20261027) ends WARNING with one file, matching the expected CSV byte for byte", () => {
      expect(main.status, main.stderr).toBe(0);
      expect(Object.keys(main.files)).toEqual([MAIN_FILE]);
      expect(main.files[MAIN_FILE]).toBe(
        readFileSync(join(EXPECTED, MAIN_FILE), "utf8"),
      );
      expect(main.outputs).toMatchObject({
        file: MAIN_FILE,
        mnos: 8,
        skipped_mnos: 1,
        status: "WARNING",
      });
    });

    it("MO-T1 — sums across billing periods: INV 202603 1,000.00 + INV 202604 800.00 − PAY 300.00 = 1500.00", () => {
      expect(amounts(main, MAIN_DATE)[MNO.F]).toBe("1500.00");
    });

    it("MO-T2 — account-level items: CRN 100.00, DBN 50.00 and write-off ADJ 20.00 (15–17 Oct) move the balance by −70.00", () => {
      const before = outstanding("20261014");
      const after = outstanding("20261017");
      expect(amounts(before, "20261014")[MNO.A]).toBe("2240.00");
      expect(amounts(after, "20261017")[MNO.A]).toBe("2170.00");
    });

    it("MO-T3 — unapplied cash: the 1,270.00 capture (8 Oct) leaves the amount unchanged (gross)", () => {
      const before = outstanding("20261007");
      const after = outstanding("20261008");
      expect(amounts(before, "20261007")[MNO.A]).toBe("3040.00");
      expect(amounts(after, "20261008")[MNO.A]).toBe("3040.00");
      // 400.00 of it is still unapplied on 27 Oct (rpt03 T8), never subtracted.
      expect(amounts(main, MAIN_DATE)[MNO.A]).toBe("2100.00");
    });

    it("MO-T4 — a payment reversed (14 Oct) puts the balance back up by 400.00", () => {
      const before = outstanding("20261013");
      const after = outstanding("20261014");
      expect(amounts(before, "20261013")[MNO.A]).toBe("1840.00");
      expect(amounts(after, "20261014")[MNO.A]).toBe("2240.00");
    });

    it("MO-T5 — an MNO with two billing accounts gets one row with their balances added", () => {
      const rows = parseReportCsv(main.files[MAIN_FILE]!).filter(
        (r) => r[1] === MNO.G,
      );
      expect(rows).toEqual([[MAIN_DATE, MNO.G, "310.00"]]); // 200 + (100 + 10)
    });

    it("MO-T6 — an MNO with a billing account that was never invoiced has a 0.00 row", () => {
      expect(amounts(main, MAIN_DATE)[MNO.I]).toBe("0.00");
    });

    it("MO-T7 — a credit note larger than what is owed gives a negative amount: -150.00", () => {
      expect(amounts(main, MAIN_DATE)[MNO.H]).toBe("-150.00");
    });

    it("MO-T8 — cut-off: an INV posted and a PAY entered on 20261028 are both excluded on the 27th and counted on the 28th", () => {
      const next = outstanding("20261028");
      expect(amounts(main, MAIN_DATE)[MNO.F]).toBe("1500.00");
      expect(amounts(next, "20261028")[MNO.F]).toBe("1510.00"); // + 50 − 40
    });

    it("MO-T9 — a PAY in pending_approval (150,000.00 on 20 Oct) is excluded", () => {
      const run = outstanding("20261020");
      expect(amounts(run, "20261020")[MNO.A]).toBe("2100.00");
    });

    it("MO-T10 — MNO-C has no MNO Public Key: no row, SKIPPED <party_role_id> MNO_PUBLIC_KEY_MISSING, skipped_mnos=1, WARNING", () => {
      expect(main.logs).toEqual([
        {
          level: "WARN",
          message: `SKIPPED ${fx.accounts.C.partyRoleId} MNO_PUBLIC_KEY_MISSING`,
        },
      ]);
      expect(Object.keys(amounts(main, MAIN_DATE))).toEqual([
        MNO.A,
        MNO.B,
        MNO.D,
        MNO.E,
        MNO.F,
        MNO.G,
        MNO.H,
        MNO.I,
      ]);
      expect(main.outputs).toMatchObject({
        skipped_mnos: 1,
        status: "WARNING",
      });
    });

    it("a run with no party role skipped ends SUCCESS with skipped_mnos=0", async () => {
      await withSpecs(
        { [fx.accounts.C.partyRoleId]: { mnoPublicKey1: "MNO-C" } },
        () => {
          const run = outstanding(MAIN_DATE);
          expect(run.status, run.stderr).toBe(0);
          expect(run.logs).toEqual([]);
          expect(run.outputs).toMatchObject({
            mnos: 9,
            skipped_mnos: 0,
            status: "SUCCESS",
          });
          // 600.00 + 90.00 invoiced − 250.00 paid − 40.00 credited.
          expect(amounts(run, MAIN_DATE)["MNO-C"]).toBe("400.00");
        },
      );
    });

    it("MO-T11 — ledger check: with no activity after the date, each MNO's amount = Σ pgledger receivables balance of its billing accounts", async () => {
      const day = businessYesterday();
      const run = outstanding(day);
      expect(run.status, run.stderr).toBe(0);
      const got = amounts(run, day);
      let compared = 0;
      for (const [mno, accounts] of Object.entries(mnoAccounts())) {
        const bans = accounts.map((a) => a.billingAccountId);
        const fa = accounts[0]!.financialAccountId;
        const [state] = await sql<{ later: number; balance: string }[]>`
          SELECT (SELECT count(*)::int FROM billing.document d
                  WHERE (d.ref_billing_account_id = ANY(${sql.array(bans)})
                         OR d.ref_financial_account_id = ${fa})
                    AND ((d.entry_date AT TIME ZONE 'Asia/Kuala_Lumpur')::date > to_date(${day}, 'YYYYMMDD')
                         OR (d.doc_type = 'INV'
                             AND (d.posted_at IS NULL
                                  OR (d.posted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date > to_date(${day}, 'YYYYMMDD'))))) AS later,
                 (SELECT coalesce(sum(a.balance), 0)::numeric(18,2)::text
                  FROM billing.ledger_binding lb
                  JOIN billing.pgledger_accounts_view a ON a.id = lb.pgledger_account_id
                  WHERE lb.owner_type = 'billing_account' AND lb.ledger_role = 'receivables'
                    AND lb.owner_id = ANY(${sql.array(bans)})) AS balance
        `;
        // Documents dated after the day (T10's) or an INV with no posted_at
        // (the INVOICE_POSTED_AT_MISSING fault) are in the live balance only.
        if (state!.later > 0) continue;
        expect(got[mno], mno).toBe(
          state!.balance === "-0.00" ? "0.00" : state!.balance,
        );
        compared += 1;
      }
      // MNO-H is negative and MNO-G spans two accounts, so the comparison
      // covers more than 0 = 0.
      expect(compared).toBeGreaterThanOrEqual(5);
    });

    it("MO-T12 — cross-check with settlement: MNO-D (one period, no account-level items) = Σ invoice_open_amount of its 202608 settlement invoices, same as_of_date", () => {
      const settlement = runReport(
        "settlement_invoice",
        [
          "--billing-period=202608",
          `--as-of-date=${MAIN_DATE}`,
          "--ts=2026-10-28T01:00:00Z",
        ],
        env,
      );
      expect(settlement.status, settlement.stderr).toBe(0);
      const [header, ...data] = parseReportCsv(
        settlement.files[
          "Reporting_dnb_settlement_invoice_20261028090000.csv"
        ]!,
      );
      const mnoAt = header!.indexOf("mno_id");
      const openAt = header!.indexOf("invoice_open_amount");
      const cents = data
        .filter((r) => r[mnoAt] === MNO.D)
        .reduce((sum, r) => sum + Math.round(Number(r[openAt]) * 100), 0);
      expect(cents).toBe(70000);
      expect(amounts(main, MAIN_DATE)[MNO.D]).toBe((cents / 100).toFixed(2));
    });

    it("MO-T13 — two runs for the same date give identical content", () => {
      const again = outstanding(MAIN_DATE);
      expect(again.status, again.stderr).toBe(0);
      expect(again.files[MAIN_FILE]).toBe(main.files[MAIN_FILE]);
    });

    it("MO-T14 (runtime) — a malformed date fails INVALID_OUTSTANDING_DATE; no file", () => {
      const run = outstanding("20261332");
      expect(run.status).toBe(1);
      expect(errors(run)).toEqual(["INVALID_OUTSTANDING_DATE 20261332"]);
      expect(run.files).toEqual({});
    });

    it("MO-T15 — no party role with a billing account: FAILED NO_MNOS; no file", () => {
      expect(empty.status).toBe(1);
      expect(empty.logs).toEqual([{ level: "ERROR", message: "NO_MNOS" }]);
      expect(empty.files).toEqual({});
    });

    it("every MNO skipped: FAILED ALL_MNOS_EXCEPTED after one SKIPPED line each; no file", async () => {
      const keyed = Object.values(mnoAccounts()).map((a) => a[0]!.partyRoleId);
      await withSpecs(Object.fromEntries(keyed.map((id) => [id, {}])), () => {
        const run = outstanding(MAIN_DATE);
        expect(run.status).toBe(1);
        const warned = run.logs.filter((l) => l.level === "WARN");
        expect(warned).toHaveLength(9);
        expect(errors(run)).toEqual(["ALL_MNOS_EXCEPTED"]);
        expect(run.files).toEqual({});
      });
    });

    it("MO-T16 — format: no header, 3 columns, YYYYMMDD, 2 dp with a leading - and no thousands separator, UTF-8 without BOM, LF, sorted by MNO, exact file name", () => {
      const text = main.files[MAIN_FILE]!;
      expect(text.charCodeAt(0)).not.toBe(0xfeff);
      expect(text).not.toContain("\r");
      expect(text.endsWith("\n")).toBe(true);
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines)
        expect(line).toMatch(/^\d{8},[^, ]+,-?(0|[1-9]\d*)\.\d{2}$/);
      expect(lines[0]!.startsWith(`${MAIN_DATE},`)).toBe(true); // no header
      const keys = lines.map((l) => l.split(",")[1]!);
      expect(keys).toEqual([...keys].sort());
      expect(text).toContain(`${MAIN_DATE},${MNO.H},-150.00\n`);
      expect(main.outputs.file).toBe(
        "Reporting_dnb_settlement_mno_20261027.csv",
      );
    });

    it("R05-T1 — same rule as Part A: each MNO's amount equals the receivables effects common/receivables.py gives rpt03, summed over the lines counted at the end of the day", () => {
      const groups = Object.fromEntries(
        Object.entries(mnoAccounts()).map(([mno, accounts]) => [
          mno,
          accounts.map((a) => a.billingAccountId),
        ]),
      );
      const run = runReportingPython(
        [
          "-c",
          `import json, sys
from datetime import date
from decimal import Decimal
from runtime.reporting.common import db, receivables
groups = json.loads(sys.argv[1])
day = date(2026, 10, 27)
with db.read_snapshot() as conn:
    snap = receivables.read_ledger(conn, [b for bans in groups.values() for b in bans], [])
out = {}
for mno, bans in groups.items():
    total = Decimal("0")
    # rpt03's effects (no cut-off), kept by this test's own reading of rpt05
    # D1: INV by posted_at day, PAY/CRN/DBN/ADJ by entry_date.
    for e in receivables.receivables_effects(snap, bans, date.max):
        line = e.line
        if line.doc_type == "INV":
            if line.posted_date is None or line.posted_date > day:
                continue
        elif line.doc_type not in ("PAY", "CRN", "DBN", "ADJ") or line.entry_date > day:
            continue
        total += e.amount
    out[mno] = f"{total:.2f}"
print(json.dumps(out))`,
          JSON.stringify(groups),
        ],
        { env },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(amounts(main, MAIN_DATE));
    });

    it("R05-T2 — each seeded INV's leg effects sum to its total_amount", async () => {
      const bans = Object.values(fx.accounts).map((a) => a.billingAccountId);
      const run = runReportingPython(
        [
          "-c",
          `import json, sys
from datetime import date
from decimal import Decimal
from runtime.reporting.common import db, receivables
bans = json.loads(sys.argv[1])
with db.read_snapshot() as conn:
    snap = receivables.read_ledger(conn, bans, [])
sums = {}
for e in receivables.receivables_effects(snap, bans, date.max):
    if e.line.doc_type == "INV":
        sums[e.line.document_id] = sums.get(e.line.document_id, Decimal("0")) + e.amount
print(json.dumps({k: f"{v:.2f}" for k, v in sums.items()}))`,
          JSON.stringify(bans),
        ],
        { env },
      );
      expect(run.status, run.stderr).toBe(0);
      const totals = await sql<{ id: string; total: string }[]>`
        SELECT document_id AS id, total_amount::numeric(18,2)::text AS total
        FROM billing.document WHERE doc_type = 'INV'
      `;
      expect(totals.length).toBe(Object.keys(fx.invoices).length);
      expect(JSON.parse(run.stdout)).toEqual(
        Object.fromEntries(totals.map((t) => [t.id, t.total])),
      );
      // The seed covers an INV with a tax line (two legs).
      expect(JSON.parse(run.stdout)[fx.invoices.E1!]).toBe("100.00");
    });

    it("R05-T3 — two party roles with the same mnoPublicKey1 fail DUPLICATE_MNO_PUBLIC_KEY <key>; no file", async () => {
      await withSpecs(
        { [fx.accounts.I.partyRoleId]: { mnoPublicKey1: MNO.A } },
        () => {
          const run = outstanding(MAIN_DATE);
          expect(run.status).toBe(1);
          expect(errors(run)).toEqual([`DUPLICATE_MNO_PUBLIC_KEY ${MNO.A}`]);
          expect(run.files).toEqual({});
        },
      );
    });

    it("R05-T4 — [guardrail 4] an INV posted 23:59 on the date counts and one posted 00:01 the next day doesn't, under session time zones UTC and Asia/Kuala_Lumpur", () => {
      const files: string[] = [];
      for (const tz of ["UTC", "Asia/Kuala_Lumpur"]) {
        const on = outstanding("20261027", { PGTZ: tz });
        const next = outstanding("20261028", { PGTZ: tz });
        expect(on.status, on.stderr).toBe(0);
        expect(next.status, next.stderr).toBe(0);
        expect(amounts(on, "20261027")[MNO.G], tz).toBe("310.00"); // + 10.00 (23:59)
        expect(amounts(next, "20261028")[MNO.G], tz).toBe("330.00"); // + 20.00 (00:01)
        files.push(on.files[MAIN_FILE]!);
      }
      expect(files[0]).toBe(files[1]);
      expect(files[0]).toBe(main.files[MAIN_FILE]);
    });
  },
);
