# Spec: um05 — RBAC Schema + Registry/Role Seed + Admin Grant

- **Boundary:** DB
- **Dependencies:** Unit um02 (Drizzle connection, `core` schema, identity tables, repository scaffold); Unit um03 (`AUDIT_LOG` table, seeded break-glass admin `appuser` + `account` rows, `db:setup` pipeline).
- **Source sections:** overview §"Data Model" (RBAC tables), §"Roles & Default Permission Seed" (permission matrix), §"Core User Flow" step 1 (cold-start seed contract); architecture §2 (`db/` folder ownership), §3 (storage model — RBAC in Postgres), §4 (one shared `core` schema, modules add `PERMISSIONS` rows via migration), §5 (RBAC mechanics — permission registry code-seeded only, effective permission = union across roles highest wins); code-standards §6.1 (DB access via repositories only), §6.5 (transactional writes), §7 (file org). Invariants touched: **#5** (effective permission = union, highest wins), **#6** (ADMIN-only in v1), **#7** (registry is migration/seed only — no code path creates `PERMISSIONS` rows), **#14** (DB access only in `db/**`), **#15** (one migration history; schema/seed changes go through committed Drizzle migrations), **#22** (seeded roles permanent; roles in use cannot be deleted).

---

## Goal

Define the four RBAC tables (`ROLES`, `ROLE_ASSIGN`, `PERMISSIONS`, `ROLE_PERMISSION_ASSIGN`) in the `core` schema via a Drizzle migration, then run a TypeScript seed script that inserts the four permission registry rows (`users`, `roles`, `system_config`, `audit_log`), the three permanent roles (ADMIN, MANAGER, USER), the ADMIN-only default permission matrix (ADMIN: `users`/`roles`/`system_config` = DELETE, `audit_log` = READ), and a `ROLE_ASSIGN` row granting the seeded break-glass admin the ADMIN role — so that after this unit, direct DB inspection shows the fully seeded registry, all three roles, four ADMIN permission mappings, and the admin's ADMIN assignment, with no application code capable of creating `PERMISSIONS` rows.

---

## Design

### Schema placement

All four tables live in the `core` Postgres schema alongside the identity and audit tables from um02/um03. Import the `pgSchema('core')` object declared once in um02's `db/schema/core/` — do not redeclare it.

### Table design decisions

#### `ROLES`

Stores the named roles. Three rows seeded: ADMIN, MANAGER, USER.

