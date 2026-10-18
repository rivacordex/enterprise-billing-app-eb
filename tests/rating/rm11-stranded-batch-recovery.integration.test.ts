import { existsSync, readFileSync } from "node:fs";
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
import {
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  RAN_USAGE_FILE_KEY_RULE,
  readManifest,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
} from "@/tests/helpers/rating-ran-harness";

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
// The DB-gated describe drives the real PRP through the shared
// `rating-ran-harness` (the production rm21 7-column `.udr` profile, the
// `rating-input-file-YYYYMMDDHHMI[_vN].udr` file-key rule and a Sample-5G graph
// with its ratecard) — a claim needs a resolvable subscription + a covered
// ratecard since rm21.
//
// NOT exercised here (deliberately, not an oversight): a byte-identical
// redelivery of the SAME physical file after its stranded batch is resolved.
// prp.py's `is_duplicate_redelivery` (rm07 D5) matches on `(file_key,
// file_checksum)` regardless of the matched row's status — so a redelivery
// with the exact same bytes as the just-FAILED run would be discarded as
// DUPLICATE_BATCH by PRP's own dedup guard, not reprocessed. Whether that is
// correct (an operator-triggered reprocess is expected to resend under a new
// name/content, matching the `rating-input-file-<stamp>_vN.udr` reissue
// convention rm10's tests already use) or a genuine cross-unit gap is NOT
// decided by this unit — rm11's spec does not mention it, and prp.py's dedup
// policy is rm07's, not rm11's, to relitigate (ai-workflow-rules §5.6: don't
// "fix" either side to match without confirming which is correct). Flagged in
// the progress tracker's Open Questions instead. This suite proves what rm11
// itself owns: the udr_batch row is released from PROCESSING, and a fresh
// claim under batch_run_num = N+1 (a corrected reissue, `_v2`) succeeds and
// is unaffected by run 1's now-resolved state.
const databaseUrl = process.env.DATABASE_URL;
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm11-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm11-test-engine@sha256:deadbeef";
const NOW = "2026-08-20T00:00:00Z";

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine.
// ---------------------------------------------------------------------
describe("stranded-batch reconcile (rm11-spec D1-D9 — static)", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "worker",
      "workflow-engine",
      "runtime",
      "stranded_reconcile.py",
    ),
    "utf8",
  );
  const flowYaml = readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "flows",
      "rating-engine",
      "rating-batch-reconcile.yaml",
    ),
    "utf8",
  );

  it("finds non-terminal (RECEIVED/PROCESSING) batches beyond the threshold (D3)", () => {
    // Both non-terminal states are stranded: PRP commits the claim as RECEIVED
    // before parsing, then stamps PROCESSING + started_at with the counts, so a
    // worker killed mid-parse strands at RECEIVED (started_at still NULL) and
    // one killed in RP/RL strands at PROCESSING. Age is measured from
    // COALESCE(started_at, received_at) so the RECEIVED case (NULL started_at)
    // is aged from its NOT-NULL claim time.
    expect(source).toMatch(/WHERE\s+status IN \('RECEIVED', 'PROCESSING'\)/);
    expect(source).toMatch(
      /now\(\) - COALESCE\(started_at, received_at\) > %\(threshold\)s/,
    );
  });

  it("resolves by setting status = 'FAILED', guarded on the row still being non-terminal (D3/D6)", () => {
    expect(source).toMatch(/SET status = 'FAILED'/);
    expect(source).toMatch(
      /WHERE batch_id = %\(batch_id\)s AND status IN \('RECEIVED', 'PROCESSING'\)/,
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
// Black-box recovery — live DB + the real prp + stranded_reconcile, on the
// maintained `rating-ran-harness` (the production 7-column `.udr` profile and
// the Sample-5G graph with its ratecard, rm21). Each case seeds its own graph
// (own MNO) so its PRP claim is independent of the other case's.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "stranded-batch reconcile (rm11-spec D1-D9, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropModuleSchemas(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await seedEventCatalog(db);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    // One Sample-5G graph + its pipeline per case, keyed by `tag`.
    async function graph(tag: string): Promise<RatingPipeline> {
      const mno = `MNO-RM11-${tag.toUpperCase()}`;
      const productName = `Sample 5G Services rm11 ${tag}`;
      await seedSample5gRatingGraph(db, {
        tag: `rm11-${tag}`,
        mno,
        productName,
        priceName: `Sample 5G Usage Rate rm11 ${tag}`,
        cardName: `RATECARD_RM11_${tag.toUpperCase()}`,
      });
      return createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: ENGINE_VERSION,
        mno,
        productName,
        now: NOW,
        tmpPrefix: `rm11-${tag}-`,
      });
    }

    function runPrp(
      pipeline: RatingPipeline,
      sourcePath: string,
      execId: string,
    ): Record<string, unknown> {
      return readManifest(pipeline.runPrp(sourcePath, execId));
    }

    // The reconcile module under the pipeline's env (its logs land in
    // pipeline.dirs.logs).
    function runReconcile(
      pipeline: RatingPipeline,
      thresholdSeconds: number,
      execId: string,
    ): string {
      return pipeline.runModule("runtime.stranded_reconcile", [
        "--threshold-seconds",
        String(thresholdSeconds),
        "--workflow-execution-id",
        execId,
      ]);
    }

    function logLines(
      pipeline: RatingPipeline,
      execId: string,
    ): Record<string, unknown>[] {
      return readFileSync(
        join(pipeline.dirs.logs, `SCHEDULER-${execId}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
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
      const pipeline = await graph("strand");
      const udrPath = pipeline.writeUdr(
        "rating-input-file-202606010000.udr",
        [10, 20, 30],
        "2026-06-01T08:00:00",
      );

      // A real claim (run 1) — PROCESSING with a fresh started_at.
      const manifest = runPrp(pipeline, udrPath, "rm11-exec-1");
      const batchId = manifest.batch_id as string;
      const fileKey = manifest.file_key as string;
      expect(fileKey).toBe("rating-input-file-202606010000");

      let row = await batchRow(batchId);
      expect(row?.status).toBe("PROCESSING"); // item 1 — stranded shape

      // Simulate the killed worker: back-date started_at past the threshold.
      // The raw file is untouched in landing/ — RL never ran, so it was never
      // archived (item 1's "zero rows in udr_rated" holds too: nothing here
      // ever reached RL).
      expect(existsSync(udrPath)).toBe(true);
      await sql`UPDATE rating.udr_batch SET started_at = now() - interval '2 hours' WHERE batch_id = ${batchId}`;

      // A batch still within the threshold is untouched (item 4) — proven
      // together with the resolve below via a short threshold that only the
      // back-dated row exceeds.
      const out1 = runReconcile(pipeline, 3600, "rm11-exec-reconcile-1");
      expect(out1).toMatch(/1 batch\(es\) resolved/);

      row = await batchRow(batchId);
      expect(row?.status).toBe("FAILED"); // item 2 — resolved, claim released
      expect(row?.error_summary).toMatch(/BATCH_STRANDED/);

      const lines = logLines(pipeline, "rm11-exec-reconcile-1");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.event_code).toBe("BATCH_STRANDED");
      expect(lines[0]!.component).toBe("SCHEDULER");
      // The run-independent DELIVERY alarm_key — identical to the key RL stamps
      // on BATCH_COMPLETE (`{udr_type}:{file_key}`), so the reprocessed run's
      // BATCH_COMPLETE auto-clears this MAJOR alarm (rm11 verification item 6).
      // NOT the run-scoped `BATCH_STRANDED:<file_key>:<run>` form, which a later
      // run's clearer could never match.
      expect(lines[0]!.alarm_key).toBe(`RAN_USAGE:${fileKey}`);
      expect(lines[0]!.batch_id).toBe(batchId);

      // Idempotent (item 5): running it again finds nothing to resolve.
      const out2 = runReconcile(pipeline, 3600, "rm11-exec-reconcile-2");
      expect(out2).toMatch(/0 batch\(es\) resolved/);
      row = await batchRow(batchId);
      expect(row?.status).toBe("FAILED"); // unchanged, not re-touched

      // A corrected reissue (new content, `_v2` — same file_key, matching the
      // rm10 reissue convention) claims batch_run_num = 2 cleanly. This is
      // independent of run 1's PROCESSING/FAILED state either way (the claim
      // insert's COALESCE(max(batch_run_num),0)+1 does not gate on status) —
      // what rm11 actually changed is that run 1 now reads as a DECIDED
      // terminal outcome instead of an indefinitely-open one.
      const udrPath2 = pipeline.writeUdr(
        "rating-input-file-202606010000_v2.udr",
        [11, 21, 31],
        "2026-06-01T08:00:00",
      );
      const manifest2 = runPrp(pipeline, udrPath2, "rm11-exec-3");
      expect(manifest2.file_key).toBe(fileKey);
      expect(manifest2.status).toBe("PROCESSING");
      const row2 = await batchRow(manifest2.batch_id as string);
      expect(row2?.batch_run_num).toBe(2);
    }, 120_000);

    it("4. a genuinely-running batch within the threshold is untouched", async () => {
      const pipeline = await graph("fresh");
      const udrPath = pipeline.writeUdr(
        "rating-input-file-202606020000.udr",
        [10, 20, 30],
        "2026-06-02T08:00:00",
      );
      const manifest = runPrp(pipeline, udrPath, "rm11-exec-fresh");
      const batchId = manifest.batch_id as string;

      // started_at is fresh (just claimed) — well within a 3600s threshold.
      const out = runReconcile(pipeline, 3600, "rm11-exec-reconcile-fresh");
      expect(out).toMatch(/0 batch\(es\) resolved/);

      const row = await batchRow(batchId);
      expect(row?.status).toBe("PROCESSING");
    }, 120_000);

    it("1 (RECEIVED variant). resolves a batch stranded at RECEIVED (worker killed before parse finished), aged from received_at", async () => {
      // PRP commits the claim as RECEIVED *before* it parses (prp.claim_batch),
      // then stamps PROCESSING + started_at with the parse counts. A worker
      // killed mid-parse therefore strands the row at RECEIVED with started_at
      // still NULL — the reconcile must reap it too (else its UNIQUE (file_key,
      // batch_run_num) claim blocks the file forever, D1), aged from the
      // NOT-NULL received_at via COALESCE(started_at, received_at). This class
      // was previously never matched by the PROCESSING-only find query.
      const pipeline = await graph("received");
      const [inserted] = await sql<{ batch_id: string; file_key: string }[]>`
        INSERT INTO rating.udr_batch
          (file_key, source_file, file_key_rule, udr_type, status, received_at)
        VALUES
          ('rating-input-file-202606030000', 'rating-input-file-202606030000.udr',
           ${RAN_USAGE_FILE_KEY_RULE}, 'RAN_USAGE', 'RECEIVED',
           now() - interval '2 hours')
        RETURNING batch_id, file_key
      `;
      const batchId = inserted!.batch_id;

      const out = runReconcile(pipeline, 3600, "rm11-exec-received");
      expect(out).toMatch(/1 batch\(es\) resolved/);

      const row = await batchRow(batchId);
      expect(row?.status).toBe("FAILED"); // reaped — claim released
      expect(row?.error_summary).toMatch(/BATCH_STRANDED/);

      const lines = logLines(pipeline, "rm11-exec-received");
      expect(lines).toHaveLength(1);
      expect(lines[0]!.event_code).toBe("BATCH_STRANDED");
      expect(lines[0]!.alarm_key).toBe(`RAN_USAGE:${inserted!.file_key}`);
    }, 120_000);

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
