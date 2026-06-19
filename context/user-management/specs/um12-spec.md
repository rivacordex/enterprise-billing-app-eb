# Spec: um12 — Assign / revoke roles (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um07 (`UserDetail` panel, `UserTable`, `types/users.ts` — `UserDetailView`, `usersReadService`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, badge components, `RoleBadge`); Unit um05 (`ROLE_ASSIGN` / `ROLES` / `PERMISSIONS` schema, `role-assign.repository.ts` stub, `roles.repository.ts` stub, `types/rbac.ts`); Unit um11 (`UserDetail` as a Client Component with `mode` state, `permissionMap` prop, edit mode pattern); Unit um03 (`writeAuditEvent` helper).
- **Source sections:** overview §"User administration" (assign/revoke roles, `assigned_by`), §"Pages — Administration" item 1 (`users:EDIT`), §"Data Model" (`ROLE_ASSIGN` — `unique(ref_user_id, ref_role_id)`, `assigned_by`), §"Audit Events" (`ROLE_ASSIGNED`, `ROLE_REVOKED`), §"Guardrails" (last ADMIN-capable account); architecture §2 (folder ownership, boundary rules), §5 (RBAC mechanics, ADMIN-only assignment), §6 (permission matrix: `users:EDIT`); code-standards §1.7 (audit atomicity), §3.4 (Server Action pattern), §7 (file organization). Invariants: **#3** (server-side authz), **#6** (ADMIN-only assignment in v1), **#11** (audit atomically with mutation), **#13** (last ADMIN-capable account never removed), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod), **#20** (authz never cached), **#22** (roles in use cannot be deleted — symmetric: users in use by role guard).

---

## Goal

Add assign and revoke role capabilities to the `UserDetail` panel, allowing an admin with `users:EDIT` to assign any available role to a user or revoke an existing assignment; each operation records `assigned_by`, enforces the `unique(ref_user_id, ref_role_id)` constraint, blocks revoking the last ADMIN role, writes a `ROLE_ASSIGNED` or `ROLE_REVOKED` audit event atomically in one transaction, and revalidates the Users page so role badges update immediately.

---

## Design

### "Manage roles" mode in `UserDetail`

The `UserDetail` panel (already a Client Component from um11) gains a **"Manage roles"** button in the panel header alongside the existing "Edit" and "×" buttons. It is visible only when `mode === 'view'`, `user !== null`, and `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)`.

Clicking "Manage roles" sets `mode` to `'manageRoles'`. In this mode:

- The panel header title remains the user's name (`<h3>`).
- The "Edit" button, "Manage roles" button, and "×" close button are all hidden.
- A **"Done"** button (ghost style, top-right) replaces them; clicking it returns to `'view'` mode.
- In the **Access group**, the read-only Roles `<dd>` is replaced by `RoleAssignmentPanel`.
- The Identity and Account state field groups remain visible as read-only.

The `useEffect` from um11 that resets `mode` to `'view'` when `user?.userId` changes is unchanged — it already covers all three modes.

### "Manage roles" button styling

- Ghost style matching um11's "Edit" button: `border border-[--border-subtle] bg-transparent hover:bg-[--action-ghost-hover] text-[--text-secondary]`
- Lucide `ShieldPlus` icon (size 14) + label "Manage roles", `text-sm`
- Focus ring: `--focus-ring`
- Placed in the panel header to the right of the "Edit" button, left of "×"

### "Done" button styling (manageRoles mode header)

- Same ghost style as "Manage roles" button
- Lucide `Check` icon (size 14) + label "Done", `text-sm`
- Positioned top-right of panel header (where "×" normally sits)

### `RoleAssignmentPanel`

Replaces the read-only Roles `<dd>` in the Access group when `mode === 'manageRoles'`. Renders inline — no modal, no drawer.

**Current roles section:**

- For each role in `currentRoles`: a row with `RoleBadge roleName` + a ghost-danger remove button (`X` icon, 14px, `aria-label="Remove {roleName}"`). While that role's operation is in-flight, the button shows `Loader2 animate-spin` and is `disabled`.
- When `currentRoles.length === 0`: `<p>No roles assigned.</p>` in `--text-muted`.

**Last-ADMIN error:** If the last revoke attempted returned `LAST_ADMIN_ROLE`, render a shadcn `Alert` (destructive variant) between the roles list and the add section: "Cannot remove the last ADMIN role. Assign ADMIN to another user first." The alert clears when any subsequent action is initiated.

**Add role section** (shown only when `availableRoles.length > 0`):

- A `<label>` "Add role" in `--text-overline` / `--text-muted` style.
- A shadcn `Select` listing `availableRoles`, each option: `roleId` as value, `roleName` as display text.
- An "Add" button (primary, `h-8 px-3 text-sm`), disabled when `selectedRoleId === null` or any save is in-flight.

**DELETED user guard:** If `userStatus === 'DELETED'`, render only `<p>Cannot manage roles for a deleted user.</p>` in `--text-muted` — no role chips or add controls. The service also enforces this; the UI check is UX-only.

**Per-operation loading:** A single `isSavingRoleId: string | null` state tracks which `roleId` is currently being saved. A revoke operation sets it to the role being removed; an assign operation sets it to `selectedRoleId`. This lets the affected button show a spinner while others remain interactive.

### `allRoles` prop flow

`UsersPage` fetches `allRoles` via `rolesReadService.listRoles()` in the same `Promise.all` as `listUsers()` and `getUserById()`. It is always fetched when the page loads (the roles list is small; always-available ensures instant transition into manage mode). `allRoles` is passed to `UserDetail`, which computes `availableRoles` as:

