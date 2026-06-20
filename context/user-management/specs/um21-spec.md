# Spec: um21 — Delete role (DELETE)

- **Boundary:** APP
- **Dependencies:** Unit um18 (`RoleDetail`, `RoleTable`, `PermissionLevelTag`, `RoleWithMappings`, `PERMISSION_DISPLAY_NAMES`, `types/roles.ts`, `rolesRepository.findById`, `rolePermissionAssignRepository.findMappingsForRole`, `roles-read.service.ts`); Unit um19 (`roles-write.service.ts`, `validation/roles.ts`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `EffectivePermissionMap`, `requirePermission`); Unit um20 (`PermissionMatrixEditor`, `RoleDetail` receiving `permissionMap`); Unit um05 (RBAC schema — `core.roles`, `core.role_assign`, `core.role_permission_assign`; `types/rbac.ts` — `PERMISSION_NAMES`, `PermissionType`; repository stubs for all four RBAC tables); Unit um03 (`writeAuditEvent` helper).
- **Source sections:** overview §"Roles & permissions" (deletion blocked while assigned; seeded roles permanent), §"Audit Events" (`ROLE_DELETED`), §"Pages — Administration" item 2, §"Guardrails"; architecture §2 (folder ownership, boundary rules), §5 (Inv. #22 — roles in use or seeded are never deleted), §6 (`roles:DELETE` required); code-standards §3 (Server Actions: parse → auth → service → typed result, `revalidatePath`), §4 (styling), §7 (file organization); ui-context §3.3 (interactive / danger tokens), §6 (radius). Invariants: **#3** (always server-side), **#11** (audit entry atomic with mutation), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached), **#22** (roles in use or seeded are never deleted — role deletion writes `ROLE_DELETED`).

---

## Goal

Add `roles:DELETE`-gated deletion to the Roles page: a "Delete" button in the `RoleDetail` panel header opens a `DeleteRoleDialog` (shadcn `AlertDialog`) that, on confirmation, calls `deleteRoleAction`; the service blocks deletion of any role with active `ROLE_ASSIGN` rows or matching a seeded name (ADMIN, MANAGER, USER), then atomically deletes the role's permission mappings, the role row, and writes `ROLE_DELETED` to `AUDIT_LOG`.

---

## Design

### "Delete" button in RoleDetail panel header

The panel header currently renders (from um19/um20): role name `<h3>` + `RoleBadge` on the left; `[Edit][×]` on the right. This unit adds a "Delete" button between Edit and ×:

```
[role name h3 + RoleBadge]          [Edit] [Delete] [×]
```

Visibility: rendered only when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.DELETE)` and `role !== null`.

**Enabled / disabled states:**

- **Non-seeded role:** button fully enabled; clicking opens `DeleteRoleDialog`.
- **Seeded role** (`ADMIN`, `MANAGER`, or `USER`): button rendered but `disabled`; `title` attribute set to `"Seeded roles (ADMIN, MANAGER, USER) cannot be deleted"` for browser tooltip disclosure. The `aria-disabled="true"` attribute is also set. This is a UX affordance; the hard block is in the service.

**Danger ghost styling** (consistent with destructive patterns; never overrides `--action-primary-bg`):

```
border border-[--border-default]
text-[--color-danger-500]
hover:bg-[--color-danger-50]
hover:border-[--color-danger-200]
focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--color-danger-500]
disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none
```

Icon: Lucide `Trash2` (size 14) + label "Delete", `text-sm`, `inline-flex items-center gap-1.5`.

### DeleteRoleDialog

Uses shadcn `AlertDialog` — the correct primitive for irreversible destructive confirmation (no form inputs, no cancel-and-keep-changes semantics). The component is mounted in `RoleDetail` and controlled via a `isDeleteOpen` / `setIsDeleteOpen` boolean state.

**Structure:**

- `AlertDialogTitle`: "Delete role"
- `AlertDialogDescription`: "This will permanently delete the role **{role.roleName}**. This action cannot be undone."
- Inline error `Alert` (danger variant, `--color-danger-50` background, `--color-danger-700` text) rendered between the description and the footer when the action returns an error:
  - `ROLE_IN_USE`: "This role is assigned to {n} user{n === 1 ? '' : 's'}. Revoke all role assignments before deleting."
  - `ROLE_NOT_FOUND`: "Role not found. It may have been deleted by another admin."
  - `FORBIDDEN` / `SERVER_ERROR`: "Something went wrong. Please try again."
- Footer buttons:
  - "Cancel" — `AlertDialogCancel`, secondary style; clears error state on click and closes dialog.
  - "Delete role" — `AlertDialogAction`, destructive style (`bg-[--color-danger-500] hover:bg-[--color-danger-600] text-white`); triggers the action on click.
  - While action is in-flight: "Delete role" button shows a `Loader2` spinner (size 14, `animate-spin`) inline and is `disabled`; "Cancel" is also `disabled` to prevent concurrent interactions.

**On success:**

1. Dialog closes.
2. `router.push('/administration/roles')` — clears `?roleId`, deselecting the panel.
3. `toast.success('Role deleted.')`.

**ROLE_IN_USE behavior:** The dialog does not pre-check ROLE_IN_USE before opening. The check runs server-side when the admin clicks "Delete role." If ROLE_IN_USE is returned, the dialog stays open and renders the error inline with the assigned count. The admin must close the dialog, navigate to the Users page to revoke assignments, then return to delete.

**SEEDED_ROLE behavior via UI:** The "Delete" button is `disabled` for seeded roles, so `DeleteRoleDialog` is never mounted for them. However, the action-level guard still blocks seeded-role deletions regardless of UI state (defense in depth).

---

## Implementation

### 21.1 — `SEEDED_ROLE_NAMES` constant and `isSeededRole` helper (`types/rbac.ts`)

Extend the existing `types/rbac.ts` (not a new file). Add:

```ts
export const SEEDED_ROLE_NAMES = ["ADMIN", "MANAGER", "USER"] as const;
export type SeededRoleName = (typeof SEEDED_ROLE_NAMES)[number];

