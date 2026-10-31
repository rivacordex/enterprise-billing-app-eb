import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect } from "vitest";
import { parse } from "yaml";

import {
  REPORTING_CONTRACTS_DIR,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// Shared static checks for the report flows' guardrail suites (rpt03 onward):
// a contract as the runtime loads it, and the parts of a report flow's shape
// every report repeats — the trace label, the validate_date / validate_output
// subflows, and the runtime tasks on the Process runner.

export interface LoadedContract {
  file: string;
  header: boolean;
  columns: [string, string, boolean][];
}

// contracts/<id>.yaml through runtime/reporting/common/contract.py.
export function loadReportingContract(id: string): LoadedContract {
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
  return JSON.parse(run.stdout) as LoadedContract;
}

export interface FlowTask {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface ReportFlow {
  id: string;
  namespace: string;
  description: string;
  disabled?: boolean;
  labels: Record<string, string>;
  inputs: { id: string; type: string; required?: boolean }[];
  variables?: Record<string, string>;
  tasks: FlowTask[];
  outputs?: unknown;
  triggers?: unknown;
}

export function loadReportFlow(path: string) {
  const flow = parse(readFileSync(path, "utf8")) as ReportFlow;
  const task = (id: string) => flow.tasks.find((t) => t.id === id)!;
  const command = (id: string) => (task(id).commands as string[]).join(" ");
  return { flow, task, command };
}

// The generated file, by its name, as a task's inputFiles.
export const GENERATED_FILE = {
  "{{ outputs.generate.vars.file }}":
    "{{ outputs.generate.outputFiles[outputs.generate.vars.file] }}",
};

export function expectFlowRevisionTrace(trace: FlowTask): void {
  expect(trace.labels).toEqual({ flow_revision: "{{ flow.revision }}" });
}

// A report's date input checked by report-validate-date: before today,
// defaulting to yesterday.
export function expectValidateDate(task: FlowTask, input: string): void {
  expect(task).toMatchObject({
    type: "io.kestra.plugin.core.flow.Subflow",
    flowId: "report-validate-date",
    wait: true,
    transmitFailed: true,
    inputs: {
      name: input,
      value: `{{ inputs.${input} ?? '' }}`,
      rule: "before_today",
      default: "yesterday",
    },
  });
}

// The single generated file checked by report-validate-output.
export function expectValidateOutput(task: FlowTask, contract: string): void {
  expect(task).toMatchObject({
    flowId: "report-validate-output",
    wait: true,
    transmitFailed: true,
    inputs: {
      file: "{{ outputs.generate.outputFiles[outputs.generate.vars.file] }}",
      contract,
      name: "{{ outputs.generate.vars.file }}",
    },
  });
}

// Each of `ids` runs on the Process runner with no template in its commands
// (values reach the runtime as env vars only); publish runs the trace's
// `delivered`.
export function expectRuntimeTasks(
  flow: ReturnType<typeof loadReportFlow>,
  ids: string[],
): void {
  for (const id of ids) {
    expect(flow.task(id).taskRunner).toEqual({
      type: "io.kestra.plugin.core.runner.Process",
    });
    expect(flow.command(id)).not.toMatch(/\{\{/);
  }
  expect(flow.command("publish")).toContain(
    "python3 -m runtime.reporting.common.trace delivered",
  );
}
