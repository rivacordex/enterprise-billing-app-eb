import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  parseKestraLines,
  REPORTING_CONTRACTS_DIR,
  REPORTING_WORKER_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt03-spec R03-T3 (guardrail 5, one sign rule) and the database-free halves
// of rpt03: the two contracts (§A.1), the flow's shape (D8), the file
// timestamp (D6), the per-invoice check (T14, SR19) and the publish task's
// DELIVERED lines. The live-database cases are
// rpt03-settlement.integration.test.ts; the Kestra cases are
// rpt03-settlement-flow.live.test.ts.

const ROOT = process.cwd();
const REPORTING_RUNTIME = join(REPORTING_WORKER_DIR, "runtime", "reporting");
const FLOW = join(
  ROOT,
  "workflow-management/flows/reporting/report-settlement-invoice.yaml",
);

const ready = reportingRuntimeReady();

// Guardrail 5 on the AST, over every runtime/reporting module except
// common/receivables.py (rptmgmt-code-standards §2.3, §9.5):
//   (a) nothing reads a transfer's accounts — no from_account_id /
//       to_account_id attribute, name or string, and no pgledger object;
//   (b) nothing flips a sign — no unary minus on a non-literal, no -1
//       (an index such as [-1] excepted), no subtraction from zero
//       (`0 - x`, `Decimal("0") - x`) and no `copy_negate()` / `__neg__` /
//       `operator.neg`;
//   (c) nothing maps a doc_type / line_kind to a number — no dict literal
//       keyed by one with numeric values.
// Docstrings are exempt (they describe the rule).
const SIGN_RULE_CHECK = `import ast, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
KINDS = {"PAY", "DEP", "CRN", "DBN", "ADJ", "INV", "capture", "allocation", "charge", "release", "refund"}
ACCOUNT_WORDS = ("from_account_id", "to_account_id", "pgledger_")
NEGATORS = ("copy_negate", "__neg__")
def is_zero(node):
    # 0, 0.0, or a one-argument call such as Decimal("0") / Decimal(0).
    if isinstance(node, ast.Call) and len(node.args) == 1 and not node.keywords:
        node = node.args[0]
    return isinstance(node, ast.Constant) and str(node.value).strip() in ("0", "0.0", "0.00")
problems = []
for path in sorted(root.rglob("*.py")):
    rel = path.relative_to(root).as_posix()
    if rel == "common/receivables.py":
        continue
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings, indexes = set(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript):
            indexes.update(id(n) for n in ast.walk(node.slice))
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    for node in ast.walk(tree):
        where = f"{rel}:{getattr(node, 'lineno', '?')}"
        if isinstance(node, ast.Attribute) and node.attr in ("from_account_id", "to_account_id"):
            problems.append(f"{where} reads .{node.attr}")
        if isinstance(node, ast.Name) and node.id in ("from_account_id", "to_account_id"):
            problems.append(f"{where} names {node.id}")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            if any(word in node.value for word in ACCOUNT_WORDS):
                problems.append(f"{where} string mentions a transfer's accounts")
            if node.value.strip() in ("-1", "-1.0"):
                problems.append(f"{where} a -1 literal")
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            if not isinstance(node.operand, ast.Constant):
                problems.append(f"{where} flips a sign: {ast.unparse(node)}")
            elif node.operand.value == 1 and id(node) not in indexes:
                problems.append(f"{where} a -1 literal")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Sub) and is_zero(node.left):
            problems.append(f"{where} flips a sign: {ast.unparse(node)}")
        if isinstance(node, ast.Attribute) and (node.attr in NEGATORS or (
                node.attr == "neg" and isinstance(node.value, ast.Name) and node.value.id == "operator")):
            problems.append(f"{where} flips a sign: {ast.unparse(node)}")
        if isinstance(node, ast.Dict):
            keys = [k.value for k in node.keys if isinstance(k, ast.Constant) and isinstance(k.value, str)]
            numeric = any(isinstance(v, (ast.Constant, ast.UnaryOp)) and not isinstance(getattr(v, "value", None), str) for v in node.values)
            if numeric and any(k.split(":")[0] in KINDS or k in KINDS for k in keys):
                problems.append(f"{where} maps a document or line kind to a number")
print(json.dumps(problems))`;

