import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
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
  SAMPLE_5G_RATECARD_STATE,
} from "@/db/seeds/sample/sample-5g-fixture";
import { udrRated } from "@/db/schema/rating/udr-rated";

// bm48-spec §Implementation §6 — geo on udr_rated is FROZEN at rating time:
//   * re-versioning the ratecard after rating leaves an already-rated row's
//     state/district unchanged, while a re-rate after the re-version reads the
//     new ACTIVE labels (closes bm45's D4 version-drift residual for post-bm48
//     rows);
//   * no runtime role (rating_runtime, app_runtime, billrun_runtime) may UPDATE
//     the columns — a real statement per role, refused with `permission denied`.
//
// Requires DATABASE_URL (a superuser on a disposable database) + python3 with the
// worker runtime; shells the real PRP/RP/RL modules exactly as the flow's tasks
// do. Skips loudly otherwise — same posture as every rm06+ DB-gated suite.
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

const ROLE_PW = "rm23-test-only-pw";
const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
);
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const BILLRUN_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/billrun-db-roles.sql",
);
const ENGINE_VERSION = "rm23-test-engine@sha256:deadbeef";
const MNO = "MNO-GEO-FROZEN";
const PRODUCT_NAME = "Sample 5G Services geo-frozen";
const CARD_NAME = "RATECARD_GEO_FROZEN";
const REVISED_STATE = "Johor";
const revisedDistrict = (i: number) => `REVISED-${i + 1}`;

