import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseKestraLines,
  reportingRuntimeReady,
  runReportingPython,
} from "@/tests/helpers/reporting-harness";

// rpt01-spec Tests R01-T9 / R01-T10 — worker unit tests (no database). The
// runtime runs as a subprocess (tests/helpers/reporting-harness.ts); psycopg's
// connect is replaced in-process by a recording fake, so nothing here opens a
// connection.

const ready = reportingRuntimeReady();

const PASSWORD = "rpt01-unit-only-Pw-7f3c";
const DB_ENV = {
  SECRET_REPORTING_RUNTIME_PASSWORD: PASSWORD,
  REPORTING_DB_HOST: "reporting-db.invalid",
  REPORTING_DB_PORT: "6543",
  REPORTING_DB_NAME: "rpt01_unit",
  REPORTING_DB_USER: "reporting_runtime",
};

// Installs a fake psycopg.connect that records every statement, then runs
// BODY. FAIL_CONNECT=1 makes the fake raise an error carrying the full DSN.
const FAKE_CONNECT = `
import json, os, sys
import psycopg
from runtime.reporting.common import db

calls = {"dsn": None, "statements": [], "closed": False}

class FakeConn:
    def execute(self, query, params=None):
        calls["statements"].append(query)
        return self
    def close(self):
        calls["closed"] = True

def fake_connect(dsn, *args, **kwargs):
    calls["dsn"] = dsn
    if os.environ.get("FAIL_CONNECT") == "1":
        raise psycopg.OperationalError(f"connection failed for {dsn}")
    return FakeConn()

psycopg.connect = fake_connect
`;

describe.skipIf(!ready)(
  "R01-T9 — common/db.py read_snapshot() (worker unit test)",
  () => {
    it("refuses to connect without SECRET_REPORTING_RUNTIME_PASSWORD", () => {
      const run = runReportingPython([
        "-c",
        FAKE_CONNECT +
          `
try:
    with db.read_snapshot():
        pass
except RuntimeError as exc:
    print(json.dumps({"error": str(exc), "connect_called": calls["dsn"] is not None}))
`,
      ]);
      expect(run.status).toBe(0);
      const out = JSON.parse(run.stdout.trim()) as {
        error: string;
        connect_called: boolean;
      };
      expect(out.error).toMatch(/SECRET_REPORTING_RUNTIME_PASSWORD is not set/);
      expect(out.connect_called).toBe(false);
    });

    it("the first statement in a snapshot is SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY, and the connection closes on exit", () => {
      const run = runReportingPython(
        [
          "-c",
          FAKE_CONNECT +
            `
with db.read_snapshot() as conn:
    conn.execute("SELECT 1")
    closed_inside = calls["closed"]
print(json.dumps({**calls, "closed_inside": closed_inside}))
`,
        ],
        { env: DB_ENV },
      );
      expect(run.status, run.stderr).toBe(0);
      const out = JSON.parse(run.stdout.trim()) as {
        dsn: string;
        statements: string[];
        closed: boolean;
        closed_inside: boolean;
      };
      expect(out.statements).toEqual([
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        "SELECT 1",
      ]);
      expect(out.closed_inside).toBe(false);
      expect(out.closed).toBe(true);
      // The DSN is assembled from REPORTING_DB_* (same shape as RATING_DB_*).
      expect(out.dsn).toContain("host=reporting-db.invalid");
      expect(out.dsn).toContain("port=6543");
      expect(out.dsn).toContain("dbname=rpt01_unit");
      expect(out.dsn).toContain("user=reporting_runtime");
    });

    it("the DSN and password never appear in logs or exceptions when connect fails", () => {
      // Uncaught on purpose: the traceback is what would reach the Kestra log.
      const run = runReportingPython(
        [
          "-c",
          FAKE_CONNECT +
            `
with db.read_snapshot():
    pass
`,
        ],
        { env: { ...DB_ENV, FAIL_CONNECT: "1" } },
      );
      expect(run.status).not.toBe(0);
      const all = run.stdout + run.stderr;
      expect(all).toMatch(/could not connect as reporting_runtime/);
      expect(all).not.toContain(PASSWORD);
      expect(all).not.toContain("host=reporting-db.invalid");
      // No chained original exception ("During handling …") either.
      expect(all).not.toMatch(/During handling|direct cause/);
    });
  },
);

const FIXTURE = join(
  process.cwd(),
  "tests/fixtures/reporting/trace-fixture.txt",
);
// Pinned: the fixture is one line with no newline, so line-ending conversion
// on checkout cannot change its bytes.
const FIXTURE_SHA256 =
  "4bddecfd947799aca5c7e7728029c8d2d235cc412cebf7812c1b5f5012e5f681";

describe.skipIf(!ready)(
  "R01-T10 — common/trace.py DELIVERED line and status (worker unit test)",
  () => {
    it("the fixture's pinned SHA-256 is its real hash", () => {
      expect(
        createHash("sha256").update(readFileSync(FIXTURE)).digest("hex"),
      ).toBe(FIXTURE_SHA256);
    });

    it("delivered() logs one INFO `DELIVERED <filename> sha256=<hex> rev=<n>` line whose hash matches the fixture", () => {
      // Run where the fixture is: sha256() reads only a file directly in the
      // working directory, as a publish task's files are (rpt03).
      const run = runReportingPython(
        [
          "-c",
          `import sys
from runtime.reporting.common import trace
print("RETURNED " + trace.delivered(sys.argv[1], 7))`,
          FIXTURE,
        ],
        { cwd: dirname(FIXTURE) },
      );
      expect(run.status, run.stderr).toBe(0);
      const { logs } = parseKestraLines(run.stdout);
      expect(logs).toEqual([
        {
          level: "INFO",
          message: `DELIVERED trace-fixture.txt sha256=${FIXTURE_SHA256} rev=7`,
        },
      ]);
      expect(run.stdout).toContain(`RETURNED ${FIXTURE_SHA256}`);
    });

    it("set_status() emits the `status` output for SUCCESS and WARNING, and rejects anything else", () => {
      const run = runReportingPython([
        "-c",
        `from runtime.reporting.common import trace
trace.set_status("WARNING")
trace.set_status("SUCCESS")
try:
    trace.set_status("FAILED")
except ValueError:
    print("REJECTED")`,
      ]);
      expect(run.status, run.stderr).toBe(0);
      const statuses = run.stdout
        .split(/\r?\n/)
        .filter((l) => l.startsWith("::"))
        .map((l) => parseKestraLines(l).outputs.status);
      expect(statuses).toEqual(["WARNING", "SUCCESS"]);
      expect(run.stdout).toContain("REJECTED");
    });
  },
);
