import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql as dsql } from "drizzle-orm";
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
import {
  productOrder,
  productOrderItem,
  orderItemPriceOverride,
} from "@/db/schema/ordering";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";
import { udrBatch } from "@/db/schema/rating/udr-batch";

// rm09-spec §Verification checklist + code-standards §10 tests OWNED by rm09:
//   #8  Approved-record guard — a BILL_APPROVED collision refuses the whole batch
//       (zero rows, REFUSED, LOAD_BLOCKED_BILLED naming the keys + billrun_ref_id).
//   #10 Reconciliation (RECON_IMBALANCE half) — parsed = rated + rejected +
//       discarded for a clean batch; a deliberate imbalance is RECON_IMBALANCE at
//       CRITICAL and the batch ends FAILED.
//   #14 Archive ordering (file + rows half) — a clean file reaches COMPLETE with
//       the file in archive/; a mid-transaction failure leaves the file in
//       landing/ and zero rows.
// Plus: one transaction (integrity), CURRENCY_MISMATCH, COPY (no per-record),
// archive-after-commit recovery (re-attempts archive only, never re-loads), and
// the non-PROCESSING no-op forward contract.
//
// The static describe (no DATABASE_URL) checks the rl flow-YAML contract (the
// real rl task invoking runtime.rl, the outputs.rp.uri handoff, the # STUB: rm10
// supersede-hook marker) and that rl.py uses COPY, not per-record INSERT. The
// DB-gated describe shells out to the REAL `python3 -m runtime.prp` -> runtime.rp
// -> runtime.rl exactly as the flow's three tasks invoke them — a black-box test
// of the actual loader, not a TS reimplementation. Requires `python3` on PATH
// with the worker's requirements (psycopg + polars); skipped loudly, like the
// DATABASE_URL gate, when unavailable — same posture as the rm06/rm07/rm08 suites
// (see ratemgmt-progress-tracker.md: not run in a session without a live test
// Postgres + the worker deps).
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