Timestamps follow the same `created_datetime` / `last_modified_datetime` pattern as `APPUSER`. `role_name` carries a standard unique constraint (not partial — deleted roles are physically removed at the row level, unlike users; role deletion is blocked by service-layer guards while any `ROLE_ASSIGN` row references the role, per Invariant #22). `role_descr` is nullable — names are self-documenting.

#### `PERMISSIONS`

The code-seeded registry; one row per page/module in the system. This table has **no timestamps** — it is static, migration/seed-only infrastructure, not operational data. No application code path creates rows here (Invariant #7). `permission_name` is unique and carries the semantic key used throughout the RBAC engine (`'users'`, `'roles'`, `'system_config'`, `'audit_log'`). `permission_info` is a nullable human-readable description.

#### `ROLE_PERMISSION_ASSIGN`

Maps a role to a permission at exactly one level (READ, EDIT, or DELETE). The unique constraint on `(ref_role_id, ref_permission_id)` enforces that a role carries at most one explicit level per permission. This is correct: the level hierarchy (DELETE ⊃ EDIT ⊃ READ) means storing the highest granted level is sufficient — the resolver (um06) derives the implied lower levels. Storing one row per role+permission pair (not three rows for DELETE + EDIT + READ) is both simpler and less error-prone.

`permission_type` is a CHECK-constrained text column — the same pattern as `auth_method` and `status` on `APPUSER`. Timestamps mirror `ROLES` (`created_datetime` / `last_modified_datetime`).

FK behavior:

- `ref_role_id → core.roles(role_id)`: `ON DELETE RESTRICT` — a role with permission mappings cannot be dropped. The service layer (um16) also enforces this; the DB constraint is a safety net.
- `ref_permission_id → core.permissions(permission_id)`: `ON DELETE RESTRICT` — permissions are never deleted, but restrict as a safety net.

#### `ROLE_ASSIGN`

Records which user holds which role, and who assigned it. One unique constraint on `(ref_user_id, ref_role_id)` — a user can hold a role at most once. This table has only `created_datetime` (no `last_modified_datetime`) — a role assignment is created or deleted, never mutated in place. Revoking = deleting the row; reassigning = inserting a new row.

`assigned_by` is **nullable** with `ON DELETE SET NULL`. It is NULL for the seeded ROLE_ASSIGN row (a system bootstrap operation, not an admin UI action). In normal operation it holds the assigning admin's `user_id`. SET NULL (not CASCADE or RESTRICT) ensures that if the assigning admin's row were ever involved in a constraint violation, the assignment row is preserved — the who-assigned-it is informational metadata, not structural data.

FK behavior:

- `ref_user_id → core.appuser(user_id)`: `ON DELETE RESTRICT` — APPUSER rows are never physically deleted (Invariant #12), so this never fires; RESTRICT is the correct safety net.
- `ref_role_id → core.roles(role_id)`: `ON DELETE RESTRICT` — role deletion requires revoking all assignments first (Invariant #22).
- `assigned_by → core.appuser(user_id)`: `ON DELETE SET NULL`.

### Migration vs. seed script

The schema (DDL) ships as a Drizzle migration SQL file generated by `drizzle-kit generate`. The seed data (INSERT rows) ships as a TypeScript script `db/seeds/seed-rbac.ts`, consistent with um03's `seed-admin.ts` pattern. Rationale:

1. The `ROLE_ASSIGN` row requires the bootstrap admin's `user_id`, which is a UUID known only at runtime (generated during the `seed-admin.ts` run). A pure SQL migration cannot reliably reference it without a stored variable or a subselect that embeds the email — the latter would couple the migration to a specific env value.
2. A TypeScript script provides idempotency checks via Drizzle queries (skip if rows already exist).
3. SQL migrations stay pure DDL; seed state is clearly separated.

The migration file number is the next in sequence after um03's `AUDIT_LOG` migration (e.g. `0002_rbac_schema.sql`). Generate it with `npm run db:generate` after adding the four schema files.

### `db:setup` pipeline

`seed-rbac.ts` must run **after** `seed-admin.ts` (it looks up the bootstrap admin by email to create the ROLE_ASSIGN row). Update `db:setup` in `package.json` accordingly:

```
db:migrate → db:seed (admin) → db:seed-rbac
```

### File layout

```
db/
  schema/
    core/
      roles.ts                         ← new
      permissions.ts                   ← new
      role-permission-assign.ts        ← new
      role-assign.ts                   ← new
      index.ts                         ← updated (add four new re-exports)
    index.ts                           ← updated (no structural change; re-exports via core/index.ts)
  migrations/
    0002_rbac_schema.sql               ← generated by drizzle-kit generate
  seeds/
    seed-rbac.ts                       ← new
  repositories/
    roles.repository.ts                ← new stub
    permissions.repository.ts          ← new stub
    role-assign.repository.ts          ← new stub
    role-permission-assign.repository.ts  ← new stub
```

No new files in `auth/`, `services/`, `actions/`, or `app/`. This unit is DB-only.

---

## Implementation

### 5.1 — Schema: `ROLES` (`db/schema/core/roles.ts`)

Table name: `roles` (lowercase). Schema: `core`.

| Column                   | Drizzle type  | Constraints / notes                  |
| ------------------------ | ------------- | ------------------------------------ |
| `role_id`                | `uuid`        | PK, `.defaultRandom()`               |
| `role_name`              | `text`        | NOT NULL; standard unique constraint |
| `role_descr`             | `text`        | nullable                             |
| `created_datetime`       | `timestamptz` | NOT NULL; default `now()`            |
| `last_modified_datetime` | `timestamptz` | NOT NULL; default `now()`            |

No CHECK constraint on `role_name` — roles are admin-managed at runtime; the seeded names (ADMIN, MANAGER, USER) are protected by a service-layer guard in later units, not a column constraint.

### 5.2 — Schema: `PERMISSIONS` (`db/schema/core/permissions.ts`)

Table name: `permissions`. Schema: `core`.

| Column            | Drizzle type | Constraints / notes                  |
| ----------------- | ------------ | ------------------------------------ |
| `permission_id`   | `uuid`       | PK, `.defaultRandom()`               |
| `permission_name` | `text`       | NOT NULL; standard unique constraint |
| `permission_info` | `text`       | nullable                             |

No timestamps — static registry. No FK. No CHECK on `permission_name` — later modules add rows for their own pages without DDL (Invariant #7 ensures only migrations write here, not a column constraint).

### 5.3 — Schema: `ROLE_PERMISSION_ASSIGN` (`db/schema/core/role-permission-assign.ts`)

Table name: `role_permission_assign`. Schema: `core`.

| Column                   | Drizzle type  | Constraints / notes                                                 |
| ------------------------ | ------------- | ------------------------------------------------------------------- |
| `role_permission_id`     | `uuid`        | PK, `.defaultRandom()`                                              |
| `ref_role_id`            | `uuid`        | NOT NULL; FK → `core.roles(role_id)` ON DELETE RESTRICT             |
| `ref_permission_id`      | `uuid`        | NOT NULL; FK → `core.permissions(permission_id)` ON DELETE RESTRICT |
| `permission_type`        | `text`        | NOT NULL; CHECK (`permission_type IN ('READ','EDIT','DELETE')`)     |
| `created_datetime`       | `timestamptz` | NOT NULL; default `now()`                                           |
| `last_modified_datetime` | `timestamptz` | NOT NULL; default `now()`                                           |

Unique constraint: `(ref_role_id, ref_permission_id)` — defined as `.unique('role_permission_assign_role_permission_unique')` in the Drizzle extra config callback (or inline `.uniqueIndex()`; use whichever Drizzle emits as a proper constraint, not just an index, so violation messages are clear).

CHECK constraint: `check('role_permission_assign_type_check', sql\`permission_type IN ('READ','EDIT','DELETE')\`)`— same pattern as`auth_method`on`APPUSER`.

### 5.4 — Schema: `ROLE_ASSIGN` (`db/schema/core/role-assign.ts`)

Table name: `role_assign`. Schema: `core`.

| Column             | Drizzle type  | Constraints / notes                                       |
| ------------------ | ------------- | --------------------------------------------------------- |
| `role_assign_id`   | `uuid`        | PK, `.defaultRandom()`                                    |
| `ref_user_id`      | `uuid`        | NOT NULL; FK → `core.appuser(user_id)` ON DELETE RESTRICT |
| `ref_role_id`      | `uuid`        | NOT NULL; FK → `core.roles(role_id)` ON DELETE RESTRICT   |
| `assigned_by`      | `uuid`        | nullable; FK → `core.appuser(user_id)` ON DELETE SET NULL |
| `created_datetime` | `timestamptz` | NOT NULL; default `now()`                                 |

No `last_modified_datetime` — this row is created or deleted; revoking a role assignment deletes the row, it is never updated.

Unique constraint: `(ref_user_id, ref_role_id)` — a user holds a given role at most once. Named `role_assign_user_role_unique`.

### 5.5 — Schema index update (`db/schema/core/index.ts`)

Add four new re-exports alongside the existing identity and audit exports:

```ts
export * from "./roles";
export * from "./permissions";
export * from "./role-permission-assign";
export * from "./role-assign";
```

`db/schema/index.ts` requires no structural change — it already re-exports everything from `core/index.ts`. Verify that `drizzle.config.ts` and `db/client.ts` both pick up the new tables via the existing import chain.

Derive and export Drizzle row types from `$inferSelect` / `$inferInsert` for all four new tables. Re-export the relevant cross-layer subset through `types/rbac.ts` (see §5.6).

### 5.6 — `types/rbac.ts` — shared RBAC types

New file. Defines constants and types needed by the RBAC engine (to be used in um06 and later):

```ts
export const PERMISSION_NAMES = [
  "users",
  "roles",
  "system_config",
  "audit_log",
] as const;
export type PermissionName = (typeof PERMISSION_NAMES)[number];

export const PERMISSION_TYPES = ["READ", "EDIT", "DELETE"] as const;
export type PermissionType = (typeof PERMISSION_TYPES)[number];

export const SEEDED_ROLE_NAMES = ["ADMIN", "MANAGER", "USER"] as const;
export type SeededRoleName = (typeof SEEDED_ROLE_NAMES)[number];
```

Re-export `Role`, `RoleInsert`, `Permission`, `PermissionInsert`, `RoleAssign`, `RoleAssignInsert`, `RolePermissionAssign`, `RolePermissionAssignInsert` from Drizzle's `$inferSelect` / `$inferInsert` on each table, through this file. This prevents `app/**`, `actions/**`, and `services/**` from importing `drizzle-orm` or the table objects directly (Invariant #14).

### 5.7 — Migration generation

After adding the four schema files and updating `core/index.ts`, run:

```
npm run db:generate
```

This emits the next SQL migration file (e.g. `db/migrations/0002_rbac_schema.sql`). **Hand-review the generated SQL before committing.** Confirm:

- `CREATE TABLE core.roles`, `core.permissions`, `core.role_permission_assign`, `core.role_assign` are all present.
- All PK columns are `uuid` with `DEFAULT gen_random_uuid()`.
- All FK constraints are present with the correct `ON DELETE` actions (RESTRICT / RESTRICT / RESTRICT / SET NULL as specified in §5.3 and §5.4).
- The unique constraint on `role_permission_assign(ref_role_id, ref_permission_id)` is a named constraint (not just an index).
- The unique constraint on `role_assign(ref_user_id, ref_role_id)` is a named constraint.
- The CHECK on `role_permission_assign.permission_type` is present.
- `role_assign` has no `last_modified_datetime` column.
- `permissions` has no timestamp columns.

Do not hand-edit the generated SQL file.

### 5.8 — `db/seeds/seed-rbac.ts` — RBAC seed script

A standalone TypeScript script (`npm run db:seed-rbac`) run with `tsx --env-file=.env`. It depends on `seed-admin.ts` having already run (the bootstrap admin row must exist to create the ROLE_ASSIGN row). `db:setup` enforces this order.

**Seed data:**

`ROLES` (3 rows):

| `role_name` | `role_descr`                                                               |
| ----------- | -------------------------------------------------------------------------- |
| `'ADMIN'`   | `'Full access to all administration pages and user lifecycle management.'` |
| `'MANAGER'` | `'Reserved for future module access. No grants in v1.'`                    |
| `'USER'`    | `'Reserved for future module access. No grants in v1.'`                    |

`PERMISSIONS` (4 rows):

| `permission_name` | `permission_info`                                     |
| ----------------- | ----------------------------------------------------- |
| `'users'`         | `'Controls access to the Users administration page.'` |
| `'roles'`         | `'Controls access to the Roles administration page.'` |
| `'system_config'` | `'Controls access to the System Configuration page.'` |
| `'audit_log'`     | `'Controls access to the Audit Log viewer.'`          |

`ROLE_PERMISSION_ASSIGN` (4 rows — ADMIN only; MANAGER and USER receive no rows):

| Role  | Permission      | `permission_type` |
| ----- | --------------- | ----------------- |
| ADMIN | `users`         | `'DELETE'`        |
| ADMIN | `roles`         | `'DELETE'`        |
| ADMIN | `system_config` | `'DELETE'`        |
| ADMIN | `audit_log`     | `'READ'`          |

`ROLE_ASSIGN` (1 row):

| `ref_user_id`                                    | `ref_role_id`          | `assigned_by` |
| ------------------------------------------------ | ---------------------- | ------------- |
| bootstrap admin's `user_id` (looked up by email) | ADMIN role's `role_id` | `NULL`        |

`assigned_by = NULL` for this row because the assignment is a system bootstrap operation performed at deployment, not an admin UI action. Add a comment in the seed script documenting this deliberate exception. Normal UI-driven role assignments (um13) always supply a non-null `assigned_by`.

**Idempotency logic:**

The seed checks each category in order before inserting:

1. Query `core.roles` for a row with `role_name = 'ADMIN'`. If found, skip the entire ROLES + PERMISSIONS + ROLE_PERMISSION_ASSIGN + ROLE_ASSIGN block and exit 0 with a log message. (If ADMIN exists, the seed has already run.) This single check is sufficient — all four categories are seeded atomically in one transaction.

If not found, open `db.transaction(async (tx) => { … })` and:

2. Insert all three `ROLES` rows; capture the returned `role_id` values by name (ADMIN, MANAGER, USER).
3. Insert all four `PERMISSIONS` rows; capture the returned `permission_id` values by `permission_name`.
4. Insert the four `ROLE_PERMISSION_ASSIGN` rows using the captured IDs from steps 2 and 3.
5. Query `core.appuser` for `user_email = config.bootstrapAdminEmail`; capture `user_id`. If not found, throw — the RBAC seed cannot complete without the bootstrap admin row (fail-fast with a clear message: "Bootstrap admin not found. Run db:seed first.").
6. Insert the single `ROLE_ASSIGN` row with `ref_user_id` from step 5, `ref_role_id` = ADMIN's `role_id`, `assigned_by = null`.
7. Commit.

If the transaction throws for any reason other than the bootstrap-admin-not-found check, catch it, log via `lib/logger`, and exit 1. Never use `console.*`.

**No `AUDIT_LOG` row is written by this seed.** Role assignments made at deployment bootstrap are infrastructure operations, not operational events. This is a deliberate, documented exception — add a comment in the seed script. Normal `ROLE_ASSIGNED` audit events are emitted by the service layer (um13) for all subsequent UI-driven assignments.

**Script skeleton:**

```ts
// db/seeds/seed-rbac.ts
// Depends on: seed-admin.ts having already run.
// Idempotent: checks for ADMIN role row before inserting; skips if found.
// No AUDIT_LOG rows written (bootstrap exception — see comment below).
```

**Add to `package.json`:**

```json
"db:seed-rbac": "node --env-file=.env --import tsx db/seeds/seed-rbac.ts",
"db:setup": "npm run db:migrate && npm run db:seed && npm run db:seed-rbac"
```

The `db:setup` command replaces the one set in um03. It is the single command for a fresh deployment; CI/CD calls this in the gated migration step.

### 5.9 — Repository stubs (`db/repositories/`)

Create four new files, each exporting a typed-but-empty repository object — the same pattern as um02's identity repository stubs. Implementations are added in later units (um13 roles/assignments CRUD, um14 permission mappings CRUD, um06 permission resolver read queries).

```ts
// db/repositories/roles.repository.ts
// Implementations added in um13.
export const rolesRepository = {} as {
  // method signatures added in um13
};

// db/repositories/permissions.repository.ts
// Implementations added in um06 (read) and are read-only at the app layer.
export const permissionsRepository = {} as {
  // method signatures added in um06
};

// db/repositories/role-assign.repository.ts
// Implementations added in um13.
export const roleAssignRepository = {} as {
  // method signatures added in um13
};

// db/repositories/role-permission-assign.repository.ts
// Implementations added in um14.
export const rolePermissionAssignRepository = {} as {
  // method signatures added in um14
};
```

No repository file may import the DB client or run any query — stubs only. Do not export these stubs from `db/schema/index.ts`; they are imported directly from `db/repositories/` by consumers.

### 5.10 — Explicitly NOT in this unit

- The effective-permission resolver (`auth/permissions.ts`) and `requirePermission` guard — um06.
- The `ROLE_ASSIGN` write path in the application (admin assigns a role via Users page) — um13.
- The `ROLE_PERMISSION_ASSIGN` write path (admin maps role → permission at a level) — um14.
- `ROLE_DELETED`, `ROLE_ASSIGNED`, `ROLE_REVOKED`, `PERMISSION_MAPPING_CHANGED` audit events — their owning units.
- Query functions on any of the four new repositories — their owning units.
- The `/administration/roles` page — um16.
- Least-privilege DB role enforcement (INSERT-only on `AUDIT_LOG`, no runtime DDL) — um25.

---

## Dependencies

No new npm packages. All required packages (`drizzle-orm`, `postgres`, `drizzle-kit`, `tsx`) were installed in um02. This unit adds only schema files, a migration, a seed script, and repository stubs.

---

## Verification Checklist

### Schema & migration generation

- [ ] `npm run db:generate` emits exactly one new SQL migration file (e.g. `0002_rbac_schema.sql`) after the um03 audit_log migration
- [ ] Generated SQL creates all four tables in `core`: `core.roles`, `core.permissions`, `core.role_permission_assign`, `core.role_assign`
- [ ] All four PK columns (`role_id`, `permission_id`, `role_permission_id`, `role_assign_id`) are `uuid` type with `DEFAULT gen_random_uuid()`
- [ ] `core.roles` DDL: `role_name` has a unique constraint; both timestamp columns are NOT NULL with `DEFAULT now()`
- [ ] `core.permissions` DDL: `permission_name` has a unique constraint; **no** timestamp columns
- [ ] `core.role_permission_assign` DDL: CHECK constraint `permission_type IN ('READ','EDIT','DELETE')` is present; named unique constraint on `(ref_role_id, ref_permission_id)` is present; FK `ref_role_id → core.roles(role_id) ON DELETE RESTRICT` and `ref_permission_id → core.permissions(permission_id) ON DELETE RESTRICT` are present
- [ ] `core.role_assign` DDL: named unique constraint on `(ref_user_id, ref_role_id)` is present; FK `ref_user_id → core.appuser(user_id) ON DELETE RESTRICT`, `ref_role_id → core.roles(role_id) ON DELETE RESTRICT`, `assigned_by → core.appuser(user_id) ON DELETE SET NULL` are all present; `assigned_by` is nullable; **no** `last_modified_datetime` column
- [ ] No `last_modified_datetime` column on `role_assign`; no timestamp columns on `permissions`

### Migration application

- [ ] `npm run db:migrate` applies all three migrations (0000 identity, 0001 audit_log, 0002 rbac_schema) cleanly against a fresh Postgres instance and exits 0
- [ ] Re-running `npm run db:migrate` is idempotent (Drizzle migration history prevents re-application)
- [ ] `psql \dt core.*` lists exactly: `appuser`, `account`, `session`, `verification`, `audit_log`, `roles`, `permissions`, `role_permission_assign`, `role_assign`

### TypeScript types

- [ ] `types/rbac.ts` exports `PERMISSION_NAMES`, `PermissionName`, `PERMISSION_TYPES`, `PermissionType`, `SEEDED_ROLE_NAMES`, `SeededRoleName` as `as const` arrays and derived union types
- [ ] Drizzle-derived `Role`, `RoleInsert`, `Permission`, `PermissionInsert`, `RoleAssign`, `RoleAssignInsert`, `RolePermissionAssign`, `RolePermissionAssignInsert` types are re-exported from `types/rbac.ts`
- [ ] `npm run typecheck` is clean across all new files

### Seed script — happy path

- [ ] `npm run db:seed-rbac` against a DB that has had `db:migrate` + `db:seed` (admin) run: exits 0
- [ ] After running: `SELECT * FROM core.roles ORDER BY role_name` returns exactly 3 rows: `ADMIN`, `MANAGER`, `USER`
- [ ] After running: `SELECT * FROM core.permissions ORDER BY permission_name` returns exactly 4 rows: `audit_log`, `roles`, `system_config`, `users`
- [ ] After running: `SELECT rpa.permission_type, r.role_name, p.permission_name FROM core.role_permission_assign rpa JOIN core.roles r ON r.role_id = rpa.ref_role_id JOIN core.permissions p ON p.permission_id = rpa.ref_permission_id ORDER BY p.permission_name` returns exactly 4 rows matching: `(ADMIN, audit_log, READ)`, `(ADMIN, roles, DELETE)`, `(ADMIN, system_config, DELETE)`, `(ADMIN, users, DELETE)`
- [ ] MANAGER and USER have **zero** rows in `core.role_permission_assign`
- [ ] After running: `SELECT ra.assigned_by, r.role_name, a.user_email FROM core.role_assign ra JOIN core.roles r ON r.role_id = ra.ref_role_id JOIN core.appuser a ON a.user_id = ra.ref_user_id` returns exactly 1 row: the bootstrap admin email, ADMIN role, `assigned_by = NULL`
- [ ] `core.audit_log` contains **zero** rows written by `seed-rbac.ts`

### Seed script — idempotency

- [ ] Re-running `npm run db:seed-rbac` on a DB that already has the seed data: exits 0 with a "already seeded, skipping" log message and creates no duplicate rows
- [ ] `SELECT COUNT(*) FROM core.roles` after a double run = 3
- [ ] `SELECT COUNT(*) FROM core.role_permission_assign` after a double run = 4
- [ ] `SELECT COUNT(*) FROM core.role_assign` after a double run = 1

### Seed script — error cases

- [ ] Running `npm run db:seed-rbac` before `npm run db:seed` (no bootstrap admin exists): exits 1 with a clear error message ("Bootstrap admin not found. Run db:seed first.")
- [ ] Running `npm run db:seed-rbac` before `npm run db:migrate` (no tables): exits 1 with a DB error; no partial state is committed (transaction atomicity)
- [ ] `npm run db:setup` from a fully clean DB: completes end-to-end (migrate + seed-admin + seed-rbac), all verification queries above pass

### Repository stubs

- [ ] `db/repositories/roles.repository.ts`, `permissions.repository.ts`, `role-assign.repository.ts`, `role-permission-assign.repository.ts` all exist and can be imported without TypeScript errors
- [ ] None of the four stub files imports the DB client or any Drizzle query builder — stubs only

### Boundary enforcement

- [ ] `grep -r "from 'drizzle-orm'" --include="*.ts" app/ actions/ services/ auth/` returns no results (Invariant #14)
- [ ] No file outside `db/` imports the new table objects or the Drizzle `db` client directly
- [ ] `db/seeds/seed-rbac.ts` is not imported by any application module — CLI script only
- [ ] No `console.*` in any new file; all diagnostics via `lib/logger`

### Scope guard

- [ ] No permission resolver, `requirePermission` guard, or effective-permission logic was added (um06)
- [ ] No route handlers, Server Actions, or pages reference the four new tables (um06+)
- [ ] No `ROLE_ASSIGNED` or `PERMISSION_MAPPING_CHANGED` audit events were emitted (um13/um14)
- [ ] The `auth/` folder is untouched — no changes to `auth/index.ts` or `auth/client.ts`
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
