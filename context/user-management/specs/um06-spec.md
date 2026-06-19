# Spec: um06 — Authorization Enforcement Core

- **Boundary:** AUTH / APP
- **Dependencies:** Unit um05 (RBAC schema seeded — `core.roles`, `core.permissions`, `core.role_permission_assign`, `core.role_assign`; `types/rbac.ts` constants; repository stubs for all four RBAC tables).
- **Source sections:** overview §"Authorization enforcement", §"Roles & Default Permission Seed", §"Core User Flow" step 5; architecture §2 (`auth/` and `app/` folder ownership), §5 (RBAC mechanics, enforcement contract, account lifecycle), §6 (per-page permission matrix); code-standards §1 (deny by default, always server-side), §3.6 (page guard pattern), §3.8 (force-dynamic), §3.13 (root redirect), §7.8 (`auth/` holds the resolver), §8.5 (typed permission constants). Invariants: **#2** (no authz state in session), **#3** (always server-side), **#4** (deny by default), **#5** (exactly one resolver, union, highest wins), **#6** (ADMIN-only in v1), **#20** (never cached).

---

## Goal

Build the single effective-permission resolver in `auth/`, the `requirePermission(name, level)` page/layout guard, typed permission-name constants, `force-dynamic` declarations on all authenticated routes, the `/no-access` page, the root `/` redirect, and the serialized client-side permission map — so that any ACTIVE user with no grants lands on `/no-access`, the seeded ADMIN is routed onward to `/administration/users`, and every route is deny-by-default, verified by a route×level matrix test suite.

---

## Design

### Permission resolution algorithm

Effective permission = union across all roles assigned to the user; for each permission name, take the **highest** `permission_type` across all matching `role_permission_assign` rows. The hierarchy is `DELETE ⊃ EDIT ⊃ READ`, encoded as a numeric rank:

```
READ  = 1
EDIT  = 2
DELETE = 3
```