```ts
const availableRoles = allRoles.filter(
  (r) => !user?.roles.find((cr) => cr.roleId === r.roleId),
);
```

`availableRoles` is passed to `RoleAssignmentPanel` as a prop.

---

## Implementation

### 12.1 — `RoleListItem` type (`types/rbac.ts`)

Add to the existing file alongside the existing `PERMISSION_NAMES`, `PermissionType`, `SeededRoleName`, and Drizzle-derived re-exports:

```ts
export interface RoleListItem {
  roleId: string;
  roleName: string;
  roleDescr: string | null;
}
```

No other changes to `types/rbac.ts`. This type is used by `rolesReadService.listRoles()` and the `UserDetail` / `RoleAssignmentPanel` props.

### 12.2 — Zod validation schemas (`validation/users.ts`)

Add below the existing schemas (e.g. `updateUserDetailsSchema` from um11):

```ts
export const assignRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  roleId: z.string().uuid("Invalid role ID"),
});
export type AssignRoleInput = z.infer<typeof assignRoleSchema>;

export const revokeRoleSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  roleId: z.string().uuid("Invalid role ID"),
});
export type RevokeRoleInput = z.infer<typeof revokeRoleSchema>;
```

Both schemas are structurally identical but are distinct named exports for clarity at call sites. No other changes to `validation/users.ts`.

### 12.3 — Repository: `roles.repository.ts` — implement `findAllRoles` and `findRoleById`

Replace the stub body created in um05 with two implemented functions. Both import only `@/db/client` and `@/db/schema`; no business logic; no audit writes; no transaction handles (read-only).

`Role` is the Drizzle `$inferSelect` type from `db/schema/core/roles.ts`, already re-exported from `types/rbac.ts`.

#### `findAllRoles(): Promise<Role[]>`

Drizzle select all columns from `core.roles`, ordered by `role_name ASC`. Returns the full array; never returns `null`. An empty DB returns `[]`.

#### `findRoleById(roleId: string): Promise<Role | null>`

Drizzle select all columns from `core.roles` WHERE `role_id = $roleId` LIMIT 1. Returns the row or `null` if not found.

### 12.4 — Repository: `role-assign.repository.ts` — implement four functions

Replace the stub body created in um05. All mutating functions accept a caller-supplied Drizzle transaction handle (`tx: DrizzleTransaction`) and never open their own transaction. The read functions run outside a transaction.

`RoleAssign` is the Drizzle `$inferSelect` type from `db/schema/core/role-assign.ts`, already re-exported from `types/rbac.ts`.

#### `insertRoleAssign(tx: DrizzleTransaction, data: { refUserId: string; refRoleId: string; assignedBy: string }): Promise<RoleAssign>`

Drizzle insert into `core.role_assign` with `ref_user_id`, `ref_role_id`, `assigned_by`; `created_datetime` defaults to `now()`. Uses `.returning()` and returns the inserted row. The unique constraint `(ref_user_id, ref_role_id)` is enforced by the DB; the service checks for duplicates before calling this.

#### `deleteRoleAssign(tx: DrizzleTransaction, data: { refUserId: string; refRoleId: string }): Promise<RoleAssign | null>`

Drizzle delete from `core.role_assign` WHERE `ref_user_id = data.refUserId AND ref_role_id = data.refRoleId`, using `.returning()`. Returns the deleted row, or `null` if no matching row (race condition). The service loads the existing assignment before entering the transaction and throws an `AppError` if `null` is returned here.

#### `findByUserIdAndRoleId(refUserId: string, refRoleId: string): Promise<RoleAssign | null>`

Drizzle select from `core.role_assign` WHERE `ref_user_id = $refUserId AND ref_role_id = $refRoleId` LIMIT 1. Returns the row or `null`. No transaction handle.

#### `countNonDeletedUsersWithRole(roleId: string): Promise<number>`

Drizzle query joining `core.role_assign` with `core.appuser` on `role_assign.ref_user_id = appuser.user_id`:

```ts
const result = await db
  .select({ count: count() })
  .from(schema.roleAssign)
  .innerJoin(
    schema.appuser,
    eq(schema.roleAssign.refUserId, schema.appuser.userId),
  )
  .where(
    and(
      eq(schema.roleAssign.refRoleId, roleId),
      ne(schema.appuser.status, "DELETED"),
    ),
  );
```

Returns the count as a `number`. Counts ACTIVE, PENDING, and DISABLED users (all non-DELETED) — DISABLED users are still ADMIN-capable and can be re-enabled. No transaction handle.

### 12.5 — Service: roles read (`services/roles/roles-read.service.ts`)

New file in a new `services/roles/` directory. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

```ts
export async function listRoles(): Promise<RoleListItem[]>;
```

1. Call `rolesRepository.findAllRoles()`.
2. Map each `Role` row to `RoleListItem`: `{ roleId: row.roleId, roleName: row.roleName, roleDescr: row.roleDescr }`.
3. Return the array.

Does not audit (read operation). Does not throw for expected cases.

### 12.6 — Service: `assignRole` (`services/users/users-write.service.ts`)

Add to the existing service file. Framework-agnostic.

```ts
type AssignRoleResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ALREADY_ASSIGNED" }
  | { ok: false; code: "CANNOT_ASSIGN_TO_DELETED_USER" };

export async function assignRole(
  input: AssignRoleInput,
  actorId: string,
): Promise<AssignRoleResult>;
```

Steps:

1. `const user = await appUserRepository.findUserById(input.userId)`. If `null` → `{ ok: false, code: 'USER_NOT_FOUND' }`. If `user.status === 'DELETED'` → `{ ok: false, code: 'CANNOT_ASSIGN_TO_DELETED_USER' }`.