export function isSeededRole(roleName: string): roleName is SeededRoleName {
  return (SEEDED_ROLE_NAMES as readonly string[]).includes(roleName);
}
```

`isSeededRole` is a pure function with no imports from `db/**`, `auth/**`, or `next/*`. It is used by both the service and the `RoleDetail` component to disable the delete button.

### 21.2 — Validation schema (`validation/roles.ts`)

Extend the existing `validation/roles.ts` from um19/20. Add:

```ts
export const deleteRoleSchema = z.object({
  roleId: z.string().uuid(),
});
export type DeleteRoleInput = z.infer<typeof deleteRoleSchema>;
```

No other changes to the file.

### 21.3 — Repository additions

#### 21.3.1 — `rolesRepository` (`db/repositories/roles.repository.ts`)

Add one function:

**`deleteById(roleId: string, tx: DrizzleTransaction): Promise<void>`**

Executes `DELETE FROM core.roles WHERE role_id = $roleId` using Drizzle's `delete().where(eq(roles.roleId, roleId))`, scoped to the provided transaction. Returns `void`; throws if the row does not exist or if a FK constraint is violated (the FK on `core.role_assign.ref_role_id` will reject the delete if any assignments remain — the service prevents this, but the DB is a final backstop). Does not write audit entries. Does not perform permission checks.

`DrizzleTransaction` is the type inferred from Drizzle's `db.transaction()` callback parameter; define it once in `db/types.ts` as `export type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]` (or the equivalent Drizzle-provided type) and import it across repositories that accept transactions.

#### 21.3.2 — `rolePermissionAssignRepository` (`db/repositories/role-permission-assign.repository.ts`)

Add one function:

**`deleteByRoleId(roleId: string, tx: DrizzleTransaction): Promise<void>`**

Executes `DELETE FROM core.role_permission_assign WHERE ref_role_id = $roleId` using Drizzle's `delete().where(eq(rolePermissionAssign.refRoleId, roleId))`, scoped to the provided transaction. Returns `void`. Does not throw if no rows match (deletion of an unassigned role is valid). Does not write audit entries.

#### 21.3.3 — `roleAssignRepository` (`db/repositories/role-assign.repository.ts`)

This file has a stub from um05. Add one function:

**`countByRoleId(roleId: string, tx: DrizzleTransaction): Promise<number>`**

Executes `SELECT COUNT(*) FROM core.role_assign WHERE ref_role_id = $roleId` within the transaction. Returns the integer count. Used to block deletion when users are still assigned.

### 21.4 — Delete service (`services/roles/roles-write.service.ts`)

Extend the existing `roles-write.service.ts` from um19. Add:

**`deleteRole(input: { roleId: string; actorUserId: string }): Promise<DeleteRoleResult>`**

where `DeleteRoleResult` is:

```ts
type DeleteRoleResult =
  | { ok: true }
  | {
      ok: false;
      code: "ROLE_NOT_FOUND" | "SEEDED_ROLE" | "FORBIDDEN" | "SERVER_ERROR";
    }
  | { ok: false; code: "ROLE_IN_USE"; assignedCount: number };
```

Define `DeleteRoleResult` and export it from `types/roles.ts` (not inline in the service file).

**Algorithm (all steps run inside a single Drizzle `db.transaction()`):**

1. `const role = await rolesRepository.findById(input.roleId, tx)` — if `null`, return `{ ok: false, code: 'ROLE_NOT_FOUND' }`.
2. `if (isSeededRole(role.roleName))` — return `{ ok: false, code: 'SEEDED_ROLE' }`.
3. `const assignedCount = await roleAssignRepository.countByRoleId(input.roleId, tx)` — if `> 0`, return `{ ok: false, code: 'ROLE_IN_USE', assignedCount }`.
4. Capture `before_data` for the audit entry: `{ roleName: role.roleName, roleDescr: role.roleDescr }`. (Permission mappings are captured via `findMappingsForRole` within the same transaction — see step 4a.)
   - `4a`: `const mappings = await rolePermissionAssignRepository.findMappingsForRole(input.roleId, tx)` — used only for `before_data`; the assignments are about to be deleted.
   - `before_data` shape: `{ roleName: role.roleName, roleDescr: role.roleDescr ?? null, permissionMappings: mappings }` where `mappings` is the array of `{ permissionName, permissionType }` objects.
5. `await rolePermissionAssignRepository.deleteByRoleId(input.roleId, tx)` — remove all permission assignments first (FK order).
6. `await rolesRepository.deleteById(input.roleId, tx)` — delete the role row.
7. `await writeAuditEvent({ eventType: 'ROLE_DELETED', actorUserId: input.actorUserId, targetEntity: 'roles', targetId: input.roleId, beforeData: before_data, afterData: null }, tx)` — pass `tx` so the audit write is in the same transaction.
8. Return `{ ok: true }`.

Wrap the entire body in `try/catch`: catch any thrown error, log via `lib/logger`, return `{ ok: false, code: 'SERVER_ERROR' }`.

The service has no imports from `next/*`, `app/**`, or `actions/**`. It does not call `requirePermission` — authorization is the action's responsibility.

`rolesRepository.findById` must accept an optional `tx` parameter for use within a transaction. Update its signature to `findById(roleId: string, tx?: DrizzleTransaction): Promise<Role | null>`, and similarly `findMappingsForRole(roleId: string, tx?: DrizzleTransaction)`. Add the `tx` parameter to these repository functions in a backward-compatible way (optional, defaulting to the module-level `db` client) — no change to call sites that don't pass `tx`.

### 21.5 — Server Action (`actions/roles/delete-role.action.ts`)

New file. `'use server'` at the top.

```ts
"use server";

export async function deleteRoleAction(
  rawInput: unknown,
): Promise<DeleteRoleActionResult>;
```

where `DeleteRoleActionResult` is the discriminated union returned to the client (re-export `DeleteRoleResult` from `types/roles.ts` with a `FORBIDDEN` variant added for action-boundary rejections).

**Algorithm:**

1. `const parsed = deleteRoleSchema.safeParse(rawInput)` — if `!parsed.success`, return `{ ok: false, code: 'SERVER_ERROR' }`. (Malformed UUIDs are a client bug, not a user-facing flow.)
2. `const { user } = await requirePermission(PERMISSIONS.ROLES, LEVELS.DELETE)` — if insufficient, return `{ ok: false, code: 'FORBIDDEN' }`. (`requirePermission` redirects on unauthenticated; on insufficient level in an action context it returns the error rather than redirecting — follow the pattern established in um19/um20.)
3. `const result = await deleteRole({ roleId: parsed.data.roleId, actorUserId: user.id })`.
4. If `result.ok`, call `revalidatePath('/administration/roles')`.
5. Return `result`.

No `try/catch` at the action boundary beyond what the service returns — the service already wraps in `try/catch` and returns `SERVER_ERROR`. No business logic in this file beyond parse → auth → service → revalidate.

### 21.6 — `DeleteRoleDialog` component (`components/roles/delete-role-dialog.tsx`)

Client Component (`'use client'`).

Props:

```ts
interface DeleteRoleDialogProps {
  role: RoleWithMappings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

The component does not own the open state — it is controlled by `RoleDetail`. This is intentional: `RoleDetail` needs to know when the dialog closes (e.g., to clear local error state) and to re-enable the Delete button.

**Internal state:**

```ts
const [isPending, startTransition] = useTransition();
const [error, setError] = useState<string | null>(null);
```

`error` holds the human-readable error message to render in the inline `Alert`. Cleared when `onOpenChange(false)` is called (dialog close/cancel).

**`handleConfirm`:**

```ts
async function handleConfirm() {
  setError(null);
  startTransition(async () => {
    const result = await deleteRoleAction({ roleId: role.roleId });
    if (result.ok) {
      onOpenChange(false);
      router.push("/administration/roles");
      toast.success("Role deleted.");
    } else {
      switch (result.code) {
        case "ROLE_IN_USE":
          setError(
            `This role is assigned to ${result.assignedCount} user${result.assignedCount === 1 ? "" : "s"}. Revoke all role assignments before deleting.`,
          );
          break;
        case "ROLE_NOT_FOUND":
          setError(
            "Role not found. It may have been deleted by another admin.",
          );
          break;
        default:
          setError("Something went wrong. Please try again.");
      }
    }
  });
}
```

**Render:**

```tsx
<AlertDialog
  open={open}
  onOpenChange={(o) => {
    if (!isPending) {
      setError(null);
      onOpenChange(o);
    }
  }}
>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete role</AlertDialogTitle>
      <AlertDialogDescription>
        This will permanently delete the role <strong>{role.roleName}</strong>.
        This action cannot be undone.
      </AlertDialogDescription>
    </AlertDialogHeader>

    {error && (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )}

    <AlertDialogFooter>
      <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onClick={(e) => {
          e.preventDefault();
          handleConfirm();
        }}
        disabled={isPending}
        className="bg-[--color-danger-500] text-white hover:bg-[--color-danger-600] focus-visible:ring-[--color-danger-500]"
      >
        {isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        Delete role
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

`AlertDialogAction`'s default `onClick` triggers `onOpenChange(false)` automatically — override with `e.preventDefault()` so the dialog stays open on error. Closing is handled explicitly in `handleConfirm` on success.

The component imports `deleteRoleAction` from `actions/roles/delete-role.action.ts`, `useRouter` from `next/navigation`, `useTransition`/`useState` from `react`, and shadcn `AlertDialog*` / `Alert*` primitives. No imports from `db/**` or `services/**`.

### 21.7 — `RoleDetail` modifications (`components/roles/role-detail.tsx`)

Add the "Delete" button and wire `DeleteRoleDialog`.

**New local state:**

```ts
const [isDeleteOpen, setIsDeleteOpen] = useState(false);
```

**Props change:** `RoleDetail` already receives `permissionMap: EffectivePermissionMap` from um20. No new props needed.

**Panel header modification** (full panel render only — not in empty/not-found states):

```tsx
<div className="flex items-center justify-between">
  <div className="flex items-center gap-2">
    <h3>{role.roleName}</h3>
    <RoleBadge roleName={role.roleName} />
  </div>
  <div className="flex items-center gap-2">
    {hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT) && (
      <EditButton ... /> {/* existing from um19 */}
    )}
    {hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.DELETE) && (
      <button
        type="button"
        onClick={() => setIsDeleteOpen(true)}
        disabled={isSeededRole(role.roleName)}
        aria-disabled={isSeededRole(role.roleName)}
        title={isSeededRole(role.roleName) ? 'Seeded roles (ADMIN, MANAGER, USER) cannot be deleted' : undefined}
        className="... danger ghost styles ..."
      >
        <Trash2 className="size-3.5" />
        Delete
      </button>
    )}
    <CloseButton ... /> {/* existing × button */}
  </div>
