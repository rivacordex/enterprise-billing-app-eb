import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import {
  insertRanOffering,
  insertRanCustomer,
  insertRanBillCycle,
  insertRanBillingAccount,
  insertRanSubscription,
  insertRanRatecard,
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_COMMERCIAL_UNIT,
  SAMPLE_5G_RATE_PER_UNIT,
} from "@/db/seeds/sample/sample-5g-fixture";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { udrBatch } from "@/db/schema/rating/udr-batch";

// rm22-spec §1 — the rm13 operator journey, REFRESHED to PER_UNIT (rm22 refreshes
// the journey + suite for PER_UNIT; it does NOT build a second test tree). The
// 3-row Sample-5G `.udr` sample lands -> PRP resolves + validates (all three
// identity locks + service_code + completeness pass on the seeded Sample-5G
// data) -> RP rates PER_UNIT -> RL loads at RATED -> udr_rated carries
// udr_rate_type="PER_UNIT", udr_rated_price_raw = ratePerUnit × usage_volume,
// udr_usage_unit="Mbps", udr_subscription_ref_id = the subscription -> re-drop
// the SAME filename -> rm10 supersedes the prior live rows, loads the new set.
// Proves the units (rm21 PRP / rm20 RP / rm09+rm10 RL) compose end to end, not
// just pass in isolation — R1 (FLAT→PER_UNIT) asserted here as ship-blocking.
//
// Requires DATABASE_URL + python3 with the worker runtime (psycopg + polars);
// shells the real runtime modules exactly as the flow's tasks do (no live Kestra
// engine). Skips loudly otherwise — same posture as every rm06+ DB-gated suite.
const databaseUrl = process.env.DATABASE_URL;
const workerDir = join(
  process.cwd(),
  "workflow-management",
  "worker",
  "workflow-engine",
);

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

const ROLE_PW = "rm22-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm22-test-engine@sha256:deadbeef";
const MNO = "MNO-E2E";
const PRODUCT_NAME = "Sample 5G Services e2e";
const CARD_NAME = "RATECARD_E2E";

// The 7-column `.udr` feed profile the flow ships for RAN_USAGE (rm21 §6) — kept
// identical here so the journey exercises the real production configuration.
const FEED_PROFILE = JSON.stringify({
  header: [
    "mno_public_id",
    "commercial_unit",
    "polygon_id",
    "datetime_YYYYMMDDHHMI",
    "usage_volume",
    "district_name",
    "service_code",
  ],
  event_time_column: "datetime_YYYYMMDDHHMI",
  event_time_assumed_tz: "Asia/Kuala_Lumpur",
  usage_column: "usage_volume",
  udr_key_columns: ["mno_public_id", "commercial_unit", "polygon_id"],
  mno_column: "mno_public_id",
  commercial_unit_column: "commercial_unit",
  polygon_column: "polygon_id",
  service_code_column: "service_code",
  subscriber_ref: null,
  interval_seconds: null,
  future_tolerance_seconds: 300,
});
const FILE_KEY_RULE =
  "^(?P<file_key>rating-input-file-\\d{12})(?:_v\\d+)?\\.udr$";
const UDR_HEADER =
  "mno_public_id,commercial_unit,polygon_id,datetime_YYYYMMDDHHMI,usage_volume,district_name,service_code";
