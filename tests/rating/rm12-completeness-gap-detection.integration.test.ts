import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
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
import { udrBatch } from "@/db/schema/rating/udr-batch";
import { udrRated } from "@/db/schema/rating/udr-rated";

// rm12-spec §Verification checklist:
//   1. A file that never arrives raises FILE_NOT_RECEIVED at MAJOR where
//      previously there was only silence.
//   2. When the late file lands and completes, it clears that alarm — a
//      CLEARED row on the same alarm_key.
//   3. An arrival outside its window raises FILE_LATE at WARNING.
//   4. Only auto-clearing codes clear (not exercised by re-raising a
//      non-auto-clearing code here — this module never emits one at all;
//      it only ever raises/clears FILE_NOT_RECEIVED/FILE_LATE, both
//      is_auto_clearing per the rm02 seed).
//   5. Usage superseded and never replaced is returned by the orphan query.
//   6. Boundary: zero-activity accounts are not reported (not applicable —
//      this module never derives an account list at all).
//   7. Every emitted code resolves in event_catalog; INDETERMINATE stays
//      zero (FILE_NOT_RECEIVED/FILE_LATE/CLEARED are all seeded by rm02).
//
// Fixtures are inserted directly via Drizzle (rm09's precedent for
// udr_rated/udr_batch fixture rows) rather than run through the full
// prp -> rp -> rl pipeline: this unit's own logic is entirely about
// evaluating udr_batch/udr_rated/process_log state against a schedule, not
// about producing that state, so a full price-resolution graph would add
// nothing this module's tests need to prove.
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

