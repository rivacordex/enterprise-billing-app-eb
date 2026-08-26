# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase A — schema foundation (rm00-build-plan.md)

## Current Goal

- rm02: seed `rating.event_catalog` so severity, X.733 event type, probable cause and clearing behaviour resolve from data at emit time (never hardcoded at a call site), for all sixteen `event_code`s the module can emit.

## Completed

- rm02 — `event_catalog` seed (`specs/rm02-event-catalog-seed.md`). Delivered:
  - `db/seeds/rating-event-catalog.data.ts` — the sixteen catalog rows, the `RATING_EVENT_CODES` typed constant + `RatingEventCode` type, and the reusable `seedEventCatalog(db)` upsert. Side-effect-free so the verification suite imports it without connecting (the seed-admin.ts / seed-admin.config.ts split precedent). Idempotent as `ON CONFLICT (event_code) DO UPDATE` — not `DO NOTHING` — so a re-run carries a severity re-tune (including back to NULL) to an existing environment; never `DELETE`s or deactivates a code absent from the list.
  - `db/seeds/rating-event-catalog.ts` — the standalone `npm run db:seed-rating` runner wrapping `seedEventCatalog`.
  - `package.json` — added `db:seed-rating`, appended to the `db:setup` chain after `db:seed-billing`.
  - `tests/rating/rm02-event-catalog-seed.integration.test.ts` — live-DB verification suite, items 1–20 + 23 (build-hygiene items 21/22 are the tsc/lint/prettier + empty-DB-seed run, exercised outside the suite; 22 is also covered by the suite's `beforeAll` seeding green from a freshly migrated DB). Includes the §A1 pair (13+14 in one test) that a `COALESCE(default_severity,'INDETERMINATE')` implementation would collapse.
  - The rm01 amendment in §A (`default_severity` nullable + `event_catalog_default_severity_check`) was already shipped by rm01 (see rm01 Open Questions / rm02 O1), so no migration change was needed here — rm02 builds against it and asserts it (items 1–2).
  - Verified: `tsc --noEmit`, ESLint, Prettier all clean; the rm02 integration suite runs 20/20 green against the disposable test Postgres (`docker-compose.test.yml`, port 5434), never the dev stack.

- rm01 — `rating` schema foundation (`specs/rm01-rating-schema-foundation.md`). Delivered:
  - `db/migrations/0034_rating.sql` — hand-authored DDL: `rating` schema, `rating.period_of()`, `udr_batch_seq`, `udr_rated`/`udr_batch`/`process_log`/`event_catalog` with every constraint and index the spec lists, both `*_default` bootstrap partitions.
  - `db/schema/rating/{pg-schema,udr-rated,udr-batch,process-log,event-catalog,index}.ts` — Drizzle typing-only declarations; wired into `db/schema/index.ts`.
  - `validation/rating/udr-rate-detail.schema.ts` — discriminated union on `udr_rate_type`, FLAT only (v1 scope).
  - `db/bootstrap/rating-partman-setup.{sql,ts}` — pg_partman registration (`udr_rated` 7yr / `process_log` 24mo, both DETACH), no second cron job. Retrofitted the pg_partman-v5 preflight assertion into `audit-partman-setup.sql` and `billing-partman-setup.sql` per spec §Implementation §6.
  - `package.json` — added `db:setup-partman-rating`, wired into `db:setup`. `db:setup` now runs `db:setup-partman` (the shared audit-log/pg_partman bootstrap) before `db:setup-partman-billing` and `db:setup-partman-rating`, so a fresh deployment provisions the `audit-log-partman-maintenance` job the billing and rating bootstraps depend on for their maintenance sweep.
  - `tests/rating/rm01-schema.integration.test.ts` — live-DB verification suite (items 1–24, 28). Named `.integration.test.ts` (not the spec's literal `rm01-schema.test.ts`) so it's actually picked up by `vitest.integration.config.ts`'s include glob rather than the DB-free default project — see Open Questions.
  - Fixed a legitimate ship-gate casualty: `tests/services/billing/collect-claim.test.ts`'s bm13 v1-placeholder guard asserted **no** `rating` export existed anywhere in `db/schema` — true only until a real rating schema shipped, and its own comment said as much. Narrowed the assertion to what must still hold on the billing side (collect-claim.ts imports nothing from `db/schema/rating`; no sanctioned rating-schema writer file exists yet).
  - Verified: `tsc --noEmit`, `npm run lint`, `prettier --check` all clean; full non-DB `vitest run` clean (2758/2758, after the collect-claim fix — a handful of unrelated action-test failures are pre-existing stale-hardcoded-date flakiness, confirmed unrelated by re-running in isolation). **Not yet run:** the new `tests/rating/rm01-schema.integration.test.ts` itself, and `tests/db/billing-partman-setup.integration.test.ts` post-retrofit — both need a disposable test Postgres, never the dev stack's `DATABASE_URL` (repo memory: `local-docker-dev-stack`).

## In Progress

- None — rm02 implementation complete and its integration suite verified green (20/20).

## Next Up

- Run `tests/rating/rm01-schema.integration.test.ts` (and re-run `tests/db/billing-partman-setup.integration.test.ts` / `tests/db/audit-*` integration suites, since their `.sql` files were retrofitted) against a disposable test Postgres — not the dev stack.
- rm03 — `rating_runtime` role grants (the grant table in code-standards §9), and the O4 carry-forward into rm12's clearing logic (`CLEARED` is now the sixteenth seeded code).

## Open Questions

- rm02-spec §A prescribes the amendment constraint be named `event_catalog_severity_check`, but rm01 shipped it as `event_catalog_default_severity_check` (rm01 Open Questions). The rm02 verification suite asserts against the actually-shipped name rather than renaming a merged constraint for a purely cosmetic match. The behaviour (nullable + the six X.733 values, vocabulary identical to `process_log_severity_check`) is what the spec's items 1–2 actually require, and both pass.
- rm02-spec §Implementation §2 says "define [`RATING_EVENT_CODES`] once, alongside the seed." Shipped it in a sibling `rating-event-catalog.data.ts` (imported by both the runner and the test) rather than in the runner script itself, because the runner ends in `void main().catch(...)` — importing it would connect and seed as a side effect. The data module keeps the constant, the rows and the upsert side-effect-free. Same directory, so "alongside" holds.
- rm01-spec §Implementation §8 names the test file `tests/rating/rm01-schema.test.ts` (no `.integration.` infix). Every other live-DB suite in this repo uses `.integration.test.ts` so it lands in the separate `vitest.integration.config.ts` project (its `include` glob requires that suffix) rather than the DB-free default project. Shipped it as `rm01-schema.integration.test.ts` to match that mechanism; flagging in case the bare name was intentional and the convention should be revisited instead.
- `rating.event_catalog.default_severity` is documented as "CHECK" in rm01-spec §Implementation §5's column notes, but no CHECK SQL is given (unlike every other CHECK in the spec, which is spelled out). Resolved: added `event_catalog_default_severity_check` in `0034_rating.sql` allowing `NULL` or the same six severity values `process_log_severity_check` accepts, honouring the spec's "CHECK" note while preserving the nullable column ("NULL means logged but never alarms").

## Architecture Decisions

- [decisions made that affect the system design]

## Session Notes

- rm01 ripple: adding the first `rating.*` migration means every `tests/**/*.integration.test.ts` file's full-migration `beforeAll`/`afterAll` now creates the `rating` schema. Added `DROP SCHEMA IF EXISTS "rating" CASCADE` immediately before each existing `DROP SCHEMA IF EXISTS "core" CASCADE` call across all 71 affected files (140 insertions), mirroring the `customer`/`billing` schema precedent (see repo memory `new-pgschema-integration-test-ripple`).
- Migration is `0034_rating.sql` (next number after `0033_customer_bill_finalization_guard.sql`); journal entry added by hand in `db/migrations/meta/_journal.json` with no matching snapshot file, matching the existing gap for every other hand-authored partitioned-table migration (0018–0020, 0027–0033 also have no snapshot).