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
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
// The rateable Sample-5G fixture builders are SHARED with the production seed
// (db/seeds/sample/sample-5g-rating.ts) — one source of truth for the fixture's
// shape (rm21 code-review fix). This suite calls them with per-case parameters.
import {
  insertRanOffering,
  insertRanCustomer,
  insertRanBillCycle,
  insertRanBillingAccount,
  insertRanSubscription,
  insertRanRatecard,
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_COMMERCIAL_UNIT,
} from "@/db/seeds/sample/sample-5g-fixture";

// rm21-spec §8 — the rm07 suite refreshed for the PER_UNIT RAN-usage shape.
//   #9  Batch claim — a well-named `.udr` file claims run 1; a `_v2` reissue
//       derives the SAME file_key; an unparseable name → FILE_KEY_UNRESOLVED.
//   rm21 resolution + identity locks + checks (all whole-batch hard-stops):
//       a clean 7-column file rates and stamps `product_inventory_id` onto the
//       chunk for RP; each forced identity/mapping/completeness fault refuses the
//       whole batch with the correct event code; dedup keys on the billing month
//       (R2); an unmapped input row is a whole-batch stop, not a LOOKUP_MISS (R3).
//
// The static describe (no DATABASE_URL) checks the flow-YAML contract rm21 adds
// (the 7-column feed profile, the `.udr` file_key rule, reject_threshold "0",
// the subscription pin + coverage-enforcement variables, the retired
// subscriber_ref_column). The DB-gated describe shells out to the REAL
// `python3 -m runtime.prp` exactly as the flow's prp task invokes it, against a
// seeded Sample-5G graph (offering + specs + scalar usage_rate price, a customer
// carrying the MNO key, its RAN_USAGE subscription, an ACTIVE ratecard). Requires
// `python3` on PATH with the worker deps (psycopg + polars); skipped loudly when
// unavailable — same posture as the rest of the rating suite (not run on a host
// without a live test Postgres + the worker deps; see ratemgmt-progress-tracker).
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

const ROLE_PW = "rm07-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);

// The 7-column feed profile the flow ships for RAN_USAGE
// (rating-engine-ran-usage.yaml `vars.feed_profile`) — kept identical here so the
// black-box test exercises the real production configuration, not a test-only one.
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
// A fixed reference instant so OUT_OF_RANGE never depends on wall-clock time;
// all fixture events are dated before it.
const NOW = "2026-09-01T00:00:00Z";
const UDR_HEADER =
  "mno_public_id,commercial_unit,polygon_id,datetime_YYYYMMDDHHMI,usage_volume,district_name,service_code";

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

