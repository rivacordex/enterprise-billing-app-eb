import postgres from "postgres";

import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { isDisposableDatabase } from "@/tests/helpers/disposable-database";

// bm40-spec (TC58) — the destructive-DB preflight. Wired as Vitest
// `globalSetup` on the DB-gated project (vitest.integration.config.ts), which
// runs ONCE, before any test file is even imported — critically, before
// `@/db/client.ts` import chain. `db/client.ts` imports `@/lib/config` at
// module load and throws on an unset `DATABASE_URL` there, which is WHY every
// `*.integration.test.ts` file's own `describe.skipIf(!DATABASE_URL)` never
// gets to run as the loud-skip it was designed to be (known-issues §13 item
// 3) — a file-level guard can only skip once its module has already loaded,
// and loading already failed. Deliberately imports nothing from `@/lib/config`
// or `@/db/client` — only `postgres` directly — so THIS check always runs,
// regardless of what the rest of the app's config requires.
//
// Refuses to let the run proceed unless BOTH hold:
//   1. DESTRUCTIVE_DB_OK === "1" — an explicit, conscious opt-in; and
//   2. the target carries the disposable sentinel (see
//      tests/helpers/disposable-database.ts) — never a name/host match,
//      which is spoofable (exactly how known-issues §13's incident happened:
//      a DATABASE_URL that merely looked like a throwaway container).
export default async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DESTRUCTIVE DB PREFLIGHT REFUSED: DATABASE_URL is not set.\n" +
        "The DB-gated integration suite needs a disposable Postgres target — " +
        "set DATABASE_URL, set DESTRUCTIVE_DB_OK=1, and mark that database " +
        "disposable (npx tsx tests/helpers/disposable-database.ts with " +
        "DATABASE_URL pointed at it) before running this suite.",
    );
  }

  if (process.env.DESTRUCTIVE_DB_OK !== "1") {
    throw new Error(
      'DESTRUCTIVE DB PREFLIGHT REFUSED: DESTRUCTIVE_DB_OK is not set to "1".\n' +
        "These suites run `DROP SCHEMA ... CASCADE` and otherwise destructively " +
        "reset their target database. Set DESTRUCTIVE_DB_OK=1 only once you are " +
        "certain DATABASE_URL points at a disposable instance — never a shared " +
        "or production one.",
    );
  }

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const disposable = await isDisposableDatabase(sql);
    if (!disposable) {
      throw new Error(
        "DESTRUCTIVE DB PREFLIGHT REFUSED: DATABASE_URL's target does not " +
          "carry the disposable sentinel.\n" +
          "DESTRUCTIVE_DB_OK=1 alone is not sufficient — the target database " +
          "itself must be marked disposable (never inferred from its name or " +
          "host). Run: npx tsx tests/helpers/disposable-database.ts, with " +
          "DATABASE_URL pointed at the throwaway/CI Postgres instance you " +
          "intend this suite to destroy.",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  // The blob-store counterpart, once for the whole project (code review): at
  // least six suites delete blobs through BILLRUN_BLOB_CONNECTION_STRING, and a
  // per-suite opt-in had reached only two. When the variable is set it must
  // point at the throwaway Azurite; BILLRUN_BLOB_ACCOUNT_URL (a real account via
  // managed identity) is never allowed. Unset, the blob suites skip themselves.
  if (process.env.BILLRUN_BLOB_ACCOUNT_URL) {
    throw new Error(
      "BLOB PREFLIGHT REFUSED: BILLRUN_BLOB_ACCOUNT_URL is set. The integration " +
        "suites delete blobs; they may only target the throwaway Azurite via " +
        "BILLRUN_BLOB_CONNECTION_STRING (load .env.test).",
    );
  }
  const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;
  if (blobConnection) {
    assertTestBlobConnection(blobConnection);
  }
}
