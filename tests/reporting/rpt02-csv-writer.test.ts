import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt02-spec T-R02-5 / T-R02-6 — common/csv_writer.py (unit: no database).
// The writer's output is byte-compared against hand-written fixtures
// (tests/fixtures/reporting/rpt02/, kept byte-exact by .gitattributes), one
// per contract shape — the format half of T18 / P-T11 and guardrail 3.

const ready = reportingRuntimeReady();

const FIXTURES = join(process.cwd(), "tests/fixtures/reporting/rpt02");
const work = mkdtempSync(join(tmpdir(), "rpt02-writer-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// Writes both fixture shapes with the real formatting helpers.
const WRITE_BOTH = `
import sys
from datetime import date
from decimal import Decimal
from pathlib import Path
from runtime.reporting.common.contract import load_contract
from runtime.reporting.common.csv_writer import fmt_amount, fmt_blank, fmt_date, fmt_integer, write_csv

fixtures, out = Path(sys.argv[1]), Path(sys.argv[2])
headed = load_contract(fixtures / "contracts" / "rpt02_headed.yaml")
write_csv(out / "Rpt02_headed_20261029.csv", headed, [
    [fmt_date(date(2026, 10, 29)), "INV-0001", "Acme, Sdn Bhd", fmt_amount(Decimal("1234.5")),
     fmt_amount(Decimal("-0.004")), fmt_integer(Decimal("1000.5")), fmt_date(date(2026, 11, 28)), 'He said "hi"'],
    [fmt_date(date(2026, 10, 29)), "INV-0002", "Beta Telco", fmt_amount(Decimal("-12.345")),
     fmt_blank(), fmt_integer(Decimal("-0.4")), fmt_blank(), fmt_blank()],
])
headerless = load_contract(fixtures / "contracts" / "rpt02_headerless.yaml")
write_csv(out / "Rpt02_headerless_20261029.csv", headerless, [
    ["MNO1", "P-001", fmt_integer(Decimal("99.5")), fmt_date(date(2026, 10, 29))],
    ["MNO2", "P-002", fmt_integer(Decimal("7")), fmt_date(date(2026, 10, 29))],
])
write_csv(out / "header_only.csv", headed, [])
write_csv(out / "headerless_empty.csv", headerless, [])
`;

function writeBoth(): void {
  const run = runReportingPython(["-c", WRITE_BOTH, FIXTURES, work]);
  expect(run.status, run.stderr).toBe(0);
}

describe.skipIf(!ready)(
  "T-R02-5 — writer format (csv_writer.py)",
  { timeout: 60_000 },
  () => {
    it("writes both contract shapes byte-for-byte as the fixtures", () => {
      writeBoth();
      for (const name of [
        "Rpt02_headed_20261029.csv",
        "Rpt02_headerless_20261029.csv",
      ]) {
        const written = readFileSync(join(work, name));
        const fixture = readFileSync(join(FIXTURES, name));
        expect(
          written.equals(fixture),
          `${name} differs from its fixture`,
        ).toBe(true);

        // Format rules, asserted directly as well (guardrail 3).
        expect(
          written.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
        ).toBe(false);
        expect(written.includes(0x0d)).toBe(false);
        expect(written.at(-1)).toBe(0x0a);
        // No space after a separator (quoted values may hold ", ").
        const unquoted = written
          .toString("utf8")
          .replace(/"(?:[^"]|"")*"/g, '""');
        expect(unquoted).not.toContain(", ");
      }
    });

    it("writes the header only with header: true, exactly the column names", () => {
      const headed = readFileSync(
        join(work, "Rpt02_headed_20261029.csv"),
        "utf8",
      );
      expect(headed.split("\n")[0]).toBe(
        "Invoice Date,Invoice No,Customer Name,Invoice Amount,Discount Amount,Usage Count,Due Date,Note",
      );
      const headerless = readFileSync(
        join(work, "Rpt02_headerless_20261029.csv"),
        "utf8",
      );
      expect(headerless.split("\n")[0]).toBe("MNO1,P-001,100,20261029");
      expect(readFileSync(join(work, "header_only.csv"), "utf8")).toBe(
        headed.split("\n")[0] + "\n",
      );
      expect(readFileSync(join(work, "headerless_empty.csv")).length).toBe(0);
    });

    it("formats 1234.5 → 1234.50, -0.004 → 0.00, integer 1000.5 → 1001 (half-up)", () => {
      const run = runReportingPython([
        "-c",
        `import json
from datetime import date
from decimal import Decimal
from runtime.reporting.common.csv_writer import fmt_amount, fmt_blank, fmt_date, fmt_integer
out = {
    "amounts": [fmt_amount(Decimal(v)) for v in ["1234.5", "-0.004", "-0.005", "0.005", "-12.345", "1000000", "0"]],
    "integers": [fmt_integer(Decimal(v)) for v in ["1000.5", "-0.4", "-0.5", "2.4999", "1E+3"]],
    "date": fmt_date(date(2026, 1, 5)),
    "blank": fmt_blank(),
}
for bad in (1.5, "1.5"):
    try:
        fmt_amount(bad)
    except TypeError:
        out.setdefault("refused", []).append(repr(bad))
print(json.dumps(out))`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        amounts: [
          "1234.50",
          "0.00",
          "-0.01",
          "0.01",
          "-12.35",
          "1000000.00",
          "0.00",
        ],
        integers: ["1001", "0", "-1", "2", "1000"],
        date: "20260105",
        blank: "",
        refused: ["1.5", "'1.5'"],
      });
    });
  },
);

describe.skipIf(!ready)(
  "T-R02-6 — quoting (csv_writer.py)",
  { timeout: 60_000 },
  () => {
    it("quotes a comma, doubles a quote, refuses LF/CR with WRITER_INVALID_VALUE and writes nothing; refuses a wrong field count", () => {
      const run = runReportingPython([
        "-c",
        `import json, sys
from pathlib import Path
from runtime.reporting.common import codes
from runtime.reporting.common.contract import load_contract
from runtime.reporting.common.csv_writer import WriterInvalidValue, render, write_csv
c = load_contract(Path(sys.argv[1]) / "contracts" / "rpt02_headerless.yaml")
out = {
    "comma": render(c, [["a,b", "P", "1", "20261029"]]).decode(),
    "quote": render(c, [['say "x"', "P", "1", "20261029"]]).decode(),
    "plain": render(c, [["a b", "P", "1", "20261029"]]).decode(),
}
target = Path(sys.argv[2]) / "refused.csv"
for label, value in (("lf", "a\\nb"), ("cr", "a\\rb")):
    try:
        write_csv(target, c, [["MNO1", value, "1", "20261029"]])
    except WriterInvalidValue as exc:
        out[label] = f"{codes.WRITER_INVALID_VALUE} {exc.column}"
out["written"] = target.exists()
try:
    render(c, [["MNO1", "P", "1"]])
except ValueError as exc:
    out["count"] = str(exc)
print(json.dumps(out))`,
        FIXTURES,
        work,
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual({
        comma: '"a,b",P,1,20261029\n',
        quote: '"say ""x""",P,1,20261029\n',
        plain: "a b,P,1,20261029\n",
        lf: "WRITER_INVALID_VALUE polygon_id",
        cr: "WRITER_INVALID_VALUE polygon_id",
        written: false,
        count: "row 1 has 3 fields; contract rpt02_headerless has 4",
      });
    });
  },
);
