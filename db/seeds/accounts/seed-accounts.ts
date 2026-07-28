import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import * as schema from "@/db/schema";

import { seedSysAccounts } from "./seed-sys-accounts";
import { seedCoa } from "./seed-coa";
import { seedGlMappings } from "./seed-gl-mappings";
import { seedReasonCodes } from "./seed-reason-codes";
import { seedBillCycles } from "./seed-bill-cycles";
import { seedWizardDefaults } from "./seed-wizard-defaults";
import { seedAccountsPermissions } from "./seed-accounts-permissions";

// Standalone script (`npm run db:seed-accounts`) — never imported by
// application code. Depends on `db:migrate` having run (needs ac02 tables).
// Idempotent: every helper checks for existing rows before inserting.
// Everything runs in one transaction (spec §2.7).
async function main(): Promise<void> {
  const client = postgres(config.DATABASE_URL, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db.transaction(async (tx) => {
      await seedSysAccounts(tx);
      await seedCoa(tx);
      await seedGlMappings(tx);
      await seedReasonCodes(tx);
      const { defaultCycleId } = await seedBillCycles(tx);
      await seedWizardDefaults(tx, defaultCycleId);
      await seedAccountsPermissions(tx);
    });

    logger.info("Accounts module seeded successfully.");
  } finally {
    await client.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Accounts seed failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
