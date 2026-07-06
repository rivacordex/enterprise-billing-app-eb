# Enterprise Billing Application — Architecture

Platform-wide technical architecture for the **enterprise billing application** used internally by Revenue Ops. This document owns the decisions **every module** — User Management, Product, Customer, Billing Service, Bill Run, Accounting — builds on: stack, folder boundaries, database design, the auth/authorization platform, and platform invariants.

**Status:** ACTIVE. Authoritative — changes to *Platform Invariants* require a documented design review.

**Companion docs:** each module owns a `<module>-architecture.md` with its module-specific storage, flows, permission matrix, and invariants (`usrmgmt-architecture.md`, `prodmgmt-architecture.md`). Module product specs (e.g. `usrmgmt-project-overview.md`) own user flows, data models, and seeds; module code-standards docs turn this into enforceable conventions.

**Scope:** Single internal tool — not multi-tenant, not customer-facing; admin pre-created accounts only. **Better-Auth**; single TypeScript runtime. **Enterprise production-grade**: zone-redundant managed Postgres with PITR, gated migrations, a least-privilege DB role, secrets in Key Vault via Managed Identity, SAST + DAST gates in CI.

---

## 1. Technology Stack

| Layer | Technology | Role |
|---|---|---|
| **Frontend** | Next.js ≥ 15 (App Router, RSC) on Node ≥ 22 (Active LTS), TypeScript `strict` | UI, routing, SSR/streaming, forms. Frontend permission checks show/hide only — never the security boundary. |
| **APIs & Backend Logic** | Next.js Route Handlers + Server Actions over a framework-agnostic `services/` layer | One deploy unit; no separate API tier, no cross-runtime token handoff. Server Actions handle UI mutations; Route Handlers (`/api/*`) host the Better-Auth handler and M2M endpoints. Business rules live in `services/`, so a future external API (e.g. TMForum) attaches as another adapter — a separate deployment unit, not a second backend. |
| **Database & Storage** | Managed **Azure Database for PostgreSQL — Flexible Server** (≥ 16) via **Drizzle ORM** | Single system of record. Drizzle owns schema + migrations; type-safe queries through the data-access layer. Zone-redundant HA. |
| **Auth & Permissions** | **Better-Auth** (DB-backed sessions; credentials + Microsoft/Entra provider) | Owns auth mechanics and its `user`/`account`/`session`/`verification` tables, fields remapped to snake_case (Inv. #14). RBAC is our tables on top, enforced per request. No authz state in the session. |
| **Hosting & Deployment** | **Azure Container Apps** on Azure Cloud (Docker, multi-replica) | Revision-based deploys, rolling/blue-green, instant rollback. Migrations run as a gated pipeline step before traffic shifts. |
| **Cloud & Compute** | **Azure Cloud** | Compute (Container Apps), managed Postgres, secrets (Key Vault), identity (Managed Identity), networking (VNet). |
| **CI/CD & Version Control** | **Azure DevOps** (Repos + Pipelines) | Git, PR/branch policies; build → test → scan (SAST + DAST) → containerize → migrate → deploy; gated dev → staging → prod. |
| **Security & RLS** | App-layer authorization (Postgres **RLS unused**); DAST via **OWASP ZAP** + **Burp Suite Community** | Single-tenant → no per-row boundary. Every request resolves live status + effective permissions before business logic. ZAP runs automated as a DAST gate; Burp for manual pen-testing. No high/critical finding ships. |
| **Rate Limiting** | None at app layer (v1) | Auth endpoints rely on Better-Auth + the custom per-account lockout (see `usrmgmt-architecture.md`). Add APIM / Front Door WAF if external exposure grows. |
| **Caching & CDN** | None | No cache tier or CDN; Next.js static serving suffices. Authz decisions are **never** cached. |
| **Load Balancing & Scaling** | Container Apps autoscaling (KEDA, HTTP-concurrency) + ingress LB | Autoscale on concurrency; min 2 replicas. Stateless → any replica serves any request. |
| **Error Tracking & Logs** | **GlitchTip** (crashes/exceptions) + **Azure Monitor + App Insights** (system/DB) | GlitchTip for frontend/backend crash capture and release health; Azure Monitor/App Insights (OpenTelemetry) for system/DB metrics, logs, traces, alerting on error rate, latency, failed-login spikes. |
| **Availability & Recovery** | Managed Azure PostgreSQL backups + **PITR**, zone-redundant Flexible Server; multi-replica Container Apps across zones | Recovery via managed PITR. Retention ≥ 14 days, zone-redundant. Stateless app → recovery = redeploy image + restore DB. Documented RPO/RTO. |

> **Single-runtime rationale**: the rebuilt engine has no Python to preserve, so backend logic stays in-process behind the `services/` boundary. Extract a standalone service (or the external API) only when a non-web consumer or independent scaling need emerges — importing the same `services/` and `db/`, not duplicating them.

---

## 2. System Boundaries — Folder Ownership

Each folder owns one responsibility. Dependencies point **inward**: UI → actions/routes → services → data-access → database; inner layers never import outward. `components/`, `validation/`, `types/` are shared **leaf** modules.

| Path | Owns | Must NOT contain |
|---|---|---|
| `app/(auth)/**` | Unauthenticated / bootstrap pages: local login, Entra sign-in entry, forced first-login password change. | Business logic; DB access; self-registration. |
| `app/(app)/**` | All authenticated module pages + the shared shell layout, one subfolder per module (`administration/`, `products/`, later `customers/`, `bill-runs/`); each page declares its permission + level; thin orchestrators composing `components/`. _(Renamed from `(admin)` — Product Module plan, Decision #10. One route group = one layout boundary; new groups only when chrome genuinely differs.)_ | DB queries; raw SQL; permission logic beyond the guard; heavy markup. |
| `components/**` | Reusable presentational UI shared across `(auth)`/`(app)`. Left navigation is structured as `NAV_SECTIONS` (caption + items per section, one section per module); nav items render regardless of permission — the page guard enforces access. Any future hide-without-permission behavior applies platform-wide, never per module. | DB access; business logic; permission **decisions** (may read a passed-in map to show/hide); data fetching beyond props. |
| `app/api/**` | Route Handlers: Better-Auth (`/api/auth/*`), Entra callback, M2M endpoints. | UI; business rules (delegates to `services`). |
| `actions/**` | Server Actions: mutation entry points. Parse input, resolve principal, check permission + level, call a service. | DB queries; business rules beyond orchestration; inline parsing. |
| `validation/**` | Zod schemas — single source for every external input's shape; parsed **before** a service. | Business logic; DB access; `next/*` or UI imports. |
| `services/**` | Business logic / use cases per module. Framework-agnostic. | `next/*`; request/response objects; UI. |
| `db/**` | Drizzle schema, migrations, seeds, repositories. The **only** place SQL/queries live. | Business rules; permission checks. |
| `auth/**` | Better-Auth config, providers, the field mapping (Inv. #14), session/sign-in hooks (incl. lockout), the code-seeded permission registry, the single effective-permission resolver. | Page-specific logic; table mutation outside repositories. |
| `types/**` | Shared cross-layer TS types (Drizzle rows + UI/request state). Prevents circular deps. | Runtime code; DB queries; business logic. |
| `lib/**` | Cross-cutting utilities: telemetry (GlitchTip + OpenTelemetry), error types, config, helpers. | Domain logic; DB access; validation schemas. |
| `tests/**` | Unit, integration, e2e — incl. the route × level authorization matrix. | Production code. |
| `infra/**` | IaC (Bicep/Terraform), Azure Pipelines YAML (incl. the OWASP ZAP DAST stage), Dockerfile, env templates. | Application code. |

**Boundary rule.** UI never calls `db/**` directly — it calls a Server Action/Route Handler, which resolves the session, loads the live user + effective permissions, checks permission/level, then calls a `service`, which calls the data-access layer. Permission checks happen at the action/route boundary; services assume an authorized context.

---

## 3. Storage Principles

All application data lives in **Postgres** — single system of record; no file storage or cache tier in v1. Rules that hold across modules:

| Concern | Rule |
|---|---|
| System of record | One Postgres database (see §4). Column-level detail for the shared core is in `usrmgmt-architecture.md` §Storage Model. |
| User-uploaded files | None in v1. Later: binary → Azure Blob, DB stores a reference. |
| Cache | None. Authz decisions evaluated live per request — never cached. |
| Secrets & connection strings | `.env` / Key Vault. Connection strings via Key Vault + Managed Identity; the Entra client secret in `.env` (rotation = redeploy). No secret in DB, repo, or image. |
| Config | Non-secret runtime params in `core.SYSTEM_CONFIG` (`is_secret` reserved, always FALSE), partitioned by `config_group`. |
| Audit | Append-only `core.AUDIT_LOG`; the app DB role has no UPDATE/DELETE. |
| JSONB columns | Allowed only when every write is validated against a Zod schema in `validation/` for the column's declared shape (discriminated per type column where applicable, e.g. per `pricing_model`). No junk-drawer JSONB. |
| Human-readable IDs | Domain-table IDs = fixed prefix + zero-padded DB sequence (e.g. `PRDOFR000001`), one sequence per table. Modules follow this convention rather than inventing their own. |

---

## 4. Multi-Module Database Design

All modules run on **one Flexible Server instance and one logical database** — no per-module database, no second Better-Auth instance.

**Shared core vs module domain.** The 10 User-Management tables are the **shared core**: identity (`APPUSER`, `account`, `session`, `verification`), RBAC (`ROLES`, `ROLE_ASSIGN`, `PERMISSIONS`, `ROLE_PERMISSION_ASSIGN`), `SYSTEM_CONFIG`, `AUDIT_LOG`. Later modules reuse them and **never create their own user, role, permission, session, config, or audit tables**; they add only domain tables (products, customers/MNOs, bill runs, ledgers, …) referencing the core by FK.

**Namespacing — schema per module.** The core lives in a `core` schema; each module owns its own (`product`, `customer`, `billing`, `accounting`, …). Cross-schema FKs (module rows → `core.APPUSER.user_id`) are used directly — logical isolation and clear ownership on one instance, one pool, one backup/restore lifecycle. Domain modules use such FKs for provenance columns too (e.g. `product.product_offering.last_edited_by` → `core.APPUSER`). Better-Auth's tables stay in `core`, snake_case like ours.

| Concern | Rule across modules |
|---|---|
| Identity & sessions | One set of Better-Auth tables in `core`; one principal in every module. |
| Permissions | One global registry; each module ships a migration adding its `core.PERMISSIONS` rows; access granted by admin role→permission mapping, no code change. |
| Audit | One `core.AUDIT_LOG`, discriminated by `event_type`/`target_entity`. INSERT-only. |
| Config | One `core.SYSTEM_CONFIG`, partitioned by `config_group`. |
| Migrations | One Drizzle migration history; modules contribute module-scoped files, applied in one gated step. |
| DB role | One least-privilege role: DML on domain tables, **INSERT-only on `core.AUDIT_LOG`**, no runtime DDL. |

**Customers (MNOs) are domain data, not tenants.** Customer records are business entities owned by module tables — not application users, not a tenancy boundary. The only principals are internal RevOps staff, so the app stays single-tenant and RLS stays unused.

---

## 5. Authentication & Authorization Platform

The platform contract every module builds on. Module-specific flows (sign-in methods, lockout, account lifecycle, the v1 permission matrix) are in `usrmgmt-architecture.md`.

**Sessions.** Better-Auth, DB-backed, HTTP-only cookie; the row is the source of truth, validated every request. **Status and effective permissions are never in the session** — loaded from Postgres per request, so disable / role change / tombstone take effect on the next request. Deleting rows = instant revocation.

**Authorization (RBAC).** Permissions in a **code-seeded registry**; levels **DELETE ⊃ EDIT ⊃ READ**; **effective permission = union across roles, highest wins**, computed in one `auth/` helper. Each module ships a migration adding its `PERMISSIONS` rows; access is granted by admin role→permission mapping, no code change.

**Per-page access declaration.** Every page declares its permission + level. Viewing needs **READ**; mutations need **EDIT**/**DELETE**. A page with no permission is a bug, not "public." New pages **must** be added to their module's permission matrix with an explicit permission + level and a migration adding the `PERMISSIONS` row before they ship.

**Enforcement (defense in depth).**
1. **Route/layout guard** — each page checks its permission + level before rendering.
2. **Action/handler guard** — every Server Action/Route Handler re-resolves the live ACTIVE user and re-checks the level; client and page guard are never trusted. Insufficient → **403**.
3. **Data-access layer** — repositories are the only DB callers; mutations write the audit entry atomically in one transaction.

---

## 6. Background Tasks & AI

**No AI/ML components.** Most "background" behaviour is a per-request check (e.g. lockout expiry, session validity, live permission resolution), not a job. Standalone jobs run as scheduled **Azure Container Apps Jobs** under a dedicated Managed Identity and never bypass authorization. Each module documents its jobs in its module architecture doc (core jobs — session purge, audit archival — are in `usrmgmt-architecture.md`).

**No email/SMTP** in v1.

---

## 7. Platform Invariants

Rules the codebase must never violate, in any module. Each is testable; CI fails builds that break them. _(Original numbering from `usrmgmt-architecture.md` §8 in parentheses; module-specific invariants #6, 9, 10, 12, 13, 22 moved to that doc.)_

1. **No plaintext or reversible credentials.** Passwords exist only as Better-Auth **scrypt** hashes in `account.password`. No password, token, or secret is logged, returned, or committed. _(orig. #1)_
2. **Authorization state never lives in the session.** Status and effective permissions are loaded from Postgres every request — never in the cookie, token, or client-readable state. _(orig. #2)_
3. **Authorization is always server-side.** Every Server Action and Route Handler re-resolves the live ACTIVE user and re-checks permission + level. Frontend checks are UX only. Insufficient → 403, even when the UI is bypassed. _(orig. #3)_
4. **Deny by default.** No grant at the required level = no access. Unknown routes, missing permissions, and non-ACTIVE accounts resolve to "no access." _(orig. #4)_
5. **Effective permission = union across roles, highest level wins** (DELETE ⊃ EDIT ⊃ READ), computed in exactly one `auth/` helper. _(orig. #5)_
6. **The permission registry is code-seeded only.** No code path creates `PERMISSIONS` rows; each module adds rows via a committed migration. _(orig. #7)_
7. **Sessions are server-revocable with zero latency.** Disabling deletes session rows so the next request fails; role/mapping and `auth_method` changes take effect on the next request with no re-login (an `auth_method` change revokes sessions outright). _(orig. #8)_
8. **The audit log is append-only and immutable.** The app DB role has no UPDATE/DELETE on `AUDIT_LOG`; `audit_log` has no EDIT/DELETE level. Every mutation **and every successful sign-in** (`SSO_LOGIN`, `LOCAL_LOGIN`) writes an entry with actor, timestamp, target, and before/after. _(orig. #11)_
9. **DB access lives only in `db/**`.** No `app/**`, `actions/**`, `services/**`, or `auth/**` file runs raw SQL or imports the DB client; all access goes through the repositories. _(orig. #14)_
10. **One shared database, one core schema.** No module creates its own identity, RBAC, session, config, or audit tables; module domain tables reference `core` by FK. Schema/seed changes go through committed Drizzle migrations run as a gated CI/CD step — no manual production DDL. _(orig. #15)_
11. **All external input is validated** against a Zod schema from `validation/` at the action/handler boundary. Server Actions are public endpoints that reject untrusted payloads; unvalidated input never reaches a service or the DB. _(orig. #16)_
12. **The app is stateless** — no request affinity, no in-memory session/user state across requests; any replica serves any request. _(orig. #17)_
13. **Secrets never live in the database, repo, or image.** Connection strings via Key Vault + Managed Identity; the Entra client secret in `.env`, rotated by redeploy. _(orig. #18)_
14. **Better-Auth's managed fields map to snake_case columns via Better-Auth's field mapping, declared once in `auth/`.** The whole database uses snake_case; the managed columns (scrypt hash, session token, timestamps) are written only by Better-Auth, and the mapping is never bypassed by hand-written SQL. _(orig. #19)_
15. **Authorization decisions are never cached across requests** — evaluated against the live principal every time. _(orig. #20)_
16. **No tenant scoping / RLS.** Single-tenant; no `organization_id` partitioning, RLS unused. Customer (MNO) records are domain data, not tenants. Security comes from server-side permission checks, not row isolation. _(orig. #21)_
17. **Security gates block the pipeline.** SAST and the **OWASP ZAP** DAST baseline run in CI; no high/critical finding ships. Burp Suite Community is used for manual pen-testing. Security regressions fail the build, like type, lint, and test failures. _(orig. #23)_
18. **Financially significant rows are immutable.** Rows that feed billing or accounting (prices, future rated charges, ledger entries) are never UPDATEd or DELETEd; a correction inserts a successor row. Historical billing basis is reconstructed from these rows — **the audit log is forensics, never a rating or pricing source.** _(introduced by the Product module; applies to Billing Service, Bill Run, Accounting.)_
