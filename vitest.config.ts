import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
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
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    // The DB integration suite is a separate Vitest project (vitest.integration.config.ts)
    // so this DB-free unit suite never opens a database connection (um02-spec §3.9).
    exclude: ["node_modules/**", "tests/**/*.integration.test.ts"],
    // Capped below CPU count (16 on dev machines) — running one jsdom
    // environment per core oversubscribes the OS scheduler and produced
    // intermittent timeouts in CPU-sensitive tests (Radix portal mount +
    // MutationObserver polling in customer-role-form.test.tsx, for one).
    pool: "forks",
    maxWorkers: 8,
    testTimeout: 10000,
  },
});
