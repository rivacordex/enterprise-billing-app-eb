import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import type postgresjs from "postgres";

import type { Database } from "@/db/client";
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
} from "@/db/seeds/sample/sample-5g-fixture";

// Shared harness for the DB+python-gated RAN_USAGE rating suites (rm13, rm23):
// shells the real PRP/RP/RL runtime modules exactly as the flow's tasks do,
// against a disposable database seeded with the Sample-5G graph.

export const RATING_WORKER_DIR = join(
  process.cwd(),
  "workflow-management",
  "worker",
  "workflow-engine",
);

// python3 is invoked by ABSOLUTE path, never resolved through PATH (a writable
// PATH entry could shadow it). RATING_PYTHON3 selects a local interpreter (e.g.
// a py3.12 venv); otherwise the fixed system locations CI installs into.
const PYTHON3_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3"];
const PYTHON3: string | undefined = (() => {
  const override = process.env.RATING_PYTHON3;
  if (override) return isAbsolute(override) ? override : undefined;
  return PYTHON3_CANDIDATES.find((p) => existsSync(p));
})();

export function pythonRuntimeReady(): boolean {
  if (!PYTHON3) return false;
  try {
    execFileSync(PYTHON3, ["-c", "import runtime, polars, psycopg"], {
      cwd: RATING_WORKER_DIR,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export async function runSqlFile(
  client: postgresjs.Sql,
  path: string,
): Promise<void> {
  const statements = readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await client.unsafe(statement);
  }
}

export async function dropModuleSchemas(client: postgresjs.Sql): Promise<void> {
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
}

// The production 7-column RAN_USAGE `.udr` feed profile (rm21 §6) — kept
// identical so the suites exercise the real production configuration.
export const RAN_USAGE_FEED_PROFILE = JSON.stringify({
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

export interface Sample5gGraphOptions {
  // Fixture-name stem, e.g. "rm23-geo" -> "rm23-geo-org", "_SAMPLE_-RM23-GEO".
  tag: string;
  mno: string;
  productName: string;
  priceName: string;
  cardName: string;
}

// Seeds the rateable Sample-5G graph via the SHARED fixture builders (the same
// builders the production db:seed-sample-5g uses).
export async function seedSample5gRatingGraph(
  db: Database,
  opts: Sample5gGraphOptions,
): Promise<{ partyRoleId: string; productInventoryId: string }> {
  const { tag } = opts;
  const words = tag.replaceAll("-", " ");
  const actorId = await getOrCreateAppUser(
    db,
    `${tag}-actor`,
    `${tag}@example.invalid`,
  );
  const { offeringId } = await insertRanOffering(db, {
    name: opts.productName,
    priceName: opts.priceName,
    udrTypeValue: "RAN_USAGE",
    cardName: opts.cardName,
  });
  const partyRoleId = await insertRanCustomer(db, {
    organizationName: `${tag}-org`,
    registrationNumber: `_SAMPLE_-${tag.toUpperCase()}`,
    partyRoleSpecification: { mnoPublicKey1: opts.mno },
    actorId,
  });
  const billCycleId = await insertRanBillCycle(db, {
    name: `${tag}-cycle`,
    description: `${words} fixture bill cycle`,
    actorId,
  });
  const billingAccountId = await insertRanBillingAccount(db, {
    financialAccountName: `${tag}-fa`,
    billingAccountName: `${tag}-ban`,
    partyRoleId,
    billCycleId,
    actorId,
  });
  const productInventoryId = await insertRanSubscription(db, {
    partyRoleId,
    billingAccountId,
    offeringId,
    actorId,
    reason: `${words} fixture`,
  });
  await insertRanRatecard(db, {
    cardName: opts.cardName,
    mnoPublicKey: opts.mno,
    lkpSubscriberRefId: partyRoleId,
    rows: SAMPLE_5G_LKP_ROWS,
    actorId,
  });
  return { partyRoleId, productInventoryId };
}

export interface RatingPipelineOptions {
  databaseUrl: string;
  rolePassword: string;
  engineVersion: string;
  mno: string;
  productName: string;
  now: string;
  tmpPrefix: string;
}

export interface RatingPipeline {
  // 3 clean rows, one per ratecard cell; `volumes[i]` is cell i's usage.
  writeUdr(name: string, volumes: readonly number[]): string;
  runPrp(sourcePath: string, execId: string): string;
  runRp(manifestUri: string, execId: string): string;
  runRl(manifestUri: string, execId: string): string;
}

// Creates fresh landing/error/logs/archive/work dirs and returns runners that
// invoke the runtime modules as rating_runtime; each returns the module's last
// stdout line (the manifest URI it hands off).
export function createRatingPipeline(
  opts: RatingPipelineOptions,
): RatingPipeline {
  const url = new URL(opts.databaseUrl);
  const root = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
  const landingDir = join(root, "landing");
  const errorDir = join(root, "error");
  const logsDir = join(root, "logs");
  const archiveDir = join(root, "archive");
  const workDir = join(root, "work");
  for (const d of [landingDir, errorDir, logsDir, archiveDir, workDir]) {
    mkdirSync(d, { recursive: true });
  }
  const env = {
    ...process.env,
    SECRET_RATING_RUNTIME_PASSWORD: opts.rolePassword,
    RATING_DB_HOST: url.hostname,
    RATING_DB_PORT: url.port || "5432",
    RATING_DB_NAME: url.pathname.replace(/^\//, ""),
    RATING_DB_USER: "rating_runtime",
    RATING_LANDING_DIR: landingDir,
    RATING_ERROR_DIR: errorDir,
    RATING_LOGS_DIR: logsDir,
    RATING_ARCHIVE_DIR: archiveDir,
    RATING_ENGINE_VERSION: opts.engineVersion,
  };

  function runModule(module: string, args: string[]): string {
    if (!PYTHON3) throw new Error("no absolute python3 (set RATING_PYTHON3)");
    const out = execFileSync(PYTHON3, ["-m", module, ...args], {
      cwd: RATING_WORKER_DIR,
      encoding: "utf8",
      env,
    });
    return out.trim().split("\n").pop() as string;
  }

  return {
    writeUdr(name, volumes) {
      const rows = SAMPLE_5G_LKP_ROWS.map((cell, i) =>
        [
          opts.mno,
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
    },
    runPrp(sourcePath, execId) {
      return runModule("runtime.prp", [
        "--source-file",
        sourcePath,
        "--udr-type",
        "RAN_USAGE",
        "--profile",
        RAN_USAGE_FEED_PROFILE,
        "--file-key-rule",
        FILE_KEY_RULE,
        "--reject-threshold",
        "0",
        "--chunk-size",
        "10000",
        "--subscription-product-name",
        opts.productName,
        "--ratecard-coverage-enforcement",
        "HARD_STOP",
        "--workflow-execution-id",
        execId,
        "--now",
        opts.now,
        "--work-dir",
        workDir,
      ]);
    },
    runRp(manifestUri, execId) {
      return runModule("runtime.rp", [
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
      ]);
    },
    runRl(manifestUri, execId) {
      return runModule("runtime.rl", [
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
      ]);
    },
  };
}

export function readManifest(uri: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(uri.trim()), "utf8"));
}