const NOW = "2026-09-01T00:00:00Z";

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

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm22 — the PER_UNIT operator journey (rm22-spec §1, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let errorDir: string;
    let logsDir: string;
    let archiveDir: string;
    let workDir: string;
    let productInventoryId: string;

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

      // Seed the rateable Sample-5G graph via the SHARED fixture builders (the
      // same builders the production db:seed-sample-5g uses).
      const actorId = await getOrCreateAppUser(
        db,
        "rm22-e2e-actor",
        "rm22-e2e@example.invalid",
      );
      const { offeringId } = await insertRanOffering(db, {
        name: PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate e2e",
        udrTypeValue: "RAN_USAGE",
        cardName: CARD_NAME,
      });
      const partyRoleId = await insertRanCustomer(db, {
        organizationName: "rm22-e2e-org",
        registrationNumber: "_SAMPLE_-RM22-E2E",
        partyRoleSpecification: { mnoPublicKey1: MNO },
        actorId,
      });
      const billCycleId = await insertRanBillCycle(db, {
        name: "rm22-e2e-cycle",
        description: "rm22 e2e fixture bill cycle",
        actorId,
      });
      const billingAccountId = await insertRanBillingAccount(db, {
        financialAccountName: "rm22-e2e-fa",
        billingAccountName: "rm22-e2e-ban",
        partyRoleId,
        billCycleId,
        actorId,
      });
      productInventoryId = await insertRanSubscription(db, {
        partyRoleId,
        billingAccountId,
        offeringId,
        actorId,
        reason: "rm22 e2e fixture",
      });
      await insertRanRatecard(db, {
        cardName: CARD_NAME,
        mnoPublicKey: MNO,
        lkpSubscriberRefId: partyRoleId,
        rows: SAMPLE_5G_LKP_ROWS,
        actorId,
      });

      const url = new URL(databaseUrl as string);
      dbParams = {
        host: url.hostname,
        port: url.port || "5432",
        name: url.pathname.replace(/^\//, ""),
      };

      const root = mkdtempSync(join(tmpdir(), "rm22-journey-"));
      landingDir = join(root, "landing");
      errorDir = join(root, "error");
      logsDir = join(root, "logs");
      archiveDir = join(root, "archive");
      workDir = join(root, "work");
      for (const d of [landingDir, errorDir, logsDir, archiveDir, workDir]) {
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
      RATING_ERROR_DIR: errorDir,
      RATING_LOGS_DIR: logsDir,
      RATING_ARCHIVE_DIR: archiveDir,
      RATING_ENGINE_VERSION: ENGINE_VERSION,
    });

    // 3 clean rows, one per ratecard cell; `volumes[i]` is cell i's usage.
    function writeUdr(name: string, volumes: readonly number[]): string {
      const rows = SAMPLE_5G_LKP_ROWS.map((cell, i) =>
        [
          MNO,
          SAMPLE_5G_COMMERCIAL_UNIT,
          cell.polygonId,
          `2026-08-14T10:0${i}:00`,
          String(volumes[i]),
          cell.district ?? "",
          cell.serviceCode ?? "",
        ].join(","),
      );
      const path = join(landingDir, name);
      writeFileSync(path, [UDR_HEADER, ...rows].join("\n") + "\n", "utf8");
      return path;
    }

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
          "0",
          "--chunk-size",
          "10000",
          "--subscription-product-name",
          PRODUCT_NAME,
          "--ratecard-coverage-enforcement",
          "HARD_STOP",
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
          "product_inventory_id",
          "--workflow-execution-id",
          execId,
          "--flow-revision",
          "1",
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
          "1",
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      );
      return out.trim().split("\n").pop() as string;
    }

    function readManifest(uri: string): Record<string, unknown> {
      return JSON.parse(readFileSync(fileURLToPath(uri.trim()), "utf8"));
    }

    async function batchRow(batchId: string) {
      const rows = await db
        .select()
        .from(udrBatch)
        .where(eq(udrBatch.batchId, batchId));
      return rows[0]!;
    }
    async function ratedForBatch(batchId: string) {
      return db
        .select()
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, batchId));
    }
    async function liveRowsForKey(udrKey: string) {
      return db
        .select()
        .from(udrRated)
        .where(and(eq(udrRated.udrKey, udrKey), eq(udrRated.status, "RATED")));
    }

    it("file -> PRP -> RP (PER_UNIT) -> RL (RATED) -> reissue -> supersession", async () => {
      // -----------------------------------------------------------
      // 1. The 3-row Sample-5G file lands; PRP resolves + validates (all locks
      //    pass) and carries the 3 survivors at PROCESSING.
      // -----------------------------------------------------------
      const path = writeUdr(
        "rating-input-file-202608140001.udr",
        [100, 200, 300],
      );
      const prpUri = runPrp(path, "rm22-prp-1");
      const prpManifest = readManifest(prpUri);
      const batchId = prpManifest.batch_id as string;
      expect(prpManifest.status).toBe("PROCESSING");
      let batch = await batchRow(batchId);
      expect(batch.status).toBe("PROCESSING");
      expect(batch.parsedCount).toBe(3);
      expect(batch.rejectedCount).toBe(0);
      expect(batch.batchRunNum).toBe(1);

      // -----------------------------------------------------------
      // 2. RP rates PER_UNIT; RL loads at RATED and archives.
      // -----------------------------------------------------------
      const rpUri = runRp(prpUri, "rm22-rp-1");
      runRl(rpUri, "rm22-rl-1");
      batch = await batchRow(batchId);
      expect(batch.status).toBe("COMPLETE"); // all 3 parsed, all rated
      expect(batch.ratedCount).toBe(3);
      expect(batch.archiveFilePath).toBeTruthy();

      // -----------------------------------------------------------
      // 3. udr_rated carries the PER_UNIT values (R1, ship-blocking).
      // -----------------------------------------------------------
      const rated = await ratedForBatch(batchId);
      expect(rated).toHaveLength(3);
      for (const r of rated) {
        expect(r.status).toBe("RATED");
        expect(r.udrRateType).toBe("PER_UNIT");
        expect(r.udrUsageUnit).toBe("Mbps"); // product-sourced, not the feed
        expect(r.udrSubscriptionRefId).toBe(productInventoryId);
        expect(r.udrUsageRate).toBe(SAMPLE_5G_RATE_PER_UNIT); // 100.000000
      }
      // The PER_UNIT divergence from FLAT: raw = rate × quantity (not the rate).
      // quantity 100 @ rate 100 -> raw 10000.000000, rated 10000.00.
      const row100 = rated.find((r) => r.udrUsageQuantity === "100.000000")!;
      expect(row100.udrRatedPriceRaw).toBe("10000.000000");
      expect(row100.udrRatedPrice).toBe("10000.00");
      const detail = row100.udrRateDetail as {
        rateType: string;
        ratePerUnit: string;
        quantity: string;
        amountRaw: string;
      };
      expect(detail).toEqual({
        rateType: "PER_UNIT",
        ratePerUnit: "100.000000",
        quantity: "100",
        amountRaw: "10000.000000",
      });

      // One live row per (partition_period, udr_key).
      const udrKey = row100.udrKey;
      expect(await liveRowsForKey(udrKey)).toHaveLength(1);

      // -----------------------------------------------------------
      // 4. Re-drop the SAME filename (reissue, corrected volumes) -> run 2.
      // -----------------------------------------------------------
      const reissue = writeUdr(
        "rating-input-file-202608140001_v2.udr",
        [150, 250, 350],
      );
      const prpUri2 = runPrp(reissue, "rm22-prp-2");
      const prpManifest2 = readManifest(prpUri2);
      const batchId2 = prpManifest2.batch_id as string;
      const batch2Claim = await batchRow(batchId2);
      expect(batch2Claim.batchRunNum).toBe(2);
      expect(batch2Claim.fileKey).toBe(batch.fileKey);

      const rpUri2 = runRp(prpUri2, "rm22-rp-2");
      runRl(rpUri2, "rm22-rl-2");

      // -----------------------------------------------------------
      // 5. rm10 supersedes: run-1 rows retire, run-2 rows go live — still
      //    exactly one live row per (partition_period, udr_key).
      // -----------------------------------------------------------
      const live = await liveRowsForKey(udrKey);
      expect(live).toHaveLength(1);
      expect(live[0]!.udrRefBatchId).toBe(batchId2);
      expect(live[0]!.udrRatedPriceRaw).toBe("15000.000000"); // 150 × 100

      const all = await db
        .select()
        .from(udrRated)
        .where(eq(udrRated.udrKey, udrKey));
      expect(all).toHaveLength(2);
      const retired = all.find((r) => r.udrRefBatchId === batchId)!;
      expect(retired.status).toBe("SUPERSEDED");
      expect(retired.isLive).toBeNull();

      const retiredBatch = await batchRow(batchId);
      expect(retiredBatch.supersededByBatchId).toBe(batchId2);
      const batch2 = await batchRow(batchId2);
      expect(batch2.status).toBe("COMPLETE");
      expect(batch2.supersededCount).toBe(3);
    }, 120_000);
  },
);