// The production 7-column RAN_USAGE `.udr` feed profile (rm21 §6), as rm13 uses.
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
function roleUrl(base: string, user: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = ROLE_PW;
  return url.toString();
}

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm23 — udr_rated geo is frozen at rating (bm48-spec §6, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let dbParams: { host: string; port: string; name: string };
    let landingDir: string;
    let errorDir: string;
    let logsDir: string;
    let archiveDir: string;
    let workDir: string;
    const roleClients: Record<string, postgresjs.Sql> = {};

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
      // Provisioning order (infra/docs/db-role-verification.md):
      // platform -> rating -> billrun.
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await runSqlFile(sql, BILLRUN_ROLES_SQL);
      for (const role of ["rating_runtime", "app_runtime", "billrun_runtime"]) {
        await sql.unsafe(`ALTER ROLE ${role} WITH PASSWORD '${ROLE_PW}'`);
        roleClients[role] = postgres(roleUrl(databaseUrl as string, role), {
          max: 1,
        });
      }

      const actorId = await getOrCreateAppUser(
        db,
        "rm23-geo-actor",
        "rm23-geo@example.invalid",
      );
      const { offeringId } = await insertRanOffering(db, {
        name: PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate geo-frozen",
        udrTypeValue: "RAN_USAGE",
        cardName: CARD_NAME,
      });
      const partyRoleId = await insertRanCustomer(db, {
        organizationName: "rm23-geo-org",
        registrationNumber: "_SAMPLE_-RM23-GEO",
        partyRoleSpecification: { mnoPublicKey1: MNO },
        actorId,
      });
      const billCycleId = await insertRanBillCycle(db, {
        name: "rm23-geo-cycle",
        description: "rm23 geo fixture bill cycle",
        actorId,
      });
      const billingAccountId = await insertRanBillingAccount(db, {
        financialAccountName: "rm23-geo-fa",
        billingAccountName: "rm23-geo-ban",
        partyRoleId,
        billCycleId,
        actorId,
      });
      await insertRanSubscription(db, {
        partyRoleId,
        billingAccountId,
        offeringId,
        actorId,
        reason: "rm23 geo fixture",
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

      const root = mkdtempSync(join(tmpdir(), "rm23-geo-"));
      landingDir = join(root, "landing");
      errorDir = join(root, "error");
      logsDir = join(root, "logs");
      archiveDir = join(root, "archive");
      workDir = join(root, "work");
      for (const d of [landingDir, errorDir, logsDir, archiveDir, workDir]) {
        mkdirSync(d, { recursive: true });
      }
    }, 120_000);

    afterAll(async () => {
      for (const client of Object.values(roleClients)) {
        await client.end();
      }
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

    // `volumeBase` varies the bytes: a byte-identical reissue would be DISCARDED
    // by PRP as a duplicate redelivery rather than re-rated.
    function writeUdr(name: string, volumeBase: number): string {
      const rows = SAMPLE_5G_LKP_ROWS.map((cell, i) =>
        [
          MNO,
          SAMPLE_5G_COMMERCIAL_UNIT,
          cell.polygonId,
          `2026-08-14T10:0${i}:00`,
          String(volumeBase * (i + 1)),
          cell.district ?? "",
          cell.serviceCode ?? "",
        ].join(","),
      );
      const path = join(landingDir, name);
      writeFileSync(path, [UDR_HEADER, ...rows].join("\n") + "\n", "utf8");
      return path;
    }

    function runModule(module: string, args: string[]): string {
      const out = execFileSync("python3", ["-m", module, ...args], {
        cwd: workerDir,
        encoding: "utf8",
        env: runEnv(),
      });
      return out.trim().split("\n").pop() as string;
    }

    // file -> PRP -> RP -> RL, returning the batch id the rows were loaded under.
    function rateFile(name: string, tag: string, volumeBase: number): string {
      const prpUri = runModule("runtime.prp", [
        "--source-file",
        writeUdr(name, volumeBase),
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
        `prp-${tag}`,
        "--now",
        NOW,
        "--work-dir",
        workDir,
      ]);
      const batchId = (
        JSON.parse(readFileSync(fileURLToPath(prpUri.trim()), "utf8")) as {
          batch_id: string;
        }
      ).batch_id;
      const rpUri = runModule("runtime.rp", [
        "--manifest",
        prpUri,
        "--udr-type",
        "RAN_USAGE",
        "--rounding-mode",
        "HALF_UP",
        "--subscriber-ref-column",
        "product_inventory_id",
        "--workflow-execution-id",
        `rp-${tag}`,
        "--flow-revision",
        "1",
        "--work-dir",
        workDir,
      ]);
      runModule("runtime.rl", [
        "--manifest",
        rpUri,
        "--udr-type",
        "RAN_USAGE",
        "--landing-dir",
        landingDir,
        "--workflow-execution-id",
        `rl-${tag}`,
        "--flow-revision",
        "1",
      ]);
      return batchId;
    }

    // polygon -> [state, district] for one batch's rows. udr_key carries the
    // canonical cell, lowercased (`...|polygon_id=<v>`).
    async function geoByPolygon(
      batchId: string,
    ): Promise<Map<string, [string | null, string | null]>> {
      const rows = await db
        .select({
          udrKey: udrRated.udrKey,
          state: udrRated.state,
          district: udrRated.district,
        })
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, batchId));
      const out = new Map<string, [string | null, string | null]>();
      for (const cell of SAMPLE_5G_LKP_ROWS) {
        const row = rows.find((r) =>
          r.udrKey.includes(cell.polygonId.toLowerCase()),
        );
        expect(row, `a rated row for ${cell.polygonId}`).toBeDefined();
        out.set(cell.polygonId, [row!.state, row!.district]);
      }
      return out;
    }

    // Supersede the ACTIVE card version and activate v2 with revised labels on
    // the same cells — exactly what an operator re-upload + activate does.
    async function reversionCard(): Promise<void> {
      await sql.begin(async (tx) => {
        const [v1] = await tx<{ ratecard_version_id: string }[]>`
          UPDATE product.ratecard_version SET status = 'SUPERSEDED'
          WHERE card_name = ${CARD_NAME} AND status = 'ACTIVE'
          RETURNING ratecard_version_id`;
        const [v2] = await tx<{ ratecard_version_id: string }[]>`
          INSERT INTO product.ratecard_version
            (card_name, version_num, status, snapshot_date, source_file, row_count)
          VALUES (${CARD_NAME}, 2, 'ACTIVE', '2026-08-20', 'rm23-revised.csv',
                  ${SAMPLE_5G_LKP_ROWS.length})
          RETURNING ratecard_version_id`;
        for (const [i, cell] of SAMPLE_5G_LKP_ROWS.entries()) {
          await tx`
            INSERT INTO product.ratecard_ran_usage_lkp
              (ratecard_version_id, mno_public_key, commercial_unit_public_key,
               polygon_id, polygon_start_date, state, district,
               lkp_subscriber_ref_id, service_code)
            SELECT ${v2!.ratecard_version_id}, mno_public_key, commercial_unit_public_key,
                   polygon_id, polygon_start_date, ${REVISED_STATE}, ${revisedDistrict(i)},
                   lkp_subscriber_ref_id, service_code
            FROM product.ratecard_ran_usage_lkp
            WHERE ratecard_version_id = ${v1!.ratecard_version_id}
              AND polygon_id = ${cell.polygonId}`;
        }
      });
    }

    let firstBatchId: string;

    it("a re-versioned card does not move an already-rated row's geo; a re-rate reads the new ACTIVE labels", async () => {
      firstBatchId = rateFile(
        "rating-input-file-202608140101.udr",
        "run1",
        100,
      );
      const before = await geoByPolygon(firstBatchId);
      for (const cell of SAMPLE_5G_LKP_ROWS) {
        expect(before.get(cell.polygonId)).toEqual([
          SAMPLE_5G_RATECARD_STATE,
          cell.district,
        ]);
      }

      await reversionCard();

      // Frozen: nothing re-reads the card for a row already rated.
      expect(await geoByPolygon(firstBatchId)).toEqual(before);

      // A reissue (same file_key, run 2) re-rates against the NEW ACTIVE card and
      // supersedes run 1's rows — which still keep their original geo.
      const secondBatchId = rateFile(
        "rating-input-file-202608140101_v2.udr",
        "run2",
        150,
      );
      const after = await geoByPolygon(secondBatchId);
      SAMPLE_5G_LKP_ROWS.forEach((cell, i) => {
        expect(after.get(cell.polygonId)).toEqual([
          REVISED_STATE,
          revisedDistrict(i),
        ]);
      });
      expect(await geoByPolygon(firstBatchId)).toEqual(before);
    }, 120_000);

    it("UPDATE of state/district is refused for rating_runtime, app_runtime and billrun_runtime", async () => {
      const [row] = await db
        .select({
          partitionPeriod: udrRated.partitionPeriod,
          udrId: udrRated.udrId,
        })
        .from(udrRated)
        .where(eq(udrRated.udrRefBatchId, firstBatchId))
        .limit(1);
      expect(row).toBeDefined();
      for (const [role, client] of Object.entries(roleClients)) {
        for (const column of ["state", "district"]) {
          await expect(
            client.unsafe(
              `UPDATE rating.udr_rated SET ${column} = 'TAMPERED' WHERE partition_period = $1 AND udr_id = $2`,
              [row!.partitionPeriod, row!.udrId],
            ),
            `${role} UPDATE ${column}`,
          ).rejects.toThrow(/permission denied/);
        }
      }
    });
  },
);