</div>

{isDeleteOpen && (
  <DeleteRoleDialog
    role={role}
    open={isDeleteOpen}
    onOpenChange={setIsDeleteOpen}
  />
)}
```

Mount `DeleteRoleDialog` conditionally only when `isDeleteOpen` is true (avoids mounting an inactive dialog; also resets dialog's internal state on each open).

No other changes to `RoleDetail`'s rendering logic.

### 21.8 — Tests

#### Unit tests: `deleteRole` service (`tests/unit/services/roles-delete.service.test.ts`)

New file. Mock `rolesRepository`, `rolePermissionAssignRepository`, `roleAssignRepository`, `writeAuditEvent`, and `db.transaction` (use a pass-through mock that executes the callback synchronously).

| Scenario                                    | Setup                                                                                               | Expected                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Role not found                              | `findById` returns `null`                                                                           | `{ ok: false, code: 'ROLE_NOT_FOUND' }`                                                                                                                          |
| Seeded role — ADMIN                         | `findById` returns role with `roleName: 'ADMIN'`                                                    | `{ ok: false, code: 'SEEDED_ROLE' }`                                                                                                                             |
| Seeded role — MANAGER                       | `findById` returns `roleName: 'MANAGER'`                                                            | `{ ok: false, code: 'SEEDED_ROLE' }`                                                                                                                             |
| Seeded role — USER                          | `findById` returns `roleName: 'USER'`                                                               | `{ ok: false, code: 'SEEDED_ROLE' }`                                                                                                                             |
| Role in use                                 | `findById` returns non-seeded role; `countByRoleId` returns `3`                                     | `{ ok: false, code: 'ROLE_IN_USE', assignedCount: 3 }`                                                                                                           |
| Role in use — single user                   | `countByRoleId` returns `1`                                                                         | `{ ok: false, code: 'ROLE_IN_USE', assignedCount: 1 }`                                                                                                           |
| Successful deletion — no mappings           | `findById` returns non-seeded role; `countByRoleId` returns `0`; `findMappingsForRole` returns `[]` | `{ ok: true }`; `deleteByRoleId` called; `deleteById` called; `writeAuditEvent` called with `eventType: 'ROLE_DELETED'`, correct `beforeData`, `afterData: null` |
| Successful deletion — with mappings         | `findMappingsForRole` returns 2 entries                                                             | `writeAuditEvent` called with `beforeData.permissionMappings` containing those 2 entries                                                                         |
| Repository throws                           | `deleteById` throws `Error('db failure')`                                                           | `{ ok: false, code: 'SERVER_ERROR' }`                                                                                                                            |
| `deleteByRoleId` called before `deleteById` | Successful path                                                                                     | Verify `rolePermissionAssignRepository.deleteByRoleId` is called before `rolesRepository.deleteById` (check call order)                                          |

#### Unit tests: `isSeededRole` (`tests/unit/types/rbac.test.ts`)

Add to the existing or new file.

- `isSeededRole('ADMIN')` → `true`
- `isSeededRole('MANAGER')` → `true`
- `isSeededRole('USER')` → `true`
- `isSeededRole('CustomRole')` → `false`
- `isSeededRole('')` → `false`
- `isSeededRole('admin')` (lowercase) → `false` (case-sensitive)

#### Unit tests: `DeleteRoleDialog` (`tests/unit/components/roles/delete-role-dialog.test.tsx`)

New file. Mock `deleteRoleAction`, `useRouter`.

- Renders dialog title "Delete role" and role name in description when `open={true}`.
- "Cancel" button calls `onOpenChange(false)`.
- Clicking "Delete role" calls `deleteRoleAction` with `{ roleId: role.roleId }`.
- `ROLE_IN_USE` (assignedCount: 2): error message "This role is assigned to 2 users." is rendered; dialog stays open.
- `ROLE_IN_USE` (assignedCount: 1): error message uses singular "user".
- `ROLE_NOT_FOUND`: error message "Role not found..." rendered; dialog stays open.
- `SERVER_ERROR`: generic error message rendered; dialog stays open.
- Success (`ok: true`): `onOpenChange(false)` called; `router.push('/administration/roles')` called; `toast.success('Role deleted.')` called.
- While pending: "Delete role" button is `disabled`; "Cancel" button is `disabled`.
- Error clears when dialog is closed and reopened (internal `error` state resets because component unmounts when `isDeleteOpen` is false).

#### Unit tests: `RoleDetail` additions (`tests/unit/components/roles/role-detail.test.tsx`)

Extend the existing test file from um18/19/20.

- "Delete" button is rendered in the panel header when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.DELETE)` is true and `role` is non-seeded.
- "Delete" button is NOT rendered when user lacks `roles:DELETE`.
- "Delete" button is `disabled` and has a `title` attribute when `role.roleName` is `'ADMIN'`.
- "Delete" button is `disabled` and has a `title` attribute when `role.roleName` is `'MANAGER'` or `'USER'`.
- "Delete" button is enabled for a non-seeded role.
- Clicking enabled "Delete" button opens `DeleteRoleDialog` (check `isDeleteOpen` causes it to mount).
- `DeleteRoleDialog` is not mounted when `isDeleteOpen` is false.