// The file_key derived from a `.udr` path (basename minus the extension) — the
// same derivation the FILE_KEY_RULE produces, used to look batches up by key.
function fileKeyOf(udrPath: string): string {
  return udrPath
    .split(/[\\/]/)
    .pop()!
    .replace(/\.udr$/, "");
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm21 §6 flow config.
// ---------------------------------------------------------------------
describe("prp flow wiring (rm21-spec §6 — static)", () => {
  const template = readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "flows",
      "rating-engine",
      "rating-engine-ran-usage.yaml",
    ),
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

  it("the prp task wires the rm21 pin + coverage-enforcement args", () => {
    const prpBlock = template.slice(
      template.indexOf("id: prp"),
      template.indexOf("id: rp"),
    );
    expect(prpBlock).toMatch(
      /--subscription-product-name "\{\{ vars\.subscription_product_name \}\}"/,
    );
    expect(prpBlock).toMatch(
      /--ratecard-coverage-enforcement "\{\{ vars\.ratecard_coverage_enforcement \}\}"/,
    );
  });

  it("the landing/ file trigger never moves the file (D3, Inv #7)", () => {
    const triggersBlock = template.slice(
      template.indexOf("triggers:"),
      template.indexOf("tasks:"),
    );
    expect(triggersBlock).toMatch(/id: landing-file/);
    expect(triggersBlock).toMatch(/fs\.local\.Trigger/);
    expect(triggersBlock).toMatch(/action:\s*NONE/);
    expect(triggersBlock).not.toMatch(
      /type:\s*io\.kestra\.plugin\.core\.trigger\.Webhook/,
    );
  });

  it("output-affecting config lives in flow variables; chunk size lives in the KV store (rm21 §6)", () => {
    const vars = template.slice(
      template.indexOf("variables:"),
      template.indexOf("concurrency:"),
    );
    // The 7-column feed profile, the `.udr` file_key rule, the all-or-nothing
    // reject threshold, the subscription pin and the coverage-enforcement mode
    // are output-affecting → flow variables.
    expect(vars).toMatch(/feed_profile:/);
    expect(vars).toMatch(/udr_key_columns/);
    expect(vars).toMatch(/mno_public_id/);
    expect(vars).toMatch(/service_code/);
    // The unit is product-sourced (rm19/rm20) — the feed carries none.
    expect(vars).not.toMatch(/usage_unit/);
    expect(vars).toMatch(/file_key_rule:/);
    expect(vars).toMatch(/rating-input-file-/);
    expect(vars).toMatch(/\\.udr\$/);
    expect(vars).toMatch(/reject_threshold:\s*"0"/);
    expect(vars).toMatch(/subscription_product_name:\s*"Sample 5G Services"/);
    expect(vars).toMatch(/ratecard_coverage_enforcement:\s*HARD_STOP/);
    // The rm07 placeholder subscriber var is retired (rm21 §6).
    expect(vars).not.toMatch(/subscriber_ref_column:/);
    // Chunk size is performance-only → the namespace KV store, NOT a variable.
    expect(vars).not.toMatch(/chunk_size/);
    expect(template).toMatch(/kv\('rating_ran_usage_chunk_size'\)/);
  });

  it("rp reads the stamped product_inventory_id column, not the retired var (rm21 §6)", () => {
    const rpBlock = template.slice(
      template.indexOf("id: rp"),
      template.indexOf("id: rl"),
    );
    expect(rpBlock).toMatch(/--subscriber-ref-column product_inventory_id/);
    expect(rpBlock).not.toMatch(/vars\.subscriber_ref_column/);
  });

  it("concurrency: limit: 1 is retained (D6)", () => {
    expect(template).toMatch(/concurrency:\s*\n\s*limit:\s*1/);
  });
});

