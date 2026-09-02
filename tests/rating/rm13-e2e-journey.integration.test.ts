import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// rm13-spec D3 — "One test exercising the whole spine, composed from the
// units: a RAN_USAGE file lands -> PRP claims and rejects the 37 bad rows
// (PARTIAL) -> RP rates the survivors -> RL loads at RATED and archives ->
// upstream reissues -> rm10 supersedes -> the completeness check runs
// clean. Proves the units compose, not just pass in isolation."
//
// This is the ONE new behavioral test rm13 adds beyond test #15 (rm13-spec
// intro: "it adds no new test tree ... [only] test #15" refers to the
// GUARDRAIL suite in code-standards §10 — the end-to-end journey is a
// separate rm13 deliverable per Implementation §3/Design D3, verification
// checklist item 1). It composes rm07 (prp), rm08 (rp), rm09 (rl), rm10
// (supersession) and rm12 (completeness) exactly as each unit's own suite
// already black-box tests them individually — this suite's job is only to
// prove they compose end to end in ONE run, not to re-prove any single
// unit's behaviour (that's each unit's own suite).
//
// Requires DATABASE_URL and python3+the worker's runtime (psycopg+polars) —
// same posture as every rm06-rm12 DB-gated suite; no live Kestra engine
// needed (this shells out to the real runtime modules directly, exactly as
// the flow's own tasks invoke them, same black-box precedent as rm07-rm12).
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

