import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { db as appDb } from "@/db/client";
import {
  assertNonProductionUrl,
  type NonProdGuardContext,
} from "@/db/seeds/lib/non-prod-guard";

import { seedProductDemo, seedRateCardDemo } from "./product-demo";
import { seedOrderingDemo } from "./ordering-demo";

// Standalone script (`npm run db:seed-demo`) — never imported by application
// code, never part of `db:setup` (D2: demo data is opt-in). Orchestrates the two
// demo seeds in one transaction, mirroring the `accounts/` orchestrator; runs
// product-demo BEFORE ordering-demo because the story looks its offering up by
// name. Depends on `db:migrate` + `db:seed-rbac` + **`db:seed`** having run —
// the rate-card demo (pm67) stamps the system/ADMIN break-glass user created by
// `db:seed` as its upload/activate actor (D2), and refuses if it is absent.
// Guarded so it cannot run against production by accident (mirrors
// `sample/seed-billrun-sample.ts`).

// Shared prod-write guard context (db/seeds/lib/non-prod-guard.ts). This seed
// touches only DATABASE_URL.
const DEMO_GUARD: NonProdGuardContext = {
  seedScript: "db:seed-demo",
  overrideEnv: "ALLOW_DEMO_SEED",
  action: `loads opt-in "Demo —" example data`,
};

// Deliberate waiver of the non-prod host check, for a non-local demo box.
function isDemoSeedOverride(): boolean {
  return process.env.ALLOW_DEMO_SEED === "true";
}

// Refuses a `DATABASE_URL` that looks like a production target. Demo rows are
// human-readable `Demo — ` example data and must never be seeded into a real
// environment by accident. Aborts loudly, before any write.
function assertNonProductionTarget(): void {
  if (isDemoSeedOverride()) {
    logger.warn(
      "db:seed-demo: ALLOW_DEMO_SEED=true — proceeding without the non-prod host check.",
    );
    return;
  }
  assertNonProductionUrl(config.DATABASE_URL, "DATABASE_URL", DEMO_GUARD);
}

async function main(): Promise<void> {
  assertNonProductionTarget();

  const client = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      await seedProductDemo(tx);
      await seedOrderingDemo(tx);
    });

    // pm67 — the rate-card demo runs on the application db pool (@/db/client),
    // NOT this script's own client: pm61/pm63's upload + activate services open
    // their own transactions there, so it must run AFTER the product/ordering
    // transaction has committed (the appuser it FKs must already be visible on
    // a separate connection). It manages its own commits via those services.
    await seedRateCardDemo();

    logger.info("Demo data seeded successfully.");
  } finally {
    await client.end();
    // seedRateCardDemo used the shared application pool; close it too so this
    // one-shot script exits promptly instead of idling the pool out to its
    // timeout (the billrun-live-kestra-smoke script uses the same pattern).
    await appDb.$client.end({ timeout: 5 }).catch(() => {});
  }
}

void main().catch((err: unknown) => {
  logger.error("Demo seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
