# User Management — Progress Tracker

## Status

| Unit | Name                                                        | Status |
| ---- | ----------------------------------------------------------- | ------ |
| um01 | Project Scaffold & Themed App Shell                         | Done   |
| um02 | Database Foundation & Better-Auth Identity Schema           | Done   |
| um03 | Local Sign-in + Seeded Break-glass Admin + Audit Foundation | Done   |
| um04 | Custom Per-Account Lockout (LOCAL)                          | Done   |
| um05 | RBAC Schema + Registry/Role Seed + Admin Grant              | Done   |
| um06 | Authorization Enforcement Core                              | Done   |
| um07 | Users list/detail (READ)                                    | Done   |
| um08 | Create user (EDIT)                                          | Done   |
| um09 | Forced first-login password change (`/set-password`)        | Done   |
| um10 | Entra SSO sign-in + email-match linking                     | Done   |
| um11 | Edit user details (EDIT)                                    | Done   |
| um12 | Assign / revoke roles (EDIT)                                | Done   |
| um13 | Disable / re-enable user (EDIT) + instant revocation        | Done   |
| um14 | Reset LOCAL password (EDIT)                                 | Done   |
| um15 | Unlock locked account (EDIT)                                | Done   |
| um16 | Switch auth_method SSO ↔ LOCAL (EDIT) + session revocation  | Done   |
| um17 | Tombstone-delete user (DELETE) + `DeleteUserDialog`         | Done   |

**Next:** um18+ — role CRUD, `/administration/roles`, audit-log page. Specs in `context/user-management/specs/`.

## Conventions (apply to every unit; specs often contradict these — codebase wins)

