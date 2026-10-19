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
  type RanLkpRow,
} from "@/db/seeds/sample/sample-5g-fixture";

// Shared harness for the DB+python-gated RAN_USAGE rating suites (rm08-rm11,
// rm13, rm23, rm27, rm28): shells the real PRP/RP/RL runtime modules exactly as
// the flow's tasks do, against a disposable database seeded with the Sample-5G
// graph. Feed polygons are written exactly as the card holds them, so the rated
// udr_key is the raw key (Inv 27) and udr_resource is the matched cell's label
// (Inv 28).

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

// The interpreter every rating suite must use for its own Parquet reads too,
// so a suite never gates on one python3 and reads with another.
export function ratingPython3(): string {
  if (!PYTHON3) throw new Error("no absolute python3 (set RATING_PYTHON3)");
  return PYTHON3;
}

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
// `rating-input-file-YYYYMMDDHHMI[_vN].udr` -> file_key
// `rating-input-file-YYYYMMDDHHMI` (a `_vN` reissue keeps the file_key).
export const RAN_USAGE_FILE_KEY_RULE =
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
  // The ratecard cells (default: the three Sample-5G cells).
  cells?: readonly RanLkpRow[];
  // The billing-account currency (default: the fixture's MYR); one that differs
  // from the price currency provokes RL's CURRENCY_MISMATCH.
  accountCurrency?: string;
}

export interface Sample5gGraph {
  partyRoleId: string;
  productInventoryId: string;
  offeringId: string;
  priceId: string;
}

// Seeds the rateable Sample-5G graph via the SHARED fixture builders (the same
// builders the production db:seed-sample-5g uses).
export async function seedSample5gRatingGraph(
  db: Database,
  opts: Sample5gGraphOptions,
): Promise<Sample5gGraph> {
  const { tag } = opts;
  const words = tag.replaceAll("-", " ");
  const actorId = await getOrCreateAppUser(
    db,
    `${tag}-actor`,
    `${tag}@example.invalid`,
  );
  const { offeringId, priceId } = await insertRanOffering(db, {
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
    ...(opts.accountCurrency ? { currency: opts.accountCurrency } : {}),
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
    rows: opts.cells ?? SAMPLE_5G_LKP_ROWS,
    actorId,
  });
  return { partyRoleId, productInventoryId, offeringId, priceId };
}

export interface RatingPipelineOptions {
  databaseUrl: string;
  rolePassword: string;
  engineVersion: string;
  mno: string;
  productName: string;
  now: string;
  tmpPrefix: string;
  // The ratecard cells writeUdr emits one row for (default: Sample-5G's three).
  cells?: readonly RanLkpRow[];
  // PRP's ratecard_coverage_enforcement (default: the production HARD_STOP).
  coverageEnforcement?: "HARD_STOP" | "WARN";
  // The flow revision RP/RL stamp (default 1).
  flowRevision?: number;
}

// One explicit `.udr` row. `datetime` is the feed's naive config-TZ
// (Asia/Kuala_Lumpur) instant; `mno` defaults to the pipeline's MNO, and the
// district / service_code are the cell's own labels.
export interface UdrRow {
  cell: RanLkpRow;
  datetime: string;
  volume: number | string;
  mno?: string;
}

export interface RatingPipelineDirs {
  landing: string;
  error: string;
  logs: string;
  archive: string;
  work: string;
}

export interface RatingPipeline {
  dirs: RatingPipelineDirs;
  // One clean row per ratecard cell; `volumes[i]` is cell i's usage. Rows are
  // dated 2026-08-14T10:0i (config TZ) unless `datetime` is given.
  writeUdr(name: string, volumes: readonly number[], datetime?: string): string;
  writeUdrRows(name: string, rows: readonly UdrRow[]): string;
  runPrp(sourcePath: string, execId: string): string;
  runRp(manifestUri: string, execId: string, roundingMode?: string): string;
  runRl(manifestUri: string, execId: string): string;
  // Any runtime module under the pipeline's env; returns the trimmed stdout.
  runModule(module: string, args: string[]): string;
}

