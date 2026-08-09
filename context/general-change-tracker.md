```markdown
# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Consistency fix: standardize human-readable ID sequences to 8-digit padding.

## Current Goal

- Implement `_change-id-padding-standardization-plan.md`: widen the 9 non-compliant
  domain-table ID DEFAULT expressions (6/7 → 8 digits), loosen the exact-length
  validation regexes to `\d+`, update the affected integration tests, and pin the
  width in `code-standards.md` #18.

## Completed

- Change: Standardize Human-Readable ID Sequences to 8-Digit Padding
  (`_change-id-padding-standardization-plan.md`) — code complete.
  - [x] 4.1 Migration `0023_widen_id_sequence_padding.sql` (hand-authored, 9× SET
        DEFAULT only) + `_journal.json` idx 23. No snapshot file (deviation from
        plan §4.1) — repo has not regenerated `meta/*_snapshot.json` since 0017;
        0018–0022 are journal-only, so 0023 follows that established convention.
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

## Next Up

- DB-dependent verification NOT yet run in this environment (no live DB):
  - Apply `npm run db:migrate` and confirm §7 checklist — a fresh INSERT into each
    of the 9 tables yields an 8-digit suffix; a pre-existing narrow-width row is
    unchanged and still passes its (now `\d+`) validator.
  - Run the integration suite (`vitest --config vitest.integration.config.ts`),
    including the 5 files in §4.4, against a migrated DB.
- Seed data: §5 option (a) chosen — existing narrow rows left as-is; no reseed.

## Open Questions

- Seed data: going with §5 option (a) — leave existing narrow-width rows as-is
  (recommended default). Reseed (option b) only if a clean baseline is later wanted.

## Architecture Decisions

- Human-readable domain-table IDs standardize on 8-digit zero-padded suffix
  (`PREFIX + lpad(nextval(seq), 8, '0')`). DEFAULT-expression change only; column
  stays `text`, sequence stays `BIGINT`. Existing rows keep their stored width.
- ID validation regexes use `^PREFIX\d+$` (shape, not fixed width) so legacy narrow
  IDs, newly-widened IDs, and any future width change all remain valid.

## Session Notes

- Snapshot convention deviation from the plan is intentional; see In Progress note.
- No 6/7-digit width assumptions exist outside `validation/` and `tests/` (swept
  app/, components/, lib/, services/, db/).
```
