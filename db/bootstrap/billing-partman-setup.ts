import { readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

import { logger } from "@/lib/logger";

// One-shot provisioning CLI (`npm run db:setup-partman-billing`). Never
// imported by application code. Stands up pg_partman for
// billing.bill_run_account by executing db/bootstrap/billing-partman-setup.sql
// (bm03-spec Implementation §3) — mirrors db/bootstrap/audit-partman-setup.ts
// exactly.
//
// Deliberately NOT part of the Drizzle migration sequence: CREATE EXTENSION
// and partman.create_parent need privileges above the least-privilege
// `app_migrate` role the automated `migrate` stage runs as. So it reads its
// own `BOOTSTRAP_DATABASE_URL` — a superuser/owner connection string supplied
// only at provisioning time, never committed — rather than the app's
// `DATABASE_URL`. Run once per environment, AFTER `npm run db:migrate` has
// created the partitioned parent (0027_bill_run_account.sql).
const PARTMAN_SQL_PATH = join(import.meta.dirname, "billing-partman-setup.sql");

function readStatements(): string[] {
  return readFileSync(PARTMAN_SQL_PATH, "utf8")
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
    logger.info("Billing pg_partman setup applied successfully.", {
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
  logger.error("Billing pg_partman setup failed.", {
    message: err instanceof Error ? err.message : "Unknown error",
    code: pgErr.code,
    detail: pgErr.detail,
    where: pgErr.where,
  });
  process.exit(1);
});