function signRuleProblems(root: string): string[] {
  const run = runReportingPython(["-c", SIGN_RULE_CHECK, root]);
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout) as string[];
}

describe.skipIf(!ready)(
  "R03-T3 — one sign rule (guardrail 5)",
  { timeout: 60_000 },
  () => {
    it("no module outside common/receivables.py reads from_account_id / to_account_id or maps a doc_type / line_kind to a sign", () => {
      expect(signRuleProblems(REPORTING_RUNTIME)).toEqual([]);
    });

    it("the check bites: a sign table, an account read and each form of sign flip in a scratch module are reported", () => {
      const scratch = mkdtempSync(join(tmpdir(), "rpt03-guard-"));
      writeFileSync(
        join(scratch, "bad.py"),
        [
          'SIGNS = {"PAY": 1, "DBN": -1}',
          "def f(line):",
          "    return line.from_account_id",
          "def g(amount):",
          "    return -amount",
          "def h(amount):",
          "    return 0 - amount",
          "def i(amount):",
          '    return Decimal("0") - amount',
          "def j(amount):",
          "    return amount.copy_negate()",
          "",
        ].join("\n"),
      );
      const problems = signRuleProblems(scratch);
      expect(
        problems.some((p) => p.includes("maps a document or line kind")),
      ).toBe(true);
      expect(problems.some((p) => p.includes("reads .from_account_id"))).toBe(
        true,
      );
      const flips = problems.filter((p) => p.includes("flips a sign"));
      for (const line of ["bad.py:5", "bad.py:7", "bad.py:9", "bad.py:11"])
        expect(
          flips.some((p) => p.startsWith(`${line} `)),
          line,
        ).toBe(true);
    });

    it("common/receivables.py is the module that reads the transfer view", () => {
      const source = readFileSync(
        join(REPORTING_RUNTIME, "common", "receivables.py"),
        "utf8",
      );
      expect(source).toContain("billing.pgledger_transfers_view");
      expect(source).toContain("t.from_account_id");
      expect(source).toContain("t.to_account_id");
    });
  },
);

// §A.1 — the exact headers, types and required flags.
const CONTRACTS: Record<string, [string, string, boolean][]> = {
  settlement_invoice: [
    ["mno_id", "text", true],
    ["invoice_entry_date", "date", true],
    ["invoice_id", "text", true],
    ["invoice_amount", "amount", true],
    ["invoice_due_date", "date", true],
    ["invoice_open_amount", "amount", true],
  ],
  settlement_invoice_payment: [
    ["mno_id", "text", true],
    ["payment_transaction_no", "text", false],
    ["type_of_payment", "text", true],
    ["payment_amount", "amount", true],
    ["invoice_id", "text", false],
    ["payment_reference", "text", false],
    ["cheque_realization_date", "date", false],
    ["comment", "text", false],
  ],
};