2. `const role = await rolesRepository.findRoleById(input.roleId)`. If `null` → `{ ok: false, code: 'ROLE_NOT_FOUND' }`.

3. `const existing = await roleAssignRepository.findByUserIdAndRoleId(input.userId, input.roleId)`. If not `null` → `{ ok: false, code: 'ALREADY_ASSIGNED' }`.

4. Open a Drizzle transaction:

   a. `const newRow = await roleAssignRepository.insertRoleAssign(tx, { refUserId: input.userId, refRoleId: input.roleId, assignedBy: actorId })`.

   b. `await writeAuditEvent(tx, { eventType: 'ROLE_ASSIGNED', actorUserId: actorId, targetEntity: 'ROLE_ASSIGN', targetId: newRow.roleAssignId, beforeData: null, afterData: { userId: input.userId, roleId: input.roleId, roleName: role.roleName, assignedBy: actorId } })`.

5. Return `{ ok: true }`.

On any transaction error, let the exception propagate — the transaction rolls back, no partial write.

### 12.7 — Service: `revokeRole` (`services/users/users-write.service.ts`)

Add to the same service file.

```ts
type RevokeRoleResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "ASSIGNMENT_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN_ROLE" };

export async function revokeRole(
  input: RevokeRoleInput,
  actorId: string,
): Promise<RevokeRoleResult>;
```

Steps:

1. `const user = await appUserRepository.findUserById(input.userId)`. If `null` → `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. `const role = await rolesRepository.findRoleById(input.roleId)`. If `null` → `{ ok: false, code: 'ROLE_NOT_FOUND' }`.

3. `const existing = await roleAssignRepository.findByUserIdAndRoleId(input.userId, input.roleId)`. If `null` → `{ ok: false, code: 'ASSIGNMENT_NOT_FOUND' }`.

4. **Last-ADMIN guard:** if `role.roleName === 'ADMIN'`:
   - `const adminCount = await roleAssignRepository.countNonDeletedUsersWithRole(input.roleId)`.
   - If `adminCount <= 1` → `{ ok: false, code: 'LAST_ADMIN_ROLE' }`.

5. Open a Drizzle transaction:

   a. `const deleted = await roleAssignRepository.deleteRoleAssign(tx, { refUserId: input.userId, refRoleId: input.roleId })`. If `deleted === null`, throw an `AppError` with message "Role assignment disappeared during transaction" — the transaction rolls back. This is a race condition; the caller will surface a `SERVER_ERROR`.

   b. `await writeAuditEvent(tx, { eventType: 'ROLE_REVOKED', actorUserId: actorId, targetEntity: 'ROLE_ASSIGN', targetId: existing.roleAssignId, beforeData: { userId: input.userId, roleId: input.roleId, roleName: role.roleName, assignedBy: existing.assignedBy }, afterData: null })`.

6. Return `{ ok: true }`.

### 12.8 — Server Action: `assignRoleAction` (`actions/users/assign-role.action.ts`)

New file. `'use server'`.

```ts
type AssignRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | {
      ok: false;
      code:
        | "USER_NOT_FOUND"
        | "ROLE_NOT_FOUND"
        | "ALREADY_ASSIGNED"
        | "CANNOT_ASSIGN_TO_DELETED_USER"
        | "FORBIDDEN"
        | "SERVER_ERROR";
    };

export async function assignRoleAction(
  rawInput: unknown,
): Promise<AssignRoleActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — in a try/catch; re-throw `NEXT_REDIRECT`; any other auth failure → `{ ok: false, code: 'FORBIDDEN' }`.
2. `const parsed = assignRoleSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.
3. `const result = await usersWriteService.assignRole(parsed.data, actorId)`.
4. If `!result.ok` → return `{ ok: false, code: result.code }`.
5. `revalidatePath('/administration/users')`.
6. Return `{ ok: true }`.

The action has no DB access; it wraps the service with validation and authorization.

### 12.9 — Server Action: `revokeRoleAction` (`actions/users/revoke-role.action.ts`)

New file. `'use server'`.

```ts
type RevokeRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | {
      ok: false;
      code:
        | "USER_NOT_FOUND"
        | "ROLE_NOT_FOUND"
        | "ASSIGNMENT_NOT_FOUND"
        | "LAST_ADMIN_ROLE"
        | "FORBIDDEN"
        | "SERVER_ERROR";
    };

export async function revokeRoleAction(
  rawInput: unknown,
): Promise<RevokeRoleActionResult>;
```

Steps: identical pattern to `assignRoleAction` — guard, parse with `revokeRoleSchema`, call `usersWriteService.revokeRole`, map result, `revalidatePath`, return. Wrap unexpected service throws in `{ ok: false, code: 'SERVER_ERROR' }`.

### 12.10 — `RoleAssignmentPanel` component (`components/users/role-assignment-panel.tsx`)

New file. Client Component (`'use client'`).

**Props:**

```ts
interface RoleAssignmentPanelProps {
  userId: string;
  currentRoles: Array<{
    roleId: string;
    roleName: string;
    assignedBy: string | null;
  }>;
  availableRoles: Array<{ roleId: string; roleName: string }>;
  userStatus: UserStatus;
}
```

**State:**

```ts
const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
const [isSavingRoleId, setIsSavingRoleId] = useState<string | null>(null);
const [lastAdminError, setLastAdminError] = useState(false);
```

**`useEffect`** — reset `selectedRoleId` to `null` when `availableRoles` changes (e.g. after a successful assign causes the list to shrink):

```ts
useEffect(() => {
  setSelectedRoleId(null);
}, [availableRoles]);
```

**`handleRevoke(roleId: string)`:**

```ts
setIsSavingRoleId(roleId);
setLastAdminError(false);
try {
  const result = await revokeRoleAction({ userId, roleId });
  if (!result.ok) {
    if (result.code === "LAST_ADMIN_ROLE") setLastAdminError(true);
    else toast.error("Failed to remove role. Please try again.");
  }
  // On ok: true, revalidatePath in the action causes the page to re-render
  // with updated props — no client-side state patching needed
} finally {
  setIsSavingRoleId(null);
}
```

**`handleAssign()`:**

```ts
if (!selectedRoleId) return;
setIsSavingRoleId(selectedRoleId);
setLastAdminError(false);
try {
  const result = await assignRoleAction({ userId, roleId: selectedRoleId });
  if (!result.ok) {
    toast.error("Failed to assign role. Please try again.");
  }
  // On ok: true, revalidatePath causes re-render; useEffect resets selectedRoleId
} finally {
  setIsSavingRoleId(null);
}
```

**Render:**

If `userStatus === 'DELETED'`:

```tsx
<p className="text-sm text-muted-foreground">
  Cannot manage roles for a deleted user.
