import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
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
import type { UsageRateComponent } from "@/validation/product/pricing-component.schema";
import { udrBatch } from "@/db/schema/rating/udr-batch";
import {
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  ratingPython3,
  readManifest as readHarnessManifest,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
} from "@/tests/helpers/rating-ran-harness";
import {
  SAMPLE_5G_COMMERCIAL_UNIT,
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_RATECARD_STATE,
  SAMPLE_5G_START_DATE,
} from "@/db/seeds/sample/sample-5g-fixture";
import { formatUdrResource } from "@/validation/rating/udr-resource.schema";

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
// real rl task invoking runtime.rl, the outputs.rp.vars.uri handoff, and — since
// rm10 — that the supersede hook is real, not the rm09 `# STUB: rm10` marker)
// and that rl.py uses COPY, not per-record INSERT. The
// DB-gated describe shells out to the REAL `python3 -m runtime.prp` -> runtime.rp
// -> runtime.rl exactly as the flow's three tasks invoke them — a black-box test
// of the actual loader, not a TS reimplementation. Requires the harness's
// absolute python3 (`RATING_PYTHON3` or the fixed system path — never a PATH
// lookup) with the worker's requirements (psycopg + polars); skipped loudly, like the
// DATABASE_URL gate, when unavailable — same posture as the rm06/rm07/rm08 suites
// (see ratemgmt-progress-tracker.md: not run in a session without a live test
// Postgres + the worker deps).
const databaseUrl = process.env.DATABASE_URL;
const workerDir = join(
  process.cwd(),
  "workflow-management",
  "worker",
  "workflow-engine",
);

// One interpreter for every python call in this file: the harness's (rm29
// review — gating on one python3 and reading Parquet with another let a
// suite run and then fail on a missing module).
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm09-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
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

// pm51-spec D6 — component-envelope builder replacing the pre-reshape flat
// usage price-row literal (same shape `db/seeds/demo/product-demo.ts`'s
// `buildPriceEnvelope` builds in production).
function usageRateEnvelope(
  ratePerUnit: string,
  unitOfMeasure: "Mbps",
): UsageRateComponent {
  return {
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: null,
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { ratePerUnit, rateCardLookUp: null },
  };
}