#### Integration tests: delete service (`tests/integration/services/roles-delete.service.test.ts`)

New file. Uses the test DB seeded with three seeded roles and one custom role (`TEST_ROLE`) with no assignments. Resets between tests.

- `deleteRole({ roleId: adminRoleId, actorUserId })` → `{ ok: false, code: 'SEEDED_ROLE' }`.
- `deleteRole({ roleId: managerRoleId, actorUserId })` → `{ ok: false, code: 'SEEDED_ROLE' }`.
- `deleteRole({ roleId: userRoleId, actorUserId })` → `{ ok: false, code: 'SEEDED_ROLE' }`.
- `deleteRole({ roleId: 'non-existent-uuid', actorUserId })` → `{ ok: false, code: 'ROLE_NOT_FOUND' }`.
- Assign `TEST_ROLE` to a test user; `deleteRole({ roleId: testRoleId, actorUserId })` → `{ ok: false, code: 'ROLE_IN_USE', assignedCount: 1 }`.
- `deleteRole({ roleId: testRoleId, actorUserId })` (no assignments) → `{ ok: true }`; `roles` table no longer contains `testRoleId`; `role_permission_assign` rows for `testRoleId` are gone; `AUDIT_LOG` contains exactly one `ROLE_DELETED` entry with `target_id = testRoleId`, correct `before_data`, `after_data = null`.
- `AUDIT_LOG` entry for successful deletion has `actor_user_id = actorUserId`.
- Seeded roles (`ADMIN`, `MANAGER`, `USER`) still exist in `roles` table after all test cases.

