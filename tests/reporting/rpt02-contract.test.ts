import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  parseKestraLines,
  reportingRuntimeReady,
  runReportingPython,
  type KestraLines,
} from "@/tests/helpers/reporting-harness";

// rpt02-spec T-R02-7 / T-R02-8 / T-R02-9 (unit half) — common/contract.py and
// `validate output`, the command behind report-validate-output. The working
// directory mirrors the Kestra task's: contracts/<id>.yaml beside the file.
// Every case runs `validate`'s main() in one Python process (a subprocess per
// case would take minutes); one case also runs `python3 -m` for real.

const ready = reportingRuntimeReady();

const FIXTURES = join(process.cwd(), "tests/fixtures/reporting/rpt02");
const work = mkdtempSync(join(tmpdir(), "rpt02-contract-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const HEADED = "Rpt02_headed_20261029.csv";
const HEADERLESS = "Rpt02_headerless_20261029.csv";

const BAD_CONTRACTS: Record<string, string> = {
  bad_key:
    "id: bad_key\nfile: x.csv\nheader: false\ncolumns:\n  - name: a\n    type: text\n    requird: true\n",
  bad_type:
    "id: bad_type\nfile: x.csv\nheader: false\ncolumns:\n  - name: a\n    type: money\n    required: true\n",
  dup_name:
    "id: dup_name\nfile: x.csv\nheader: true\ncolumns:\n  - name: a\n    type: text\n    required: true\n  - name: a\n    type: date\n    required: false\n",
  wrong_id:
    "id: other\nfile: x.csv\nheader: false\ncolumns:\n  - name: a\n    type: text\n    required: true\n",
  missing_req:
    "id: missing_req\nfile: x.csv\nheader: false\ncolumns:\n  - name: a\n    type: text\n",
  top_key:
    "id: top_key\nfile: x.csv\nheader: false\ndelimiter: ';'\ncolumns:\n  - name: a\n    type: text\n    required: true\n",
  comma_name:
    "id: comma_name\nfile: x.csv\nheader: true\ncolumns:\n  - name: 'a,b'\n    type: text\n    required: true\n",
  not_yaml: "id: [unclosed\n",
};

// The headed fixture plus a third row, as lines (no trailing LF).
const H =
  "Invoice Date,Invoice No,Customer Name,Invoice Amount,Discount Amount,Usage Count,Due Date,Note";
const R1 =
  '20261029,INV-0001,"Acme, Sdn Bhd",1234.50,0.00,1001,20261128,"He said ""hi"""';
const R2 = "20261029,INV-0002,Beta Telco,-12.35,,0,,";
const R3 = "20261030,INV-0003,Gamma,12.50,,5,,";
const lf = (...lines: string[]) => lines.map((l) => l + "\n").join("");

const DATA_FILES: Record<string, string | Buffer> = {
  "swapped.csv": lf(
    "Invoice No,Invoice Date,Customer Name,Invoice Amount,Discount Amount,Usage Count,Due Date,Note",
    "INV-0002,20261029,Beta Telco,-12.35,,0,,",
  ),
  "bad_date.csv": lf(H, R1.replace("20261029", "20261301"), R2, R3),
  "bad_amount.csv": lf(H, R1, R2, R3.replace("12.50", "12.5")),
  "seven_fields.csv": lf(H, R1, R2.replace(/,$/, ""), R3),
  "bom.csv": Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(lf(H, R1)),
  ]),
  "crlf.csv": H + "\n" + R1 + "\r\n" + R2 + "\n",
  "required_empty.csv": lf(H, R1, R2, R3.replace("INV-0003", "")),
  "negative_zero.csv": lf(
    H,
    R3.replace("12.50", "-0.00").replace(",5,", ",-0,"),
  ),
  "leading_zero.csv": lf(H, R3.replace(",5,", ",007,")),
  "no_final_lf.csv": H + "\n" + R1,
  "bad_quoting.csv": lf(H, R3.replace("Gamma", '"Gamma"x')),
  "not_utf8.csv": Buffer.concat([
    Buffer.from(lf(H)),
    Buffer.from([0x32, 0x30, 0xff, 0x0a]),
  ]),
  "empty.csv": "",
  "many.csv": lf(
    ...Array.from({ length: 60 }, (_, i) => `MNO${i},P-${i},x,20261029`),
  ),
  "header_only.csv": lf(H),
};

interface CaseResult extends KestraLines {
  exit: number;
}

const DRIVER = `
import contextlib, io, json, sys
from runtime.reporting.validate.__main__ import main
results = {}
for name, argv in json.loads(sys.argv[1]).items():
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(argv)
    results[name] = {"exit": code, "stdout": out.getvalue()}
print(json.dumps(results))
`;

