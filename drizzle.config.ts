import { defineConfig } from "drizzle-kit";

// drizzle-kit is a build/CLI tool invoked with `--env-file`; this is the
// sanctioned exception to "config is read in one place" (lib/config.ts) —
// it runs outside the app runtime and is never imported by application code.
//
// NOTE: do NOT run `drizzle-kit generate` to add migrations — the snapshot
// baseline in db/migrations/meta stops at 0026, so generate would emit a
// broken giant diff for every hand-authored billing migration (0027+). All
// migrations here are hand-written SQL; see db/migrations/README.md.
// `drizzle-kit introspect` is unaffected (it reads the live DB, not snapshots).
export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL! },
  schemaFilter: [
    "core",
    "product",
    "customer",
    "billing",
    "ordering",
    "inventory",
  ],
  // pgledger's own tables/functions/views (ac01) are vendored raw SQL, never
  // introspected/diffed by drizzle-kit — only the module tables above are
  // Drizzle-managed (ac02-spec §2.5/§3.5).
  tablesFilter: ["!pgledger_*"],
  verbose: true,
  strict: true,
});
