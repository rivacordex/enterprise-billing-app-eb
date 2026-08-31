import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import {
  EVENT_CATALOG_SEED,
  seedEventCatalog,
} from "@/db/seeds/rating-event-catalog.data";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rm06-spec §Verification checklist + code-standards §10 test #16 (owned by
// rm06: "the format round-trips an error message containing quotes, newlines
// and delimiters; sweeping one file twice leaves the row count unchanged; an
// alarming code, a non-alarming code and an uncatalogued code resolve to a
// severity, NULL and INDETERMINATE respectively").
//
// Scope: this suite covers the LOGGING CONTRACT + SWEEP (D8, D9, D10, D11 —
// checklist items 6-15) plus static structural checks on the flow template
// (D1, D3-D6 — checklist items 1-5, the parts that don't need a live Kestra
// engine). Checklist items 1 ("a file moves through all three stub sections
// on a manual trigger") and 16 (git-based deploy actually reaching an engine)
// need a running engine / pipeline run — rm04 D9's local stack or a real
// deploy — and are NOT automated here; see ratemgmt-progress-tracker.md.
//
// The DB-gated describe below shells out to the REAL `runtime.log_sweep`
// Python module (rating-engine/worker/runtime/log_sweep.py) via
// `python3 -m runtime.log_sweep`, exactly as log-sweep.yaml's task invokes
// it — this is a black-box test of the actual sweep, not a reimplementation
// of its SQL in TypeScript. Requires `python3` on PATH with the worker's
// requirements installed (psycopg at minimum); skipped loudly, like the
// DATABASE_URL gate, when that isn't available.
const databaseUrl = process.env.DATABASE_URL;
const workerDir = join(process.cwd(), "rating-engine", "worker");