// Creates fresh landing/error/logs/archive/work dirs and returns runners that
// invoke the runtime modules as rating_runtime; runPrp/runRp/runRl return the
// module's last stdout line (the manifest URI it hands off).
export function createRatingPipeline(
  opts: RatingPipelineOptions,
): RatingPipeline {
  const url = new URL(opts.databaseUrl);
  const root = mkdtempSync(join(tmpdir(), opts.tmpPrefix));
  const dirs: RatingPipelineDirs = {
    landing: join(root, "landing"),
    error: join(root, "error"),
    logs: join(root, "logs"),
    archive: join(root, "archive"),
    work: join(root, "work"),
  };
  for (const d of Object.values(dirs)) {
    mkdirSync(d, { recursive: true });
  }
  const env = {
    ...process.env,
    SECRET_RATING_RUNTIME_PASSWORD: opts.rolePassword,
    RATING_DB_HOST: url.hostname,
    RATING_DB_PORT: url.port || "5432",
    RATING_DB_NAME: url.pathname.replace(/^\//, ""),
    RATING_DB_USER: "rating_runtime",
    RATING_LANDING_DIR: dirs.landing,
    RATING_ERROR_DIR: dirs.error,
    RATING_LOGS_DIR: dirs.logs,
    RATING_ARCHIVE_DIR: dirs.archive,
    RATING_ENGINE_VERSION: opts.engineVersion,
  };
  const cells = opts.cells ?? SAMPLE_5G_LKP_ROWS;
  const flowRevision = String(opts.flowRevision ?? 1);

  function runModule(module: string, args: string[]): string {
    if (!PYTHON3) throw new Error("no absolute python3 (set RATING_PYTHON3)");
    const out = execFileSync(PYTHON3, ["-m", module, ...args], {
      cwd: RATING_WORKER_DIR,
      encoding: "utf8",
      env,
    });
    return out.trim();
  }
  const lastLine = (out: string): string => out.split("\n").pop() as string;

  function writeUdrRows(name: string, rows: readonly UdrRow[]): string {
    const lines = rows.map((row) =>
      [
        row.mno ?? opts.mno,
        SAMPLE_5G_COMMERCIAL_UNIT,
        row.cell.polygonId,
        row.datetime,
        String(row.volume),
        row.cell.district ?? "",
        row.cell.serviceCode ?? "",
      ].join(","),
    );
    const path = join(dirs.landing, name);
    writeFileSync(path, [UDR_HEADER, ...lines].join("\n") + "\n", "utf8");
    return path;
  }

  return {
    dirs,
    writeUdr(name, volumes, datetime) {
      // One volume per cell: a short list would write "undefined" volumes.
      if (volumes.length !== cells.length) {
        throw new Error(
          `writeUdr: ${volumes.length} volumes for ${cells.length} cells`,
        );
      }
      // Naive config-TZ instants, formatted via UTC so no host TZ applies.
      const start = Date.UTC(2026, 7, 14, 10, 0, 0);
      return writeUdrRows(
        name,
        cells.map((cell, i) => ({
          cell,
          // One minute apart from 10:00; calendar arithmetic rolls past
          // midnight into the next date, so any cell count stays valid.
          datetime:
            datetime ??
            new Date(start + i * 60_000).toISOString().slice(0, 19),
          volume: volumes[i]!,
        })),
      );
    },
    writeUdrRows,
    runModule,
    runPrp(sourcePath, execId) {
      return lastLine(
        runModule("runtime.prp", [
          "--source-file",
          sourcePath,
          "--udr-type",
          "RAN_USAGE",
          "--profile",
          RAN_USAGE_FEED_PROFILE,
          "--file-key-rule",
          RAN_USAGE_FILE_KEY_RULE,
          "--reject-threshold",
          "0",
          "--chunk-size",
          "10000",
          "--subscription-product-name",
          opts.productName,
          "--ratecard-coverage-enforcement",
          opts.coverageEnforcement ?? "HARD_STOP",
          "--workflow-execution-id",
          execId,
          "--now",
          opts.now,
          "--work-dir",
          dirs.work,
        ]),
      );
    },
    runRp(manifestUri, execId, roundingMode = "HALF_UP") {
      return lastLine(
        runModule("runtime.rp", [
          "--manifest",
          manifestUri,
          "--udr-type",
          "RAN_USAGE",
          "--rounding-mode",
          roundingMode,
          "--subscriber-ref-column",
          "product_inventory_id",
          "--workflow-execution-id",
          execId,
          "--flow-revision",
          flowRevision,
          "--work-dir",
          dirs.work,
        ]),
      );
    },
    runRl(manifestUri, execId) {
      return lastLine(
        runModule("runtime.rl", [
          "--manifest",
          manifestUri,
          "--udr-type",
          "RAN_USAGE",
          "--landing-dir",
          dirs.landing,
          "--workflow-execution-id",
          execId,
          "--flow-revision",
          flowRevision,
        ]),
      );
    },
  };
}

export function readManifest(uri: string): Record<string, unknown> {
  return JSON.parse(readFileSync(fileURLToPath(uri.trim()), "utf8"));
}
