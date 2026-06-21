import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

// One-shot CLI tool (npm run db:migrate). Never imported by application
// code; the gated CI/CD `migrate` stage (um30) calls this before traffic
// shifts — also the migration Container Apps Job's entrypoint, reusing the
// app's own image (see infra/bicep/modules/container-app-job.bicep).
async function main(): Promise<void> {
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(sql), {
      migrationsFolder: "./db/migrations",
      migrationsSchema: "drizzle",
    });
    logger.info("Migrations applied successfully.");
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("Migration failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
  });
  process.exit(1);
});