const CASES: Record<string, string[]> = {};
function output(contract: string, file: string, name?: string): string[] {
  return [
    "output",
    `--contract=contracts/${contract}.yaml`,
    `--file=${file}`,
    ...(name ? [`--name=${name}`] : []),
  ];
}

let results: Record<string, CaseResult> = {};

beforeAll(() => {
  if (!ready) return;
  mkdirSync(join(work, "contracts"));
  for (const id of ["rpt02_headed", "rpt02_headerless"]) {
    copyFileSync(
      join(FIXTURES, "contracts", `${id}.yaml`),
      join(work, "contracts", `${id}.yaml`),
    );
  }
  for (const [id, body] of Object.entries(BAD_CONTRACTS)) {
    writeFileSync(join(work, "contracts", `${id}.yaml`), body);
  }
  for (const [name, body] of Object.entries(DATA_FILES))
    writeFileSync(join(work, name), body);
  copyFileSync(join(FIXTURES, HEADED), join(work, HEADED));
  copyFileSync(join(FIXTURES, HEADERLESS), join(work, HEADERLESS));

  for (const id of Object.keys(BAD_CONTRACTS))
    CASES[`contract:${id}`] = output(id, HEADERLESS);
  CASES["contract:missing"] = output("nope", HEADERLESS);
  CASES["contract:traversal"] = [
    "output",
    "--contract=contracts/../x.yaml",
    `--file=${HEADERLESS}`,
  ];
  for (const name of Object.keys(DATA_FILES)) {
    const contract = ["empty.csv", "many.csv"].includes(name)
      ? "rpt02_headerless"
      : "rpt02_headed";
    CASES[`file:${name}`] = output(
      contract,
      name,
      `kestra:///reporting/x/inputs/file/${name}`,
    );
  }
  CASES["pass:headed"] = output("rpt02_headed", HEADED);
  CASES["pass:headerless"] = output("rpt02_headerless", HEADERLESS);

  const run = runReportingPython(["-c", DRIVER, JSON.stringify(CASES)], {
    cwd: work,
  });
  expect(run.status, run.stderr).toBe(0);
  const raw = JSON.parse(run.stdout) as Record<
    string,
    { exit: number; stdout: string }
  >;
  results = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [
      k,
      { exit: v.exit, ...parseKestraLines(v.stdout) },
    ]),
  );
}, 120_000);

function errors(key: string): string[] {
  const r = results[key]!;
  expect(r.exit, key).toBe(1);
  expect(r.outputs, key).toEqual({});
  expect(
    r.logs.every((l) => l.level === "ERROR"),
    key,
  ).toBe(true);
  return r.logs.map((l) => l.message);
}

describe.skipIf(!ready)(
  "T-R02-7 — contract loading (contract.py)",
  { timeout: 60_000 },
  () => {
    it("an unknown key, an unknown type, a duplicate name or id ≠ file name → CONTRACT_INVALID", () => {
      expect(errors("contract:bad_key")).toEqual([
        "CONTRACT_INVALID bad_key unknown key 'requird' in column 1",
      ]);
      expect(errors("contract:bad_type")).toEqual([
        "CONTRACT_INVALID bad_type unknown type 'money' in column 1",
      ]);
      expect(errors("contract:dup_name")).toEqual([
        "CONTRACT_INVALID dup_name duplicate name 'a'",
      ]);
      expect(errors("contract:wrong_id")).toEqual([
        "CONTRACT_INVALID wrong_id id 'other' does not equal the file name",
      ]);
    });

    it("a missing key, an unknown top-level key, a name needing quotes, invalid YAML, a missing file or a path outside contracts/ → CONTRACT_INVALID", () => {
      expect(errors("contract:missing_req")).toEqual([
        "CONTRACT_INVALID missing_req missing key 'required' in column 1",
      ]);
      expect(errors("contract:top_key")).toEqual([
        "CONTRACT_INVALID top_key unknown key 'delimiter' in contract",
      ]);
      expect(errors("contract:comma_name")).toEqual([
        "CONTRACT_INVALID comma_name column 1 name 'a,b' contains , \" CR or LF",
      ]);
      expect(errors("contract:not_yaml")).toEqual([
        "CONTRACT_INVALID not_yaml not valid YAML",
      ]);
      expect(errors("contract:missing")).toEqual([
        "CONTRACT_INVALID nope unreadable (FileNotFoundError)",
      ]);
      expect(errors("contract:traversal")).toEqual([
        "CONTRACT_INVALID x path must be contracts/<id>.yaml",
      ]);
    });
  },
);

