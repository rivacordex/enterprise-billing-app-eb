import { defineConfig } from "drizzle-kit";

// drizzle-kit is a build/CLI tool invoked with `--env-file`; this is the
// sanctioned exception to "config is read in one place" (lib/config.ts) —
// it runs outside the app runtime and is never imported by application code.
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: ["core", "product", "customer"],
  verbose: true,
  strict: true,
});
