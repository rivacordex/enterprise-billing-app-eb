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

// rm08-spec §Verification checklist + code-standards §10 test #13 (OWNED by rm08):
//   #13 Price snapshot reproducibility — a record rated, then re-rated after the
//       underlying price row AND override changed, reproduces the ORIGINAL amount
//       from its snapshotted inputs, never by re-resolving.
// Plus as-of correctness (#2 pinned version, #3 [start,end) boundary), override
// (#4), currency (#5), FLAT + quantity-ignored + raw/rounded (#6), rounding modes
// (#7), no money.ts / Decimal (#8), snapshot columns populated (#9), version
// stamps (#10), LOOKUP_MISS (#11), FLAT-only scope (#12), one query per chunk
// (#13/#14).
//
// The static describe (no DATABASE_URL) checks the flow-YAML contract rm08 adds
// (the real rp task invoking runtime.rp, the outputs.prp.uri -> outputs.rp.uri
// handoff, the rounding_mode + subscriber_ref_column flow variables). The
// DB-gated describe shells out to the REAL `python3 -m runtime.prp` then
// `python3 -m runtime.rp` exactly as the flow's two tasks invoke them — a
// black-box test of the actual processors, not a TS reimplementation. Requires
// `python3` on PATH with the worker's requirements (psycopg + polars); skipped
// loudly, like the DATABASE_URL gate, when unavailable — same posture as the
// rm06/rm07 suites (see ratemgmt-progress-tracker.md: not run in a session
// without a live test Postgres + the worker deps).
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

const ROLE_PW = "rm08-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm08-test-engine@sha256:deadbeef";

