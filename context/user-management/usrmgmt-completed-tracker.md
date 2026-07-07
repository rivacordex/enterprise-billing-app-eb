# User Management — Progress Tracker

## Status

| Unit | Name                                                          | Status |
| ---- | ------------------------------------------------------------- | ------ |
| um01 | Project Scaffold & Themed App Shell                           | Done   |
| um02 | Database Foundation & Better-Auth Identity Schema             | Done   |
| um03 | Local Sign-in + Seeded Break-glass Admin + Audit Foundation   | Done   |
| um04 | Custom Per-Account Lockout (LOCAL)                            | Done   |
| um05 | RBAC Schema + Registry/Role Seed + Admin Grant                | Done   |
| um06 | Authorization Enforcement Core                                | Done   |
| um07 | Users list/detail (READ)                                      | Done   |
| um08 | Create user (EDIT)                                            | Done   |
| um09 | Forced first-login password change (`/set-password`)          | Done   |
| um10 | Entra SSO sign-in + email-match linking                       | Done   |
| um11 | Edit user details (EDIT)                                      | Done   |
| um12 | Assign / revoke roles (EDIT)                                  | Done   |
| um13 | Disable / re-enable user (EDIT) + instant revocation          | Done   |
| um14 | Reset LOCAL password (EDIT)                                   | Done   |
| um15 | Unlock locked account (EDIT)                                  | Done   |
| um16 | Switch auth_method SSO ↔ LOCAL (EDIT) + session revocation    | Done   |
| um17 | Tombstone-delete user (DELETE) + `DeleteUserDialog`           | Done   |
| um18 | Roles list/detail (READ)                                      | Done   |
| um19 | Create & edit role (EDIT)                                     | Done   |
| um20 | Map role → permission levels (EDIT)                           | Done   |
| um21 | Delete role (DELETE)                                          | Done   |
| um22 | System Config view (READ)                                     | Done   |
| um23 | System Config edit (EDIT)                                     | Done   |
| um24 | Audit Log viewer (READ)                                       | Done   |
| um25 | Password Complexity (config + validation + temp-password gen) | Done   |
| um26 | Logout (sidebar sign-out button)                              | Done   |
| um27 | Audit Log → ULID + Range Partitioning (pg_partman) (INFRA)    | Done   |
| um28 | Side Panel & System Config (chrome + branding + locale)       | Done   |
| um29 | Configurable Business Timezone (display + boundary)           | Done   |
| um30 | Deployment, Secrets & Security Gates (INFRA)                  | Done   |

**Next:** all specced units implemented and shipped (a working Azure deployment exists — see ZAP reports under `context/zap-reports/`). Only open items below remain.

## Open items (verified 2026-07-02)

- **ZAP PR13v2 — both fixes landed on `dev1`, uncommitted** (`context/zap-reports/ZAP-PR13v2-fix-plan.md`):
  - Fix 1 (Medium, rule 10055): `style-src 'unsafe-inline'` removed. Confirmed in code — `next.config.ts` sets `style-src 'self'`, `audit-log-table.tsx`'s swatch uses a Tailwind class map, `sonner.tsx`'s custom properties moved to `.toaster{}` in `globals.css`, and an ESLint `no-restricted-syntax` rule now bans the `style` JSX prop.
  - Fix 2 (Low, rule 10110): the shipped `/login` chunk's `eval(` (from `node:crypto`→`crypto-browserify`→`vm-browserify` leaking into the client bundle) is fixed by splitting client-safe CSRF constants into new `lib/csrf-shared.ts`; `lib/csrf.ts` keeps the `node:crypto` users behind `import "server-only"`. Confirmed: `lib/csrf-shared.ts` exists, `lib/csrf.ts`/`login-form.tsx` updated, full unit suite green (934/934).
  - **Remaining:** re-run the ZAP baseline scan against staging to confirm both rules produce 0 alerts (external/deploy-gated, not a code task).
