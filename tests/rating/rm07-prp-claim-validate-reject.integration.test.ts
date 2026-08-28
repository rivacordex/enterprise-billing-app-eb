import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
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

// rm07-spec §Verification checklist + code-standards §10 tests OWNED by rm07:
//   #9  Batch claim — two differently named files derive the SAME file_key (one
//       logical delivery); two content periods NEVER derive the same key; an
//       unparseable name refuses with FILE_KEY_UNRESOLVED.
//   #12 Log proportionality — N rejected records produce exactly ONE summarised
//       process_log line, independent of N (Inv #11).
//
// The static describe (no DATABASE_URL) checks the flow-YAML contract rm07
// adds (the real prp task, the landing trigger, the output-affecting variables,
// the chunk-size KV reference). The DB-gated describe shells out to the REAL
// `python3 -m runtime.prp` exactly as the flow's prp task invokes it — a
// black-box test of the actual processor, not a TS reimplementation. Requires
// `python3` on PATH with the worker's requirements installed (psycopg + polars);
// skipped loudly, like the DATABASE_URL gate, when unavailable — same posture as
// the rm06 suite (see ratemgmt-progress-tracker.md: not run in a session without
// a live test Postgres + the worker deps).
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

const ROLE_PW = "rm07-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);

// The feed profile the flow ships for RAN_USAGE (ran-usage-rating.yaml
// `vars.feed_profile`) — kept identical here so the black-box test exercises the
// real production configuration, not a test-only one.
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
// A fixed reference instant so OUT_OF_RANGE never depends on wall-clock time;
// all fixture events are dated before it.
const NOW = "2026-08-20T00:00:00Z";

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

