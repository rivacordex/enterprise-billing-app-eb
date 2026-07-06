# Product Management — Progress Tracker

## Status

| Unit | Name                                                                | Status             |
| ---- | ------------------------------------------------------------------- | ------------------ |
| pm01 | Route-group rename `(admin)` → `(app)` + rename-invariance CI proof | Done (uncommitted) |
| pm02 | DB foundation (`product` schema, 3 tables, constraints, perm seed)  | Not Started        |
| pm03 | Validation schemas (`validation/product/`)                          | Not Started        |
| pm04 | Seeds (`TOREMOVE-Template-*`)                                       | Not Started        |
| pm05 | Repositories + `services/product`                                   | Not Started        |
| pm06 | Nav refactor (`NAV_ITEMS` → `NAV_SECTIONS`)                         | Not Started        |
| pm07 | Page — one section per unit (table → detail → specs → prices)       | Not Started        |
| pm08 | Authz-matrix entry + remaining §9 guardrail tests                   | Not Started        |

**Next:** pm01 implemented per `specs/pm01-spec.md` — folder move (14 files via `git mv`), 6 test-file imports, 2 path comments (`lib/sidebar.ts`, `auth/guard.ts`), and the new `tests/app/route-manifest.test.ts` rename-invariance proof. Docs were already in sync ahead of code (repo copies of `usrmgmt-architecture.md` / `usrmgmt-code-standards.md` already referenced `(app)` with the historical "renamed from `(admin)`" note) — no doc edit was needed for this unit.

**Verified this session:** `git status` diff matches spec §5 exactly (14 renames + 6 test imports + 2 comments + 1 new test file; no other source file touched); `grep -rn` for the old group string across `app actions auth components db lib services types validation tests` returns zero matches; `npx vitest run` (unit config) — 101 files / 938 tests green, including all 7 rename-related files; `tsc --noEmit` clean after regenerating the stale `.next/` type-validator (a gitignored build artifact, expected to reference the old paths until rebuilt); `eslint .` clean; `next build` succeeds with the route table showing the same 8 URLs as before the rename; `prettier --check` flags only pre-existing `context/**` doc files, none touched by this unit.

**Not verified this session (needs a live environment):** the integration Vitest config (`vitest.integration.config.ts`) — no local Postgres was running; the manual dev-server spot check (sidebar collapse, deny-by-default for a no-grant user); the CI pipeline's SAST/ZAP baseline. None of this unit's changes touch DB, auth, or runtime logic, so no regression is expected, but these gates should still run before merge.

**Not yet committed** — changes are in the working tree; commit per user confirmation (workflow supplement §3.6 names one commit containing exactly this unit's diff).

## Per-unit specs

| Unit | Spec file            | Summary                                                                                                                                                                                                                                                                  |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| pm01 | `specs/pm01-spec.md` | Rename `app/(admin)/**` → `app/(app)/**` (14 files, `git mv`); update 6 test imports + 2 path comments; add `tests/app/route-manifest.test.ts` rename-invariance proof (manifest set-equal, old group gone, no stale `(admin)` reference in code dirs). No other change. |
