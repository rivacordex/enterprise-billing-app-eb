# Enterprise Billing Application — User Management Module: Project Overview

**Drafted:** 2026-06-16
**Scope:** User Management Module — first module of wholesale enterprise billing app rebuild.
**Companion docs:** `usrmgmt-architecture.md` (technical design, invariants), `usrmgmt-code-standards.md` (conventions, CI gates), `usrmgmt-ai-workflow-rules.md` (agent workflow)

> Owns **product spec**: purpose, user flows, pages, data model, roles, permission seed, audit events, scope.

---

## Overview

Internal tool for **wholesale telecom billing** — billing other Mobile Network Operators (MNOs) for wholesale services — used by the Revenue Operations (RevOps) team and rebuilt one module at a time. The **User Management Module** ships first: it is the access gate every later module (Product, Customer, Billing Service, Bill Run, Accounting) sits behind, and it establishes the auth, session, RBAC, config, and audit patterns they reuse on one shared PostgreSQL database. It governs **who can sign in** (admin-pre-created accounts only — no self-registration, no JIT; each user is Entra ID SSO or local-password), **what each user can do** (database-driven RBAC mapping admin-managed roles to a code-seeded permission registry at READ/EDIT/DELETE per page, enforced server-side every request), and **how the app is configured** (a System Configuration page for non-secret parameters).

## Goals

1. **Gate the app to known users.** Only admin-pre-created accounts sign in; any other Entra login is rejected and creates no account.
2. **Replace legacy hardcoded roles** with DB-driven roles and role→permission mappings an admin edits in the UI, no code changes.
3. **Enforce every permission server-side.** The API checks effective permissions on every protected request; frontend checks only show/hide controls.
4. **Make revocation instant** via Better-Auth DB-backed sessions — disabling rejects the next request, no token-expiry wait.
5. **Keep SSO config simple in v1.** Entra credentials in `.env`; rotation = redeploy. `SYSTEM_CONFIG` carries version/status columns to add in-UI lifecycle later without a migration.
6. **Audit every mutation and sign-in** to an append-only, immutable log (actor, timestamp, event type, target, before/after).
7. **Establish the reusable shared core** — identity, RBAC, config, audit — that later modules inherit on the same database.

## Technology Decisions (Why)

1. **Single TypeScript stack, one runtime.** Rebuilt from scratch → one runtime; Better-Auth runs in-process, no token handoff.
2. **Better-Auth over Auth.js.** Database-first; ships managed `user`/`session`/`account`/`verification` models, a credentials provider, and Microsoft/Entra OIDC. RBAC is our own tables on top.
3. **DB-backed sessions, not stateless JWTs.** Disabling deletes session rows and the next request fails immediately.
4. **Simplified SSO (env config).** Entra secrets rotate once or twice a year, so an in-UI lifecycle is overkill for v1. Secrets in `.env`; `SYSTEM_CONFIG` pre-modelled to add the lifecycle later without a schema change.
5. **Adopt Better-Auth's storage model, remapped to snake_case.** Password hash and SSO link live in `account` (one row per auth method), not on the user row. `APPUSER` is the renamed `user` model with our custom fields. Better-Auth's managed fields map to snake_case columns via field mapping, declared once in `auth/`, so the whole database uses one casing convention.
6. **Better-Auth's built-in scrypt hashing.** scrypt is OWASP-acceptable.
7. **Custom per-account lockout, not library rate-limiting.** Better-Auth has no per-account lockout; the 5-failures → 15-min lock is our logic on `failed_login_count`/`locked_until`, in the sign-in hook.
8. **ADMIN-only Administration in v1.** Only ADMIN reaches the four admin pages, removing role-assignment escalation problem at the root (only ADMIN, who holds every permission, assigns roles). MANAGER and USER are seeded and permanent but carry no v1 grants; later modules grant them access.

## Core User Flow