- **Validation files:** `validation/<entity>-<operation>.schema.ts` (not the specs' `validation/users.ts`).
- **Repositories:** every function takes the `db | tx: Database` handle as explicit first param (callers compose into their own transaction). Files never import `db/client` directly. Export style is per-file: plain named functions (`appuser`, `audit`, `lockout`, `roles`) vs namespace object (`roleAssignRepository`, `rolePermissionAssignRepository`) — each file keeps whatever its first export established.
- **Services:** read before-snapshot ahead of the transaction; run the mutation + `insertAuditEvent(...)` atomically in one `db.transaction`. Reads aren't audited.
- **Actions:** `requirePermission → schema.safeParse → service → revalidatePath('/administration/users')`; any thrown error (incl. `redirect()`'s `NEXT_REDIRECT`, gated via `isRedirectError`) maps to `{ ok:false, code:'FORBIDDEN' }` — actions are RPC-invoked, never navigations.
- **Errors:** `AppError` codes are `INTERNAL` / `FORBIDDEN` / `SERVER_ERROR` (no `INTERNAL_ERROR`). Repository "should never happen" guards throw plain `Error`.
- **Tests:** `tests/<area>/*.test.ts`; DB tests use the `*.integration.test.ts` suffix (separate `vitest.integration.config.ts`, `fileParallelism: false`, `describe.skipIf(!databaseUrl)` so missing `DATABASE_URL` loud-skips). Not the specs' `tests/unit`/`tests/integration`. Running integration suites DROPs `core`/`drizzle` — re-run `db:seed && db:seed-rbac` before manual smoke-testing on the same container.
- **Config:** `lib/config.ts` exposes fields under their raw env key (`config.DATABASE_URL`), Zod-validated, frozen, server-only. `BOOTSTRAP_ADMIN_*` live in a separate `db/seeds/seed-admin.config.ts` loader (seed-only), not `lib/config.ts`. SSO vars (`MICROSOFT_*`, `ENTRA_TENANT_ID`) are optional; `entraConfig`/`isSsoConfigured` derived from them.
- **Telemetry sink is `lib/logger.ts`** (specs' `lib/telemetry.ts` doesn't exist). Sole sanctioned `console.*` site; future GlitchTip/OTel hook.
- **`server-only` imports:** aliased to `tests/mocks/server-only.ts` (no-op) in both vitest configs.
- **React:** `react-hooks/set-state-in-effect` is enforced — never `useEffect(() => setState())`. Reset all state via a `key` prop on the parent; reset partial state by tracking the previous prop value and adjusting during render.
- **jsdom:** `tests/setup.ts` polyfills `hasPointerCapture` + `scrollIntoView` (Radix `Select` needs them).

## Stack & architecture facts

- **DB:** postgres.js + Drizzle, single `core` pgSchema (declared once in `db/schema/identity.ts`, imported by siblings). Schema files are **flat** in `db/schema/` (no `core/` subfolder). 9 tables: `appuser`, `account`, `session`, `verification`, `audit_log`, `roles`, `permissions`, `role_permission_assign`, `role_assign`. PK property is `id` in Drizzle (Better-Auth hardcodes `id`, not remappable); SQL columns stay snake_case. Better-Auth FK columns are `text`, not `uuid` (its id format). RBAC PKs are `uuid` `defaultRandom()`.
- **Migrations:** `0000_core.sql`, `0001_audit.sql`, `0002_rbac.sql` (renamed from Drizzle's auto-names; `meta/_journal.json` `tag`s must match or `db:migrate` breaks). `db:setup` = `db:migrate && db:seed && db:seed-rbac`. Seeds use a dedicated `postgres({max:1})` client, are idempotent, and write no `AUDIT_LOG` row (bootstrap exception).
- **Better-Auth (installed v1.6.19, explicit `@better-auth/core` dep):**
  - Field mapping in `auth/index.ts` only remaps fields whose default name differs from the Drizzle property (`createdAt`→`createdDatetime`, etc.).
  - Status gate (`ACTIVE || PENDING`) lives in `databaseHooks.session.create.before` (runs after password check). `DISABLED`/`DELETED` rejected. PENDING is allowed because first-login activation requires signing in pre-activation.
  - Lockout + SSO branch live in top-level `hooks.before`/`after` matched on `ctx.path` (the only point before password verification). Lockout bookkeeping try/catches and never rethrows; the lock-check (`before`) does propagate.
  - **Session payload carries no `status`/`force_password_change`** — pages needing those do their own `findUserById` lookup.
  - SSO: native account-linking resolves the email match itself before `account.create.before` fires; our hook only validates (reject LOCAL/DELETED). `disableSignUp: true` blocks JIT; `accountLinking.trustedProviders:['microsoft']` required (Entra omits `email_verified`); `mapProfileToUser` prefers `oid`. No auto GET signin route — `app/api/auth/signin/microsoft/route.ts` bridges to `signInSocial(asResponse:true)`.
- **AuthZ:** `auth/resolver.ts` builds the effective-permission map (highest `LEVEL_RANK` grant per `PermissionName`, no cache). `auth/guard.ts` exports `requireAuthenticated`/`requirePermission`/`resolveForcePasswordChangeSession` (all redirect, never return a Response). `app/page.tsx` is the one place that bypasses the guard layer (redirect-loop risk) and imports `db` directly — has its own `root-page` ESLint boundary carve-out. 4 permissions seeded (`users`, `roles`, `system_config`, `audit_log`), ADMIN-only matrix.
- **ESLint boundaries:** inward-only import graph (`eslint-plugin-boundaries` v6, `mode:"full"`). Client-safe carve-outs exist for single files: `auth/client.ts`, `auth/permission-constants.ts`, `auth/lockout.ts` (um15, lets `services/**` reuse `isCurrentlyLocked` instead of inlining the check). `components → actions`, `actions → services`, `services → db` are allowed.
- **UI / design tokens (`app/globals.css`):** full token system on `:root`; only a curated shadcn subset is re-exposed via `@theme inline`. Scale tokens (status/cyan/primary/neutral) have **no** Tailwind utility — reference them as `bg-[color:var(--color-success-50)]`. Scales define only `-50`/`-500`/`-700` steps (no `-300`/`-600`). The shadcn `--accent` slot maps to the magenta brand accent — override list/focus hover to `bg-muted`. shadcn CLI is v4.11 "Nova": no `Form` component (use `Field`/`FieldError` + RHF `register`), `components.json` has no `style` field. Vendor `components/ui/*` files: token wiring/consumer-side `className` overrides only, never hand-edited.

## Open items

- **um13:** one live disable call returned `SERVER_ERROR` in a browser against a _shared_ dev server; an isolated direct service call returned `{ ok:true }`. Unit/integration green. Re-check on an isolated dev server.
- **um14:** test-count baseline discrepancy (measured 345 on `dev2` vs um13's quoted 328) left unreconciled — verify next unit.
- **Locked-account message discloses** ("temporarily locked") rather than um04-spec's non-disclosing wording — deliberate um03 UX, user-confirmed. `auth/index.ts` throws `code: USER_LOCKED` with that message.
- **`/administration/system-config`** exists but is Entra-ID-only/minimal (built in um10 from scratch). A future system-config unit should treat it as already-owned, not recreate it. Entra values are env-only (no `SYSTEM_CONFIG` table).

## Per-unit specs

All under `context/user-management/specs/`. um01–um15 implemented; deviation/verification detail recoverable from git history if needed.

- um01 `um01-spec.md` — tooling + themed shell (Next 16.2, React 19, Tailwind v4, shadcn, ESLint boundaries, Vitest, `infra/azure-pipelines.yml`).
- um02 `um02-db-foundation-identity-schema.md` — Drizzle + 4 identity tables.
- um03 `um03-local-signin-admin-seed-audit.md` — credential provider, `/login`, `audit_log`, break-glass admin, `LOCAL_LOGIN` audit.
- um04 `um04-lockout.md` — per-account lockout state machine (5 fails → 15 min lock + `USER_LOCKED`).
- um05 `um05-rbac-schema-seed.md` — 4 RBAC tables, registry/role seed, ADMIN grant.
- um06 `um06-spec.md` — permission resolver, page guards, `/no-access`, root redirect.
- um07 `um07-spec.md` — `/administration/users` read (table/detail, badges, `AdminNav`).
- um08 `um08-spec.md` — create user (+ Rev 1: Auth Method dropdown, field reorder).
- um09 `um09-spec.md` — `/set-password` + PENDING→ACTIVE activation.
- um10 `um10-spec.md` — Entra SSO + email-match linking + minimal system-config page.
- um11 `um11-spec.md` — inline edit user name/phone.
- um12 `um12-spec.md` — assign/revoke roles + last-ADMIN guard.
- um13 `um13-spec.md` — disable/enable + instant session revocation + last-admin guard.
- um14 `um14-spec.md` — admin LOCAL password reset + one-time temp-password reveal.
- um15 `um15-spec.md` — admin unlock locked account (`USER_UNLOCKED`) + `Unlock` button/dialog on `UserDetail`.
- um16 `um16-spec.md` — switch `auth_method` SSO↔LOCAL (`USER_AUTH_METHOD_CHANGED`) + instant session revocation; SSO→LOCAL reveals one-time temp password, LOCAL→SSO clears credential + lockout. `Switch to …` control in the `UserDetail` Auth Method row + confirm dialog with self-switch warning.
- um17 `um17-spec.md` — tombstone-delete DISABLED users behind `users:DELETE` (`USER_DELETED`); atomically sets `status=DELETED`, strips `role_assign` + `account` rows + residual sessions, preserves the `appuser` row (no physical delete), frees email/Entra identity for reuse via the um02 partial unique index. New `DeleteUserDialog` (standalone, `AlertDialog`) + filled-danger "Delete user" header button on `UserDetail`; muted "· Deleted" header for DELETED users. Deviations from spec (codebase wins): repo file is `appuser.repository.ts` and `getUserRoleNames(db, userId)` takes the `db` handle (no module-`db`); audit writer is `insertAuditEvent`; validation is `validation/delete-user.schema.ts`; action maps redirect→FORBIDDEN via `isRedirectError` (no NEXT_REDIRECT re-throw); button/Alert use existing tokens (`--color-danger-500/700`, no `-600`; warning Alert via inline classes, no `variant="warning"`); dialog error-reset uses reset-during-render (tracks prev `isOpen`), not a `useEffect` (enforced `react-hooks/set-state-in-effect`); `isDeleted` cross-user reset relies on the page `key` remount. No migration needed — partial index already in `0000_core.sql`. Repository unit coverage folded into the integration test (codebase has no mocked-db repo tests).