describe.skipIf(!ready)(
  "T-R02-8 — output check refuses a bad file (contract.py, T19)",
  { timeout: 60_000 },
  () => {
    const v = (file: string, row: number, column: string, reason: string) =>
      `OUTPUT_CONTRACT_VIOLATION ${file} ${row} ${column} ${reason}`;

    it("names file, row and column exactly for each spec case", () => {
      expect(errors("file:swapped.csv")).toEqual([
        v("swapped.csv", 1, "Invoice Date", "HEADER_MISMATCH"),
        v("swapped.csv", 1, "Invoice No", "HEADER_MISMATCH"),
      ]);
      expect(errors("file:bad_date.csv")).toEqual([
        v("bad_date.csv", 2, "Invoice Date", "BAD_DATE"),
      ]);
      expect(errors("file:bad_amount.csv")).toEqual([
        v("bad_amount.csv", 4, "Invoice Amount", "BAD_AMOUNT"),
      ]);
      expect(errors("file:seven_fields.csv")).toEqual([
        v("seven_fields.csv", 3, "-", "FIELD_COUNT"),
      ]);
      expect(errors("file:bom.csv")).toEqual([v("bom.csv", 1, "-", "BOM")]);
      expect(errors("file:crlf.csv")).toEqual([
        v("crlf.csv", 2, "-", "CR_IN_FILE"),
      ]);
      expect(errors("file:required_empty.csv")).toEqual([
        v("required_empty.csv", 4, "Invoice No", "REQUIRED_EMPTY"),
      ]);
    });

    it("refuses -0.00, -0 and leading zeros, a missing final LF, bad quoting, non-UTF-8 and an empty header: false file", () => {
      expect(errors("file:negative_zero.csv")).toEqual([
        v("negative_zero.csv", 2, "Invoice Amount", "BAD_AMOUNT"),
        v("negative_zero.csv", 2, "Usage Count", "BAD_INTEGER"),
      ]);
      expect(errors("file:leading_zero.csv")).toEqual([
        v("leading_zero.csv", 2, "Usage Count", "BAD_INTEGER"),
      ]);
      expect(errors("file:no_final_lf.csv")).toEqual([
        v("no_final_lf.csv", 2, "-", "NO_FINAL_LF"),
      ]);
      expect(errors("file:bad_quoting.csv")).toEqual([
        v("bad_quoting.csv", 2, "-", "BAD_QUOTING"),
      ]);
      expect(errors("file:not_utf8.csv")).toEqual([
        v("not_utf8.csv", 2, "-", "NOT_UTF8"),
      ]);
      expect(errors("file:empty.csv")).toEqual([
        v("empty.csv", 1, "-", "EMPTY_FILE"),
      ]);
    });

    it("logs at most 50 violations, then `… <n> more`", () => {
      const lines = errors("file:many.csv");
      expect(lines).toHaveLength(51);
      expect(lines[0]).toBe(v("many.csv", 1, "capacity", "BAD_INTEGER"));
      expect(lines[49]).toBe(v("many.csv", 50, "capacity", "BAD_INTEGER"));
      expect(lines[50]).toBe("OUTPUT_CONTRACT_VIOLATION many.csv … 10 more");
    });

    it("check_file() returns (row, column, reason) tuples, stopping at the first failing stage", () => {
      const run = runReportingPython(
        [
          "-c",
          `import json
from runtime.reporting.common.contract import check_file, load_contract
c = load_contract("contracts/rpt02_headed.yaml")
print(json.dumps([[x.row, x.column, x.reason] for x in check_file("crlf.csv", c)]))`,
        ],
        { cwd: work },
      );
      expect(run.status, run.stderr).toBe(0);
      // crlf.csv also has a valid shape and fields: only the bytes stage reports.
      expect(JSON.parse(run.stdout)).toEqual([[2, "-", "CR_IN_FILE"]]);
    });
  },
);

describe.skipIf(!ready)(
  "T-R02-9 — output check passes (contract.py)",
  { timeout: 60_000 },
  () => {
    it("the writer's output for each shape passes, and `rows` is the data-row count", () => {
      expect(results["pass:headed"]).toEqual({
        exit: 0,
        outputs: { rows: 2 },
        logs: [],
      });
      expect(results["pass:headerless"]).toEqual({
        exit: 0,
        outputs: { rows: 2 },
        logs: [],
      });
    });

    it("a header-only file passes with header: true and rows = 0 (GL17)", () => {
      expect(results["file:header_only.csv"]).toEqual({
        exit: 0,
        outputs: { rows: 0 },
        logs: [],
      });
    });

    it("python3 -m runtime.reporting.validate output runs as the subflow runs it", () => {
      const run = runReportingPython(
        [
          "-m",
          "runtime.reporting.validate",
          "output",
          "--contract=contracts/rpt02_headed.yaml",
          `--file=${HEADED}`,
        ],
        { cwd: work },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(parseKestraLines(run.stdout)).toEqual({
        outputs: { rows: 2 },
        logs: [],
      });
      expect(
        readFileSync(join(work, HEADED)).equals(
          readFileSync(join(FIXTURES, HEADED)),
        ),
      ).toBe(true);
    });
  },
);