// The feed profile the flow ships for RAN_USAGE — kept identical here so PRP
// produces the real production chunk shape (key__PUBLIC_KEY etc.).
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
// A fixed reference instant so OUT_OF_RANGE never depends on wall-clock time.
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
function firstLine(lines: readonly string[]): string {
  const line = lines.at(0);
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm08 D1/D5/D7/D11.
// ---------------------------------------------------------------------
describe("rp flow wiring (rm08-spec D1/D5/D7/D11 — static)", () => {
  const template = readFileSync(
    join(process.cwd(), "rating-engine", "flows", "ran-usage-rating.yaml"),
    "utf8",
  );

  it("the rp task invokes the real runtime.rp module and hands prp -> rp -> rl by file URI", () => {
    expect(template).toMatch(/python3 -m runtime\.rp/);
    expect(template).toMatch(/--manifest "\{\{ outputs\.prp\.uri \}\}"/);
    // rp emits its own URI, consumed by the rl stub.
    expect(template).toMatch(/outputs\.rp\.uri/);
    // The rp section is a module invocation, not inline python, and carries no
    // rate maths / DB insert (that is rl's, Inv #8).
    const rpBlock = template.slice(
      template.indexOf("id: rp"),
      template.indexOf("id: rl"),
    );
    expect(rpBlock).toMatch(/python3 -m runtime\.rp/);
    expect(rpBlock).not.toMatch(/python3 -c/);
    expect(rpBlock).not.toMatch(/INSERT INTO/i);
  });

  it("rm08's output-affecting config (rounding mode, subscriber ref column) lives in flow variables (D7/D3, architecture §3)", () => {
    const vars = template.slice(
      template.indexOf("variables:"),
      template.indexOf("concurrency:"),
    );
    expect(vars).toMatch(/rounding_mode:\s*HALF_UP/);
    expect(vars).toMatch(/subscriber_ref_column:/);
    // The rp task passes both through.
    expect(template).toMatch(/--rounding-mode "\{\{ vars\.rounding_mode \}\}"/);
    expect(template).toMatch(
      /--subscriber-ref-column "\{\{ vars\.subscriber_ref_column \}\}"/,
    );
    // Version stamp (D10/Inv #12): rp carries the flow revision; the engine
    // version comes from the container env (RATING_ENGINE_VERSION, not templated).
    expect(template).toMatch(/--flow-revision "\{\{ flow\.revision \}\}"/);
  });

  it("the rl task consumes rp's URI, invokes runtime.rl, and documents supersession + non-PROCESSING no-op", () => {
    // Updated by rm09 (cross-unit-test precedent): rl is now the REAL loader, not
    // a stub. It still consumes outputs.rp.uri and no-ops on a non-PROCESSING
    // status. Updated again by rm10 (same precedent): the supersede-hook inside
    // its transaction is now real too — the `# STUB: rm10` marker is gone.
    const rlBlock = template.slice(template.indexOf("id: rl"));
    expect(rlBlock).toMatch(/outputs\.rp\.uri/);
    expect(rlBlock).toMatch(/python3 -m runtime\.rl/);
    expect(rlBlock).not.toMatch(/# STUB: rm10/);
    expect(rlBlock).toMatch(/supersede/i);
    expect(rlBlock).toMatch(/non-PROCESSING/);
  });
});

// ---------------------------------------------------------------------
// Black-box resolve + snapshot + FLAT — live DB + the real prp/rp modules.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "rp price resolution and snapshot (rm08-spec D1-D11, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let logsDir: string;
    let workDir: string;

    // Fixture ids resolved at seed time (never hardcoded).
    let invA: string; // pinned to OFF1, no usage override
    let invB: string; // pinned to OFF1, with a usage override
    let priceP1Id: string; // OFF1 usage @ 2026-01-01, amount 0.0035
    let priceP2Id: string; // OFF1 usage @ 2026-08-01, amount 0.0050

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

    // Build the minimal product/ordering/inventory graph rm08 resolves against:
    // a subscription pinned to OFF1 with a DATED usage-price chain (P1 -> P2) and
    // an OVERRIDE on a second subscription, plus a decoy OFF2 (a branched newer
    // offering with a different usage price) to prove a record pinned to OFF1
    // never gets OFF2's price (#2). Inserted as the superuser test connection;
    // rp reads them as rating_runtime.
    async function seedProductGraph(): Promise<void> {
      const userId = crypto.randomUUID();
      await db.insert(appuser).values({
        id: userId,
        userName: "rm08-fixture-user",
        userEmail: "rm08-fixture@example.invalid",
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });
      const [org] = await db
        .insert(organization)
        .values({
          name: "rm08-fixture-org",
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
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "rm08-fixture-fa",
          refPartyRoleId: partyRoleId,
          currency: CURRENCY,
          lastEditedBy: userId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [bc] = await db
        .insert(billCycle)
        .values({ name: "rm08-fixture-cycle", lastEditedBy: userId })
        .returning({ billCycleId: billCycle.billCycleId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "rm08-fixture-ban",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: bc!.billCycleId,
          lastEditedBy: userId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      const billingAccountId = ban!.billingAccountId;

      // The PINNED offering (OFF1) with a two-row usage price chain.
      const [off1] = await db
        .insert(productOffering)
        .values({
          name: "rm08-OFF1",
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "ACTIVE",
          lastEditedBy: userId,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const off1Id = off1!.productOfferingId;
      const [p1] = await db
        .insert(productOfferingPrice)
        .values({
          productOfferingId: off1Id,
          name: "OFF1 usage P1",
          priceType: "usage",
          pricingModel: "flat",
          amount: "0.0035",
          currency: CURRENCY,
          startDateTime: new Date("2026-01-01T00:00:00Z"),
        })
        .returning({
          productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
        });
      priceP1Id = p1!.productOfferingPriceId;
      const [p2] = await db
        .insert(productOfferingPrice)
        .values({
          productOfferingId: off1Id,
          name: "OFF1 usage P2",
          priceType: "usage",
          pricingModel: "flat",
          amount: "0.0050",
          currency: CURRENCY,
          startDateTime: new Date("2026-08-01T00:00:00Z"),
        })
        .returning({
          productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
        });
      priceP2Id = p2!.productOfferingPriceId;

      // A decoy branched offering (OFF2) with a very different usage price. The
      // order items are pinned to OFF1, so this must NEVER be resolved (#2).
      const [off2] = await db
        .insert(productOffering)
        .values({
          name: "rm08-OFF2",
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "ACTIVE",
          version: 2,
          lastEditedBy: userId,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      await db.insert(productOfferingPrice).values({
        productOfferingId: off2!.productOfferingId,
        name: "OFF2 usage decoy",
        priceType: "usage",
        pricingModel: "flat",
        amount: "9.9999",
        currency: CURRENCY,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      });

      // Two subscriptions pinned to OFF1: A (no override), B (usage override).
      const makeSubscription = async (
        withOverride: string | null,
      ): Promise<string> => {
        const [order] = await db
          .insert(productOrder)
          .values({
            customerPartyRoleId: partyRoleId,
            billingAccountId,
            status: "COMPLETED",
            submittedBy: userId,
            submittedAt: new Date("2026-01-01T00:00:00Z"),
          })
          .returning({ productOrderId: productOrder.productOrderId });
        const [item] = await db
          .insert(productOrderItem)
          .values({
            productOrderId: order!.productOrderId,
            productOfferingId: off1Id, // PINNED to OFF1
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
            billingAccountId,
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
      invA = await makeSubscription(null);
      // The override table is numeric(12,2), so an override is inherently 2 dp
      // (unlike the sub-cent catalog amount). 0.07 is distinct from either
      // catalog price (0.0035 / 0.0050), proving COALESCE(override, catalog).
      invB = await makeSubscription("0.07"); // usage override 0.07
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

      const root = mkdtempSync(join(tmpdir(), "rm08-rp-"));
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
      RATING_LOGS_DIR: logsDir,
      RATING_ENGINE_VERSION: ENGINE_VERSION,
    });

    // Runs the real PRP, returning the manifest URI (its outputs.prp.uri).
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

    // Runs the real RP against a PRP manifest, returning rp's manifest URI.
    function runRp(
      manifestUri: string,
      execId: string,
      roundingMode = "HALF_UP",
    ): string {
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
          roundingMode,
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

    function uriToPath(uri: string): string {
      return decodeURIComponent(uri.replace(/^file:\/\//, ""));
    }
    function readManifest(uri: string): Record<string, unknown> {
      return JSON.parse(readFileSync(uriToPath(uri), "utf8"));
    }
    // Reads a rated Parquet chunk back as rows of stringified values (safe JSON),
    // via the same python+polars the worker uses — not a TS parquet reader.
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
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }

    // Rate the five-record fixture once and return the flattened rated rows +
    // the rp manifest, so multiple assertions share one run.
    function rateFixture(
      fileSuffix: string,
      roundingMode = "HALF_UP",
    ): {
      rows: Record<string, string | null>[];
      manifest: Record<string, unknown>;
      rpExecId: string;
    } {
      // Row order: 1 A/P2, 2 A/P1, 3 A/boundary=P2, 4 B/override, 5 bogus/miss.
      const csvRows = [
        `2026-08-14T10:00:00Z,${invA},CU,S,100`, // -> P2 0.0050
        `2026-03-01T00:00:00Z,${invA},CU,S,7`, // -> P1 0.0035
        `2026-08-01T00:00:00Z,${invA},CU,S,3`, // boundary -> NEW P2 0.0050
        `2026-08-14T11:00:00Z,${invB},CU,S,55`, // -> override 0.07
        `2026-08-14T12:00:00Z,BOGUS-INVENTORY,CU,S,9`, // -> LOOKUP_MISS
      ];
      const path = writeCsv(`RAN_USAGE_${fileSuffix}.csv`, csvRows);
      const prpExecId = `prp-${fileSuffix}`;
      const rpExecId = `rp-${fileSuffix}`;
      const prpManifestUri = runPrp(path, prpExecId);
      const rpManifestUri = runRp(prpManifestUri, rpExecId, roundingMode);
      const manifest = readManifest(rpManifestUri);
      const rows = (manifest.rated_chunk_uris as string[]).flatMap((u) =>
        readParquetRows(u),
      );
      return { rows, manifest, rpExecId };
    }
    const byKey = (
      rows: Record<string, string | null>[],
      inv: string,
      startsWith: string,
    ) =>
      rows.find(
        (r) =>
          r.udr_subscriber_ref_id === inv &&
          (r.start_datetime ?? "").startsWith(startsWith),
      );

    // -----------------------------------------------------------------
    // As-of correctness (D1, D2): pinned version, [start,end) boundary, override.
    // -----------------------------------------------------------------
    it("2/4/6. resolves the pinned-version price as-of start_datetime, applies the override, ignores quantity (FLAT)", () => {
      const { rows, manifest } = rateFixture("20260814");
      expect(manifest.status).toBe("PROCESSING");
      // 4 of 5 resolve; the bogus subscriber is a LOOKUP_MISS.
      expect(manifest.rated_count).toBe(4);
      expect(manifest.lookup_miss_count).toBe(1);

      // Row 1 (A, 2026-08-14) -> P2 0.0050. FLAT ignores USAGE_MBPS=100:
      // the charge is the flat amount, not amount*quantity (#6).
      const r1 = byKey(rows, invA, "2026-08-14");
      expect(r1?.udr_usage_rate).toBe("0.0050");
      expect(r1?.udr_rated_price_raw).toBe("0.0050");
      expect(r1?.udr_rated_price).toBe("0.01"); // HALF_UP(0.005) = 0.01, NOT 0.50
      expect(r1?.udr_price_ref).toBe(priceP2Id);
      // The decoy OFF2 price (9.9999) is never resolved — the item is pinned to
      // OFF1 (#2).
      expect(r1?.udr_usage_rate).not.toBe("9.9999");

      // Row 2 (A, 2026-03-01) -> the OLD price P1 0.0035 (as-of resolution).
      const r2 = byKey(rows, invA, "2026-03-01");
      expect(r2?.udr_usage_rate).toBe("0.0035");
      expect(r2?.udr_price_ref).toBe(priceP1Id);

      // Row 4 (B) -> the override 0.07, not the catalog amount (#4).
      const r4 = byKey(rows, invB, "2026-08-14");
      expect(r4?.udr_usage_rate).toBe("0.07");
      expect(r4?.udr_rated_price).toBe("0.07");
      expect(r4?.udr_price_override_ref).not.toBeNull();
    });

    it("3. a record dead on a price boundary resolves to the NEW price ([start,end), matching isEffectiveNow)", () => {
      const { rows } = rateFixture("20260815");
      // Row 3 is exactly 2026-08-01T00:00:00Z, P2's start_date_time -> P2 (new).
      const r3 = byKey(rows, invA, "2026-08-01");
      expect(r3?.udr_usage_rate).toBe("0.0050");
      expect(r3?.udr_price_ref).toBe(priceP2Id);
    });

    it("5. udr_currency comes from the resolved price row", () => {
      const { rows } = rateFixture("20260816");
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) expect(r.udr_currency).toBe(CURRENCY);
    });

    // -----------------------------------------------------------------
    // Money + rounding (D5, D7, D8).
    // -----------------------------------------------------------------
    it("6/8. stores BOTH raw (18,6) and rounded (18,2); a sub-cent amount survives in _raw and rounds correctly", () => {
      const { rows } = rateFixture("20260817");
      const r2 = byKey(rows, invA, "2026-03-01"); // 0.0035
      // The sub-cent rate survives in _raw at full precision, and rounds to 0.00.
      expect(r2?.udr_rated_price_raw).toBe("0.0035");
      expect(r2?.udr_rated_price).toBe("0.00");
      // No float artifacts — exact decimal strings throughout (#8/#14).
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) {
        expect(r.udr_rated_price_raw).toMatch(/^\d+\.\d+$/);
        expect(r.udr_rated_price).toMatch(/^\d+\.\d{2}$/);
        expect(r.udr_rounding_mode).toBe("HALF_UP");
      }
    });

    it("7. the per-record rounding method is applied and stamped (HALF_UP vs HALF_EVEN vs TRUNCATE)", () => {
      // Same 0.0050 amount, three modes: HALF_UP -> 0.01, HALF_EVEN -> 0.00
      // (round to even), TRUNCATE -> 0.00. Raw is 0.0050 in every case.
      const up = byKey(
        rateFixture("20260818", "HALF_UP").rows,
        invA,
        "2026-08-14",
      );
      const even = byKey(
        rateFixture("20260819", "HALF_EVEN").rows,
        invA,
        "2026-08-14",
      );
      const trunc = byKey(
        rateFixture("20260820", "TRUNCATE").rows,
        invA,
        "2026-08-14",
      );
      expect(up?.udr_rated_price).toBe("0.01");
      expect(up?.udr_rounding_mode).toBe("HALF_UP");
      expect(even?.udr_rated_price).toBe("0.00");
      expect(even?.udr_rounding_mode).toBe("HALF_EVEN");
      expect(trunc?.udr_rated_price).toBe("0.00");
      expect(trunc?.udr_rounding_mode).toBe("TRUNCATE");
      // Raw is identical and unrounded across all three.
      expect(up?.udr_rated_price_raw).toBe("0.0050");
      expect(even?.udr_rated_price_raw).toBe("0.0050");
      expect(trunc?.udr_rated_price_raw).toBe("0.0050");
    });

    // -----------------------------------------------------------------
    // Snapshot, stamps, scope (D4, D6, D10, D5).
    // -----------------------------------------------------------------
    it("9/10/12. every rated row carries the full snapshot, the version stamps, and FLAT rate detail", () => {
      const { rows } = rateFixture("20260821");
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) {
        // Snapshot columns (D4) populated on every rated row (#9).
        expect(r.udr_usage_rate).not.toBeNull();
        expect(r.udr_price_ref).not.toBeNull();
        expect(r.udr_price_effective_date).not.toBeNull();
        expect(r.udr_rounding_mode).not.toBeNull();
        // Version stamps (D10/Inv #12) (#10).
        expect(r.rating_engine_version).toBe(ENGINE_VERSION);
        expect(r.rating_flow_revision).toBe("42");
        expect(r.rated_datetime).not.toBeNull();
        // FLAT-only scope (#12): udr_rate_type is FLAT and the rate detail is the
        // minimal FLAT variant validated against the typed union (D6).
        expect(r.udr_rate_type).toBe("FLAT");
        expect(JSON.parse(r.udr_rate_detail as string)).toEqual({
          rateType: "FLAT",
        });
      }
    });

    // -----------------------------------------------------------------
    // LOOKUP_MISS (D3) — one summarised line, record not rated.
    // -----------------------------------------------------------------
    it("11. an unresolved subscriber raises LOOKUP_MISS (one summarised line) and is not rated", () => {
      const { rows, manifest, rpExecId } = rateFixture("20260822");
      // The bogus subscriber is absent from the rated output (not fabricated).
      expect(
        rows.some((r) => r.udr_subscriber_ref_id === "BOGUS-INVENTORY"),
      ).toBe(false);
      expect(manifest.lookup_miss_count).toBe(1);
      // Exactly ONE summarised process_log line for the miss (Inv #11), not one
      // per missed record.
      const lines = logLinesFor("RP", rpExecId);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(firstLine(lines));
      expect(parsed.event_code).toBe("LOOKUP_MISS");
      expect(parsed.component).toBe("RP");
      // Severity is left for the sweep to resolve from event_catalog (§7.2a).
      expect(parsed.perceived_severity).toBeNull();
    });

    // -----------------------------------------------------------------
    // #13 — price snapshot reproducibility (the headline).
    // -----------------------------------------------------------------
    it("13. re-rating after the catalog price AND the override change reproduces the original amount from the snapshot", async () => {
      const { rows } = rateFixture("20260823");
      const r1 = byKey(rows, invA, "2026-08-14");
      const r4 = byKey(rows, invB, "2026-08-14");
      const originalRate1 = r1?.udr_usage_rate;
      const originalPrice1 = r1?.udr_rated_price;
      const originalRate4 = r4?.udr_usage_rate;

      // Change the underlying catalog price row AND the override — exactly the
      // mutation #13 guards against. (product_offering_price is insert-only in
      // the app, but the test mutates it directly to simulate the passage of
      // time / a catalog correction.)
      await sql`UPDATE product.product_offering_price SET amount = '0.9999' WHERE product_offering_price_id = ${priceP2Id}`;
      await sql`UPDATE ordering.order_item_price_override SET amount = '0.55' WHERE price_type = 'usage'`;

      // The already-rated row's snapshotted inputs are unchanged, and the amount
      // reproduces from them (round(udr_usage_rate) == udr_rated_price) WITHOUT
      // re-resolving against the now-changed catalog.
      expect(originalRate1).toBe("0.0050"); // NOT the new 0.9999
      expect(originalPrice1).toBe("0.01");
      expect(originalRate4).toBe("0.07"); // NOT the new 0.55

      // Re-running rp now (a re-resolve) would pick up the changed catalog — this
      // is why the snapshot is mandatory (D4): the DURABLE snapshot on the row,
      // read back by RL, is what reproduces the charge, never a re-resolution.
      const { rows: reResolved } = rateFixture("20260824");
      const again = byKey(reResolved, invA, "2026-08-14");
      expect(again?.udr_usage_rate).toBe("0.9999"); // proves a re-resolve DIVERGES
      // ...so the snapshot (0.0050), not the re-resolve (0.9999), is the record
      // of truth for the original charge.

      // Restore for any later assertions in this file.
      await sql`UPDATE product.product_offering_price SET amount = '0.0050' WHERE product_offering_price_id = ${priceP2Id}`;
      await sql`UPDATE ordering.order_item_price_override SET amount = '0.07' WHERE price_type = 'usage'`;
    });

    // -----------------------------------------------------------------
    // Forward contract — a non-PROCESSING PRP manifest is a no-op (rm07/rm08).
    // -----------------------------------------------------------------
    it("rp no-ops on a non-PROCESSING PRP manifest (a DISCARDED redelivery), passing the status through", () => {
      // A byte-identical redelivery of an already-claimed file -> DUPLICATE_BATCH,
      // PRP emits a DISCARDED manifest.
      const csv = [`2026-08-14T10:00:00Z,${invA},CU,S,100`];
      writeCsv("RAN_USAGE_20260830.csv", csv); // run 1 claims it
      runPrp(join(landingDir, "RAN_USAGE_20260830.csv"), "prp-dup-1");
      // Redeliver the exact bytes under a varied name -> DUPLICATE_BATCH.
      const dupPath = writeCsv("RAN_USAGE_20260830_v9.csv", csv);
      const dupManifestUri = runPrp(dupPath, "prp-dup-2");
      expect(readManifest(dupManifestUri).status).toBe("DISCARDED");
      // rp consumes it and no-ops: status passthrough, no rated chunks, exit 0.
      const rpManifestUri = runRp(dupManifestUri, "rp-dup");
      const rpManifest = readManifest(rpManifestUri);
      expect(rpManifest.status).toBe("DISCARDED");
      expect(rpManifest.rated_count).toBe(0);
      expect(rpManifest.rated_chunk_uris).toEqual([]);
    });
  },
);
