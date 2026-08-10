# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Migration-chain consolidation: fold the two recent trailing changes back into
  their rightful CREATE migrations so the runtime migrator builds correctly
  0000 → latest without patch migrations.

## Current Goal

- Implement `_change-id-padding-standardization-plan.md`: widen the 9 non-compliant
  domain-table ID DEFAULT expressions (6/7 → 8 digits), loosen the exact-length
  validation regexes to `\d+`, update the affected integration tests, and pin the
  width in `code-standards.md` #18.

## Completed

- Change: Standardize Human-Readable ID Sequences to 8-Digit Padding
  (`_change-id-padding-standardization-plan.md`) — code complete.
  - [x] 4.1 Migration — the 8-digit `SET DEFAULT` widening shipped folded into the
        base CREATE migrations (`0006`/`0009`/`0012`), not a standalone `0023`
        (see *Migration-chain consolidation* below); the drizzle-kit baseline was
        later re-generated as `meta/0021_snapshot.json`.
  - [x] 4.2 Drizzle schema — 9 lpad `6/7 → 8` edits across product.ts, customer.ts,
        billing/accounts.ts, billing/catalogs.ts, billing/ledger-binding.ts.
  - [x] 4.3 Validation — 23 regexes → `^PREFIX\d+$` across 15 files (FIN, BAN, BCY,
        ORG, PRDOFR). CTMD/PTRL/DLN left at `\d{8}` per plan default.
  - [x] 4.4 Tests — 5 integration tests → `^PREFIX\d{8}$` for fresh inserts.
  - [x] Plan gap fixed: 3 unit tests in `tests/validation/` asserted the removed
        exact-width rejection (parse-accounts-context, organization.schema,
        offering-list.schema) — realigned to the `\d+` shape contract. (§4.4 only
        listed integration tests; these were under-scoped by the plan.)
  - [x] 4.6 Docs — `context/code-standards.md` #18 pins width to 8 and documents
        the `^PREFIX\d+$` validation rule.
  - [x] typecheck clean, lint clean, full unit suite green (2097 tests).

- Migration-chain consolidation (folded 0022 + 0023 into originals):
  - [x] `0006_product.sql` — PRDOFR/PRDOFP/PRDSMD lpad `6 → 8`.
  - [x] `0009_customer.sql` — ORG lpad `7 → 8`.
  - [x] `0012_billing_module_tables.sql` — BAN/FIN/BCY/GLM/LBD lpad `6 → 8`;
        `reference_date` column created directly as `entry_date`.
  - [x] Deleted `0022_document_rename_reference_date_to_entry_date.sql` and
        `0023_widen_id_sequence_padding.sql`; removed journal idx 22 & 23
        (tail truncation — no renumbering; journal now ends at 0021).
  - [x] `db/schema/billing/documents.ts` comment updated (no longer cites the
        deleted 0022 migration).
  - [x] Structural verification: 22 .sql = 22 journal entries, every tag has a
        file, zero leftover 6/7-digit lpad, zero `reference_date` in migrations,
        schema TS (source of truth) already matches (entry_date + 8-digit).
  - Safe because ALL databases are rebuilt from 0000 (user-confirmed) — editing
    already-applied migrations is otherwise a divergence hazard.

## Verification (DB rebuilt from 0000)

- Full rebuild run (steps 1–6): drop schemas → `db:migrate` as superuser →
  `db:bootstrap-roles` → `db:setup-partman` → seeds. §7 checklist confirmed by
  read-only query against the live DB:
  - 22 migrations applied, ledger `0000` → `0021` (no stale `0022`/`0023`).
  - `billing.document` has `entry_date`, no `reference_date`.
  - All 9 widened tables' ID defaults are `lpad(..., 8, '0')`; new inserts are 8-digit.
  - partman: `core.audit_log` config present; premake future partitions only
    partially created (known/accepted — a prior partman run left stale state;
    audit writes land in the default partition).
- NOT run against the live dev DB: `vitest --config vitest.integration.config.ts`
  — it drops+rebuilds all schemas (destructive) and would wipe the just-seeded
  DB. Run it on CI / a disposable DB for the end-to-end proof.
- Seed data: the rebuild produced a uniform 8-digit baseline, so option (a)'s
  mixed-width case does not arise; no legacy narrow rows remain.

## Open Questions

- Seed data: going with §5 option (a) — leave existing narrow-width rows as-is
  (recommended default). Reseed (option b) only if a clean baseline is later wanted.

## Architecture Decisions

- Human-readable domain-table IDs standardize on 8-digit zero-padded suffix
  (`PREFIX + lpad(nextval(seq), 8, '0')`). DEFAULT-expression change only; column
  stays `text`, sequence stays `BIGINT`. Existing rows keep their stored width.
- ID validation regexes use `^PREFIX\d+$` (shape, not fixed width) for the widened
  IDs so legacy-narrow, newly-widened, and future widths all stay valid; the
  always-8-digit IDs (party_role, contact_medium, document_line, document) keep
  `^PREFIX\d{8}$`.

## Session Notes

- Snapshot convention deviation from the plan is intentional; see In Progress note.
- No 6/7-digit width assumptions exist outside `validation/` and `tests/` (swept
  app/, components/, lib/, services/, db/).