describe.skipIf(!ready)("the two contracts (§A.1, D6)", () => {
  for (const [id, columns] of Object.entries(CONTRACTS)) {
    it(`${id}.yaml loads and has exactly the §A.1 columns, types and required flags, header: true`, () => {
      const run = runReportingPython([
        "-c",
        `import json, sys
from pathlib import Path
from runtime.reporting.common.contract import load_contract
c = load_contract(Path(sys.argv[1]))
print(json.dumps({"file": c.file, "header": c.header, "columns": [[x.name, x.type, x.required] for x in c.columns]}))`,
        join(REPORTING_CONTRACTS_DIR, `${id}.yaml`),
      ]);
      expect(run.status, run.stderr).toBe(0);
      const contract = JSON.parse(run.stdout) as {
        file: string;
        header: boolean;
        columns: [string, string, boolean][];
      };
      expect(contract.header).toBe(true);
      expect(contract.columns).toEqual(columns);
      expect(contract.file).toBe(
        id === "settlement_invoice"
          ? "Reporting_dnb_settlement_invoice_<ts>.csv"
          : "Reporting_dnb_settlement_invoice_payment_<ts>.csv",
      );
    });
  }

  it("each contract names its readers in a comment", () => {
    for (const id of Object.keys(CONTRACTS))
      expect(
        readFileSync(join(REPORTING_CONTRACTS_DIR, `${id}.yaml`), "utf8"),
      ).toMatch(/^# .*Finance \/ billing ops/m);
  });
});

describe.skipIf(!ready)("the file timestamp (SR22, D6)", () => {
  it("is the execution start in Asia/Kuala_Lumpur, yyyyMMddHHmmss, whatever the fraction or offset", () => {
    const run = runReportingPython([
      "-c",
      `import json
from runtime.reporting.settlement_invoice.__main__ import file_stamp
cases = ["2026-10-26T01:30:15Z", "2026-10-25T16:00:00.123456789Z", "2026-10-26T09:30:15+08:00", "2026-10-26T01:30:15.5+00:00"]
out = [file_stamp(c) for c in cases]
try:
    file_stamp("2026-10-26 01:30:15")
except ValueError:
    out.append("REFUSED")
print(json.dumps(out))`,
    ]);
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual([
      "20261026093015",
      "20261026000000",
      "20261026093015",
      "20261026093015",
      "REFUSED",
    ]);
  });
});

describe.skipIf(!ready)(
  "T14 — the per-invoice check (SR19), database-free",
  () => {
    it("passes consistent rows and names the file line of a corrupted open amount", () => {
      const run = runReportingPython([
        "-c",
        `import json
from runtime.reporting.settlement_invoice.invoice_report import check
invoices = [
    {"invoice_id": "INV1", "invoice_amount": "800.00", "invoice_open_amount": "500.00"},
    {"invoice_id": "INV2", "invoice_amount": "400.00", "invoice_open_amount": "400.00"},
]
payments = [
    {"invoice_id": "INV1", "payment_amount": "300.00"},
    {"invoice_id": "INV2", "payment_amount": "400.00"},
    {"invoice_id": "INV2", "payment_amount": "-400.00"},
    {"invoice_id": "", "payment_amount": "70.00"},
]
clean = check(invoices, payments)
invoices[1]["invoice_open_amount"] = "399.99"
print(json.dumps([clean, check(invoices, payments)]))`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      // Account-level rows (blank invoice_id) never count; line 3 = INV2.
      expect(JSON.parse(run.stdout)).toEqual([[], [3]]);
    });
  },
);

describe.skipIf(!ready)("publish — the DELIVERED lines (RF7, D8)", () => {
  it("trace delivered logs one DELIVERED line per file, in argument order", () => {
    const dir = mkdtempSync(join(tmpdir(), "rpt03-publish-"));
    writeFileSync(join(dir, "Reporting_dnb_settlement_invoice_1.csv"), "a\n");
    writeFileSync(
      join(dir, "Reporting_dnb_settlement_invoice_payment_1.csv"),
      "b\n",
    );
    const run = runReportingPython(
      [
        "-m",
        "runtime.reporting.common.trace",
        "delivered",
        "--flow-revision=4",
        "Reporting_dnb_settlement_invoice_1.csv",
        "Reporting_dnb_settlement_invoice_payment_1.csv",
      ],
      { cwd: dir },
    );
    expect(run.status, run.stderr).toBe(0);
    expect(parseKestraLines(run.stdout).logs).toEqual([
      {
        level: "INFO",
        message:
          "DELIVERED Reporting_dnb_settlement_invoice_1.csv sha256=87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7 rev=4",
      },
      {
        level: "INFO",
        message:
          "DELIVERED Reporting_dnb_settlement_invoice_payment_1.csv sha256=0263829989b6fd954f72baaf2fc64bc2e2f01d692d4de72986ea808f6e99813f rev=4",
      },
    ]);
    expect(readdirSync(dir).sort()).toHaveLength(2);
  });
});

interface Task {
  id: string;
  type: string;
  [key: string]: unknown;
}

describe("report-settlement-invoice — static shape (D8)", () => {
  const flow = parse(readFileSync(FLOW, "utf8")) as {
    id: string;
    namespace: string;
    description: string;
    labels: Record<string, string>;
    inputs: { id: string; type: string; required?: boolean }[];
    tasks: Task[];
    outputs?: unknown;
  };
  const task = (id: string) => flow.tasks.find((t) => t.id === id)!;

  it("id, namespace, description, the two inputs and the report label", () => {
    expect(flow.id).toBe("report-settlement-invoice");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toMatch(/Settlement/);
    expect(flow.inputs.map((i) => [i.id, i.type])).toEqual([
      ["billing_period", "STRING"],
      ["as_of_date", "STRING"],
    ]);
    expect(flow.labels).toEqual({ report: "settlement_invoice" });
  });

  it("tasks run validate_period → generate → validate_output (once per file) → publish → set_status", () => {
    expect(flow.tasks.map((t) => t.id)).toEqual([
      "trace",
      "validate_period",
      "inputs_labels",
      "generate",
      "count_labels",
      "validate_output_invoice",
      "validate_output_payment",
      "publish",
      "set_status",
    ]);
    expect(task("validate_period")).toMatchObject({
      type: "io.kestra.plugin.core.flow.Subflow",
      flowId: "report-validate-period",
      wait: true,
      transmitFailed: true,
    });
    expect(
      [task("validate_output_invoice"), task("validate_output_payment")].map(
        (t) => [t.flowId, t.inputs],
      ),
    ).toEqual([
      [
        "report-validate-output",
        {
          file: "{{ outputs.generate.outputFiles[outputs.generate.vars.invoice_file] }}",
          contract: "settlement_invoice",
          name: "{{ outputs.generate.vars.invoice_file }}",
        },
      ],
      [
        "report-validate-output",
        {
          file: "{{ outputs.generate.outputFiles[outputs.generate.vars.payment_file] }}",
          contract: "settlement_invoice_payment",
          name: "{{ outputs.generate.vars.payment_file }}",
        },
      ],
    ]);
    expect((task("set_status").then as Task[])[0]!.state).toBe("WARNING");
  });

  it("labels: flow_revision, billing_period, as_of_date (effective), skipped_invoices", () => {
    expect(task("trace").labels).toEqual({
      flow_revision: "{{ flow.revision }}",
    });
    expect(task("inputs_labels").labels).toEqual({
      billing_period: "{{ inputs.billing_period }}",
      as_of_date: "{{ outputs.validate_period.outputs.effective_as_of_date }}",
    });
    expect(task("count_labels").labels).toEqual({
      skipped_invoices: "{{ outputs.generate.vars.skipped_invoices }}",
    });
  });

  it("generate and publish run the runtime with inputs as env vars only, on the Process runner", () => {
    for (const id of ["generate", "publish"]) {
      const t = task(id);
      expect(t.taskRunner).toEqual({
        type: "io.kestra.plugin.core.runner.Process",
      });
      expect((t.commands as string[]).join(" ")).not.toMatch(/\{\{/);
    }
    expect((task("generate").commands as string[]).join(" ")).toContain(
      "python3 -m runtime.reporting.settlement_invoice",
    );
    expect(task("generate").namespaceFiles).toEqual({
      enabled: true,
      include: ["contracts/**"],
    });
    expect((task("publish").commands as string[]).join(" ")).toContain(
      "python3 -m runtime.reporting.common.trace delivered",
    );
  });

  it("the published files are the publish task's, which keeps the generated names; no flow-level outputs (Inv 5)", () => {
    const publish = task("publish");
    expect(publish.outputFiles).toEqual([
      "Reporting_dnb_settlement_invoice_*.csv",
    ]);
    expect(publish.inputFiles).toEqual({
      "{{ outputs.generate.vars.invoice_file }}":
        "{{ outputs.generate.outputFiles[outputs.generate.vars.invoice_file] }}",
      "{{ outputs.generate.vars.payment_file }}":
        "{{ outputs.generate.outputFiles[outputs.generate.vars.payment_file] }}",
    });
    // The Exit task that ends a run WARNING skips rendering flow outputs
    // (v1.3.35), so they would exist on SUCCESS only.
    expect(flow.outputs).toBeUndefined();
  });
});