// Every row of one Parquet file as JSON — nulls kept, datetimes as UTC ISO
// strings — so values reach the test byte for byte.
function parquetRows(path: string): Record<string, string | null>[] {
  const out = execFileSync(
    ratingPython3(),
    [
      "-c",
      [
        "import json,sys,datetime,polars",
        "def s(v):",
        "  if v is None: return None",
        "  if isinstance(v, datetime.datetime): return v.astimezone(datetime.timezone.utc).isoformat()",
        "  return str(v)",
        "f=polars.read_parquet(sys.argv[1])",
        "print(json.dumps([{k:s(v) for k,v in r.items()} for r in f.iter_rows(named=True)]))",
      ].join("\n"),
      path,
    ],
    { cwd: workerDir, encoding: "utf8" },
  );
  return JSON.parse(out) as Record<string, string | null>[];
}
function firstLine(lines: readonly string[]): string {
  const line = lines.at(0);
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

// Shared by both DB-gated blocks below: a freshly migrated database with the
// event catalog seeded (roles are applied by each block).
async function openMigratedDb(): Promise<{
  sql: postgresjs.Sql;
  db: Database;
}> {
  assertTestDatabaseUrl(databaseUrl as string);
  const sql = postgres(databaseUrl as string, { max: 1 });
  try {
    await dropModuleSchemas(sql);
    const db = drizzle(sql, { schema });
    await migrate(db, {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });
    await seedEventCatalog(db);
    return { sql, db };
  } catch (error) {
    // The caller never receives `sql` on failure, so its afterAll cannot
    // close it — close it here rather than leak the connection.
    await sql.end();
    throw error;
  }
}
async function countRated(db: Database, batchId: string): Promise<number> {
  const rows = await db
    .select({ n: dsql<number>`count(*)::int` })
    .from(udrRated)
    .where(eq(udrRated.udrRefBatchId, batchId));
  return rows[0]!.n;
}
async function readBatch(db: Database, batchId: string) {
  const rows = await db
    .select()
    .from(udrBatch)
    .where(eq(udrBatch.batchId, batchId));
  return rows[0]!;
}
// The billing month of an instant, in rating's config zone (rating.period_of(),
// Asia/Kuala_Lumpur, X1) — not the UTC month, or a held row at 00:00–07:59
// +08 on the 1st fails udr_rated_period_matches_check before the guard runs.
function monthBucket(iso: string): string {
  const [y, m] = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
  })
    .format(new Date(iso))
    .split("-");
  return `${y}-${m}-01`;
}
// A live udr_rated row a bill run holds, built from a rated Parquet row so
// udr_key is read back, never reimplemented.
function heldRowValues(
  src: Record<string, string | null>,
  opts: {
    status: "BILL_DRAFT" | "BILL_APPROVED";
    rateType: "FLAT" | "PER_UNIT";
    refBatchId: string;
    sourceFile: string;
    engineVersion: string;
    billrunRefId: string;
  },
) {
  return {
    partitionPeriod: monthBucket(src.start_datetime as string),
    udrType: src.udr_type as string,
    startDatetime: new Date(src.start_datetime as string),
    endDatetime: new Date(src.end_datetime as string),
    status: opts.status,
    udrSubscriptionRefId: src.udr_subscription_ref_id as string,
    udrKey: src.udr_key as string,
    udrUsageQuantity: src.udr_usage_quantity as string,
    udrUsageUnit: src.udr_usage_unit as string,
    udrRateType: opts.rateType,
    udrRatedPrice: src.udr_rated_price as string,
    udrRatedPriceRaw: src.udr_rated_price_raw as string,
    udrRoundingMode: src.udr_rounding_mode as string,
    udrCurrency: src.udr_currency as string,
    udrRefBatchId: opts.refBatchId,
    udrSourceFile: opts.sourceFile,
    ratingEngineVersion: opts.engineVersion,
    ratingFlowRevision: 1,
    billrunRefId: opts.billrunRefId,
    udrResource: src.udr_resource ?? null,
  };
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm09 D1/D4/D8.
// ---------------------------------------------------------------------
describe("rl flow wiring + COPY (rm09-spec D1/D4/D8 — static)", () => {
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

  it("the rl task invokes the real runtime.rl module, consuming outputs.rp.vars.uri", () => {
    expect(template).toMatch(/python3 -m runtime\.rl/);
    const rlBlock = template.slice(template.indexOf("id: rl"));
    expect(rlBlock).toMatch(/python3 -m runtime\.rl/);
    expect(rlBlock).toMatch(/--manifest "\{\{ outputs\.rp\.vars\.uri \}\}"/);
    expect(rlBlock).toMatch(/--landing-dir/);
    expect(rlBlock).toMatch(
      /--workflow-execution-id "\{\{ execution\.id \}\}"/,
    );
    // rl is a module invocation now, not the rm06/rm07/rm08 inline python stub.
    expect(rlBlock).not.toMatch(/python3 -c/);
  });

  it("rm10 fills the supersede hook inside RL's one transaction (D8)", () => {
    // rm09 shipped this as a named `# STUB: rm10` no-op; rm10 replaced it with
    // the real batch-level supersession, still inside load_and_reconcile's
    // single `with db.transaction(conn):` block, immediately before the COPY.
    expect(rlSource).not.toMatch(/# STUB: rm10/);
    expect(rlSource).toMatch(/supersede_batch/);
    expect(rlSource).toMatch(/batch-level supersession/i);
  });

  it("RL bulk-inserts via COPY, never per-record INSERT (D4, Inv #10)", () => {
    expect(rlSource).toMatch(/copy_insert/);
    // No row-by-row INSERT INTO udr_rated — the write path is COPY.
    expect(rlSource).not.toMatch(/INSERT\s+INTO\s+rating\.udr_rated/i);
  });
});

// ---------------------------------------------------------------------
// bm48-spec D2/D4 + rm28 — RL's COPY row builder, the geo columns and
// udr_resource. Exercises the real `runtime.rl.build_chunk_rows` on hand-built
// rated frames (python3 only, no DB): the columns are appended last, copied
// as-is when present, required for RAN_USAGE (the loud guard that PRP stamped +
// RP carried them), and written NULL only for a usage type that reads no
// ratecard. udr_resource is stricter than the geo columns: a RAN_USAGE row
// with it NULL or empty also fails (Inv 28). argv[3] is the udr_resource mode:
// 'absent', 'null', 'empty', or a value to carry.
// ---------------------------------------------------------------------
const BUILD_ROW_SCRIPT = [
  "import sys, json",
  "from datetime import datetime, timezone",
  "import polars as pl",
  "from runtime import rl",
  "udr_type, with_geo, resource = sys.argv[1], sys.argv[2] == '1', sys.argv[3]",
  "ts = datetime(2026, 8, 14, 10, tzinfo=timezone.utc)",
  "data = {'udr_type': [udr_type], 'start_datetime': [ts], 'end_datetime': [ts],",
  "  'udr_subscription_ref_id': ['PIV1'], 'udr_key': ['K1'],",
  "  'udr_usage_quantity': ['1.000000'], 'udr_usage_unit': ['EA'],",
  "  'udr_usage_rate': ['1.000000'], 'udr_rate_type': ['PER_UNIT'],",
  "  'udr_rate_detail': ['{}'], 'udr_rated_price': ['1.00'],",
  "  'udr_rated_price_raw': ['1.000000'], 'udr_rounding_mode': ['HALF_UP'],",
  "  'udr_currency': ['MYR'], 'udr_price_ref': ['OPP1'],",
  "  'udr_price_effective_date': [ts], 'udr_price_override_ref': [None],",
  "  'udr_ref_batch_id': ['B1'], 'udr_source_file': ['f.csv'],",
  "  'rating_engine_version': ['v'], 'rating_flow_revision': [1],",
  "  'rated_datetime': [ts]}",
  "if with_geo:",
  "  data['state'] = ['STATE-1']",
  "  data['district'] = pl.Series('district', [None], dtype=pl.Utf8)",
  "if resource == 'null':",
  "  data['udr_resource'] = pl.Series('udr_resource', [None], dtype=pl.Utf8)",
  "elif resource == 'empty':",
  "  data['udr_resource'] = ['']",
  "elif resource != 'absent':",
  "  data['udr_resource'] = [resource]",
  "try:",
  "  row = rl.build_chunk_rows(pl.DataFrame(data))[0]",
  "  print(json.dumps({'ok': True, 'tail': list(rl.COPY_COLUMNS[-3:]),",
  "    'state': row[rl.COPY_COLUMNS.index('state')],",
  "    'district': row[rl.COPY_COLUMNS.index('district')],",
  "    'udr_resource': row[rl.COPY_COLUMNS.index('udr_resource')]}))",
  // The guard that fired is reported (type + message) so each fail-loud case
  // can assert it is THIS guard, not another KeyError/ValueError (rm29 review).
  "except (KeyError, ValueError) as e:",
  "  print(json.dumps({'ok': False, 'error': type(e).__name__, 'message': str(e)}))",
].join("\n");

const COPY_TAIL = ["state", "district", "udr_resource"];
const RESOURCE = "STATE-1|DIST-1|2026-01-01";

describe.skipIf(!pythonReady)(
  "rl COPY row builder carries udr_rated geo + udr_resource (bm48-spec D2/D4, rm28-spec, requires python3+runtime)",
  () => {
    function buildRow(udrType: string, withGeo: boolean, resource: string) {
      const out = execFileSync(
        ratingPython3(),
        ["-c", BUILD_ROW_SCRIPT, udrType, withGeo ? "1" : "0", resource],
        { cwd: workerDir, encoding: "utf8" },
      );
      return JSON.parse(out.trim().split(/\r?\n/).pop() as string) as {
        ok: boolean;
        tail?: string[];
        state?: string | null;
        district?: string | null;
        udr_resource?: string | null;
        error?: string;
        message?: string;
      };
    }

    // A fail-loud case: the named exception, from the guard whose message
    // carries `fragment`.
    function expectGuard(
      result: ReturnType<typeof buildRow>,
      error: "KeyError" | "ValueError",
      fragment: string,
    ) {
      expect(result.ok).toBe(false);
      expect(result.error).toBe(error);
      expect(result.message).toContain(fragment);
    }

    it("appends state/district last and copies them as-is (NULL stays NULL)", () => {
      expect(buildRow("RAN_USAGE", true, RESOURCE)).toEqual({
        ok: true,
        tail: COPY_TAIL,
        state: "STATE-1",
        district: null,
        udr_resource: RESOURCE,
      });
    });

    it("a RAN_USAGE chunk missing the geo columns fails loud (KeyError guard)", () => {
      expectGuard(
        buildRow("RAN_USAGE", false, RESOURCE),
        "KeyError",
        "has no 'state' column",
      );
    });

    it("a usage type that reads no ratecard writes NULL geo when the columns are absent", () => {
      expect(buildRow("SMS_USAGE", false, "absent")).toEqual({
        ok: true,
        tail: COPY_TAIL,
        state: null,
        district: null,
        udr_resource: null,
      });
    });

    it("rm28 1. udr_resource is the last COPY column and a present value is copied as is", () => {
      const row = buildRow("RAN_USAGE", true, RESOURCE);
      expect(row.tail).toEqual(COPY_TAIL);
      expect(row.udr_resource).toBe(RESOURCE);
    });

    it("rm28 2. a RAN_USAGE chunk without udr_resource fails loud", () => {
      expectGuard(
        buildRow("RAN_USAGE", true, "absent"),
        "KeyError",
        "has no 'udr_resource' column",
      );
    });

    it.each(["null", "empty"])(
      "rm28 3. a RAN_USAGE chunk whose udr_resource is %s fails loud",
      (mode) => {
        expectGuard(
          buildRow("RAN_USAGE", true, mode),
          "ValueError",
          "has an empty 'udr_resource'",
        );
      },
    );

    it("rm28 4b. a usage type that reads no ratecard but carries a udr_resource value fails loud (broken handoff)", () => {
      expectGuard(
        buildRow("SMS_USAGE", false, RESOURCE),
        "ValueError",
        "carries 'udr_resource'",
      );
    });

    it.each(["absent", "null"])(
      "rm28 4. a usage type that reads no ratecard writes NULL udr_resource (column %s)",
      (mode) => {
        expect(buildRow("SMS_USAGE", false, mode)).toEqual({
          ok: true,
          tail: COPY_TAIL,
          state: null,
          district: null,
          udr_resource: null,
        });
      },
    );
  },
);

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

      // OFF1 with a usage price in MYR. Inserted DRAFT, priced, then flipped
      // to ACTIVE — pm36's DRAFT-guard trigger refuses a price write once
      // the parent offering leaves DRAFT (same pattern as
      // `db/seeds/demo/product-demo.ts`).
      const [off1] = await db
        .insert(productOffering)
        .values({
          name: "rm09-OFF1",
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "DRAFT",
          lastEditedBy: userId,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const off1Id = off1!.productOfferingId;
      // pm51-spec D6 — re-keyed, same rate/currency/start date.
      await db.insert(productOfferingPrice).values({
        productOfferingId: off1Id,
        name: "OFF1 usage",
        componentType: "usage_rate",
        priceComponent: usageRateEnvelope("0.0050", "Mbps"),
        unitOfMeasure: "Mbps",
        currency: CURRENCY,
        startDateTime: new Date("2026-01-01T00:00:00Z"),
      });
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "ACTIVE" })
        .where(eq(productOffering.productOfferingId, off1Id));

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
      ({ sql, db } = await openMigratedDb());
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
      await dropModuleSchemas(sql);
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
        ratingPython3(),
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
        ratingPython3(),
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
        ratingPython3(),
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
    const readParquetRows = (fileUri: string) =>
      parquetRows(uriToPath(fileUri));

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
    const ratedCount = (batchId: string) => countRated(db, batchId);
    const batchRow = (batchId: string) => readBatch(db, batchId);

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
        udrSubscriptionRefId: collide.udr_subscription_ref_id as string,
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
    // bm25 — the BILL_DRAFT (in-flight) guard + billed-precedence.
    // -----------------------------------------------------------------
    // A live udr_rated row a bill run holds in flight, read straight from the
    // rated Parquet so udr_key is never reimplemented (matching test #8).
    const liveCollisionValues = (
      src: Record<string, string | null>,
      status: "BILL_DRAFT" | "BILL_APPROVED",
      sentinel: string,
      billrunRefId: string,
    ) =>
      heldRowValues(src, {
        status,
        rateType: "FLAT",
        refBatchId: sentinel,
        sourceFile: "prior-run.csv",
        engineVersion: ENGINE_VERSION,
        billrunRefId,
      });

    it("bm25. a BILL_DRAFT collision refuses the whole batch: zero rows, REFUSED, LOAD_BLOCKED_INFLIGHT naming the bill run", async () => {
      const { rpManifestUri, manifest, rated } = prepRated(
        "20260210",
        cleanRows("inflight"),
      );
      const batchId = manifest.batch_id as string;
      // A live BILL_DRAFT row (an in-flight bill run holds the claim) colliding
      // with one incoming record. The widened pre-check refuses the whole batch.
      const collide = rated[0]!;
      await db
        .insert(udrRated)
        .values(
          liveCollisionValues(
            collide,
            "BILL_DRAFT",
            "SENTINEL-DRAFT",
            "BR-INFLIGHT-042",
          ),
        );

      runRlExpectFail(rpManifestUri, "rl-inflight");

      // Zero rows written for THIS batch (the whole batch refused).
      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("REFUSED");
      // The raw file stays in landing/ (never archived on a refusal).
      expect(batch.archiveFilePath).toBeNull();
      expect(existsSync(join(landingDir, "RAN_USAGE_20260210.csv"))).toBe(true);
      // LOAD_BLOCKED_INFLIGHT (MINOR) names the blocking bill_run_id.
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-inflight")));
      expect(line.event_code).toBe("LOAD_BLOCKED_INFLIGHT");
      expect(line.additional_info.blocking_bill_run_ids).toContain(
        "BR-INFLIGHT-042",
      );
      const collisions = line.additional_info.collisions as {
        udr_key: string;
        billrun_ref_id: string;
      }[];
      expect(collisions[0]!.udr_key).toBe(collide.udr_key);
      expect(collisions[0]!.billrun_ref_id).toBe("BR-INFLIGHT-042");
    });

    it("bm25. a BILL_APPROVED collision takes precedence over a BILL_DRAFT one (billed wins)", async () => {
      const { rpManifestUri, manifest, rated } = prepRated(
        "20260220",
        cleanRows("precedence"),
      );
      const batchId = manifest.batch_id as string;
      // Both classes present: an approved collision on the first record and an
      // in-flight collision on the second. The billed refusal must win.
      await db
        .insert(udrRated)
        .values([
          liveCollisionValues(
            rated[0]!,
            "BILL_APPROVED",
            "SENTINEL-APPROVED",
            "BR-APPROVED-9",
          ),
          liveCollisionValues(
            rated[1]!,
            "BILL_DRAFT",
            "SENTINEL-DRAFT",
            "BR-INFLIGHT-9",
          ),
        ]);

      runRlExpectFail(rpManifestUri, "rl-precedence");

      expect(await ratedCount(batchId)).toBe(0);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("REFUSED");
      const line = JSON.parse(firstLine(logLinesFor("RL", "rl-precedence")));
      expect(line.event_code).toBe("LOAD_BLOCKED_BILLED");
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
        udrSubscriptionRefId: collide.udr_subscription_ref_id as string,
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
      const before = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(udrRated);
      runRl(dupRpUri, "rl-noop");
      const after = await db
        .select({ n: dsql<number>`count(*)::int` })
        .from(udrRated);
      // (No batch_id to filter on for a DISCARDED manifest; assert the DISCARDED
      // redelivery added nothing under its varied name in landing.)
      expect(after[0]!.n).toBe(before[0]!.n);
      expect(logLinesFor("RL", "rl-noop")).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------
// rm28-spec §2 (live-DB) — RL writes udr_resource and the guard, supersession
// and the live-row constraint all work on raw keys (Inv 27, 28; R4, R5).
//
// Runs on the maintained `rating-ran-harness` (the production 7-column profile
// and the Sample-5G graph with its ratecard), not the block above: that block
// still invokes PRP with the pre-rm21 5-column CLI and seeds no ratecard, so it
// cannot produce a udr_resource (its failures are a recorded baseline, billing
// known-issues §21). Each case seeds its own graph (own MNO), because the
// live-row key (partition_period, udr_key, is_live) holds one live row per cell
// per month and writeUdr's rows are all dated 2026-08-14.
// ---------------------------------------------------------------------
const RM28_ROLE_PW = "rm28-test-only-pw";
const RM28_ENGINE_VERSION = "rm28-test-engine@sha256:deadbeef";
const RM28_VOLUMES = [100, 200, 300] as const;
// A case variant of SAMPLE_5G_LKP_ROWS[0]'s polygon, written out by hand
// (§0.1 rule 7: no case function is applied to a key value, even in a test).
const CASE_VARIANT_POLYGON = "pcu-042_04";

function ratedChunkUris(rpManifestUri: string): string[] {
  return readHarnessManifest(rpManifestUri).rated_chunk_uris as string[];
}

// The rated rows of an RP manifest.
function readRatedRows(rpManifestUri: string): Record<string, string | null>[] {
  return ratedChunkUris(rpManifestUri).flatMap((uri) =>
    parquetRows(fileURLToPath(uri)),
  );
}

// rm28 checklist — break the RP→RL handoff in place: drop udr_resource from
// every rated chunk ("absent") or blank it on every row ("empty").
function breakRatedChunks(rpManifestUri: string, mode: "absent" | "empty") {
  const transform =
    mode === "absent"
      ? "f.drop('udr_resource')"
      : "f.with_columns(polars.lit('').alias('udr_resource'))";
  for (const uri of ratedChunkUris(rpManifestUri)) {
    const path = fileURLToPath(uri);
    execFileSync(
      ratingPython3(),
      [
        "-c",
        `import polars,sys;f=polars.read_parquet(sys.argv[1]);${transform}.write_parquet(sys.argv[1])`,
        path,
      ],
      { cwd: workerDir, stdio: "ignore" },
    );
  }
}

function expectedResource(district: string | null): string {
  return formatUdrResource({
    state: SAMPLE_5G_RATECARD_STATE,
    district,
    polygonStartDate: SAMPLE_5G_START_DATE,
  });
}

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm28 — RL writes udr_resource; guard + supersession on raw keys (rm28-spec §2, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let ratingRuntime: postgresjs.Sql | undefined;

    beforeAll(async () => {
      ({ sql, db } = await openMigratedDb());
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(
        `ALTER ROLE rating_runtime WITH PASSWORD '${RM28_ROLE_PW}'`,
      );
      const url = new URL(databaseUrl as string);
      url.username = "rating_runtime";
      url.password = RM28_ROLE_PW;
      ratingRuntime = postgres(url.toString(), { max: 1 });
    }, 120_000);

    afterAll(async () => {
      await ratingRuntime?.end();
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    const ratedCount = (batchId: string) => countRated(db, batchId);
    const batchRow = (batchId: string) => readBatch(db, batchId);

    // One Sample-5G graph + its pipeline per case, keyed by `tag`.
    async function graph(
      tag: string,
    ): Promise<{ pipeline: RatingPipeline; mno: string; cardName: string }> {
      const mno = `MNO-RM28-${tag.toUpperCase()}`;
      const productName = `Sample 5G Services rm28 ${tag}`;
      const cardName = `RATECARD_RM28_${tag.toUpperCase()}`;
      await seedSample5gRatingGraph(db, {
        tag: `rm28-${tag}`,
        mno,
        productName,
        priceName: `Sample 5G Usage Rate rm28 ${tag}`,
        cardName,
      });
      const pipeline = createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: RM28_ROLE_PW,
        engineVersion: RM28_ENGINE_VERSION,
        mno,
        productName,
        now: "2026-09-01T00:00:00Z",
        tmpPrefix: `rm28-${tag}-`,
      });
      return { pipeline, mno, cardName };
    }

    // file -> PRP -> RP; returns the RP manifest URI and the batch id.
    function prepRated(
      p: RatingPipeline,
      path: string,
      tag: string,
    ): { rpUri: string; batchId: string } {
      const prpUri = p.runPrp(path, `prp-${tag}`);
      const prp = readHarnessManifest(prpUri);
      expect(prp.status).toBe("PROCESSING");
      return {
        rpUri: p.runRp(prpUri, `rp-${tag}`),
        batchId: prp.batch_id as string,
      };
    }

    async function ratedRows(batchId: string) {
      return db
        .select({
          udrKey: udrRated.udrKey,
          udrResource: udrRated.udrResource,
          isLive: udrRated.isLive,
          status: udrRated.status,
        })
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, batchId));
    }

    function rowForPolygon<T extends { udrKey: string }>(
      rows: T[],
      polygonId: string,
    ): T {
      const row = rows.find((r) =>
        r.udrKey.endsWith(`|polygon_id=${polygonId}`),
      );
      expect(row, `a rated row for ${polygonId}`).toBeDefined();
      return row!;
    }

    // A live row a bill run holds, keyed by a rated Parquet row's raw udr_key
    // (read back, never rebuilt — as the guard cases above do).
    const liveHeldRow = (
      src: Record<string, string | null>,
      status: "BILL_DRAFT" | "BILL_APPROVED",
      billrunRefId: string,
    ) =>
      heldRowValues(src, {
        status,
        rateType: "PER_UNIT",
        refBatchId: `SENTINEL-${status}`,
        sourceFile: "prior-run.udr",
        engineVersion: RM28_ENGINE_VERSION,
        billrunRefId,
      });

    it("6. a clean RAN_USAGE load writes udr_resource = formatUdrResource(cell) on every row", async () => {
      const { pipeline } = await graph("load");
      const { rpUri, batchId } = prepRated(
        pipeline,
        pipeline.writeUdr("rating-input-file-202608140281.udr", RM28_VOLUMES),
        "load",
      );
      const rated = readRatedRows(rpUri);
      pipeline.runRl(rpUri, "rl-load");

      const rows = await ratedRows(batchId);
      expect(rows).toHaveLength(SAMPLE_5G_LKP_ROWS.length);
      for (const cell of SAMPLE_5G_LKP_ROWS) {
        const row = rowForPolygon(rows, cell.polygonId);
        expect(row.udrResource).toBe(expectedResource(cell.district));
        // The value RL wrote is the one PRP stamped and RP carried.
        const src = rated.find((r) => r.udr_key === row.udrKey);
        expect(src?.udr_resource).toBe(row.udrResource);
      }
      expect((await batchRow(batchId)).status).toBe("COMPLETE");
    }, 120_000);

    it.each([
      ["BILL_APPROVED", "LOAD_BLOCKED_BILLED", "billed", "202608140282"],
      ["BILL_DRAFT", "LOAD_BLOCKED_INFLIGHT", "inflight", "202608140283"],
    ] as const)(
      "7. a raw-key collision with a live %s row refuses the batch whole (%s), zero rows",
      async (status, eventCode, tag, stamp) => {
        const { pipeline } = await graph(tag);
        const { rpUri, batchId } = prepRated(
          pipeline,
          pipeline.writeUdr(`rating-input-file-${stamp}.udr`, RM28_VOLUMES),
          tag,
        );
        const collide = readRatedRows(rpUri)[0]!;
        // The key is raw: the Sample-5G polygon keeps its upper case.
        expect(collide.udr_key).toMatch(/\|polygon_id=PCU-/);
        await db
          .insert(udrRated)
          .values(liveHeldRow(collide, status, `BR-RM28-${tag}`));

        expect(() => pipeline.runRl(rpUri, `rl-${tag}`)).toThrow();

        expect(await ratedCount(batchId)).toBe(0);
        const batch = await batchRow(batchId);
        expect(batch.status).toBe("REFUSED");
        expect(batch.archiveFilePath).toBeNull();
        expect(batch.errorSummary?.startsWith(`${eventCode}:`)).toBe(true);
      },
      120_000,
    );

    it("8. two keys differing only in the case of the polygon both load and both stay live (R4 accepted risk)", async () => {
      const { pipeline, mno, cardName } = await graph("case");
      const first = SAMPLE_5G_LKP_ROWS[0]!;
      // A second card cell whose polygon differs from the first only in case.
      await sql`
        INSERT INTO product.ratecard_ran_usage_lkp
          (ratecard_version_id, mno_public_key, commercial_unit_public_key,
           polygon_id, polygon_start_date, state, district,
           lkp_subscriber_ref_id, service_code)
        SELECT l.ratecard_version_id, l.mno_public_key, l.commercial_unit_public_key,
               ${CASE_VARIANT_POLYGON}, l.polygon_start_date, l.state, 'OTHER',
               l.lkp_subscriber_ref_id, l.service_code
          FROM product.ratecard_ran_usage_lkp l
          JOIN product.ratecard_version v
            ON v.ratecard_version_id = l.ratecard_version_id
         WHERE v.card_name = ${cardName} AND v.status = 'ACTIVE'
           AND l.polygon_id = ${first.polygonId}`;
      await sql`
        UPDATE product.ratecard_version SET row_count = row_count + 1
         WHERE card_name = ${cardName} AND status = 'ACTIVE'`;
      // Every ACTIVE cell must be in the feed (HARD_STOP coverage), so the
      // variant row is appended to the three Sample-5G rows.
      const path = pipeline.writeUdr(
        "rating-input-file-202608140284.udr",
        RM28_VOLUMES,
      );
      appendFileSync(
        path,
        [
          mno,
          SAMPLE_5G_COMMERCIAL_UNIT,
          CASE_VARIANT_POLYGON,
          "2026-08-14T10:15:00",
          "50",
          "OTHER",
          first.serviceCode ?? "",
        ].join(",") + "\n",
        "utf8",
      );
      const { rpUri, batchId } = prepRated(pipeline, path, "case");
      pipeline.runRl(rpUri, "rl-case");

      const rows = await ratedRows(batchId);
      expect(rows).toHaveLength(SAMPLE_5G_LKP_ROWS.length + 1);
      const upper = rowForPolygon(rows, first.polygonId);
      const lower = rowForPolygon(rows, CASE_VARIANT_POLYGON);
      expect(upper.udrKey).not.toBe(lower.udrKey);
      expect(upper.isLive).toBe(true);
      expect(lower.isLive).toBe(true);
      expect(upper.udrResource).toBe(expectedResource(first.district));
      expect(lower.udrResource).toBe(expectedResource("OTHER"));
    }, 120_000);

    it("9. a reissue of the same file_key supersedes run 1's raw-key rows; one live row per key, new rows carry udr_resource", async () => {
      const { pipeline } = await graph("reissue");
      const run1 = prepRated(
        pipeline,
        pipeline.writeUdr("rating-input-file-202608140285.udr", RM28_VOLUMES),
        "reissue-1",
      );
      pipeline.runRl(run1.rpUri, "rl-reissue-1");
      // Different volumes: a byte-identical re-drop is DISCARDED as a duplicate.
      const run2 = prepRated(
        pipeline,
        pipeline.writeUdr(
          "rating-input-file-202608140285_v2.udr",
          RM28_VOLUMES.map((v) => v + 1),
        ),
        "reissue-2",
      );
      pipeline.runRl(run2.rpUri, "rl-reissue-2");

      const old = await ratedRows(run1.batchId);
      expect(old).toHaveLength(SAMPLE_5G_LKP_ROWS.length);
      expect(old.every((r) => r.status === "SUPERSEDED")).toBe(true);
      expect(old.every((r) => r.isLive === null)).toBe(true);

      const fresh = await ratedRows(run2.batchId);
      expect(fresh).toHaveLength(SAMPLE_5G_LKP_ROWS.length);
      for (const cell of SAMPLE_5G_LKP_ROWS) {
        const row = rowForPolygon(fresh, cell.polygonId);
        expect(row.isLive).toBe(true);
        expect(row.udrResource).toBe(expectedResource(cell.district));
        // Same raw key in both runs; only run 2's is live.
        expect(rowForPolygon(old, cell.polygonId).udrKey).toBe(row.udrKey);
      }
      const live = await db
        .select({ udrKey: udrRated.udrKey })
        .from(udrRated)
        .where(
          and(
            inArray(udrRated.udrRefBatchId, [run1.batchId, run2.batchId]),
            eq(udrRated.isLive, true),
          ),
        );
      expect(live).toHaveLength(SAMPLE_5G_LKP_ROWS.length);
      expect(new Set(live.map((r) => r.udrKey)).size).toBe(live.length);
    }, 120_000);

    it("10. UPDATE … SET udr_resource is refused for rating_runtime", async () => {
      // Self-contained (rm29 review): its own row, not one left by case 6.
      const [row] = await db
        .insert(udrRated)
        .values({
          partitionPeriod: "2026-08-01",
          udrType: "RAN_USAGE",
          startDatetime: new Date("2026-08-14T02:00:00Z"),
          endDatetime: new Date("2026-08-14T02:00:00Z"),
          status: "RATED",
          udrSubscriptionRefId: "rm28-case10",
          udrKey: "commercial_unit=CU-10|mno_public_id=MNO-10|polygon_id=P-10",
          udrUsageQuantity: "1.000000",
          udrUsageUnit: "Mbps",
          udrRateType: "PER_UNIT",
          udrRatedPrice: "1.00",
          udrRatedPriceRaw: "1.000000",
          udrRoundingMode: "HALF_UP",
          udrCurrency: "MYR",
          udrRefBatchId: "SENTINEL-CASE10",
          udrSourceFile: "case10.udr",
          ratingEngineVersion: RM28_ENGINE_VERSION,
          ratingFlowRevision: 1,
          udrResource: RESOURCE,
        })
        .returning({
          partitionPeriod: udrRated.partitionPeriod,
          udrId: udrRated.udrId,
        });
      expect(row).toBeDefined();
      await expect(
        ratingRuntime!.unsafe(
          "UPDATE rating.udr_rated SET udr_resource = 'TAMPERED' WHERE partition_period = $1 AND udr_id = $2",
          [row!.partitionPeriod, row!.udrId],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it.each([
      ["absent", "202608140286"],
      ["empty", "202608140287"],
    ] as const)(
      "11. a RAN_USAGE rated chunk with udr_resource %s makes RL exit non-zero: zero rows, batch left PROCESSING, nothing archived",
      async (mode, stamp) => {
        const { pipeline } = await graph(`handoff-${mode}`);
        const path = pipeline.writeUdr(
          `rating-input-file-${stamp}.udr`,
          RM28_VOLUMES,
        );
        const { rpUri, batchId } = prepRated(pipeline, path, `handoff-${mode}`);
        breakRatedChunks(rpUri, mode);

        let stderr = "";
        try {
          pipeline.runRl(rpUri, `rl-handoff-${mode}`);
        } catch (error) {
          stderr = String((error as { stderr?: unknown }).stderr ?? "");
        }
        // RL's own guard fired (not some other failure).
        expect(stderr).toContain(
          mode === "absent"
            ? "has no 'udr_resource' column"
            : "has an empty 'udr_resource'",
        );
        // Uncaught by main(): the transaction rolled back and the batch is left
        // for rm11's stranded-batch reconciliation (rm28 spec, Design).
        expect(await ratedCount(batchId)).toBe(0);
        const batch = await batchRow(batchId);
        expect(batch.status).toBe("PROCESSING");
        expect(batch.archiveFilePath).toBeNull();
        expect(existsSync(path)).toBe(true); // still in landing/
      },
      120_000,
    );
  },
);