#### Integration tests: repository additions (`tests/integration/db/roles-repository.test.ts`)

Extend the existing file from um18.

- `roleAssignRepository.countByRoleId(roleId)` returns `0` when no assignments exist.
- Assign role to a user; `countByRoleId` returns `1`; assign to a second user; returns `2`.
- `rolePermissionAssignRepository.deleteByRoleId(roleId)` removes all matching rows; `findMappingsForRole(roleId)` returns `[]` afterward.
- `rolesRepository.deleteById(roleId, tx)` removes the role row; subsequent `findById(roleId)` returns `null`.
- `rolesRepository.deleteById(roleId, tx)` raises (FK constraint) if `role_assign` rows still reference the role.

#### Integration tests: action guard (`tests/integration/app/roles-delete-guard.test.ts`)

New file.

| Session                           | Expected                                                             |
| --------------------------------- | -------------------------------------------------------------------- |
| `admin_user` (has `roles:DELETE`) | `deleteRoleAction` proceeds to service; returns service result       |
| `no_grants_user`                  | Returns `{ ok: false, code: 'FORBIDDEN' }`                           |
| (no session)                      | Redirects to `/login` (unauthenticated path via `requirePermission`) |

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `drizzle-orm` — `delete()`, `eq()`, `count()` for repository functions.
- `next` — `revalidatePath`, `useRouter`.
- `react` — `useState`, `useTransition`.
- `lucide-react` — `Trash2` (delete button icon), `Loader2` (spinner; already used in um19/um20).
- shadcn `AlertDialog` primitives — already installed with shadcn/ui.
- shadcn `Alert` — already installed (used in um19 for inline errors).
- `vitest`, `@testing-library/react` — already installed.

