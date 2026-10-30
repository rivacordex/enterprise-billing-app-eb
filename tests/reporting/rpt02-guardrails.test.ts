import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  REPORTING_WORKER_DIR,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt02-spec T-R02-11 (guardrail 2, the register), T-R02-12 (safe YAML only),
// and the static half of T-R02-10 (namespace-file deploy) and T-R02-13 (hash
// lock), plus the shape of the three shared subflows (D4, D6). The live runs
// are tests/reporting/rpt02-subflows.live.test.ts.

const ROOT = process.cwd();
const REPORTING_RUNTIME = join(REPORTING_WORKER_DIR, "runtime", "reporting");
const FLOWS = join(ROOT, "workflow-management", "flows", "reporting");

const read = (path: string) => readFileSync(path, "utf8");

function pythonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory())
      return entry === "__pycache__" ? [] : pythonFiles(path);
    return entry.endsWith(".py") ? [path] : [];
  });
}

// Every upper-case code token in backticks in rptmgmt-code-standards.md §6.
function registerFromDoc(): Set<string> {
  const doc = read(
    join(ROOT, "context/reporting-management/rptmgmt-code-standards.md"),
  );
  const section = doc.slice(doc.indexOf("## 6."), doc.indexOf("## 7."));
  const codes = new Set<string>();
  for (const [, span] of section.matchAll(/`([^`]+)`/g)) {
    for (const [token] of span!.matchAll(
      /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g,
    )) {
      if (token.length > 1) codes.add(token);
    }
  }
  return codes;
}

const ready = reportingRuntimeReady();

describe.skipIf(!ready)(
  "T-R02-11 — the register (guardrail 2)",
  { timeout: 60_000 },
  () => {
    it("codes.py and rptmgmt-code-standards.md §6 list the same codes; every constant equals its name", () => {
      const run = runReportingPython([
        "-c",
        `import json
from runtime.reporting.common import codes
consts = {k: v for k, v in vars(codes).items() if k.isupper() and isinstance(v, str)}
print(json.dumps({"register": sorted(codes.REGISTER), "mismatched": [k for k, v in consts.items() if k != v]}))`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      const { register, mismatched } = JSON.parse(run.stdout) as {
        register: string[];
        mismatched: string[];
      };
      expect(mismatched).toEqual([]);
      expect(register).toEqual([...registerFromDoc()].sort());
    });

    it("no runtime module spells a code as a literal, and no log call starts with an unregistered literal code", () => {
      // Static, on the AST: (a) outside codes.py, no string constant (docstrings
      // excepted) contains a registered code; (b) no string constant inside a
      // trace.info/error call starts with an UPPER_SNAKE code-like word, so a new
      // code can't be logged without being registered first.
      const run = runReportingPython([
        "-c",
        `import ast, json, pathlib, re, sys
from runtime.reporting.common import codes
token = re.compile(r"\\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\\b")
code_like = re.compile(r"^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\\b")
problems = []
for path in sorted(pathlib.Path(sys.argv[1]).rglob("*.py")):
    if path.name == "codes.py" and path.parent.name == "common":
        continue
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) and node.body:
            first = node.body[0]
            if isinstance(first, ast.Expr) and isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                docstrings.add(id(first.value))
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            for tok in token.findall(node.value):
                if tok in codes.REGISTER:
                    problems.append(f"{path.name}:{node.lineno} literal code {tok}")
        if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr in ("info", "error", "warn", "warning")
                and isinstance(node.func.value, ast.Name) and node.func.value.id == "trace"):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Constant) and isinstance(sub.value, str) and code_like.match(sub.value):
                    problems.append(f"{path.name}:{sub.lineno} unregistered code in a log call: {sub.value!r}")
print(json.dumps(problems))`,
        REPORTING_RUNTIME,
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual([]);
    });

    it("INVALID_<NAME> is built only through codes.invalid(), for registered input names", () => {
      const run = runReportingPython([
        "-c",
        `from runtime.reporting.common import codes
print(codes.invalid("report_date"))
try:
    codes.invalid("anything_else")