// noUncheckedIndexedAccess makes `rows[0]` / `lines[0]` possibly-undefined;
// these assert-and-narrow so the tests read cleanly.
function firstRow<T>(rows: readonly T[]): T {
  const row = rows.at(0);
  if (row === undefined) throw new Error("expected at least one row");
  return row;
}
function firstLine(lines: readonly string[]): string {
  const line = lines.at(0);
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm07 D1/D3/D6/D7.
// ---------------------------------------------------------------------
describe("prp flow wiring (rm07-spec D1/D3/D6/D7 — static)", () => {
  const template = readFileSync(
    join(process.cwd(), "rating-engine", "flows", "ran-usage-rating.yaml"),
    "utf8",
  );

  it("the prp task invokes the real runtime.prp module and hands off a manifest URI", () => {
    expect(template).toMatch(/python3 -m runtime\.prp/);
    expect(template).toMatch(/--source-file "\{\{ trigger\.uri \}\}"/);
    expect(template).toMatch(/outputs\.prp\.uri/);
    // The prp section carries no rate maths / insert (that is rp/rl's) — it is a
    // module invocation, not inline python.
    const prpBlock = template.slice(
      template.indexOf("id: prp"),
      template.indexOf("id: rp"),
    );
    expect(prpBlock).not.toMatch(/INSERT INTO/i);
    expect(prpBlock).not.toMatch(/python3 -c/);
  });

  it("the landing/ file trigger replaces the manual trigger and never moves the file (D3, Inv #7)", () => {
    const triggersBlock = template.slice(
      template.indexOf("triggers:"),
      template.indexOf("tasks:"),
    );
    expect(triggersBlock).toMatch(/id: landing-file/);
    expect(triggersBlock).toMatch(/fs\.local\.Trigger/);
    // The claim is the DB constraint, not a filesystem op — the trigger takes no
    // move/delete action (Inv #7, Inv #9).
    expect(triggersBlock).toMatch(/action:\s*NONE/);
    // The manual Webhook trigger plugin is gone (the word may appear in a
    // comment explaining the replacement; the plugin type must not).
    expect(triggersBlock).not.toMatch(
      /type:\s*io\.kestra\.plugin\.core\.trigger\.Webhook/,
    );
  });

  it("output-affecting config lives in flow variables; chunk size lives in the KV store (D1/D6/D7, architecture §3)", () => {
    const vars = template.slice(
      template.indexOf("variables:"),
      template.indexOf("concurrency:"),
    );
    // The feed profile (column mapping + udr_key column list), the file_key rule
    // and the reject threshold are output-affecting → flow variables.
    expect(vars).toMatch(/feed_profile:/);
    expect(vars).toMatch(/udr_key_columns/);
    expect(vars).toMatch(/PUBLIC_KEY/);
    expect(vars).toMatch(/file_key_rule:/);
    expect(vars).toMatch(/reject_threshold:/);
    // Chunk size is performance-only → the namespace KV store, NOT a variable.
    expect(vars).not.toMatch(/chunk_size/);
    expect(template).toMatch(/kv\('rating_ran_usage_chunk_size'\)/);
  });

  it("concurrency: limit: 1 is retained (D6)", () => {
    expect(template).toMatch(/concurrency:\s*\n\s*limit:\s*1/);
  });
});

// ---------------------------------------------------------------------
// Black-box claim/validate/reject — live DB + the real python3 -m runtime.prp.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "prp claim/validate/reject (rm07-spec D3-D6, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let errorDir: string;
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

      const root = mkdtempSync(join(tmpdir(), "rm07-prp-"));
      landingDir = join(root, "landing");
      errorDir = join(root, "error");
      logsDir = join(root, "logs");
      workDir = join(root, "work");
      for (const d of [landingDir, errorDir, logsDir, workDir]) {
        mkdirSync(d, { recursive: true });
      }
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropAll(sql);
      await sql.end();
    });

    function writeCsv(name: string, rows: string[]): string {
      const header = "DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS";
      const path = join(landingDir, name);
      writeFileSync(path, [header, ...rows].join("\n") + "\n", "utf8");
      return path;
    }

    // Runs the real prp exactly as the flow's prp task does. Returns the printed
    // manifest URI (stdout) and the workflow-execution-id used, or throws with
    // the captured stderr on a non-zero exit (the refuse / FILE_KEY_UNRESOLVED
    // paths).
    function runPrp(
      sourcePath: string,
      opts: { threshold?: number; chunkSize?: number; execId?: string } = {},
    ): { execId: string; manifestUri: string } {
      const execId =
        opts.execId ?? `exec-${Math.random().toString(36).slice(2)}`;
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
          String(opts.threshold ?? 0.5),
          "--chunk-size",
          String(opts.chunkSize ?? 10_000),
          "--workflow-execution-id",
          execId,
          "--now",
          NOW,
          "--work-dir",
          workDir,
        ],
        {
          cwd: workerDir,
          encoding: "utf8",
          env: {
            ...process.env,
            SECRET_RATING_RUNTIME_PASSWORD: ROLE_PW,
            RATING_DB_HOST: dbParams.host,
            RATING_DB_PORT: dbParams.port,
            RATING_DB_NAME: dbParams.name,
            RATING_DB_USER: "rating_runtime",
            RATING_ERROR_DIR: errorDir,
            RATING_LOGS_DIR: logsDir,
          },
        },
      );
      return { execId, manifestUri: out.trim().split("\n").pop() as string };
    }

    function validRows(count: number, startPk = 0): string[] {
      return Array.from({ length: count }, (_, i) => {
        const n = startPk + i;
        return `2026-08-14T10:${String(n % 60).padStart(2, "0")}:00Z,PK${n},CU${n % 5},SITE${n % 3},${(n % 9) + 0.5}`;
      });
    }

    function logLinesFor(execId: string): string[] {
      const path = join(logsDir, `PRP-${execId}.jsonl`);
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }

    // -----------------------------------------------------------------
    // #9 — Batch claim / file_key derivation from the FILENAME (D3).
    // -----------------------------------------------------------------
    it("9. claims run 1 for a well-named file and stamps its counts", async () => {
      const path = writeCsv("RAN_USAGE_20260814.csv", validRows(10));
      runPrp(path);
      const rows = await sql`
        SELECT file_key, batch_run_num, status, parsed_count, rejected_count,
               discarded_count, source_file
          FROM rating.udr_batch WHERE file_key = 'RAN_USAGE_20260814'`;
      expect(rows).toHaveLength(1);
      expect(firstRow(rows).batch_run_num).toBe(1);
      expect(firstRow(rows).parsed_count).toBe(10);
      expect(firstRow(rows).rejected_count).toBe(0);
      expect(firstRow(rows).discarded_count).toBe(0);
      expect(firstRow(rows).source_file).toBe("RAN_USAGE_20260814.csv");
    });

    it("9. two differently named files derive the SAME file_key — recognised as one logical delivery (run 2)", async () => {
      // Different content (11 rows, not 10) so it is a genuine reissue, not a
      // byte-identical redelivery.
      const path = writeCsv("RAN_USAGE_20260814_v2.csv", validRows(11));
      runPrp(path);
      const rows = await sql`
        SELECT batch_run_num, source_file
          FROM rating.udr_batch
         WHERE file_key = 'RAN_USAGE_20260814'
         ORDER BY batch_run_num`;
      expect(rows.map((r) => r.batch_run_num)).toEqual([1, 2]);
      // The reissue records its own physical name, but groups under one file_key.
      expect(rows.map((r) => r.source_file)).toContain(
        "RAN_USAGE_20260814_v2.csv",
      );
    });

    it("9. a different content date NEVER derives the same file_key", async () => {
      const path = writeCsv("RAN_USAGE_20260815.csv", validRows(5));
      runPrp(path);
      const keys = await sql`
        SELECT DISTINCT file_key FROM rating.udr_batch ORDER BY file_key`;
      expect(keys.map((k) => k.file_key)).toEqual([
        "RAN_USAGE_20260814",
        "RAN_USAGE_20260815",
      ]);
    });

    it("9. an unparseable filename refuses with FILE_KEY_UNRESOLVED and makes no batch", async () => {
      const path = writeCsv("corrected.csv", validRows(3));
      expect(() => runPrp(path, { execId: "exec-fku" })).toThrow();
      const rows = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE source_file = 'corrected.csv'`;
      expect(firstRow(rows).n).toBe(0);
      const lines = logLinesFor("exec-fku");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(firstLine(lines)).event_code).toBe(
        "FILE_KEY_UNRESOLVED",
      );
    });

    it("a byte-identical redelivery is discarded as DUPLICATE_BATCH before parsing (D5)", async () => {
      // Re-deliver run 1's exact bytes under a varied name (same file_key).
      const identical = validRows(10);
      writeCsv("RAN_USAGE_20260814.csv", identical); // reproduce run-1 content
      const before = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE file_key = 'RAN_USAGE_20260814'`;
      const dupPath = writeCsv("RAN_USAGE_20260814_v9.csv", identical);
      const { execId } = runPrp(dupPath, { execId: "exec-dup" });
      const after = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE file_key = 'RAN_USAGE_20260814'`;
      expect(firstRow(after).n).toBe(firstRow(before).n); // no new batch
      const lines = logLinesFor(execId);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(firstLine(lines)).event_code).toBe("DUPLICATE_BATCH");
    });

    // -----------------------------------------------------------------
    // #12 — Log proportionality (Inv #11): N rejects → ONE summarised line.
    // -----------------------------------------------------------------
    it("12. N rejected records produce exactly one summarised process_log line, independent of N", async () => {
      // 37 bad rows among 100 (the headline case's ratio), threshold 0.5 → carry.
      const good = validRows(63, 100);
      const bad = Array.from(
        { length: 37 },
        (_, i) => `not-a-date,PK${i},CU${i},SITE${i},oops`, // BAD_DATETIME + BAD_USAGE
      );
      const path = writeCsv("RAN_USAGE_20260901.csv", [...good, ...bad]);
      const { execId } = runPrp(path, {
        execId: "exec-partial",
        threshold: 0.5,
      });

      const lines = logLinesFor(execId);
      expect(lines).toHaveLength(1); // ONE line, not 37
      expect(JSON.parse(firstLine(lines)).event_code).toBe("BATCH_PARTIAL");

      const rows = await sql`
        SELECT parsed_count, rejected_count, discarded_count, status, reject_file_path
          FROM rating.udr_batch WHERE file_key = 'RAN_USAGE_20260901'`;
      expect(firstRow(rows).parsed_count).toBe(100);
      expect(firstRow(rows).rejected_count).toBe(37);
      expect(firstRow(rows).discarded_count).toBe(0);
      // The 37 land in the reject file (per record), never per-record log rows.
      const rejectRows = readFileSync(firstRow(rows).reject_file_path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(rejectRows).toHaveLength(1 + 37); // header + 37 rejects
    });

    it("12. a different reject count still produces exactly one line — proportionality is independent of N", async () => {
      const good = validRows(97, 500);
      const bad = [
        "not-a-date,PK,CU,SITE,x",
        "bad2,PK,CU,SITE,y",
        "bad3,PK,,SITE,z",
      ];
      const path = writeCsv("RAN_USAGE_20260902.csv", [...good, ...bad]);
      const { execId } = runPrp(path, {
        execId: "exec-partial2",
        threshold: 0.5,
      });
      expect(logLinesFor(execId)).toHaveLength(1);
      const rows = await sql`
        SELECT rejected_count FROM rating.udr_batch WHERE file_key = 'RAN_USAGE_20260902'`;
      expect(firstRow(rows).rejected_count).toBe(3);
    });

    // Review-fix regression: a whitespace-only line is a non-record (skipped,
    // not counted, not rejected), and the reject file preserves the ORIGINAL
    // garbled row rather than a re-serialized form.
    it("review-fix: whitespace-only lines are skipped, and the reject file keeps the original garbled row", async () => {
      const rowsIn = [
        ...validRows(5, 600),
        "   ", // whitespace-only trailing line → must be SKIPPED, not MALFORMED_ROW
        '2026-08-14T10:00:00Z,PK,"unterminated,SITE,5', // garbled quoting → MALFORMED_ROW
      ];
      const path = writeCsv("RAN_USAGE_20260905.csv", rowsIn);
      const { execId } = runPrp(path, { execId: "exec-ws", threshold: 0.5 });
      const rows = await sql`
        SELECT parsed_count, rejected_count, reject_file_path
          FROM rating.udr_batch WHERE file_key = 'RAN_USAGE_20260905'`;
      // 5 good + 1 garbled = 6 parsed; the whitespace line is NOT counted.
      expect(firstRow(rows).parsed_count).toBe(6);
      expect(firstRow(rows).rejected_count).toBe(1);
      expect(logLinesFor(execId)).toHaveLength(1); // one summarised line (Inv #11)
      // The garbled row's original content survives into the reject file.
      const rejectText = readFileSync(firstRow(rows).reject_file_path, "utf8");
      expect(rejectText).toContain("unterminated");
    });

    // Review-fix regression: an empty --source-file (an unresolved trigger
    // binding) fails fast with exit 1, not a crash in the error path.
    it("review-fix: an empty --source-file fails fast (exit 1), never crashing the log path", () => {
      expect(() => runPrp("", { execId: "exec-empty" })).toThrow();
    });

    it("threshold 0 refuses the whole file on the first bad record (PARSE_FAILURE, REFUSED)", async () => {
      const rowsIn = [...validRows(20, 900), "bad,PK,CU,SITE,x"];
      const path = writeCsv("RAN_USAGE_20260903.csv", rowsIn);
      expect(() =>
        runPrp(path, { execId: "exec-refuse", threshold: 0 }),
      ).toThrow();
      const rows = await sql`
        SELECT status, rejected_count FROM rating.udr_batch
         WHERE file_key = 'RAN_USAGE_20260903'`;
      expect(firstRow(rows).status).toBe("REFUSED");
      const lines = logLinesFor("exec-refuse");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(firstLine(lines)).event_code).toBe("PARSE_FAILURE");
      // No survivor chunks were carried forward for a refused file.
      const manifests = readdirSync(workDir).filter((f) =>
        f.endsWith("-manifest.json"),
      );
      // The refused batch prints no manifest (exit non-zero) — its work dir holds
      // no manifest for this file_key's batch.
      expect(
        manifests.some((m) =>
          readFileSync(join(workDir, m), "utf8").includes("REFUSED"),
        ),
      ).toBe(false);
    });

    it("carries survivors as chunked Parquet with the counts stamped (D7)", async () => {
      const path = writeCsv("RAN_USAGE_20260904.csv", validRows(25, 1000));
      const { manifestUri } = runPrp(path, {
        execId: "exec-chunks",
        chunkSize: 10,
      });
      const manifestPath = decodeURIComponent(
        manifestUri.replace(/^file:\/\//, ""),
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.status).toBe("PROCESSING");
      expect(manifest.parsed_count).toBe(25);
      // 25 rows at chunk size 10 → 3 chunks (10, 10, 5) — bounded by chunk count,
      // never per record (Inv #10).
      expect(manifest.chunk_uris).toHaveLength(3);
    });
  },
);
