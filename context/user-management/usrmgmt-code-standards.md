# User Management — Module Code Standards

> **ACTIVE** — module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** User Management specifics; everything else (TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is not restated here. If a rule seems missing, it lives in the general file.

**Companion docs:** `usrmgmt-project-overview.md` (product spec) and `usrmgmt-architecture.md` (technical design, numbered **Invariants**). Where this doc conflicts with the architecture *Invariants*, the **Invariants win** and the conflict is a bug to fix here.

---

## 1. Domain Conventions

1. **Domain unions** (general §2.6), defined as `as const` string-literal unions:
   - `UserStatus`: `'PENDING' | 'ACTIVE' | 'DISABLED' | 'DELETED'`
   - `AuthMethod`: `'SSO' | 'LOCAL'`
   - `PermissionLevel`: `'READ' | 'EDIT' | 'DELETE'`
2. **Better-Auth field mapping.** Better-Auth's managed tables (`APPUSER`/`user`, `account`, `session`, `verification`) have fields remapped to snake_case via Better-Auth's field mapping, declared once in `auth/` (inv. #19). Always derive row types from the Drizzle table — never Better-Auth's default field names (general §2.7). The mapping is never bypassed by hand-written SQL (general §6.4).
3. **`app/api/auth/[...all]/route.ts` is owned by Better-Auth.** No custom logic in that path; extend via Better-Auth config and hooks in `auth/` — where the custom lockout sign-in hook lives (general §5.2).
4. **Passwords exist only as Better-Auth scrypt hashes in `account.password`** (LOCAL only) (inv. #1; general §6.10).
5. **The Entra client secret lives in `.env`** — never in code, repo, image, or DB (inv. #18; general §1.6, §6.15).
6. **Account lockout:** 5 failed attempts → 15-min lock via `failed_login_count` / `locked_until` (architecture §5). The `auth/` sign-in hook reads/writes lockout state through a repository (general §6.1). Lockout reads `locked_until`; session validity reads `expires_at` (inv. #8). This is the only throttling in v1 (general §5.10).
7. **Auth events written to `AUDIT_LOG`** in addition to atomically-audited mutations (general §1.7): `SSO_LOGIN`, `LOCAL_LOGIN`, `USER_FIRST_LOGIN`, `USER_LOCKED`, `USER_UNLOCKED`.
8. **Users are tombstoned, never hard-deleted** (inv. #12; general §6.7): set `status = DELETED`, remove role assignments in the same transaction, preserve the `APPUSER` row. Partial unique indexes exclude `DELETED` so email/Entra identity can be reused (architecture §5; overview flow #8).
9. **Instant revocation:** disabling a user or changing `auth_method` deletes their `session` rows (inv. #8; architecture §5).
10. **`force_password_change` is enforced in middleware/guard** (general §3.9): a session with `force_password_change = TRUE` is redirected to `/set-password` for every route except `/set-password` and sign-out.
11. **Shared indicator components** (general §4.8): `StatusBadge` for `PENDING | ACTIVE | DISABLED | DELETED`; `AuthMethodBadge` for `SSO | LOCAL`.
12. **Services** are grouped as `services/users/…`, `services/roles/…`, `services/audit/…` (general §7.5).
13. **The 10 shared-core tables live in `core`** — identity, RBAC, session, config, audit (architecture §4; general §6.3). Later modules reference them by FK and never re-create them.
14. **Timezone specifics:** local-day↔UTC boundary math for the audit "from/to" day filter uses `lib/timezone.ts` (general §2.13; um29). DST transition-day limitation documented in um29 §2.2.
15. **v1 role reality:** only ADMIN holds the module grants; MANAGER and USER have no v1 grants and land on `/no-access` (architecture §6). `/` redirects to the first page the user can READ, else `/no-access` (general §3.13).
16. **`(app)` module folder:** pages live under `app/(app)/administration/` — renamed from `(admin)`, Product Module plan Decision #10.

---

## 2. Permission Names & Per-Page Permission Map

**v1 permission names** (general §8.1): `users`, `roles`, `system_config`, `audit_log`. `audit_log` is READ-max — no EDIT/DELETE level exists for it (architecture §6; general §1.8, §8.2). Reference via typed constants in `auth/` (general §8.5).

Authoritative for v1; mirrors architecture §6. New pages are appended before they ship. **In v1 only ADMIN holds the `users`/`roles`/`system_config`/`audit_log` grants, so the four Administration pages are ADMIN-only; MANAGER and USER land on `/no-access`.**

| Page | Route | Top-level component | Folder | Permission : level |
|---|---|---|---|---|
| Login | `/login` | `LoginPage` → `LoginForm` | `app/(auth)/login/` | **Public** (redirects if authenticated) |
| Entra sign-in / callback | `/api/auth/*` | Better-Auth handler | `app/api/auth/[...all]/` | **Public, provider-gated** — valid Entra identity matching a pre-created SSO user |
| Set password (forced first-login change) | `/set-password` | `SetPasswordPage` → `SetPasswordForm` | `app/(auth)/set-password/` | **Session-gated** — `force_password_change = TRUE`, own credential only |
| Root | `/` | `RootRedirect` | `app/` | **Authenticated** — first page the user can READ, else `/no-access` |
| No access | `/no-access` | `NoAccessPage` | `app/(app)/no-access/` | **Authenticated** — any `ACTIVE` session; no nav. v1 landing for MANAGER/USER. |
| Users — list/detail | `/administration/users` | `UsersPage` → `UserTable`, `UserDetail` | `app/(app)/administration/users/` | `users` : **READ** (ADMIN only in v1) |
| Users — create/edit, assign/revoke roles, reset password, unlock, change auth method | (actions under `/administration/users`) | `UserForm`, `RoleAssignmentPanel` | `actions/users/` | `users` : **EDIT** (role assignment is ADMIN-only, architecture §5) |
| Users — tombstone (delete) | (action under `/administration/users`) | `DeleteUserDialog` | `actions/users/` | `users` : **DELETE** (target DISABLED first) |
| Roles — list/detail | `/administration/roles` | `RolesPage` → `RoleTable`, `RoleDetail` | `app/(app)/administration/roles/` | `roles` : **READ** (ADMIN only in v1) |
| Roles — create/edit, change permission mappings | (actions under `/administration/roles`) | `RoleForm`, `PermissionMatrixEditor` | `actions/roles/` | `roles` : **EDIT** |
| Roles — delete | (action under `/administration/roles`) | `DeleteRoleDialog` | `actions/roles/` | `roles` : **DELETE** |
| System Configuration — view | `/administration/system-config` | `SystemConfigPage` → `ConfigTable` | `app/(app)/administration/system-config/` | `system_config` : **READ** (ADMIN only in v1) |
| System Configuration — change values | (action under `/administration/system-config`) | `ConfigEditor` | `actions/system-config/` | `system_config` : **EDIT** |
| Audit Log — view | `/administration/audit-log` | `AuditLogPage` → `AuditLogTable`, `AuditLogFilters` | `app/(app)/administration/audit-log/` | `audit_log` : **READ** (READ-max) |

**Notes**

- Component names are the binding convention; create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- A MANAGER/USER account has no v1 grants and lands on `/no-access` (architecture §6).
- The page guard (general §3.6) checks **READ** to render; each mutating action re-checks **EDIT**/**DELETE** (general §1.2). Both reference the typed constant (general §8.5).

---

## 3. Module Guardrail Tests (CI gate §10.4)

The general test-suite gate includes this module's guardrail tests from *Success Criteria*: ADMIN-only administration, instant revocation, exclusive auth paths (SSO vs LOCAL), tombstone end-to-end, and the unified audit trail — plus the route × level matrix for every §2 row.
