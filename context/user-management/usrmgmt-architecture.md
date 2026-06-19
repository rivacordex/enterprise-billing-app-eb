# User Management — Architecture

Technical architecture for **User Management Module** — first module of **wholesale enterprise billing application** rebuild (billing other MNOs for wholesale services), used internally by RevOps. It establishes auth, session, permission, and database patterns every later module (Product, Customer, Billing Service, Bill Run, Accounting) reuses.

**Status:** Authoritative. Changes to _Invariants_ require a documented design review.

**Companion docs:** `usrmgmt-project-overview.md` owns the product spec (user flows, 10-table data model, roles, permission seed, audit events); this doc owns technical design and references rather than restates it. `usrmgmt-code-standards.md` turns it into enforceable conventions.

**Scope:** Single internal tool — not multi-tenant, not customer-facing; admin pre-created accounts only. **Better-Auth**; single TypeScript runtime. **Enterprise production-grade**: zone-redundant managed Postgres with PITR, gated migrations, a least-privilege DB role, secrets in Key Vault via Managed Identity, SAST + DAST gates in CI.

---

## 1. Technology Stack

| Layer                        | Technology                                                                                                             | Role                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Frontend**                 | Next.js ≥ 15 (App Router, RSC) on Node ≥ 22 (Active LTS), TypeScript `strict`                                          | UI, routing, SSR/streaming, forms. Frontend permission checks show/hide only — never the security boundary.                                                                                                                                                                                                                                      |
| **APIs & Backend Logic**     | Next.js Route Handlers + Server Actions over a framework-agnostic `services/` layer                                    | One deploy unit; no separate API tier, no cross-runtime token handoff. Server Actions handle UI mutations; Route Handlers (`/api/*`) host the Better-Auth handler and M2M endpoints. Business rules live in `services/`, so a future external API (e.g. TMForum) attaches as another adapter — a separate deployment unit, not a second backend. |
| **Database & Storage**       | Managed **Azure Database for PostgreSQL — Flexible Server** (≥ 16) via **Drizzle ORM**                                 | Single system of record. Drizzle owns schema + migrations; type-safe queries through the data-access layer. Zone-redundant HA.                                                                                                                                                                                                                   |
| **Auth & Permissions**       | **Better-Auth** (DB-backed sessions; credentials + Microsoft/Entra provider)                                           | Owns auth mechanics and its `user`/`account`/`session`/`verification` tables, fields remapped to snake_case (§3, Inv. #19). RBAC is our tables on top, enforced per request. No authz state in the session.                                                                                                                                      |
| **Hosting & Deployment**     | **Azure Container Apps** on Azure Cloud (Docker, multi-replica)                                                        | Revision-based deploys, rolling/blue-green, instant rollback. Migrations run as a gated pipeline step before traffic shifts.                                                                                                                                                                                                                     |
| **Cloud & Compute**          | **Azure Cloud**                                                                                                        | Compute (Container Apps), managed Postgres, secrets (Key Vault), identity (Managed Identity), networking (VNet).                                                                                                                                                                                                                                 |
| **CI/CD & Version Control**  | **Azure DevOps** (Repos + Pipelines)                                                                                   | Git, PR/branch policies; build → test → scan (SAST + DAST) → containerize → migrate → deploy; gated dev → staging → prod.                                                                                                                                                                                                                        |
| **Security & RLS**           | App-layer authorization (Postgres **RLS unused**); DAST via **OWASP ZAP** + **Burp Suite Community**                   | Single-tenant → no per-row boundary. Every request resolves live status + effective permissions before business logic. ZAP runs automated as a DAST gate; Burp for manual pen-testing. No high/critical finding ships.                                                                                                                           |
| **Rate Limiting**            | None at app layer (v1)                                                                                                 | Auth endpoints rely on Better-Auth + our **custom per-account lockout** (5 → 15-min on `failed_login_count`/`locked_until`, §5). Add APIM / Front Door WAF if external exposure grows.                                                                                                                                                           |
| **Caching & CDN**            | None                                                                                                                   | No cache tier or CDN; Next.js static serving suffices. Authz decisions are **never** cached.                                                                                                                                                                                                                                                     |
| **Load Balancing & Scaling** | Container Apps autoscaling (KEDA, HTTP-concurrency) + ingress LB                                                       | Autoscale on concurrency; min 2 replicas. Stateless → any replica serves any request.                                                                                                                                                                                                                                                            |
| **Error Tracking & Logs**    | **GlitchTip** (crashes/exceptions) + **Azure Monitor + App Insights** (system/DB)                                      | GlitchTip for frontend/backend crash capture and release health; Azure Monitor/App Insights (OpenTelemetry) for system/DB metrics, logs, traces, alerting on error rate, latency, failed-login spikes.                                                                                                                                           |
| **Availability & Recovery**  | Managed Azure PostgreSQL backups + **PITR**, zone-redundant Flexible Server; multi-replica Container Apps across zones | Recovery via managed PITR. Retention ≥ 14 days, zone-redundant. Stateless app → recovery = redeploy image + restore DB. Documented RPO/RTO.                                                                                                                                                                                                      |

> **Single-runtime rationale** (overview _Technology Decisions_ #1–2): the rebuilt engine has no Python to preserve, so backend logic stays in-process behind the `services/` boundary. Extract a standalone service (or the external API) only when a non-web consumer or independent scaling need emerges — importing the same `services/` and `db/`, not duplicating them.

---

## 2. System Boundaries — Folder Ownership

Each folder owns one responsibility. Dependencies point **inward**: UI → actions/routes → services → data-access → database; inner layers never import outward. `components/`, `validation/`, `types/` are shared **leaf** modules.

| Path             | Owns                                                                                                                                                                         | Must NOT contain                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `app/(auth)/**`  | Unauthenticated / bootstrap pages: local login, Entra sign-in entry, forced first-login password change.                                                                     | Business logic; DB access; self-registration.                                                                            |
| `app/(admin)/**` | The four **Administration** pages + layouts; each declares its permission + level; thin orchestrators composing `components/`.                                               | DB queries; raw SQL; permission logic beyond the guard; heavy markup.                                                    |
| `components/**`  | Reusable presentational UI shared across `(auth)`/`(admin)`.                                                                                                                 | DB access; business logic; permission **decisions** (may read a passed-in map to show/hide); data fetching beyond props. |
| `app/api/**`     | Route Handlers: Better-Auth (`/api/auth/*`), Entra callback, M2M endpoints.                                                                                                  | UI; business rules (delegates to `services`).                                                                            |
| `actions/**`     | Server Actions: mutation entry points. Parse input, resolve principal, check permission + level, call a service.                                                             | DB queries; business rules beyond orchestration; inline parsing.                                                         |
| `validation/**`  | Zod schemas — single source for every external input's shape; parsed **before** a service.                                                                                   | Business logic; DB access; `next/*` or UI imports.                                                                       |
| `services/**`    | Business logic / use cases (user lifecycle, roles & mappings, audit writes, account linking). Framework-agnostic.                                                            | `next/*`; request/response objects; UI.                                                                                  |
| `db/**`          | Drizzle schema, migrations, seeds, repositories. The **only** place SQL/queries live.                                                                                        | Business rules; permission checks.                                                                                       |
| `auth/**`        | Better-Auth config, providers, the field mapping (§3), session/sign-in hooks (incl. lockout), the code-seeded permission registry, the single effective-permission resolver. | Page-specific logic; table mutation outside repositories.                                                                |
| `types/**`       | Shared cross-layer TS types (Drizzle rows + UI/request state). Prevents circular deps.                                                                                       | Runtime code; DB queries; business logic.                                                                                |
| `lib/**`         | Cross-cutting utilities: telemetry (GlitchTip + OpenTelemetry), error types, config, helpers.                                                                                | Domain logic; DB access; validation schemas.                                                                             |
| `tests/**`       | Unit, integration, e2e — incl. the route × level authorization matrix.                                                                                                       | Production code.                                                                                                         |
| `infra/**`       | IaC (Bicep/Terraform), Azure Pipelines YAML (incl. the OWASP ZAP DAST stage), Dockerfile, env templates.                                                                     | Application code.                                                                                                        |

**Boundary rule.** UI never calls `db/**` directly — it calls a Server Action/Route Handler, which resolves the session, loads the live user + effective permissions, checks permission/level, then calls a `service`, which calls the data-access layer. Permission checks happen at the action/route boundary; services assume an authorized context.

---

## 3. Storage Model

All in Postgres; no file storage or cache tier in v1. Column schema is in the overview's _Data Model_; this is "what lives where." Better-Auth's managed fields map to snake_case columns via field mapping, declared once in `auth/` (Inv. #19).

| Data                                                                   | Where                  | Notes                                                                                                                                   |
| ---------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Identity (`APPUSER`), credentials & SSO link (`account`)               | **Postgres**           | LOCAL → scrypt hash in `account.password`; SSO → Entra object id in `account.provider_account_id`. Passwords live nowhere else.         |
| Sessions (`session`)                                                   | **Postgres**           | HTTP-only cookie holds only the token; the row is authoritative. **Deleting rows = instant revocation.** No authz state in the session. |
| RBAC (`ROLES`, `ROLE_ASSIGN`, `PERMISSIONS`, `ROLE_PERMISSION_ASSIGN`) | **Postgres**           | Roles, assignments, the code-seeded registry, role→permission→level mappings.                                                           |
| Config (`SYSTEM_CONFIG`), audit (`AUDIT_LOG`)                          | **Postgres**           | Config = non-secret params (`is_secret` reserved, always FALSE). Audit = append-only; app DB role has no UPDATE/DELETE.                 |
| User-uploaded files                                                    | **None**               | No uploads in v1. Later: binary → Azure Blob, DB stores a reference.                                                                    |
| Cache                                                                  | **None**               | Authz decisions evaluated live per request.                                                                                             |
| Secrets & connection strings                                           | **`.env` / Key Vault** | Connection strings via Key Vault + Managed Identity; Entra secret in `.env` (rotation = redeploy). No secret in DB, repo, or image.     |

---

## 4. Multi-Module Database Design

All modules run on **one Flexible Server instance and one logical database** — no per-module database, no second Better-Auth instance.

**Shared core vs module domain.** The 10 User-Management tables are the **shared core**: identity (`APPUSER`, `account`, `session`, `verification`), RBAC (`ROLES`, `ROLE_ASSIGN`, `PERMISSIONS`, `ROLE_PERMISSION_ASSIGN`), `SYSTEM_CONFIG`, `AUDIT_LOG`. Later modules reuse them and **never create their own user, role, permission, session, config, or audit tables**; they add only domain tables (products, customers/MNOs, bill runs, ledgers, …) referencing the core by FK.

**Namespacing — schema per module.** The core lives in a `core` schema; each module owns its own (`product`, `customer`, `billing`, `accounting`, …). Cross-schema FKs (module rows → `core.APPUSER.user_id`) are used directly — logical isolation and clear ownership on one instance, one pool, one backup/restore lifecycle. Better-Auth's tables stay in `core`, snake_case like ours.

| Concern             | Rule across modules                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity & sessions | One set of Better-Auth tables in `core`; one principal in every module.                                                                                 |
| Permissions         | One global registry; each module ships a migration adding its `core.PERMISSIONS` rows; access granted by admin role→permission mapping, no code change. |
| Audit               | One `core.AUDIT_LOG`, discriminated by `event_type`/`target_entity`. INSERT-only.                                                                       |
| Config              | One `core.SYSTEM_CONFIG`, partitioned by `config_group`.                                                                                                |
| Migrations          | One Drizzle migration history; modules contribute module-scoped files, applied in one gated step.                                                       |
| DB role             | One least-privilege role: DML on domain tables, **INSERT-only on `core.AUDIT_LOG`**, no runtime DDL.                                                    |

**Customers (MNOs) are domain data, not tenants.** Customer records are business entities owned by module tables — not application users, not a tenancy boundary. The only principals are internal RevOps staff, so the app stays single-tenant and RLS stays unused.

---

## 5. Authentication & Access Model

The user-facing flow is in the overview's _Core User Flow_; this is the enforcement contract.

**Authentication.** Better-Auth, two mutually exclusive methods per user (`auth_method`): **SSO** (Entra, matched by email to a pre-created SSO `APPUSER`) and **LOCAL** (credentials, scrypt, temp password + forced change). Credentials never authenticate an SSO user; the Entra callback never links/creates a LOCAL user. Entra owns MFA/password policy for SSO. A seeded LOCAL admin is bootstrap + break-glass. Every successful sign-in is audited (`SSO_LOGIN`/`LOCAL_LOGIN`).

**Account lockout (LOCAL).** Ours, not a library feature. The `auth/` sign-in hook checks `locked_until` before verifying and increments `failed_login_count` on failure; the 5th consecutive failure sets `locked_until` 15 min ahead and writes `USER_LOCKED`. A success resets the counter; an admin clears the lock (`USER_UNLOCKED`).

**Sessions.** DB-backed, HTTP-only cookie; the row is the source of truth, validated every request. **Status and effective permissions are never in the session** — loaded from Postgres per request, so disable / role change / tombstone take effect on the next request.

**Account lifecycle.** `PENDING → ACTIVE → DISABLED → DELETED`. Only ACTIVE may act. Disabling deletes sessions at once. Tombstone sets `status=DELETED`, removes role assignments, preserves the row; partial unique indexes exclude DELETED so email/Entra identity can be reused. No physical delete.

**Authorization (RBAC).** Permissions in a **code-seeded registry**; levels **DELETE ⊃ EDIT ⊃ READ**; **effective permission = union across roles, highest wins**, computed in one `auth/` helper. The role list and seed are canonical in the overview. Distinguish: **assigning a role** is `users:EDIT` (Users page); **defining a role's mappings** is `roles:EDIT` (Roles page).

**ADMIN-only Administration.** In v1 the section is ADMIN-only, so role assignment is ADMIN-only. MANAGER/USER carry no v1 grants and land on `/no-access`. This removes role-assignment escalation at the root (only ADMIN, holding every permission, assigns roles). The RBAC engine stays general for later modules.

**Auth-method change.** Switching `auth_method` revokes that user's sessions; they re-authenticate via the new method.

**Enforcement (defense in depth).**

1. **Route/layout guard** — each page checks its permission + level before rendering (ADMIN-only in v1).
2. **Action/handler guard** — every Server Action/Route Handler re-resolves the live ACTIVE user and re-checks the level; client and page guard are never trusted. Insufficient → **403**.
3. **Data-access layer** — repositories are the only DB callers; mutations write the audit entry atomically in one transaction.

---

## 6. Per-Page Permission Matrix

Every page declares its access. Viewing needs **READ**; mutations need **EDIT**/**DELETE**. A page with no permission is a bug, not "public." In v1 only **ADMIN** holds the permissions below; MANAGER/USER resolve to `/no-access`.

| Page (route)                                                                             | Access                  | Required permission : level                                                                                  |
| ---------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/login`                                                                                 | Public                  | — (redirects if already authenticated)                                                                       |
| Entra sign-in / callback (`/api/auth/*`)                                                 | Public (provider-gated) | Valid Entra identity matching a pre-created SSO user                                                         |
| `/set-password` (forced first-login change)                                              | Session-gated           | Valid session with `force_password_change = TRUE` (own credential only)                                      |
| `/` (root)                                                                               | Authenticated           | Redirects to the first page the user can READ; if none, `/no-access`                                         |
| `/no-access`                                                                             | Authenticated           | Any ACTIVE session — "no module access yet, contact an administrator" (no nav). v1 landing for MANAGER/USER. |
| `/administration/users` (list/detail)                                                    | Authenticated           | `users` : **READ** (ADMIN only in v1)                                                                        |
| — create / edit user, assign or revoke roles, reset password, unlock, change auth method | Authenticated           | `users` : **EDIT** (role assignment is ADMIN-only, §5)                                                       |
| — tombstone (delete) user                                                                | Authenticated           | `users` : **DELETE** (target must be DISABLED first)                                                         |
| `/administration/roles` (list/detail)                                                    | Authenticated           | `roles` : **READ** (ADMIN only in v1)                                                                        |
| — create / edit role, change permission mappings                                         | Authenticated           | `roles` : **EDIT**                                                                                           |
| — delete role                                                                            | Authenticated           | `roles` : **DELETE**                                                                                         |
| `/administration/system-config`                                                          | Authenticated           | `system_config` : **READ** (ADMIN only in v1)                                                                |
| — change configuration values                                                            | Authenticated           | `system_config` : **EDIT**                                                                                   |
| `/administration/audit-log`                                                              | Authenticated           | `audit_log` : **READ** (READ-max — no EDIT/DELETE)                                                           |

> A MANAGER/USER account has no v1 grants and lands on `/no-access` until a later module grants a permission. New pages **must** be added here with an explicit permission + level and a migration adding the `PERMISSIONS` row before they ship.

---

## 7. Background Tasks & AI

**No AI/ML components.** Most "background" behaviour is a per-request check (lockout expiry via `locked_until`, session validity via `expires_at`, live permission resolution), not a job. Standalone jobs run as scheduled **Azure Container Apps Jobs**:

| Task                          | Trigger | Notes                                                                                            |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| Purge expired sessions        | Daily   | Removes `session` rows past `expires_at`. Active revocation is immediate/inline, not this job.   |
| Audit-log archival (optional) | Future  | May export old `AUDIT_LOG` rows to Azure Blob; the table stays append-only. Not required for v1. |

**No email/SMTP**: temp passwords are shown once in-UI and shared out-of-band. Jobs run under a dedicated Managed Identity and never bypass authorization.

---

## 8. Invariants

Rules the codebase must never violate. Each is testable; CI fails builds that break them.

1. **No plaintext or reversible credentials.** Passwords exist only as Better-Auth **scrypt** hashes in `account.password`. No password, token, or secret is logged, returned, or committed.
2. **Authorization state never lives in the session.** Status and effective permissions are loaded from Postgres every request — never in the cookie, token, or client-readable state.
3. **Authorization is always server-side.** Every Server Action and Route Handler re-resolves the live ACTIVE user and re-checks permission + level. Frontend checks are UX only. Insufficient → 403, even when the UI is bypassed.
4. **Deny by default.** No grant at the required level = no access. Unknown routes, missing permissions, and non-ACTIVE accounts resolve to "no access."
5. **Effective permission = union across roles, highest level wins** (DELETE ⊃ EDIT ⊃ READ), computed in exactly one `auth/` helper.
6. **Administration is ADMIN-only in v1, and role assignment requires ADMIN.** MANAGER and USER carry no grants until later modules add permission rows. No subset/escalation computation is needed, because the only actor who can assign a role (ADMIN) already holds every permission.
7. **The permission registry is code-seeded only.** No code path creates `PERMISSIONS` rows; each module adds rows via a committed migration.
8. **Sessions are server-revocable with zero latency.** Disabling deletes session rows so the next request fails; role/mapping and `auth_method` changes take effect on the next request with no re-login (an `auth_method` change revokes sessions outright).
9. **The two auth methods are mutually exclusive per user**, and an Entra login with no matching pre-created SSO email is rejected and creates nothing.
10. **No self-service account creation** — admin pre-creation only; no self-registration, JIT, or Entra-group-based access.
11. **The audit log is append-only and immutable.** The app DB role has no UPDATE/DELETE on `AUDIT_LOG`; `audit_log` has no EDIT/DELETE level. Every mutation **and every successful sign-in** (`SSO_LOGIN`, `LOCAL_LOGIN`) writes an entry with actor, timestamp, target, and before/after.
12. **Users are never physically deleted** — tombstone only (`status=DELETED`, assignments removed in-transaction, `APPUSER` row preserved).
13. **The last ADMIN-capable account can never be disabled or deleted**, and a user must be DISABLED before being tombstoned.
14. **DB access lives only in `db/**`.** No `app/**`, `actions/**`, `services/**`, or `auth/**` file runs raw SQL or imports the DB client; all access goes through the repositories.
15. **One shared database, one core schema.** No module creates its own identity, RBAC, session, config, or audit tables; module domain tables reference `core` by FK. Schema/seed changes go through committed Drizzle migrations run as a gated CI/CD step — no manual production DDL.
16. **All external input is validated** against a Zod schema from `validation/` at the action/handler boundary. Server Actions are public endpoints that reject untrusted payloads; unvalidated input never reaches a service or the DB.
17. **The app is stateless** — no request affinity, no in-memory session/user state across requests; any replica serves any request.
18. **Secrets never live in the database, repo, or image.** Connection strings via Key Vault + Managed Identity; the Entra client secret in `.env`, rotated by redeploy.
19. **Better-Auth's managed fields map to snake_case columns via Better-Auth's field mapping, declared once in `auth/`.** The whole database uses snake_case; the managed columns (scrypt hash, session token, timestamps) are written only by Better-Auth, and the mapping is never bypassed by hand-written SQL.
20. **Authorization decisions are never cached across requests** — evaluated against the live principal every time.
21. **No tenant scoping / RLS.** Single-tenant; no `organization_id` partitioning, RLS unused. Customer (MNO) records in later modules are domain data, not tenants. Security comes from server-side permission checks, not row isolation.
22. **Roles in use or seeded are never deleted.** A role with any `ROLE_ASSIGN` row cannot be deleted (revoke first); the three seeded roles (ADMIN, MANAGER, USER) are permanent. Role deletion writes `ROLE_DELETED`.
23. **Security gates block the pipeline.** SAST and the **OWASP ZAP** DAST baseline run in CI; no high/critical finding ships. Burp Suite Community is used for manual pen-testing. Security regressions fail the build, like type, lint, and test failures.