except ValueError:
    print("REFUSED")`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim().split(/\r?\n/)).toEqual([
        "INVALID_REPORT_DATE",
        "REFUSED",
      ]);
    });
  },
);

describe("T-R02-12 — safe YAML only", () => {
  it("nothing under runtime/reporting/ uses another YAML loader", () => {
    const files = pythonFiles(REPORTING_RUNTIME);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) =>
      /yaml\.load\(|yaml\.full_load\(|yaml\.unsafe_load\(|Loader=/.test(
        read(f),
      ),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
    expect(read(join(REPORTING_RUNTIME, "common", "contract.py"))).toContain(
      "yaml.safe_load(",
    );
  });
});

describe("T-R02-13 — hash lock (static half; the image build is the other)", () => {
  it("PyYAML is pinned exactly in requirements.in and hash-locked in requirements.txt", () => {
    const worker = REPORTING_WORKER_DIR;
    expect(read(join(worker, "requirements.in"))).toMatch(
      /^PyYAML==\d+\.\d+\.\d+$/m,
    );
    const lock = read(join(worker, "requirements.txt"));
    const entry =
      /^pyyaml==(\S+) \\\r?\n((?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\r?\n)+)/m.exec(
        lock,
      );
    expect(
      entry,
      "pyyaml with --hash lines in requirements.txt",
    ).not.toBeNull();
    expect(read(join(worker, "requirements.in"))).toContain(
      `PyYAML==${entry![1]}`,
    );
    expect(read(join(worker, "Dockerfile"))).toContain(
      "--require-hashes -r /tmp/requirements.txt",
    );
  });
});

interface Task {
  id: string;
  type: string;
  [key: string]: unknown;
}
interface Flow {
  id: string;
  namespace: string;
  description: string;
  inputs: { id: string; type: string; required?: boolean; values?: string[] }[];
  tasks: Task[];
  outputs: { id: string; type: string; value: string }[];
}
const flow = (name: string) => parse(read(join(FLOWS, `${name}.yaml`))) as Flow;
const PROCESS = { type: "io.kestra.plugin.core.runner.Process" };

function commandsTask(task: Task, subcommand: string): string {
  expect(task.type).toBe("io.kestra.plugin.scripts.python.Commands");
  expect(task.taskRunner).toEqual(PROCESS);
  const command = (task.commands as string[]).join(" ");
  expect(command).toContain(
    `python3 -m runtime.reporting.validate ${subcommand}`,
  );
  // Inputs reach the shell only as env vars.
  expect(command).not.toMatch(/\{\{/);
  return command;
}

describe("shared subflows — static shape (D4, D6)", () => {
  it("report-validate-date: inputs name/value/rule/default, one Commands task, output effective_date", () => {
    const f = flow("report-validate-date");
    expect([f.id, f.namespace]).toEqual(["report-validate-date", "reporting"]);
    expect(f.inputs.map((i) => i.id)).toEqual([
      "name",
      "value",
      "rule",
      "default",
    ]);
    expect(f.inputs.find((i) => i.id === "rule")?.values).toEqual([
      "not_future",
      "before_today",
    ]);
    expect(f.inputs.find((i) => i.id === "default")?.values).toEqual([
      "today",
      "yesterday",
    ]);
    // The default is resolved in the runtime, never by Kestra input defaults.
    expect(f.inputs.every((i) => !("defaults" in i))).toBe(true);
    expect(f.tasks).toHaveLength(1);
    commandsTask(f.tasks[0]!, "date");
    expect(f.outputs).toEqual([
      {
        id: "effective_date",
        type: "STRING",
        value: "{{ outputs.check.vars.effective_date }}",
      },
    ]);
  });

  it("report-validate-period: period check → report-validate-date (not_future, today) → as_of check", () => {
    const f = flow("report-validate-period");
    expect(f.inputs.map((i) => i.id)).toEqual(["billing_period", "as_of_date"]);
    expect(f.tasks.map((t) => t.id)).toEqual([
      "check_period",
      "as_of_date",
      "check_as_of",
    ]);
    commandsTask(f.tasks[0]!, "period");
    expect(f.tasks[1]).toMatchObject({
      type: "io.kestra.plugin.core.flow.Subflow",
      namespace: "reporting",
      flowId: "report-validate-date",
      wait: true,
      transmitFailed: true,
      inputs: { name: "as_of_date", rule: "not_future", default: "today" },
    });
    expect(commandsTask(f.tasks[2]!, "period")).toContain(
      '--as-of-date="$AS_OF_DATE"',
    );
    expect((f.tasks[2]!.env as Record<string, string>).AS_OF_DATE).toBe(
      "{{ outputs.as_of_date.outputs.effective_date }}",
    );
    expect(f.outputs.map((o) => o.id)).toEqual([
      "period_start",
      "period_end",
      "effective_as_of_date",
    ]);
  });

  it("report-validate-output: FILE + contract inputs (+ the optional name, rpt03), contracts/** namespace files, output rows", () => {
    const f = flow("report-validate-output");
    expect(f.inputs).toEqual([
      { id: "file", type: "FILE" },
      { id: "contract", type: "STRING" },
      { id: "name", type: "STRING", required: false },
    ]);
    const check = f.tasks[0]!;
    expect(commandsTask(check, "output")).toContain(
      '--contract="contracts/$CONTRACT.yaml"',
    );
    expect(check.namespaceFiles).toEqual({
      enabled: true,
      include: ["contracts/**"],
    });
    expect(f.outputs).toEqual([
      { id: "rows", type: "INT", value: "{{ outputs.check.vars.rows }}" },
    ]);
  });

  // rpt02 shipped none (D9); each report unit adds its own (rpt03: Part A's
  // two). Nothing else lives there.
  it("contracts/ holds its README and the built reports' contracts only", () => {
    expect(readdirSync(join(FLOWS, "contracts")).sort()).toEqual([
      "README.md",
      "settlement_invoice.yaml",
      "settlement_invoice_payment.yaml",
    ]);
  });
});

describe("T-R02-10 — namespace-file deploy (static half)", () => {
  it("dev flow-deploy uploads flows/reporting/contracts to namespace reporting at contracts/, after the flows", () => {
    const compose = read(
      join(ROOT, "workflow-management/dev/docker-compose.dev.yml"),
    );
    const upload =
      "/app/kestra namespace files update reporting /flows/reporting/contracts contracts/ --no-delete";
    expect(compose).toContain(upload);
    expect(compose.indexOf(upload)).toBeGreaterThan(
      compose.indexOf("flow namespace update"),
    );
  });

  it("CI deploy_workflow_flows uploads the same directory after the reporting flow deploy", () => {
    const ci = read(join(ROOT, "infra/azure-pipelines.yml"));
    const at = ci.indexOf(
      "namespace files update reporting /contracts contracts/",
    );
    expect(at).toBeGreaterThan(
      ci.indexOf("deploy_fn reporting                      reporting"),
    );
    expect(ci).toContain(
      "workflow-management/flows/reporting/contracts:/contracts",
    );
  });
});