No new schema migrations. No new `PERMISSIONS` rows. No new `ROLES` seed rows.

---

## Verification Checklist

### Constant and helper

- [ ] `SEEDED_ROLE_NAMES = ['ADMIN', 'MANAGER', 'USER'] as const` added to `types/rbac.ts`
- [ ] `isSeededRole(roleName)` is exported from `types/rbac.ts` and is a pure function with no external imports
- [ ] `isSeededRole('ADMIN')`, `'MANAGER'`, `'USER'` all return `true`
- [ ] `isSeededRole('CustomRole')` returns `false`
- [ ] `isSeededRole` is case-sensitive (e.g., `'admin'` → `false`)

### Validation

- [ ] `deleteRoleSchema` added to `validation/roles.ts`; accepts a `roleId: z.string().uuid()`
- [ ] `DeleteRoleInput` type is exported
- [ ] Existing create/update schemas in the file are unmodified

### Repositories

- [ ] `rolesRepository.deleteById(roleId, tx)` implemented; uses the provided `tx` exclusively (no module-level `db` call)
- [ ] `rolesRepository.findById` accepts optional `tx` parameter without breaking existing call sites
- [ ] `rolePermissionAssignRepository.deleteByRoleId(roleId, tx)` implemented
- [ ] `rolePermissionAssignRepository.findMappingsForRole` accepts optional `tx` parameter
- [ ] `roleAssignRepository.countByRoleId(roleId, tx)` implemented; returns integer
- [ ] `DrizzleTransaction` type is defined once in `db/types.ts` and imported by all repositories that accept transactions
- [ ] No repository function imports from `auth/`, `services/`, `app/`, or `actions/`

