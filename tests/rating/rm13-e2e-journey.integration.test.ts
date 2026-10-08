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
  SAMPLE_5G_RATE_PER_UNIT,
  SAMPLE_5G_RATECARD_STATE,
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
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm22-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const MNO = "MNO-E2E";
const PRODUCT_NAME = "Sample 5G Services e2e";

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm22 — the PER_UNIT operator journey (rm22-spec §1, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let pipeline: RatingPipeline;
    let productInventoryId: string;

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
      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);

      ({ productInventoryId } = await seedSample5gRatingGraph(db, {
        tag: "rm22-e2e",
        mno: MNO,
        productName: PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate e2e",
        cardName: "RATECARD_E2E",
      }));
      pipeline = createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: "rm22-test-engine@sha256:deadbeef",
        mno: MNO,
        productName: PRODUCT_NAME,
        now: "2026-09-01T00:00:00Z",
        tmpPrefix: "rm22-journey-",
      });
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

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
      const path = pipeline.writeUdr(
        "rating-input-file-202608140001.udr",
        [100, 200, 300],
      );
      const prpUri = pipeline.runPrp(path, "rm22-prp-1");
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
      const rpUri = pipeline.runRp(prpUri, "rm22-rp-1");
      pipeline.runRl(rpUri, "rm22-rl-1");
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

      // bm48 — every rated row carries its matched ratecard cell's geo, frozen
      // at rating. Cell i was written at volume [100, 200, 300][i].
      SAMPLE_5G_LKP_ROWS.forEach((cell, i) => {
        const quantity = `${[100, 200, 300][i]}.000000`;
        const row = rated.find((r) => r.udrUsageQuantity === quantity)!;
        expect(row.state).toBe(SAMPLE_5G_RATECARD_STATE);
        expect(row.district).toBe(cell.district);
      });

      // One live row per (partition_period, udr_key).
      const udrKey = row100.udrKey;
      expect(await liveRowsForKey(udrKey)).toHaveLength(1);

      // -----------------------------------------------------------
      // 4. Re-drop the SAME filename (reissue, corrected volumes) -> run 2.
      // -----------------------------------------------------------
      const reissue = pipeline.writeUdr(
        "rating-input-file-202608140001_v2.udr",
        [150, 250, 350],
      );
      const prpUri2 = pipeline.runPrp(reissue, "rm22-prp-2");
      const prpManifest2 = readManifest(prpUri2);
      const batchId2 = prpManifest2.batch_id as string;
      const batch2Claim = await batchRow(batchId2);
      expect(batch2Claim.batchRunNum).toBe(2);
      expect(batch2Claim.fileKey).toBe(batch.fileKey);

      const rpUri2 = pipeline.runRp(prpUri2, "rm22-rp-2");
      pipeline.runRl(rpUri2, "rm22-rl-2");

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
