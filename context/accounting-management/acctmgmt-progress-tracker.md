# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase 1 — Data core (ac00-build-plan.md unit 1 of 17)

## Current Goal

- ac01 — pgledger Foundation: vendor the pgledger fork (tables/functions/views) into `billing` via a transform pipeline, vendor the ULID helper it depends on, land the one raw-SQL migration, and get the V1 zero-sum scratch test green.

## Completed

- **ac01 — pgledger Foundation** (`context/accounting-management/specs/ac01-pgledger-foundation.md`). Started and finished 2026-07-25. Not yet committed to git (uncommitted working tree — commit is the user's call). Verified locally: `npm run pgledger:transform` idempotent (clean re-run), transform unit tests green (7/7, `tests/pgledger/transform.test.ts`), fresh-DB migrate + scratch + V1 zero-sum + engine guardrail tests green (`tests/accounts/v01-zero-sum.integration.test.ts`, run against a throwaway Postgres 16 container — never against the shared dev-stack `DATABASE_URL`), full existing test suite still green (1586 unit + 356 integration tests across 38 integration files, including the 37 files that got the new `billing` schema drop), `typecheck`/`lint`/`format:check` all clean, `db:generate` confirmed a no-op ("No schema changes, nothing to migrate").

## In Progress

- None — ac02 not yet started.

## Next Up

- ac02 — module tables migration set (`financial_account`, `billing_account`, … + views + PERMISSIONS rows), per `acctmgmt-ai-workflow-rules.md` §2 unit 2. When it adds `db/schema/billing/**` and puts `billing` into `drizzle.config.ts`'s `schemaFilter`, it must **in the same change** add the `tablesFilter` exclusion for `pgledger_*` (spec ac01 §2.5/§3.5) — untested territory since ac01 deliberately never put `billing` in `schemaFilter` (see Session Notes).

## Open Questions

- None — Q1–Q28 in `_newmodule-account-plan.md` are all resolved; ac01 raised no new Q.

## Architecture Decisions

- None yet beyond the plan's Q1–Q28.

## Session Notes

- **ac01 codebase-verification findings** (spec's "Note on codebase verification", both now resolved and corrected here rather than by editing the spec's placeholder text):
  1. **Next free migration index: `0011`** (`db/migrations/0000`…`0010` already exist through `product_offering_family`). Generated via `drizzle-kit generate --custom --name=billing_pgledger`, producing `db/migrations/0011_billing_pgledger.sql` + the journal entry + `meta/0011_snapshot.json` (a no-op diff vs `0010` — `billing` is not yet in `drizzle.config.ts`'s `schemaFilter`, so nothing to diff).
  2. **An existing Postgres ULID generator does exist in `core`** (`core.generate_ulid()`, added by um27, returns `uuid`) — but it is **not** a substitute for what this unit needs, so §3.3's vendored `ulid.sql` was **not** dropped. Reasoning: upstream `pgledger.sql` already contains its own id-generation logic (`pgledger_uuidv7()` + `pgledger_generate_id(prefix)`) and depends on exactly one external symbol, `uuid_to_ulid(uuid) → text`, vendored upstream itself from `scoville/pgsql-ulid` (BSD-3-Clause) at `pgr0ss/pgledger`'s own `vendor/scoville-pgsql-ulid/uuid-to-ulid.sql`. `core.generate_ulid()` has a different signature/purpose (generates a whole new ULID-as-uuid from scratch; pgledger needs a uuid→ULID-**text** converter applied to a uuid it already generated internally). Swapping in `core.generate_ulid()` would require hand-editing `pgledger_generate_id`'s body — forbidden by module inv. #14 ("changes namespaces, never behaviour"). So `db/pgledger/ulid.sql` vendors `uuid-to-ulid.sql` verbatim (qualified into `billing`), matching pgledger's own upstream dependency exactly.
- **Upstream identity confirmed:** `pgledger` = `pgr0ss/pgledger` (Paul Gross, MIT License). `UPSTREAM_COMMIT` = `43240dbdfc291eca5380cbcee7dfe594922c67d6` (2026-02-06, GPG-verified, tip of `main` at implementation time). The vendored ULID helper (`db/pgledger/ulid.sql`) traces to `scoville/pgsql-ulid` (BSD-3-Clause), vendored transitively via pgledger's own `vendor/scoville-pgsql-ulid/uuid-to-ulid.sql` — both licenses are permissive and compatible with vendoring into this proprietary codebase; provenance recorded in each file's header for future license-audit purposes.
- **Test-suite ripple applied:** per the platform pattern (every prior module's pgSchema needs this), added `await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');` to the `beforeAll`/`afterAll` of all 37 existing `*.integration.test.ts` files that do the full-schema drop+migrate cycle, immediately before their existing `"customer"` drop line — otherwise a later integration test's `migrate()` hits `CREATE TABLE billing.pgledger_accounts` on a non-empty `billing` schema left behind by an earlier test file and fails with "already exists".
- `billing` is **not** added to `drizzle.config.ts`'s `schemaFilter` in this unit (still `["core", "product", "customer"]`) — ac02 adds it alongside the module's Drizzle schema files, together with the `tablesFilter` exclusion for `pgledger_*` called out in spec §2.5/§3.5 (todo for ac02, not rediscovered here since `billing` isn't filtered in yet, so `db:generate` cannot touch it either way).