function pythonRuntimeReady(): boolean {
  try {
    execFileSync("python3", ["-c", "import runtime"], {
      cwd: workerDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm06-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runSqlFile(client: postgresjs.Sql, path: string): Promise<void> {
  for (const statement of statements(path)) {
    await client.unsafe(statement);
  }
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. D1/D3/D4/D5/D6/D7.
// ---------------------------------------------------------------------
describe("flow template structure (rm06-spec D1, D3-D7 — static)", () => {
  const flowsDir = join(process.cwd(), "rating-engine", "flows");
  const template = readFileSync(
    join(flowsDir, "ran-usage-rating.yaml"),
    "utf8",
  );
  const sweepFlow = readFileSync(join(flowsDir, "log-sweep.yaml"), "utf8");

  it("2. prp/rp/rl are all real runtime modules in order; the only remaining stub is the # STUB: rm10 supersede-hook", () => {
    const prpIdx = template.indexOf("id: prp");
    const rpIdx = template.indexOf("id: rp");
    const rlIdx = template.indexOf("id: rl");
    expect(prpIdx).toBeGreaterThan(-1);
    expect(rpIdx).toBeGreaterThan(prpIdx);
    expect(rlIdx).toBeGreaterThan(rpIdx);

    // rm07/rm08/rm09 replaced the prp/rp/rl STUBs with the real processors, each
    // invoked as a runtime module (module form, not a python3 -c placeholder).
    // The only remaining stub is the # STUB: rm10 supersede-hook inside rl's
    // transaction (updated here by rm09, per the cross-unit-test precedent, when
    // rl became real).
    expect(template).toMatch(/python3 -m runtime\.prp/);
    expect(template).toMatch(/python3 -m runtime\.rp/);
    expect(template).toMatch(/python3 -m runtime\.rl/);
    expect(template).not.toMatch(/# STUB: rm07 owns PRP/);
    expect(template).not.toMatch(/# STUB: rm08 owns RP/);
    expect(template).not.toMatch(/# STUB: rm09 owns RL/);
    // rm10 (supersession) is the last remaining stub, named in rl's doc comment.
    expect(template).toMatch(/# STUB: rm10/);

    // No TODO anywhere (code-standards §1.5/§3.5 — a stub is a documented
    // section, never a TODO).
    expect(template).not.toMatch(/TODO/);

    // All three components are real module invocations — no python3 -c
    // placeholder bodies remain in the flow.
    const commandBodies = [
      ...template.matchAll(/python3 -c "\n([\s\S]*?)\n\s*"/g),
    ].map((m) => m[1]);
    expect(commandBodies).toHaveLength(0);
  });

  it("3. sections hand off by file URI (Kestra internal storage), never a record payload", () => {
    expect(template).toMatch(/outputs\.prp\.uri/);
    expect(template).toMatch(/outputs\.rp\.uri/);
  });

  it("4. concurrency: limit: 1 is declared on the flow", () => {
    expect(template).toMatch(/concurrency:\s*\n\s*limit:\s*1/);
  });

  it("3 (D3, replaced by rm07). the trigger is now the landing/ file trigger, not rm06's manual Webhook placeholder", () => {
    const triggersBlock = template.slice(
      template.indexOf("triggers:"),
      template.indexOf("tasks:"),
    );
    // rm07 Implementation §1 replaced rm06's manual Webhook placeholder with the
    // landing/ file trigger; the Webhook (and its secret) are gone.
    expect(triggersBlock).toMatch(/id: landing-file/);
    expect(triggersBlock).toMatch(/fs\.local\.Trigger/);
    expect(triggersBlock).not.toMatch(
      /io\.kestra\.plugin\.core\.trigger\.Webhook/,
    );
  });

  it("5. both errors and finally write a terminal-outcome log line via the emitter", () => {
    const errorsBlock = template.slice(template.indexOf("errors:"));
    const finallyBlock = template.slice(template.indexOf("finally:"));
    expect(errorsBlock).toMatch(/emit_terminal_log/);
    expect(errorsBlock).toMatch(/--outcome FAILED/);
    expect(finallyBlock).toMatch(/emit_terminal_log/);
    expect(finallyBlock).toMatch(/--outcome FINALIZED/);
  });

  it("18. no secret literal or console.* in either flow file", () => {
    for (const doc of [template, sweepFlow]) {
      expect(doc).not.toMatch(/console\./);
      // A real password/connection-string literal would not be a Jinja
      // secret() call or a KV secretRef-style reference.
      expect(doc).not.toMatch(/password:\s*['"][^{]/i);
    }
  });

  it("log-sweep.yaml is scheduled independently, with its own error+finally handlers (D9)", () => {
    expect(sweepFlow).toMatch(/io\.kestra\.plugin\.core\.trigger\.Schedule/);
    expect(sweepFlow).toMatch(/cron:/);
    expect(sweepFlow).toMatch(/log_sweep/);
    expect(sweepFlow).toMatch(/errors:/);
    expect(sweepFlow).toMatch(/finally:/);
  });
});

// ---------------------------------------------------------------------
// Logging contract + sweep — D8, D9, D10, D11. Live DB + the real Python
// sweep, run as a subprocess exactly as Kestra would invoke it.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "logging contract + log sweep (rm06-spec D8-D11, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await seedEventCatalog(db);

      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);

      const url = new URL(databaseUrl as string);
      dbParams = {
        host: url.hostname,
        port: url.port || "5432",
        name: url.pathname.replace(/^\//, ""),
      };
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropAll(sql);
      await sql.end();
    });

    // Fresh logs/ + swept/ + malformed/ per test so idempotency/torn-line
    // assertions can't see another test's leftover files.
    let logsDir: string;
    let sweptDir: string;
    let malformedDir: string;
    beforeAll(() => {
      const root = mkdtempSync(join(tmpdir(), "rm06-logs-"));
      logsDir = join(root, "logs");
      sweptDir = join(logsDir, "swept");
      malformedDir = join(logsDir, "malformed");
      mkdirSync(logsDir, { recursive: true });
      mkdirSync(sweptDir, { recursive: true });
      mkdirSync(malformedDir, { recursive: true });
    });

    function writeLogFile(name: string, content: string): string {
      const path = join(logsDir, name);
      writeFileSync(path, content, "utf8");
      return path;
    }

    // Builds one JSON-Lines record matching the contract (§7.9) exactly —
    // partition_period is deliberately never a key here, mirroring
    // logemit.py's FIELDS tuple.
    function jsonLine(fields: {
      log_datetime: string;
      component: string;
      log_level: string;
      event_code: string;
      source_file: string;
      batch_id: string;
      workflow_execution_id: string;
      perceived_severity?: string | null;
      specific_problem?: string | null;
      managed_object?: string | null;
      alarm_key?: string | null;
      additional_info?: Record<string, unknown> | null;
    }): string {
      return JSON.stringify({
        perceived_severity: null,
        specific_problem: null,
        managed_object: null,
        alarm_key: null,
        additional_info: null,
        ...fields,
      });
    }

    // Invokes the REAL sweep exactly as log-sweep.yaml's task does.
    function runSweep(workflowExecutionId: string): string {
      return execFileSync(
        "python3",
        [
          "-m",
          "runtime.log_sweep",
          "--dir",
          logsDir,
          "--swept",
          sweptDir,
          "--malformed",
          malformedDir,
          "--workflow-execution-id",
          workflowExecutionId,
        ],
        {
          cwd: workerDir,
          env: {
            ...process.env,
            RATING_DB_HOST: dbParams.host,
            RATING_DB_PORT: dbParams.port,
            RATING_DB_NAME: dbParams.name,
            RATING_DB_USER: "rating_runtime",
            SECRET_RATING_RUNTIME_PASSWORD: ROLE_PW,
          },
          encoding: "utf8",
        },
      );
    }

    type LogRow = {
      component: string;
      log_level: string;
      perceived_severity: string | null;
      event_code: string;
      specific_problem: string | null;
      source_file: string;
      batch_id: string;
      workflow_execution_id: string;
      partition_period: string;
      log_datetime: string;
      insert_datetime: string;
    };

    const rowsFor = (batchId: string) =>
      sql<LogRow[]>`
        SELECT component, log_level, perceived_severity, event_code,
               specific_problem, source_file, batch_id, workflow_execution_id,
               partition_period, log_datetime, insert_datetime
        FROM rating.process_log
        WHERE batch_id = ${batchId}
        ORDER BY log_datetime
      `;

    // The sweep's own summary row (D10, malformed-line quarantine) carries
    // batch_id 'UNKNOWN' — a malformed line has no readable batch of its
    // own — so it is found by workflow_execution_id, not batch_id.
    const rowsForExecution = (workflowExecutionId: string) =>
      sql<LogRow[]>`
        SELECT component, log_level, perceived_severity, event_code,
               specific_problem, source_file, batch_id, workflow_execution_id,
               partition_period, log_datetime, insert_datetime
        FROM rating.process_log
        WHERE workflow_execution_id = ${workflowExecutionId}
        ORDER BY log_datetime
      `;

    it("6+9. a specific_problem with quotes, newlines and a pipe round-trips intact (JSON Lines, not delimited)", async () => {
      const batchId = "UDRBAT-RM06-ROUNDTRIP";
      const nasty = 'a "quoted" value\nwith a newline and a | pipe';
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "ERROR",
        event_code: "DB_WRITE_FAILURE", // catalogued, CRITICAL
        source_file: "usage-sample.csv",
        batch_id: batchId,
        workflow_execution_id: "exec-roundtrip",
        specific_problem: nasty,
      });
      writeLogFile("RL-exec-roundtrip.jsonl", line + "\n");

      runSweep("exec-roundtrip");

      const rows = await rowsFor(batchId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.specific_problem).toBe(nasty);
      expect(rows[0]!.perceived_severity).toBe("CRITICAL");
      expect(rows[0]!.log_level).toBe("ERROR");
    });

    it("8+9. an alarming code, a catalogued non-alarming code and an uncatalogued code resolve to a severity, NULL and INDETERMINATE respectively — never via COALESCE", async () => {
      const batchId = "UDRBAT-RM06-THREEOUTCOME";
      const execId = "exec-threeoutcome";
      const lines = [
        jsonLine({
          log_datetime: "2026-08-14T10:00:00Z",
          component: "RL",
          log_level: "ERROR",
          event_code: "DB_WRITE_FAILURE",
          source_file: "s.csv",
          batch_id: batchId,
          workflow_execution_id: execId,
        }),
        jsonLine({
          log_datetime: "2026-08-14T10:00:01Z",
          component: "RL",
          log_level: "INFO",
          event_code: "BATCH_COMPLETE", // catalogued, default_severity NULL
          source_file: "s.csv",
          batch_id: batchId,
          workflow_execution_id: execId,
        }),
        jsonLine({
          log_datetime: "2026-08-14T10:00:02Z",
          component: "RL",
          log_level: "WARN",
          event_code: "TOTALLY_UNCATALOGUED_RM06", // no catalog row
          source_file: "s.csv",
          batch_id: batchId,
          workflow_execution_id: execId,
        }),
      ];
      writeLogFile(`RL-${execId}.jsonl`, lines.join("\n") + "\n");

      runSweep(execId);

      const rows = await rowsFor(batchId);
      const byCode = Object.fromEntries(rows.map((r) => [r.event_code, r]));
      expect(byCode.DB_WRITE_FAILURE?.perceived_severity).toBe("CRITICAL");
      expect(byCode.BATCH_COMPLETE?.perceived_severity).toBeNull();
      expect(byCode.TOTALLY_UNCATALOGUED_RM06?.perceived_severity).toBe(
        "INDETERMINATE",
      );
      // log_level is the emitter's, passed through unchanged (§7.2b) —
      // never derived from severity.
      expect(byCode.DB_WRITE_FAILURE?.log_level).toBe("ERROR");
      expect(byCode.BATCH_COMPLETE?.log_level).toBe("INFO");
      expect(byCode.TOTALLY_UNCATALOGUED_RM06?.log_level).toBe("WARN");
    });

    it("10. partition_period is computed by the sweep as rating.period_of(log_datetime) and is absent from the line contract", async () => {
      const batchId = "UDRBAT-RM06-PARTITION";
      const execId = "exec-partition";
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      expect(JSON.parse(line)).not.toHaveProperty("partition_period");
      writeLogFile(`RL-${execId}.jsonl`, line + "\n");

      runSweep(execId);

      const [expected] = await sql<{ period: string }[]>`
        SELECT rating.period_of('2026-08-14T10:00:00Z'::timestamptz)::text AS period
      `;
      const rows = await rowsFor(batchId);
      expect(rows[0]!.partition_period).toBe(expected!.period);
    });

    it("13. sweeping the same file twice leaves the row count unchanged (rename-on-completion idempotency)", async () => {
      const batchId = "UDRBAT-RM06-IDEMPOTENT";
      const execId = "exec-idempotent";
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      writeLogFile(`RL-${execId}.jsonl`, line + "\n");

      runSweep(execId);
      const afterFirst = await rowsFor(batchId);
      expect(afterFirst).toHaveLength(1);

      // Second run: nothing left in logsDir for this file (it was moved to
      // swept/), so a re-run must not duplicate it.
      runSweep(execId);
      const afterSecond = await rowsFor(batchId);
      expect(afterSecond).toHaveLength(1);
    });

    it("14. a malformed line is quarantined and does not fail the sweep; a torn last line is deferred to the next run", async () => {
      const batchId = "UDRBAT-RM06-MALFORMED";
      const execId = "exec-malformed";
      const goodLine = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      const fileName = `RL-${execId}.jsonl`;
      writeLogFile(fileName, `${goodLine}\nnot valid json at all\n`);

      expect(() => runSweep(execId)).not.toThrow();

      const good = (await rowsFor(batchId)).find(
        (r) => r.event_code === "BATCH_COMPLETE",
      );
      expect(good).toBeDefined();
      const summary = (await rowsForExecution(execId)).find(
        (r) => r.event_code === "MALFORMED_LOG_LINE",
      );
      expect(summary?.log_level).toBe("WARN");
      expect(summary?.perceived_severity).toBe("INDETERMINATE");

      const quarantined = readFileSync(join(malformedDir, fileName), "utf8");
      expect(quarantined).toMatch(/not valid json at all/);
    });

    it("torn last line: zero rows load and the file is left in place; a later complete run loads it", async () => {
      const batchId = "UDRBAT-RM06-TORN";
      const execId = "exec-torn";
      const fileName = `RL-${execId}.jsonl`;
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      // No trailing newline — simulates a file still open for writing.
      writeLogFile(fileName, line);

      runSweep(execId);
      let rows = await rowsFor(batchId);
      expect(rows).toHaveLength(0);
      // File must still be sitting in logsDir, unmoved.
      expect(() => readFileSync(join(logsDir, fileName), "utf8")).not.toThrow();

      // The writer "finishes" — the line is now complete.
      writeFileSync(join(logsDir, fileName), line + "\n", "utf8");
      runSweep(execId);
      rows = await rowsFor(batchId);
      expect(rows).toHaveLength(1);
    });

    it("12. a deliberately crashed flow's log still sweeps — the sweep is independent of the flow that wrote it", async () => {
      // Simulates emit_terminal_log.py's own FAILED output — the mechanism a
      // killed ran-usage-rating execution relies on (D7/D9): the flow itself
      // never inserts anything; only this independent sweep does.
      const batchId = "UDRBAT-RM06-CRASHED";
      const execId = "exec-crashed";
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "ERROR",
        event_code: "STUB_EXECUTION_FAILED",
        source_file: "UNKNOWN",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      writeLogFile(`RL-${execId}.jsonl`, line + "\n");

      runSweep(execId);

      const rows = await rowsFor(batchId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.perceived_severity).toBe("INDETERMINATE");
    });

    it("15. the log_datetime -> insert_datetime lag is a queryable health metric", async () => {
      const batchId = "UDRBAT-RM06-LAG";
      const execId = "exec-lag";
      const line = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      writeLogFile(`RL-${execId}.jsonl`, line + "\n");

      runSweep(execId);

      const rows = await rowsFor(batchId);
      expect(rows).toHaveLength(1);
      const lag =
        new Date(rows[0]!.insert_datetime).getTime() -
        new Date(rows[0]!.log_datetime).getTime();
      expect(lag).toBeGreaterThanOrEqual(0);
    });

    it("naive (offset-less) log_datetime is treated as malformed and quarantined, never inserted with an ambiguous instant", async () => {
      const batchId = "UDRBAT-RM06-NAIVEDT";
      const execId = "exec-naivedt";
      const good = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      // No 'Z', no offset — Postgres would localize it in the session tz.
      const naive = jsonLine({
        log_datetime: "2026-08-14T10:00:00",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      const fileName = `RL-${execId}.jsonl`;
      writeLogFile(fileName, `${good}\n${naive}\n`);

      expect(() => runSweep(execId)).not.toThrow();

      // Only the tz-aware line loaded; the naive one is quarantined.
      const loaded = (await rowsFor(batchId)).filter(
        (r) => r.event_code === "BATCH_COMPLETE",
      );
      expect(loaded).toHaveLength(1);
      const summary = (await rowsForExecution(execId)).find(
        (r) => r.event_code === "MALFORMED_LOG_LINE",
      );
      expect(summary?.perceived_severity).toBe("INDETERMINATE");
      const quarantined = readFileSync(join(malformedDir, fileName), "utf8");
      expect(quarantined).toMatch(/2026-08-14T10:00:00"/); // the naive line, no Z
    });

    it("one poison/unreadable file does not wedge the sweep — files sorted after it still load", async () => {
      const batchId = "UDRBAT-RM06-ISOLATION";
      const execId = "exec-isolation";
      // Invalid UTF-8 → read_text raises before any per-line handling. Sorted
      // FIRST; without per-file isolation it would abort the run and starve
      // every later file, every run forever (defeating D9).
      writeFileSync(
        join(logsDir, "00-poison.jsonl"),
        Buffer.from([0xff, 0xff, 0xff, 0x0a]),
      );
      const good = jsonLine({
        log_datetime: "2026-08-14T10:00:00Z",
        component: "RL",
        log_level: "INFO",
        event_code: "BATCH_COMPLETE",
        source_file: "s.csv",
        batch_id: batchId,
        workflow_execution_id: execId,
      });
      writeLogFile(`99-RL-${execId}.jsonl`, good + "\n");

      expect(() => runSweep(execId)).not.toThrow();

      // The good file (sorted AFTER the poison one) still loaded.
      const rows = await rowsFor(batchId);
      expect(rows).toHaveLength(1);
      // The poison file is left in place for inspection, not moved to swept/.
      expect(() =>
        readFileSync(join(logsDir, "00-poison.jsonl")),
      ).not.toThrow();
    });

    it("11. every catalogued severity value round-trips (build hygiene: the seed itself is usable input)", () => {
      // A cheap sanity check that the fixture codes used above actually come
      // from the real catalog, not an invented one.
      const codes = new Set(EVENT_CATALOG_SEED.map((r) => r.eventCode));
      expect(codes.has("DB_WRITE_FAILURE")).toBe(true);
      expect(codes.has("BATCH_COMPLETE")).toBe(true);
    });
  },
);
