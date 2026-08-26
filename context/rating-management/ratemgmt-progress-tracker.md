# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase A — schema foundation (rm00-build-plan.md)

## Current Goal

- rm03: make the rating/billing separation a **database privilege** — create `rating_runtime`, grant the column-scoped surface (Inv #1/#2/#17a/#18) so a bug, a new dev or a hand-typed `psql` cannot cross the boundary. **Complete** (last unit of Phase A).

## Completed

- rm03 — `rating_runtime` role, grants and the billing boundary (`specs/rm03-rating-runtime-role-grants.md`). Delivered:
  - `db/bootstrap/rating-db-roles.sql` — new bootstrap script (NOT a Drizzle migration; needs `CREATEROLE`, D11). All eleven spec steps: role with `CONNECTION LIMIT 20` (idempotent, `ELSE ALTER` converges the limit), the D6 `REVOKE CONNECT … FROM PUBLIC` + explicit re-grant, schema `USAGE`, column-scoped `rating` table grants on the **parents only** (D3), the six-column `app_runtime` boundary (D1), the D8 sequence/function `EXECUTE`/`USAGE` grants, enumerated cross-schema `SELECT` (D9), the redundant-by-design `billing` write revoke (Inv #1), the D7 `REVOKE EXECUTE … FROM PUBLIC` on the four `SECURITY DEFINER` pgledger functions, `SELECT`-only default privileges (D5), and `app_migrate` schema ownership. Statement-breakpoint markers so the runner and `psql` can both apply it.
  - `db/bootstrap/rating-db-roles.ts` — the `npm run db:bootstrap-rating-roles` runner (copy of `bootstrap-db-roles.ts`), reading `BOOTSTRAP_DATABASE_URL`. Registered in `package.json`.
  - `infra/docs/db-role-verification.md` — extended the provisioning order with step 3 (`db:bootstrap-rating-roles`, after `db:bootstrap-roles`), a "Platform changes" note recording the two revokes (D6 `PUBLIC` `CONNECT`, D7 `PUBLIC` `EXECUTE` — escalations E1/E2) so an operator learns what changed database-wide, and the manual `ALTER ROLE rating_runtime PASSWORD` follow-up (never committed).
  - `tests/rating/grants.integration.test.ts` — live-DB assertion suite, a **connection per role**, asserting both the ACL (`has_*_privilege`) and the real statement it governs. Covers the pg_attribute enumeration (exactly six `app_runtime`-updatable + only `status` for `rating_runtime`), both-direction column refusals, `is_live` (D4), partition-direct refusal + zero child ACLs (Inv #17a), the D8 insert prerequisites, the billing boundary incl. the D7 `permission denied for function` + the standing "no `PUBLIC`-executable `SECURITY DEFINER`" assertion, the CONNECT boundary (D6, no-grant probe refused / three roles admitted / `rolconnlimit = 20`), the D5 default-privilege posture incl. the column-scoped-`ALTER DEFAULT PRIVILEGES` rejection, and idempotency (re-run → identical enumeration, limit still 20).
  - Verified: `tsc --noEmit`, ESLint, Prettier clean; the suite runs **31/31 green** against the disposable test Postgres (`docker-compose.test.yml`, port 5434), never the dev stack. Caught and fixed a self-inflicted bug during verification — a literal `--> statement-breakpoint` in the SQL header comment split the header mid-sentence (precedent avoids the arrow form in prose); reworded to match.



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

- None — rm03 implementation complete and its integration suite verified green (31/31). Phase A (rm01–rm03) done.

## Next Up

- Run `tests/rating/rm01-schema.integration.test.ts` (and re-run `tests/db/billing-partman-setup.integration.test.ts` / `tests/db/audit-*` integration suites, since their `.sql` files were retrofitted) against a disposable test Postgres — not the dev stack.
- rm03a — create the `kestra` database and `kestra_engine` role (same repo/boundary), which must be created **after** rm03's `REVOKE CONNECT … FROM PUBLIC`, plus the mirror-image revoke on the `kestra` database (Inv #18, both directions). See rm03 spec §Implementation Step 9a.
- Phase B — begins the rating runtime/engine units (rm04+); carry E1 forward as a billing-module escalation (own the D7 `SECURITY DEFINER` `FROM PUBLIC` revoke where the pgledger functions live), and the O4 carry-forward into rm12's clearing logic (`CLEARED` is the sixteenth seeded code).

## Open Questions

- rm02-spec §A prescribes the amendment constraint be named `event_catalog_severity_check`, but rm01 shipped it as `event_catalog_default_severity_check` (rm01 Open Questions). The rm02 verification suite asserts against the actually-shipped name rather than renaming a merged constraint for a purely cosmetic match. The behaviour (nullable + the six X.733 values, vocabulary identical to `process_log_severity_check`) is what the spec's items 1–2 actually require, and both pass.
- rm02-spec §Implementation §2 says "define [`RATING_EVENT_CODES`] once, alongside the seed." Shipped it in a sibling `rating-event-catalog.data.ts` (imported by both the runner and the test) rather than in the runner script itself, because the runner ends in `void main().catch(...)` — importing it would connect and seed as a side effect. The data module keeps the constant, the rows and the upsert side-effect-free. Same directory, so "alongside" holds.
- rm01-spec §Implementation §8 names the test file `tests/rating/rm01-schema.test.ts` (no `.integration.` infix). Every other live-DB suite in this repo uses `.integration.test.ts` so it lands in the separate `vitest.integration.config.ts` project (its `include` glob requires that suffix) rather than the DB-free default project. Shipped it as `rm01-schema.integration.test.ts` to match that mechanism; flagging in case the bare name was intentional and the convention should be revisited instead.
- `rating.event_catalog.default_severity` is documented as "CHECK" in rm01-spec §Implementation §5's column notes, but no CHECK SQL is given (unlike every other CHECK in the spec, which is spelled out). Resolved: added `event_catalog_default_severity_check` in `0034_rating.sql` allowing `NULL` or the same six severity values `process_log_severity_check` accepts, honouring the spec's "CHECK" note while preserving the nullable column ("NULL means logged but never alarms").
- rm03-spec §Implementation §4 names the test file `tests/rating/grants.test.ts` (no `.integration.` infix). Shipped it as `grants.integration.test.ts` for the same reason rm01/rm02 did: the DB-free default vitest project would grab a bare `.test.ts` and it would only ever `describe.skipIf` (no `DATABASE_URL`), while `vitest.integration.config.ts`'s include glob requires the `.integration.test.ts` suffix to run it against a live DB. Same standing convention question flagged for rm01.
- rm03 escalation E1 (open): `PUBLIC` held `EXECUTE` on the four `billing` `SECURITY DEFINER` pgledger functions — any login role could post ledger transfers. rm03 closes it (Step 9) but the defect predates rating and lives in the billing module; it should be raised there so the revoke is owned where the functions live and the next `SECURITY DEFINER` function ships with a matching `FROM PUBLIC`. rm03's standing assertion (grants suite item 28) fails the build if a fifth is added without one.

## Architecture Decisions

- [decisions made that affect the system design]

## Session Notes

- rm01 ripple: adding the first `rating.*` migration means every `tests/**/*.integration.test.ts` file's full-migration `beforeAll`/`afterAll` now creates the `rating` schema. Added `DROP SCHEMA IF EXISTS "rating" CASCADE` immediately before each existing `DROP SCHEMA IF EXISTS "core" CASCADE` call across all 71 affected files (140 insertions), mirroring the `customer`/`billing` schema precedent (see repo memory `new-pgschema-integration-test-ripple`).
- Migration is `0034_rating.sql` (next number after `0033_customer_bill_finalization_guard.sql`); journal entry added by hand in `db/migrations/meta/_journal.json` with no matching snapshot file, matching the existing gap for every other hand-authored partitioned-table migration (0018–0020, 0027–0033 also have no snapshot).