const ROLE_PW = "rm13-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm13-test-engine@sha256:deadbeef";

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
describe.skipIf(!databaseUrl || !pythonReady)(
  "rm13 — the complete operator journey (rm13-spec D3, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let errorDir: string;
    let logsDir: string;
    let archiveDir: string;
    let workDir: string;
    let invA: string;

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

    // Same MYR product/order/inventory graph rm10's suite seeds — one
    // subscriber, one FLAT usage price, so the priced amount is not the
    // point of this suite (rm08 already proves resolution/rounding).
    async function seedProductGraph(): Promise<void> {
      const userId = crypto.randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "rm13-fixture-user",
        userEmail: "rm13-fixture@example.invalid",
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
      const [org] = await db
        .insert(organization)
        .values({
          name: "rm13-fixture-org",
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
        .values({ name: "rm13-fixture-cycle", lastEditedBy: userId })
        .returning({ billCycleId: billCycle.billCycleId });
      const billCycleId = bc!.billCycleId;

      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "rm13-fa-MYR",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: userId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "rm13-ban-MYR",
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
          name: "rm13-OFF1",
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

      const root = mkdtempSync(join(tmpdir(), "rm13-journey-"));
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

    function writeCsv(name: string, rows: string[]): string {
      const header = "DATETIME,PUBLIC_KEY,COMMERCIAL_UNIT,SITE,USAGE_MBPS";
      const path = join(landingDir, name);
      writeFileSync(path, [header, ...rows].join("\n") + "\n", "utf8");
      return path;
    }

    function runPrp(sourcePath: string, execId: string, now: string): string {
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
          now,
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

    function runCompletenessCheck(opts: {
      config: string;
      now: string;
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
          "1",
          "--workflow-execution-id",
          opts.execId,
          "--now",
          opts.now,
        ],
        { cwd: workerDir, encoding: "utf8", env: runEnv() },
      ).trim();
    }

    function readManifest(uri: string): Record<string, unknown> {
      const path = decodeURIComponent(uri.replace(/^file:\/\//, ""));
      return JSON.parse(readFileSync(path, "utf8"));
    }

    async function batchRow(batchId: string) {
      const rows = await db
        .select()
        .from(udrBatch)
        .where(eq(udrBatch.batchId, batchId));
      return rows[0]!;
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

    it("file lands -> PARTIAL (37 rejects) -> rated -> loaded + archived -> reissue supersedes -> completeness check runs clean", async () => {
      const NOW1 = "2026-05-04T08:00:00Z";

      // -----------------------------------------------------------
      // 1. A RAN_USAGE file lands: 63 valid rows + 37 bad rows.
      // -----------------------------------------------------------
      const goodRows = Array.from({ length: 63 }, (_, i) => {
        const minute = String(i % 60).padStart(2, "0");
        return `2026-05-04T07:${minute}:00Z,${invA},CU,SITE,${(i % 9) + 0.5}`;
      });
      const badRows = Array.from(
        { length: 37 },
        (_, i) => `not-a-date,${invA},CU,SITE,oops-${i}`,
      );
      const path = writeCsv("RAN_USAGE_20260504.csv", [
        ...goodRows,
        ...badRows,
      ]);

      // -----------------------------------------------------------
      // 2. PRP claims the file and rejects the 37 bad rows -> PARTIAL.
      // -----------------------------------------------------------
      const prpUri = runPrp(path, "journey-prp-1", NOW1);
      const prpManifest = readManifest(prpUri);
      const batchId = prpManifest.batch_id as string;
      let batch = await batchRow(batchId);
      expect(batch.status).toBe("PARTIAL");
      expect(batch.parsedCount).toBe(100);
      expect(batch.rejectedCount).toBe(37);
      expect(batch.batchRunNum).toBe(1);

      // -----------------------------------------------------------
      // 3. RP rates the 63 survivors.
      // -----------------------------------------------------------
      const rpUri = runRp(prpUri, "journey-rp-1");

      // -----------------------------------------------------------
      // 4. RL loads the survivors at RATED and archives the raw file.
      // -----------------------------------------------------------
      runRl(rpUri, "journey-rl-1");
      batch = await batchRow(batchId);
      // 63 rated + 37 rejected + 0 discarded = 100 parsed — the
      // reconciliation identity holds (rm09 D5) — and the batch stays
      // PARTIAL (not every parsed record was rated, rm09's terminal-status
      // decision recorded in Open Questions).
      expect(batch.status).toBe("PARTIAL");
      expect(batch.ratedCount).toBe(63);
      expect(batch.archiveFilePath).toBeTruthy();

      const allRows = await db
        .select()
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, batchId));
      expect(allRows).toHaveLength(63);
      expect(allRows.every((r) => r.status === "RATED")).toBe(true);
      const udrKey = allRows[0]!.udrKey;

      // -----------------------------------------------------------
      // 5. Upstream reissues under a new filename (same file_key) with a
      //    corrected reading for the same natural keys.
      // -----------------------------------------------------------
      const NOW2 = "2026-05-04T09:00:00Z";
      const correctedRows = Array.from({ length: 63 }, (_, i) => {
        const minute = String(i % 60).padStart(2, "0");
        // A different usage value — a genuine correction, not a
        // byte-identical redelivery (rm07 D5's DUPLICATE_BATCH guard).
        return `2026-05-04T07:${minute}:00Z,${invA},CU,SITE,${(i % 9) + 1.5}`;
      });
      const reissuePath = writeCsv("RAN_USAGE_20260504_v2.csv", correctedRows);
      const prpUri2 = runPrp(reissuePath, "journey-prp-2", NOW2);
      const prpManifest2 = readManifest(prpUri2);
      const batchId2 = prpManifest2.batch_id as string;
      const batch2Claim = await batchRow(batchId2);
      expect(batch2Claim.batchRunNum).toBe(2);
      expect(batch2Claim.fileKey).toBe(batch.fileKey);

      const rpUri2 = runRp(prpUri2, "journey-rp-2");
      runRl(rpUri2, "journey-rl-2");

      // -----------------------------------------------------------
      // 6. rm10 supersedes: run 1's rows retire, run 2's rows go live.
      // -----------------------------------------------------------
      const live = await liveRowsForKey(udrKey);
      expect(live).toHaveLength(1);
      expect(live[0]!.udrRefBatchId).toBe(batchId2);

      const all = await allRowsForKey(udrKey);
      expect(all).toHaveLength(2);
      const retired = all.find((r) => r.udrRefBatchId === batchId)!;
      expect(retired.status).toBe("SUPERSEDED");
      expect(retired.isLive).toBeNull();

      const retiredBatch = await batchRow(batchId);
      expect(retiredBatch.supersededByBatchId).toBe(batchId2);
      expect(retiredBatch.supersedeReason).toBeTruthy();
      const batch2 = await batchRow(batchId2);
      expect(batch2.status).toBe("COMPLETE"); // all 63 parsed, all rated
      expect(batch2.supersededCount).toBe(63);

      // -----------------------------------------------------------
      // 7. The completeness check runs clean — the delivery already
      //    arrived (both runs), well before an end-of-day deadline, so
      //    nothing is FILE_NOT_RECEIVED or FILE_LATE.
      // -----------------------------------------------------------
      const checkOut = runCompletenessCheck({
        config: "RAN_USAGE:23:59",
        now: "2026-05-04T09:05:00Z",
        execId: "journey-completeness",
      });
      expect(checkOut).toMatch(/0 event\(s\) emitted/);
    }, 120_000);
  },
);
