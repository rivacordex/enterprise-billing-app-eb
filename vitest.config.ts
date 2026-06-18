import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["tests/setup.ts"],
    // The DB integration suite is a separate Vitest project (vitest.integration.config.ts)
    // so this DB-free unit suite never opens a database connection (um02-spec §3.9).
    exclude: ["node_modules/**", "tests/**/*.integration.test.ts"],
  },
});
