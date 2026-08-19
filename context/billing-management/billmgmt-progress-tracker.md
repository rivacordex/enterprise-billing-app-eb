# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Phase 1 — Bill Run module build (bottom-up, one vertical unit per pass).

## Current Goal

- bm01 delivered: the Billing nav section + permission-gated Bill Runs scaffold.
  Next: bm02 (lazy materialization + run-list read).

## Completed

- **bm01 — Billing section & RBAC scaffold** (`specs/bm01-billing-section-rbac-scaffold.md`).
  Auth/RBAC + app shell only; no domain tables.
  - Permission registry: `billrun_view` / `billrun_operate` / `billrun_approve`
    added to `PERMISSION_NAMES` (`types/rbac.ts`) + typed `PERMISSIONS.BILLRUN_*`
    constants (`auth/permission-constants.ts`). Rows land in migration
    `0024_billrun_permissions.sql` (`INSERT … ON CONFLICT DO NOTHING`).
  - Seeded role: `BILLING_VIEWER` added to `SEEDED_ROLE_NAMES` (protected by
    `isSeededRole`). Created + granted by the new `db/seeds/billing.ts`
    (`db:seed-billing`, wired into `db:setup`): BILLING_VIEWER → `billrun_view:READ`;
    ADMIN → `billrun_view:READ`, `billrun_operate:EDIT`, `billrun_approve:EDIT`.
    Idempotent (role pre-check + `onConflictDoNothing` on grants).
  - Route/page/states: `app/(app)/billing/bill-runs/{page,loading,error}.tsx` —
    `BillRunsPage` guards `billrun_view:READ` then renders `BillRunsEmptyState`
    (`components/billing/bill-runs-empty-state.tsx`, server component, scaffold
    empty state; no data fetch, no StubDataBanner, no CTA).
  - Nav: `Billing` section (`ReceiptText` icon, `billrun_view:READ`
    requiredPermission → fail-closed lock) inserted between Accounts and
    Administration in `components/admin-nav.tsx`.
  - Route × level matrix test: `tests/app/bill-runs-page.test.tsx`
    (granted → renders; no grant → /no-access; unauthenticated → /login).

## In Progress

- None.

## Next Up

- **bm02** — Lazy materialization + run-list read: `billing/bill-runs/page.tsx`
  materialize service (`ON CONFLICT (ref_bill_cycle_id, period_start) DO NOTHING`),
  `RunListRow` read model, `BillRunList`, still `billrun_view` guarded.

## Open Questions

- None for bm01.

## Architecture Decisions

- **Permission names are snake_case** (`billrun_view/operate/approve`), matching
  the delivered Accounts pattern; docs (architecture §4, code-standards §7/§8)
  already reflect this and the `/billing/bill-runs` route.
- **Three permissions, not one with levels** — segregation of duties (four-eyes):
  operate and approve must be grantable to different people.
- **Permission rows in a migration; grants in a seed** — established split
  (`0023`/`db:seed-ordering` precedent).
- **`billrun_*` are optional permissions** (`types/permissions.ts`
  `OptionalPermissionName`) — the resolver omits ungranted permissions and users
  predating the module hold none; this also prevents rippling `null` into every
  hardcoded `EffectivePermissionMap` fixture (same um06/pm25 move).

## Session Notes

- Context docs live under `context/billing-management/` (matches AGENTS.md).
  The folder was renamed from an earlier `billling-management` (triple-l) typo.
- Adding the three permission names required mechanical fixture updates in
  `tests/{auth/resolver, services/roles-read.service, components/{admin-nav,
  permission-matrix-editor,role-detail}}` (permission count 11 → 14) and
  registering `/billing/bill-runs` in `tests/app/route-manifest.test.ts` — the
  same ripple pm25 handled when it added the two ordering permissions.
- Pre-existing, unrelated: the 4 date-dependent action suites
  (`create-order`, `resume/suspend/terminate-subscription`) fail on the clean
  baseline too (hardcoded dates now >3 days in the past vs. 2026-08-19).
