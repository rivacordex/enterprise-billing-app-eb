import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { seedEventCatalog } from "@/db/seeds/rating-event-catalog.data";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { udrBatch } from "@/db/schema/rating/udr-batch";
import {
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  RATING_WORKER_DIR,
  ratingPython3,
  readManifest,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
  type UdrRow,
} from "@/tests/helpers/rating-ran-harness";
import {
  SAMPLE_5G_LKP_ROWS,
  type RanLkpRow,
} from "@/db/seeds/sample/sample-5g-fixture";

// rm10-spec §Verification checklist + code-standards §10 tests OWNED by rm10:
//   #4  Live-row uniqueness (the skipped-supersede half) — a live row the
//       supersede predicate cannot reach still aborts the COPY on the
//       unique constraint (Inv #3 backstop), rather than double-loading.
//   #7  Supersession scope — keyed on file_key, never source_file.
//   #10 Reconciliation (the SHRINKING_REISSUE half) — a reissue smaller than
//       its predecessor raises SHRINKING_REISSUE at MAJOR rather than
//       silently losing the missing records.
// Plus: cross-period supersede detection (CROSS_PERIOD_SUPERSEDE, WARNING),
// batch-level lineage across four consecutive reprocessings of one record,
// status-only update + no superseded_by_udr_id on udr_rated, and superseded
// rows remaining in udr_rated with is_live NULL.
//
// The static describe (no DATABASE_URL) checks rl.py's supersede predicate
// text (file_key, not source_file; status-only; the two event codes) without
// a live engine. The DB-gated describe shells out to the REAL
// `python3 -m runtime.prp` -> runtime.rp -> runtime.rl through the shared
// `rating-ran-harness` (the production rm21 7-column `.udr` profile, the
// `rating-input-file-YYYYMMDDHHMI[_vN].udr` file-key rule, a Sample-5G graph
// with its ratecard — PER_UNIT rating), run multiple times per scenario to
// exercise real reissues — a black-box test of the actual loader, not a TS
// reimplementation. Each case seeds its own graph (own MNO), so its raw
// udr_keys never collide with another case's live rows. Requires the harness's
// absolute python3 (`RATING_PYTHON3` or the fixed system path) with the
// worker's requirements (psycopg + polars); skipped loudly, like the
// DATABASE_URL gate, when unavailable — same posture as the rm06-rm09 suites.
const databaseUrl = process.env.DATABASE_URL;
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm10-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm10-test-engine@sha256:deadbeef";
const NOW = "2026-08-20T00:00:00Z";
// A one-cell ratecard: each record of a scenario is the same raw udr_key, so
// a reissue supersedes exactly the rows its predecessor loaded.
const ONE_CELL: readonly RanLkpRow[] = [SAMPLE_5G_LKP_ROWS[0]!];
const TWO_CELLS: readonly RanLkpRow[] = SAMPLE_5G_LKP_ROWS.slice(0, 2);

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm10-spec D1-D4.
// ---------------------------------------------------------------------
describe("rl supersede predicate (rm10-spec D1-D4 — static)", () => {
  const rlSource = readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "worker",
      "workflow-engine",
      "runtime",
      "rl.py",
    ),
    "utf8",
  );

  it("keys the supersede predicate on file_key, never source_file (D1/Inv #5, test #7)", () => {
    expect(rlSource).toMatch(/def supersede_batch/);
    expect(rlSource).toMatch(
      /WHERE file_key = %\(file_key\)s AND batch_run_num < %\(batch_run_num\)s/,
    );
    // The supersede UPDATE never filters on source_file — only udr_batch's
    // file_key join decides which rows are retired.
    const updateBlock = rlSource.slice(
      rlSource.indexOf("_SUPERSEDE_SQL"),
      rlSource.indexOf("_SUPERSEDE_SQL") + 400,
    );
    expect(updateBlock).not.toMatch(/source_file/);
  });

  it("the supersede UPDATE touches only status; there is no superseded_by_udr_id (D1)", () => {
    expect(rlSource).toMatch(/SET status = 'SUPERSEDED'/);
    expect(rlSource).not.toMatch(/superseded_by_udr_id/);
    // Lineage is stamped on udr_batch, never on udr_rated.
    expect(rlSource).toMatch(/UPDATE rating\.udr_batch/);
    expect(rlSource).toMatch(/superseded_by_batch_id = %\(batch_id\)s/);
    expect(rlSource).toMatch(/supersede_reason = %\(reason\)s/);
  });

  it("emits CROSS_PERIOD_SUPERSEDE (WARNING) and SHRINKING_REISSUE (MAJOR)", () => {
    expect(rlSource).toMatch(/event_code="CROSS_PERIOD_SUPERSEDE"/);
    expect(rlSource).toMatch(/event_code="SHRINKING_REISSUE"/);
  });

  it("supersede runs inside RL's one load transaction, before the COPY", () => {
    const fn = rlSource.slice(
      rlSource.indexOf("def load_and_reconcile"),
      rlSource.indexOf("def _iso"),
    );
    const supersedeIdx = fn.indexOf("supersede_batch(");
    const copyIdx = fn.indexOf("copy_chunks(");
    expect(supersedeIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeGreaterThan(supersedeIdx);
  });
});