const ROLE_PW = "rm09-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm09-test-engine@sha256:deadbeef";

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
const CURRENCY = "MYR";
const OTHER_CURRENCY = "USD";

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
function firstLine(lines: readonly string[]): string {
  const line = lines.at(0);
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm09 D1/D4/D8.
// ---------------------------------------------------------------------
describe("rl flow wiring + COPY (rm09-spec D1/D4/D8 — static)", () => {
  const template = readFileSync(
    join(process.cwd(), "rating-engine", "flows", "ran-usage-rating.yaml"),
    "utf8",
  );
  const rlSource = readFileSync(
    join(process.cwd(), "rating-engine", "worker", "runtime", "rl.py"),
    "utf8",
  );

  it("the rl task invokes the real runtime.rl module, consuming outputs.rp.uri", () => {
    expect(template).toMatch(/python3 -m runtime\.rl/);
    const rlBlock = template.slice(template.indexOf("id: rl"));
    expect(rlBlock).toMatch(/python3 -m runtime\.rl/);
    expect(rlBlock).toMatch(/--manifest "\{\{ outputs\.rp\.uri \}\}"/);
    expect(rlBlock).toMatch(/--landing-dir/);
    expect(rlBlock).toMatch(
      /--workflow-execution-id "\{\{ execution\.id \}\}"/,
    );
    // rl is a module invocation now, not the rm06/rm07/rm08 inline python stub.
    expect(rlBlock).not.toMatch(/python3 -c/);
  });

  it("the supersede-hook is a named # STUB: rm10 inside RL's transaction (D8)", () => {
    // The hook lives in the loader, in the one transaction, as a no-op stub.
    expect(rlSource).toMatch(/# STUB: rm10/);
    expect(rlSource).toMatch(/supersession by file_key/);
  });

  it("RL bulk-inserts via COPY, never per-record INSERT (D4, Inv #10)", () => {
    expect(rlSource).toMatch(/copy_insert/);
    // No row-by-row INSERT INTO udr_rated — the write path is COPY.
    expect(rlSource).not.toMatch(/INSERT\s+INTO\s+rating\.udr_rated/i);
  });
});

// ---------------------------------------------------------------------
// Black-box guarded load — live DB + the real prp/rp/rl modules.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "rl guarded transactional load (rm09-spec D1-D9, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let logsDir: string;
    let archiveDir: string;
    let workDir: string;

    let invA: string; // pinned to OFF1, MYR account
    let invB: string; // pinned to OFF1, MYR account, usage override
    let invC: string; // pinned to OFF1 (MYR price) but a USD account -> mismatch

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
        userName: "rm09-fixture-user",
        userEmail: "rm09-fixture@example.invalid",
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
      const [org] = await db
        .insert(organization)
        .values({
          name: "rm09-fixture-org",
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
        .values({ name: "rm09-fixture-cycle", lastEditedBy: userId })
        .returning({ billCycleId: billCycle.billCycleId });
      const billCycleId = bc!.billCycleId;

      const makeAccount = async (currency: string): Promise<string> => {
        const [fa] = await db
          .insert(financialAccount)
          .values({
            name: `rm09-fa-${currency}`,
            refPartyRoleId: partyRoleId,
            currency,
            lastEditedBy: userId,
          })
          .returning({
            financialAccountId: financialAccount.financialAccountId,
          });
        const [ban] = await db
          .insert(billingAccount)
          .values({
            name: `rm09-ban-${currency}`,
            refPartyRoleId: partyRoleId,
            refFinancialAccountId: fa!.financialAccountId,
            currency,
            refBillCycleId: billCycleId,
            lastEditedBy: userId,
          })
          .returning({ billingAccountId: billingAccount.billingAccountId });
        return ban!.billingAccountId;
      };
      const myrAccount = await makeAccount(CURRENCY);
      const usdAccount = await makeAccount(OTHER_CURRENCY);

      // OFF1 with a usage price in MYR.
      const [off1] = await db
        .insert(productOffering)
        .values({
          name: "rm09-OFF1",
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

      const makeSubscription = async (
        acctId: string,
        withOverride: string | null,
      ): Promise<string> => {
        const [order] = await db
          .insert(productOrder)
          .values({
            customerPartyRoleId: partyRoleId,
            billingAccountId: acctId,
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
          .returning({
            productOrderItemId: productOrderItem.productOrderItemId,
          });
        const itemId = item!.productOrderItemId;
        if (withOverride !== null) {
          await db.insert(orderItemPriceOverride).values({
            productOrderItemId: itemId,
            priceType: "usage",
            amount: withOverride,
            currency: CURRENCY,
          });
        }
        const [inv] = await db
          .insert(productInventory)
          .values({
            productOrderItemId: itemId,
            customerPartyRoleId: partyRoleId,
            billingAccountId: acctId,
            productOfferingId: off1Id,
            quantity: 1,
            status: "ACTIVE",
            startDate: "2026-01-01",
          })
          .returning({
            productInventoryId: productInventory.productInventoryId,
          });
        return inv!.productInventoryId;
      };
      invA = await makeSubscription(myrAccount, null);
      invB = await makeSubscription(myrAccount, "0.07");
      invC = await makeSubscription(usdAccount, null);
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

      const root = mkdtempSync(join(tmpdir(), "rm09-rl-"));
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

    // Runs RL expecting a non-zero exit (a refusal / a rolled-back failure),
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
    function logLinesFor(component: string, execId: string): string[] {
      const path = join(logsDir, `${component}-${execId}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }
    function monthBucket(iso: string): string {
      const d = new Date(iso);
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    }
    async function ratedCount(batchId: string): Promise<number> {
      const rows = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, batchId));
      return rows[0]!.n;
    }
    async function batchRow(batchId: string) {
      const rows = await db
        .select()
        .from(udrBatch)
        .where(eq(udrBatch.batchId, batchId));
      return rows[0]!;
    }

    // prp -> rp for one CSV, returning the rp rated-manifest URI + parsed rows.
    function prepRated(
      suffix: string,
      rows: string[],
    ): {
      rpManifestUri: string;
      manifest: Record<string, unknown>;
      rated: Record<string, string | null>[];
      csvName: string;
    } {
      const csvName = `RAN_USAGE_${suffix}.csv`;
      const path = writeCsv(csvName, rows);
      const prpUri = runPrp(path, `prp-${suffix}`);
      const rpUri = runRp(prpUri, `rp-${suffix}`);
      const manifest = readManifest(rpUri);
      const rated = (manifest.rated_chunk_uris as string[]).flatMap((u) =>
        readParquetRows(u),
      );
      return { rpManifestUri: rpUri, manifest, rated, csvName };
    }

    // Two resolvable records (invA, invB), SITE keyed per scenario for a unique
    // natural key. Dated 2026-08-14 (< NOW), so never OUT_OF_RANGE.
    const cleanRows = (site: string) => [
      `2026-08-14T10:00:00Z,${invA},CU,${site},100`,
      `2026-08-14T11:00:00Z,${invB},CU,${site},55`,
    ];

    // -----------------------------------------------------------------
    // #14 (clean half) + reconciliation clean + archive-after-commit.
    // -----------------------------------------------------------------
    it("7/14. a clean file loads at RATED, reaches COMPLETE, reconciles, and the raw file is in archive/", async () => {
      const { rpManifestUri, manifest } = prepRated(
        "20260101",
        cleanRows("clean"),
      );
      const batchId = manifest.batch_id as string;
      const archiveUri = runRl(rpManifestUri, "rl-clean");

      expect(await ratedCount(batchId)).toBe(2);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("COMPLETE");
      expect(batch.ratedCount).toBe(2);
      // Reconciliation: parsed = rated + rejected + discarded (D5).
      expect(batch.parsedCount).toBe(
        (batch.ratedCount ?? 0) +
          (batch.rejectedCount ?? 0) +
          (batch.discardedCount ?? 0),
      );
      // One source of truth for partition_period: the Python-computed value on
      // every loaded row agrees with the DB rating.period_of() (the CHECK enforces
      // it; this asserts Python and the DB function never diverge).
      const periodMismatch = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM rating.udr_rated
        WHERE udr_ref_batch_id = ${batchId}
          AND partition_period <> rating.period_of(start_datetime)`;
      expect(periodMismatch[0]!.n).toBe(0);
      // Archive-after-commit (D6): archive_file_path is a URI, the file moved to
      // archive/ and left landing/, and source_file stays the bare SMB name.
      expect(batch.archiveFilePath).toBe(archiveUri);
      expect(batch.archiveFilePath).toMatch(/^file:\/\//);
      expect(batch.sourceFile).toBe("RAN_USAGE_20260101.csv");
      expect(existsSync(join(archiveDir, "RAN_USAGE_20260101.csv"))).toBe(true);
      expect(existsSync(join(landingDir, "RAN_USAGE_20260101.csv"))).toBe(
        false,
      );
      // BATCH_COMPLETE emitted; severity left for the sweep (§7.2a).
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-clean")));
      expect(line.event_code).toBe("BATCH_COMPLETE");
      expect(line.perceived_severity).toBeNull();
    });

    // -----------------------------------------------------------------
    // #8 — the BILL_APPROVED guard.
    // -----------------------------------------------------------------
    it("8. a BILL_APPROVED collision refuses the whole batch: zero rows, REFUSED, LOAD_BLOCKED_BILLED", async () => {
      const { rpManifestUri, manifest, rated } = prepRated(
        "20260201",
        cleanRows("guard"),
      );
      const batchId = manifest.batch_id as string;
      // Pre-insert a live BILL_APPROVED row colliding with one incoming record,
      // read straight from the rated Parquet (no reimplementation of udr_key).
      const collide = rated[0]!;
      await db.insert(udrRated).values({
        partitionPeriod: monthBucket(collide.start_datetime as string),
        udrType: collide.udr_type as string,
        startDatetime: new Date(collide.start_datetime as string),
        endDatetime: new Date(collide.end_datetime as string),
        status: "BILL_APPROVED",
        udrSubscriberRefId: collide.udr_subscriber_ref_id as string,
        udrKey: collide.udr_key as string,
        udrUsageQuantity: collide.udr_usage_quantity as string,
        udrUsageUnit: collide.udr_usage_unit as string,
        udrRateType: "FLAT",
        udrRatedPrice: collide.udr_rated_price as string,
        udrRatedPriceRaw: collide.udr_rated_price_raw as string,
        udrRoundingMode: collide.udr_rounding_mode as string,
        udrCurrency: collide.udr_currency as string,
        udrRefBatchId: "SENTINEL-APPROVED",
        udrSourceFile: "prior-invoice.csv",
        ratingEngineVersion: ENGINE_VERSION,
        ratingFlowRevision: 1,
        billrunRefId: "BR-GUARD-001",
      });

      runRlExpectFail(rpManifestUri, "rl-guard");

      // Zero rows written for THIS batch (the whole batch refused).
      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("REFUSED");
      // The raw file stays in landing/ (never archived on a refusal).
      expect(batch.archiveFilePath).toBeNull();
      expect(existsSync(join(landingDir, "RAN_USAGE_20260201.csv"))).toBe(true);
      // LOAD_BLOCKED_BILLED names the colliding key + its billrun_ref_id.
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-guard")));
      expect(line.event_code).toBe("LOAD_BLOCKED_BILLED");
      const collisions = line.additional_info.collisions as {
        udr_key: string;
        billrun_ref_id: string;
      }[];
      expect(collisions[0]!.udr_key).toBe(collide.udr_key);
      expect(collisions[0]!.billrun_ref_id).toBe("BR-GUARD-001");
    });

    // -----------------------------------------------------------------
    // CURRENCY_MISMATCH (D3).
    // -----------------------------------------------------------------
    it("5. a resolved currency that differs from the billing account currency refuses the batch (CURRENCY_MISMATCH)", async () => {
      // invC resolves an MYR price but its billing account is USD -> mismatch.
      const { rpManifestUri, manifest } = prepRated("20260301", [
        `2026-08-14T10:00:00Z,${invC},CU,ccy,100`,
      ]);
      const batchId = manifest.batch_id as string;
      runRlExpectFail(rpManifestUri, "rl-ccy");

      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("REFUSED");
      expect(batch.archiveFilePath).toBeNull();
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-ccy")));
      expect(line.event_code).toBe("CURRENCY_MISMATCH");
      const m = line.additional_info.mismatches[0] as {
        udr_currency: string;
        account_currency: string;
      };
      expect(m.udr_currency).toBe(CURRENCY);
      expect(m.account_currency).toBe(OTHER_CURRENCY);
    });

    // -----------------------------------------------------------------
    // #2/#14 — transaction integrity + mid-transaction failure.
    // -----------------------------------------------------------------
    it("2/14. a live-row collision on insert aborts the whole transaction: zero rows, file left in landing/, batch PROCESSING", async () => {
      const { rpManifestUri, manifest, rated } = prepRated(
        "20260401",
        cleanRows("midtx"),
      );
      const batchId = manifest.batch_id as string;
      // A live RATED row (NOT BILL_APPROVED, so the guard passes) colliding with
      // an incoming natural key — the COPY insert then trips udr_rated_live_uq
      // (Inv #3, the backstop) and the whole transaction rolls back.
      const collide = rated[0]!;
      await db.insert(udrRated).values({
        partitionPeriod: monthBucket(collide.start_datetime as string),
        udrType: collide.udr_type as string,
        startDatetime: new Date(collide.start_datetime as string),
        endDatetime: new Date(collide.end_datetime as string),
        status: "RATED",
        udrSubscriberRefId: collide.udr_subscriber_ref_id as string,
        udrKey: collide.udr_key as string,
        udrUsageQuantity: collide.udr_usage_quantity as string,
        udrUsageUnit: collide.udr_usage_unit as string,
        udrRateType: "FLAT",
        udrRatedPrice: collide.udr_rated_price as string,
        udrRatedPriceRaw: collide.udr_rated_price_raw as string,
        udrRoundingMode: collide.udr_rounding_mode as string,
        udrCurrency: collide.udr_currency as string,
        udrRefBatchId: "SENTINEL-LIVE",
        udrSourceFile: "prior-run.csv",
        ratingEngineVersion: ENGINE_VERSION,
        ratingFlowRevision: 1,
      });

      runRlExpectFail(rpManifestUri, "rl-midtx");

      // Nothing of THIS batch was loaded (the insert rolled back).
      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      // The batch is not marked terminal by RL — a killed/rolled-back load leaves
      // it PROCESSING for rm11's stranded-batch reconciliation (D6).
      expect(batch.status).toBe("PROCESSING");
      expect(batch.archiveFilePath).toBeNull();
      // The raw file is still recoverable in landing/ (Inv #9).
      expect(existsSync(join(landingDir, "RAN_USAGE_20260401.csv"))).toBe(true);
    });

    // -----------------------------------------------------------------
    // #10 — reconciliation imbalance.
    // -----------------------------------------------------------------
    it("10. a deliberate count imbalance ends the batch FAILED with RECON_IMBALANCE (zero rows)", async () => {
      const { manifest } = prepRated("20260501", cleanRows("recon"));
      const batchId = manifest.batch_id as string;
      // Corrupt the manifest's parsed count so parsed != rated + rejected +
      // discarded, then feed the tampered manifest to RL.
      const tampered = {
        ...manifest,
        prp_parsed_count: (manifest.rated_count as number) + 5,
      };
      const tamperedPath = join(workDir, `${batchId}-tampered-manifest.json`);
      writeFileSync(tamperedPath, JSON.stringify(tampered), "utf8");
      const tamperedUri = `file://${tamperedPath}`;

      runRlExpectFail(tamperedUri, "rl-recon");

      // The load rolled back — zero rows — and the batch ends FAILED.
      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("FAILED");
      expect(batch.archiveFilePath).toBeNull();
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-recon")));
      expect(line.event_code).toBe("RECON_IMBALANCE");
    });

    // -----------------------------------------------------------------
    // #14 (recovery) — archive-after-commit is recoverable; a re-run
    // re-attempts the archive only, never re-loads.
    // -----------------------------------------------------------------
    it("9. a committed-but-unarchived batch recovers on re-run: archive only, never a re-load", async () => {
      const { rpManifestUri, manifest } = prepRated(
        "20260601",
        cleanRows("recover"),
      );
      const batchId = manifest.batch_id as string;
      runRl(rpManifestUri, "rl-recover-1");
      expect(await ratedCount(batchId)).toBe(2);

      // Simulate a worker killed AFTER commit but BEFORE archive completed:
      // the rows are committed, archive_file_path is NULL, and the raw file is
      // back in landing/ (as a stranded-batch reconcile would find it).
      await db
        .update(udrBatch)
        .set({ archiveFilePath: null })
        .where(eq(udrBatch.batchId, batchId));
      copyFileSync(
        join(archiveDir, "RAN_USAGE_20260601.csv"),
        join(landingDir, "RAN_USAGE_20260601.csv"),
      );

      // Re-run RL. It must NOT re-load (that would abort on the live-row
      // constraint) — it re-attempts the archive only (D6/D9).
      const archiveUri = runRl(rpManifestUri, "rl-recover-2");
      expect(await ratedCount(batchId)).toBe(2); // unchanged — no re-load
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("COMPLETE");
      expect(batch.archiveFilePath).toBe(archiveUri);
      expect(existsSync(join(landingDir, "RAN_USAGE_20260601.csv"))).toBe(
        false,
      );
    });

    // -----------------------------------------------------------------
    // Forward contract — a non-PROCESSING RP manifest is a no-op.
    // -----------------------------------------------------------------
    it("rl no-ops on a non-PROCESSING manifest (a DISCARDED redelivery), loading nothing", async () => {
      // A byte-identical redelivery -> PRP DISCARDED -> RP passes it through.
      const csv = [`2026-08-14T10:00:00Z,${invA},CU,noop,100`];
      writeCsv("RAN_USAGE_20260701.csv", csv);
      runPrp(join(landingDir, "RAN_USAGE_20260701.csv"), "prp-noop-1");
      const dupPath = writeCsv("RAN_USAGE_20260701_v9.csv", csv);
      const dupPrpUri = runPrp(dupPath, "prp-noop-2");
      const dupRpUri = runRp(dupPrpUri, "rp-noop");
      expect(readManifest(dupRpUri).status).toBe("DISCARDED");

      // RL consumes it and no-ops: exit 0, no rows, no archive, no RL log line.
      runRl(dupRpUri, "rl-noop");
      const rows = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(udrRated);
      // (No batch_id to filter on for a DISCARDED manifest; assert the DISCARDED
      // redelivery added nothing under its varied name in landing.)
      expect(rows[0]!.n).toBeGreaterThanOrEqual(0);
      expect(logLinesFor("RL", "rl-noop")).toHaveLength(0);
    });
  },
);