1. **Fresh deployment.** Migrations seed (a) the registry rows (`users`, `roles`, `system_config`, `audit_log`), (b) three roles (ADMIN, MANAGER, USER) with default mappings, (c) one **local admin** — bootstrap + permanent break-glass. Entra credentials from `.env`; if absent, only local login works.
2. **Admin pre-creates users** (Users page) — name, email, phone, `auth_method` (SSO/LOCAL), initial roles. Every account starts **PENDING**. LOCAL users get a one-time temp password (shown once) with `force_password_change`, shared out-of-band.
3. **Admin defines roles** (Roles page) — maps each role to registry entries at READ/EDIT/DELETE (DELETE ⊃ EDIT ⊃ READ). Admins can't create permission rows (code-seeded).
4. **User activates on first login.**
   - **SSO** — Entra authenticates; match **by email** to an `auth_method = SSO` APPUSER, store the Entra object id, write `SSO_LOGIN`, record `last_login_datetime`, flip PENDING → ACTIVE. An Entra login with no matching SSO email is rejected, creating nothing.
   - **LOCAL** — sign in with the temp password, set a new one; success writes `LOCAL_LOGIN` and flips PENDING → ACTIVE.
   - The two paths are mutually exclusive.
5. **Every request is enforced server-side** — resolve session, load user (must be ACTIVE) and effective permissions from PostgreSQL, return 403 on insufficient permission. The UI uses the effective-permission map for show/hide only.
6. **Permissions change in real time** — a mapping/assignment change takes effect on the next request; nothing is baked into the session.
7. **Account lockout (LOCAL).** Five consecutive failures set `locked_until` 15 min ahead and write `USER_LOCKED`; the sign-in hook rejects attempts until expiry or admin unlock (`USER_UNLOCKED`).
8. **Offboarding.** DISABLED revokes sessions and rejects the next request. An admin with `users:DELETE` can then **tombstone** (`status = DELETED`, role assignments removed, `USER_DELETED` audited). The APPUSER row is never physically removed; email and Entra identity become reusable (partial unique indexes exclude DELETED).
9. **Secret rotation** — update `.env`, redeploy.
10. **Review** — an admin filters the Audit Log by event type, actor, or date range.

## Pages — "Administration" Section (4)

All four require the **ADMIN** role in v1.

1. **Users** — list (name, email, auth-method badge, status, roles, last login; DELETED behind a "Show deleted" toggle). Detail: edit name/phone; assign/revoke roles (`assigned_by` recorded); switch `auth_method` (SSO→LOCAL sets a temp password, LOCAL→SSO clears the credential — **switching revokes sessions**); reset LOCAL password; unlock. Create → PENDING (LOCAL returns a one-time temp password). Disable/re-enable (instant). Tombstone-delete (needs `users:DELETE`; target DISABLED first). All actions audited.
2. **Roles** — list roles + mappings; create/edit/describe/delete roles; map role→permission at READ/EDIT/DELETE. Permissions are code-seeded; the UI can't create permission rows. Effective permission = union across roles, **highest level wins**.
3. **System Configuration** — non-secret parameters (`SYSTEM_CONFIG`). The Entra secret is in `.env`, not here; non-secret Entra values (tenant id, derived redirect URI) shown read-only. `config_version`/`status` reserve a future in-UI lifecycle.
4. **Audit Log** — read-only viewer over the append-only `AUDIT_LOG`, filterable by event type, actor, date range. Gated by `audit_log:READ`.

## Data Model (10 tables)

The **shared core** every later module reuses (see architecture, _Multi-Module Database Design_); modules add domain tables but never duplicate identity, RBAC, config, or audit. Better-Auth's managed fields map to the snake_case columns below via field mapping (declared once in `auth/`); the whole database is snake_case.

### Identity (Better-Auth-managed, remapped to snake_case)

