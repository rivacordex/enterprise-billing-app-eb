import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

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

// The gate imports every third-party package a reporting entry point loads
// (psycopg through db, PyYAML through contract), so an interpreter missing one
// — e.g. a reused RATING_PYTHON3 venv without PyYAML — skips the suites
// instead of failing them.
export function reportingRuntimeReady(): boolean {
  if (!PYTHON3) return false;
  try {
    execFileSync(
      PYTHON3,
      [
        "-c",
        "import runtime.reporting.common.db, runtime.reporting.common.trace, runtime.reporting.common.contract",
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
function pythonEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // NODE_ENV is carried only because ProcessEnv's typing requires it.
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env.PATH ?? "",
    ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
    PYTHONPATH: REPORTING_WORKER_DIR,
    ...extra,
  };
}

export function runReportingPython(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): PythonRun {
  const result = spawnSync(reportingPython3(), args, {
    cwd: options.cwd ?? REPORTING_WORKER_DIR,
    encoding: "utf8",
    env: pythonEnv(options.env),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// The same, without waiting: for a case that acts while the runtime runs
// (rpt03 T20's concurrent post).
export function spawnReportingPython(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): ChildProcessWithoutNullStreams {
  return spawn(reportingPython3(), args, {
    cwd: options.cwd ?? REPORTING_WORKER_DIR,
    env: pythonEnv(options.env),
  });
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

// ---------------------------------------------------------------------------
// rpt03 — live-database helpers for the report suites (rpt03-spec D9): reset
// and provision a throwaway database, connect the runtime as
// `reporting_runtime`, run a report, and read its files.

export const REPORTING_CONTRACTS_DIR = join(
  process.cwd(),
  "workflow-management",
  "flows",
  "reporting",
  "contracts",
);

// Cluster-level: the suites that use it run only against a disposable
// cluster (tests/integration-global-setup.ts).
export const REPORTING_ROLE_TEST_PASSWORD = "rpt03-test-only-pw";

const ROLE_FILES = [
  "bootstrap-db-roles.sql",
  "rating-db-roles.sql",
  "billrun-db-roles.sql",
  "reporting-db-roles.sql",
];

const APP_SCHEMAS = [
  "inventory",
  "ordering",
  "billing",
  "customer",
  "product",
  "rating",
  "core",
  "drizzle",
  "partman",
];

export async function dropAppSchemas(sql: postgresjs.Sql): Promise<void> {
  for (const s of APP_SCHEMAS) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  }
}

// Drops every app schema, migrates, and runs the role files in their
// provisioning order (roles -> rating -> billrun -> reporting), then sets
// reporting_runtime's password to the test value — what
// tests/db/reporting-db-roles.integration.test.ts does, for report suites.
// The migration runs on its own connection: drizzle's driver replaces the
// client's date parsers, which the caller's `sql` keeps.
export async function resetReportingDatabase(
  databaseUrl: string,
  sql: postgresjs.Sql,
): Promise<void> {
  await dropAppSchemas(sql);
  const migrateSql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(migrateSql), {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });
  } finally {
    await migrateSql.end();
  }
  for (const file of ROLE_FILES) {
    const text = readFileSync(
      join(process.cwd(), "db/bootstrap", file),
      "utf8",
    );
    for (const statement of text
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)) {
      await sql.unsafe(statement);
    }
  }
  await sql.unsafe(
    `ALTER ROLE reporting_runtime WITH PASSWORD '${REPORTING_ROLE_TEST_PASSWORD}'`,
  );
}

// The REPORTING_DB_* environment common/db.py reads, pointed at the
// database DATABASE_URL names, as reporting_runtime.
export function reportingDbEnv(databaseUrl: string): Record<string, string> {
  const url = new URL(databaseUrl);
  return {
    SECRET_REPORTING_RUNTIME_PASSWORD: REPORTING_ROLE_TEST_PASSWORD,
    REPORTING_DB_HOST: url.hostname,
    REPORTING_DB_PORT: url.port || "5432",
    REPORTING_DB_NAME: decodeURIComponent(url.pathname.slice(1)),
    REPORTING_DB_USER: "reporting_runtime",
    REPORTING_DB_SSLMODE: "disable",
  };
}

export interface ReportRun extends PythonRun, KestraLines {
  outDir: string;
  // Every file the run left in outDir, by name.
  files: Record<string, string>;
}

// Runs `python3 -m runtime.reporting.<module> …args` in a fresh temporary
// working directory (the task's working directory), with the contracts the
// flow mounts as namespace files. `inputFiles` (relative path → source) are
// copied into it first, as the flow's namespace files are; put them in a
// subfolder so `files` lists only what the run wrote.
export function runReport(
  module: string,
  args: string[],
  env: Record<string, string>,
  inputFiles: Record<string, string> = {},
): ReportRun {
  const outDir = mkdtempSync(join(tmpdir(), `rpt-${module}-`));
  for (const [path, source] of Object.entries(inputFiles)) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    copyFileSync(source, join(outDir, path));
  }
  const run = runReportingPython(
    [
      "-m",
      `runtime.reporting.${module}`,
      ...args,
      `--out-dir=${outDir}`,
      `--contracts-dir=${REPORTING_CONTRACTS_DIR}`,
    ],
    { cwd: outDir, env },
  );
  const files: Record<string, string> = {};
  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.isFile())
      files[entry.name] = readFileSync(join(outDir, entry.name), "utf8");
  }
  return { ...run, ...parseKestraLines(run.stdout), outDir, files };
}

// RFC 4180 parse of a reporting file (RF4: LF only, no BOM, quoted only when
// needed). Throws on CR, a BOM or a missing final LF — the writer never
// produces them.
export function parseReportCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) throw new Error("reporting CSV has a BOM");
  if (text.includes("\r")) throw new Error("reporting CSV contains CR");
  if (text !== "" && !text.endsWith("\n"))
    throw new Error("reporting CSV does not end with LF");
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      record.push(cell);
      cell = "";
    } else if (ch === "\n") {
      record.push(cell);
      records.push(record);
      record = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  return records;
}
