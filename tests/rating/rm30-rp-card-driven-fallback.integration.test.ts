import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
} from "@/tests/helpers/rating-ran-harness";
import { SAMPLE_5G_RATE_PER_UNIT } from "@/db/seeds/sample/sample-5g-fixture";

// rm30-spec — RP rates a card-driven usage_rate (plaSpecId 'PLA_USAGE_RATE') at
// the product's ratePerUnit when the card it names has an ACTIVE version with no
// cell rate (Inv 24, PC10's final fallback), and still refuses loudly with
// CARD_DRIVEN_RATING_UNSUPPORTED when that card carries a rate or has no ACTIVE
// version.
//
// Requires DATABASE_URL (a superuser on a disposable database) + python3 with the
// worker runtime; shells the real PRP/RP modules exactly as the flow's tasks do.
// Skips loudly otherwise — same posture as every rm06+ DB-gated suite.
const databaseUrl = process.env.DATABASE_URL;
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm30-test-only-pw";
const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
);
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const VOLUMES = [100, 200, 300] as const;
const EVENT_CODE = "CARD_DRIVEN_RATING_UNSUPPORTED";

interface Graph {
  mno: string;
  productName: string;
  cardName: string;
}

const FALLBACK: Graph = {
  mno: "MNO-RM30-FB",
  productName: "Sample 5G Services rm30 fallback",
  cardName: "RATECARD_RM30_FB",
};
const RATED: Graph = {
  mno: "MNO-RM30-RATED",
  productName: "Sample 5G Services rm30 rated",
  cardName: "RATECARD_RM30_RATED",
};
const MISSING: Graph = {
  mno: "MNO-RM30-MISS",
  productName: "Sample 5G Services rm30 missing",
  cardName: "RATECARD_RM30_MISS",
};
// The card MISSING's price names: never uploaded, so it has no ACTIVE version.
const ABSENT_CARD = "RATECARD_RM30_ABSENT";

function columnValues(parquetUri: string, column: string): string[] {
  const out = execFileSync(
    ratingPython3(),
    [
      "-c",
      "import json,polars,sys;f=polars.read_parquet(sys.argv[1]);print(json.dumps([str(x) for x in f[sys.argv[2]].to_list()]))",
      fileURLToPath(parquetUri),
      column,
    ],
    { cwd: RATING_WORKER_DIR, encoding: "utf8" },
  );
  return JSON.parse(out) as string[];
}

