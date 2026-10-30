import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { logger } from "@/lib/logger";

// One-shot provisioning CLI (`npm run db:bootstrap-reporting-roles`). Never
// imported by application code. Creates the SELECT-only `reporting_runtime`
// login role and its grants by executing db/bootstrap/reporting-db-roles.sql
// (rpt01-spec §Implementation §2).
//
// Deliberately NOT part of the Drizzle migration sequence: creating a role
// needs CREATEROLE, which the `app_migrate` role the automated `migrate` stage
// runs as does not hold. So it reads its own `BOOTSTRAP_DATABASE_URL` — a
// superuser/owner connection string supplied only at provisioning time, never
// committed — rather than the app's `DATABASE_URL`. Run once per environment,
// AFTER `npm run db:bootstrap-roles`, `npm run db:bootstrap-rating-roles` AND
// `npm run db:bootstrap-billrun-roles` (Step 0 fails closed unless rating's
// REVOKE CONNECT ... FROM PUBLIC has already run). See the provisioning order
// in infra/docs/db-role-verification.md (step 3c).
const BOOTSTRAP_SQL_PATH = join(import.meta.dirname, "reporting-db-roles.sql");

function readStatements(): string[] {
  return readFileSync(BOOTSTRAP_SQL_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function main(): Promise<void> {
  const bootstrapUrl = process.env.BOOTSTRAP_DATABASE_URL;
  if (!bootstrapUrl) {
    throw new Error(
      "BOOTSTRAP_DATABASE_URL is not set. Provide a superuser/owner " +
        "connection string (this is NOT the app's DATABASE_URL).",
    );
  }

  const statements = readStatements();
  const sql = postgres(bootstrapUrl, { max: 1 });
  try {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    logger.info("Reporting DB role bootstrap applied successfully.", {
      statements: statements.length,
    });
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  const pgErr =
    typeof err === "object" && err !== null
      ? (err as { code?: string; detail?: string; where?: string })
      : {};
  logger.error("Reporting DB role bootstrap failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
    code: pgErr.code,
    detail: pgErr.detail,
    where: pgErr.where,
  });
  process.exit(1);
});
