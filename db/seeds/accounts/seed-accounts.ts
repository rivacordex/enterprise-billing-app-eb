import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { seedChartOfAccounts } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { seedBillCycles } from "@/db/seeds/accounts/seed-bill-cycles";
import { seedWizardDefaults } from "@/db/seeds/accounts/seed-wizard-defaults";

// Standalone script (`npm run db:seed-accounts`) — never imported by
// application code. Runs after `db:migrate` (needs ac02's billing tables).
// One transaction, ordered per ac03-spec §3.1: sys pgledger accounts -> CoA
// -> GL mappings (asserts each target is_postable) -> reason codes -> bill
// cycles -> wizard-default config. Every step is skip-if-present, so
// re-running this script is a no-op on an already-seeded database — this is
// the seed set that must leave `gl_resolution_view` at zero unmapped
// accounts (module Inv. #10, V5).
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(sql, { schema });

  try {
    await db.transaction(async (tx) => {
      await seedSysAccounts(tx);
      await seedChartOfAccounts(tx);
      await seedGlMappings(tx);
      await seedReasonCodes(tx);
      const { defaultBillCycleId } = await seedBillCycles(tx);
      await seedWizardDefaults(tx, defaultBillCycleId);
    });

    logger.info("Accounts seed set completed successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Accounts seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
