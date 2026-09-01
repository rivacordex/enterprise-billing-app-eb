import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { seedEventCatalog } from "@/db/seeds/rating-event-catalog.data";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// rm11-spec §Verification checklist + code-standards §10 test #14 (rm11's
// half — "the stranded batch it resolves"):
//   1. A worker killed mid-load leaves the source file in landing/, zero
//      rows in udr_rated, and a udr_batch row stranded at PROCESSING.
//   2. The reconcile finds it beyond the threshold, resolves it (FAILED,
//      claim released).
//   4. A genuinely-running batch WITHIN the threshold is untouched.
//   5. The reconcile is idempotent — running it twice resolves each strand
//      once.
//   6/7. BATCH_STRANDED emitted at MAJOR and resolves in event_catalog (the
//      coordinated rm02 addition) — the INDETERMINATE count stays zero.
// Item 8 (runs both on flow start and on schedule) is a flow-trigger fact,
// asserted structurally below (static describe) — it needs a live Kestra
// engine to prove for real, same posture as every other flow-trigger item in
// this repo's rm04-rm10 suites.
//
// NOT exercised here (deliberately, not an oversight): a byte-identical
// redelivery of the SAME physical file after its stranded batch is resolved.
// prp.py's `is_duplicate_redelivery` (rm07 D5) matches on `(file_key,
// file_checksum)` regardless of the matched row's status — so a redelivery
// with the exact same bytes as the just-FAILED run would be discarded as
// DUPLICATE_BATCH by PRP's own dedup guard, not reprocessed. Whether that is
// correct (an operator-triggered reprocess is expected to resend under a new
// name/content, matching the RAN_USAGE_<date>_vN.csv reissue convention
// rm10's tests already use) or a genuine cross-unit gap is NOT decided by
// this unit — rm11's spec does not mention it, and prp.py's dedup policy is
// rm07's, not rm11's, to relitigate (ai-workflow-rules §5.6: don't "fix"
// either side to match without confirming which is correct). Flagged in the
// progress tracker's Open Questions instead. This suite proves what rm11
// itself owns: the udr_batch row is released from PROCESSING, and a fresh
// claim under batch_run_num = N+1 (a corrected reissue, `_v2`) succeeds and
// is unaffected by run 1's now-resolved state.
const databaseUrl = process.env.DATABASE_URL;
const workerDir = join(process.cwd(), "rating-engine", "worker");