### Service

- [ ] `deleteRole` added to `services/roles/roles-write.service.ts`
- [ ] `DeleteRoleResult` is exported from `types/roles.ts`, not defined inline in the service
- [ ] All steps (find, count, delete mappings, delete role, audit write) execute within a single `db.transaction()`
- [ ] `rolePermissionAssignRepository.deleteByRoleId` is called **before** `rolesRepository.deleteById` (FK order)
- [ ] Seeded role check uses `isSeededRole` from `types/rbac.ts` (not a raw string comparison inline)
- [ ] `before_data` includes `roleName`, `roleDescr`, and `permissionMappings` fetched within the transaction
- [ ] `after_data` is `null`
- [ ] `writeAuditEvent` receives `eventType: 'ROLE_DELETED'` and is called within the same transaction
- [ ] Service catches all thrown errors and returns `{ ok: false, code: 'SERVER_ERROR' }` (no unhandled throws)
- [ ] Service has no imports from `next/*`, `app/**`, or `actions/**`

### Server Action

- [ ] `deleteRoleAction` calls `deleteRoleSchema.safeParse` before any auth check
- [ ] `requirePermission(PERMISSIONS.ROLES, LEVELS.DELETE)` is called; insufficient level returns `{ ok: false, code: 'FORBIDDEN' }` (no redirect from an action)
- [ ] `revalidatePath('/administration/roles')` called only on `result.ok === true`
- [ ] `PERMISSIONS.ROLES` and `LEVELS.DELETE` constants used (not raw strings)
- [ ] File is `'use server'` at the top
- [ ] No business logic beyond parse → auth → service → revalidate

### `DeleteRoleDialog`