// ---------------------------------------------------------------------
// Black-box supersession + reprocessing — live DB + the real prp/rp/rl.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "rl supersession and reprocessing (rm10-spec D1-D9, requires DATABASE_URL and python3+runtime)",
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

    // One Sample-5G graph (own MNO, own card over `cells`) + its pipeline per
    // case, keyed by `tag`.
    async function graph(
      tag: string,
      cells: readonly RanLkpRow[] = ONE_CELL,
      coverageEnforcement: "HARD_STOP" | "WARN" = "HARD_STOP",
    ): Promise<RatingPipeline> {
      const mno = `MNO-RM10-${tag.toUpperCase()}`;
      const productName = `Sample 5G Services rm10 ${tag}`;
      await seedSample5gRatingGraph(db, {
        tag: `rm10-${tag}`,
        mno,
        productName,
        priceName: `Sample 5G Usage Rate rm10 ${tag}`,
        cardName: `RATECARD_RM10_${tag.toUpperCase()}`,
        cells,
      });
      return createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: ENGINE_VERSION,
        mno,
        productName,
        now: NOW,
        tmpPrefix: `rm10-${tag}-`,
        cells,
        coverageEnforcement,
      });
    }

    // Runs RL expecting a non-zero exit (a refusal / an aborted transaction),
    // returning the captured stderr for diagnosis.
    function runRlExpectFail(
      p: RatingPipeline,
      manifestUri: string,
      execId: string,
    ): string {
      try {
        p.runRl(manifestUri, execId);
        throw new Error("expected RL to exit non-zero, but it succeeded");
      } catch (e) {
        const err = e as { status?: number; stderr?: string; message?: string };
        if (err.status === undefined) throw e; // a real assertion failure above
        return err.stderr ?? "";
      }
    }

    function readParquetRows(fileUri: string): Record<string, string | null>[] {
      const out = execFileSync(
        ratingPython3(),
        [
          "-c",
          "import sys, json, polars as pl\n" +
            "df = pl.read_parquet(sys.argv[1])\n" +
            "print(json.dumps([{k:(str(v) if v is not None else None) for k,v in r.items()} for r in df.iter_rows(named=True)]))",
          fileURLToPath(fileUri),
        ],
        { cwd: RATING_WORKER_DIR, encoding: "utf8" },
      );
      return JSON.parse(out);
    }

    function logLinesFor(
      p: RatingPipeline,
      component: string,
      execId: string,
    ): Record<string, unknown>[] {
      const path = join(p.dirs.logs, `${component}-${execId}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    }
    async function batchRow(batchId: string) {
      const rows = await db
        .select()
        .from(udrBatch)
        .where(eq(udrBatch.batchId, batchId));
      return rows[0]!;
    }
    async function batchesForFileKey(fileKey: string) {
      return db.select().from(udrBatch).where(eq(udrBatch.fileKey, fileKey));
    }
    async function liveRowsForKey(udrKey: string) {
      return db
        .select()
        .from(udrRated)
        .where(and(eq(udrRated.udrKey, udrKey), eq(udrRated.status, "RATED")));
    }
    async function allRowsForKey(udrKey: string) {
      return db.select().from(udrRated).where(eq(udrRated.udrKey, udrKey));
    }

    // One `.udr` row per (cell, volume) on the pipeline's MNO, at `datetime`
    // (naive config-TZ instant, Asia/Kuala_Lumpur).
    const rowsAt = (
      datetime: string,
      cellVolumes: readonly [RanLkpRow, number][],
    ): UdrRow[] =>
      cellVolumes.map(([cell, volume]) => ({ cell, datetime, volume }));

    // prp -> rp for one `.udr`, returning the rl manifest URI + parsed rows.
    function prepRated(
      p: RatingPipeline,
      fileName: string,
      execSuffix: string,
      rows: readonly UdrRow[],
    ): {
      rpManifestUri: string;
      manifest: Record<string, unknown>;
      rated: Record<string, string | null>[];
    } {
      const path = p.writeUdrRows(fileName, rows);
      const prpUri = p.runPrp(path, `prp-${execSuffix}`);
      const rpUri = p.runRp(prpUri, `rp-${execSuffix}`);
      const manifest = readManifest(rpUri);
      const rated = (manifest.rated_chunk_uris as string[]).flatMap((u) =>
        readParquetRows(u),
      );
      return { rpManifestUri: rpUri, manifest, rated };
    }

    // Loads one file end-to-end (prp -> rp -> rl) and returns the batch id +
    // the manifest + the parsed rated rows (for reading udr_key back).
    function loadFile(
      p: RatingPipeline,
      fileName: string,
      execSuffix: string,
      rows: readonly UdrRow[],
    ): {
      batchId: string;
      manifest: Record<string, unknown>;
      rated: Record<string, string | null>[];
    } {
      const { rpManifestUri, manifest, rated } = prepRated(
        p,
        fileName,
        execSuffix,
        rows,
      );
      p.runRl(rpManifestUri, `rl-${execSuffix}`);
      return { batchId: manifest.batch_id as string, manifest, rated };
    }

    const cell0 = SAMPLE_5G_LKP_ROWS[0]!;
    const cell1 = SAMPLE_5G_LKP_ROWS[1]!;

    // -----------------------------------------------------------------
    // #7 — supersession scopes by file_key, never source_file.
    // -----------------------------------------------------------------
    it("7. a reissue under a NEW filename (same file_key) supersedes the prior run, leaving one live row", async () => {
      const p = await graph("scope");
      const run1 = loadFile(
        p,
        "rating-input-file-202603140000.udr",
        "scope-1",
        rowsAt("2026-03-14T18:00:00", [[cell0, 100]]),
      );
      const run2 = loadFile(
        p,
        "rating-input-file-202603140000_v2.udr",
        "scope-2",
        rowsAt("2026-03-14T18:00:00", [[cell0, 120]]),
      );
      const udrKey = run1.rated[0]!.udr_key as string;

      expect(run1.manifest.file_key).toBe("rating-input-file-202603140000");
      expect(run2.manifest.file_key).toBe("rating-input-file-202603140000");
      expect((await batchRow(run1.batchId)).sourceFile).toBe(
        "rating-input-file-202603140000.udr",
      );
      expect((await batchRow(run2.batchId)).sourceFile).toBe(
        "rating-input-file-202603140000_v2.udr",
      );

      const live = await liveRowsForKey(udrKey);
      expect(live).toHaveLength(1);
      expect(live[0]!.udrRefBatchId).toBe(run2.batchId);

      const all = await allRowsForKey(udrKey);
      expect(all).toHaveLength(2);
      const retired = all.find((r) => r.udrRefBatchId === run1.batchId)!;
      expect(retired.status).toBe("SUPERSEDED");
      // #9 — superseded rows remain in udr_rated with is_live NULL, not deleted.
      expect(retired.isLive).toBeNull();

      const run1Batch = await batchRow(run1.batchId);
      expect(run1Batch.supersededByBatchId).toBe(run2.batchId);
      expect(run1Batch.supersedeReason).toBeTruthy();
      const run2Batch = await batchRow(run2.batchId);
      expect(run2Batch.supersededCount).toBe(1);
    }, 120000);

    // -----------------------------------------------------------------
    // #4 — the proof: a live row the supersede predicate cannot reach still
    // aborts the COPY on the unique constraint (Inv #3 backstop).
    // -----------------------------------------------------------------
    it("4. a live row outside the file_key chain still aborts the COPY on the unique constraint", async () => {
      const p = await graph("proof");
      const { rpManifestUri, manifest, rated } = prepRated(
        p,
        "rating-input-file-202603150000.udr",
        "proof-1",
        rowsAt("2026-03-15T18:00:00", [[cell0, 50]]),
      );
      const batchId = manifest.batch_id as string;
      const incoming = rated[0]!;

      // Pre-insert a live row with the SAME natural key, but NOT reachable by
      // rm10's supersede predicate — its udr_ref_batch_id is a sentinel that
      // is not a udr_batch row for this file_key, simulating "supersession
      // never ran / cannot see it". If supersede were the only guarantee,
      // this would double-load; Inv #3's unique constraint must abort it.
      await db.insert(udrRated).values({
        partitionPeriod: "2026-03-01",
        udrType: incoming.udr_type as string,
        startDatetime: new Date(incoming.start_datetime as string),
        endDatetime: new Date(incoming.end_datetime as string),
        status: "RATED",
        udrSubscriptionRefId: incoming.udr_subscription_ref_id as string,
        udrKey: incoming.udr_key as string,
        udrUsageQuantity: incoming.udr_usage_quantity as string,
        udrUsageUnit: incoming.udr_usage_unit as string,
        udrRateType: "PER_UNIT",
        udrRatedPrice: incoming.udr_rated_price as string,
        udrRatedPriceRaw: incoming.udr_rated_price_raw as string,
        udrRoundingMode: incoming.udr_rounding_mode as string,
        udrCurrency: incoming.udr_currency as string,
        udrRefBatchId: "SENTINEL-NOTCHAIN",
        udrSourceFile: "unrelated.udr",
        ratingEngineVersion: ENGINE_VERSION,
        ratingFlowRevision: 1,
        udrResource: incoming.udr_resource ?? null,
      });

      runRlExpectFail(p, rpManifestUri, "rl-proof");

      // The transaction aborted — nothing from THIS batch was written, and
      // the batch never reached a terminal status (stranded at PROCESSING
      // for rm11, matching rm09's documented UniqueViolation posture).
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("PROCESSING");
      expect(batch.ratedCount).toBeNull();
      const all = await allRowsForKey(incoming.udr_key as string);
      // Only the pre-inserted sentinel row exists — the incoming row never
      // committed, and the sentinel was never superseded (unreachable).
      expect(all).toHaveLength(1);
      expect(all[0]!.udrRefBatchId).toBe("SENTINEL-NOTCHAIN");
    }, 120000);

    // -----------------------------------------------------------------
    // Cross-period supersede (D2).
    // -----------------------------------------------------------------
    it("2. a corrected timestamp crossing a month boundary is still superseded, and emits CROSS_PERIOD_SUPERSEDE at WARNING", async () => {
      const p = await graph("xperiod");
      const run1 = loadFile(
        p,
        "rating-input-file-202604010000.udr",
        "xperiod-1",
        rowsAt("2026-04-15T18:00:00", [[cell0, 75]]),
      );
      // Same identity (mno_public_id/commercial_unit/polygon_id), corrected
      // datetime moving the record into MAY (a different monthly partition).
      const run2 = loadFile(
        p,
        "rating-input-file-202604010000_v2.udr",
        "xperiod-2",
        rowsAt("2026-05-02T18:00:00", [[cell0, 75]]),
      );
      const udrKey = run1.rated[0]!.udr_key as string;

      const all = await allRowsForKey(udrKey);
      expect(all).toHaveLength(2);
      const retired = all.find((r) => r.udrRefBatchId === run1.batchId)!;
      const live = all.find((r) => r.udrRefBatchId === run2.batchId)!;
      expect(retired.status).toBe("SUPERSEDED");
      expect(String(retired.partitionPeriod)).toMatch(/2026-04-01/);
      expect(live.status).toBe("RATED");
      expect(String(live.partitionPeriod)).toMatch(/2026-05-01/);

      const lines = logLinesFor(p, "RL", "rl-xperiod-2");
      const crossPeriod = lines.find(
        (l) => l.event_code === "CROSS_PERIOD_SUPERSEDE",
      );
      expect(crossPeriod).toBeDefined();
      expect(crossPeriod!.log_level).toBe("WARN");
    }, 120000);

    // -----------------------------------------------------------------
    // #10 — SHRINKING_REISSUE (D4).
    // -----------------------------------------------------------------
    it("10. a reissue smaller than its predecessor raises SHRINKING_REISSUE at MAJOR, not a silent loss", async () => {
      // A two-cell card under ratecard_coverage_enforcement = WARN (rm21 §5):
      // under the production HARD_STOP a reissue that drops a card cell is
      // refused RATECARD_COVERAGE_GAP before RL, so it never reaches
      // supersession; WARN rates it and flags the gap — the path on which a
      // shrinking reissue can actually retire a record.
      const p = await graph("shrink", TWO_CELLS, "WARN");
      const run1 = loadFile(
        p,
        "rating-input-file-202605010000.udr",
        "shrink-1",
        rowsAt("2026-05-14T18:00:00", [
          [cell0, 60],
          [cell1, 40],
        ]),
      );
      // The reissue carries only ONE of run1's two records — the other is
      // silently retired by D3's batch-level supersede unless SHRINKING_REISSUE
      // surfaces it.
      const run2 = loadFile(
        p,
        "rating-input-file-202605010000_v2.udr",
        "shrink-2",
        rowsAt("2026-05-14T18:00:00", [[cell0, 65]]),
      );
      expect(
        logLinesFor(p, "PRP", "prp-shrink-2").some(
          (l) => l.event_code === "RATECARD_COVERAGE_GAP_WARN",
        ),
      ).toBe(true);

      const run2Batch = await batchRow(run2.batchId);
      // Both of run1's rows were retired (batch-level, not record-matched).
      expect(run2Batch.supersededCount).toBe(2);

      const lines = logLinesFor(p, "RL", "rl-shrink-2");
      const shrinking = lines.find((l) => l.event_code === "SHRINKING_REISSUE");
      expect(shrinking).toBeDefined();
      const info = shrinking!.additional_info as Record<string, unknown>;
      expect(info.parsed_count).toBe(1);
      expect(info.prev_parsed_count).toBe(2);

      // The dropped record (cell 1) now has no live row anywhere.
      const droppedRow = run1.rated.find(
        (r) => r.udr_key !== run2.rated[0]!.udr_key,
      )!;
      const droppedLive = await liveRowsForKey(droppedRow.udr_key as string);
      expect(droppedLive).toHaveLength(0);
    }, 120000);

    // -----------------------------------------------------------------
    // #5 — four consecutive reprocessings: batch-level lineage chain.
    // -----------------------------------------------------------------
    it("5. four consecutive reprocessings leave four SUPERSEDED rows and one live row, each retired batch pointing at its replacement", async () => {
      const p = await graph("chain");
      const fileKey = "rating-input-file-202606010000";
      const at = "2026-06-10T18:00:00";
      const runs = [
        loadFile(p, `${fileKey}.udr`, "chain-1", rowsAt(at, [[cell0, 10]])),
        loadFile(p, `${fileKey}_v2.udr`, "chain-2", rowsAt(at, [[cell0, 20]])),
        loadFile(p, `${fileKey}_v3.udr`, "chain-3", rowsAt(at, [[cell0, 30]])),
        loadFile(p, `${fileKey}_v4.udr`, "chain-4", rowsAt(at, [[cell0, 40]])),
        loadFile(p, `${fileKey}_v5.udr`, "chain-5", rowsAt(at, [[cell0, 50]])),
      ];
      const udrKey = runs[0]!.rated[0]!.udr_key as string;

      const all = await allRowsForKey(udrKey);
      expect(all).toHaveLength(5);
      const superseded = all.filter((r) => r.status === "SUPERSEDED");
      const live = all.filter((r) => r.status === "RATED");
      expect(superseded).toHaveLength(4);
      expect(live).toHaveLength(1);
      expect(live[0]!.udrRefBatchId).toBe(runs[4]!.batchId);

      // Each retired batch points at the batch that replaced it — not all at
      // the final run — because each run's supersede predicate only ever
      // matches the row still live at that moment.
      for (let i = 0; i < 4; i++) {
        const retiredBatch = await batchRow(runs[i]!.batchId);
        expect(retiredBatch.supersededByBatchId).toBe(runs[i + 1]!.batchId);
      }
      const finalBatch = await batchRow(runs[4]!.batchId);
      expect(finalBatch.supersededByBatchId).toBeNull();

      const batches = await batchesForFileKey(fileKey);
      expect(batches).toHaveLength(5);
      expect(batches.map((b) => b.batchRunNum).sort()).toEqual([1, 2, 3, 4, 5]);
    }, 120000);
  },
);