// ---------------------------------------------------------------------
// Black-box resolve/validate/reject — live DB + the real python3 -m runtime.prp.
// ---------------------------------------------------------------------
describe.skipIf(!databaseUrl || !pythonReady)(
  "prp resolve/validate/reject (rm21-spec §8, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let actorId: string;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let errorDir: string;
    let logsDir: string;
    let workDir: string;

    // The ratecard cell structure is shared with the production seed's fixture.
    const POLYGONS = SAMPLE_5G_LKP_ROWS.map((r) => r.polygonId);
    const SERVICE_CODES = SAMPLE_5G_LKP_ROWS.map((r) => r.serviceCode);
    const COMMERCIAL_UNIT = SAMPLE_5G_COMMERCIAL_UNIT;

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
      actorId = await getOrCreateAppUser(
        db,
        "_SAMPLE_ rm21 Seed Actor",
        "rm21-seed@example.invalid",
      );

      const url = new URL(databaseUrl as string);
      dbParams = {
        host: url.hostname,
        port: url.port || "5432",
        name: url.pathname.replace(/^\//, ""),
      };

      const root = mkdtempSync(join(tmpdir(), "rm21-prp-"));
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

    // --- Fixture seeding: thin wrappers over the SHARED sample-5g-fixture
    // builders (one source of truth with the production seed), parameterised per
    // test case (unique names per tag, override hooks for the fault scenarios).

    async function seedOffering(
      tag: string,
      udrTypeValue: string,
      cardName: string,
    ): Promise<{ offeringId: string; familyId: string }> {
      const { offeringId } = await insertRanOffering(db, {
        name: `Sample 5G Services ${tag}`,
        priceName: `Sample 5G Usage Rate ${tag}`,
        udrTypeValue,
        cardName,
      });
      // family_id = COALESCE(family_offering_id, product_offering_id) = the id,
      // since this offering is its own family root (familyOfferingId null).
      return { offeringId, familyId: offeringId };
    }

    async function seedCustomer(
      tag: string,
      spec: Record<string, unknown>,
    ): Promise<string> {
      return insertRanCustomer(db, {
        organizationName: `_SAMPLE_ rm21 ${tag}`,
        registrationNumber: `_SAMPLE_-RM21-${tag}`,
        partyRoleSpecification: spec,
        actorId,
      });
    }

    async function seedBillingAccount(
      tag: string,
      partyRoleId: string,
    ): Promise<string> {
      const billCycleId = await insertRanBillCycle(db, {
        name: `_SAMPLE_ rm21 Cycle ${tag}`,
        description: "rm21 fixture bill cycle",
        actorId,
      });
      return insertRanBillingAccount(db, {
        financialAccountName: `_SAMPLE_ rm21 FA ${tag}`,
        billingAccountName: `_SAMPLE_ rm21 BAN ${tag}`,
        partyRoleId,
        billCycleId,
        actorId,
      });
    }

    async function seedSubscription(
      partyRoleId: string,
      billingAccountId: string,
      offeringId: string,
    ): Promise<string> {
      return insertRanSubscription(db, {
        partyRoleId,
        billingAccountId,
        offeringId,
        actorId,
        reason: "rm21 fixture",
      });
    }

    async function seedRatecard(
      cardName: string,
      mno: string,
      lkpSubscriberRefId: string,
    ): Promise<void> {
      await insertRanRatecard(db, {
        cardName,
        mnoPublicKey: mno,
        lkpSubscriberRefId,
        rows: SAMPLE_5G_LKP_ROWS,
        actorId,
      });
    }

    // The common happy-path fixture: one customer (MNO key), its RAN subscription
    // to the pinned offering, and an ACTIVE ratecard whose lkp points at that
    // customer. Returns the ids the per-case tests vary around.
    async function seedBaseScenario(
      tag: string,
      mno: string,
    ): Promise<{
      productName: string;
      card: string;
      partyRoleId: string;
      productInventoryId: string;
      offeringId: string;
    }> {
      const card = `RATECARD_${tag}`;
      const { offeringId } = await seedOffering(tag, "RAN_USAGE", card);
      const partyRoleId = await seedCustomer(tag, { mnoPublicKey1: mno });
      const billingAccountId = await seedBillingAccount(tag, partyRoleId);
      const productInventoryId = await seedSubscription(
        partyRoleId,
        billingAccountId,
        offeringId,
      );
      await seedRatecard(card, mno, partyRoleId);
      return {
        productName: `Sample 5G Services ${tag}`,
        card,
        partyRoleId,
        productInventoryId,
        offeringId,
      };
    }

    // --- file + prp harness --------------------------------------------------

    function writeUdr(name: string, rows: string[]): string {
      const path = join(landingDir, name);
      writeFileSync(path, [UDR_HEADER, ...rows].join("\n") + "\n", "utf8");
      return path;
    }

    // A clean row for a polygon cell (all three identity factors + service_code
    // agree with the seeded ratecard).
    function cleanRow(
      mno: string,
      polyIdx: number,
      datetime: string,
      volume = "100",
    ): string {
      return [
        mno,
        COMMERCIAL_UNIT,
        POLYGONS[polyIdx],
        datetime,
        volume,
        `DIST-${polyIdx + 1}`,
        SERVICE_CODES[polyIdx],
      ].join(",");
    }

    // All three cells, clean — the full-coverage happy file.
    function cleanRows(mno: string): string[] {
      return [
        cleanRow(mno, 0, "2026-08-14T10:00:00"),
        cleanRow(mno, 1, "2026-08-14T10:05:00"),
        cleanRow(mno, 2, "2026-08-14T10:10:00"),
      ];
    }

    let fileSeq = 100000000000;
    function udrName(): string {
      fileSeq += 1;
      return `rating-input-file-${fileSeq}.udr`;
    }

    function runPrp(
      sourcePath: string,
      opts: {
        productName: string;
        coverage?: "HARD_STOP" | "WARN";
        threshold?: number;
        chunkSize?: number;
        execId?: string;
      },
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
          String(opts.threshold ?? 0),
          "--chunk-size",
          String(opts.chunkSize ?? 10_000),
          "--subscription-product-name",
          opts.productName,
          "--ratecard-coverage-enforcement",
          opts.coverage ?? "HARD_STOP",
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

    function logLinesFor(execId: string): string[] {
      const path = join(logsDir, `PRP-${execId}.jsonl`);
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }

    function eventCodes(execId: string): string[] {
      return logLinesFor(execId).map((l) => JSON.parse(l).event_code as string);
    }

    function readParquetColumn(parquetUri: string, column: string): string[] {
      const path = decodeURIComponent(parquetUri.replace(/^file:\/\//, ""));
      const out = execFileSync(
        "python3",
        [
          "-c",
          "import polars,sys;print('\\n'.join(str(v) for v in polars.read_parquet(sys.argv[1])[sys.argv[2]].to_list()))",
          path,
          column,
        ],
        { cwd: workerDir, encoding: "utf8" },
      );
      return out
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
    }

    // -----------------------------------------------------------------
    // #9 — Batch claim / file_key derivation from the `.udr` FILENAME (D3).
    // -----------------------------------------------------------------
    it("9. a clean 7-column .udr file claims run 1, rates, and stamps product_inventory_id onto the chunk for RP", async () => {
      const s = await seedBaseScenario("clean", "MNO-CLEAN");
      const path = writeUdr(udrName(), cleanRows("MNO-CLEAN"));
      const { manifestUri } = runPrp(path, { productName: s.productName });
      const manifestPath = decodeURIComponent(
        manifestUri.replace(/^file:\/\//, ""),
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.status).toBe("PROCESSING");
      expect(manifest.parsed_count).toBe(3);
      expect(manifest.rejected_count).toBe(0);
      expect(manifest.chunk_uris).toHaveLength(1);
      // product_inventory_id reaches RP: every chunk row carries the resolved id.
      const ids = readParquetColumn(
        manifest.chunk_uris[0],
        "product_inventory_id",
      );
      expect(new Set(ids)).toEqual(new Set([s.productInventoryId]));
      const rows = await sql`
        SELECT batch_run_num, status FROM rating.udr_batch
         WHERE file_key = ${manifest.file_key}`;
      expect(firstRow(rows).batch_run_num).toBe(1);
      expect(firstRow(rows).status).toBe("PROCESSING");
    });

    it("9. an unparseable filename refuses with FILE_KEY_UNRESOLVED and makes no batch", async () => {
      const s = await seedBaseScenario("fku", "MNO-FKU");
      const path = writeUdr("corrected.udr", cleanRows("MNO-FKU"));
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-fku" }),
      ).toThrow();
      const rows = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE source_file = 'corrected.udr'`;
      expect(firstRow(rows).n).toBe(0);
      expect(eventCodes("exec-fku")).toEqual(["FILE_KEY_UNRESOLVED"]);
    });

    it("9. a `_v2` reissue derives the SAME file_key — recognised as one logical delivery (run 2)", async () => {
      const s = await seedBaseScenario("reissue", "MNO-REISS");
      const run1 = writeUdr(
        "rating-input-file-202608010001.udr",
        cleanRows("MNO-REISS"),
      );
      runPrp(run1, { productName: s.productName, execId: "exec-reiss1" });
      // Different content (volumes) so it is a genuine reissue, not byte-identical.
      const run2 = writeUdr("rating-input-file-202608010001_v2.udr", [
        cleanRow("MNO-REISS", 0, "2026-08-14T10:00:00", "111"),
        cleanRow("MNO-REISS", 1, "2026-08-14T10:05:00", "222"),
        cleanRow("MNO-REISS", 2, "2026-08-14T10:10:00", "333"),
      ]);
      runPrp(run2, { productName: s.productName, execId: "exec-reiss2" });
      const rows = await sql`
        SELECT batch_run_num, source_file FROM rating.udr_batch
         WHERE file_key = 'rating-input-file-202608010001'
         ORDER BY batch_run_num`;
      expect(rows.map((r) => r.batch_run_num)).toEqual([1, 2]);
      expect(rows.map((r) => r.source_file)).toContain(
        "rating-input-file-202608010001_v2.udr",
      );
    });

    it("9. two different content timestamps NEVER derive the same file_key (code-standards §10 #9)", async () => {
      const s = await seedBaseScenario("period", "MNO-PERIOD");
      // Two files, same content, different 12-digit stamps → two distinct keys
      // (the key is derived from the filename, never the content).
      const a = writeUdr(
        "rating-input-file-203001010001.udr",
        cleanRows("MNO-PERIOD"),
      );
      const b = writeUdr(
        "rating-input-file-203001020001.udr",
        cleanRows("MNO-PERIOD"),
      );
      runPrp(a, { productName: s.productName, execId: "exec-per-a" });
      runPrp(b, { productName: s.productName, execId: "exec-per-b" });
      const keys = await sql`
        SELECT DISTINCT file_key FROM rating.udr_batch
         WHERE file_key IN ('rating-input-file-203001010001','rating-input-file-203001020001')
         ORDER BY file_key`;
      expect(keys.map((k) => k.file_key)).toEqual([
        "rating-input-file-203001010001",
        "rating-input-file-203001020001",
      ]);
    });

    it("a byte-identical redelivery is discarded as DUPLICATE_BATCH before parsing (D5)", async () => {
      const s = await seedBaseScenario("dup", "MNO-DUPB");
      const identical = cleanRows("MNO-DUPB");
      const first = writeUdr("rating-input-file-202608020001.udr", identical);
      runPrp(first, { productName: s.productName, execId: "exec-dupb1" });
      const before = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE file_key = 'rating-input-file-202608020001'`;
      const dup = writeUdr("rating-input-file-202608020001_v9.udr", identical);
      runPrp(dup, { productName: s.productName, execId: "exec-dupb2" });
      const after = await sql`
        SELECT count(*)::int AS n FROM rating.udr_batch
         WHERE file_key = 'rating-input-file-202608020001'`;
      expect(firstRow(after).n).toBe(firstRow(before).n); // no new batch
      expect(eventCodes("exec-dupb2")).toEqual(["DUPLICATE_BATCH"]);
    });

    // #12 (code-standards §10) — Log proportionality: N structural rejects produce
    // exactly ONE summarised process_log line (Inv #11). Under reject_threshold 0
    // any structural reject refuses the whole file (PARSE_FAILURE).
    it("12. N structural rejects produce exactly one summarised line and the reject file names them all", async () => {
      const s = await seedBaseScenario("partial", "MNO-PART");
      const bad = Array.from({ length: 12 }, (_, i) =>
        [
          "MNO-PART",
          COMMERCIAL_UNIT,
          POLYGONS[i % 3],
          "2026-08-14T10:00:00",
          "oops", // BAD_USAGE
          "DIST-1",
          SERVICE_CODES[i % 3],
        ].join(","),
      );
      const path = writeUdr(udrName(), bad);
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-part" }),
      ).toThrow();
      expect(eventCodes("exec-part")).toEqual(["PARSE_FAILURE"]); // ONE line, not 12
      const batch = await sql`
        SELECT status, parsed_count, rejected_count, reject_file_path
          FROM rating.udr_batch
         WHERE file_key = ${fileKeyOf(path)}`;
      expect(firstRow(batch).status).toBe("REFUSED");
      expect(firstRow(batch).parsed_count).toBe(12);
      expect(firstRow(batch).rejected_count).toBe(12);
      const rejectRows = readFileSync(firstRow(batch).reject_file_path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      expect(rejectRows).toHaveLength(1 + 12); // header + 12 rejects
    });

    // -----------------------------------------------------------------
    // rm21 §3 — udrType confirmation (whole-batch hard-stop).
    // -----------------------------------------------------------------
    it("UDRTYPE_MISMATCH refuses the whole batch when the pinned offering's udrType spec disagrees", async () => {
      const card = "RATECARD_UDRTYPE";
      const { offeringId } = await seedOffering("udrtype", "OTHER_USAGE", card);
      const partyRoleId = await seedCustomer("udrtype", {
        mnoPublicKey1: "MNO-UDR",
      });
      const banId = await seedBillingAccount("udrtype", partyRoleId);
      await seedSubscription(partyRoleId, banId, offeringId);
      await seedRatecard(card, "MNO-UDR", partyRoleId);
      const path = writeUdr(udrName(), cleanRows("MNO-UDR"));
      expect(() =>
        runPrp(path, {
          productName: "Sample 5G Services udrtype",
          execId: "exec-udrtype",
        }),
      ).toThrow();
      expect(eventCodes("exec-udrtype")).toContain("UDRTYPE_MISMATCH");
      const rows = await sql`
        SELECT status FROM rating.udr_batch WHERE file_key = ${fileKeyOf(path)}`;
      expect(firstRow(rows).status).toBe("REFUSED");
    });

    // -----------------------------------------------------------------
    // rm21 §2/§4 — the three-factor identity lock + mapping (hard-stops).
    // -----------------------------------------------------------------
    it("a bad MNO key (no resolving subscriber) hard-stops the batch UNKNOWN_SUBSCRIBER", async () => {
      const s = await seedBaseScenario("unknown", "MNO-KNOWN");
      // The file uses an MNO no party_role carries.
      const path = writeUdr(udrName(), [
        cleanRow("MNO-ABSENT", 0, "2026-08-14T10:00:00"),
      ]);
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-unknown" }),
      ).toThrow();
      expect(eventCodes("exec-unknown")).toContain("UNKNOWN_SUBSCRIBER");
    });

    it("a wrong ratecard lkp_subscriber_ref_id hard-stops the batch SUBSCRIBER_REF_MISMATCH", async () => {
      const card = "RATECARD_SUBREF";
      const { offeringId } = await seedOffering("subref", "RAN_USAGE", card);
      const partyRoleId = await seedCustomer("subref", {
        mnoPublicKey1: "MNO-SUBREF",
      });
      const banId = await seedBillingAccount("subref", partyRoleId);
      await seedSubscription(partyRoleId, banId, offeringId);
      // The ratecard references a DIFFERENT party_role than the one the MNO
      // resolves to → factor 2 fails.
      await seedRatecard(card, "MNO-SUBREF", "PTRL99999999");
      const path = writeUdr(udrName(), cleanRows("MNO-SUBREF"));
      expect(() =>
        runPrp(path, {
          productName: "Sample 5G Services subref",
          execId: "exec-subref",
        }),
      ).toThrow();
      expect(eventCodes("exec-subref")).toContain("SUBSCRIBER_REF_MISMATCH");
    });

    it("a resolved family id != the pinned family hard-stops the batch PRODUCT_PIN_MISMATCH", async () => {
      // Pin = offering A; the customer's RAN subscription is to offering B (a
      // different family). A's ratecard references the customer (factor 2 passes),
      // so factor 3 (family B != family A) is the fault.
      const cardA = "RATECARD_PINA";
      const { offeringId: offeringA } = await seedOffering(
        "pinA",
        "RAN_USAGE",
        cardA,
      );
      const { offeringId: offeringB } = await seedOffering(
        "pinB",
        "RAN_USAGE",
        "RATECARD_PINB",
      );
      const partyRoleId = await seedCustomer("pin", {
        mnoPublicKey1: "MNO-PIN",
      });
      const banId = await seedBillingAccount("pin", partyRoleId);
      await seedSubscription(partyRoleId, banId, offeringB);
      await seedRatecard(cardA, "MNO-PIN", partyRoleId);
      expect(offeringA).not.toBe(offeringB);
      const path = writeUdr(udrName(), cleanRows("MNO-PIN"));
      expect(() =>
        runPrp(path, {
          productName: "Sample 5G Services pinA",
          execId: "exec-pin",
        }),
      ).toThrow();
      expect(eventCodes("exec-pin")).toContain("PRODUCT_PIN_MISMATCH");
    });

    it("an input service_code != the matched ratecard row hard-stops the batch SERVICE_CODE_MISMATCH", async () => {
      const s = await seedBaseScenario("svc", "MNO-SVC");
      const rows = cleanRows("MNO-SVC");
      // Corrupt the first row's service_code.
      rows[0] = [
        "MNO-SVC",
        COMMERCIAL_UNIT,
        POLYGONS[0],
        "2026-08-14T10:00:00",
        "100",
        "DIST-1",
        "SVL-WRONG",
      ].join(",");
      const path = writeUdr(udrName(), rows);
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-svc" }),
      ).toThrow();
      expect(eventCodes("exec-svc")).toContain("SERVICE_CODE_MISMATCH");
    });

    it("an unmapped input row is a whole-batch stop INPUT_UNMAPPED, not a per-record LOOKUP_MISS (R3)", async () => {
      const s = await seedBaseScenario("unmapped", "MNO-UNMAP");
      const rows = [
        ...cleanRows("MNO-UNMAP"),
        // A polygon with no ratecard entry.
        [
          "MNO-UNMAP",
          COMMERCIAL_UNIT,
          "PCU-999_99",
          "2026-08-14T10:20:00",
          "100",
          "DIST-9",
          "SVL-100",
        ].join(","),
      ];
      const path = writeUdr(udrName(), rows);
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-unmap" }),
      ).toThrow();
      const codes = eventCodes("exec-unmap");
      expect(codes).toContain("INPUT_UNMAPPED");
      expect(codes).not.toContain("LOOKUP_MISS");
    });

    it("two customers sharing one MNO key hard-stop the batch MNO_KEY_NOT_UNIQUE", async () => {
      const card = "RATECARD_NU";
      const { offeringId } = await seedOffering("nu", "RAN_USAGE", card);
      const pr1 = await seedCustomer("nu1", { mnoPublicKey1: "MNO-DUP" });
      const pr2 = await seedCustomer("nu2", { mnoPublicKey1: "MNO-DUP" });
      const ban1 = await seedBillingAccount("nu1", pr1);
      const ban2 = await seedBillingAccount("nu2", pr2);
      await seedSubscription(pr1, ban1, offeringId);
      await seedSubscription(pr2, ban2, offeringId);
      await seedRatecard(card, "MNO-DUP", pr1);
      const path = writeUdr(udrName(), [
        cleanRow("MNO-DUP", 0, "2026-08-14T10:00:00"),
      ]);
      expect(() =>
        runPrp(path, {
          productName: "Sample 5G Services nu",
          execId: "exec-nu",
        }),
      ).toThrow();
      expect(eventCodes("exec-nu")).toContain("MNO_KEY_NOT_UNIQUE");
    });

    // -----------------------------------------------------------------
    // rm21 §5 — ratecard→input completeness (HARD_STOP vs WARN).
    // -----------------------------------------------------------------
    it("a missing ratecard polygon under HARD_STOP refuses the batch RATECARD_COVERAGE_GAP", async () => {
      const s = await seedBaseScenario("covhs", "MNO-COVHS");
      // Only two of the three ratecard cells appear in the input.
      const path = writeUdr(udrName(), [
        cleanRow("MNO-COVHS", 0, "2026-08-14T10:00:00"),
        cleanRow("MNO-COVHS", 1, "2026-08-14T10:05:00"),
      ]);
      expect(() =>
        runPrp(path, {
          productName: s.productName,
          coverage: "HARD_STOP",
          execId: "exec-covhs",
        }),
      ).toThrow();
      expect(eventCodes("exec-covhs")).toContain("RATECARD_COVERAGE_GAP");
    });

    it("the same missing-polygon file under WARN rates and logs RATECARD_COVERAGE_GAP_WARN (not a stop)", async () => {
      const s = await seedBaseScenario("covwarn", "MNO-COVWARN");
      const path = writeUdr(udrName(), [
        cleanRow("MNO-COVWARN", 0, "2026-08-14T10:00:00"),
        cleanRow("MNO-COVWARN", 1, "2026-08-14T10:05:00"),
      ]);
      const { manifestUri } = runPrp(path, {
        productName: s.productName,
        coverage: "WARN",
        execId: "exec-covwarn",
      });
      const manifestPath = decodeURIComponent(
        manifestUri.replace(/^file:\/\//, ""),
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.status).toBe("PROCESSING");
      expect(manifest.parsed_count).toBe(2);
      expect(eventCodes("exec-covwarn")).toContain(
        "RATECARD_COVERAGE_GAP_WARN",
      );
    });

    // -----------------------------------------------------------------
    // rm21 §4 / R2 — dedup on the billing-month identity.
    // -----------------------------------------------------------------
    it("a same-cell/same-month duplicate is rejected (reject_threshold 0 → PARSE_FAILURE), R2", async () => {
      const s = await seedBaseScenario("dupsame", "MNO-DUPS");
      const rows = [
        ...cleanRows("MNO-DUPS"),
        // A second record for cell 0 in the SAME billing month → DUPLICATE_IN_FILE.
        cleanRow("MNO-DUPS", 0, "2026-08-20T09:00:00"),
      ];
      const path = writeUdr(udrName(), rows);
      expect(() =>
        runPrp(path, { productName: s.productName, execId: "exec-dupsame" }),
      ).toThrow();
      expect(eventCodes("exec-dupsame")).toContain("PARSE_FAILURE");
      const batch = await sql`
        SELECT status, rejected_count, reject_file_path FROM rating.udr_batch
         WHERE file_key = ${fileKeyOf(path)}`;
      expect(firstRow(batch).status).toBe("REFUSED");
      const rejectText = readFileSync(firstRow(batch).reject_file_path, "utf8");
      expect(rejectText).toContain("DUPLICATE_IN_FILE");
    });

    it("a same-cell/different-month pair is KEPT (not a duplicate), R2", async () => {
      const s = await seedBaseScenario("dupdiff", "MNO-DUPD");
      // cell 0 in two different billing months, plus cells 1 and 2 for coverage.
      // Both months are before NOW (2026-09-01) and within the subscription
      // period, so neither row is OUT_OF_RANGE — only the billing-month dedup
      // behaviour is under test here.
      const rows = [
        cleanRow("MNO-DUPD", 0, "2026-07-14T10:00:00"),
        cleanRow("MNO-DUPD", 0, "2026-08-14T10:00:00"),
        cleanRow("MNO-DUPD", 1, "2026-08-14T10:05:00"),
        cleanRow("MNO-DUPD", 2, "2026-08-14T10:10:00"),
      ];
      const path = writeUdr(udrName(), rows);
      const { manifestUri } = runPrp(path, {
        productName: s.productName,
        execId: "exec-dupdiff",
      });
      const manifestPath = decodeURIComponent(
        manifestUri.replace(/^file:\/\//, ""),
      );
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.status).toBe("PROCESSING");
      expect(manifest.parsed_count).toBe(4);
      expect(manifest.rejected_count).toBe(0);
    });
  },
);
