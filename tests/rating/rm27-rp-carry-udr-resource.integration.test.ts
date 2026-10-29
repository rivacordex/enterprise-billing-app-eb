import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { seedEventCatalog } from "@/db/seeds/rating-event-catalog.data";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  RATING_WORKER_DIR,
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  ratingPython3,
  readManifest,
  readParquetColumn,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
} from "@/tests/helpers/rating-ran-harness";
import {
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_RATE_PER_UNIT,
  SAMPLE_5G_RATECARD_STATE,
  SAMPLE_5G_START_DATE,
} from "@/db/seeds/sample/sample-5g-fixture";
import { formatUdrResource } from "@/validation/rating/udr-resource.schema";

// rm27-spec — RP carries PRP's `udr_resource` column through to the rated
// Parquet unchanged (Inv 28, R5/R6); since rm32 (Phase J) it is the only
// ratecard-cell column, so neither chunk carries `state`/`district`:
//   * the rated value equals the PRP chunk's, row for row (incl. `||<date>`);
//   * a chunk without the column yields a rated chunk without it, so RL's
//     missing-column guard (rm28) can still fire;
//   * `udr_key` and the PER_UNIT pricing are untouched.
//
// Requires DATABASE_URL (a superuser on a disposable database) + python3 with the
// worker runtime; shells the real PRP/RP modules exactly as the flow's tasks do.
// Skips loudly otherwise — same posture as every rm06+ DB-gated suite.
const databaseUrl = process.env.DATABASE_URL;
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm27-test-only-pw";
const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
);
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const MNO = "MNO-RM27";
const PRODUCT_NAME = "Sample 5G Services rm27";
const BLANK_MNO = "MNO-RM27-BLANK";
const BLANK_PRODUCT_NAME = "Sample 5G Services rm27 blank";
const BLANK_CARD_NAME = "RATECARD_RM27_BLANK";
const VOLUMES = [100, 200, 300] as const;

function columnValues(parquetUri: string, column: string): (string | null)[] {
  const { values } = readParquetColumn(parquetUri, column);
  expect(values, `${column} in ${parquetUri}`).not.toBeNull();
  return values!;
}

// The only new test utility (spec §2.3): rewrite a PRP chunk in place without
// `udr_resource`, leaving every other column as PRP wrote it.
function dropUdrResource(parquetUri: string): void {
  execFileSync(
    ratingPython3(),
    [
      "-c",
      "import polars,sys;p=sys.argv[1];polars.read_parquet(p).drop('udr_resource').write_parquet(p)",
      fileURLToPath(parquetUri),
    ],
    { cwd: RATING_WORKER_DIR, stdio: "ignore" },
  );
}