describe.skipIf(!databaseUrl || !pythonReady)(
  "rm30 — RP card-driven usage_rate falls back to the product rate (rm30-spec, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    const priceIds = new Map<Graph, string>();
    const pipelines = new Map<Graph, RatingPipeline>();

    // Make the graph's usage_rate card-driven, naming `card`. A superuser write
    // with the DRAFT-guard trigger bypassed for this transaction only (the
    // offering is ACTIVE once seeded).
    async function makeCardDriven(
      priceId: string,
      card: string,
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL session_replication_role = replica");
        await tx`
          UPDATE product.product_offering_price
             SET price_component = jsonb_set(
                   jsonb_set(price_component, '{plaSpecId}', '"PLA_USAGE_RATE"'),
                   '{params,rateCardLookUp}', to_jsonb(${card}::text))
           WHERE product_offering_price_id = ${priceId}`;
      });
    }

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

      for (const [tag, graph] of [
        ["rm30-fb", FALLBACK],
        ["rm30-rated", RATED],
        ["rm30-miss", MISSING],
      ] as const) {
        const { priceId } = await seedSample5gRatingGraph(db, {
          tag,
          mno: graph.mno,
          productName: graph.productName,
          priceName: `Sample 5G Usage Rate ${tag}`,
          cardName: graph.cardName,
        });
        priceIds.set(graph, priceId);
        pipelines.set(
          graph,
          createRatingPipeline({
            databaseUrl: databaseUrl as string,
            rolePassword: ROLE_PW,
            engineVersion: "rm30-test-engine@sha256:deadbeef",
            now: "2026-09-01T00:00:00Z",
            mno: graph.mno,
            productName: graph.productName,
            tmpPrefix: `${tag}-`,
          }),
        );
      }

      await makeCardDriven(priceIds.get(FALLBACK)!, FALLBACK.cardName);
      await makeCardDriven(priceIds.get(RATED)!, RATED.cardName);
      await makeCardDriven(priceIds.get(MISSING)!, ABSENT_CARD);
      // RATED's card carries one cell rate, so the fallback must not apply.
      await sql`
        UPDATE product.ratecard_ran_usage_lkp l
           SET rate_per_unit = 7
          FROM product.ratecard_version v
         WHERE v.ratecard_version_id = l.ratecard_version_id
           AND v.card_name = ${RATED.cardName}
           AND l.ratecard_ran_usage_lkp_id = (
                 SELECT min(l2.ratecard_ran_usage_lkp_id::text)::uuid
                   FROM product.ratecard_ran_usage_lkp l2
                  WHERE l2.ratecard_version_id = v.ratecard_version_id)`;
    }, 180_000);

    afterAll(async () => {
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    // file -> PRP -> RP. Returns the RP manifest URI, or the stderr of a refusal.
    function prpThenRp(
      graph: Graph,
      name: string,
      tag: string,
    ): { rpUri?: string; stderr?: string } {
      const p = pipelines.get(graph)!;
      const prpUri = p.runPrp(p.writeUdr(name, VOLUMES), `prp-${tag}`);
      expect(readManifest(prpUri).status).toBe("PROCESSING");
      try {
        return { rpUri: p.runRp(prpUri, `rp-${tag}`) };
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        return { stderr: String(e.stderr ?? e.message ?? "") };
      }
    }

    function rpLogLines(graph: Graph, tag: string): string[] {
      const path = join(pipelines.get(graph)!.dirs.logs, `RP-rp-${tag}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter(Boolean);
    }

    function expectRefused(
      graph: Graph,
      tag: string,
      result: { rpUri?: string; stderr?: string },
      reason: string,
    ): void {
      expect(result.rpUri).toBeUndefined();
      expect(result.stderr).toContain(EVENT_CODE);
      expect(result.stderr).toContain(reason);
      const lines = rpLogLines(graph, tag);
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0]!) as {
        event_code: string;
        additional_info: { price_ref: string };
      };
      expect(line.event_code).toBe(EVENT_CODE);
      expect(line.additional_info.price_ref).toBe(priceIds.get(graph));
    }

    it("1. a card with no cell rates rates PER_UNIT at the product's ratePerUnit", () => {
      const { rpUri, stderr } = prpThenRp(
        FALLBACK,
        "rating-input-file-202609010301.udr",
        "fb",
      );
      expect(stderr).toBeUndefined();
      const chunks = readManifest(rpUri!).rated_chunk_uris as string[];
      expect(chunks).toHaveLength(1);
      const rated = chunks[0]!;
      const quantities = columnValues(rated, "udr_usage_quantity");
      expect(new Set(columnValues(rated, "udr_rate_type"))).toEqual(
        new Set(["PER_UNIT"]),
      );
      expect(new Set(columnValues(rated, "udr_usage_rate"))).toEqual(
        new Set([SAMPLE_5G_RATE_PER_UNIT]),
      );
      expect(new Set(columnValues(rated, "udr_price_ref"))).toEqual(
        new Set([priceIds.get(FALLBACK)]),
      );
      const raws = columnValues(rated, "udr_rated_price_raw");
      const details = columnValues(rated, "udr_rate_detail");
      quantities.forEach((quantity, i) => {
        const amountRaw = `${Number(SAMPLE_5G_RATE_PER_UNIT) * Number(quantity)}.000000`;
        expect(raws[i]).toBe(amountRaw);
        expect(JSON.parse(details[i]!)).toEqual({
          rateType: "PER_UNIT",
          ratePerUnit: SAMPLE_5G_RATE_PER_UNIT,
          quantity,
          amountRaw,
        });
      });
    }, 120_000);

    it("2. a card carrying a cell rate is refused (no silent fallback)", () => {
      const result = prpThenRp(
        RATED,
        "rating-input-file-202609010302.udr",
        "rated",
      );
      expectRefused(RATED, "rated", result, "carries 1 cell rate");
    }, 120_000);

    it("3. a card with no ACTIVE version is refused", () => {
      const result = prpThenRp(
        MISSING,
        "rating-input-file-202609010303.udr",
        "miss",
      );
      expectRefused(MISSING, "miss", result, "has no ACTIVE version");
    }, 120_000);
  },
);
