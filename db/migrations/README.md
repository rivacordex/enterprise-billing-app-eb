# Migrations — hand-authored, NOT `drizzle-kit generate`

**Do not run `npm run db:generate` (`drizzle-kit generate`) to add a migration
here.** Its snapshot baseline is stale.

## Why

Drizzle's generate/diff workflow relies on the per-migration snapshots in
`meta/*_snapshot.json`. Those stop at **`0026`** — there is **no snapshot for
`0018`–`0020` or `0027` onward** (all the billing-module migrations, including
the CHECK/constraint ones like `0014`, `0031`, `0037`). Those were hand-written
directly as SQL, and `meta/_journal.json` was hand-appended.

Running `drizzle-kit generate` today would diff the current schema against the
`0026` snapshot and emit one giant, broken migration re-creating everything
from `0027` on. So generate is effectively retired for this project — it is not
the workflow, regardless of any individual change.

The apply path never reads snapshots: `npm run db:migrate` → `db/migrate.ts` →
Drizzle's postgres-js migrator, which reads `meta/_journal.json` + the `.sql`
files (tracking applied ones by hash) only.

## Adding a migration

1. Hand-write `NNNN_short_name.sql`, splitting statements with
   `--> statement-breakpoint` marker lines (the migrator and the bootstrap
   `.ts` runners both rely on them).
2. Append the matching entry to `meta/_journal.json` (`tag` = the filename
   without `.sql`).
3. Keep the Drizzle schema under `db/schema/**` in sync by hand — it stays the
   source of truth for the app's typed queries, and its `check()`/constraint
   definitions are cross-referenced from the SQL of record (see the
   "kept in sync with it" notes in `db/schema/billing/documents.ts`).
4. As a rule, don't edit a migration that has already been applied anywhere —
   **not because it re-applies, but because it _silently doesn't_.** This
   migrator does **not** compare hashes: Drizzle's postgres-js migrator reads
   the most-recently-applied row from `drizzle.__drizzle_migrations` and applies
   a journal entry only when `entry.when > last_applied.created_at`. An edited
   file whose `when` is older than the last applied entry is **skipped** — not
   re-applied, not errored, not warned about. So the edit reaches **new
   databases only** (a fresh `db:setup` from empty); every already-migrated
   environment (your dev DB, test, staging, prod) keeps the old content until
   its volume is wiped and rebuilt. That is why **forward migrations remain the
   rule**: they are the only change that actually lands everywhere. Editing an
   unapplied, not-yet-shipped migration in place is fine and is the idiom here.
   (The Product Manage rebuild's one authorized round of editing `0006_product.sql`
   in place under its fresh-install assumption — decision D11 — is **closed as of
   pm45**; forward-only is the rule again for every migration from here.)
   (A rare, explicitly-granted exception: editing **seed metadata that nothing
   reads but admin help text** — e.g. a `system_config` row `description` — in
   place, paired with a one-off documented `UPDATE` for existing environments.)

`drizzle-kit introspect` (`npm run db:introspect`) is still safe — it reads the
live database, not the snapshots. pgledger's raw-SQL tables are deliberately
excluded from drizzle-kit entirely (`tablesFilter: ["!pgledger_*"]`).

## Known issues

### FK / constraint names exceed 63-char Postgres limit (tech debt)

Many auto-generated foreign key constraint names in the migration SQL exceed
PostgreSQL's 63-character identifier limit. Postgres silently truncates them
(`NOTICE 42622`) rather than erroring, so migrations succeed and the constraints
work — but the stored names are truncated and differ from what Drizzle schema
files declare, making `db:introspect` output noisy and diffs confusing.

**Observed at:** first `db:migrate` run against any fresh database (Azure dev
confirmed 2026-09-23).

**Fix (forward migration):** add a migration that uses `ALTER TABLE ... RENAME
CONSTRAINT` to replace every truncated name with an explicit short alias (≤ 63
chars). Then update the corresponding `db/schema/**/*.ts` Drizzle files to use
`.name("short_alias")` on each affected `references()`/`foreignKey()` call so
future migrations Drizzle would generate (if generate were re-enabled) would not
reintroduce the long names. Because already-applied migration SQL cannot be
edited (see rule above), the rename forward migration is the only safe path.
Do NOT edit existing migration files — the rename migration is how this reaches
already-migrated environments.
