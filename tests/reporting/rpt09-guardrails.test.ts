import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectFlowRevisionTrace,
  type FlowTask,
  loadReportFlow,
  loadReportingContract,
} from "@/tests/helpers/reporting-flow-shape";
import {
  parseKestraLines,
  REPORTING_CONTRACTS_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt09-spec Tests, database-free: the contract (D4, GL10, GL18), R09-T1 (the
// apportionment), the §E.1 table (D2: every kind, nothing defaults), the rows
// on a hand-built extract (D1–D4, GL6, GL9, GL13, GL16), the D5 report checks,
// encryption (R09-T7's secret-first half, R09-T8, D6) and the flow's shape
// (D7; guardrail 7's static half). The live-database cases are
// rpt09-gl-feed.integration.test.ts; the Kestra cases are
// rpt09-gl-feed-flow.live.test.ts.

const ROOT = process.cwd();
const FLOW = join(
  ROOT,
  "workflow-management",
  "flows",
  "reporting",
  "report-gl-feed.yaml",
);
const read = (path: string) => readFileSync(path, "utf8");

const ready = reportingRuntimeReady();
// Skipping is for local machines without the runtime; in CI (GitHub's CI,
// Azure Pipelines' TF_BUILD) a missing runtime fails the file instead.
if (!ready && (process.env.CI || process.env.TF_BUILD)) {
  throw new Error(
    "reporting runtime unavailable in CI (set REPORTING_PYTHON3 to a python3 with the worker's packages)",
  );
}

function python(script: string, env: Record<string, string> = {}): unknown {
  const run = runReportingPython(["-c", script], { env });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

const HEADER =
  "MNO Public Key,Commercial Unit,Polygon ID,Service Public Key,Amount,Rev_GLCODE,Polygon Subscription Date,Payment mode,payment ref,Discounted_Amount,Invoice Reference Number,Invoice/Transaction entry date,Invoice Amount,Invoice Amount-Open,Product Code,Indicator";

describe.skipIf(!ready)("the gl_feed contract (D4, GL10, GL18)", () => {
  it("loads: header true, GL10's header exactly, GL18's types, the five required columns", () => {
    const contract = loadReportingContract("gl_feed");
    expect(contract.file).toBe("GLFEED_ORAFIN_<posting_date>.csv");
    expect(contract.header).toBe(true);
    expect(contract.columns.map(([name]) => name).join(",")).toBe(HEADER);
    expect(contract.columns).toEqual([
      ["MNO Public Key", "text", true],
      ["Commercial Unit", "text", false],
      ["Polygon ID", "text", false],
      ["Service Public Key", "text", false],
      ["Amount", "amount", true],
      ["Rev_GLCODE", "text", true],
      ["Polygon Subscription Date", "date", false],
      ["Payment mode", "text", false],
      ["payment ref", "text", false],
      ["Discounted_Amount", "amount", false],
      ["Invoice Reference Number", "text", false],
      ["Invoice/Transaction entry date", "date", true],
      ["Invoice Amount", "amount", false],
      ["Invoice Amount-Open", "amount", false],
      ["Product Code", "text", false],
      ["Indicator", "text", true],
    ]);
  });

  it("names Finance as its reader", () => {
    expect(read(join(REPORTING_CONTRACTS_DIR, "gl_feed.yaml"))).toMatch(
      /^# GLFEED_ORAFIN_<posting_date>\.csv — Finance/m,
    );
  });
});

describe.skipIf(!ready)("R09-T1 — apportionment (D1)", () => {
  const SHARES = `import json
from decimal import Decimal as D
from runtime.reporting.common.polygon_lines import CapacityLine, PolygonLine, apportion_discount
def p(udr, polygon, amount):
    return PolygonLine("B1", udr, "L1", "OFF1", polygon, "2025-03-01", "CU", D("1"), D(amount))
def shares(discount, amounts):
    polys = [p(f"u{i}", f"P{i}", a) for i, a in enumerate(amounts)]
    out = apportion_discount(CapacityLine("L1", "B1", "OFF1", D(discount), sum(D(a) for a in amounts)), polys)
    return [str(out[x.udr_id]) for x in polys]
`;

  it("100.00 over 500.00 / 300.00 / 200.00 is 50.00 / 30.00 / 20.00; over three equal polygons 33.33 / 33.33 / 33.34", () => {
    expect(
      python(`${SHARES}
print(json.dumps([shares("100.00", ["500.00", "300.00", "200.00"]), shares("100.00", ["10.00", "10.00", "10.00"])]))`),
    ).toEqual([
      ["50.00", "30.00", "20.00"],
      ["33.33", "33.33", "33.34"],
    ]);
  });

  it("the shares always add up to the line's discount (100 random lines)", () => {
    expect(
      python(`${SHARES}
import random
random.seed(9)
bad = []
for _ in range(100):
    amounts = [f"{random.randint(1, 99999) / 100:.2f}" for _ in range(random.randint(1, 7))]
    discount = f"{random.randint(0, int(sum(float(a) for a in amounts) * 100)) / 100:.2f}"
    if sum(D(s) for s in shares(discount, amounts)) != D(discount):
        bad.append([discount, amounts])
print(json.dumps(bad))`),
    ).toEqual([]);
  });
});

describe.skipIf(!ready)("the §E.1 table (D2, GL24)", () => {
  it("one entry per row kind, each naming its subject role, GL side and Indicator", () => {
    expect(
      python(`import json
from runtime.reporting.gl_feed import rows
print(json.dumps([[k.name, k.doc_type, list(k.line_kinds), k.reversal, k.reason, k.subject, k.gl_side, k.indicator, k.annual]
                  for k in rows.ROW_KINDS]))`),
    ).toEqual([
      [
        "invoice_charges",
        "INV",
        ["charge"],
        false,
        null,
        "receivables",
        "product",
        "I",
        true,
      ],
      [
        "invoice_tax",
        "INV",
        ["release"],
        false,
        null,
        "receivables",
        "counter",
        "I",
        true,
      ],
      [
        "payment_capture",
        "PAY",
        ["capture"],
        null,
        null,
        "unapplied_cash",
        "counter",
        "P",
        false,
      ],
      [
        "payment_allocation",
        "PAY",
        ["allocation"],
        null,
        null,
        "receivables",
        "subject",
        "P",
        false,
      ],
      [
        "payment_release",
        "PAY",
        ["release"],
        null,
        null,
        "receivables",
        "subject",
        "P",
        false,
      ],
      [
        "payment_refund",
        "PAY",
        ["refund"],
        null,
        null,
        "unapplied_cash",
        "counter",
        "P",
        false,
      ],
      [
        "credit_note",
        "CRN",
        ["charge"],
        null,
        null,
        "receivables",
        "counter",
        "A",
        false,
      ],
      [
        "one_time_charge",
        "DBN",
        ["charge", "release"],
        null,
        "occ_reason",
        "receivables",
        "counter",
        "I",
        false,
      ],
      [
        "debit_note",
        "DBN",
        ["charge", "release"],
        null,
        "other_reason",
        "receivables",
        "counter",
        "A",
        false,
      ],
      [
        "adjustment",
        "ADJ",
        ["charge", "release"],
        null,
        null,
        "receivables",
        "counter",
        "A",
        false,
      ],
      [
        "deposit",
        "DEP",
        ["capture", "release"],
        null,
        null,
        "deposits",
        "subject",
        "P",
        false,
      ],
      [
        "deposit_refund",
        "DEP",
        ["refund"],
        null,
        null,
        "unapplied_cash",
        "counter",
        "P",
        false,
      ],
    ]);
  });

  it("a line no kind matches is unmapped: a CRN release, an INV reversal, an unknown doc type; GL7 picks the DBN kind by reason code", () => {
    expect(
      python(`import json
from datetime import date, datetime, timezone
from decimal import Decimal as D
from runtime.reporting.gl_feed import rows
from runtime.reporting.gl_feed.extract import Document
def doc(doc_type, reason="R", reversal=False):
    t = datetime(2026, 10, 26, tzinfo=timezone.utc)
    return Document("D1", doc_type, reason, reversal, t, date(2026, 10, 26), date(2026, 10, 26), None, "", D("0"), "MNO", ())
def kind(d, line_kind, occ=("LATE",)):
    k = rows.row_kind(d, line_kind, occ)
    return None if k is None else k.name
print(json.dumps([kind(doc("CRN"), "release"), kind(doc("INV", reversal=True), "charge"),
                  kind(doc("XYZ"), "charge"), kind(doc("DBN", "LATE"), "charge"),
                  kind(doc("DBN", "MANUAL_CHARGE"), "release"), kind(doc("PAY", reversal=True), "capture")]))`),
    ).toEqual([
      null,
      null,
      null,
      "one_time_charge",
      "debit_note",
      "payment_capture",
    ]);
  });
});

// A hand-built extract. Accounts: REC (BAN B1's receivables), UC / DEP (FA
// F1's unapplied cash and deposits), CASH, REV, TAX (system accounts).
const EXTRACT = `import json
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal as D
from runtime.reporting.common.polygon_lines import CapacityLine, PolygonLine
from runtime.reporting.common.receivables import LedgerSnapshot, PostedLine
from runtime.reporting.gl_feed import rows
from runtime.reporting.gl_feed.extract import Bill, BillLine, Document, Extract, Invoice
KL = timezone(timedelta(hours=8))
DAY = date(2026, 10, 26)
def at(h):
    return datetime(2026, 10, 26, h, tzinfo=KL)
def line(lid, doc, doc_type, kind, amount, frm, to, settled=None, entry=DAY):
    return PostedLine(lid, doc, doc_type, "posted", entry, DAY, None, "ref", kind, settled,
                      None if settled is None else "INV", None, D(amount), frm, to)
def doc(did, doc_type, lines, h, total="0.00", mno="MNO1", reason="R", mode=None, ref="TT-1", entry=DAY):
    return Document(did, doc_type, reason, False, at(h), DAY, entry, mode, ref, D(total), mno, tuple(lines))
def poly(udr, pid, amount, cu="CU-1", start="2025-03-01"):
    return PolygonLine("CB1", udr, "BL1", "OFF-CAP", pid, start, cu, D("1"), D(amount))
LINES = (
    line("L1", "I1", "INV", "charge", "1250.00", "REV", "REC"),
    line("L2", "I1", "INV", "release", "100.00", "TAX", "REC"),
    line("L3", "C1", "PAY", "capture", "1500.00", "UC", "CASH"),
    line("L4", "A1", "PAY", "allocation", "600.00", "REC", "UC", settled="I0"),
    line("L5", "D1", "DEP", "capture", "5000.00", "DEP", "CASH"),
)
DOCS = (
    doc("I1", "INV", ["L1", "L2"], 9, total="1350.00"),
    doc("C1", "PAY", ["L3"], 10, mode="bank_transfer", ref="TT-57001"),
    doc("A1", "PAY", ["L4"], 11, ref="TT-57001", entry=date(2026, 10, 21)),
    doc("D1", "DEP", ["L5"], 12, mode="cheque", ref="CHQ-1"),
)
BILL_LINES = (
    BillLine("BL1", "CB1", "USAGE", "charge", True, "OFF-CAP", D("1150.00"), D("1000.00"), D("100.00"), D("1050.00")),
    BillLine("BL2", "CB1", "RECURRING", "charge", False, "OFF-REC", D("200.00"), None, D("0.00"), D("200.00")),
)
def extract(docs=DOCS, bill_lines=BILL_LINES, annual=False, day_effects="750.00", polygons=None, price=None):
    return Extract(
        documents=docs,
        ledger=LedgerSnapshot(LINES, {"B1": "REC"}, {"F1": "UC"}, {"F1": "DEP"}),
        gl_codes={"REC": "1200", "UC": "2300", "DEP": "2400", "CASH": "1050", "REV": "4000", "TAX": "2200"},
        day_effects={"B1": D(day_effects)},
        mno_billing_accounts={"MNO1": ("B1",)},
        invoices={"I1": Invoice("I1", D("1350.00"), "B1"), "I0": Invoice("I0", D("1000.00"), "B1")},
        bills={"I1": Bill("I1", None, annual, bill_lines)},
        polygons=polygons if polygons is not None else (poly("u3", "P-3", "200.00"), poly("u1", "P-1", "500.00"),
                                                         poly("u2", "P-2", "300.00", start="2025-04-15")),
        capacity_lines={"BL1": CapacityLine("BL1", "CB1", "OFF-CAP", D("100.00"), D("1000.00"))},
        price_gl_codes=price if price is not None else {"BL1": "4010", "BL2": None},
    )
def run(data, occ=("LATE",)):
    built = rows.build(data, DAY, occ)
    return {"rows": [",".join(r) for r in rows.render(built)],
            "problems": [p.line for p in built.problems],
            "fallbacks": [f.line for f in built.fallbacks],
            "violations": [[v.line, v.column, v.reason] for v in rows.check(built)]}
`;

describe.skipIf(!ready)("rows on a hand-built extract (D1–D4)", () => {
  it("D1 polygon rows (net Amount + Discounted_Amount), the top-up, the recurring row (GL9 fallback), the tax row; payment and deposit rows; GL13 order; D5 passes", () => {
    expect(python(`${EXTRACT}print(json.dumps(run(extract())))`)).toEqual({
      rows: [
        "MNO1,CU-1,P-1,,450.00,4010,20250301,,,50.00,I1,20261026,1350.00,1350.00,OFF-CAP,I",
        "MNO1,CU-1,P-2,,270.00,4010,20250415,,,30.00,I1,20261026,1350.00,1350.00,OFF-CAP,I",
        "MNO1,CU-1,P-3,,180.00,4010,20250301,,,20.00,I1,20261026,1350.00,1350.00,OFF-CAP,I",
        "MNO1,,,,150.00,4010,,,,,I1,20261026,1350.00,1350.00,OFF-CAP,I",
        "MNO1,,,,200.00,4000,,,,,I1,20261026,1350.00,1350.00,OFF-REC,I",
        "MNO1,,,,100.00,2200,,,,,I1,20261026,1350.00,1350.00,,I",
        "MNO1,,,,-1500.00,1050,,bank_transfer,TT-57001,,,20261026,,,,P",
        "MNO1,,,,-600.00,1200,,,TT-57001,,I0,20261021,1000.00,400.00,,P",
        "MNO1,,,,-5000.00,2400,,cheque,CHQ-1,,,20261026,,,,P",
      ],
      problems: [],
      fallbacks: ["GL_CODE_FALLBACK I1 OFF-REC"],
      violations: [],
    });
  });

  it("GL6 — an annual-cycle invoice's polygon, top-up, recurring and tax rows are P with a positive Amount; a one-time line stays I", () => {
    const result = python(`${EXTRACT}
lines = BILL_LINES[:1] + (BillLine("BL2", "CB1", "OCC", "charge", False, "OFF-OCC", D("200.00"), None, D("0.00"), D("200.00")),)
r = run(extract(bill_lines=lines, annual=True, price={"BL1": "4010", "BL2": "4030"}))
print(json.dumps([[x.split(",")[4], x.split(",")[15]] for x in r["rows"][:6]]))`);
    expect(result).toEqual([
      ["450.00", "P"],
      ["270.00", "P"],
      ["180.00", "P"],
      ["150.00", "P"],
      ["200.00", "I"],
      ["100.00", "P"],
    ]);
  });

  it("GL16 — every problem is listed once per document, in document order: CAPACITY_LINE_MISMATCH, POLYGON_ID_MISSING, POLYGON_START_DATE_MISSING, UNMAPPED_DOCUMENT, MNO_PUBLIC_KEY_MISSING, GL_CODE_UNRESOLVED", () => {
    expect(
      python(`${EXTRACT}
mismatch = run(extract(polygons=(poly("u1", "P-1", "500.00"), poly("u2", "P-2", "300.00"), poly("u3", "P-3", "199.00"))))
missing = run(extract(polygons=(poly("u1", None, "500.00"), poly("u2", "P-2", "300.00", start=None), poly("u3", "P-3", "200.00"))))
other_usage = BILL_LINES + (BillLine("BL3", "CB1", "USAGE", "charge", False, "OFF-GB", D("8.00"), None, D("0.00"), D("8.00")),)
unmapped = run(extract(bill_lines=other_usage, docs=DOCS[:1] + (replace(DOCS[1], doc_type="CRN"), replace(DOCS[2], mno_public_key=None))))
data = extract()
unresolved = run(replace(data, gl_codes={k: v for k, v in data.gl_codes.items() if k != "CASH"}))
print(json.dumps([r["problems"] for r in (mismatch, missing, unmapped, unresolved)]))`),
    ).toEqual([
      ["GL_ROW_INVALID I1 CAPACITY_LINE_MISMATCH"],
      [
        "GL_ROW_INVALID I1 POLYGON_ID_MISSING",
        "GL_ROW_INVALID I1 POLYGON_START_DATE_MISSING",
      ],
      [
        "GL_ROW_INVALID I1 UNMAPPED_DOCUMENT",
        "GL_ROW_INVALID C1 UNMAPPED_DOCUMENT",
        "GL_ROW_INVALID A1 MNO_PUBLIC_KEY_MISSING",
      ],
      ["GL_ROW_INVALID C1 GL_CODE_UNRESOLVED"],
    ]);
  });

  it("D1 — a capacity line whose rows don't come to its net_amount fails CAPACITY_LINE_MISMATCH", () => {
    expect(
      python(`${EXTRACT}
lines = (replace(BILL_LINES[0], net_amount=D("1049.99")),) + BILL_LINES[1:]
print(json.dumps(run(extract(bill_lines=lines))["problems"]))`),
    ).toEqual(["GL_ROW_INVALID I1 CAPACITY_LINE_MISMATCH"]);
  });

  it("GL7 — with the DBN's reason code listed in occ_reason_codes the row is I, otherwise A", () => {
    expect(
      python(`${EXTRACT}
dbn = doc("N1", "DBN", ["L6"], 13, reason="MANUAL_CHARGE")
data = extract(docs=DOCS + (dbn,), day_effects="800.00")
data = replace(data, ledger=replace(data.ledger, lines=data.ledger.lines + (line("L6", "N1", "DBN", "charge", "50.00", "REV", "REC"),)))
print(json.dumps([run(data)["rows"][-1], run(data, ("MANUAL_CHARGE",))["rows"][-1]]))`),
    ).toEqual([
      "MNO1,,,,50.00,4000,,,,,,20261026,,,,A",
      "MNO1,,,,50.00,4000,,,,,,20261026,,,,I",
    ]);
  });
});

describe.skipIf(!ready)("D5 — the report checks", () => {
  it("(b) the MNO's receivables rows against the ledger's own day: GL_RECONCILIATION <mno>; captures and deposits are not counted", () => {
    expect(
      python(
        `${EXTRACT}print(json.dumps(run(extract(day_effects="749.99"))["violations"]))`,
      ),
    ).toEqual([[null, "Amount", "GL_RECONCILIATION MNO1"]]);
  });

  it("(a) an invoice whose rows don't add up to its total: INVOICE_SUM <invoice_id> on its first row", () => {
    expect(
      python(`${EXTRACT}
docs = (replace(DOCS[0], total_amount=D("1350.01")),) + DOCS[1:]
print(json.dumps(run(extract(docs=docs))["violations"]))`),
    ).toEqual([[2, "Amount", "INVOICE_SUM I1"]]);
  });

  it("(c) an Indicator outside I / P / A fails BAD_TEXT", () => {
    expect(
      python(`${EXTRACT}
built = rows.build(extract(), DAY, ())
built.rows[0] = replace(built.rows[0], indicator="X")
print(json.dumps([[v.line, v.column, v.reason] for v in rows.check(built)]))`),
    ).toEqual([[2, "Indicator", "BAD_TEXT"]]);
  });
});

describe.skipIf(!ready)("encryption (D6, R09-T7, R09-T8)", () => {
  const CSV = `${HEADER}\nMNO1,,,,1.00,1200,,,,,,20261026,,,,P\n`;

  function encryptDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "rpt09-encrypt-"));
    writeFileSync(join(dir, "GLFEED_ORAFIN_20261026.csv"), CSV);
    return dir;
  }

  const encrypt = (dir: string, env: Record<string, string>) =>
    runReportingPython(
      [
        "-m",
        "runtime.reporting.common.encrypt",
        "encrypt",
        "--method=zip_aes256",
        "--file=GLFEED_ORAFIN_20261026.csv",
      ],
      { cwd: dir, env },
    );

  it("R09-T8 — the zip opens with pyzipper and the password, holds exactly the one CSV (AES-256, deflated), and fails without it; the plain CSV is gone", () => {
    const dir = encryptDir();
    const run = encrypt(dir, { GLFEED_ZIP_PASSWORD: "s3cret pass" });
    expect(run.status, run.stderr).toBe(0);
    expect(parseKestraLines(run.stdout).outputs).toEqual({
      file: "GLFEED_ORAFIN_20261026.zip",
    });
    expect(readdirSync(dir)).toEqual(["GLFEED_ORAFIN_20261026.zip"]);
    expect(run.stdout + run.stderr).not.toContain("s3cret");
    expect(
      python(`import json, pyzipper, zipfile
path = r"${join(dir, "GLFEED_ORAFIN_20261026.zip")}"
with pyzipper.AESZipFile(path) as z:
    info = z.infolist()
    out = {"names": z.namelist(), "compress": info[0].compress_type == zipfile.ZIP_DEFLATED,
           "aes": [i.flag_bits & 0x1 for i in info]}
    try:
        z.read(info[0].filename)
        out["without"] = "opened"
    except RuntimeError:
        out["without"] = "refused"
    try:
        z.setpassword(b"wrong")
        z.read(info[0].filename)
        out["wrong"] = "opened"
    except RuntimeError:
        out["wrong"] = "refused"
    z.setpassword(b"s3cret pass")
    out["text"] = z.read(info[0].filename).decode("utf-8")
with zipfile.ZipFile(path) as plain:
    out["aes_extra"] = any(e.extra[:2] == b"\\x01\\x99" for e in plain.infolist())
print(json.dumps(out))`),
    ).toEqual({
      names: ["GLFEED_ORAFIN_20261026.csv"],
      compress: true,
      aes: [1],
      without: "refused",
      wrong: "refused",
      text: CSV,
      aes_extra: true,
    });
  });

  // check reads the engine's base64 SECRET_GLFEED_ZIP_PASSWORD (a missing
  // secret() fails at render on v1.3.35); encrypt reads the decoded
  // GLFEED_ZIP_PASSWORD the flow renders from the Kestra secret.
  it("R09-T7 — check fails ENCRYPTION_KEY_MISSING with the secret unset, empty or not base64; encrypt with no (or an empty) password; the CSV stays only in the task's directory, no zip", () => {
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{}, {}],
      [{ SECRET_GLFEED_ZIP_PASSWORD: "" }, { GLFEED_ZIP_PASSWORD: "" }],
      [{ SECRET_GLFEED_ZIP_PASSWORD: "not base64!" }, {}],
    ];
    for (const [secret, env] of cases) {
      const check = runReportingPython(
        [
          "-m",
          "runtime.reporting.common.encrypt",
          "check",
          "--method=zip_aes256",
        ],
        { env: secret },
      );
      expect(check.status).not.toBe(0);
      expect(parseKestraLines(check.stdout).logs).toEqual([
        { level: "ERROR", message: "ENCRYPTION_KEY_MISSING" },
      ]);
      const dir = encryptDir();
      const run = encrypt(dir, env);
      expect(run.status).not.toBe(0);
      expect(readdirSync(dir)).toEqual(["GLFEED_ORAFIN_20261026.csv"]);
    }
    const ok = runReportingPython(
      [
        "-m",
        "runtime.reporting.common.encrypt",
        "check",
        "--method=zip_aes256",
      ],
      { env: { SECRET_GLFEED_ZIP_PASSWORD: "eA==" } },
    );
    expect(ok.status, ok.stderr).toBe(0);
  });

  it("an existing zip is never replaced; an unknown method is refused", () => {
    const dir = encryptDir();
    writeFileSync(join(dir, "GLFEED_ORAFIN_20261026.zip"), "earlier");
    const run = encrypt(dir, { GLFEED_ZIP_PASSWORD: "x" });
    expect(run.status).not.toBe(0);
    expect(read(join(dir, "GLFEED_ORAFIN_20261026.zip"))).toBe("earlier");
    const pgp = runReportingPython(
      ["-m", "runtime.reporting.common.encrypt", "check", "--method=pgp"],
      { env: { GLFEED_ZIP_PASSWORD: "x" } },
    );
    expect(pgp.status).not.toBe(0);
  });
});