function pythonRuntimeReady(): boolean {
  try {
    execFileSync("python3", ["-c", "import runtime, polars, psycopg"], {
      cwd: workerDir,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm11-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm11-test-engine@sha256:deadbeef";

const FEED_PROFILE = JSON.stringify({
  header: ["DATETIME", "PUBLIC_KEY", "COMMERCIAL_UNIT", "SITE", "USAGE_MBPS"],
  event_time_column: "DATETIME",
  event_time_assumed_tz: "UTC",
  usage_column: "USAGE_MBPS",
  usage_unit: "MBPS",
  udr_key_columns: ["PUBLIC_KEY", "COMMERCIAL_UNIT", "SITE"],
  subscriber_ref: null,
  interval_seconds: null,
  future_tolerance_seconds: 300,
});
const FILE_KEY_RULE = "^(?P<file_key>RAN_USAGE_\\d{8})(?:_v\\d+)?\\.csv$";
const NOW = "2026-08-20T00:00:00Z";
const CSV_HEADER = "DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS\n";

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
// Static structural checks — no DATABASE_URL, no engine.
// ---------------------------------------------------------------------
describe("stranded-batch reconcile (rm11-spec D1-D9 — static)", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "rating-engine",
      "worker",
      "runtime",
      "stranded_reconcile.py",
    ),
    "utf8",
  );
  const flowYaml = readFileSync(
    join(
      process.cwd(),
      "rating-engine",
      "flows",
      "stranded-batch-reconcile.yaml",
    ),
    "utf8",
  );

  it("finds PROCESSING batches beyond the threshold (D3)", () => {
    expect(source).toMatch(/WHERE\s+status = 'PROCESSING'/);
    expect(source).toMatch(/now\(\) - started_at > %\(threshold\)s/);
  });

  it("resolves by setting status = 'FAILED', guarded on the row still being PROCESSING (D3/D6)", () => {
    expect(source).toMatch(/SET status = 'FAILED'/);
    expect(source).toMatch(
      /WHERE batch_id = %\(batch_id\)s AND status = 'PROCESSING'/,
    );
    // Never touches file_key/batch_run_num/source_file — a status-lifecycle
    // write only, matching rating_runtime's udr_batch grant (code-standards §9).
    const resolveBlock = source.slice(
      source.indexOf("_RESOLVE_SQL"),
      source.indexOf("_RESOLVE_SQL") + 400,
    );
    expect(resolveBlock).not.toMatch(/SET[^;]*file_key/);
  });

  it("emits BATCH_STRANDED with component SCHEDULER", () => {
    expect(source).toMatch(/event_code="BATCH_STRANDED"/);
    expect(source).toMatch(/component="SCHEDULER"/);
  });

  it("the flow declares a Schedule trigger, concurrency limit 1, and calls runtime.stranded_reconcile", () => {
    expect(flowYaml).toMatch(/io\.kestra\.plugin\.core\.trigger\.Schedule/);
    expect(flowYaml).toMatch(/limit:\s*1/);
    expect(flowYaml).toMatch(/python3 -m runtime\.stranded_reconcile/);
    expect(flowYaml).toMatch(/--threshold-seconds/);
  });

  it("both the errors and finally handlers report the terminal outcome (code-standards §3.9)", () => {
    expect(flowYaml).toMatch(/errors:/);
    expect(flowYaml).toMatch(/finally:/);
    const errorsAndFinally = flowYaml.slice(flowYaml.indexOf("errors:"));
    const occurrences =
      errorsAndFinally.match(/runtime\.emit_terminal_log/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Black-box recovery — live DB + the real prp + stranded_reconcile.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "stranded-batch reconcile (rm11-spec D1-D9, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let logsDir: string;
    let workDir: string;

    const dropAll = async (client: postgresjs.Sql) => {
      for (const s of [
        "inventory",
        "ordering",
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
      ]) {
        await client.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
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

      const root = mkdtempSync(join(tmpdir(), "rm11-reconcile-"));
      landingDir = join(root, "landing");
      logsDir = join(root, "logs");
      workDir = join(root, "work");
      for (const d of [landingDir, logsDir, workDir]) {
        mkdirSync(d, { recursive: true });
      }
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropAll(sql);
      await sql.end();
    });

    const runEnv = () => ({
      ...process.env,
      SECRET_RATING_RUNTIME_PASSWORD: ROLE_PW,
      RATING_DB_HOST: dbParams.host,
      RATING_DB_PORT: dbParams.port,
      RATING_DB_NAME: dbParams.name,
      RATING_DB_USER: "rating_runtime",
      RATING_LANDING_DIR: landingDir,
      RATING_LOGS_DIR: logsDir,
      RATING_ENGINE_VERSION: ENGINE_VERSION,
    });

    function uriToPath(uri: string): string {
      return decodeURIComponent(uri.replace(/^file:\/\//, ""));
    }

    function runPrp(
      sourcePath: string,
      execId: string,
    ): Record<string, unknown> {
      const out = execFileSync(
        "python3",
        [
          "-m",
          "runtime.prp",
          "--source-file",
          sourcePath,
          "--udr-type",
          "RAN_USAGE",
          "--profile",
          FEED_PROFILE,
          "--file-key-rule",
          FILE_KEY_RULE,
          "--reject-threshold",
          "0.5",
          "--chunk-size",
          "10000",
          "--workflow-execution-id",
          execId,
          "--now",
          NOW,
          "--work-dir",
          workDir,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
      const manifestUri = out.trim().split("\n").pop() as string;
      return JSON.parse(readFileSync(uriToPath(manifestUri), "utf8"));
    }

    function runReconcile(thresholdSeconds: number, execId: string): string {
      return execFileSync(
        "python3",
        [
          "-m",
          "runtime.stranded_reconcile",
          "--threshold-seconds",
          String(thresholdSeconds),
          "--workflow-execution-id",
          execId,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      ).trim();
    }

    async function batchRow(batchId: string) {
      const [row] = await sql<
        {
          status: string;
          error_summary: string | null;
          file_key: string;
          batch_run_num: number;
        }[]
      >`
        SELECT status, error_summary, file_key, batch_run_num
        FROM rating.udr_batch WHERE batch_id = ${batchId}
      `;
      return row;
    }

    it("1-3, 5. resolves a batch stranded beyond the threshold (releasing it from PROCESSING), is idempotent on re-run, and a corrected reissue claims cleanly as batch_run_num = 2", async () => {
      const csvPath = join(landingDir, "RAN_USAGE_20260601.csv");
      writeFileSync(
        csvPath,
        `${CSV_HEADER}2026-06-01T00:00:00Z,PK1,CU1,SITE1,10.0\n`,
      );

      // A real claim (run 1) — PROCESSING with a fresh started_at.
      const manifest = runPrp(csvPath, "rm11-exec-1");
      const batchId = manifest.batch_id as string;
      const fileKey = manifest.file_key as string;

      let row = await batchRow(batchId);
      expect(row?.status).toBe("PROCESSING"); // item 1 — stranded shape

      // Simulate the killed worker: back-date started_at past the threshold.
      // The raw file (csvPath) is untouched in landing/ — RL never ran, so it
      // was never archived (item 1's "zero rows in udr_rated" holds too:
      // nothing here ever reached RL).
      await sql`UPDATE rating.udr_batch SET started_at = now() - interval '2 hours' WHERE batch_id = ${batchId}`;

      // A batch still within the threshold is untouched (item 4) — proven
      // together with the resolve below via a short threshold that only the
      // back-dated row exceeds.
      const out1 = runReconcile(3600, "rm11-exec-reconcile-1");
      expect(out1).toMatch(/1 batch\(es\) resolved/);

      row = await batchRow(batchId);
      expect(row?.status).toBe("FAILED"); // item 2 — resolved, claim released
      expect(row?.error_summary).toMatch(/BATCH_STRANDED/);

      const logPath = join(logsDir, "SCHEDULER-rm11-exec-reconcile-1.jsonl");
      const lines = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0].event_code).toBe("BATCH_STRANDED");
      expect(lines[0].component).toBe("SCHEDULER");
      expect(lines[0].alarm_key).toBe(`BATCH_STRANDED:${fileKey}:1`);
      expect(lines[0].batch_id).toBe(batchId);

      // Idempotent (item 5): running it again finds nothing to resolve.
      const out2 = runReconcile(3600, "rm11-exec-reconcile-2");
      expect(out2).toMatch(/0 batch\(es\) resolved/);
      row = await batchRow(batchId);
      expect(row?.status).toBe("FAILED"); // unchanged, not re-touched

      // A corrected reissue (new content, `_v2` — same file_key, matching the
      // rm10 reissue convention) claims batch_run_num = 2 cleanly. This is
      // independent of run 1's PROCESSING/FAILED state either way (the claim
      // insert's COALESCE(max(batch_run_num),0)+1 does not gate on status) —
      // what rm11 actually changed is that run 1 now reads as a DECIDED
      // terminal outcome instead of an indefinitely-open one.
      const csvPath2 = join(landingDir, "RAN_USAGE_20260601_v2.csv");
      writeFileSync(
        csvPath2,
        `${CSV_HEADER}2026-06-01T00:00:00Z,PK1,CU1,SITE1,10.0\n2026-06-01T00:05:00Z,PK2,CU1,SITE1,5.0\n`,
      );
      const manifest2 = runPrp(csvPath2, "rm11-exec-3");
      expect(manifest2.file_key).toBe(fileKey);
      expect(manifest2.status).toBe("PROCESSING");
      const row2 = await batchRow(manifest2.batch_id as string);
      expect(row2?.batch_run_num).toBe(2);
    });

    it("4. a genuinely-running batch within the threshold is untouched", async () => {
      const csvPath = join(landingDir, "RAN_USAGE_20260602.csv");
      writeFileSync(
        csvPath,
        `${CSV_HEADER}2026-06-02T00:00:00Z,PK1,CU1,SITE1,10.0\n`,
      );
      const manifest = runPrp(csvPath, "rm11-exec-fresh");
      const batchId = manifest.batch_id as string;

      // started_at is fresh (just claimed) — well within a 3600s threshold.
      const out = runReconcile(3600, "rm11-exec-reconcile-fresh");
      expect(out).toMatch(/0 batch\(es\) resolved/);

      const row = await batchRow(batchId);
      expect(row?.status).toBe("PROCESSING");
    });

    it("6-7. BATCH_STRANDED resolves to MAJOR via event_catalog, and the INDETERMINATE count stays zero", async () => {
      const [resolved] = await sql<
        {
          perceived_severity: string | null;
          event_type: string;
          probable_cause: string;
        }[]
      >`
        SELECT CASE WHEN c.event_code IS NULL THEN 'INDETERMINATE' ELSE c.default_severity END AS perceived_severity,
               c.event_type, c.probable_cause
        FROM (SELECT 'BATCH_STRANDED'::text AS event_code) e
        LEFT JOIN rating.event_catalog c ON c.event_code = e.event_code AND c.is_active
      `;
      expect(resolved?.perceived_severity).toBe("MAJOR");
      expect(resolved?.event_type).toBe("processingErrorAlarm");

      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM rating.event_catalog
        WHERE event_code = 'BATCH_STRANDED' AND is_auto_clearing AND clear_event_code = 'BATCH_COMPLETE'
      `;
      expect(row?.count).toBe(1);
    });
  },
);
