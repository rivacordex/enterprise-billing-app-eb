# Spec: um18 — Roles list/detail (READ)

- **Boundary:** APP
- **Dependencies:** Unit um06 (authorization enforcement core — `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `EffectivePermissionMap`, `hasLevel`, `(admin)` layout with nav sidebar, `/no-access`, root redirect); Unit um05 (RBAC schema seeded — `core.roles`, `core.permissions`, `core.role_permission_assign`; `types/rbac.ts` constants `PERMISSION_NAMES`/`PermissionName`/`PermissionType`; repository stubs for all four RBAC tables).
- **Source sections:** overview §"Roles & permissions", §"Pages — Administration" item 2, §"Roles & Default Permission Seed" (permission matrix); architecture §2 (folder ownership, boundary rules), §5 (RBAC mechanics — one level per role+permission pair, DELETE ⊃ EDIT ⊃ READ), §6 (`roles:READ` required); code-standards §3.3 (page guard pattern), §3.6 (page guard), §3.8 (force-dynamic), §4 (styling — CSS variables, `cva`, no raw hex), §7 (file organization); ui-context §3.6 (role badge tokens, `PermissionLevelTag` tokens — READ/EDIT/DELETE ramp), §5 (typography, `--text-overline` for table headers), §6 (radius — `--radius-pill` for tags). Invariants: **#2** (no authz state in session), **#3** (always server-side), **#4** (deny by default), **#7** (permission registry migration-only — no code creates `PERMISSIONS` rows), **#14** (DB access only in `db/**`), **#20** (never cache authz decisions), **#22** (seeded roles permanent).

---

## Goal

Build the read-only `/administration/roles` page — guarded at `roles:READ`, rendering a `RoleTable` (role name, description, permission assignments as `PermissionLevelTag` chips) and a `RoleDetail` panel showing the full permission matrix for the selected role, URL-driven via `?roleId=<role_id>`, so that the seeded ADMIN can navigate to the Roles page and see all three seeded roles with their complete permission mappings.

---

## Design

### Page layout

Mirrors the master-detail layout from um07 (Users page):

- **Left — `RoleTable`** (~60% width): card on `--surface-card`, `--shadow-sm`, `--radius-md`. Shows all roles with their assigned permission levels.
- **Right — `RoleDetail`** (~40% width): panel that slides in when a row is selected; empty-state placeholder ("Select a role to view details" in `--text-muted`) when no row is selected.
- Row selection is **URL-driven**: clicking a row pushes `?roleId=<role_id>` to the browser URL (deep-linkable, browser-back-navigable).
- On narrow viewports, the detail panel stacks below the table.
- The admin nav sidebar from um07 is already in place; this page is reached via the "Roles" nav link. No changes to the sidebar in this unit.

### RoleTable

- **Table header area**: "Roles" heading (`--text-h3`, `--text-primary`) + live row count in `--text-muted` on the left; a stub "Add Role" button (`disabled`, `--action-primary-bg`, tooltip "Feature coming soon") on the right, visible only when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)`. The stub button exists because later units (um19) add the create flow.
- **Columns** (in order):

  | #   | Column      | Data                       | Notes                                                                                                   |
  | --- | ----------- | -------------------------- | ------------------------------------------------------------------------------------------------------- |
  | 1   | Role        | `roleName`                 | `--text-body`, medium weight; clicking row selects                                                      |
  | 2   | Description | `roleDescr`                | `--text-body`, `--text-muted`; "—" if null                                                              |
  | 3   | Permissions | `PermissionLevelTag` chips | One chip per assignment (permission name + level). "No permissions" in `--text-muted` if no assignments |
  | 4   | Created     | `createdDatetime`          | Formatted date, `--font-mono`, `--text-muted`                                                           |

- **Table header row**: `--text-overline` style (11px, semibold, uppercase, letter-spaced), `--color-neutral-800`, `--border-subtle` bottom border. No sort in v1 — the roles list is short and stable.
- **Row hover**: `--action-ghost-hover` (`neutral-100`) background.
- **Selected row**: `--surface-selected` (`primary-50`) background; `3px solid var(--color-primary-500)` left border.
- **Empty state**: centered "No roles found." in `--text-muted`. Should not occur with the seeded data, but must be handled.
- No pagination — three seeded roles in v1.

### Permissions column chip format

Each role's Permissions cell renders a set of inline chips, one per `role_permission_assign` row for that role. Each chip shows the **permission display name** (see display name map below) followed by a **`PermissionLevelTag`** for the level. Chips wrap if they exceed the column width.

Permission display names (code constant, not DB-queried):

| `permission_name` | Display label   |
| ----------------- | --------------- |
| `'users'`         | `Users`         |
| `'roles'`         | `Roles`         |
| `'system_config'` | `System Config` |
| `'audit_log'`     | `Audit Log`     |

Example for ADMIN: `Users DELETE` · `Roles DELETE` · `System Config DELETE` · `Audit Log READ`

Chips use inline-flex, `--radius-xs` (2px), `--text-caption` (12px), `--surface-sunken` background, `--text-body` color, `gap-1` between permission name and level tag, `gap-2` between chips. The `PermissionLevelTag` within the chip provides the color; the permission name is plain muted text (`--text-muted`).

### RoleDetail panel

- `--surface-card` background, `--shadow-md` on the left edge.
- **Panel header**: role name as `<h3>` (`--text-h3`, `--text-primary`); a `RoleBadge` for the role (using the tokens from ui-context §3.6: ADMIN → `primary-50`/`primary-700`, MANAGER → `cyan-50`/`cyan-700`, USER → `neutral-100`/`neutral-700`, unknown → neutral fallback); close (×, `lucide-react X`, ghost style) top-right, navigates to `/administration/roles` (clears `?roleId`).
- **No action buttons** in this unit (edit/delete/create come in later units).
- **Field groups** — read-only, `<dl>`/`<dt>`/`<dd>` accessible markup:

  | Group       | Fields                                                                                  |
  | ----------- | --------------------------------------------------------------------------------------- |
  | Role info   | Name, Description ("—" if null), Created (`--font-mono`), Last Modified (`--font-mono`) |
  | Permissions | Permission matrix (see below)                                                           |

- `<dt>` labels: `--text-overline`, `--text-muted`. `<dd>` values: `--text-body`, `--text-primary`.

### Permission matrix in RoleDetail

The Permissions group shows a matrix table with all four permissions as rows. The matrix is the read-only view of what level is stored in `role_permission_assign` for this role. MANAGER and USER will show all "—" rows since they have no assignments in v1.

| Permission    | Level                                   |
| ------------- | --------------------------------------- |
| Users         | `[PermissionLevelTag: DELETE]` — or `—` |
| Roles         | `[PermissionLevelTag: DELETE]` — or `—` |
| System Config | `[PermissionLevelTag: DELETE]` — or `—` |
| Audit Log     | `[PermissionLevelTag: READ]` — or `—`   |

Row order: Users, Roles, System Config, Audit Log (matches the order in `PERMISSION_NAMES`).

`—` is rendered in `--text-muted` and `--text-body` size.

Note: the `audit_log` permission is READ-max in the system (no EDIT or DELETE exists). The read display simply shows the assigned level (READ for ADMIN, "—" for others). The disabled-cell treatment from ui-context (§3.6) applies to the _write_ editor, not this read view.

"User not found" / "Role not found" state: rendered when `?roleId` is present but `getRoleById` returned `null` — centered "Role not found." with a "Back to roles" `<Link>` that clears the param.

### PermissionLevelTag

A shared leaf component in `components/roles/permission-level-tag.tsx`. Renders a styled pill for one of `'READ' | 'EDIT' | 'DELETE'`. Uses `cva` with a `level` variant key. Token mapping from ui-context §3.6:

| Level    | `bg` tint              | `text` (`-fg`)          | Conveys     |
| -------- | ---------------------- | ----------------------- | ----------- |
| `READ`   | `info-50` `#E7F1FD`    | `info-700` `#0C4084`    | View only   |
| `EDIT`   | `warning-50` `#FEF4E6` | `warning-700` `#8A5200` | Mutate      |
| `DELETE` | `danger-50` `#FDEAEA`  | `danger-700` `#8A1717`  | Destructive |

Shape: `--radius-xs` (2px), `--text-overline` (11px, semibold, uppercase), `px-1.5 py-0.5`, `inline-flex`. No icon — label alone is sufficient at this size. Meaning never relies on color alone because the label (READ / EDIT / DELETE) is always shown.

---

## Implementation

### 18.1 — Shared types (`types/roles.ts`)

New file. No imports from `db/**`, `auth/**`, `next/*`. Leaf module.

Re-export `Role` and `RoleInsert` from Drizzle's `$inferSelect`/`$inferInsert` on the `roles` table (via `types/rbac.ts`, which already re-exports them from um05).

Define:

```ts
import type { PermissionName, PermissionType, Role } from "@/types/rbac";

export type RolePermissionMapping = {
  permissionName: PermissionName;
  assignedLevel: PermissionType | null; // null = no assignment for this role
};

export type RoleWithMappings = Role & {
  mappings: RolePermissionMapping[]; // length === PERMISSION_NAMES.length, one entry per known permission
};
```

`RoleWithMappings.mappings` always contains one entry for each name in `PERMISSION_NAMES` (ordered: `'users'`, `'roles'`, `'system_config'`, `'audit_log'`), with `assignedLevel: null` for unassigned permissions. The service is responsible for building this full array.

Export `PERMISSION_DISPLAY_NAMES` as a `Record<PermissionName, string>` constant:

```ts
export const PERMISSION_DISPLAY_NAMES: Record<PermissionName, string> = {
  users: "Users",
  roles: "Roles",
  system_config: "System Config",
  audit_log: "Audit Log",
} as const;
```

This is the only place the display label map is defined. Components import it; no raw string mapping elsewhere.

### 18.2 — Repository implementations

#### 18.2.1 — `rolesRepository` (`db/repositories/roles.repository.ts`)

Implements the stub file from um05. Two functions, both read-only:

**`findAll(): Promise<Role[]>`**

```sql
SELECT * FROM core.roles ORDER BY role_name ASC
```

Returns all role rows (no pagination — small, stable set).

**`findById(roleId: string): Promise<Role | null>`**

```sql
SELECT * FROM core.roles WHERE role_id = $roleId
```

Returns the row or `null` if not found.

Neither function writes to the DB, writes to `AUDIT_LOG`, or performs permission checks. No imports from `auth/`, `services/`, or `next/*`.

#### 18.2.2 — `rolePermissionAssignRepository` (`db/repositories/role-permission-assign.repository.ts`)

This file already has `findGrantsByRoleIds` implemented in um06 (returns `{ permissionName, permissionType }` for the resolver). Add one new function:

**`findMappingsForRole(roleId: string): Promise<Array<{ permissionName: PermissionName; permissionType: PermissionType }>>`**

```sql
SELECT p.permission_name, rpa.permission_type
FROM core.role_permission_assign rpa
JOIN core.permissions p ON p.permission_id = rpa.ref_permission_id
WHERE rpa.ref_role_id = $roleId
```

Use Drizzle's `eq` operator (not raw SQL). Map result rows to `{ permissionName, permissionType }` using the same type-guard narrowing as `findGrantsByRoleIds` from um06 (check `PERMISSION_NAMES.includes(v)` before casting; throw `AppError` with code `INTERNAL_ERROR` for unrecognised names). If no rows, return `[]`.

Do not modify `findGrantsByRoleIds` from um06.

### 18.3 — Read service (`services/roles/roles-read.service.ts`)

New file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

**`getAllRolesWithMappings(): Promise<RoleWithMappings[]>`**

Steps:

1. `const roles = await rolesRepository.findAll()` — all roles ordered by name.
2. For each role: `const assignments = await rolePermissionAssignRepository.findMappingsForRole(role.roleId)`.
3. Build `mappings` by iterating over `PERMISSION_NAMES` in order: for each name, find the entry in `assignments` where `permissionName === name`; if found use `permissionType`, else `null`.
4. Return `roles.map(role => ({ ...role, mappings }))`.

**`getRoleWithMappings(roleId: string): Promise<RoleWithMappings | null>`**

Steps:

1. `const role = await rolesRepository.findById(roleId)`. If `null`, return `null`.
2. `const assignments = await rolePermissionAssignRepository.findMappingsForRole(roleId)`.
3. Build `mappings` by the same iteration over `PERMISSION_NAMES` as above.
4. Return `{ ...role, mappings }`.

No audit writes, no side effects. Both functions may throw `AppError` only for repository-level failures; propagate up to the page/action boundary.

### 18.4 — Page (`app/(admin)/administration/roles/page.tsx`)

Server Component. Required exports:

```ts
export const dynamic = "force-dynamic";
export const metadata = { title: "Roles — Enterprise Billing" };
```

**Algorithm:**

1. `const { permissionMap } = await requirePermission(PERMISSIONS.ROLES, LEVELS.READ)` — unauthenticated → `/login`; insufficient level → `/no-access`.
2. `const roles = await getAllRolesWithMappings()`.
3. Read `?roleId` from `searchParams`. If present, `const selectedRole = await getRoleWithMappings(roleId)` — else `selectedRole = null`.
4. Render the two-column layout: `<RoleTable>` on the left, `<RoleDetail>` on the right.

Pass to `RoleTable`: `roles`, `selectedRoleId` (string or `null`), `permissionMap`.
Pass to `RoleDetail`: `role` (the `RoleWithMappings` or `null`).

No DB access in this file — delegates entirely to the service. No business rules.

### 18.5 — `loading.tsx` (`app/(admin)/administration/roles/loading.tsx`)

Required by code-standards §3.11. Renders a minimal skeleton matching the two-column layout: a card-shaped `--surface-card` placeholder on the left (table skeleton with 3 shimmer rows) and a narrower placeholder on the right. Use Tailwind `animate-pulse` for shimmer.

### 18.6 — `error.tsx` (`app/(admin)/administration/roles/error.tsx`)

Required by code-standards §3.11. Calls the `lib/` telemetry helper (`GlitchTip`) with the error. Renders a non-leaking message ("Something went wrong loading the Roles page.") with a "Try again" reload button. No stack traces, no internal codes visible in the rendered page.

### 18.7 — `PermissionLevelTag` component (`components/roles/permission-level-tag.tsx`)

Leaf component. No `'use client'` needed — no state, no effects, no browser APIs.

Props:

```ts
interface PermissionLevelTagProps {
  level: PermissionType;
  className?: string;
}
```

Use `cva` to define the `level` variant with the three token sets from §Design above. Render a `<span>` with the level label text (verbatim: `READ`, `EDIT`, `DELETE`). Apply `--radius-xs` via `rounded-xs` (or the matching Tailwind token from the project's config). Use CSS variable references for colors — never raw hex.

Export `PermissionLevelTagProps` and the component as named exports. No default export.

### 18.8 — `RoleTable` component (`components/roles/role-table.tsx`)

Client Component (`'use client'`).

Props:

```ts
interface RoleTableProps {
  roles: RoleWithMappings[];
  selectedRoleId: string | null;
  permissionMap: EffectivePermissionMap;
}
```

**Behavior:**

- Renders an HTML `<table>` inside a `--surface-card` card.
- Header area (above `<table>`): "Roles" heading + row count in `--text-muted`; stub "Add Role" `<button>` on the right (always `disabled` in this unit, visible only when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)`).
- Column headers: Role, Description, Permissions, Created — all `--text-overline` style, non-sortable in this unit.
- Row click: uses `useRouter().push(\`/administration/roles?roleId=\${role.roleId}\`)`to set the selection. Selected row gets`--surface-selected` background and 3px left border.
- The Permissions cell renders the chip list described in §Design: for each `mapping` where `assignedLevel !== null`, a chip showing `PERMISSION_DISPLAY_NAMES[mapping.permissionName]` + `<PermissionLevelTag level={mapping.assignedLevel} />`. If all `assignedLevel` are null, render "No permissions" in `--text-muted`.
- Empty state: centered "No roles found." in `--text-muted` when `roles.length === 0`.
- Dates in the Created column use `--font-mono` and `toLocaleDateString('en-GB')` formatting (consistent with the project date pattern from um07).

No business logic. No DB access. Imports `PermissionLevelTag`, `PERMISSION_DISPLAY_NAMES`, `hasLevel`, `PERMISSIONS`, `LEVELS` — no `db/**` or `services/**`.

### 18.9 — `RoleDetail` component (`components/roles/role-detail.tsx`)

Client Component (`'use client'`). Designed to be extended by later write units (um19/um20).

Props:

```ts
interface RoleDetailProps {
  role: RoleWithMappings | null;
}
```

**Empty state** (when `role === null`): centered `<p>` "Select a role to view details." in `--text-muted`, full panel height centered.

**"Role not found" state** (handled in parent page; the page passes `null` to `RoleDetail` when `?roleId` is present but the DB returned null): same empty state rendering — the page handles detection, not the component.

Actually: the page passes `role = null` when `selectedRole` is null or when `findRoleById` returned null. The panel always renders null as the empty state. The "Role not found" message ("Role not found. [Back to roles]") is rendered when `?roleId` is present but the service returned null — distinguish this by having the page pass a `notFound: boolean` flag, or by comparing `selectedRoleId` with `role`:

```ts
interface RoleDetailProps {
  role: RoleWithMappings | null;
  selectedRoleId: string | null;
}
```

If `selectedRoleId !== null && role === null`: render "Role not found." with a "Back to roles" link (`href="/administration/roles"`).
If `selectedRoleId === null`: render the empty-state placeholder.
If `role !== null`: render the full panel.

**Full panel rendering:**

Panel header:

- `<h3>` with `role.roleName` (`--text-h3`, `--text-primary`)
- `<RoleBadge roleName={role.roleName} />` inline below (using the existing `RoleBadge` component from um07)
- Close (×) button top-right: `onClick` navigates to `/administration/roles` (no `?roleId`). Use `useRouter().push('/administration/roles')`.

Field groups (`<dl>`):

**Role info group:**

- Name: `role.roleName`
- Description: `role.roleDescr ?? '—'` (muted if "—")
- Created: `role.createdDatetime` formatted in `--font-mono`, UTC
- Last Modified: `role.lastModifiedDatetime` formatted in `--font-mono`, UTC

**Permissions group:**

A `<table>` (not `<dl>`) within the group for the matrix:

```
<thead>
  <tr>
    <th>Permission</th>
    <th>Assigned Level</th>
  </tr>
</thead>
<tbody>
  {PERMISSION_NAMES.map(name => (
    <tr key={name}>
      <td>{PERMISSION_DISPLAY_NAMES[name]}</td>
      <td>
        {mapping.assignedLevel
          ? <PermissionLevelTag level={mapping.assignedLevel} />
          : <span className="text-[--text-muted]">—</span>
        }
      </td>
    </tr>
  ))}
</tbody>
```

Iterate `PERMISSION_NAMES` in order (users → roles → system_config → audit_log). Find the matching mapping from `role.mappings` for each name.

Table styling: `--border-subtle` between rows, `--text-overline` for column headers, no outer border (inherits from the field group card). Alternating row background is NOT used — too noisy in a small 4-row matrix.

No action buttons (Edit/Delete) in this unit.

### 18.10 — Tests

#### Unit tests: `PermissionLevelTag` (`tests/unit/components/roles/permission-level-tag.test.tsx`)

New file.

- Renders `READ` label and applies the `info-50`/`info-700` classes.
- Renders `EDIT` label and applies the `warning-50`/`warning-700` classes.
- Renders `DELETE` label and applies the `danger-50`/`danger-700` classes.
- Accepts `className` prop without error.
- TypeScript: passing an invalid level string is a type error (compile-time, not test assertion).

#### Unit tests: types and service (`tests/unit/services/roles-read.service.test.ts`)

New file. Mock `rolesRepository` and `rolePermissionAssignRepository`.

| Scenario                                           | Input                                                                             | Expected                                                                                                                                                |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getAllRolesWithMappings` — three seeded roles     | Repos return 3 roles; ADMIN has 4 assignments, MANAGER/USER have 0                | Returns 3 `RoleWithMappings` objects; ADMIN has 4 entries in `mappings` with correct levels; MANAGER/USER have 4 entries all with `assignedLevel: null` |
| `getAllRolesWithMappings` — `mappings` length      | Any return                                                                        | Each `RoleWithMappings.mappings` has exactly `PERMISSION_NAMES.length` entries                                                                          |
| `getAllRolesWithMappings` — `mappings` order       |                                                                                   | Entries are in `PERMISSION_NAMES` order: users, roles, system_config, audit_log                                                                         |
| `getRoleWithMappings` — role not found             | `findById` returns `null`                                                         | Returns `null`; `findMappingsForRole` not called                                                                                                        |
| `getRoleWithMappings` — found, no assignments      | Role found, assignments `[]`                                                      | Returns `RoleWithMappings` with all 4 `mappings` having `assignedLevel: null`                                                                           |
| `getRoleWithMappings` — found, partial assignments | Role found, assignments `[{ permissionName: 'users', permissionType: 'DELETE' }]` | `mappings` for `users` → `DELETE`; others → `null`                                                                                                      |

#### Unit tests: `RoleTable` (`tests/unit/components/roles/role-table.test.tsx`)

New file. Mock `useRouter`.

- Renders 3 rows when given 3 roles.
- ADMIN row shows 4 chips (one per assignment).
- MANAGER row shows "No permissions" text.
- Clicking a row calls `router.push` with `?roleId=<role_id>`.
- Selected row (matching `selectedRoleId` prop) has the selected-row class applied.
- "Add Role" button is not rendered when `hasLevel(map, PERMISSIONS.ROLES, LEVELS.EDIT)` is false (no-grants user).
- "Add Role" button is rendered but `disabled` when `hasLevel` returns true (ADMIN in this unit).
- Empty state renders "No roles found." when `roles = []`.

#### Unit tests: `RoleDetail` (`tests/unit/components/roles/role-detail.test.tsx`)

New file. Mock `useRouter`.

- Empty-state placeholder renders when `role = null` and `selectedRoleId = null`.
- "Role not found." renders when `role = null` and `selectedRoleId` is non-null.
- "Back to roles" link points to `/administration/roles` (no `?roleId`).
- Full panel renders role name as `<h3>` when `role` is provided.
- All 4 permission rows are rendered in the matrix.
- ADMIN: `users`, `roles`, `system_config` cells show `PermissionLevelTag` with `DELETE`; `audit_log` shows `READ`.
- MANAGER: all 4 cells show "—".
- Description field renders "—" when `role.roleDescr` is null.
- Close button calls `router.push('/administration/roles')` (clears `?roleId`).
- Permissions group renders rows in PERMISSION_NAMES order.

#### Integration tests: roles read service (`tests/integration/services/roles-read.service.test.ts`)

New file. Uses the test DB (seeded via `db:setup` with all three roles and the ADMIN-only matrix).

- `getAllRolesWithMappings()` returns exactly 3 roles.
- ADMIN role's `mappings` contains: `users:DELETE`, `roles:DELETE`, `system_config:DELETE`, `audit_log:READ`.
- MANAGER role's `mappings` contains: all four with `assignedLevel: null`.
- USER role's `mappings` contains: all four with `assignedLevel: null`.
- `getRoleWithMappings(adminRoleId)` returns the ADMIN role with the same mapping as above.
- `getRoleWithMappings('non-existent-uuid')` returns `null`.
- `RoleWithMappings.mappings` order is always: users, roles, system_config, audit_log — regardless of DB row order.

#### Integration tests: page guard (`tests/integration/app/roles-page-guard.test.ts`)

New file. Uses the guard test infrastructure from um06.

| Session                         | Expected                                                                         |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `admin_user` (has `roles:READ`) | `requirePermission(PERMISSIONS.ROLES, LEVELS.READ)` returns context; no redirect |
| `no_grants_user`                | `redirect('/no-access')`                                                         |
| (no session)                    | `redirect('/login')`                                                             |

#### Integration tests: repository (`tests/integration/db/roles-repository.test.ts`)

New file.

- `rolesRepository.findAll()` returns 3 rows after `db:setup`; ordered by `role_name` ascending.
- `rolesRepository.findById(adminRoleId)` returns the ADMIN role row.
- `rolesRepository.findById('non-existent-uuid')` returns `null`.
- `rolePermissionAssignRepository.findMappingsForRole(adminRoleId)` returns 4 entries with correct `permissionName`/`permissionType` pairs.
- `rolePermissionAssignRepository.findMappingsForRole(managerRoleId)` returns `[]`.

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `drizzle-orm` — `eq` for repository queries.
- `next` — `redirect()`, `headers()`, `useRouter()`, `usePathname()`.
- `lucide-react` — `X` icon for close button. No new icons beyond what um07 already uses.
- `vitest`, `@testing-library/react` — testing, already installed.
- `cva` — already installed (used by `StatusBadge`/`AuthMethodBadge`/`RoleBadge` from um07).

No new `PERMISSIONS` migration rows — `roles:READ` is already seeded (ADMIN holds `roles:DELETE` which satisfies READ). No schema migrations required.

---

## Verification Checklist

### Page guard

- [ ] `app/(admin)/administration/roles/page.tsx` calls `requirePermission(PERMISSIONS.ROLES, LEVELS.READ)` before any data fetching
- [ ] `export const dynamic = 'force-dynamic'` is present
- [ ] An unauthenticated request redirects to `/login`
- [ ] A request from a user with no grants redirects to `/no-access`
- [ ] The ADMIN user reaches the page and sees the Roles table
- [ ] `PERMISSIONS.ROLES` and `LEVELS.READ` constants are used (not raw strings `'roles'`/`'READ'`)
- [ ] No DB access in `page.tsx` — delegates entirely to `getAllRolesWithMappings` and `getRoleWithMappings`

### Page structure

- [ ] `loading.tsx` exists and renders a shimmer skeleton (table on left, panel on right)
- [ ] `error.tsx` exists, calls the telemetry helper, renders a non-leaking error message
- [ ] `export const metadata = { title: 'Roles — Enterprise Billing' }` is present
- [ ] The page renders the two-column layout with `RoleTable` and `RoleDetail`
- [ ] `permissionMap` from `requirePermission` is passed to `RoleTable`

### Repository implementations

- [ ] `rolesRepository.findAll()` is implemented (not a stub); returns all 3 seeded roles after `db:setup`
- [ ] `rolesRepository.findById(id)` returns the matching role or `null`
- [ ] `rolePermissionAssignRepository.findMappingsForRole(adminRoleId)` returns 4 entries; ADMIN matrix is `users:DELETE`, `roles:DELETE`, `system_config:DELETE`, `audit_log:READ`
- [ ] `rolePermissionAssignRepository.findMappingsForRole(managerRoleId)` returns `[]`
- [ ] Neither repository function imports from `auth/`, `services/`, `app/`, or `actions/`
- [ ] The new `findMappingsForRole` does not modify `findGrantsByRoleIds` from um06

### Service

- [ ] `getAllRolesWithMappings()` returns 3 `RoleWithMappings` objects against the seeded test DB
- [ ] Every `RoleWithMappings.mappings` has exactly 4 entries (one per `PERMISSION_NAMES` entry)
- [ ] `mappings` order is always: users → roles → system_config → audit_log
- [ ] ADMIN mappings: `{ permissionName: 'users', assignedLevel: 'DELETE' }`, `{ permissionName: 'roles', assignedLevel: 'DELETE' }`, `{ permissionName: 'system_config', assignedLevel: 'DELETE' }`, `{ permissionName: 'audit_log', assignedLevel: 'READ' }`
- [ ] MANAGER mappings: all 4 with `assignedLevel: null`
- [ ] `getRoleWithMappings('non-existent-id')` returns `null`
- [ ] Service has no imports from `next/*`, `app/**`, or `actions/**`

### `PermissionLevelTag`

- [ ] Renders the correct label: `READ`, `EDIT`, or `DELETE`
- [ ] Applies `info-50`/`info-700` tokens for `READ`; `warning-50`/`warning-700` for `EDIT`; `danger-50`/`danger-700` for `DELETE`
- [ ] No raw hex values in the component — CSS variable references only
- [ ] Uses `--radius-xs` (2px) and `--text-overline` sizing
- [ ] Component is not a default export

### `RoleTable`

- [ ] Renders 3 rows for the 3 seeded roles
- [ ] ADMIN row: shows 4 permission chips (users, roles, system_config, audit_log with their levels)
- [ ] MANAGER row: shows "No permissions" in `--text-muted`
- [ ] USER row: shows "No permissions" in `--text-muted`
- [ ] Clicking a row navigates to `?roleId=<role_id>`
- [ ] The selected row (matching `selectedRoleId`) has the selected-row style applied
- [ ] "Add Role" button is `disabled` and is only visible when `hasLevel(...ROLES, LEVELS.EDIT)` is true
- [ ] `PERMISSION_DISPLAY_NAMES` is used for permission labels (not raw `permission_name` strings)
- [ ] Empty state ("No roles found.") renders when `roles = []`
- [ ] No imports from `db/**` or `services/**`

### `RoleDetail`

- [ ] Empty state renders when `role = null` and `selectedRoleId = null`
- [ ] "Role not found." + "Back to roles" link renders when `role = null` and `selectedRoleId` is non-null
- [ ] Panel renders role name as `<h3>` and a `RoleBadge` when `role` is provided
- [ ] All 4 permissions appear in the matrix in order: Users, Roles, System Config, Audit Log
- [ ] ADMIN: `PermissionLevelTag` renders with `DELETE` for users/roles/system_config and `READ` for audit_log
- [ ] MANAGER: all 4 rows show "—" in `--text-muted`
- [ ] Description field shows "—" when `roleDescr` is `null`
- [ ] Created and Last Modified values use `--font-mono`
- [ ] Close (×) button navigates to `/administration/roles` (no `?roleId`)
- [ ] `RoleBadge` from um07 is reused (not re-implemented)
- [ ] No action buttons exist in this unit (no Edit/Delete in the panel)
- [ ] No imports from `db/**` or `services/**`

### Types

- [ ] `types/roles.ts` exports `RolePermissionMapping`, `RoleWithMappings`, `PERMISSION_DISPLAY_NAMES`
- [ ] `RolePermissionMapping.assignedLevel` is `PermissionType | null` (not `undefined`)
- [ ] `PERMISSION_DISPLAY_NAMES` is a `Record<PermissionName, string>` with all 4 keys
- [ ] `tsc --noEmit` clean across all new and modified files

### Test suite

- [ ] All `PermissionLevelTag` unit tests pass
- [ ] All `getAllRolesWithMappings` service unit tests pass (6 scenarios)
- [ ] All `RoleTable` unit tests pass (7 scenarios)
- [ ] All `RoleDetail` unit tests pass (9 scenarios)
- [ ] All roles-read service integration tests pass
- [ ] All page guard integration tests pass
- [ ] All repository integration tests pass

### Boundary enforcement

- [ ] `types/roles.ts` has no import from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `services/roles/roles-read.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `components/roles/*.tsx` have no imports from `db/**` or `services/**`
- [ ] `app/(admin)/administration/roles/page.tsx` has no direct DB queries
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Navigation

- [ ] The "Roles" nav link in the sidebar (added in um07) now resolves to a real page rather than 404
- [ ] Navigating to `/administration/roles` with the ADMIN session shows the Roles table with the 3 seeded roles
- [ ] The nav link shows the active state (`--surface-selected`, left border) when on the Roles page

### Scope guard

- [ ] No Server Actions added — this is a read-only unit; mutations come in um19/um20
- [ ] No role create/edit/delete UI added
- [ ] No permission mapping write path added
- [ ] No new `PERMISSIONS` migration rows added
- [ ] No schema migrations added
- [ ] `RoleBadge` from um07 is reused, not modified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