- **`APPUSER`** (renamed `user`) — `user_id` (PK, maps `id`), `user_name` (`name`), `user_email` (`email`; unique via partial index **excluding DELETED**), `email_verified` (`emailVerified`; boolean, default `true`; part of Better-Auth schema completeness — no email verification flow in v1, set true as email expected to work), `user_phonenum`, `auth_method` (`SSO`|`LOCAL`, CHECK), `status` (`PENDING`|`ACTIVE`|`DISABLED`|`DELETED`, CHECK), `force_password_change`, `failed_login_count`, `locked_until`, `last_login_datetime`, `created_datetime` (`createdAt`), `last_modified_datetime` (`updatedAt`). Password hash and SSO id live in `account`, not here.
- **`account`** — one row per auth method: `account_id` (PK, `id`), `user_id`→APPUSER (`userId`), `provider_id` (`credential`|`microsoft`), `provider_account_id` (local: user id; Entra: object id), `password` (scrypt hash, only when `provider_id = credential`), Better-Auth OAuth token columns (null under simplified SSO), timestamps.
- **`session`** — `session_id` (PK, `id`), `user_id`→APPUSER (`userId`), `session_token` (`token`), `expires_at` (`expiresAt`), `ip_address`, `user_agent`, timestamps. **Deleting rows = instant revocation.**
- **`verification`** — required by Better-Auth core; remapped to snake_case. No rows written in v1.

### RBAC (ours; snake_case)

- **`ROLES`** — `role_id` (PK), `role_name` (unique), `role_descr`, timestamps. _Seeded: ADMIN, MANAGER, USER._
- **`ROLE_ASSIGN`** — `role_assign_id` (PK), `ref_user_id`→APPUSER, `ref_role_id`→ROLES, `assigned_by`→APPUSER, `created_datetime`; unique(`ref_user_id`, `ref_role_id`).
- **`PERMISSIONS`** — `permission_id` (PK), `permission_name` (unique; `users`, `roles`, `system_config`, `audit_log`), `permission_info`. **Migration-inserted only**, one row per page/module.
- **`ROLE_PERMISSION_ASSIGN`** — `role_permission_id` (PK), `ref_role_id`→ROLES, `ref_permission_id`→PERMISSIONS, `permission_type` (`READ`|`EDIT`|`DELETE`, CHECK), timestamps; unique(`ref_role_id`, `ref_permission_id`).

### Config + audit (ours; snake_case)

- **`SYSTEM_CONFIG`** — `config_id` (PK), `config_group`, `config_version`, `config_key`, `config_value`, `is_secret`, `status` (`DRAFT`|`ACTIVE`|`RETIRED`), `modified_by`, timestamps; unique(`config_group`, `config_version`, `config_key`). _`is_secret` reserved, always FALSE in v1 — no secret in the DB._
- **`AUDIT_LOG`** — `audit_id` (PK), `event_type`, `actor_user_id`→APPUSER, `target_entity`, `target_id`, `before_data` (JSON), `after_data` (JSON), `created_datetime`. **Append-only**: app DB role has no UPDATE/DELETE.

## Roles & Default Permission Seed

Administration is **ADMIN-only** in v1. ADMIN holds all grants; MANAGER and USER are seeded and permanent but carry no v1 grants — they exist for later modules, which map their own permission rows to these roles without code changes.

| Permission (page) | ADMIN  | MANAGER | USER |
| ----------------- | ------ | ------- | ---- |
| `users`           | DELETE | —       | —    |
| `roles`           | DELETE | —       | —    |
| `system_config`   | DELETE | —       | —    |
| `audit_log`       | READ   | —       | —    |

- **ADMIN** — full user lifecycle (incl. tombstone), role/permission definition, system config, audit read. The only role with v1 access.
- **MANAGER / USER** — reserved; no v1 grants; land on `/no-access` until a later module grants a permission.
- **`audit_log` is READ-max** — no EDIT/DELETE level; the log is immutable for everyone, ADMIN included.

