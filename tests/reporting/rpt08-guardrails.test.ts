import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  expectFlowRevisionTrace,
  type FlowTask,
  loadReportFlow,
  loadReportingContract,
} from "@/tests/helpers/reporting-flow-shape";
import {
  REPORTING_CONTRACTS_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt08-spec Tests, database-free: the contract (D3, IC6), R08-T2 (the key
// names against the rating flow's feed profile), `apportion_discount`
// (R08-T6's arithmetic, R08-T7, R08-T8), the builder's skips and order (D2,
// D4, D8), the IC18 report check (R08-T9) and the flow's shape (D5, IC19–IC21:
// Kestra output only). The live-database cases are
// rpt08-invoice-csv.integration.test.ts; the Kestra cases are
// rpt08-invoice-csv-flow.live.test.ts.

const ROOT = process.cwd();
const FLOW = join(
  ROOT,
  "workflow-management",
  "flows",
  "reporting",
  "report-invoice-csv.yaml",
);
const RATING_FLOW = join(
  ROOT,
  "workflow-management",
  "flows",
  "rating-engine",
  "rating-engine-ran-usage.yaml",
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

function python(script: string): unknown {
  const run = runReportingPython(["-c", script]);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout);
}

describe.skipIf(!ready)("the invoice_csv contract (§D.1, D3)", () => {
  it("loads: header true, the IC6 header exactly, the D3 types, all required but Usage_Mbps", () => {
    expect(loadReportingContract("invoice_csv")).toEqual({
      file: "R<mno><invoice_date>.csv",
      header: true,
      columns: [
        ["MNO_ID", "text", true],
        ["Commercial Unit", "text", true],
        ["Polygon Public Key", "text", true],
        ["Usage Amount", "amount", true],
        ["Polygon Subscription Date", "date", true],
        ["Invoice reference Number", "text", true],
        ["Transaction Entry Date", "date", true],
        ["Invoice Amount", "amount", true],
        ["Product Type", "text", true],
        ["Usage_Mbps", "amount", false],
      ],
    });
  });

  it("names the MNOs (via the CSP later) as its readers", () => {
    expect(read(join(REPORTING_CONTRACTS_DIR, "invoice_csv.yaml"))).toMatch(
      /^# .*the MNOs \(via the CSP later/m,
    );
  });
});

describe.skipIf(!ready)("R08-T2 — key names", () => {
  it("polygon_lines' commercial_unit and polygon_id names equal the RAN usage feed profile's commercial_unit_column and polygon_column", () => {
    const flow = parse(read(RATING_FLOW)) as {
      variables: { feed_profile: string };
    };
    const profile = JSON.parse(flow.variables.feed_profile) as Record<
      string,
      unknown
    >;
    expect(
      python(`import json
from runtime.reporting.common import polygon_lines as p
print(json.dumps([p.COMMERCIAL_UNIT_KEY, p.POLYGON_KEY]))`),
    ).toEqual([profile.commercial_unit_column, profile.polygon_column]);
  });
});

// Hand-made polygon lines: `p(udr, polygon, amount, …)` on line L1 of bill B1.
const FIXTURE = `import json
from datetime import date
from decimal import Decimal as D
from runtime.reporting.common.polygon_lines import BillScope, CapacityLine, PolygonLine, apportion_discount
from runtime.reporting.invoice_csv import builder
from runtime.reporting.invoice_csv.extract import Extract, Invoice
def p(udr, polygon, amount="100.00", mbps="1.000000", line="L1", bill="B1", cu="CU-1", start="2025-03-01"):
    return PolygonLine(bill, udr, line, "OFF1", polygon, start, cu,
                       None if mbps is None else D(mbps), None if amount is None else D(amount))
def cap(discount, line="L1", bill="B1"):
    return CapacityLine(line, bill, "OFF1", D(discount), None)
def shares(discount, polygons):
    return {k: str(v) for k, v in apportion_discount(cap(discount), polygons).items()}
def invoice(inv, mno, bill, total="500.00"):
    return Invoice(inv, D(total), mno, BillScope("RUN", "BAN", 1, bill, date(2026, 9, 1)))
DAY = date(2026, 10, 5)
`;

describe.skipIf(!ready)("apportion_discount (rpt09 D1, rpt08 D8)", () => {
  it("R08-T6 — 100.00 over 500.00 / 300.00 / 200.00 is 50.00 / 30.00 / 20.00", () => {
    expect(
      python(`${FIXTURE}
print(json.dumps(shares("100.00", [p("u1", "A", "500.00"), p("u2", "B", "300.00"), p("u3", "C", "200.00")])))`),
    ).toEqual({ u1: "50.00", u2: "30.00", u3: "20.00" });
  });

  it("R08-T7 — a 0.00 discount gives 0.00 shares", () => {
    expect(
      python(`${FIXTURE}
print(json.dumps(shares("0.00", [p("u1", "A"), p("u2", "B")])))`),
    ).toEqual({ u1: "0.00", u2: "0.00" });
  });

  it("R08-T8 — 100.00 over three equal polygons is 33.33 / 33.33 / 33.34: half-up, the remainder on the last polygon by polygon id, whatever the input order", () => {
    expect(
      python(`${FIXTURE}
print(json.dumps(shares("100.00", [p("u9", "C"), p("u1", "A"), p("u5", "B")])))`),
    ).toEqual({ u1: "33.33", u5: "33.33", u9: "33.34" });
  });

  it("the shares always add up to the line's discount (half-up rounding up, and a zero-amount line)", () => {
    expect(
      python(`${FIXTURE}
a = shares("0.05", [p("u1", "A", "1.00"), p("u2", "B", "1.00"), p("u3", "C", "1.00")])
z = shares("10.00", [p("u1", "A", "0.00"), p("u2", "B", "0.00")])
print(json.dumps([a, z]))`),
    ).toEqual([
      { u1: "0.02", u2: "0.02", u3: "0.01" },
      { u1: "0.00", u2: "10.00" },
    ]);
  });
});

describe.skipIf(!ready)("builder (D2, D4, D8, IC12, IC15, IC16)", () => {
  it("one file per MNO in key order; rows by invoice, then polygon; each discount row right after its usage row; IC6 column order", () => {
    expect(
      python(`${FIXTURE}
data = Extract(
    (invoice("INV2", "MNO-B", "B2"), invoice("INV1", "MNO-A", "B1", "900.00"), invoice("INV3", "MNO-A", "B3")),
    (p("u2", "Z", "500.00", "5.000000"), p("u1", "Y", "400.00", "4.125000", start="2025-04-15"),
     p("u3", "X", "100.00", line="L2", bill="B2"), p("u4", "W", "100.00", line="L3", bill="B3")),
    {"L1": cap("90.00"), "L2": cap("0.00", "L2", "B2"), "L3": cap("0.00", "L3", "B3")},
    {"OFF1": "eMBB Wholesale 5G Network"})
b = builder.build(data, DAY)
print(json.dumps({"files": [[f.mno_public_key, f.rows] for f in b.files], "skipped": [s.line for s in b.skipped], "invoices": b.invoices}))`),
    ).toEqual({
      files: [
        [
          "MNO-A",
          [
            [
              "MNO-A",
              "CU-1",
              "Y",
              "400.00",
              "20250415",
              "INV1",
              "20261005",
              "900.00",
              "eMBB Wholesale 5G Network",
              "4.13",
            ],
            [
              "MNO-A",
              "CU-1",
              "Y",
              "-40.00",
              "20250415",
              "INV1",
              "20261005",
              "900.00",
              "eMBB Wholesale 5G Network",
              "",
            ],
            [
              "MNO-A",
              "CU-1",
              "Z",
              "500.00",
              "20250301",
              "INV1",
              "20261005",
              "900.00",
              "eMBB Wholesale 5G Network",
              "5.00",
            ],
            [
              "MNO-A",
              "CU-1",
              "Z",
              "-50.00",
              "20250301",
              "INV1",
              "20261005",
              "900.00",
              "eMBB Wholesale 5G Network",
              "",
            ],
            [
              "MNO-A",
              "CU-1",
              "W",
              "100.00",
              "20250301",
              "INV3",
              "20261005",
              "500.00",
              "eMBB Wholesale 5G Network",
              "1.00",
            ],
          ],
        ],
        [
          "MNO-B",
          [
            [
              "MNO-B",
              "CU-1",
              "X",
              "100.00",
              "20250301",
              "INV2",
              "20261005",
              "500.00",
              "eMBB Wholesale 5G Network",
              "1.00",
            ],
          ],
        ],
      ],
      skipped: [],
      invoices: 3,
    });
  });

  it("IC16 — an invoice with any polygon row missing a value is skipped whole, one SKIPPED line per invoice in invoice order; an MNO with every invoice skipped gets no file", () => {
    expect(
      python(`${FIXTURE}
def q(bill, udr, polygon="A", **kw):
    return p(udr, polygon, bill=bill, line=f"L{bill}", **kw)
polys = (
    q("B1", "u1"), q("B1", "u2", None),          # POLYGON_ID_MISSING
    q("B2", "u3", start=None),                   # malformed udr_resource
    q("B3", "u4", start="2025-02-30"),           # not a calendar day
    q("B4", "u5", amount=None),                  # USAGE_AMOUNT_MISSING
    q("B5", "u6", mbps=None),                    # USAGE_MBPS_MISSING
    q("B6", "u7", cu=None),                      # COMMERCIAL_UNIT_MISSING
    q("B8", "u8"),                               # its invoice has no key
)
lines = {x.line_id: cap("0.00", x.line_id, x.customer_bill_id) for x in polys}
invs = tuple(invoice(f"INV{n}", "MNO-A", f"B{n}") for n in range(1, 8)) + (invoice("INV8", None, "B8"), invoice("INV9", "MNO-B", "B9"))
b = builder.build(Extract(invs, polys, lines, {}), DAY)
print(json.dumps({"files": [f.mno_public_key for f in b.files], "skipped": [s.line for s in b.skipped], "invoices": b.invoices}))`),
    ).toEqual({
      files: [],
      skipped: [
        "SKIPPED INV1 POLYGON_ID_MISSING",
        "SKIPPED INV2 POLYGON_START_DATE_MISSING",
        "SKIPPED INV3 POLYGON_START_DATE_MISSING",
        "SKIPPED INV4 USAGE_AMOUNT_MISSING",
        "SKIPPED INV5 USAGE_MBPS_MISSING",
        "SKIPPED INV6 COMMERCIAL_UNIT_MISSING",
        "SKIPPED INV7 NO_POLYGON_LINES",
        "SKIPPED INV8 MNO_PUBLIC_KEY_MISSING",
        "SKIPPED INV9 NO_POLYGON_LINES",
      ],
      invoices: 0,
    });
  });
});

describe.skipIf(!ready)("R08-T9 — the IC18 report check", () => {
  const CHECK = `${FIXTURE}
U = ["MNO-A", "CU-1", "A", "100.00", "20250301", "INV1", "20261005", "900.00", "eMBB", "1.00"]
def row(**changes):
    r = list(U)
    for k, v in changes.items():
        r[int(k[1:])] = v
    return r
def check(rows):
    return [[v.line, v.column, v.reason] for v in builder.check(rows)]
`;

  it("a clean file has no violation", () => {
    expect(
      python(`${CHECK}
print(json.dumps(check([row(), row(c3="-10.00", c9=""), row(c2="B")])))`),
    ).toEqual([]);
  });

  it("a positive amount with a blank Usage_Mbps, a discount row with no usage row before it, or one after another polygon's row fails DISCOUNT_ROW_INVALID", () => {
    expect(
      python(`${CHECK}
print(json.dumps([
    check([row(), row(c9="")]),                                  # positive amount, blank Mbps
    check([row(c3="-10.00", c9="")]),                            # no usage row before it
    check([row(), row(c3="-10.00", c9=""), row(c3="-1.00", c9="")]),  # after a discount row
    check([row(), row(c2="B", c3="-10.00", c9="")]),             # another polygon's usage row
    check([row(), row(c5="INV2", c3="-10.00", c9="")]),          # another invoice's usage row
]))`),
    ).toEqual([
      [[3, "Usage_Mbps", "DISCOUNT_ROW_INVALID"]],
      [[2, "Usage_Mbps", "DISCOUNT_ROW_INVALID"]],
      [[4, "Usage_Mbps", "DISCOUNT_ROW_INVALID"]],
      [[3, "Usage_Mbps", "DISCOUNT_ROW_INVALID"]],
      [[3, "Usage_Mbps", "DISCOUNT_ROW_INVALID"]],
    ]);
  });

  it("every row of one invoice carries the same Invoice Amount (INVOICE_AMOUNT_NOT_CONSTANT on each row that differs)", () => {
    expect(
      python(`${CHECK}
print(json.dumps(check([row(), row(c2="B", c7="901.00"), row(c5="INV2", c7="5.00"), row(c2="C")])))`),
    ).toEqual([[3, "Invoice Amount", "INVOICE_AMOUNT_NOT_CONSTANT"]]);
  });
});

describe.skipIf(!ready)("file names (IC5)", () => {
  it("R<mno><invoice_date>.csv; a key that isn't a plain file name fails the run", () => {
    expect(
      python(`import json
from pathlib import Path
from runtime.reporting.common.contract import load_contract
from runtime.reporting.invoice_csv.__main__ import file_name
c = load_contract(Path("${join(REPORTING_CONTRACTS_DIR, "invoice_csv.yaml").replaceAll("\\", "/")}"))
out = [file_name(c, "MNO1", "20261005")]
for key in ("../x", "a/b", "a\\\\b"):
    try:
        file_name(c, key, "20261005")
        out.append("written")
    except ValueError:
        out.append("refused")
print(json.dumps(out))`),
    ).toEqual(["RMNO120261005.csv", "refused", "refused", "refused"]);
  });
});

describe("report-invoice-csv — static shape (D5, IC19–IC21)", () => {
  const { flow, task, command } = loadReportFlow(FLOW);
  const inner = (id: string) => (task(id).tasks as FlowTask[])[0]!;

  it("id, namespace, description, one optional invoice_date input, the report label; enabled, manual (no triggers)", () => {
    expect(flow.id).toBe("report-invoice-csv");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toBe("Invoice CSV");
    expect(flow.inputs.map((i) => [i.id, i.type, i.required])).toEqual([
      ["invoice_date", "STRING", false],
    ]);
    expect(flow.labels).toEqual({ report: "invoice_csv" });
    expect(flow.disabled).toBeUndefined();
    expect(flow.triggers).toBeUndefined();
  });

  it("tasks run validate_date → generate → validate_output → publish → set_status; no deliver, no outbound_dir (IC19)", () => {
    expect(flow.tasks.map((t) => t.id)).toEqual([
      "trace",
      "validate_date",
      "inputs_labels",
      "generate",
      "count_labels",
      "validate_output",
      "publish",
      "set_status",
    ]);
    expect(flow.variables).toBeUndefined();
    expect(task("validate_date")).toMatchObject({
      type: "io.kestra.plugin.core.flow.Subflow",
      flowId: "report-validate-date",
      wait: true,
      transmitFailed: true,
      inputs: {
        name: "invoice_date",
        value: "{{ inputs.invoice_date ?? '' }}",
        rule: "not_future",
        default: "yesterday",
      },
    });
    expect((task("set_status").then as FlowTask[])[0]!.state).toBe("WARNING");
  });

  it("labels: flow_revision, invoice_date (effective), skipped_invoices, files_written", () => {
    expectFlowRevisionTrace(task("trace"));
    expect(task("inputs_labels").labels).toEqual({
      invoice_date: "{{ outputs.validate_date.outputs.effective_date }}",
    });
    expect(task("count_labels").labels).toEqual({
      skipped_invoices: "{{ outputs.generate.vars.skipped_invoices }}",
      files_written: "{{ outputs.generate.vars.files_written }}",
    });
  });

  it("validate_output is a ForEach over the generated files, each checked by report-validate-output with invoice_csv", () => {
    expect(task("validate_output")).toMatchObject({
      type: "io.kestra.plugin.core.flow.ForEach",
      values: "{{ outputs.generate.vars.files }}",
    });
    expect(inner("validate_output")).toMatchObject({
      type: "io.kestra.plugin.core.flow.Subflow",
      flowId: "report-validate-output",
      wait: true,
      transmitFailed: true,
      inputs: {
        file: "{{ outputs.generate.outputFiles[taskrun.value] }}",
        contract: "invoice_csv",
        name: "{{ taskrun.value }}",
      },
    });
  });

  it("generate and each publish run the runtime on the Process runner with values as env vars only; the published files are publish's", () => {
    const publish = inner("publish");
    for (const t of [task("generate"), publish]) {
      expect(t.taskRunner).toEqual({
        type: "io.kestra.plugin.core.runner.Process",
      });
      expect((t.commands as string[]).join(" ")).not.toMatch(/\{\{/);
    }
    expect(command("generate")).toContain(
      "python3 -m runtime.reporting.invoice_csv",
    );
    expect(task("generate").env).toEqual({
      INVOICE_DATE: "{{ outputs.validate_date.outputs.effective_date }}",
    });
    expect(task("generate").outputFiles).toEqual(["R*.csv"]);
    expect(task("publish")).toMatchObject({
      type: "io.kestra.plugin.core.flow.ForEach",
      values: "{{ outputs.generate.vars.files }}",
    });
    expect((publish.commands as string[]).join(" ")).toContain(
      "python3 -m runtime.reporting.common.trace delivered",
    );
    expect(publish.inputFiles).toEqual({
      "{{ taskrun.value }}":
        "{{ outputs.generate.outputFiles[taskrun.value] }}",
    });
    expect(publish.outputFiles).toEqual(["R*.csv"]);
    expect(flow.outputs).toBeUndefined();
  });
});
