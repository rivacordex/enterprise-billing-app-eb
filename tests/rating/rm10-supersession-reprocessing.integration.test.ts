import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import { productOrder, productOrderItem } from "@/db/schema/ordering";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { udrBatch } from "@/db/schema/rating/udr-batch";

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
// `python3 -m runtime.prp` -> runtime.rp -> runtime.rl, run multiple times
// per scenario to exercise real reissues — a black-box test of the actual
// loader, not a TS reimplementation. Requires `python3` on PATH with the
// worker's requirements (psycopg + polars); skipped loudly, like the
// DATABASE_URL gate, when unavailable — same posture as the rm06-rm09 suites.
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

const ROLE_PW = "rm10-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm10-test-engine@sha256:deadbeef";

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
// Matches RAN_USAGE_<date>.csv and RAN_USAGE_<date>_v<N>.csv to the SAME
// file_key — a reissue under a new physical filename (rm10 D1/Inv #5, test #7).
const FILE_KEY_RULE = "^(?P<file_key>RAN_USAGE_\\d{8})(?:_v\\d+)?\\.csv$";
const NOW = "2026-08-20T00:00:00Z";
const CURRENCY = "MYR";

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
// Static structural checks — no DATABASE_URL, no engine. rm10-spec D1-D4.
// ---------------------------------------------------------------------
describe("rl supersede predicate (rm10-spec D1-D4 — static)", () => {
  const rlSource = readFileSync(
    join(process.cwd(), "rating-engine", "worker", "runtime", "rl.py"),
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
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let logsDir: string;
    let archiveDir: string;
    let workDir: string;
    let invA: string; // pinned to OFF1, MYR account

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

    async function seedProductGraph(): Promise<void> {
      const userId = crypto.randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "rm10-fixture-user",
        userEmail: "rm10-fixture@example.invalid",
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
      const [org] = await db
        .insert(organization)
        .values({
          name: "rm10-fixture-org",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: userId,
        })
        .returning({ organizationId: organization.organizationId });
      const [pr] = await db
        .insert(partyRole)
        .values({ engagedParty: org!.organizationId, lastModifiedBy: userId })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const partyRoleId = pr!.partyRoleId;
      const [bc] = await db
        .insert(billCycle)
        .values({ name: "rm10-fixture-cycle", lastEditedBy: userId })
        .returning({ billCycleId: billCycle.billCycleId });
      const billCycleId = bc!.billCycleId;

      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "rm10-fa-MYR",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: userId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "rm10-ban-MYR",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: billCycleId,
          lastEditedBy: userId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      const myrAccount = ban!.billingAccountId;

      const [off1] = await db
        .insert(productOffering)
        .values({
          name: "rm10-OFF1",
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "ACTIVE",
          lastEditedBy: userId,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const off1Id = off1!.productOfferingId;
      await db.insert(productOfferingPrice).values({
        productOfferingId: off1Id,
        name: "OFF1 usage",
        priceType: "usage",
        pricingModel: "flat",
        amount: "0.0050",
        currency: CURRENCY,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      });

      const [order] = await db
        .insert(productOrder)
        .values({
          customerPartyRoleId: partyRoleId,
          billingAccountId: myrAccount,
          status: "COMPLETED",
          submittedBy: userId,
          submittedAt: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({ productOrderId: productOrder.productOrderId });
      const [item] = await db
        .insert(productOrderItem)
        .values({
          productOrderId: order!.productOrderId,
          productOfferingId: off1Id,
          quantity: 1,
          startDate: "2026-01-01",
        })
        .returning({ productOrderItemId: productOrderItem.productOrderItemId });
      const [inv] = await db
        .insert(productInventory)
        .values({
          productOrderItemId: item!.productOrderItemId,
          customerPartyRoleId: partyRoleId,
          billingAccountId: myrAccount,
          productOfferingId: off1Id,
          quantity: 1,
          status: "ACTIVE",
          startDate: "2026-01-01",
        })
        .returning({ productInventoryId: productInventory.productInventoryId });
      invA = inv!.productInventoryId;
    }

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
      await seedProductGraph();

      const url = new URL(databaseUrl as string);
      dbParams = {
        host: url.hostname,
        port: url.port || "5432",
        name: url.pathname.replace(/^\//, ""),
      };

      const root = mkdtempSync(join(tmpdir(), "rm10-rl-"));
      landingDir = join(root, "landing");
      logsDir = join(root, "logs");
      archiveDir = join(root, "archive");
      workDir = join(root, "work");
      for (const d of [landingDir, logsDir, archiveDir, workDir]) {
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
      RATING_ARCHIVE_DIR: archiveDir,
      RATING_ENGINE_VERSION: ENGINE_VERSION,
    });

    function runPrp(sourcePath: string, execId: string): string {
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
      return out.trim().split("\n").pop() as string;
    }

    function runRp(manifestUri: string, execId: string): string {
      const out = execFileSync(
        "python3",
        [
          "-m",
          "runtime.rp",
          "--manifest",
          manifestUri,
          "--udr-type",
          "RAN_USAGE",
          "--rounding-mode",
          "HALF_UP",
          "--subscriber-ref-column",
          "PUBLIC_KEY",
          "--workflow-execution-id",
          execId,
          "--flow-revision",
          "42",
          "--work-dir",
          workDir,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
      return out.trim().split("\n").pop() as string;
    }

    function runRl(manifestUri: string, execId: string): string {
      const out = execFileSync(
        "python3",
        [
          "-m",
          "runtime.rl",
          "--manifest",
          manifestUri,
          "--udr-type",
          "RAN_USAGE",
          "--landing-dir",
          landingDir,
          "--workflow-execution-id",
          execId,
          "--flow-revision",
          "42",
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
      return out.trim().split("\n").pop() as string;
    }

    // Runs RL expecting a non-zero exit (a refusal / an aborted transaction),
    // returning the captured stderr for diagnosis.
    function runRlExpectFail(manifestUri: string, execId: string): string {
      try {
        runRl(manifestUri, execId);
        throw new Error("expected RL to exit non-zero, but it succeeded");
      } catch (e) {
        const err = e as { status?: number; stderr?: string; message?: string };
        if (err.status === undefined) throw e; // a real assertion failure above
        return err.stderr ?? "";
      }
    }

    function uriToPath(uri: string): string {
      return decodeURIComponent(uri.replace(/^file:\/\//, ""));
    }
    function readManifest(uri: string): Record<string, unknown> {
      return JSON.parse(readFileSync(uriToPath(uri), "utf8"));
    }
    function readParquetRows(fileUri: string): Record<string, string | null>[] {
      const path = uriToPath(fileUri);
      const out = execFileSync(
        "python3",
        [
          "-c",
          "import sys, json, polars as pl\n" +
            "df = pl.read_parquet(sys.argv[1])\n" +
            "print(json.dumps([{k:(str(v) if v is not None else None) for k,v in r.items()} for r in df.iter_rows(named=True)]))",
          path,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
      return JSON.parse(out);
    }

    function writeCsv(name: string, rows: string[]): string {
      const header = "DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS";
      const path = join(landingDir, name);
      writeFileSync(path, [header, ...rows].join("\n") + "\n", "utf8");
      return path;
    }
    function logLinesFor(
      component: string,
      execId: string,
    ): Record<string, unknown>[] {
      const path = join(logsDir, `${component}-${execId}.jsonl`);
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

    // prp -> rp for one CSV, returning the rl manifest URI + parsed rows.
    function prepRated(
      fileName: string,
      execSuffix: string,
      rows: string[],
    ): {
      rpManifestUri: string;
      manifest: Record<string, unknown>;
      rated: Record<string, string | null>[];
    } {
      const path = writeCsv(fileName, rows);
      const prpUri = runPrp(path, `prp-${execSuffix}`);
      const rpUri = runRp(prpUri, `rp-${execSuffix}`);
      const manifest = readManifest(rpUri);
      const rated = (manifest.rated_chunk_uris as string[]).flatMap((u) =>
        readParquetRows(u),
      );
      return { rpManifestUri: rpUri, manifest, rated };
    }

    // Loads one file end-to-end (prp -> rp -> rl) and returns the batch id +
    // the manifest + the parsed rated rows (for reading udr_key back).
    function loadFile(
      fileName: string,
      execSuffix: string,
      rows: string[],
    ): {
      batchId: string;
      manifest: Record<string, unknown>;
      rated: Record<string, string | null>[];
    } {
      const { rpManifestUri, manifest, rated } = prepRated(
        fileName,
        execSuffix,
        rows,
      );
      runRl(rpManifestUri, `rl-${execSuffix}`);
      return { batchId: manifest.batch_id as string, manifest, rated };
    }

    // -----------------------------------------------------------------
    // #7 — supersession scopes by file_key, never source_file.
    // -----------------------------------------------------------------
    it("7. a reissue under a NEW filename (same file_key) supersedes the prior run, leaving one live row", async () => {
      const run1 = loadFile("RAN_USAGE_20260301.csv", "scope-1", [
        `2026-03-14T10:00:00Z,${invA},CU,scope,100`,
      ]);
      const run2 = loadFile("RAN_USAGE_20260301_v2.csv", "scope-2", [
        `2026-03-14T10:00:00Z,${invA},CU,scope,120`,
      ]);
      const udrKey = run1.rated[0]!.udr_key as string;

      expect(run1.manifest.file_key).toBe("RAN_USAGE_20260301");
      expect(run2.manifest.file_key).toBe("RAN_USAGE_20260301");
      expect((await batchRow(run1.batchId)).sourceFile).toBe(
        "RAN_USAGE_20260301.csv",
      );
      expect((await batchRow(run2.batchId)).sourceFile).toBe(
        "RAN_USAGE_20260301_v2.csv",
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
    });

    // -----------------------------------------------------------------
    // #4 — the proof: a live row the supersede predicate cannot reach still
    // aborts the COPY on the unique constraint (Inv #3 backstop).
    // -----------------------------------------------------------------
    it("4. a live row outside the file_key chain still aborts the COPY on the unique constraint", async () => {
      const { rpManifestUri, manifest, rated } = prepRated(
        "RAN_USAGE_20260302.csv",
        "proof-1",
        ["2026-03-15T10:00:00Z,".concat(invA, ",CU,proof,50")],
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
        udrSubscriberRefId: incoming.udr_subscriber_ref_id as string,
        udrKey: incoming.udr_key as string,
        udrUsageQuantity: incoming.udr_usage_quantity as string,
        udrUsageUnit: incoming.udr_usage_unit as string,
        udrRateType: "FLAT",
        udrRatedPrice: incoming.udr_rated_price as string,
        udrRatedPriceRaw: incoming.udr_rated_price_raw as string,
        udrRoundingMode: incoming.udr_rounding_mode as string,
        udrCurrency: incoming.udr_currency as string,
        udrRefBatchId: "SENTINEL-NOTCHAIN",
        udrSourceFile: "unrelated.csv",
        ratingEngineVersion: ENGINE_VERSION,
        ratingFlowRevision: 1,
      });

      runRlExpectFail(rpManifestUri, "rl-proof");

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
    });

    // -----------------------------------------------------------------
    // Cross-period supersede (D2).
    // -----------------------------------------------------------------
    it("2. a corrected timestamp crossing a month boundary is still superseded, and emits CROSS_PERIOD_SUPERSEDE at WARNING", async () => {
      const run1 = loadFile("RAN_USAGE_20260401.csv", "xperiod-1", [
        "2026-04-15T10:00:00Z,".concat(invA, ",CU,xperiod,75"),
      ]);
      // Same identity (PUBLIC_KEY/COMMERCIAL_UNIT/SITE), corrected DATETIME
      // moving the record into MAY (a different monthly partition).
      const run2 = loadFile("RAN_USAGE_20260401_v2.csv", "xperiod-2", [
        "2026-05-02T10:00:00Z,".concat(invA, ",CU,xperiod,75"),
      ]);
      const udrKey = run1.rated[0]!.udr_key as string;

      const all = await allRowsForKey(udrKey);
      expect(all).toHaveLength(2);
      const retired = all.find((r) => r.udrRefBatchId === run1.batchId)!;
      const live = all.find((r) => r.udrRefBatchId === run2.batchId)!;
      expect(retired.status).toBe("SUPERSEDED");
      expect(String(retired.partitionPeriod)).toMatch(/2026-04-01/);
      expect(live.status).toBe("RATED");
      expect(String(live.partitionPeriod)).toMatch(/2026-05-01/);

      const lines = logLinesFor("RL", "rl-xperiod-2");
      const crossPeriod = lines.find(
        (l) => l.event_code === "CROSS_PERIOD_SUPERSEDE",
      );
      expect(crossPeriod).toBeDefined();
      expect(crossPeriod!.log_level).toBe("WARN");
    });

    // -----------------------------------------------------------------
    // #10 — SHRINKING_REISSUE (D4).
    // -----------------------------------------------------------------
    it("10. a reissue smaller than its predecessor raises SHRINKING_REISSUE at MAJOR, not a silent loss", async () => {
      const run1 = loadFile("RAN_USAGE_20260501.csv", "shrink-1", [
        "2026-05-14T10:00:00Z,".concat(invA, ",CU,shrink-keep,60"),
        "2026-05-14T11:00:00Z,".concat(invA, ",CU,shrink-drop,40"),
      ]);
      // The reissue carries only ONE of run1's two records — the other is
      // silently retired by D3's batch-level supersede unless SHRINKING_REISSUE
      // surfaces it.
      const run2 = loadFile("RAN_USAGE_20260501_v2.csv", "shrink-2", [
        "2026-05-14T10:00:00Z,".concat(invA, ",CU,shrink-keep,65"),
      ]);

      const run2Batch = await batchRow(run2.batchId);
      // Both of run1's rows were retired (batch-level, not record-matched).
      expect(run2Batch.supersededCount).toBe(2);

      const lines = logLinesFor("RL", "rl-shrink-2");
      const shrinking = lines.find((l) => l.event_code === "SHRINKING_REISSUE");
      expect(shrinking).toBeDefined();
      const info = shrinking!.additional_info as Record<string, unknown>;
      expect(info.parsed_count).toBe(1);
      expect(info.prev_parsed_count).toBe(2);

      // The dropped record ("shrink-drop") now has no live row anywhere.
      const droppedRow = run1.rated.find(
        (r) => r.udr_key !== run2.rated[0]!.udr_key,
      )!;
      const droppedLive = await liveRowsForKey(droppedRow.udr_key as string);
      expect(droppedLive).toHaveLength(0);
    });

    // -----------------------------------------------------------------
    // #5 — four consecutive reprocessings: batch-level lineage chain.
    // -----------------------------------------------------------------
    it("5. four consecutive reprocessings leave four SUPERSEDED rows and one live row, each retired batch pointing at its replacement", async () => {
      const fileKey = "RAN_USAGE_20260601";
      const runs = [
        loadFile(`${fileKey}.csv`, "chain-1", [
          "2026-06-10T10:00:00Z,".concat(invA, ",CU,chain,10"),
        ]),
        loadFile(`${fileKey}_v2.csv`, "chain-2", [
          "2026-06-10T10:00:00Z,".concat(invA, ",CU,chain,20"),
        ]),
        loadFile(`${fileKey}_v3.csv`, "chain-3", [
          "2026-06-10T10:00:00Z,".concat(invA, ",CU,chain,30"),
        ]),
        loadFile(`${fileKey}_v4.csv`, "chain-4", [
          "2026-06-10T10:00:00Z,".concat(invA, ",CU,chain,40"),
        ]),
        loadFile(`${fileKey}_v5.csv`, "chain-5", [
          "2026-06-10T10:00:00Z,".concat(invA, ",CU,chain,50"),
        ]),
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
    });
  },
);
