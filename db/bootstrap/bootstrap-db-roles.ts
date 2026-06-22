import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { logger } from "@/lib/logger";

// One-shot provisioning CLI (`npm run db:bootstrap-roles`). Never imported by
// application code. Creates the least-privilege `app_runtime`/`app_migrate`
// roles by executing db/bootstrap/bootstrap-db-roles.sql.
//
// Deliberately NOT part of the Drizzle migration sequence: creating roles
// needs a superuser/owner connection, while the automated `migrate` stage
// runs as the (lower-privilege) `app_migrate` role this script itself
// creates. So it reads its own `BOOTSTRAP_DATABASE_URL` — a superuser/owner
// connection string supplied only at provisioning time, never committed —
// rather than the app's `DATABASE_URL`. Run once per environment, AFTER the
// initial superuser/owner `npm run db:migrate` has created the schema (the
// grants/revokes reference existing tables). See the provisioning order in
// infra/docs/db-role-verification.md.
const BOOTSTRAP_SQL_PATH = join(import.meta.dirname, "bootstrap-db-roles.sql");

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
    logger.info("DB role bootstrap applied successfully.", {
      statements: statements.length,
    });
  } finally {
    await sql.end();
  }
}

void main().catch((err: unknown) => {
  logger.error("DB role bootstrap failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
    code: (err as { code?: string }).code,
    detail: (err as { detail?: string }).detail,
    where: (err as { where?: string }).where,
  });
  process.exit(1);
});
