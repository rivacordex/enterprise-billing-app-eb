import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { logger } from "@/lib/logger";

// One-shot provisioning CLI (`npm run db:bootstrap-kestra-roles`). Never
// imported by application code. Creates the `kestra` database and the
// least-privilege `kestra_engine` login role rm04's engine connects as, by
// executing db/bootstrap/kestra-db-roles.sql (rm03-spec §Implementation
// Step 9a; rm04-spec Depends-on).
//
// Deliberately NOT part of the Drizzle migration sequence: creating a
// database/role needs CREATEDB/CREATEROLE, which `app_migrate` does not
// hold. Reads its own `BOOTSTRAP_DATABASE_URL` — the same superuser/owner
// connection string used for db:bootstrap-rating-roles, never committed.
// Run once per environment, AFTER `npm run db:bootstrap-rating-roles`
// (its Step 2 REVOKE CONNECT ... FROM PUBLIC must land first — see the
// header comment in kestra-db-roles.sql). See the provisioning order in
// infra/docs/db-role-verification.md.
const BOOTSTRAP_SQL_PATH = join(import.meta.dirname, "kestra-db-roles.sql");

// Postgres error code for "database already exists" (duplicate_database).
// CREATE DATABASE cannot be wrapped in a DO block/IF-NOT-EXISTS guard (it
// cannot run inside a transaction block at all), so idempotency for that one
// statement is handled here instead of in SQL — see kestra-db-roles.sql
// Step 1's comment.
const PG_DUPLICATE_DATABASE = "42P04";

function readStatements(): string[] {
  return readFileSync(BOOTSTRAP_SQL_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function isDuplicateDatabaseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === PG_DUPLICATE_DATABASE
  );
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
      try {
        await sql.unsafe(statement);
      } catch (err) {
        if (isDuplicateDatabaseError(err)) {
          logger.info(
            "kestra database already exists; skipping CREATE DATABASE.",
          );
          continue;
        }
        throw err;
      }
    }
    logger.info("Kestra DB role bootstrap applied successfully.", {
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
  logger.error("Kestra DB role bootstrap failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
    code: pgErr.code,
    detail: pgErr.detail,
    where: pgErr.where,
  });
  process.exit(1);
});
