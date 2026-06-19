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
    include: ["tests/**/*.integration.test.ts"],
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
  },
});
