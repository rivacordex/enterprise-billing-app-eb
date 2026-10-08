import { join } from "node:path";

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
import {
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  readManifest,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
} from "@/tests/helpers/rating-ran-harness";
import {
  SAMPLE_5G_LKP_ROWS,
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
const MNO = "MNO-GEO-FROZEN";
const PRODUCT_NAME = "Sample 5G Services geo-frozen";
const CARD_NAME = "RATECARD_GEO_FROZEN";
const REVISED_STATE = "Johor";
const revisedDistrict = (i: number) => `REVISED-${i + 1}`;

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
    let pipeline: RatingPipeline;
    const roleClients: Record<string, postgresjs.Sql> = {};

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropModuleSchemas(sql);
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

      await seedSample5gRatingGraph(db, {
        tag: "rm23-geo",
        mno: MNO,
        productName: PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate geo-frozen",
        cardName: CARD_NAME,
      });
      pipeline = createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: "rm23-test-engine@sha256:deadbeef",
        mno: MNO,
        productName: PRODUCT_NAME,
        now: "2026-09-01T00:00:00Z",
        tmpPrefix: "rm23-geo-",
      });
    }, 120_000);

    afterAll(async () => {
      for (const client of Object.values(roleClients)) {
        await client.end();
      }
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    // file -> PRP -> RP -> RL, returning the batch id the rows were loaded under.
    // `volumeBase` varies the bytes: a byte-identical reissue would be DISCARDED
    // by PRP as a duplicate redelivery rather than re-rated.
    function rateFile(name: string, tag: string, volumeBase: number): string {
      const volumes = SAMPLE_5G_LKP_ROWS.map((_, i) => volumeBase * (i + 1));
      const prpUri = pipeline.runPrp(
        pipeline.writeUdr(name, volumes),
        `prp-${tag}`,
      );
      const rpUri = pipeline.runRp(prpUri, `rp-${tag}`);
      pipeline.runRl(rpUri, `rl-${tag}`);
      return readManifest(prpUri).batch_id as string;
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
