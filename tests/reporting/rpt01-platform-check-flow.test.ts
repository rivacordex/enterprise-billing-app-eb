import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// rpt01-spec D8 — static shape of `report-platform-check` (DB-free). The live
// runs (R01-T11–T14) prove the behaviour on a local Kestra; this pins the
// wiring they depend on, verified on the pinned v1.3.35:
//   - flow-level `labels:` are stored literally, so `flow_revision` must come
//     from a runtime `execution.Labels` task (RF7);
//   - WARNING is the runtime's `status` output applied by If → Exit, never an
//     exit code (code-standards §2.6).

interface Task {
  id: string;
  type: string;
  [key: string]: unknown;
}

const flow = parse(
  readFileSync(
    join(
      process.cwd(),
      "workflow-management/flows/reporting/report-platform-check.yaml",
    ),
    "utf8",
  ),
) as {
  id: string;
  namespace: string;
  description: string;
  labels: Record<string, string>;
  inputs: { id: string; type: string; defaults: unknown }[];
  variables: Record<string, string>;
  tasks: Task[];
};

describe("report-platform-check flow (rpt01 D8)", () => {
  it("is report-platform-check in namespace reporting, manual (no triggers)", () => {
    expect(flow.id).toBe("report-platform-check");
    expect(flow.namespace).toBe("reporting");
    expect(flow.description).toBe("Reporting platform check");
    expect(flow).not.toHaveProperty("triggers");
  });

  it("has the one simulate_warning BOOLEAN input, default false", () => {
    expect(flow.inputs).toEqual([
      { id: "simulate_warning", type: "BOOLEAN", defaults: false },
    ]);
  });

  it("labels report=platform_check statically and flow_revision through a Labels task", () => {
    expect(flow.labels).toEqual({ report: "platform_check" });
    const trace = flow.tasks.find(
      (t) => t.type === "io.kestra.plugin.core.execution.Labels",
    );
    expect(trace?.labels).toEqual({ flow_revision: "{{ flow.revision }}" });
  });

  it("runs the runtime on the Process runner and publishes its file", () => {
    const check = flow.tasks.find((t) => t.id === "check")!;
    expect(check.type).toBe("io.kestra.plugin.scripts.python.Commands");
    expect(check.taskRunner).toEqual({
      type: "io.kestra.plugin.core.runner.Process",
    });
    const command = (check.commands as string[]).join(" ");
    expect(command).toContain("python3 -m runtime.reporting.platform_check");
    expect(command).toContain('--outbound-dir "{{ vars.outbound_dir }}"');
    expect(command).toContain('--flow-revision "{{ flow.revision }}"');
    expect(check.outputFiles).toEqual(["platform_check_*.txt"]);
    expect(flow.variables.outbound_dir).toBe("/data/outbound/_platform-check");
  });

  it("ends with set_status: If status == WARNING → Exit state WARNING", () => {
    const last = flow.tasks.at(-1)!;
    expect(last.id).toBe("set_status");
    expect(last.type).toBe("io.kestra.plugin.core.flow.If");
    expect(last.condition).toBe("{{ outputs.check.vars.status == 'WARNING' }}");
    expect(last.then).toEqual([
      {
        id: "warning",
        type: "io.kestra.plugin.core.execution.Exit",
        state: "WARNING",
      },
    ]);
  });
});
