import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Separate Vitest project for DB-dependent integration suites (um02-spec
// §3.9) — keeps the default `npm test` run DB-free. Run against
// `DATABASE_URL`; skip loudly when it is unset rather than passing silently.
export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      // See tests/mocks/server-only.ts — Vitest never sets the
      // "react-server" condition that makes the real package a no-op.
      "server-only": fileURLToPath(
        new URL("./tests/mocks/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: true,
    // `.property.test.ts` (fast-check) suites are also DB-backed — they run
    // here (with DATABASE_URL) alongside the `.integration.test.ts` files, not
    // in the DB-free default project where they would only ever skip.
    include: ["tests/**/*.integration.test.ts", "tests/**/*.property.test.ts"],
    // Each suite owns the whole `core`/`drizzle` schema for its own
    // DROP/migrate/teardown cycle against one shared DATABASE_URL; running
    // files in parallel races those DDL statements against each other.
    fileParallelism: false,
    // Non-DATABASE_URL config required by `@/lib/config` (eagerly validated
    // by anything importing `@/auth` or `@/db/client`, e.g. tests/auth/*).
    // These are test fixtures, not real secrets — DATABASE_URL is the only
    // var that depends on real infra and is deliberately left unset here so
    // its absence still triggers the loud `describe.skipIf` skip.
    env: {
      BETTER_AUTH_SECRET: "test-only-secret-value-not-used-in-prod-32chars",
      BETTER_AUTH_URL: "http://localhost:3000",
      BOOTSTRAP_ADMIN_EMAIL: "bootstrap-admin@example.com",
      BOOTSTRAP_ADMIN_PASSWORD: "test-only-bootstrap-password",
    },
    // Every suite resets its schemas with `DROP SCHEMA IF EXISTS ... CASCADE`
    // in beforeAll/afterAll. postgres.js's default notice handler `console.log`s
    // every server NOTICE (connection.js `NoticeResponse`), so those drops
    // flood stdout with thousands of benign "schema … does not exist, skipping"
    // / "drop cascades to N objects" lines. Centralized here rather than
    // threading `onnotice: () => {}` through the ~60 suites that each construct
    // their own `postgres()` client.
    //
    // SAFETY: this gates console *display* only — it never affects assertions
    // or pass/fail, so it cannot hide a test failure. The match is pinned to the
    // full postgres NOTICE signature: a whole-log object literal carrying
    // `severity: 'NOTICE'` alongside the `code:` (SQLSTATE) and `routine:` fields
    // every server notice has. It therefore cannot match a WARNING/ERROR/FATAL
    // notice, a thrown pg error, or an app JSON log (double-quoted keys) — only
    // genuine NOTICE-level teardown chatter is dropped.
    onConsoleLog(log) {
      const t = log.trim();
      const isBenignPgNotice =
        t.startsWith("{") &&
        t.endsWith("}") &&
        /\bseverity: 'NOTICE'/.test(t) &&
        /\bcode: '/.test(t) &&
        /\broutine: '/.test(t);
      if (isBenignPgNotice) return false;
    },
  },
});
