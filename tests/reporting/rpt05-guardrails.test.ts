import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  expectFlowRevisionTrace,
  expectRuntimeTasks,
  expectValidateDate,
  expectValidateOutput,
  type FlowTask,
  GENERATED_FILE,
  loadReportFlow,
  loadReportingContract,
} from "@/tests/helpers/reporting-flow-shape";
import {
  REPORTING_CONTRACTS_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt05-spec Tests, database-free: the pieces the live suites rely on — the
// contract (D3, MO13), the builder's skips, duplicate keys, sort and amounts
// (D1, D2, MO5–MO8, MO11), `receivables_balance`'s cut-off by document kind
// (D1) — and the flow's shape (D5, MO15–MO17: Kestra output only, no folder
// delivery). The live-database cases are rpt05-mno-outstanding.integration.test.ts;
// the Kestra cases are rpt05-mno-outstanding-flow.live.test.ts.

const ROOT = process.cwd();
const FLOW = join(
  ROOT,
  "workflow-management",
  "flows",
  "reporting",
  "report-mno-outstanding.yaml",
);
const read = (path: string) => readFileSync(path, "utf8");

const ready = reportingRuntimeReady();

describe.skipIf(!ready)("the mno_outstanding contract (§C.1, D3)", () => {
  it("loads: header false, the three §C.1 columns in order, date/text/amount, all required", () => {
    expect(loadReportingContract("mno_outstanding")).toEqual({
      file: "Reporting_dnb_settlement_mno_<outstanding_date>.csv",
      header: false,
      columns: [
        ["outstanding_date", "date", true],
        ["mno_public_key", "text", true],
        ["outstanding_amount_myr", "amount", true],
      ],
    });
  });

  it("names the CSP as its reader", () => {
    expect(read(join(REPORTING_CONTRACTS_DIR, "mno_outstanding.yaml"))).toMatch(
      /^# .*the CSP/m,
    );
  });
});

// A ledger of hand-made posted lines: BAN1/BAN2 → receivables accounts R1/R2.
const LEDGER = `from datetime import date
from decimal import Decimal
from runtime.reporting.common import receivables
from runtime.reporting.mno_outstanding import builder
from runtime.reporting.mno_outstanding.extract import PartyRole
def line(n, doc_type, amount, into, entry, posted=None, state="posted"):
    frm, to = ("X", into) if into.startswith("R") else (into[1:], "X")
    return receivables.PostedLine(f"L{n}", f"D{n}", doc_type, state, entry, posted, None, "",
                                  "charge", None, None, None, Decimal(amount), frm, to)
d = date
lines = (
    line(1, "INV", "100.00", "R1", d(2026, 9, 30), d(2026, 10, 27)),  # posted on D
    line(2, "INV", "20.00", "R1", d(2026, 9, 30), d(2026, 10, 28)),   # posted after D
    line(3, "INV", "5.00", "R1", d(2026, 9, 30), None),               # no posted_at
    line(4, "PAY", "30.00", "-R1", d(2026, 10, 27)),                  # entered on D
    line(5, "PAY", "7.00", "-R1", d(2026, 10, 28)),                   # entered after D
    line(6, "CRN", "300.00", "-R2", d(2026, 10, 1)),                  # BAN2 owed
    line(7, "DBN", "1.00", "R2", d(2026, 10, 1), state="draft"),      # never counts
    line(8, "DEP", "9.00", "-R1", d(2026, 10, 1)),                    # not payment side
)
snap = receivables.LedgerSnapshot(lines, {"BAN1": "R1", "BAN2": "R2"}, {})
`;

describe.skipIf(!ready)("builder and receivables_balance (D1, D2)", () => {
  it("receivables_balance: INV by posted_at day, PAY/CRN/DBN/ADJ by entry_date, counted states only, gross", () => {
    const run = runReportingPython([
      "-c",
      `${LEDGER}
print(receivables.receivables_balance(snap, ["BAN1"], d(2026, 10, 27)))
print(receivables.receivables_balance(snap, ["BAN1"], d(2026, 10, 28)))
print(receivables.receivables_balance(snap, ["BAN1", "BAN2"], d(2026, 10, 27)))`,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim().split(/\r?\n/)).toEqual([
      "70.00", // 100 − 30
      "83.00", // + 20 − 7
      "-230.00", // − 300 on BAN2
    ]);
  });

  it("one row per key, sorted by code point; two accounts summed; skipped in party_role_id order; negatives and 0.00 kept", () => {
    const run = runReportingPython([
      "-c",
      `${LEDGER}
import json
roles = [
    PartyRole("PR3", "mno-b", ("BAN2",)),
    PartyRole("PR1", "MNO-Z", ("BAN1", "BAN2")),
    PartyRole("PR9", None, ("BAN9",)),
    PartyRole("PR2", "MNO-A", ("BAN7",)),
    PartyRole("PR0", None, ("BAN8",)),
]
b = builder.build(roles, snap, d(2026, 10, 27))
print(json.dumps({"rows": b.rows, "skipped": [s.line for s in b.skipped], "dup": b.duplicate_keys}))`,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      rows: [
        ["20261027", "MNO-A", "0.00"],
        ["20261027", "MNO-Z", "-230.00"],
        ["20261027", "mno-b", "-300.00"],
      ],
      skipped: [
        "SKIPPED PR0 MNO_PUBLIC_KEY_MISSING",
        "SKIPPED PR9 MNO_PUBLIC_KEY_MISSING",
      ],
      dup: [],
    });
  });

  it("two party roles with one key: no rows, the key reported (never merged)", () => {
    const run = runReportingPython([
      "-c",
      `${LEDGER}
import json
roles = [PartyRole("PR1", "MNO-A", ("BAN1",)), PartyRole("PR2", "MNO-A", ("BAN2",)),
         PartyRole("PR3", "MNO-B", ("BAN1",))]
b = builder.build(roles, snap, d(2026, 10, 27))
print(json.dumps({"rows": b.rows, "dup": b.duplicate_keys}))`,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ rows: [], dup: ["MNO-A"] });
  });
});

describe("report-mno-outstanding — static shape (D5, MO15–MO17)", () => {
  const shape = loadReportFlow(FLOW);
  const { flow, task, command } = shape;

  it("id, namespace, description, one optional outstanding_date input, the report label; enabled, manual (no triggers)", () => {
    expect(flow.id).toBe("report-mno-outstanding");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toBe("MNO outstanding");
    expect(flow.inputs.map((i) => [i.id, i.type, i.required])).toEqual([
      ["outstanding_date", "STRING", false],
    ]);
    expect(flow.labels).toEqual({ report: "mno_outstanding" });
    expect(flow.disabled).toBeUndefined();
    expect(flow.triggers).toBeUndefined();
  });

  it("tasks run validate_date → generate → validate_output → publish → set_status; no deliver, no outbound_dir (MO15)", () => {
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
    expectValidateDate(task("validate_date"), "outstanding_date");
    expectValidateOutput(task("validate_output"), "mno_outstanding");
    expect((task("set_status").then as FlowTask[])[0]!.state).toBe("WARNING");
  });

  it("labels: flow_revision, outstanding_date (effective), skipped_mnos", () => {
    expectFlowRevisionTrace(task("trace"));
    expect(task("inputs_labels").labels).toEqual({
      outstanding_date: "{{ outputs.validate_date.outputs.effective_date }}",
    });
    expect(task("count_labels").labels).toEqual({
      skipped_mnos: "{{ outputs.generate.vars.skipped_mnos }}",
    });
  });

  it("generate and publish run the runtime on the Process runner with values as env vars only", () => {
    expectRuntimeTasks(shape, ["generate", "publish"]);
    expect(command("generate")).toContain(
      "python3 -m runtime.reporting.mno_outstanding",
    );
    expect(task("generate").env).toEqual({
      OUTSTANDING_DATE: "{{ outputs.validate_date.outputs.effective_date }}",
    });
  });

  it("the published file is the publish task's; no flow-level outputs (Inv 5)", () => {
    expect(task("publish").inputFiles).toEqual(GENERATED_FILE);
    expect(task("publish").outputFiles).toEqual([
      "Reporting_dnb_settlement_mno_*.csv",
    ]);
    expect(flow.outputs).toBeUndefined();
  });
});