A user satisfies a required level when their effective rank for that permission is **≥** the required rank. If a user has no `role_assign` rows or no matching `role_permission_assign` rows for a given permission, their effective level for that permission is `null` (no access). `null` satisfies nothing — deny by default (Invariant #4).

This logic lives in exactly one place: `auth/resolver.ts` (Invariant #5). No other file re-implements it.

### Resolver output shape

`resolveEffectivePermissions(userId: string)` returns `EffectivePermissionMap`:

```
Record<PermissionName, PermissionType | null>
```

Every known `PermissionName` (`'users'`, `'roles'`, `'system_config'`, `'audit_log'`) is present as a key; the value is the highest `PermissionType` the user holds or `null`. Missing permission names default to `null` (not `undefined`) so callers never need an existence check.

This shape is used:

- Server-side by the guard to enforce access.
- Client-side (serialized as a prop from RSC to client components) for show/hide only — never the enforcement point.

### Guard behavior

`requirePermission(name, level)` is an `async` Server function called at the top of `page.tsx` or `layout.tsx` before rendering. Behavior in order:

1. Call `auth.api.getSession({ headers: headers() })` to retrieve the current Better-Auth session.
2. If no session → `redirect('/login')`.
3. Load the APPUSER row by `session.user.id`. If the user is not ACTIVE (PENDING, DISABLED, DELETED) → delete all sessions for that user and `redirect('/login')`.
4. If `force_password_change = TRUE` → `redirect('/set-password')`. (Exception: guard is not called on `/set-password` itself.)
5. Call `resolveEffectivePermissions(userId)` to get the map.
6. Call `meetsLevel(map[name], level)`. If true → return the resolved context (user + map) so the page can use it.
7. If false → `redirect('/no-access')`.

`requireAuthenticated()` is a simpler guard (no permission argument) for routes that only need an ACTIVE session — specifically `/no-access` itself. Steps 1–4 only; returns the session user.

The guard **never** returns a `Response` object — it either returns the resolved context or calls `redirect()` / throws. This keeps it usable in RSC page files where `return new Response(...)` is not the pattern. API route handlers that need a 403 response use the resolver directly and call `meetsLevel` themselves; that pattern is specified in the first action unit (um13+), not here.

### Permission-name typed constants

A single `PERMISSIONS` constant in `auth/permission-constants.ts` maps human-readable keys to the seeded `permission_name` string literals. Every page and test imports from this constant; a typo is a compile error (code-standards §8.5):

```ts
PERMISSIONS.USERS = "users";
PERMISSIONS.ROLES = "roles";
PERMISSIONS.SYSTEM_CONFIG = "system_config";
PERMISSIONS.AUDIT_LOG = "audit_log";
```

A parallel `LEVELS` constant covers the three level strings:

```ts
LEVELS.READ = "READ";
LEVELS.EDIT = "EDIT";
LEVELS.DELETE = "DELETE";
```

Both are `as const` and typed via `satisfies`.

### `force-dynamic`

Every page or layout that loads auth-dependent data must opt out of static generation. `export const dynamic = 'force-dynamic'` appears in:

- `app/(admin)/layout.tsx`
- `app/page.tsx` (root redirect)

Individual pages in `(admin)/` inherit the layout's dynamic declaration and do **not** need to repeat it. Pages in later units that open their own data streams should still include it as a local declaration for explicitness and resilience against layout restructuring — that is a convention to document in each later unit's spec. In um06 it is applied only where files are created here.

### `/no-access` page — visual structure

Minimal, full-viewport centered layout with no navigation sidebar. Content:

- App logo / name (top-left or centered, consistent with the login page shell).
- Heading: "No Access"
- Body: "Your account doesn't have access to any modules yet. Contact an administrator."
- Sign out link/button (always visible — the user must be able to leave).
- No links to any administration pages.

No `<nav>` element, no sidebar, no breadcrumb. The page lives inside `app/(admin)/` so it inherits the group layout, but the group layout in this unit is minimal (force-dynamic + HTML shell only; navigation sidebar is added in a later UI unit).

### Root `/` redirect — routing table

The resolver is called with the current user's ID. The ordered list of routes the redirect considers, in canonical sequence:

| Check (in order)       | Redirects to                    |
| ---------------------- | ------------------------------- |
| `users` : READ         | `/administration/users`         |
| `roles` : READ         | `/administration/roles`         |
| `system_config` : READ | `/administration/system-config` |
| `audit_log` : READ     | `/administration/audit-log`     |
| (none)                 | `/no-access`                    |

The first match wins. In v1 ADMIN always matches on `users` : READ and lands on `/administration/users`. MANAGER/USER have no grants and land on `/no-access`.

This ordering is defined as a typed constant array in `app/page.tsx` (not in `auth/`) — it is routing policy, not permission logic.

### Client permission map

Pages that need to conditionally render controls (show/hide buttons based on the user's level) receive the `EffectivePermissionMap` as a Server Component prop and pass it to leaf client components. The shape is `Record<PermissionName, PermissionType | null>` — the same type returned by the resolver, already serializable as plain JSON. No additional transformation is needed.

A helper `hasLevel(map: EffectivePermissionMap, name: PermissionName, level: PermissionType): boolean` is exported from `types/permissions.ts` for use in client components. It is the only place the level comparison is allowed client-side. Client components must never use the map to gate a mutation — only to show/hide a control.

---

## Implementation

### 6.1 — Permission-name constants (`auth/permission-constants.ts`)

New file. No runtime dependencies — pure constants.

```ts
// Typed constants for permission names and levels.
// All pages and guards import from here; a typo is a compile error.

import type { PermissionName, PermissionType } from "@/types/permissions";

export const PERMISSIONS = {
  USERS: "users",
  ROLES: "roles",
  SYSTEM_CONFIG: "system_config",
  AUDIT_LOG: "audit_log",
} as const satisfies Record<string, PermissionName>;

export const LEVELS = {
  READ: "READ",
  EDIT: "EDIT",
  DELETE: "DELETE",
} as const satisfies Record<string, PermissionType>;
```

Export `PERMISSIONS` and `LEVELS` as named exports. Do not export a default.

`auth/index.ts` (the Better-Auth config file) must not re-export from this file — keep it importable independently so tests and later units can import it without pulling in the full Better-Auth config tree.

### 6.2 — Permission types (`types/permissions.ts`)

New file. Extends the constants already in `types/rbac.ts` with the resolver output shape and the client helper.

**Exports:**

`EffectivePermissionMap`

```ts
// Record<PermissionName, PermissionType | null>
// null = no access for that permission.
// Every known PermissionName is always present as a key.
```

`LEVEL_RANK: Record<PermissionType, number>`

```ts
{ READ: 1, EDIT: 2, DELETE: 3 }
```

`meetsLevel(effective: PermissionType | null, required: PermissionType): boolean`
Server-side and client-safe pure function. Returns `true` iff `LEVEL_RANK[effective] >= LEVEL_RANK[required]`. Returns `false` if `effective` is `null`. This is the **only** place the numeric rank comparison is implemented.

`hasLevel(map: EffectivePermissionMap, name: PermissionName, level: PermissionType): boolean`
Convenience wrapper over `meetsLevel(map[name], level)`. For use in client components.

No imports from `auth/`, `db/`, `services/`, or `next/*`. This file is a leaf module.

### 6.3 — Repository implementations

Replace the stubs from um05 with typed query functions. These are the **only** two RBAC repository functions needed by the resolver; all others remain stubs for later units.

#### 6.3.1 — `roleAssignRepository.findRoleIdsByUserId` (`db/repositories/role-assign.repository.ts`)

Signature:

```ts
findRoleIdsByUserId(userId: string): Promise<string[]>
```

Implementation: `SELECT ref_role_id FROM core.role_assign WHERE ref_user_id = $userId`.

Returns an array of role UUIDs (may be empty). No join needed — the resolver handles the second query separately.

#### 6.3.2 — `rolePermissionAssignRepository.findGrantsByRoleIds` (`db/repositories/role-permission-assign.repository.ts`)

Signature:

```ts
findGrantsByRoleIds(
  roleIds: string[]
): Promise<Array<{ permissionName: PermissionName; permissionType: PermissionType }>>
```

Implementation: If `roleIds` is empty, return `[]` immediately (no query). Otherwise:

```sql
SELECT p.permission_name, rpa.permission_type
FROM core.role_permission_assign rpa
JOIN core.permissions p ON p.permission_id = rpa.ref_permission_id
WHERE rpa.ref_role_id = ANY($roleIds)
```

Use Drizzle's `inArray` operator (not raw SQL). Map the result rows to `{ permissionName, permissionType }` using the Drizzle column accessors. The returned `permissionName` values must be narrowed to `PermissionName` — assert with a type guard that checks `PERMISSION_NAMES.includes(v)` before casting; throw an `AppError` with code `INTERNAL_ERROR` if an unrecognised name is encountered (a migration bug, not a user error).

Both implementations follow the repository boundary rules: import only `@/db/client` and `@/db/schema`; no business logic; no audit writes.

### 6.4 — Effective-permission resolver (`auth/resolver.ts`)

New file. Lives in `auth/` per architecture §2. This is Invariant #5's single resolver.

**Exported function:**

```ts
export async function resolveEffectivePermissions(
  userId: string,
): Promise<EffectivePermissionMap>;
```

**Algorithm:**

1. Call `roleAssignRepository.findRoleIdsByUserId(userId)` → `roleIds: string[]`.
2. If `roleIds` is empty, return a map with every `PermissionName` set to `null` (fast path — MANAGER/USER in v1).
3. Call `rolePermissionAssignRepository.findGrantsByRoleIds(roleIds)` → `grants`.
4. Build the map: iterate over `PERMISSION_NAMES`. For each name, filter `grants` by `permissionName === name`, extract the `permissionType` values, find the one with the highest `LEVEL_RANK`. If no grants for this name, value is `null`.
5. Return the fully-populated `Record<PermissionName, PermissionType | null>`.

The resolver is a **pure query + computation** function. It does not write to the DB, does not write to `AUDIT_LOG`, and does not throw redirect errors. It may throw `AppError` only for repository-level failures (propagate up).

**Never cache the result.** No memoization, no module-level cache, no React cache API wrapping the resolver. Every call hits the DB (Invariant #20).

Do not import from `next/headers`, `next/navigation`, or any `app/**` module. The resolver is framework-agnostic so it can be called from both page guards and future action/handler guards without coupling.

### 6.5 — Guard functions (`auth/guard.ts`)

New file. Imports `auth` from `@/auth` (the Better-Auth config), `headers` from `next/headers`, `redirect` from `next/navigation`, and the resolver and repository functions. This file **is** Next.js-coupled (it uses `redirect()` and `headers()`) — that is acceptable because it is the boundary adapter for page/layout use.

**`requireAuthenticated()`**

```ts
export async function requireAuthenticated(): Promise<{
  userId: string;
  userEmail: string;
}>;
```

Steps:

1. `const session = await auth.api.getSession({ headers: await headers() })`.
2. If `!session` → `redirect('/login')`.
3. Load the APPUSER row by `session.user.id` via `appUserRepository.findById`. If not found or `status !== 'ACTIVE'` → delete all sessions for that `userId` via `sessionRepository.deleteByUserId`, then `redirect('/login')`.
4. If `force_password_change === true` → `redirect('/set-password')`.
5. Return `{ userId: user.user_id, userEmail: user.user_email }`.

Used only by the `/no-access` page. All other pages use `requirePermission`.

**`requirePermission(name, level)`**

```ts
export async function requirePermission(
  name: PermissionName,
  level: PermissionType,
): Promise<{
  userId: string;
  userEmail: string;
  permissionMap: EffectivePermissionMap;
}>;
```

Steps 1–4 are identical to `requireAuthenticated()`.

5. Call `resolveEffectivePermissions(userId)` → `permissionMap`.
6. If `meetsLevel(permissionMap[name], level)` → return `{ userId, userEmail, permissionMap }`.
7. Else → `redirect('/no-access')`.

The returned `permissionMap` is the full `EffectivePermissionMap` ready to be passed as a prop to client components for show/hide decisions. The page must not re-fetch it.

**Repository calls inside the guard** use `appUserRepository.findById` and `sessionRepository.deleteByUserId`. Both were stubbed in um02/um03; their implementations are available from those units. If either repository method is still a stub (no-op), the guard will fail safe — a user with a stale stub result will still fail the `status !== 'ACTIVE'` check on a fresh DB read. Confirm the appUserRepository and sessionRepository functions called here are implemented (not stubs) before this unit ships.

### 6.6 — `(admin)` group layout (`app/(admin)/layout.tsx`)

New file. This is the shared layout wrapping all pages under `app/(admin)/`, including `/no-access` and all future administration pages.

```ts
export const dynamic = "force-dynamic";
```

In um06 the layout body is minimal: render `{children}` inside an HTML shell (a single `<div>` wrapper with the app's base background). **No navigation sidebar, no header, no breadcrumb** — those are added in a later UI unit when the first administration page ships. The navigation must not be added here speculatively.

No auth check in this layout — each child page handles its own guard. The layout does not call `requirePermission` or `requireAuthenticated`.

Provide `metadata` export:

```ts
export const metadata = { title: "Administration — Enterprise Billing" };
```

Provide `loading.tsx` in `app/(admin)/` returning a minimal spinner/skeleton (required by code-standards §3.11).

Provide `error.tsx` in `app/(admin)/` calling the `lib/` telemetry helper and showing a non-leaking error message (required by code-standards §3.11). Do not expose stack traces or internal error codes to the rendered page.

### 6.7 — `/no-access` page (`app/(admin)/no-access/page.tsx`)

Permission: authenticated only (any ACTIVE session). Calls `requireAuthenticated()` at the top.

```ts
export const metadata = { title: "No Access — Enterprise Billing" };
```

`dynamic` is inherited from `(admin)/layout.tsx`.

**Rendered content (Server Component):**

Full-viewport centered layout with no sidebar or navigation links. Exact markup is the implementer's choice within these constraints:

- Displays the application name or logo (same treatment as the `/login` page for visual consistency).
- Heading: "No Access" (`<h1>`).
- Body text: "Your account doesn't have access to any modules yet. Contact an administrator." (`<p>`).
- A "Sign out" button or link that calls the Better-Auth sign-out action and redirects to `/login`. This must be a Client Component form or button since it triggers a mutation — extract it as `components/sign-out-button.tsx` with `'use client'`.
- No links to `/administration/*` or any other restricted route.
- No navigation element (`<nav>`).

The page must be keyboard-accessible: the sign-out control is focusable, has a visible focus ring, and has a clear label.

### 6.8 — Root redirect (`app/page.tsx`)

```ts
export const dynamic = "force-dynamic";
```

This page is a Server Component that performs the redirect and renders nothing. It must not import layout components or render any UI.

**Algorithm:**

1. Retrieve the session via `auth.api.getSession({ headers: await headers() })`.
2. If no session → `redirect('/login')`.
3. Check `force_password_change` on the user row → if true, `redirect('/set-password')`.
4. Call `resolveEffectivePermissions(userId)` → `permissionMap`.
5. Iterate the ordered routing table (defined as a local `const` array in this file):
   ```ts
   const ROUTE_ORDER: Array<{ name: PermissionName; route: string }> = [
     { name: PERMISSIONS.USERS, route: "/administration/users" },
     { name: PERMISSIONS.ROLES, route: "/administration/roles" },
     {
       name: PERMISSIONS.SYSTEM_CONFIG,
       route: "/administration/system-config",
     },
     { name: PERMISSIONS.AUDIT_LOG, route: "/administration/audit-log" },
   ];
   ```
6. `redirect()` to the first route where `meetsLevel(permissionMap[name], 'READ')` is true, or `redirect('/no-access')` if none.

The routing table is routing policy, not permission logic. It lives here, not in `auth/`. When a new module adds a page, it appends a row to this table and provides its `PERMISSIONS` migration — no changes to `auth/`.

Do **not** call `requirePermission` or `requireAuthenticated` from the root page — those functions redirect unauthenticated users to `/login` internally, but the root page needs to redirect to `/login` before checking permissions anyway, and reusing the guard would create a redirect loop risk when `force_password_change` is true. Call `auth.api.getSession` and `resolveEffectivePermissions` directly.

### 6.9 — `force-dynamic` placement summary

| File                     | Declaration                              | Reason                                                                                |
| ------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `app/page.tsx`           | `export const dynamic = 'force-dynamic'` | Reads session cookie; must not be statically cached                                   |
| `app/(admin)/layout.tsx` | `export const dynamic = 'force-dynamic'` | All child pages are auth-dependent; prevents accidental static rendering of the shell |

Pages in `app/(admin)/` created in later units inherit the layout's declaration. Each later unit's spec should still include an explicit `dynamic` declaration in its own `page.tsx` for resilience.

### 6.10 — Route × level matrix tests (`tests/`)

#### Test infrastructure

Use **Vitest** (already configured from um01/um02). Tests that interact with the DB use a test-database connection (the same pattern as prior units — a `.env.test` pointing at a test Postgres instance with migrations + seeds applied). Tests that test the resolver and guard in isolation mock the repository layer.

#### Unit tests: resolver (`tests/unit/auth/resolver.test.ts`)

Test `resolveEffectivePermissions` in isolation by mocking `roleAssignRepository` and `rolePermissionAssignRepository`. Do not hit the DB. Cover:

| Scenario                                     | Input                                        | Expected output                                                                    |
| -------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| No roles assigned                            | `roleIds = []`                               | All four permissions `null`                                                        |
| Single role with one grant                   | ADMIN role with `users:DELETE`               | `{ users: 'DELETE', roles: null, system_config: null, audit_log: null }`           |
| Full ADMIN seed                              | ADMIN with all four grants                   | `{ users: 'DELETE', roles: 'DELETE', system_config: 'DELETE', audit_log: 'READ' }` |
| Two roles with overlapping grants            | Role A: `users:READ`, Role B: `users:EDIT`   | `{ users: 'EDIT', … }` — highest wins                                              |
| Two roles, DELETE vs READ on same permission | Role A: `users:DELETE`, Role B: `users:READ` | `{ users: 'DELETE', … }` — DELETE wins                                             |
| Role with no permission_assign rows          | Any role, no grants                          | All four `null`                                                                    |

#### Unit tests: level comparison (`tests/unit/types/permissions.test.ts`)

Test `meetsLevel` exhaustively:

| effective  | required   | expected |
| ---------- | ---------- | -------- |
| `null`     | any        | `false`  |
| `'READ'`   | `'READ'`   | `true`   |
| `'READ'`   | `'EDIT'`   | `false`  |
| `'READ'`   | `'DELETE'` | `false`  |
| `'EDIT'`   | `'READ'`   | `true`   |
| `'EDIT'`   | `'EDIT'`   | `true`   |
| `'EDIT'`   | `'DELETE'` | `false`  |
| `'DELETE'` | `'READ'`   | `true`   |
| `'DELETE'` | `'EDIT'`   | `true`   |
| `'DELETE'` | `'DELETE'` | `true`   |

#### Integration tests: guard (`tests/integration/auth/guard.test.ts`)

These tests call `requirePermission` and `requireAuthenticated` with a live test DB (seeded via `db:setup`). They intercept `redirect()` by catching the redirect error thrown by `next/navigation`'s `redirect()`. Better-Auth's `getSession` is mocked to return a controlled session object; the APPUSER and session rows are live in the test DB.

Create three test users in the test DB before the suite:

- **admin_user**: ACTIVE, assigned ADMIN role (via `role_assign`).
- **no_grants_user**: ACTIVE, no role assignments.
- **pending_user**: PENDING, no role assignments.
- **disabled_user**: DISABLED, no role assignments.

**`requirePermission` test matrix:**

For each `(name, level)` pair in the v1 permission matrix, assert against each user:

| User           | Permission : Level     | Expected                                                            |
| -------------- | ---------------------- | ------------------------------------------------------------------- |
| admin_user     | `users:READ`           | Returns context (no redirect)                                       |
| admin_user     | `users:EDIT`           | Returns context                                                     |
| admin_user     | `users:DELETE`         | Returns context                                                     |
| admin_user     | `roles:READ`           | Returns context                                                     |
| admin_user     | `roles:EDIT`           | Returns context                                                     |
| admin_user     | `roles:DELETE`         | Returns context                                                     |
| admin_user     | `system_config:READ`   | Returns context                                                     |
| admin_user     | `system_config:EDIT`   | Returns context                                                     |
| admin_user     | `system_config:DELETE` | Returns context                                                     |
| admin_user     | `audit_log:READ`       | Returns context                                                     |
| no_grants_user | `users:READ`           | `redirect('/no-access')`                                            |
| no_grants_user | `roles:READ`           | `redirect('/no-access')`                                            |
| no_grants_user | `system_config:READ`   | `redirect('/no-access')`                                            |
| no_grants_user | `audit_log:READ`       | `redirect('/no-access')`                                            |
| pending_user   | `users:READ`           | `redirect('/login')` (non-ACTIVE → session deleted, redirect login) |
| disabled_user  | `users:READ`           | `redirect('/login')`                                                |
| (no session)   | any                    | `redirect('/login')`                                                |

**`requireAuthenticated` test matrix:**

| User           | Expected                        |
| -------------- | ------------------------------- |
| admin_user     | Returns `{ userId, userEmail }` |
| no_grants_user | Returns `{ userId, userEmail }` |
| pending_user   | `redirect('/login')`            |
| (no session)   | `redirect('/login')`            |

**`force_password_change` test:**

| User                                            | Expected                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| active user with `force_password_change = true` | `redirect('/set-password')` for `requirePermission` and `requireAuthenticated` |

#### Integration tests: root redirect (`tests/integration/app/root-redirect.test.ts`)

Call the root page logic (extract into a testable helper, see §6.8 note below) with mocked sessions:

| Session                                     | Expected redirect       |
| ------------------------------------------- | ----------------------- |
| admin_user                                  | `/administration/users` |
| no_grants_user                              | `/no-access`            |
| (no session)                                | `/login`                |
| active user, `force_password_change = true` | `/set-password`         |

**Note on testability of `app/page.tsx`:** The redirect logic should be extracted into a standalone async function `resolveRootRedirect(session, permissionMap)` in `lib/root-redirect.ts` (or similar) that accepts its inputs and returns a route string. `app/page.tsx` calls this function then calls `redirect()`. Tests import and call `resolveRootRedirect` directly without needing a running Next.js server.

#### Scope of the matrix in um06

The route×level matrix in this unit covers the **resolver and guard logic** only. HTTP-level end-to-end tests (hitting actual running routes) are added in each page unit as those pages are built. The matrix tests here establish the authorization contract; later unit tests verify the wiring.

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `better-auth` — session resolution (`auth.api.getSession`).
- `drizzle-orm` — repository queries (`inArray`, `eq`).
- `next` — `redirect()`, `headers()`.
- `vitest` — test runner.

---

## Verification Checklist

### Constants and types

- [ ] `auth/permission-constants.ts` exports `PERMISSIONS` and `LEVELS` as `as const` objects typed via `satisfies`
- [ ] `PERMISSIONS.USERS === 'users'`, `PERMISSIONS.ROLES === 'roles'`, `PERMISSIONS.SYSTEM_CONFIG === 'system_config'`, `PERMISSIONS.AUDIT_LOG === 'audit_log'`
- [ ] `LEVELS.READ === 'READ'`, `LEVELS.EDIT === 'EDIT'`, `LEVELS.DELETE === 'DELETE'`
- [ ] `types/permissions.ts` exports `EffectivePermissionMap`, `LEVEL_RANK`, `meetsLevel`, `hasLevel`
- [ ] `meetsLevel(null, 'READ')` returns `false`; `meetsLevel('DELETE', 'READ')` returns `true`; `meetsLevel('READ', 'EDIT')` returns `false`
- [ ] `tsc --noEmit` clean across all new files

### Repository implementations

- [ ] `roleAssignRepository.findRoleIdsByUserId(userId)` is implemented (not a stub); returns `[]` for a user with no assignments
- [ ] `rolePermissionAssignRepository.findGrantsByRoleIds([])` returns `[]` without querying the DB
- [ ] `rolePermissionAssignRepository.findGrantsByRoleIds(adminRoleIds)` returns all four ADMIN grants from the seeded DB
- [ ] Neither repository function imports anything from `auth/`, `services/`, `app/`, or `actions/`

### Resolver

- [ ] `resolveEffectivePermissions(adminUserId)` against the seeded test DB returns `{ users: 'DELETE', roles: 'DELETE', system_config: 'DELETE', audit_log: 'READ' }`
- [ ] `resolveEffectivePermissions(noGrantsUserId)` returns `{ users: null, roles: null, system_config: null, audit_log: null }`
- [ ] When a user holds two roles that both grant the same permission at different levels, the higher level wins (tested via unit test with mocked repos)
- [ ] Resolver does not cache results between calls — calling it twice with the same `userId` makes two DB round-trips (verified by asserting query mock call count in unit tests)
- [ ] `auth/resolver.ts` has no import from `next/headers`, `next/navigation`, or any `app/**` module

### Guard functions

- [ ] `requirePermission('users', 'READ')` called with an ADMIN session returns `{ userId, userEmail, permissionMap }` without throwing
- [ ] `requirePermission('users', 'READ')` called with a no-grants session throws a redirect to `/no-access`
- [ ] `requirePermission('users', 'EDIT')` called with an ADMIN session returns successfully (DELETE ⊃ EDIT)
- [ ] `requirePermission('audit_log', 'EDIT')` called with an ADMIN session throws a redirect to `/no-access` (ADMIN only has READ on `audit_log`)
- [ ] `requirePermission` called with no session throws a redirect to `/login`
- [ ] `requirePermission` called with a PENDING or DISABLED user throws a redirect to `/login` and deletes that user's sessions
- [ ] `requirePermission` or `requireAuthenticated` called with `force_password_change = true` throws a redirect to `/set-password`
- [ ] `requireAuthenticated` called with a no-grants ACTIVE user returns `{ userId, userEmail }` successfully (no permission check)

### `/no-access` page

- [ ] `app/(admin)/no-access/page.tsx` exists and renders without error for an ACTIVE session with no grants
- [ ] The page contains a heading "No Access" and the prescribed body text
- [ ] The page contains a sign-out control (`SignOutButton` client component)
- [ ] The page contains no `<nav>` element and no links to `/administration/*`
- [ ] The page is keyboard-accessible (sign-out button is focusable with a visible focus ring)
- [ ] `app/(admin)/no-access/page.tsx` calls `requireAuthenticated()` at the top
- [ ] A DISABLED user attempting to access `/no-access` is redirected to `/login` (via `requireAuthenticated`)

### Root redirect

- [ ] `app/page.tsx` has `export const dynamic = 'force-dynamic'`
- [ ] An unauthenticated request to `/` redirects to `/login`
- [ ] The seeded ADMIN user is redirected to `/administration/users`
- [ ] An ACTIVE user with no grants is redirected to `/no-access`
- [ ] An ACTIVE user with `force_password_change = true` is redirected to `/set-password`
- [ ] The routing table in `app/page.tsx` uses `PERMISSIONS.*` constants, not raw strings
- [ ] `resolveRootRedirect` (or equivalent extracted helper) is covered by unit tests with all four redirect scenarios

### `(admin)` layout

- [ ] `app/(admin)/layout.tsx` exports `export const dynamic = 'force-dynamic'`
- [ ] `app/(admin)/layout.tsx` renders `{children}` without adding navigation, sidebar, or auth checks
- [ ] `app/(admin)/loading.tsx` exists and renders a spinner or skeleton
- [ ] `app/(admin)/error.tsx` exists, calls the `lib/` telemetry helper, and renders a non-leaking error message

### Test suite

- [ ] `vitest run` passes all unit tests in `tests/unit/auth/resolver.test.ts` and `tests/unit/types/permissions.test.ts`
- [ ] All 9 `meetsLevel` combinations are covered (see §6.10 table)
- [ ] All resolver unit test scenarios are covered (see §6.10 table)
- [ ] All `requirePermission` guard integration test rows pass (see §6.10 matrix table)
- [ ] All `requireAuthenticated` test rows pass
- [ ] `force_password_change` redirect is tested for both guards
- [ ] Root-redirect integration tests cover all four scenarios

### Boundary enforcement

- [ ] `auth/resolver.ts` has no import from `next/*` or `app/**`
- [ ] `types/permissions.ts` has no import from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `auth/permission-constants.ts` has no import from `next/*`, `db/**`, or `services/**`
- [ ] `app/page.tsx` does not import `requirePermission` or `requireAuthenticated` — it calls `auth.api.getSession` and `resolveEffectivePermissions` directly
- [ ] No file outside `db/**` imports `roleAssignRepository` or `rolePermissionAssignRepository` from their table objects directly — only from the repository module
- [ ] No `console.*` in any new file; all diagnostics via `lib/logger`

### Scope guard

- [ ] No Server Actions were added (um13+)
- [ ] No administration pages were added (um13, um14, um16, etc.)
- [ ] The `PERMISSIONS` migration was not modified — `auth/permission-constants.ts` references existing seeded names only
- [ ] The `auth/` Better-Auth config (`auth/index.ts`) was not modified in this unit
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
