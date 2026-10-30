import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// Shared harness for the reporting suites (rpt01 onward, rptmgmt-code-standards
// §9): runs the Python runtime in `runtime/reporting/` as a subprocess, as the
// flows' tasks do, the way tests/helpers/rating-ran-harness.ts runs rating's.

export const REPORTING_WORKER_DIR = join(
  process.cwd(),
  "workflow-management",
  "worker",
  "workflow-engine",
);

// python3 is invoked by ABSOLUTE path, never resolved through PATH (a writable
// PATH entry could shadow it). REPORTING_PYTHON3 — or the rating suites'
// RATING_PYTHON3, so one local venv serves both — selects an interpreter;
// otherwise the fixed system locations CI installs into.
const PYTHON3_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3"];
const PYTHON3: string | undefined = (() => {
  const override = process.env.REPORTING_PYTHON3 ?? process.env.RATING_PYTHON3;
  if (override) return isAbsolute(override) ? override : undefined;
  return PYTHON3_CANDIDATES.find((p) => existsSync(p));
})();

export function reportingPython3(): string {
  if (!PYTHON3) throw new Error("no absolute python3 (set REPORTING_PYTHON3)");
  return PYTHON3;
}

// The worker image's runtime package imports polars at `import runtime`, so
// the gate imports exactly what a reporting entry point loads.
export function reportingRuntimeReady(): boolean {
  if (!PYTHON3) return false;
  try {
    execFileSync(
      PYTHON3,
      [
        "-c",
        "import runtime.reporting.common.db, runtime.reporting.common.trace",
      ],
      { cwd: REPORTING_WORKER_DIR, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

export interface PythonRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs python3 with the worker dir on PYTHONPATH (as the image's
// PYTHONPATH=/app), so `cwd` is free to be the task's working directory.
// `env` replaces the inherited environment except PATH/SYSTEMROOT, so a host
// SECRET_REPORTING_RUNTIME_PASSWORD or REPORTING_DB_* never leaks into a case.
export function runReportingPython(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): PythonRun {
  // NODE_ENV is carried only because ProcessEnv's typing requires it.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "",
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    PYTHONPATH: REPORTING_WORKER_DIR,
    ...options.env,
  };
  const result = spawnSync(reportingPython3(), args, {
    cwd: options.cwd ?? REPORTING_WORKER_DIR,
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export interface KestraLines {
  outputs: Record<string, unknown>;
  logs: { level: string; message: string }[];
}

// Parses Kestra's script-output protocol lines (`::{"outputs":…}::`,
// `::{"logs":[…]}::`) the way the engine does (runtime/reporting/common/trace.py).
export function parseKestraLines(stdout: string): KestraLines {
  const parsed: KestraLines = { outputs: {}, logs: [] };
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^::(\{.*\})::$/.exec(line.trim());
    if (!match) continue;
    const payload = JSON.parse(match[1]!) as {
      outputs?: Record<string, unknown>;
      logs?: { level: string; message: string }[];
    };
    Object.assign(parsed.outputs, payload.outputs ?? {});
    parsed.logs.push(...(payload.logs ?? []));
  }
  return parsed;
}