- **`db/bootstrap/audit-partman-setup.ts` is not idempotent** — re-running `db:setup-partman` against a Postgres volume that already has pg_partman provisioned fails on a `part_config_parent_table_pkey` duplicate-key error (unlike `db:migrate`/`db:seed`, which are idempotent). Confirmed still unfixed in `db/bootstrap/audit-partman-setup.sql`. Fix when next touched: guard the `create_parent` call or catch-and-skip if already registered.
- **Entra callback URI (manual, Azure portal only):** confirm `<APP_BASE_URL>/api/auth/callback/microsoft` is registered in the Entra app registration's Redirect URIs — can't be verified from the repo.
- **um29 manual `/qa` runtime pass** (set `APP_TIMEZONE=Asia/Kuala_Lumpur`, click through Users/Roles/System Config/Audit Log, confirm +08 display + correct local-day filter across UTC midnight) — status unconfirmed; re-verify if not already done.
- **Locked-account message intentionally discloses** ("temporarily locked") rather than um04-spec's non-disclosing wording — deliberate um03 UX, user-confirmed. Not a bug. `auth/index.ts` throws `code: USER_LOCKED` with that message.

### Resolved / stale items removed from this list (verified 2026-07-02)

`.env` deleted-from-tree note (um18) — stale, `.env` now present and points at a real Azure Postgres instance, not the old shared Tailscale dev DB. um27 partition-exclusion test drift — verified fixed (`tests/db/migration.integration.test.ts` now filters `relispartition`). um13 SERVER_ERROR anomaly and um14 test-count discrepancy — unreproduced one-offs, superseded by dozens of clean full-suite runs since (currently 934/934). `(um25)` comment clash and um29's two stale-test fixes — resolved in-place, no longer relevant.

## Conventions (apply to every unit; specs often contradict these — codebase wins)

