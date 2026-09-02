import { join } from "node:path";

import { logger } from "@/lib/logger";
import {
  checkRatingMigrationBoundary,
  findRatingMigrationFiles,
} from "@/db/checks/rating-migration-boundary";

// One-shot CLI tool (npm run check:rating-migration-boundary). Invoked by
// the CI test_scan stage (rm13-spec D4/Implementation §4) — the
// source-level half of the "no rating migration touches billing" gate.
// Never imported by application code.
function main(): void {
  const migrationsDir = join(process.cwd(), "db", "migrations");
  const files = findRatingMigrationFiles(migrationsDir);
  const violations = checkRatingMigrationBoundary(migrationsDir);

  if (violations.length > 0) {
    logger.error(
      "rm13 migration-boundary check FAILED — a rating migration references billing.*",
      { violations },
    );
    process.exit(1);
  }

  logger.info(
    "rm13 migration-boundary check OK — no rating migration writes billing.*",
    { scannedFiles: files },
  );
}

main();
