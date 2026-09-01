import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import {
  EVENT_CATALOG_SEED,
  seedEventCatalog,
} from "@/db/seeds/rating-event-catalog.data";

// Standalone script (`npm run db:seed-rating`) — never imported by application
// code. Seeds `rating.event_catalog` (rm02-spec) so severity, X.733 event type
// and probable cause resolve from data at emit time, never hardcoded at a call
// site. Depends only on the 0034_rating migration (the table).
//
// The seed data, the RATING_EVENT_CODES constant and the reusable upsert live
// in rating-event-catalog.data.ts, which the verification suite imports without
// this script's connect-and-run side effect. `event_catalog` is seeded under
// app_migrate (code-standards §9): rating_runtime and app_runtime hold SELECT
// only, so this must run on a migrate-capable DATABASE_URL.
//
// Idempotent: ON CONFLICT DO UPDATE, so a re-run brings an existing environment
// to the current catalog (including a severity re-tune) without a manual diff,
// and running it twice leaves seventeen rows, not thirty-four.
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    await seedEventCatalog(db);
    logger.info("Rating event catalog seeded successfully.", {
      rows: EVENT_CATALOG_SEED.length,
    });
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Rating event catalog seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