- **Validation files:** `validation/<entity>-<operation>.schema.ts` (one file per schema, not the specs' single `validation/<domain>.ts`).
- **Repositories:** every function takes the `db | tx: Database` handle as explicit first param; files never import `db/client` directly. Export style is per-file (plain named functions vs namespace object) — each file keeps whatever its first export established.
- **Services:** read before-snapshot ahead of the transaction; run the mutation + `insertAuditEvent(...)` atomically in one `db.transaction`. Reads aren't audited.
- **Actions:** `requirePermission → schema.safeParse → service → revalidatePath(...)`; any thrown error (incl. `redirect()`'s `NEXT_REDIRECT`, gated via `isRedirectError`) maps to `{ ok:false, code:'FORBIDDEN' }` — actions are RPC-invoked, never navigations.
- **Errors:** `AppError` codes are `INTERNAL` / `FORBIDDEN` / `SERVER_ERROR` (no `INTERNAL_ERROR`). Repository "should never happen" guards throw plain `Error`.
- **Tests:** `tests/<area>/*.test.ts`; DB tests use `*.integration.test.ts` (separate `vitest.integration.config.ts`, `fileParallelism: false`, `describe.skipIf(!databaseUrl)`). Running integration suites DROPs `core`/`drizzle` — re-run `db:seed && db:seed-rbac` before manual smoke-testing on the same container. No mocked-db repository unit tests anywhere — integration tests are the sole repo coverage.
- **Config:** `lib/config.ts` exposes fields under their raw env key (`config.DATABASE_URL`), Zod-validated, frozen, server-only. `BOOTSTRAP_ADMIN_*` live in `db/seeds/seed-admin.config.ts` (seed-only). SSO vars (`MICROSOFT_*`, `ENTRA_TENANT_ID`) are optional; `entraConfig`/`isSsoConfigured` derived from them.
- **Telemetry sink is `lib/logger.ts`** — sole sanctioned `console.*` site; future GlitchTip/OTel hook.
- **`server-only` imports:** aliased to `tests/mocks/server-only.ts` (no-op) in both vitest configs.
- **React:** `react-hooks/set-state-in-effect` is enforced — never `useEffect(() => setState())`. Reset all state via a `key` prop on the parent; reset partial state by tracking the previous prop value during render.
- **jsdom:** `tests/setup.ts` polyfills `hasPointerCapture` + `scrollIntoView` (Radix `Select` needs them).
- **No `PageHeader`/breadcrumb component** exists anywhere — admin pages render a plain `<h1>`.
- **Danger/destructive styling** reuses `--color-danger-500`/`-700`/`-50` tokens or `Alert variant="destructive"` — the danger scale has no `-200`/`-600` step, contrary to what several specs' literal class names assumed.

## Stack & architecture facts

- **DB:** postgres.js + Drizzle, single `core` pgSchema (declared once in `db/schema/identity.ts`). Schema files are flat in `db/schema/` (no subfolder, no `.schema.ts` suffix). 10 tables: `appuser`, `account`, `session`, `verification`, `audit_log`, `roles`, `permissions`, `role_permission_assign`, `role_assign`, `system_config`. PK property is `id` in Drizzle; SQL columns stay snake_case. Better-Auth FK columns are `text` (its id format), not `uuid` — RBAC PKs are `uuid` `defaultRandom()`.
- **Migrations:** `0000`–`0005` (`core`, `audit`, `rbac`, `roles_name_ci_unique`, `system_config`, `admin_chrome_config`). `meta/_journal.json` `tag`s must match filenames. `db:setup` = `db:migrate && db:seed && db:seed-rbac`. Two provisioning scripts run outside the migration sequence (superuser-only, once per env, after migrate): `db/bootstrap/bootstrap-db-roles.sql` (`npm run db:bootstrap-roles`, least-privilege `app_runtime`/`app_migrate` roles) and `db/bootstrap/audit-partman-setup.sql` (`npm run db:setup-partman`, pg_partman/pg_cron monthly partitioning + 7-year retention — **not idempotent**, see Open Items). `audit_log` is `PARTITION BY RANGE (created_datetime)`, ULID-keyed (`core.generate_ulid()`), composite PK `(audit_id, created_datetime)`, with an `audit_log_default` bootstrap partition.
- **Better-Auth (v1.6.19):**
  - Field mapping in `auth/index.ts` only remaps fields whose default name differs from the Drizzle property.
  - Status gate (`ACTIVE || PENDING`) lives in `databaseHooks.session.create.before`. PENDING is allowed because first-login activation requires signing in pre-activation.
  - Lockout + SSO branch live in top-level `hooks.before`/`after` matched on `ctx.path`. Session payload carries no `status`/`force_password_change` — pages needing those do their own `findUserById` lookup.
  - SSO: native account-linking resolves the email match before `account.create.before` fires; hook only validates (reject LOCAL/DELETED). `disableSignUp: true` blocks JIT; `mapProfileToUser` prefers `oid`, falls back `email ?? preferred_username ?? upn` (Entra omits `email_verified`/`email` for mailbox-less test accounts).
- **AuthZ:** `auth/resolver.ts` builds the effective-permission map (highest `LEVEL_RANK` grant per `PermissionName`, no cache). `auth/guard.ts` exports `requireAuthenticated`/`requirePermission`/`resolveForcePasswordChangeSession`/`getCurrentUserIdentity` (all but the last redirect, never return a Response). `app/page.tsx` is the one place that bypasses the guard layer and imports `db` directly. 4 permissions seeded (`users`, `roles`, `system_config`, `audit_log`), ADMIN-only matrix; `audit_log` is READ-max (no writes/deletes).
- **ESLint boundaries:** inward-only import graph (`eslint-plugin-boundaries` v6, `mode:"full"`). Client-safe carve-outs exist for single files (`auth/client.ts`, `auth/permission-constants.ts`, `auth/lockout.ts`, `lib/csrf-shared.ts`). `components → actions`, `actions → services`, `services → db` are allowed. `style` JSX prop is banned repo-wide (`no-restricted-syntax`, ZAP rule 10055).
- **UI / design tokens (`app/globals.css`):** full token system on `:root`; only a curated shadcn subset re-exposed via `@theme inline`. Scale tokens (status/cyan/primary/neutral) have no Tailwind utility — reference as `bg-[color:var(--color-success-50)]`. Scales define only `-50`/`-500`/`-700` steps. shadcn CLI v4.11 "Nova": no `Form` component (use `Field`/`FieldError` + RHF `register`). Vendor `components/ui/*` files: token wiring/consumer-side `className` overrides only, never hand-edited.
- **Chrome:** collapsible `AdminSidebar` (icon-rail ↔ full width, `sidebar_collapsed` cookie), admin-configurable logo (`BrandLogo`, `/brand/`-only paths, monogram fallback), locale/currency-driven formatting (`lib/locale.ts`, `lib/formatters.ts`), timezone-aware audit-log day boundaries (`lib/timezone.ts`, DST-correct two-pass resolution).
- **Deployment:** 3-stage Dockerfile (non-root, `output: "standalone"`), `infra/azure-pipelines.yml` (`build`→`test_scan`→`containerize`→`migrate`→`deploy`→`zap_scan`), Bicep IaC under `infra/bicep/`. Secrets via Azure Key Vault + Managed Identity; SSO client ID/tenant ID are deploy-time params (public identifiers, not secrets) sourced from the `um30-infra` variable group, never committed.

## Per-unit specs

All specs under `context/user-management/specs/`. Deviations consistently favor "codebase wins" over literal spec text (file paths/names, validation-file-per-schema, no `useTransition`, no shadcn `Form`, danger-token corrections, etc.) — full deviation/verification detail recoverable from git history if needed.

| Unit | Spec file                                   | Summary                                                                                                                                   |
| ---- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| um01 | `um01-spec.md`                              | Tooling + themed shell (Next 16.2, React 19, Tailwind v4, shadcn, ESLint boundaries, Vitest, pipeline).                                   |
| um02 | `um02-db-foundation-identity-schema.md`     | Drizzle + 4 identity tables.                                                                                                              |
| um03 | `um03-local-signin-admin-seed-audit.md`     | Credential provider, `/login`, `audit_log`, break-glass admin, `LOCAL_LOGIN` audit.                                                       |
| um04 | `um04-lockout.md`                           | Per-account lockout state machine (5 fails → 15 min lock + `USER_LOCKED`).                                                                |
| um05 | `um05-rbac-schema-seed.md`                  | 4 RBAC tables, registry/role seed, ADMIN grant.                                                                                           |
| um06 | `um06-spec.md`                              | Permission resolver, page guards, `/no-access`, root redirect.                                                                            |
| um07 | `um07-spec.md`                              | `/administration/users` read (table/detail, badges, `AdminNav`).                                                                          |
| um08 | `um08-spec.md`                              | Create user (Auth Method dropdown, field reorder).                                                                                        |
| um09 | `um09-spec.md`                              | `/set-password` + PENDING→ACTIVE activation.                                                                                              |
| um10 | `um10-spec.md`                              | Entra SSO + email-match linking + minimal system-config page.                                                                             |
| um11 | `um11-spec.md`                              | Inline edit user name/phone.                                                                                                              |
| um12 | `um12-spec.md`                              | Assign/revoke roles + last-ADMIN guard.                                                                                                   |
| um13 | `um13-spec.md`                              | Disable/enable + instant session revocation + last-admin guard.                                                                           |
| um14 | `um14-spec.md`                              | Admin LOCAL password reset + one-time temp-password reveal.                                                                               |
| um15 | `um15-spec.md`                              | Admin unlock locked account (`USER_UNLOCKED`) + `Unlock` control on `UserDetail`.                                                         |
| um16 | `um16-spec.md`                              | Switch `auth_method` SSO↔LOCAL + instant session revocation; reveals/clears temp password accordingly.                                    |
| um17 | `um17-spec.md`                              | Tombstone-delete DISABLED users (`users:DELETE`); strips roles/account/sessions, preserves the row, frees email/Entra identity for reuse. |
| um18 | `um18-spec.md`                              | Read-only `/administration/roles` (`RoleTable`/`RoleDetail`), permission matrix chip display.                                             |
| um19 | `um19-spec.md`                              | Create-role dialog + inline edit-role flow (shared `RoleForm`).                                                                           |
| um20 | `um20-spec.md`                              | Interactive `PermissionMatrixEditor` (per-permission level buttons, optimistic save); `audit_log` READ-max enforced at 3 layers.          |
| um21 | `um21-spec.md`                              | `roles:DELETE`-gated role deletion, `DeleteRoleDialog`, seeded-role + in-use guards.                                                      |
| um22 | `um22-spec.md`                              | `system_config` table + read-only "Configuration Parameters" section on the system-config page.                                           |
| um23 | `um23-spec.md`                              | `system_config:EDIT` value editing via `ConfigEditDialog`.                                                                                |
| um24 | `um24-spec.md`                              | Read-only `/administration/audit-log`: filter bar + server-side pagination + expandable before/after detail.                              |
| um25 | `um25-password-complexity.md`               | Env-configurable LOCAL password policy, applied uniformly across first-login, admin reset, temp-password gen.                             |
| um26 | `um26-spec.md`                              | Sidebar footer (identity strip + sign-out) + 128-char password max-length cap.                                                            |
| um27 | `um27-audit-log-ulid-partitioning.md`       | `audit_log` → ULID + `PARTITION BY RANGE`, pg_partman/pg_cron monthly partitions + 7-year retention.                                      |
| um28 | `um28-side-panel-system-config.md`          | Collapsible sidebar, admin-configurable logo, locale/currency-driven formatting, 5 new `system_config` rows.                              |
| um29 | (business timezone)                         | Configurable `APP_TIMEZONE` display + DST-correct local-day audit boundary resolution.                                                    |
| um30 | `um30-deployment-secrets-security-gates.md` | Dockerfile, 5-stage pipeline + ZAP scan stage, Bicep IaC, least-privilege DB role bootstrap.                                              |