function onlyChunk(manifestUri: string, key: string): string {
  const chunks = readManifest(manifestUri)[key] as string[];
  expect(chunks).toHaveLength(1);
  return chunks[0]!;
}

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm27 — RP carries udr_resource (rm27-spec, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let pipeline: RatingPipeline;
    let blankPipeline: RatingPipeline;

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
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);

      await seedSample5gRatingGraph(db, {
        tag: "rm27-carry",
        mno: MNO,
        productName: PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate rm27",
        cardName: "RATECARD_RM27",
      });
      // A second graph whose card labels are blank: state "" and district
      // "   " are both empty segments of udr_resource (Inv 28).
      await seedSample5gRatingGraph(db, {
        tag: "rm27-blank",
        mno: BLANK_MNO,
        productName: BLANK_PRODUCT_NAME,
        priceName: "Sample 5G Usage Rate rm27 blank",
        cardName: BLANK_CARD_NAME,
      });
      await sql`
        UPDATE product.ratecard_ran_usage_lkp l
           SET state = '', district = '   '
          FROM product.ratecard_version v
         WHERE v.ratecard_version_id = l.ratecard_version_id
           AND v.card_name = ${BLANK_CARD_NAME}`;

      const common = {
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: "rm27-test-engine@sha256:deadbeef",
        now: "2026-09-01T00:00:00Z",
      };
      pipeline = createRatingPipeline({
        ...common,
        mno: MNO,
        productName: PRODUCT_NAME,
        tmpPrefix: "rm27-carry-",
      });
      blankPipeline = createRatingPipeline({
        ...common,
        mno: BLANK_MNO,
        productName: BLANK_PRODUCT_NAME,
        tmpPrefix: "rm27-blank-",
      });
    }, 120_000);

    afterAll(async () => {
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    // file -> PRP -> RP; returns the single PRP chunk and the single rated chunk.
    function prpThenRp(
      p: RatingPipeline,
      name: string,
      tag: string,
      beforeRp?: (prpChunk: string) => void,
    ): { prpChunk: string; ratedChunk: string } {
      const prpUri = p.runPrp(p.writeUdr(name, VOLUMES), `prp-${tag}`);
      expect(readManifest(prpUri).status).toBe("PROCESSING");
      const prpChunk = onlyChunk(prpUri, "chunk_uris");
      beforeRp?.(prpChunk);
      const rpUri = p.runRp(prpUri, `rp-${tag}`);
      return { prpChunk, ratedChunk: onlyChunk(rpUri, "rated_chunk_uris") };
    }

    let carried: { prpChunk: string; ratedChunk: string };

    beforeAll(() => {
      carried = prpThenRp(
        pipeline,
        "rating-input-file-202608140271.udr",
        "carry",
      );
    }, 120_000);

    it("1. the rated udr_resource equals the PRP chunk's, row for row and in order", () => {
      const prp = columnValues(carried.prpChunk, "udr_resource");
      const rated = columnValues(carried.ratedChunk, "udr_resource");
      expect(rated).toEqual(prp);
      // rm32 — the geo travels only inside udr_resource.
      const { columns } = readParquetColumn(carried.ratedChunk, "udr_resource");
      expect(columns).toContain("udr_resource");
      expect(columns).not.toContain("state");
      expect(columns).not.toContain("district");

      // Per Sample-5G cell: `STATE-1|DIST-n|2026-01-01`, keyed by the raw
      // polygon on the rated udr_key.
      const keys = columnValues(carried.ratedChunk, "udr_key");
      expect(rated).toHaveLength(SAMPLE_5G_LKP_ROWS.length);
      for (const cell of SAMPLE_5G_LKP_ROWS) {
        const i = keys.findIndex((k) =>
          k!.includes(`polygon_id=${cell.polygonId}`),
        );
        expect(i, `a rated row for ${cell.polygonId}`).toBeGreaterThanOrEqual(
          0,
        );
        const expected = formatUdrResource({
          state: SAMPLE_5G_RATECARD_STATE,
          district: cell.district,
          polygonStartDate: SAMPLE_5G_START_DATE,
        });
        expect(expected).toBe(`STATE-1|${cell.district}|2026-01-01`);
        expect(rated[i]).toBe(expected);
      }
    });

    it("2. blank card labels reach the rated chunk as `||2026-01-01`", () => {
      const { prpChunk, ratedChunk } = prpThenRp(
        blankPipeline,
        "rating-input-file-202608140272.udr",
        "blank",
      );
      const blank = formatUdrResource({
        state: null,
        district: null,
        polygonStartDate: SAMPLE_5G_START_DATE,
      });
      expect(blank).toBe("||2026-01-01");
      const rated = columnValues(ratedChunk, "udr_resource");
      expect(rated).toEqual(columnValues(prpChunk, "udr_resource"));
      expect(rated).toEqual(SAMPLE_5G_LKP_ROWS.map(() => blank));
      const { columns } = readParquetColumn(ratedChunk, "udr_resource");
      expect(columns).not.toContain("state");
      expect(columns).not.toContain("district");
    });

    it("3. a PRP chunk without udr_resource yields a rated chunk without it", () => {
      const { prpChunk, ratedChunk } = prpThenRp(
        pipeline,
        "rating-input-file-202608140273.udr",
        "absent",
        dropUdrResource,
      );
      expect(readParquetColumn(prpChunk, "udr_resource").values).toBeNull();
      const rated = readParquetColumn(ratedChunk, "udr_resource");
      expect(rated.values).toBeNull();
      expect(rated.columns).not.toContain("udr_resource");
      // Still rated — the absence is RL's to catch (rm28), not RP's.
      expect(columnValues(ratedChunk, "udr_key")).toHaveLength(
        SAMPLE_5G_LKP_ROWS.length,
      );
    });

    it("4. udr_key passes through RP byte for byte (PCU-042_04 keeps its upper case)", () => {
      const prp = columnValues(carried.prpChunk, "udr_key");
      const rated = columnValues(carried.ratedChunk, "udr_key");
      expect(rated).toEqual(prp);
      expect(rated.some((k) => k!.includes("polygon_id=PCU-042_04"))).toBe(
        true,
      );
    });

    it("5. PER_UNIT pricing is unchanged with the column present (R1)", () => {
      const rated = carried.ratedChunk;
      const quantities = columnValues(rated, "udr_usage_quantity");
      const rateTypes = columnValues(rated, "udr_rate_type");
      const rates = columnValues(rated, "udr_usage_rate");
      const raws = columnValues(rated, "udr_rated_price_raw");
      const details = columnValues(rated, "udr_rate_detail");
      expect(new Set(rateTypes)).toEqual(new Set(["PER_UNIT"]));
      expect(new Set(rates)).toEqual(new Set([SAMPLE_5G_RATE_PER_UNIT]));
      expect([...quantities].sort((a, b) => Number(a) - Number(b))).toEqual(
        VOLUMES.map(String),
      );
      quantities.forEach((quantity, i) => {
        // ratePerUnit 100 × usage_volume, at numeric(18,6) scale.
        const amountRaw = `${Number(SAMPLE_5G_RATE_PER_UNIT) * Number(quantity)}.000000`;
        expect(raws[i]).toBe(amountRaw);
        expect(JSON.parse(details[i]!)).toEqual({
          rateType: "PER_UNIT",
          ratePerUnit: SAMPLE_5G_RATE_PER_UNIT,
          quantity,
          amountRaw,
        });
      });
    });
  },
);