describe("report-gl-feed — static shape (D7, GL21–GL23)", () => {
  const { flow, task, command } = loadReportFlow(FLOW);
  const build = (task("build").tasks as FlowTask[]) ?? [];
  const inBuild = (id: string) => build.find((t) => t.id === id)!;
  const commands = (t: FlowTask) => (t.commands as string[]).join(" ");

  it("id, namespace, description, one optional posting_date input, the report label, the two variables; enabled, manual (no triggers)", () => {
    expect(flow.id).toBe("report-gl-feed");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toBe("GL feed (Oracle Financials)");
    expect(flow.inputs.map((i) => [i.id, i.type, i.required])).toEqual([
      ["posting_date", "STRING", false],
    ]);
    expect(flow.labels).toEqual({ report: "gl_feed" });
    expect(flow.variables).toEqual({
      occ_reason_codes: "MNO_SIGNUP_FEE,LATE_PAYMENT_CHARGE,INTEGRATION_CHARGE",
      encryption: "zip_aes256",
    });
    expect(flow.disabled).toBeUndefined();
    expect(flow.triggers).toBeUndefined();
    expect(flow.outputs).toBeUndefined();
  });

  it("tasks run check_secret → validate_date → generate → validate_output → encrypt → publish → set_status, the middle three in one working directory", () => {
    expect(flow.tasks.map((t) => t.id)).toEqual([
      "trace",
      "check_secret",
      "validate_date",
      "inputs_labels",
      "build",
      "count_labels",
      "publish",
      "set_status",
    ]);
    expect(task("build")).toMatchObject({
      type: "io.kestra.plugin.core.flow.WorkingDirectory",
      namespaceFiles: { enabled: true, include: ["contracts/**"] },
    });
    expect(build.map((t) => t.id)).toEqual([
      "generate",
      "validate_output",
      "encrypt",
    ]);
    expect(task("validate_date")).toMatchObject({
      type: "io.kestra.plugin.core.flow.Subflow",
      flowId: "report-validate-date",
      inputs: {
        name: "posting_date",
        value: "{{ inputs.posting_date ?? '' }}",
        rule: "before_today",
        default: "yesterday",
      },
    });
    expect((task("set_status").then as FlowTask[])[0]!.state).toBe("WARNING");
    expect(task("set_status").condition).toBe(
      "{{ outputs.generate.vars.status == 'WARNING' }}",
    );
  });

  it("labels: flow_revision, posting_date (effective), rows, gl_code_fallbacks", () => {
    expectFlowRevisionTrace(task("trace"));
    expect(task("inputs_labels").labels).toEqual({
      posting_date: "{{ outputs.validate_date.outputs.effective_date }}",
    });
    expect(task("count_labels").labels).toEqual({
      rows: "{{ outputs.generate.vars.rows }}",
      gl_code_fallbacks: "{{ outputs.generate.vars.gl_code_fallbacks }}",
    });
  });

  it("D6 — the password reaches encrypt as an env var from the Kestra secret only, never on a command line; check_secret isn't handed it", () => {
    expect(
      (inBuild("encrypt").env as Record<string, string>).GLFEED_ZIP_PASSWORD,
    ).toBe("{{ secret('GLFEED_ZIP_PASSWORD') }}");
    expect(task("check_secret").env).toEqual({
      ENCRYPTION: "{{ vars.encryption }}",
    });
    for (const t of [task("check_secret"), ...build, task("publish")]) {
      expect(t.taskRunner).toEqual({
        type: "io.kestra.plugin.core.runner.Process",
      });
      expect(commands(t)).not.toMatch(/\{\{|GLFEED_ZIP_PASSWORD|secret/);
    }
    expect(command("check_secret")).toContain(
      "python3 -m runtime.reporting.common.encrypt check",
    );
    expect(commands(inBuild("generate"))).toContain(
      "python3 -m runtime.reporting.gl_feed",
    );
    expect(commands(inBuild("validate_output"))).toContain(
      "python3 -m runtime.reporting.validate output --contract=contracts/gl_feed.yaml",
    );
    expect(commands(inBuild("encrypt"))).toContain(
      "python3 -m runtime.reporting.common.encrypt encrypt",
    );
  });

  it("[guardrail 7, static] no task lists a CSV as an output file: only encrypt's zip leaves the working directory, and publish publishes the zip", () => {
    const outputs = [...flow.tasks, ...build].flatMap(
      (t) => (t.outputFiles as string[] | undefined) ?? [],
    );
    expect(outputs).toEqual(["GLFEED_ORAFIN_*.zip", "GLFEED_ORAFIN_*.zip"]);
    expect(inBuild("encrypt").outputFiles).toEqual(["GLFEED_ORAFIN_*.zip"]);
    expect(task("publish").outputFiles).toEqual(["GLFEED_ORAFIN_*.zip"]);
    expect(task("publish").inputFiles).toEqual({
      "{{ outputs.encrypt.vars.file }}":
        "{{ outputs.encrypt.outputFiles[outputs.encrypt.vars.file] }}",
    });
    expect(read(FLOW)).not.toMatch(/outputFiles:\s*\n\s*- [^\n]*\.csv/);
  });
});
