import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { logger } from "@/lib/logger";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm40-spec (TC58) — the disposable-DB sentinel the destructive-DB preflight
// (tests/integration-global-setup.ts) checks for. Deliberately NOT a name or
// host match: `assertTestDatabaseUrl`'s localhost/"test"-in-the-name heuristic
// is a last-line sanity check, not proof — a `DATABASE_URL` that merely LOOKS
// disposable is exactly the failure mode known-issues §13 describes (a
// misdirected `DATABASE_URL` wiping a real dev stack + the co-located `kestra`
// database). This module instead reads content the provisioning step must
// have explicitly written INTO the target database.
const SENTINEL_TABLE = "_test_disposable_sentinel";

export async function isDisposableDatabase(
  sql: postgres.Sql,
): Promise<boolean> {
  try {
    const rows = await sql.unsafe<{ disposable: boolean }[]>(
      `SELECT disposable FROM public.${SENTINEL_TABLE} ` +
        `WHERE marker = 'disposable' AND disposable = true LIMIT 1`,
    );
    return rows.length > 0;
  } catch (err) {
    // 42P01 = undefined_table (Postgres): the sentinel was never written —
    // not disposable. Any other failure (a bad connection, a permissions
    // error) is surfaced rather than silently read as "not disposable".
    if ((err as { code?: string } | undefined)?.code === "42P01") {
      return false;
    }
    throw err;
  }
}

/**
 * Marks `sql`'s target database disposable. Intended for a human or a CI
 * provisioning step to run ONCE against a freshly created throwaway/CI
 * Postgres instance — never against a shared or production database (hence
 * the `assertTestDatabaseUrl` sanity check in the CLI entrypoint below).
 */
export async function markDatabaseDisposable(
  sql: postgres.Sql,
): Promise<void> {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS public.${SENTINEL_TABLE} (
      marker     text PRIMARY KEY,
      disposable boolean NOT NULL,
      marked_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
  await sql.unsafe(`
    INSERT INTO public.${SENTINEL_TABLE} (marker, disposable, marked_at)
    VALUES ('disposable', true, now())
    ON CONFLICT (marker) DO UPDATE SET disposable = true, marked_at = now()
  `);
}

// CLI entrypoint: `node --env-file=.env --import tsx tests/helpers/disposable-database.ts`
// (or with DATABASE_URL set inline) marks that connection's database
// disposable. Run this once per freshly (re)created throwaway/CI Postgres
// instance before setting DESTRUCTIVE_DB_OK=1 and running the DB-gated suite.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set — nothing to mark disposable.");
  }
  assertTestDatabaseUrl(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await markDatabaseDisposable(sql);
    logger.info("Marked database disposable");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (isMain) {
  void main().catch((err: unknown) => {
    logger.error("Failed to mark database disposable", {
      message: err instanceof Error ? err.message : "Unknown error",
    });
    process.exit(1);
  });
}