</p>
```

Otherwise:

```tsx
<div className="flex flex-col gap-3">
  {/* Current roles */}
  <div className="flex flex-col gap-1.5">
    {currentRoles.length === 0 ? (
      <p className="text-sm text-muted-foreground">No roles assigned.</p>
    ) : (
      currentRoles.map((role) => (
        <div key={role.roleId} className="flex items-center justify-between">
          <RoleBadge roleName={role.roleName} />
          <button
            aria-label={`Remove ${role.roleName}`}
            disabled={isSavingRoleId === role.roleId}
            onClick={() => handleRevoke(role.roleId)}
            className="rounded p-1 text-[--color-danger-700] hover:bg-[--color-danger-50] focus:outline-none focus-visible:ring-2 focus-visible:ring-[--focus-ring] disabled:opacity-50"
          >
            {isSavingRoleId === role.roleId ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <X size={14} />
            )}
          </button>
        </div>
      ))
    )}
  </div>

  {/* Last-admin error */}
  {lastAdminError && (
    <Alert variant="destructive">
      <AlertDescription>
        Cannot remove the last ADMIN role. Assign ADMIN to another user first.
      </AlertDescription>
    </Alert>
  )}

  {/* Add role */}
  {availableRoles.length > 0 && (
    <div className="flex flex-col gap-1.5">
      <label className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Add role
      </label>
      <div className="flex items-center gap-2">
        <Select value={selectedRoleId ?? ""} onValueChange={setSelectedRoleId}>
          <SelectTrigger className="h-8 flex-1 text-sm">
            <SelectValue placeholder="Select a role…" />
          </SelectTrigger>
          <SelectContent>
            {availableRoles.map((r) => (
              <SelectItem key={r.roleId} value={r.roleId}>
                {r.roleName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          className="h-8"
          disabled={!selectedRoleId || isSavingRoleId !== null}
          onClick={handleAssign}
        >
          {isSavingRoleId === selectedRoleId && selectedRoleId !== null ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : null}
          Add
        </Button>
      </div>
    </div>
  )}
</div>
```

Imports: `useState`, `useEffect` from React; `revokeRoleAction` from `@/actions/users/revoke-role.action`; `assignRoleAction` from `@/actions/users/assign-role.action`; `RoleBadge` from `@/components/role-badge`; `Loader2`, `X` from `lucide-react`; shadcn `Alert`, `AlertDescription`, `Button`, `Select`, `SelectContent`, `SelectItem`, `SelectTrigger`, `SelectValue`; `toast` from `sonner`; `UserStatus` from `@/types/rbac`.

No DB access, no service imports, no `next/*` imports beyond what shadcn may require.

### 12.11 — `UserDetail` update (`components/users/user-detail.tsx`)

**Props update** — add `allRoles`:

```ts
interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
  permissionMap: EffectivePermissionMap;
  allRoles: RoleListItem[]; // NEW
}
```

**`mode` state extension:**

```ts
const [mode, setMode] = useState<"view" | "edit" | "manageRoles">("view");
```

The existing `useEffect` resetting `mode` to `'view'` on `user?.userId` change covers this new mode — no changes needed there.

**Derived value** (compute during render, before the return):

```ts
const availableRoles = allRoles.filter(
  (r) => !user?.roles.find((cr) => cr.roleId === r.roleId),
);
```

**Panel header extension** — the header button group currently (after um11) shows [Edit] [×] in view mode and nothing in edit mode. After um12, in `mode === 'view'` it shows:

```tsx
<div className="flex items-center gap-2">
  {/* Edit — from um11, unchanged */}
  {user && hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT) && (
    <Button variant="ghost" size="sm" onClick={() => setMode("edit")}>
      <Pencil size={14} className="mr-1" /> Edit
    </Button>
  )}
  {/* Manage roles — NEW */}
  {user && hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT) && (
    <Button variant="ghost" size="sm" onClick={() => setMode("manageRoles")}>
      <ShieldPlus size={14} className="mr-1" /> Manage roles
    </Button>
  )}
  {/* Close */}
  <Link href="/administration/users" className="...ghost-icon-button...">
    <X size={16} />
  </Link>
</div>
```

In `mode === 'edit'` — no changes from um11 (Edit/Manage roles/× all hidden; Save/Cancel at bottom).

In `mode === 'manageRoles'` — new header button group:

```tsx
<div className="flex items-center gap-2">
  <Button variant="ghost" size="sm" onClick={() => setMode("view")}>
    <Check size={14} className="mr-1" /> Done
  </Button>
</div>
```

**Access group — Roles `<dd>`** — extend the view-mode render:

```tsx
<dd>
  {mode === "manageRoles" ? (
    <RoleAssignmentPanel
      userId={user.userId}
      currentRoles={user.roles}
      availableRoles={availableRoles}
      userStatus={user.status}
    />
  ) : user.roles.length > 0 ? (
    user.roles.map((r) => <RoleBadge key={r.roleId} roleName={r.roleName} />)
  ) : (
    <span className="text-muted-foreground">None assigned</span>
  )}
</dd>
```

The read-only roles field is only active when `mode === 'view'` or `mode === 'edit'` (edit mode leaves Identity editable but Access group read-only, per um11 spec — no change to that behavior).

No changes to any other part of `UserDetail`.

### 12.12 — `UsersPage` update (`app/(admin)/administration/users/page.tsx`)

Extend the `Promise.all` call to also fetch all roles, and pass `allRoles` to `UserDetail`.

```ts
// Before (um11):
const [users, selectedUser] = await Promise.all([
  usersReadService.listUsers(),
  selectedUserId
    ? usersReadService.getUserById(selectedUserId)
    : Promise.resolve(null),
]);

// After (um12):
const [users, selectedUser, allRoles] = await Promise.all([
  usersReadService.listUsers(),
  selectedUserId
    ? usersReadService.getUserById(selectedUserId)
    : Promise.resolve(null),
  rolesReadService.listRoles(),
]);
```

Import `rolesReadService` from `@/services/roles/roles-read.service`. Pass `allRoles` to `UserDetail`:

```tsx
<UserDetail
  user={selectedUser}
  notFound={selectedUserId !== undefined && selectedUser === null}
  permissionMap={permissionMap}
  allRoles={allRoles}
/>
```

No other changes to `UsersPage`.

### 12.13 — Tests

#### Unit tests: schemas (`tests/unit/validation/users.test.ts`)

Extend the existing file. Cover both `assignRoleSchema` and `revokeRoleSchema` (same coverage for each):

| Input                                          | Expected                    |
| ---------------------------------------------- | --------------------------- |
| `{ userId: valid-uuid, roleId: valid-uuid }`   | Passes                      |
| `{ userId: 'not-a-uuid', roleId: valid-uuid }` | Fails; `userId` error       |
| `{ userId: valid-uuid, roleId: 'not-a-uuid' }` | Fails; `roleId` error       |
| `{ userId: valid-uuid }` (no `roleId`)         | Fails; `roleId` required    |
| `{}`                                           | Fails; both fields required |

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository`, `rolesRepository`, `roleAssignRepository`, `writeAuditEvent`.

**`assignRole` scenarios:**

| Scenario                   | Setup                                                                                                        | Expected                                                                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path (ACTIVE user)   | `findUserById` → ACTIVE; `findRoleById` → role; `findByUserIdAndRoleId` → null; `insertRoleAssign` → new row | Transaction opened; `insertRoleAssign` called with `{ refUserId, refRoleId, assignedBy: actorId }`; `writeAuditEvent` called with `ROLE_ASSIGNED`, `beforeData: null`, `afterData` includes `roleName`; returns `{ ok: true }` |
| Happy path (PENDING user)  | Same but `status: 'PENDING'`                                                                                 | Succeeds — PENDING users may receive role assignments                                                                                                                                                                          |
| Happy path (DISABLED user) | Same but `status: 'DISABLED'`                                                                                | Succeeds — DISABLED users may receive role assignments                                                                                                                                                                         |
| User not found             | `findUserById` → null                                                                                        | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; no transaction opened                                                                                                                                                         |
| DELETED user blocked       | `findUserById` → `{ status: 'DELETED' }`                                                                     | Returns `{ ok: false, code: 'CANNOT_ASSIGN_TO_DELETED_USER' }`; no transaction                                                                                                                                                 |
| Role not found             | `findRoleById` → null                                                                                        | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`; no transaction                                                                                                                                                                |
| Already assigned           | `findByUserIdAndRoleId` → existing row                                                                       | Returns `{ ok: false, code: 'ALREADY_ASSIGNED' }`; no transaction                                                                                                                                                              |
| Audit `afterData` content  | Happy path                                                                                                   | `afterData.roleName` matches the role returned by `findRoleById`; `afterData.assignedBy` matches `actorId`                                                                                                                     |

**`revokeRole` scenarios:**

| Scenario                                                     | Setup                                                                                         | Expected                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path (non-ADMIN role)                                  | User exists; `role.roleName = 'MANAGER'`; assignment exists; `deleteRoleAssign` → deleted row | `deleteRoleAssign` called; `writeAuditEvent` called with `ROLE_REVOKED`, `beforeData.roleName = 'MANAGER'`, `afterData: null`; returns `{ ok: true }` |
| Happy path (ADMIN, count = 2)                                | `role.roleName = 'ADMIN'`; `countNonDeletedUsersWithRole` → 2                                 | Last-admin guard passes; deletion proceeds; returns `{ ok: true }`                                                                                    |
| User not found                                               | `findUserById` → null                                                                         | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`                                                                                                       |
| Role not found                                               | `findRoleById` → null                                                                         | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`                                                                                                       |
| Assignment not found                                         | `findByUserIdAndRoleId` → null                                                                | Returns `{ ok: false, code: 'ASSIGNMENT_NOT_FOUND' }`                                                                                                 |
| Last ADMIN (count = 1)                                       | `role.roleName = 'ADMIN'`; `countNonDeletedUsersWithRole` → 1                                 | Returns `{ ok: false, code: 'LAST_ADMIN_ROLE' }`; no transaction                                                                                      |
| Last ADMIN (count = 0, edge case)                            | `countNonDeletedUsersWithRole` → 0                                                            | Returns `{ ok: false, code: 'LAST_ADMIN_ROLE' }`                                                                                                      |
| Before-data from existing assignment                         | Existing row has `assignedBy = 'some-admin-id'`                                               | `beforeData.assignedBy = 'some-admin-id'`                                                                                                             |
| `countNonDeletedUsersWithRole` not called for non-ADMIN role | `role.roleName = 'USER'`                                                                      | `countNonDeletedUsersWithRole` never called                                                                                                           |

#### Unit tests: `assignRoleAction` (`tests/unit/actions/assign-role.action.test.ts`)

New file. Mock `requirePermission`, `usersWriteService.assignRole`, `revalidatePath`.

| Scenario                        | Setup                                                            | Expected                                                                                           |
| ------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Valid input, ADMIN session      | Service → `{ ok: true }`                                         | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called                           |
| Invalid `roleId` UUID           | `roleId = 'not-a-uuid'`                                          | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; service not called; `revalidatePath` not called |
| `CANNOT_ASSIGN_TO_DELETED_USER` | Service → `{ ok: false, code: 'CANNOT_ASSIGN_TO_DELETED_USER' }` | Returns `{ ok: false, code: 'CANNOT_ASSIGN_TO_DELETED_USER' }`                                     |
| `ALREADY_ASSIGNED`              | Service → `{ ok: false, code: 'ALREADY_ASSIGNED' }`              | Returns `{ ok: false, code: 'ALREADY_ASSIGNED' }`                                                  |
| Unauthorized                    | `requirePermission` throws (not NEXT_REDIRECT)                   | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                         |
| Server error                    | Service throws                                                   | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                                      |

#### Unit tests: `revokeRoleAction` (`tests/unit/actions/revoke-role.action.test.ts`)

New file. Same mock pattern.

| Scenario                   | Setup                                                   | Expected                                                                 |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Valid input, ADMIN session | Service → `{ ok: true }`                                | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called |
| `LAST_ADMIN_ROLE`          | Service → `{ ok: false, code: 'LAST_ADMIN_ROLE' }`      | Returns `{ ok: false, code: 'LAST_ADMIN_ROLE' }`                         |
| `ASSIGNMENT_NOT_FOUND`     | Service → `{ ok: false, code: 'ASSIGNMENT_NOT_FOUND' }` | Returns `{ ok: false, code: 'ASSIGNMENT_NOT_FOUND' }`                    |
| Unauthorized               | `requirePermission` throws                              | Returns `{ ok: false, code: 'FORBIDDEN' }`                               |
| Validation failure         | Invalid `userId`                                        | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`                        |

#### Unit tests: `RoleAssignmentPanel` (`tests/unit/components/role-assignment-panel.test.tsx`)

New file. Use `@testing-library/react` + `vitest`. Mock `assignRoleAction`, `revokeRoleAction`, `toast.error`.

| Scenario                                                    | Expected                                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `userStatus = 'DELETED'`                                    | Renders "Cannot manage roles for a deleted user."; no role chips, no add section |
| `currentRoles = []`, `availableRoles` non-empty             | "No roles assigned." visible; add section visible                                |
| One current role                                            | Role badge + remove button present                                               |
| `availableRoles.length = 0`                                 | Add section not rendered                                                         |
| Remove button click                                         | `revokeRoleAction` called with `{ userId, roleId }`                              |
| While save in-flight (mock action pending)                  | Remove button for that role shows spinner; button disabled                       |
| `revokeRoleAction` returns `LAST_ADMIN_ROLE`                | Inline destructive `Alert` rendered                                              |
| `revokeRoleAction` returns other error                      | `toast.error` called                                                             |
| Select + Add button calls `assignRoleAction`                | `assignRoleAction` called with `{ userId, roleId: selectedRoleId }`              |
| "Add" button disabled when no role selected                 |                                                                                  |
| `selectedRoleId` resets after `availableRoles` prop changes |                                                                                  |

#### Unit tests: `UserDetail` — manageRoles mode (`tests/unit/components/user-detail.test.tsx`)

Extend the existing file.

| Scenario                                                                             | Expected |
| ------------------------------------------------------------------------------------ | -------- |
| "Manage roles" button visible in `view` mode when `hasLevel(...)` and user not null  |          |
| "Manage roles" button not visible when `hasLevel(...)` false                         |          |
| "Manage roles" button not visible in `edit` mode (no regression from um11)           |          |
| Clicking "Manage roles" renders `RoleAssignmentPanel`; read-only role badges removed |          |
| "Done" button visible in `manageRoles` mode; clicking it returns to view mode        |          |
| In `manageRoles` mode: Edit, Manage roles, × buttons all hidden                      |          |
| In `manageRoles` mode: Identity and Account state groups still render read-only      |          |
| `user.userId` change while in `manageRoles` resets to `view` mode                    |          |
| `availableRoles` passed to panel = `allRoles` minus `user.roles`                     |          |

#### Integration tests: assign / revoke actions (`tests/integration/actions/assign-revoke-role.action.test.ts`)

New file. Use the test DB. Fixtures: `admin_user` (ACTIVE, ADMIN role), `no_grants_user` (ACTIVE, no roles), `target_user` (ACTIVE, no roles), `test_role` (INSERT into `core.roles`: e.g. `{ role_name: 'TEST_ROLE' }`).

| Scenario                          | Action                                                                                                           | Expected                                                                                                                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assign role — happy path          | `assignRoleAction({ userId: target_user, roleId: test_role })` with `admin_user` session                         | Returns `{ ok: true }`; `core.role_assign` row exists with `ref_user_id = target_user`, `ref_role_id = test_role`, `assigned_by = admin_user.userId`; `AUDIT_LOG` has `ROLE_ASSIGNED` entry |
| Revoke role — happy path          | `revokeRoleAction({ userId: target_user, roleId: test_role })` with `admin_user` session (after assigning above) | Returns `{ ok: true }`; `core.role_assign` row deleted; `AUDIT_LOG` has `ROLE_REVOKED` entry                                                                                                |
| Assign twice → `ALREADY_ASSIGNED` | Assign `test_role` to `target_user` twice                                                                        | Second call returns `{ ok: false, code: 'ALREADY_ASSIGNED' }`; only one `role_assign` row                                                                                                   |
| Last ADMIN guard — blocks revoke  | Attempt `revokeRoleAction` to revoke ADMIN from `admin_user` when it is the only non-DELETED user with ADMIN     | Returns `{ ok: false, code: 'LAST_ADMIN_ROLE' }`; `role_assign` row preserved                                                                                                               |
| Unauthorized (assign)             | `no_grants_user` session                                                                                         | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                                                                                                  |
| Unauthorized (revoke)             | `no_grants_user` session                                                                                         | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                                                                                                  |
| Audit `ROLE_ASSIGNED` row         | Happy path assign                                                                                                | `event_type = 'ROLE_ASSIGNED'`, `actor_user_id = admin_user.userId`, `target_entity = 'ROLE_ASSIGN'`, `before_data = null`, `after_data` JSON contains `roleName`                           |
| Audit `ROLE_REVOKED` row          | Happy path revoke                                                                                                | `event_type = 'ROLE_REVOKED'`, `before_data` JSON contains `roleName` and `assignedBy`, `after_data = null`                                                                                 |
| Atomicity                         | (Service-level test) Simulate write failure mid-transaction                                                      | Neither `role_assign` row nor `AUDIT_LOG` row committed                                                                                                                                     |

---

## Dependencies

No new npm packages required. All framework dependencies (`next`, `react`, `drizzle-orm`, `zod`, `lucide-react`, `sonner`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — run CLI if not already added:

- `npx shadcn@latest add select` — "Add role" dropdown in `RoleAssignmentPanel`. Added to `components/ui/`; do not hand-edit.
- `npx shadcn@latest add alert` — Last-ADMIN error display. May already be present from um11; skip if so.

---

## Verification Checklist

### Actions and authorization

- [ ] `assignRoleAction` and `revokeRoleAction` are decorated `'use server'`
- [ ] Both actions call `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` as the first `await`
- [ ] Both actions use `PERMISSIONS.USERS` constant (not the raw string `'users'`)
- [ ] Calling either action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling either action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling either action with an ADMIN session and valid input returns `{ ok: true }` on the happy path
- [ ] `revalidatePath('/administration/users')` is called on success for both actions
- [ ] Neither action contains DB access — both delegate entirely to `usersWriteService`

### Validation

- [ ] `assignRoleAction` with `userId` not a valid UUID returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `assignRoleAction` with `roleId` not a valid UUID returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `revokeRoleAction` with either field not a valid UUID returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `assignRoleSchema` and `revokeRoleSchema` are imported from `@/validation/users` (not redefined in the action file)

### `assignRole` service

- [ ] Assigning a role to an ACTIVE user inserts a `ROLE_ASSIGN` row with `assigned_by = actorId`
- [ ] Assigning a role to a PENDING or DISABLED user succeeds (both are allowed)
- [ ] Attempting to assign a role to a DELETED user returns `{ ok: false, code: 'CANNOT_ASSIGN_TO_DELETED_USER' }` with no DB writes
- [ ] A non-existent `userId` returns `{ ok: false, code: 'USER_NOT_FOUND' }`
- [ ] A non-existent `roleId` returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`
- [ ] Assigning a role the user already has returns `{ ok: false, code: 'ALREADY_ASSIGNED' }` with no DB writes
- [ ] `AUDIT_LOG` row is written inside the same transaction as the `ROLE_ASSIGN` insert
- [ ] `ROLE_ASSIGNED` audit `beforeData` is `null`; `afterData` includes `userId`, `roleId`, `roleName`, `assignedBy`
- [ ] If the DB insert throws mid-transaction, the audit row is also rolled back

### `revokeRole` service

- [ ] Revoking a non-ADMIN role deletes the `ROLE_ASSIGN` row and writes `ROLE_REVOKED` audit atomically
- [ ] Revoking ADMIN when 2+ non-DELETED users hold ADMIN succeeds
- [ ] Revoking ADMIN when only 1 non-DELETED user holds ADMIN returns `{ ok: false, code: 'LAST_ADMIN_ROLE' }` with no DB writes
- [ ] `countNonDeletedUsersWithRole` is NOT called when the role being revoked is not ADMIN
- [ ] A non-existent `userId` returns `{ ok: false, code: 'USER_NOT_FOUND' }`
- [ ] A non-existent `roleId` returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`
- [ ] Revoking a role not assigned returns `{ ok: false, code: 'ASSIGNMENT_NOT_FOUND' }` with no DB writes
- [ ] `ROLE_REVOKED` audit `beforeData` includes `roleName` and `assignedBy` (from the existing assignment row); `afterData` is `null`
- [ ] If the DB delete throws mid-transaction, the audit row is also rolled back

### Repository

- [ ] `insertRoleAssign` accepts a transaction handle and does not open its own transaction
- [ ] `deleteRoleAssign` accepts a transaction handle, uses `.returning()`, returns the deleted row or `null`
- [ ] `findByUserIdAndRoleId` returns `null` for a pair with no assignment
- [ ] `countNonDeletedUsersWithRole` joins `core.role_assign` with `core.appuser` and excludes DELETED users; ACTIVE, PENDING, DISABLED users are counted
- [ ] `findAllRoles` returns rows sorted by `role_name ASC`; returns `[]` when no roles exist
- [ ] `findRoleById` returns `null` for a non-existent UUID
- [ ] No repository function contains business logic or audit writes
- [ ] All repository functions import only from `@/db/client` and `@/db/schema`

### `RoleAssignmentPanel`

- [ ] DELETED user renders "Cannot manage roles for a deleted user." only — no role chips, no add section
- [ ] "No roles assigned." shown when `currentRoles` is empty (and user is not DELETED)
- [ ] Add role section is not rendered when `availableRoles.length === 0`
- [ ] Each current role renders `RoleBadge` + remove button with correct `aria-label="Remove {roleName}"`
- [ ] Clicking remove calls `revokeRoleAction({ userId, roleId })`
- [ ] While a remove is in-flight, that role's button shows `Loader2 animate-spin` and is `disabled`
- [ ] Other roles' remove buttons remain enabled during a single-role revoke
- [ ] `LAST_ADMIN_ROLE` response shows inline destructive `Alert`; does not show a toast
- [ ] Other revoke errors show a toast; no inline alert
- [ ] "Add" button is disabled when `selectedRoleId` is null
- [ ] "Add" button is disabled while any save is in-flight
- [ ] Clicking "Add" calls `assignRoleAction({ userId, roleId: selectedRoleId })`
- [ ] `selectedRoleId` resets to `null` when `availableRoles` changes
- [ ] `lastAdminError` clears on next action attempt (assign or revoke)
- [ ] Component has `'use client'`; no DB access; no service imports; no `next/*` imports

### `UserDetail` — manageRoles mode

- [ ] "Manage roles" button visible in view mode when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is true and user is not null
- [ ] "Manage roles" button not visible when `hasLevel(...)` is false
- [ ] "Manage roles" button not visible when `mode === 'edit'` (no regression from um11)
- [ ] Clicking "Manage roles" shows `RoleAssignmentPanel` in the Roles `<dd>`; read-only role badges removed
- [ ] "Done" button visible in `manageRoles` mode; clicking it returns to view mode
- [ ] In `manageRoles` mode: "Edit" button, "Manage roles" button, and "×" close button are all hidden
- [ ] In `manageRoles` mode: Identity and Account state field groups remain read-only (no regression)
- [ ] Changing `user.userId` while in `manageRoles` mode resets to view mode (existing `useEffect`)
- [ ] `availableRoles` passed to `RoleAssignmentPanel` excludes roles already in `user.roles`

### `UserDetail` — view mode (no regression)

- [ ] Read-only role badge display unchanged when `mode === 'view'`
- [ ] "None assigned" renders when `user.roles` is empty in view mode
- [ ] Edit mode from um11 is fully unaffected — entering/exiting edit mode works as before
- [ ] `allRoles` prop addition does not break any existing render path when the list is empty

### `UsersPage`

- [ ] `rolesReadService.listRoles()` is included in the `Promise.all`
- [ ] `allRoles` is passed to `UserDetail`
- [ ] `page.tsx` still has `export const dynamic = 'force-dynamic'`
- [ ] No regression in `listUsers()` or `getUserById()` fetching

### Roles read service

- [ ] `services/roles/roles-read.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `listRoles()` returns all roles including any admin-created roles beyond the three seeded
- [ ] `listRoles()` returns an empty array (not null or undefined) when no roles exist

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, or UI imports
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/assign-role.action.ts` and `revoke-role.action.ts` have no DB access
- [ ] `components/users/role-assignment-panel.tsx` has `'use client'` and imports no service or repository
- [ ] `types/rbac.ts` update (`RoleListItem`) has no runtime code or DB/service imports
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] `vitest run` passes all `assignRoleSchema` / `revokeRoleSchema` unit tests (5 scenarios each)
- [ ] `vitest run` passes all `assignRole` service unit tests (8 scenarios per §12.13)
- [ ] `vitest run` passes all `revokeRole` service unit tests (9 scenarios per §12.13)
- [ ] `vitest run` passes all `assignRoleAction` unit tests (6 scenarios per §12.13)
- [ ] `vitest run` passes all `revokeRoleAction` unit tests (5 scenarios per §12.13)
- [ ] `vitest run` passes all `RoleAssignmentPanel` unit tests (12 scenarios per §12.13)
- [ ] `vitest run` passes all `UserDetail` manageRoles unit tests (9 scenarios per §12.13)
- [ ] Integration tests pass: happy-path assign+revoke, ALREADY_ASSIGNED, LAST_ADMIN_ROLE, unauthorized, audit row assertions

### Scope guard

- [ ] No edit of user name, phone, email, auth method, status, or password was added
- [ ] No disable/enable, unlock, or tombstone functionality was added
- [ ] No new `PERMISSIONS` migration rows were added (`users:EDIT` is already seeded)
- [ ] No schema migrations were added (`ROLE_ASSIGN` schema is fully in place from um05)
- [ ] The `role-assign.repository.ts` stubs from um05 have been replaced with implementations (not added alongside them)
- [ ] The `roles.repository.ts` stubs from um05 have been replaced with implementations
- [ ] `UserTable`, `UsersPage` (beyond the `allRoles` addition), `StatusBadge`, `AuthMethodBadge`, `RoleBadge`, and the admin sidebar are unchanged
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