**Guardrails (enforced regardless of mapping):**

- The last ADMIN-capable account cannot be disabled or deleted.
- A user must be DISABLED before tombstoning; tombstone never runs a physical DELETE.
- Changing a user's `auth_method` revokes that user's active sessions.
- Role deletion is blocked while any user is assigned (revoke first); the three seeded roles can never be deleted.
- No privilege-escalation rule is needed: only ADMIN assigns roles, and ADMIN already holds every permission.

## Audit Events

`USER_CREATED`, `USER_UPDATED`, `USER_DISABLED`, `USER_ENABLED`, `USER_DELETED`, `USER_FIRST_LOGIN`, `ROLE_CREATED`, `ROLE_UPDATED`, `ROLE_DELETED`, `ROLE_ASSIGNED`, `ROLE_REVOKED`, `PERMISSION_MAPPING_CHANGED`, `SYSTEM_CONFIG_CHANGED`, `SSO_LOGIN`, `LOCAL_LOGIN`, `USER_PASSWORD_RESET`, `USER_PASSWORD_CHANGED`, `USER_LOCKED`, `USER_UNLOCKED`, `USER_AUTH_METHOD_CHANGED`. Each records actor, timestamp, event type, target entity, before/after.

**Both sign-in methods are audited** for one unified trail: `SSO_LOGIN` per Entra sign-in, `LOCAL_LOGIN` per local sign-in, `USER_FIRST_LOGIN` on activation. (Entra keeps its own logs too; the in-app `SSO_LOGIN` keeps "who signed in, when" answerable from one log.)

## Features

By area; each is gated by the permission in _Roles & Default Permission Seed_ and is ADMIN-only in v1.

### Authentication & sessions

