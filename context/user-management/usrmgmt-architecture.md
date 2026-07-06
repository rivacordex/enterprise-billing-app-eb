# User Management — Architecture (Module)

Module-specific technical architecture for the **User Management Module** — first module of the enterprise billing app rebuild, used internally by RevOps. It delivers the shared core (identity, sessions, RBAC, config, audit) every later module reuses.

**Status:** ACTIVE Authoritative — changes to *Module Invariants* require a documented design review.

**Companion docs:** `architecture.md` owns the platform-wide design this module builds on — stack, folder ownership, multi-module database design, the auth/authorization platform, and platform invariants; this doc does not restate it. `usrmgmt-project-overview.md` owns the product spec (user flows, 10-table data model, roles, permission seed, audit events). `usrmgmt-code-standards.md` turns both into enforceable conventions.

**Scope:** Admin pre-created accounts only — no self-registration. Better-Auth with two auth methods (LOCAL credentials, Entra SSO). This module ships the `core` schema and its 10 tables.

---

## 1. Storage Model

All in Postgres; no file storage or cache tier in v1 (platform rule — `architecture.md` §3). Column schema is in the overview's *Data Model*; this is "what lives where." Better-Auth's managed fields map to snake_case columns via field mapping, declared once in `auth/` (platform Inv. #14).

| Data | Where | Notes |
|---|---|---|
| Identity (`APPUSER`), credentials & SSO link (`account`) | **Postgres** | LOCAL → scrypt hash in `account.password`; SSO → Entra object id in `account.provider_account_id`. Passwords live nowhere else. |
| Sessions (`session`) | **Postgres** | HTTP-only cookie holds only the token; the row is authoritative. **Deleting rows = instant revocation.** No authz state in the session. |
| RBAC (`ROLES`, `ROLE_ASSIGN`, `PERMISSIONS`, `ROLE_PERMISSION_ASSIGN`) | **Postgres** | Roles, assignments, the code-seeded registry, role→permission→level mappings. |
| Config (`SYSTEM_CONFIG`), audit (`AUDIT_LOG`) | **Postgres** | Config = non-secret params (`is_secret` reserved, always FALSE). Audit = append-only; app DB role has no UPDATE/DELETE. |

---

## 2. Authentication & Access Model

The user-facing flow is in the overview's *Core User Flow*; the platform enforcement contract (session model, RBAC resolution, 3-layer defense in depth) is in `architecture.md` §5. This section is the module's specifics.

**Authentication.** Better-Auth, two mutually exclusive methods per user (`auth_method`): **SSO** (Entra, matched by email to a pre-created SSO `APPUSER`) and **LOCAL** (credentials, scrypt, temp password + forced change). Credentials never authenticate an SSO user; the Entra callback never links/creates a LOCAL user. Entra owns MFA/password policy for SSO. A seeded LOCAL admin is bootstrap + break-glass. Every successful sign-in is audited (`SSO_LOGIN`/`LOCAL_LOGIN`).

**Account lockout (LOCAL).** Ours, not a library feature. The `auth/` sign-in hook checks `locked_until` before verifying and increments `failed_login_count` on failure; the 5th consecutive failure sets `locked_until` 15 min ahead and writes `USER_LOCKED`. A success resets the counter; an admin clears the lock (`USER_UNLOCKED`).

**Account lifecycle.** `PENDING → ACTIVE → DISABLED → DELETED`. Only ACTIVE may act. Disabling deletes sessions at once. Tombstone sets `status=DELETED`, removes role assignments, preserves the row; partial unique indexes exclude DELETED so email/Entra identity can be reused. No physical delete.

**Authorization (RBAC).** Engine per `architecture.md` §5 (code-seeded registry; DELETE ⊃ EDIT ⊃ READ; union across roles, highest wins). The role list and seed are canonical in the overview. Distinguish: **assigning a role** is `users:EDIT` (Users page); **defining a role's mappings** is `roles:EDIT` (Roles page).

**ADMIN-only Administration.** In v1 the section is ADMIN-only, so role assignment is ADMIN-only. MANAGER/USER carry no v1 grants and land on `/no-access`. This removes role-assignment escalation at the root (only ADMIN, holding every permission, assigns roles). The RBAC engine stays general for later modules.

**Auth-method change.** Switching `auth_method` revokes that user's sessions; they re-authenticate via the new method.

---

## 3. Per-Page Permission Matrix

Every page declares its access (platform rule — `architecture.md` §5). Viewing needs **READ**; mutations need **EDIT**/**DELETE**. In v1 only **ADMIN** holds the permissions below; MANAGER/USER resolve to `/no-access`.

| Page (route) | Access | Required permission : level |
|---|---|---|
| `/login` | Public | — (redirects if already authenticated) |
| Entra sign-in / callback (`/api/auth/*`) | Public (provider-gated) | Valid Entra identity matching a pre-created SSO user |
| `/set-password` (forced first-login change) | Session-gated | Valid session with `force_password_change = TRUE` (own credential only) |
| `/` (root) | Authenticated | Redirects to the first page the user can READ; if none, `/no-access` |
| `/no-access` | Authenticated | Any ACTIVE session — "no module access yet, contact an administrator" (no nav). v1 landing for MANAGER/USER. |
| `/administration/users` (list/detail) | Authenticated | `users` : **READ** (ADMIN only in v1) |
| — create / edit user, assign or revoke roles, reset password, unlock, change auth method | Authenticated | `users` : **EDIT** (role assignment is ADMIN-only, §2) |
| — tombstone (delete) user | Authenticated | `users` : **DELETE** (target must be DISABLED first) |
| `/administration/roles` (list/detail) | Authenticated | `roles` : **READ** (ADMIN only in v1) |
| — create / edit role, change permission mappings | Authenticated | `roles` : **EDIT** |
| — delete role | Authenticated | `roles` : **DELETE** |
| `/administration/system-config` | Authenticated | `system_config` : **READ** (ADMIN only in v1) |
| — change configuration values | Authenticated | `system_config` : **EDIT** |
| `/administration/audit-log` | Authenticated | `audit_log` : **READ** (READ-max — no EDIT/DELETE) |

> A MANAGER/USER account has no v1 grants and lands on `/no-access` until a later module grants a permission. New pages **must** be added here with an explicit permission + level and a migration adding the `PERMISSIONS` row before they ship.

---

## 4. Background Tasks

Per-request checks (lockout expiry via `locked_until`, session validity via `expires_at`, live permission resolution) are not jobs. This module's standalone jobs (scheduled **Azure Container Apps Jobs** — platform pattern, `architecture.md` §6):

| Task | Trigger | Notes |
|---|---|---|
| Purge expired sessions | Daily | Removes `session` rows past `expires_at`. Active revocation is immediate/inline, not this job. |
| Audit-log archival (optional) | Future | May export old `AUDIT_LOG` rows to Azure Blob; the table stays append-only. Not required for v1. |

**No email/SMTP**: temp passwords are shown once in-UI and shared out-of-band.

---

## 5. Module Invariants

Module-specific rules, in addition to the platform invariants in `architecture.md` §7. Each is testable; CI fails builds that break them. _(Original numbering from `usrmgmt-architecture.md` §8 in parentheses.)_

1. **Administration is ADMIN-only in v1, and role assignment requires ADMIN.** MANAGER and USER carry no grants until later modules add permission rows. No subset/escalation computation is needed, because the only actor who can assign a role (ADMIN) already holds every permission. _(orig. #6)_
2. **The two auth methods are mutually exclusive per user**, and an Entra login with no matching pre-created SSO email is rejected and creates nothing. _(orig. #9)_
3. **No self-service account creation** — admin pre-creation only; no self-registration, JIT, or Entra-group-based access. _(orig. #10)_
4. **Users are never physically deleted** — tombstone only (`status=DELETED`, assignments removed in-transaction, `APPUSER` row preserved). _(orig. #12)_
5. **The last ADMIN-capable account can never be disabled or deleted**, and a user must be DISABLED before being tombstoned. _(orig. #13)_
6. **Roles in use or seeded are never deleted.** A role with any `ROLE_ASSIGN` row cannot be deleted (revoke first); the three seeded roles (ADMIN, MANAGER, USER) are permanent. Role deletion writes `ROLE_DELETED`. _(orig. #22)_