const ROLE_PW = "rm12-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm12-test-engine@sha256:deadbeef";

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
describe("completeness and gap detection (rm12-spec D1-D6 — static)", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "rating-engine",
      "worker",
      "runtime",
      "completeness_check.py",
    ),
    "utf8",
  );
  const flowYaml = readFileSync(
    join(process.cwd(), "rating-engine", "flows", "completeness-check.yaml"),
    "utf8",
  );

  it("finds udr_batch rows received for a period, by udr_type + UTC calendar day (D3)", () => {
    expect(source).toMatch(/WHERE\s+udr_type = %\(udr_type\)s/);
    expect(source).toMatch(
      /\(received_at AT TIME ZONE 'UTC'\)::date = %\(period\)s/,
    );
  });

  it("the raise guard and the clear guard are two distinct queries (D4/D6)", () => {
    expect(source).toMatch(/def alarm_already_raised/);
    expect(source).toMatch(/def alarm_is_open/);
    // The raise guard tests existence only (no CLEARED-aware NOT EXISTS) —
    // a cleared alarm must never re-raise on the same still-true historical
    // fact.
    const raisedBlock = source.slice(
      source.indexOf("_ALARM_EVER_RAISED_SQL"),
      source.indexOf("_ALARM_EVER_RAISED_SQL") + 300,
    );
    expect(raisedBlock).not.toMatch(/CLEARED/);
  });

  it("emits FILE_NOT_RECEIVED / FILE_LATE / CLEARED, never a code outside that set", () => {
    expect(source).toMatch(/event_code="FILE_NOT_RECEIVED"/);
    expect(source).toMatch(/event_code="FILE_LATE"/);
    expect(source).toMatch(/event_code="CLEARED"/);
  });

  it("runs the spec's literal superseded-never-replaced orphan query (D5)", () => {
    expect(source).toMatch(/o\.is_live IS NULL/);
    expect(source).toMatch(
      /l\.udr_key = o\.udr_key AND l\.start_datetime = o\.start_datetime/,
    );
    expect(source).toMatch(/AND\s+l\.is_live\)/);
  });

  it("never touches non-auto-clearing codes (D4 boundary)", () => {
    for (const code of [
      "LOAD_BLOCKED_BILLED",
      "RECON_IMBALANCE",
      "SHRINKING_REISSUE",
      "FILE_KEY_UNRESOLVED",
      "CURRENCY_MISMATCH",
    ]) {
      expect(source).not.toContain(code);
    }
  });

  it("the flow declares an hourly Schedule trigger, concurrency limit 1, and calls runtime.completeness_check", () => {
    expect(flowYaml).toMatch(/io\.kestra\.plugin\.core\.trigger\.Schedule/);
    expect(flowYaml).toMatch(/limit:\s*1/);
    expect(flowYaml).toMatch(/python3 -m runtime\.completeness_check/);
    expect(flowYaml).toMatch(/--config/);
    expect(flowYaml).toMatch(/kv\('rating_completeness_config'\)/);
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
// Black-box check — live DB + the real completeness_check + log_sweep.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "completeness and gap detection (rm12-spec D1-D6, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let logsDir: string;
    let sweptDir: string;
    let malformedDir: string;

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

      const root = mkdtempSync(join(tmpdir(), "rm12-completeness-"));
      logsDir = join(root, "logs");
      sweptDir = join(root, "logs", "swept");
      malformedDir = join(root, "logs", "malformed");
      mkdirSync(logsDir, { recursive: true });
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
      RATING_LOGS_DIR: logsDir,
      RATING_ENGINE_VERSION: ENGINE_VERSION,
    });

    function runCheck(opts: {
      config: string;
      now: string;
      lookbackDays: number;
      execId: string;
    }): string {
      return execFileSync(
        "python3",
        [
          "-m",
          "runtime.completeness_check",
          "--config",
          opts.config,
          "--lookback-days",
          String(opts.lookbackDays),
          "--workflow-execution-id",
          opts.execId,
          "--now",
          opts.now,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      ).trim();
    }

    function runSweep(execId: string): void {
      execFileSync(
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
          execId,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
    }

    function logLines(execId: string) {
      const path = join(logsDir, `SCHEDULER-${execId}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }

    let batchSeq = 0;
    async function insertBatch(opts: {
      udrType: string;
      receivedAt: string;
      status: string;
    }): Promise<string> {
      batchSeq += 1;
      const fileKey = `RM12-FIXTURE-${batchSeq}`;
      const [row] = await db
        .insert(udrBatch)
        .values({
          fileKey,
          sourceFile: `${fileKey}.csv`,
          fileKeyRule: "^(?P<file_key>RM12-FIXTURE-\\d+)$",
          udrType: opts.udrType,
          status: opts.status,
          receivedAt: new Date(opts.receivedAt),
        })
        .returning({ batchId: udrBatch.batchId });
      return row!.batchId;
    }

    // -------------------------------------------------------------
    // 1/2/3 — FILE_NOT_RECEIVED raised on silence, FILE_LATE raised on a
    // late arrival, and each clears exactly once when the delivery lands
    // and completes — proven together since the clearing scenario needs a
    // period that was first absent, then late-but-completed.
    // -------------------------------------------------------------
    it("1/2/3. raises FILE_NOT_RECEIVED on silence, then FILE_LATE + clears FILE_NOT_RECEIVED once the late delivery completes, idempotently", async () => {
      const CONFIG = "RAN_USAGE:06:00";
      const PERIOD = "2026-06-05";

      // Run 1 — nothing has arrived; the 06:00 deadline has passed (now=08:00).
      const out1 = runCheck({
        config: CONFIG,
        now: "2026-06-05T08:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-1",
      });
      expect(out1).toMatch(/1 event\(s\) emitted/);
      const lines1 = logLines("rm12-exec-1");
      expect(lines1).toHaveLength(1);
      expect(lines1[0]!.event_code).toBe("FILE_NOT_RECEIVED");
      expect(lines1[0]!.alarm_key).toBe(
        `FILE_NOT_RECEIVED:RAN_USAGE:${PERIOD}`,
      );
      expect(lines1[0]!.perceived_severity).toBeNull(); // resolved later by the sweep

      runSweep("sweep-1");

      // Re-running before anything changes must NOT duplicate the raise
      // (D6 idempotency) — same period, same absence, still silent.
      const out1b = runCheck({
        config: CONFIG,
        now: "2026-06-05T08:30:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-1b",
      });
      expect(out1b).toMatch(/0 event\(s\) emitted/);

      // The delivery arrives late (09:00, after the 06:00 deadline) and has
      // already reached COMPLETE by the time of the next check.
      await insertBatch({
        udrType: "RAN_USAGE",
        receivedAt: "2026-06-05T09:00:00Z",
        status: "COMPLETE",
      });

      // Run 2 — the batch is now visible: FILE_LATE raises (item 3), and
      // FILE_NOT_RECEIVED clears (item 2 — "lands and completes" clears the
      // earlier alarm on the SAME alarm_key). FILE_LATE itself is too fresh
      // to clear in this same run (nothing has swept its raise yet).
      const out2 = runCheck({
        config: CONFIG,
        now: "2026-06-05T10:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-2",
      });
      expect(out2).toMatch(/2 event\(s\) emitted/);
      const lines2 = logLines("rm12-exec-2");
      const late = lines2.find((l) => l.event_code === "FILE_LATE");
      const cleared = lines2.find((l) => l.event_code === "CLEARED");
      expect(late?.alarm_key).toBe(`FILE_LATE:RAN_USAGE:${PERIOD}`);
      expect(cleared?.alarm_key).toBe(`FILE_NOT_RECEIVED:RAN_USAGE:${PERIOD}`);

      runSweep("sweep-2");

      // Run 3 — FILE_LATE's own raise has now been swept, so it clears too.
      // It must NOT be re-raised (D6/D4's oscillation guard: the late-arrival
      // fact stays true forever, but a dated alarm_key fires at most once).
      const out3 = runCheck({
        config: CONFIG,
        now: "2026-06-05T11:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-3",
      });
      expect(out3).toMatch(/1 event\(s\) emitted/);
      const lines3 = logLines("rm12-exec-3");
      expect(lines3).toHaveLength(1);
      expect(lines3[0]!.event_code).toBe("CLEARED");
      expect(lines3[0]!.alarm_key).toBe(`FILE_LATE:RAN_USAGE:${PERIOD}`);

      runSweep("sweep-3");

      // Run 4 — everything is resolved and swept; a further run is a
      // stable no-op, proving the fix holds rather than oscillating.
      const out4 = runCheck({
        config: CONFIG,
        now: "2026-06-05T12:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-4",
      });
      expect(out4).toMatch(/0 event\(s\) emitted/);
    });

    // -------------------------------------------------------------
    // On-time arrival: no alarm at all.
    // -------------------------------------------------------------
    it("a delivery received before its deadline raises nothing", async () => {
      await insertBatch({
        udrType: "RAN_USAGE",
        receivedAt: "2026-06-06T05:00:00Z",
        status: "RECEIVED",
      });
      const out = runCheck({
        config: "RAN_USAGE:06:00",
        now: "2026-06-06T07:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-ontime",
      });
      expect(out).toMatch(/0 event\(s\) emitted/);
      expect(logLines("rm12-exec-ontime")).toHaveLength(0);
    });

    // -------------------------------------------------------------
    // Empty config — a safe no-op, never a hang or an error.
    // -------------------------------------------------------------
    it("an empty --config no-ops rather than failing", () => {
      const out = runCheck({
        config: "",
        now: "2026-06-07T12:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-empty",
      });
      expect(out).toMatch(/no udr_type configured/);
    });

    // -------------------------------------------------------------
    // 5 — superseded-never-replaced, via the orphan index.
    // -------------------------------------------------------------
    it("5. surfaces usage superseded and never replaced, via the orphan-index query", async () => {
      const commonRow = {
        partitionPeriod: "2026-06-01",
        udrType: "RAN_USAGE",
        udrSubscriberRefId: "sub-rm12",
        udrUsageQuantity: "10",
        udrUsageUnit: "MBPS",
        udrRateType: "FLAT" as const,
        udrRatedPrice: "1.00",
        udrRatedPriceRaw: "1.000000",
        udrRoundingMode: "HALF_UP" as const,
        udrCurrency: "MYR",
        udrRefBatchId: "SENTINEL-RM12",
        udrSourceFile: "rm12-fixture.csv",
        ratingEngineVersion: ENGINE_VERSION,
        ratingFlowRevision: 1,
      };
      const rowAt = (start: string) => ({
        startDatetime: new Date(start),
        endDatetime: new Date(new Date(start).getTime() + 15 * 60 * 1000),
      });

      // Orphan: SUPERSEDED with no live row sharing its exact natural key
      // (start_datetime, udr_key) — the shrinking-reissue / never-replaced
      // case (D5's headline scenario).
      await db.insert(udrRated).values({
        ...commonRow,
        ...rowAt("2026-06-01T00:00:00Z"),
        status: "SUPERSEDED",
        udrKey: "orphan-key-rm12",
      });

      // Not an orphan: SUPERSEDED, but a live row exists at the exact same
      // (udr_key, start_datetime) — the spec's literal NOT EXISTS predicate
      // must exclude this one.
      await db.insert(udrRated).values({
        ...commonRow,
        ...rowAt("2026-06-01T01:00:00Z"),
        status: "SUPERSEDED",
        udrKey: "replaced-key-rm12",
      });
      await db.insert(udrRated).values({
        ...commonRow,
        ...rowAt("2026-06-01T01:00:00Z"),
        status: "RATED",
        udrKey: "replaced-key-rm12",
      });

      // Never superseded at all — is_live is NOT NULL, excluded trivially.
      await db.insert(udrRated).values({
        ...commonRow,
        ...rowAt("2026-06-01T02:00:00Z"),
        status: "RATED",
        udrKey: "live-only-key-rm12",
      });

      const out = runCheck({
        config: "",
        now: "2026-06-07T12:00:00Z",
        lookbackDays: 1,
        execId: "rm12-exec-orphan",
      });
      expect(out).toMatch(/1 superseded-never-replaced key/);
      expect(out).toContain("orphan-key-rm12");
      expect(out).not.toContain("replaced-key-rm12");
      expect(out).not.toContain("live-only-key-rm12");
    });

    // -------------------------------------------------------------
    // 7 — every emitted code resolves in event_catalog; INDETERMINATE stays
    // zero for the codes this module emits.
    // -------------------------------------------------------------
    it("7. FILE_NOT_RECEIVED, FILE_LATE and CLEARED all resolve in event_catalog, and each is is_auto_clearing", async () => {
      const rows = await sql<
        {
          event_code: string;
          perceived_severity: string | null;
          is_auto_clearing: boolean;
        }[]
      >`
        SELECT c.event_code, c.default_severity AS perceived_severity, c.is_auto_clearing
        FROM rating.event_catalog c
        WHERE c.event_code IN ('FILE_NOT_RECEIVED', 'FILE_LATE', 'CLEARED') AND c.is_active
        ORDER BY c.event_code
      `;
      expect(rows).toHaveLength(3);
      const byCode = Object.fromEntries(rows.map((r) => [r.event_code, r]));
      expect(byCode.FILE_NOT_RECEIVED!.perceived_severity).toBe("MAJOR");
      expect(byCode.FILE_NOT_RECEIVED!.is_auto_clearing).toBe(true);
      expect(byCode.FILE_LATE!.perceived_severity).toBe("WARNING");
      expect(byCode.FILE_LATE!.is_auto_clearing).toBe(true);
      expect(byCode.CLEARED!.perceived_severity).toBe("CLEARED");
    });

    it("rejects a malformed --config entry rather than silently skipping it", () => {
      expect(() =>
        runCheck({
          config: "RAN_USAGE:not-a-time",
          now: "2026-06-08T12:00:00Z",
          lookbackDays: 1,
          execId: "rm12-exec-badconfig",
        }),
      ).toThrow();
    });
  },
);