- [ ] Uses shadcn `AlertDialog` (not `Dialog`)
- [ ] Dialog title is "Delete role"; description includes `role.roleName` in bold
- [ ] "Delete role" button overrides `AlertDialogAction` default close behavior with `e.preventDefault()`; dialog only closes on success
- [ ] While `isPending`: "Delete role" button shows `Loader2` spinner and is `disabled`; "Cancel" is also `disabled`
- [ ] `ROLE_IN_USE`: inline error with pluralized user count; dialog remains open
- [ ] `ROLE_NOT_FOUND`: inline error; dialog remains open
- [ ] `FORBIDDEN` / `SERVER_ERROR`: generic inline error; dialog remains open
- [ ] On success: `onOpenChange(false)`, `router.push('/administration/roles')`, `toast.success('Role deleted.')` — in that order
- [ ] Error clears when `onOpenChange` is called with `false` (Cancel or external close)
- [ ] No imports from `db/**` or `services/**`

### `RoleDetail` modifications

- [ ] "Delete" button is rendered only when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.DELETE)` is true
- [ ] "Delete" button is NOT rendered when `role` is `null` (empty / not-found state)
- [ ] "Delete" button is `disabled` and has `title` attribute for seeded roles (`ADMIN`, `MANAGER`, `USER`)
- [ ] "Delete" button is enabled (no `disabled`) for non-seeded roles
- [ ] Button order in header: `[Edit] [Delete] [×]`
- [ ] Clicking enabled "Delete" button sets `isDeleteOpen` to `true`
- [ ] `DeleteRoleDialog` mounts only when `isDeleteOpen` is true
- [ ] `isSeededRole` from `types/rbac.ts` is used (not a local inline check)
- [ ] No new props added to `RoleDetail` (uses the `permissionMap` already present from um20)

### Tests

- [ ] All `isSeededRole` unit tests pass (6 cases)
- [ ] All `deleteRole` service unit tests pass (10 cases including call-order verification)
- [ ] All `DeleteRoleDialog` unit tests pass (8 cases)
- [ ] All `RoleDetail` addition tests pass (7 new cases)
- [ ] All delete service integration tests pass
- [ ] All repository integration tests pass
- [ ] All action guard integration tests pass

### Audit

- [ ] `ROLE_DELETED` is the `event_type` (not any other string)
- [ ] `target_entity` is `'roles'`; `target_id` is the deleted role's `roleId`
- [ ] `before_data` contains `roleName`, `roleDescr`, and `permissionMappings`
- [ ] `after_data` is `null`
- [ ] Audit entry is written atomically in the same transaction as the role deletion
- [ ] No audit entry is written for blocked deletions (SEEDED_ROLE, ROLE_IN_USE, ROLE_NOT_FOUND)

### Seeded-role invariant

- [ ] `deleteRole` service returns `SEEDED_ROLE` for `'ADMIN'`, `'MANAGER'`, and `'USER'`
- [ ] The seeded roles still exist in the `roles` table after all delete scenarios in integration tests
- [ ] The UI disables the "Delete" button for seeded roles (`disabled` attribute + `title` tooltip)
- [ ] `deleteRoleAction` with a seeded role ID returns `{ ok: false, code: 'SEEDED_ROLE' }` (bypassing the disabled UI)

### ROLE_IN_USE invariant

- [ ] Service returns `ROLE_IN_USE` when `countByRoleId > 0`, before any DELETE executes
- [ ] `deleteById` and `deleteByRoleId` are NOT called when `ROLE_IN_USE` is returned (mock call verification)
- [ ] Dialog renders the `assignedCount` from the result in the error message

### Boundary enforcement

- [ ] `types/rbac.ts` additions have no import from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `services/roles/roles-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `components/roles/delete-role-dialog.tsx` has no imports from `db/**` or `services/**`
- [ ] `actions/roles/delete-role.action.ts` has no direct DB queries
- [ ] No `console.*` in any new or modified file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules
- [ ] `tsc --noEmit` clean across all new and modified files

### Scope guard

- [ ] No UI changes to `RoleTable` — delete is scoped to `RoleDetail` only
- [ ] No changes to `PermissionMatrixEditor` (um20)
- [ ] No changes to `CreateRoleDialog` or `RoleForm` (um19)
- [ ] No new `PERMISSIONS` migration rows added
- [ ] No schema migrations added
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