- Two mutually exclusive methods per user: **SSO** (Entra via Better-Auth's Microsoft/OIDC provider) and **LOCAL** (email + password).
- **Entra SSO** with email-match linking on first login (captures Entra object id; PENDING → ACTIVE; writes `SSO_LOGIN`). No matching SSO account → rejected, nothing created.
- **Local sign-in** with scrypt hashing, one-time temp passwords, forced first-login change.
- **Custom per-account lockout** (LOCAL) — five failures → 15-min `locked_until`; sign-in hook rejects until expiry or admin unlock.
- **DB-backed sessions** with immediate revocation on disable, tombstone, or `auth_method` switch.
- **Seeded local admin** — bootstrap + break-glass when Entra is unconfigured/unavailable.

### User administration

- List users; create (PENDING; LOCAL returns a one-time temp password); edit name/phone; assign/revoke roles (`assigned_by` recorded); switch `auth_method`; reset LOCAL password; unlock; disable/re-enable (next-request effect); tombstone-delete (`status = DELETED`, assignments removed; target DISABLED + actor holds `users:DELETE`; row preserved, email/Entra identity reusable).

### Roles & permissions

- Create/edit/describe/delete roles (deletion blocked while assigned; seeded roles permanent).
- Map each role to registry entries at **READ/EDIT/DELETE** (DELETE ⊃ EDIT ⊃ READ).
- Code-seeded registry (one row per page/module); UI can't create permission rows.
- Effective permission = union across roles, highest level wins, computed server-side per request.
- Three seeded roles; only ADMIN has v1 grants.

### System configuration

- Manage non-secret parameters via `SYSTEM_CONFIG`.
- Show non-secret Entra values (tenant id, derived redirect URI) read-only from env.
- Schema reserved (`config_version`/`status`) for a future in-UI lifecycle.

### Authorization enforcement

- Server-side check on every protected request (403 on insufficient level), loading status + effective permissions per request.
- Real-time: mapping/assignment changes apply on the next request.
- Effective-permission map for UI show/hide only — never the enforcement point.

### Audit

- Append-only, immutable log of every mutation and successful sign-in (actor, timestamp, target, before/after).
- Audit Log viewer filterable by event type, actor, date range; gated by `audit_log:READ`.

## In Scope (v1)

- The 4 Administration pages — Users, Roles, System Configuration, Audit Log — **ADMIN-only**.
- The 10 shared-core tables on one PostgreSQL database, Better-Auth fields remapped to snake_case.
- Two auth methods (Entra SSO, LOCAL), custom per-account lockout, DB-backed sessions with instant revocation, forced first-login password change, seeded break-glass local admin.
- DB-driven RBAC with code-seeded registry, READ/EDIT/DELETE hierarchy, server-side enforcement every request.
- Append-only audit of every mutation and both sign-in methods (`SSO_LOGIN`, `LOCAL_LOGIN`).
- Migrations: schema, registry seed, three-role seed with the ADMIN-only matrix, seeded local admin.

Anything not listed here or in _Features_ is deferred.

## Out of Scope (v1)

- **All later billing modules** — Product, Customer, Billing Service, Bill Run, Accounting. User Management ships first as their shared scaffold.
- **External / partner API surface, incl. TMForum Open API.** When added: a **separate deployment unit** over the same service layer and database (own M2M auth via OAuth2 client credentials + API gateway) — not a second backend, not a second copy of identity or business logic.
- In-UI Entra secret lifecycle (env + redeploy instead).
- MFA for LOCAL users (Entra enforces MFA for SSO).
- SMTP / email (no email invitations or resets; temp passwords shared out-of-band).
- JIT provisioning, self-registration, Entra-group-based access.
- Admin-creatable permissions (registry is migration-seeded only).
- SCIM / directory sync.
- Self-service profile editing (admins edit in v1).
- Delegated (non-ADMIN) administration — ADMIN-only in v1.
- Org hierarchy / manager relationships.
- Active-session viewer / impersonation UI.
- **Multi-tenancy / customer-facing login** — internal RevOps tool only. The MNOs billed are stored as **customer** business data by later modules; they are domain entities, not application users and not a tenancy boundary, so the app stays single-tenant.
- The billing engine (rating, invoicing, ledger, settlement) — later modules.

## Success Criteria

1. **Cold start** — migrations seed the registry, three roles + ADMIN-only matrix, and a local admin who signs in with a password and reaches all four pages with no Entra config.
2. **Only pre-created users get in** — a PENDING SSO user is activated and linked on first Entra login (`SSO_LOGIN` written); an Entra user with no matching SSO email is rejected, no row created; a LOCAL user enters only after changing the temp password.
3. **Server-side enforcement** — every protected route returns 403 to a user lacking the level, even when bypassing the UI. Tests cover each route × level.
4. **Exact resolution** — roles granting READ and EDIT on the same permission yield EDIT; DELETE implies EDIT and READ.
5. **Instant revocation** — a role change affects the next request without re-login; disabling revokes sessions so the next request fails.
6. **Exclusive auth paths** — credentials reject SSO users; the Entra callback never links a LOCAL user; every local sign-in writes `LOCAL_LOGIN`, every SSO sign-in writes `SSO_LOGIN`.
7. **Hardened local credentials** — scrypt only; a temp password is unusable past the forced change; 5 failures → 15-min lock (`USER_LOCKED`); admin reset and unlock audited.
8. **Tombstone end-to-end** — a DISABLED user is tombstoned by an admin with `users:DELETE`; role assignments removed in the same transaction; `USER_DELETED` captures pre-deletion name, email, roles; later sign-ins (SSO/LOCAL) rejected; email and Entra identity reusable on a new account.
9. **ADMIN-only administration** — a MANAGER/USER account has no v1 grants and lands on `/no-access`; only ADMIN reaches the four pages; verified by the route × level matrix.
10. **Unified audit trail** — every mutation and successful sign-in writes an `AUDIT_LOG` entry (actor, timestamp, target, before/after); the app DB role cannot UPDATE or DELETE audit rows.
