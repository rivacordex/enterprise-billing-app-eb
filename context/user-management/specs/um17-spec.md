# Spec: um17 — Tombstone-delete user (DELETE) + `DeleteUserDialog`

- **Boundary:** APP
- **Dependencies:** Unit um13 (`disableUserAction` pattern, `userHasAdminRole`, `countRemainingAdmins`, `deleteUserSessions`, `setUserStatus` repository functions, `UserDetail` Client Component with `permissionMap` prop, `StatusBadge`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `requirePermission`); Unit um08 (`writeAuditEvent`, `users-write.service.ts` structure); Unit um11 (`UserDetail` mode state, `EffectivePermissionMap`, `UserDetailView` type).
- **Source sections:** overview §"User administration" (tombstone-delete: `users:DELETE`; target DISABLED first; row preserved; email/Entra identity reusable), §"Core User Flow" item 8 (offboarding — DISABLED → tombstone), §"Pages — Administration" item 1 (tombstone-delete: needs `users:DELETE`; target DISABLED), §"Data Model" (`APPUSER.status` CHECK, `APPUSER.user_email` partial unique index excluding DELETED; `ROLE_ASSIGN`; `account`), §"Audit Events" (`USER_DELETED` — captures pre-deletion name/email/roles); architecture §2 (folder ownership, boundary rules), §5 (account lifecycle `PENDING → ACTIVE → DISABLED → DELETED`; tombstone: no physical delete, role assignments removed, email/Entra identity reusable), §6 (`users:DELETE` required); code-standards §3 (Server Actions: parse → auth → service → typed result, `revalidatePath`), §7 (file organisation). Invariants: **#3** (server-side authz), **#11** (audit entry atomic with mutation), **#12** (no physical delete — tombstone only), **#13** (last ADMIN-capable account cannot be deleted; DISABLED precondition), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached).

---

## Goal

Implement the tombstone-delete action behind `users:DELETE`: an admin with `users:DELETE` can delete a user whose status is `DISABLED` by setting `status = DELETED`, atomically removing all role assignments and account credential rows, writing `USER_DELETED` capturing the pre-deletion name, email, and role names, and cleaning up any residual session rows — preserving the `APPUSER` row, unblocking the email and Entra identity for reuse via a partial unique index that excludes `DELETED` rows, and rendering a `DeleteUserDialog` confirmation in `UserDetail` that surfaces the action only to actors holding the DELETE level.

---

## Design

### "Delete user" button in `UserDetail`

The `UserDetail` panel gains a "Delete user" button in the panel header. It is placed to the right of "Enable" and left of "Edit":

**Header layout (left → right):** `[user name] — [spacer] — [Enable] [Delete user] [Edit] [×]`

Visibility conditions (all must be true):

- `user.status === 'DISABLED'`
- `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.DELETE)`

The button is never rendered for `ACTIVE`, `PENDING`, or `DELETED` users, nor when the actor lacks `users:DELETE`.

Since DELETE implies EDIT implies READ, an actor who sees "Delete user" also sees "Enable" and "Edit". The three buttons coexist when the user is `DISABLED` and the actor holds `users:DELETE`. When only `users:EDIT` is held (no DELETE), the "Delete user" button is absent — "Enable" and "Edit" remain.

**Button styling:**

```
variant: destructive (filled danger background — more severe than Disable's outline style)
bg: bg-[--color-danger-600]
text: text-white
hover bg: hover:bg-[--color-danger-700]
icon: lucide Trash2 (size 14) + label "Delete user", text-sm
focus ring: --focus-ring
disabled: while any action is in-flight (isDeleting state or mode === 'edit')
```

The filled destructive style distinguishes tombstone (irreversible) from disable (reversible outline danger) at a glance.

### DELETED state — panel header cleanup

When `user.status === 'DELETED'`, the panel header renders **no action buttons** — only the close (×) button:

`[user name — Deleted] — [spacer] — [×]`

The user name in the header gets a muted colour (`text-[--color-neutral-400]`) and a trailing "· Deleted" label in `text-[--color-danger-600] text-xs`. The existing "Edit" button from um11 is also hidden for DELETED users. Field groups remain visible in read-only mode.

### `DeleteUserDialog`

A new `DeleteUserDialog` component using a shadcn `AlertDialog` — not `Dialog` — because the backdrop-click-to-dismiss of `Dialog` is inappropriate for an irreversible action. `AlertDialog` forces an explicit button choice.

**Title:** `"Permanently delete {user.userName}?"`

**Body:** Two paragraphs.

Paragraph 1 — what will happen:

> Deleting **{user.userName}** will:
>
> - Set their account status to DELETED
> - Remove all role assignments
> - Remove their stored credentials
> - Revoke any remaining active sessions

Paragraph 2 — permanence and reuse:

> **This cannot be undone.** The account record is preserved for audit history, but the user will never be able to sign in. Once deleted, their email address and Entra identity can be reused for a new account.

**Self-delete warning** — shown when `targetUserId === actorId` (an admin deleting their own account):

An inline `Alert` (warning variant, `--color-warning-*`) above the body:

> **You are deleting your own account.** You will be signed out and lose all access immediately.

In practice this is unlikely — the last-admin guard prevents the only admin from being disabled, so they can't reach DISABLED status before being tombstoned. But the guard must still display if the preconditions are met.

**Actions:** "Cancel" (ghost, `disabled` while in-flight) + "Delete user" (`variant="destructive"`, shows `Loader2 animate-spin` and becomes `disabled` while in-flight).

**Error display inside the dialog:**

| Code                         | Inline `Alert` message (destructive variant)                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `INVALID_STATE`              | "This user must be disabled before they can be deleted."                                                    |
| `LAST_ADMIN`                 | "Cannot delete this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first." |
| `USER_NOT_FOUND`             | "User not found. The record may have been deleted."                                                         |
| `FORBIDDEN` / `SERVER_ERROR` | toast (error variant) — "Something went wrong. Please try again." — dialog closes                           |

For `INVALID_STATE`, `LAST_ADMIN`, and `USER_NOT_FOUND`, the dialog stays open with the inline error visible so the admin can read the explanation before dismissing. These are informational — the admin needs to act on them (e.g. re-enable before deleting, assign another ADMIN). For server/auth errors, close the dialog and use a toast.

### Post-tombstone UI behaviour

After a successful tombstone, `revalidatePath('/administration/users')` triggers a server re-render. The `UserTable` row's `StatusBadge` updates to `DELETED`. By default DELETED users are hidden behind the "Show deleted" toggle (from um07/um09), so the row may disappear from the visible list. The `UserDetail` panel re-fetches and enters the read-only DELETED header state described above.

---

## Implementation

### 17.1 — Partial unique index migration

Confirm that the migration from um02 created the partial unique index:

```sql
CREATE UNIQUE INDEX idx_appuser_email_active
  ON core.appuser (user_email)
  WHERE status != 'DELETED';
```

If this index was not created in um02, add a new Drizzle migration file in `db/migrations/` that creates it. Do not modify the `appuser` Drizzle table definition's `.unique()` call — use `sql` to create the index directly in the migration, since Drizzle's `.unique()` does not support `WHERE` clauses.

**Verify:** `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'appuser' AND indexname LIKE '%email%'` should show the partial index. The integration test in §17.7 exercises this by creating a new user with the same email as a DELETED user and asserting no unique-constraint violation.

No migration is needed for the `account` table — email/Entra identity reuse is achieved by deleting the `account` rows during tombstone (§17.2.4), removing the OID from the uniqueness surface.

### 17.2 — Repository additions (`db/repositories/app-user.repository.ts`)

Add the functions below to the existing repository file. All mutating functions accept a Drizzle transaction handle; none open their own transactions.

#### 17.2.1 — Extend `setUserStatus` to accept `'DELETED'`

The existing `setUserStatus(tx, userId, status)` from um13 accepts `'ACTIVE' | 'DISABLED'`. Extend the type to:

```ts
export async function setUserStatus(
  tx: DrizzleTransaction,
  userId: string,
  status: "ACTIVE" | "DISABLED" | "DELETED",
): Promise<void>;
```

No logic change — the Drizzle `UPDATE` is the same. Only the TypeScript union widens. Confirm the `APPUSER.status` Drizzle column type already allows `'DELETED'` (it should — the CHECK constraint was defined as `PENDING | ACTIVE | DISABLED | DELETED` in um02).

#### 17.2.2 — `removeUserRoleAssignments(tx, userId): Promise<number>`

```ts
export async function removeUserRoleAssignments(
  tx: DrizzleTransaction,
  userId: string,
): Promise<number>;
```

Deletes all `ROLE_ASSIGN` rows where `ref_user_id = userId`:

```ts
const result = await tx
  .delete(roleAssign)
  .where(eq(roleAssign.refUserId, userId))
  .returning({ id: roleAssign.roleAssignId });

return result.length;
```

Returns the count of deleted rows (included in the before-snapshot as the number of roles removed). Zero rows is not an error — a user with no roles assigned at delete time is valid.

#### 17.2.3 — `deleteAllUserAccounts(tx, userId): Promise<void>`

```ts
export async function deleteAllUserAccounts(
  tx: DrizzleTransaction,
  userId: string,
): Promise<void>;
```

Deletes all rows from the `account` table where `user_id = userId`:

```ts
await tx.delete(account).where(eq(account.userId, userId));
```

This removes both the `'credential'` account row (password hash) and the `'microsoft'` account row (Entra OID) if they exist, releasing the Entra identity for reuse. Zero rows deleted is not an error.

> **Note:** The `account` table is Better-Auth-managed, but direct repository deletion of the user's own account rows on tombstone is intentional — the user is being made permanently inactive and their credentials no longer serve any purpose. All other Better-Auth operations on this user cease after `status = 'DELETED'`.

#### 17.2.4 — `getUserRoleNames(userId: string): Promise<string[]>`

```ts
export async function getUserRoleNames(userId: string): Promise<string[]>;
```

Read-only, no transaction. Returns the `role_name` values for all roles currently assigned to `userId`:

```ts
const rows = await db
  .select({ roleName: roles.roleName })
  .from(roleAssign)
  .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
  .where(eq(roleAssign.refUserId, userId));

return rows.map((r) => r.roleName);
```

Called by the service before the transaction opens to build the before-snapshot. Returns an empty array if the user has no role assignments.

> **Reuse check:** If a prior unit (e.g. the assign/revoke role work) already added a `getUserRoleNames` or equivalent function that returns `string[]`, reuse it and omit this addition.

**Existing functions to reuse from um13 (no changes needed):**

- `findUserById(userId)` — for before-snapshot name/email/status
- `userHasAdminRole(userId)` — for last-admin guard short-circuit
- `countRemainingAdmins(userId)` — for last-admin guard count
- `deleteUserSessions(tx, userId)` — for residual session cleanup

### 17.3 — Service function (`services/users/users-write.service.ts`)

Add `tombstoneDeleteUser` to the existing service file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

```ts
type TombstoneDeleteUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "LAST_ADMIN" };

export async function tombstoneDeleteUser(
  input: DeleteUserInput,
  actorId: string,
): Promise<TombstoneDeleteUserResult>;
```

Steps:

1. **Load current user (before-snapshot base).** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Precondition — DISABLED check.** If `existingUser.status !== 'DISABLED'` → return `{ ok: false, code: 'INVALID_STATE' }`. Tombstone only proceeds from `DISABLED`; `ACTIVE`, `PENDING`, and `DELETED` are all invalid.

3. **Last-admin guard.** Call `appUserRepository.userHasAdminRole(input.userId)`. If `true`, call `appUserRepository.countRemainingAdmins(input.userId)`. If count is `0` → return `{ ok: false, code: 'LAST_ADMIN' }`. If `userHasAdminRole` is `false`, skip the count entirely.

   > **Note:** In practice a DISABLED admin implies at least one other active admin exists (the um13 disable guard enforced it). The check here is defence in depth against data inconsistency or concurrent operations.

4. **Load role names for before-snapshot.** Call `appUserRepository.getUserRoleNames(input.userId)`. Capture result.

5. **Build before-snapshot:**

   ```ts
   const before = {
     userName: existingUser.userName,
     userEmail: existingUser.userEmail,
     status: existingUser.status, // 'DISABLED'
     roles: roleNames, // string[]
   };
   ```

6. **Transaction.** Open a Drizzle transaction and execute atomically in this order:

   a. `await appUserRepository.setUserStatus(tx, input.userId, 'DELETED')`

   b. `await appUserRepository.removeUserRoleAssignments(tx, input.userId)`

   c. `await appUserRepository.deleteAllUserAccounts(tx, input.userId)`

   d. `await appUserRepository.deleteUserSessions(tx, input.userId)` — cleans up any residual sessions. Since the user was DISABLED (um13 deleted sessions at that point), this is typically a no-op; it is included for correctness.

   e. `await writeAuditEvent(tx, {
  eventType:    'USER_DELETED',
  actorUserId:  actorId,
  targetEntity: 'APPUSER',
  targetId:     input.userId,
  beforeData:   before,
  afterData:    { status: 'DELETED' },
})`

7. **Return** `{ ok: true }`.

On any transaction error, propagate — transaction rolls back; all five writes are one atomic unit. No partial state can exist.

### 17.4 — Validation schema (`validation/users.ts`)

Add below the schemas from previous units:

```ts
export const deleteUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
```

No other fields — the `DISABLED` precondition and last-admin guard live in the service, not the schema.

### 17.5 — Server Action (`actions/users/delete-user.action.ts`)

New file. `'use server'`.

```ts
type DeleteUserActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function deleteUserAction(
  rawInput: unknown,
): Promise<DeleteUserActionResult>;
```

Steps:

1. **Auth check.** `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.DELETE)` — wrap in try/catch; re-throw `NEXT_REDIRECT`; other auth failures → `{ ok: false, code: 'FORBIDDEN' }`.

2. **Validate.** `const parsed = deleteUserSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. **Call service.** Wrap in try/catch:

   ```ts
   const result = await usersWriteService.tombstoneDeleteUser(
     parsed.data,
     actorId,
   );
   ```

   On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }`.

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true }`.

No DB access in the action — delegates entirely to `usersWriteService`.

### 17.6 — `DeleteUserDialog` component (`components/users/delete-user-dialog.tsx`)

New file. `'use client'`.

**Props:**

```ts
interface DeleteUserDialogProps {
  targetUserId: string;
  targetUserName: string;
  actorId: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}
```

The parent (`UserDetail`) controls open state, consistent with the disable dialog pattern from um13.

**State:**

```ts
const [isDeleting, setIsDeleting] = useState(false);
const [actionError, setActionError] = useState<
  "INVALID_STATE" | "LAST_ADMIN" | "USER_NOT_FOUND" | null
>(null);
```

Clear `actionError` when `isOpen` transitions from `false` to `true`:

```ts
useEffect(() => {
  if (isOpen) setActionError(null);
}, [isOpen]);
```

**Delete handler:**

```ts
const handleDeleteConfirm = async () => {
  setIsDeleting(true);
  setActionError(null);
  try {
    const result = await deleteUserAction({ userId: targetUserId });
    if (result.ok) {
      onOpenChange(false);
      onSuccess();
    } else if (
      result.code === "INVALID_STATE" ||
      result.code === "LAST_ADMIN" ||
      result.code === "USER_NOT_FOUND"
    ) {
      setActionError(result.code);
      // dialog stays open; error renders inline
    } else {
      toast.error("Something went wrong. Please try again.");
      onOpenChange(false);
    }
  } finally {
    setIsDeleting(false);
  }
};
```

**Render:**

```tsx
<AlertDialog open={isOpen} onOpenChange={isDeleting ? undefined : onOpenChange}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Permanently delete {targetUserName}?</AlertDialogTitle>
    </AlertDialogHeader>

    {isSelfDelete && (
      <Alert variant="warning" className="mb-3">
        <AlertDescription>
          <strong>You are deleting your own account.</strong> You will be signed
          out and lose all access immediately.
        </AlertDescription>
      </Alert>
    )}

    {actionError && (
      <Alert variant="destructive" className="mb-3">
        <AlertDescription>
          {actionError === "INVALID_STATE" &&
            "This user must be disabled before they can be deleted."}
          {actionError === "LAST_ADMIN" &&
            "Cannot delete this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first."}
          {actionError === "USER_NOT_FOUND" &&
            "User not found. The record may have been deleted."}
        </AlertDescription>
      </Alert>
    )}

    <AlertDialogDescription asChild>
      <div className="space-y-3 text-sm">
        <p>
          Deleting <strong>{targetUserName}</strong> will:
        </p>
        <ul className="list-inside list-disc space-y-1 text-[--color-neutral-600]">
          <li>Set their account status to DELETED</li>
          <li>Remove all role assignments</li>
          <li>Remove their stored credentials</li>
          <li>Revoke any remaining active sessions</li>
        </ul>
        <p>
          <strong>This cannot be undone.</strong> The account record is
          preserved for audit history, but the user will never be able to sign
          in. Once deleted, their email address and Entra identity can be reused
          for a new account.
        </p>
      </div>
    </AlertDialogDescription>

    <AlertDialogFooter>
      <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
      <Button
        variant="destructive"
        onClick={handleDeleteConfirm}
        disabled={isDeleting}
      >
        {isDeleting && <Loader2 size={14} className="mr-1 animate-spin" />}
        Delete user
      </Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

`isSelfDelete` is derived: `const isSelfDelete = actorId === targetUserId`.

`onOpenChange` is passed `undefined` while `isDeleting` is true to prevent backdrop/Escape dismissal mid-flight.

### 17.7 — `UserDetail` component update (`components/users/user-detail.tsx`)

The component is a Client Component with existing state from um11 and um13. Add tombstone state and the DELETED header.

**New state:**

```ts
const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
const [isDeleted, setIsDeleted] = useState(false);
```

`isDeleted` is a local optimistic flag — if the Server Action succeeds, set it before `revalidatePath` re-renders the panel so the user sees an immediate header change. Reset it on user change:

```ts
useEffect(() => {
  setIsDeleted(false);
  setIsDeleteDialogOpen(false);
}, [user?.userId]);
```

**Visibility constants (add alongside existing `showDisable` / `showEnable` from um13):**

```ts
const canDelete = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.DELETE);
const showDelete =
  canDelete && user !== null && user.status === "DISABLED" && !isDeleted;
const actionsDisabled =
  mode === "edit" || isDisabling || isEnabling || isDeleteDialogOpen;
```

**DELETED header (rendered when `user.status === 'DELETED'` or `isDeleted`):**

```tsx
{(user.status === 'DELETED' || isDeleted) ? (
  <div className="flex items-center justify-between">
    <h3 className="text-[--color-neutral-400]">
      {user.userName}
      <span className="ml-2 text-xs text-[--color-danger-600]">· Deleted</span>
    </h3>
    <button onClick={onClose} aria-label="Close">
      <X size={16} />
    </button>
  </div>
) : (
  /* existing header with Disable/Enable/Edit/× buttons */
)}
```

**"Delete user" button in the normal header (view mode, after Enable and before Edit):**

```tsx
{
  showDelete && (
    <Button
      variant="destructive"
      size="sm"
      onClick={() => setIsDeleteDialogOpen(true)}
      disabled={actionsDisabled}
    >
      <Trash2 size={14} />
      Delete user
    </Button>
  );
}
```

**Edit button — hide for DELETED:**

Wrap the existing Edit button render with:

```tsx
{user.status !== 'DELETED' && !isDeleted && (
  /* existing Edit button JSX */
)}
```

**`DeleteUserDialog` mount (outside the panel card, alongside the existing `AlertDialog` from um13):**

```tsx
{
  user !== null && (
    <DeleteUserDialog
      targetUserId={user.userId}
      targetUserName={user.userName}
      actorId={actorId}
      isOpen={isDeleteDialogOpen}
      onOpenChange={setIsDeleteDialogOpen}
      onSuccess={() => setIsDeleted(true)}
    />
  );
}
```

`actorId` is already available on `UserDetail` from um16's `actorId` prop addition. If um16 has not been implemented, add `actorId?: string` as a prop here following the same pattern (optional, passed from `UsersPage`).

**No changes to `UsersPage`, `UserTable`, or `UserForm`.**

### 17.8 — Tests

#### Unit tests: schema (`tests/unit/validation/users.test.ts`)

Extend the existing file.

| Input                                    | Expected                      |
| ---------------------------------------- | ----------------------------- |
| `{ userId: valid-uuid }`                 | Passes                        |
| `{ userId: 'not-a-uuid' }`               | Fails; `userId` error present |
| `{}`                                     | Fails; `userId` required      |
| `{ userId: valid-uuid, extra: 'field' }` | Passes; extra fields stripped |

#### Unit tests: repository (`tests/unit/db/app-user-repository.test.ts`)

Extend the existing file. Use a mocked `db` client.

- `setUserStatus` accepts `'DELETED'` without a TypeScript error and calls `tx.update(appuser).set({ status: 'DELETED', lastModifiedDatetime: ... })`.
- `removeUserRoleAssignments` calls `tx.delete(roleAssign).where(eq(roleAssign.refUserId, userId))`.
- `removeUserRoleAssignments` returns `0` when no rows exist — no error.
- `deleteAllUserAccounts` calls `tx.delete(account).where(eq(account.userId, userId))`.
- `getUserRoleNames` returns an array of `roleName` strings from the joined query; empty array when no assignments exist.

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository` and `writeAuditEvent`.

| Scenario                                        | Setup                                                                                                 | Expected                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path — DISABLED user, no admin role       | `findUserById → { status: 'DISABLED' }`, `userHasAdminRole → false`, `getUserRoleNames → ['MANAGER']` | `setUserStatus` called with `'DELETED'`; `removeUserRoleAssignments` called; `deleteAllUserAccounts` called; `deleteUserSessions` called; `writeAuditEvent` called with `USER_DELETED`, `beforeData = { userName, userEmail, status: 'DISABLED', roles: ['MANAGER'] }`, `afterData = { status: 'DELETED' }`; returns `{ ok: true }` |
| Happy path — DISABLED admin, other admins exist | `userHasAdminRole → true`, `countRemainingAdmins → 2`                                                 | Guard passes; proceeds normally                                                                                                                                                                                                                                                                                                     |
| Happy path — user has no roles                  | `getUserRoleNames → []`                                                                               | `beforeData.roles = []`; proceeds without error                                                                                                                                                                                                                                                                                     |
| User not found                                  | `findUserById → null`                                                                                 | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; no DB writes; `writeAuditEvent` not called                                                                                                                                                                                                                                         |
| Precondition: ACTIVE user                       | `findUserById → { status: 'ACTIVE' }`                                                                 | Returns `{ ok: false, code: 'INVALID_STATE' }`; no DB writes                                                                                                                                                                                                                                                                        |
| Precondition: PENDING user                      | `findUserById → { status: 'PENDING' }`                                                                | Returns `{ ok: false, code: 'INVALID_STATE' }`                                                                                                                                                                                                                                                                                      |
| Precondition: already DELETED                   | `findUserById → { status: 'DELETED' }`                                                                | Returns `{ ok: false, code: 'INVALID_STATE' }`                                                                                                                                                                                                                                                                                      |
| Last-admin guard — only remaining admin         | `userHasAdminRole → true`, `countRemainingAdmins → 0`                                                 | Returns `{ ok: false, code: 'LAST_ADMIN' }`; transaction not opened; `writeAuditEvent` not called                                                                                                                                                                                                                                   |
| Non-admin user — count skipped                  | `userHasAdminRole → false`                                                                            | `countRemainingAdmins` NOT called; service proceeds                                                                                                                                                                                                                                                                                 |
| Transaction rollback                            | `removeUserRoleAssignments` throws mid-transaction                                                    | Exception propagates; no partial writes; `writeAuditEvent` not called                                                                                                                                                                                                                                                               |
| `beforeData` shape                              | Happy path                                                                                            | `beforeData` contains `userName`, `userEmail`, `status: 'DISABLED'`, `roles: string[]`; `afterData` contains only `{ status: 'DELETED' }` — no credentials in either                                                                                                                                                                |

#### Unit tests: action (`tests/unit/actions/delete-user.action.test.ts`)

New file. Mock `requirePermission`, `tombstoneDeleteUser` service function, and `revalidatePath`.

| Scenario                       | Setup                                             | Expected                                                                     |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Valid input, ADMIN session     | Service → `{ ok: true }`                          | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called     |
| Invalid UUID                   | `userId = 'not-a-uuid'`                           | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; service not called        |
| User not found                 | Service → `{ ok: false, code: 'USER_NOT_FOUND' }` | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; `revalidatePath` NOT called |
| Invalid state                  | Service → `{ ok: false, code: 'INVALID_STATE' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`                               |
| Last admin                     | Service → `{ ok: false, code: 'LAST_ADMIN' }`     | Returns `{ ok: false, code: 'LAST_ADMIN' }`                                  |
| Unauthorized (no DELETE level) | `requirePermission` throws                        | Returns `{ ok: false, code: 'FORBIDDEN' }`                                   |
| Server error                   | Service throws                                    | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                |

#### Unit tests: `DeleteUserDialog` (`tests/unit/components/users/delete-user-dialog.test.tsx`)

New file. Mock `deleteUserAction`.

- Dialog is not visible when `isOpen = false`.
- Dialog renders title `"Permanently delete {targetUserName}?"` when `isOpen = true`.
- Self-delete warning Alert is rendered when `actorId === targetUserId`.
- Self-delete warning is absent when `actorId !== targetUserId`.
- "Cancel" button calls `onOpenChange(false)` without calling `deleteUserAction`.
- "Delete user" confirm button calls `deleteUserAction({ userId: targetUserId })`.
- While `isDeleting` is true, the confirm button is `disabled` and shows `Loader2`.
- On `{ ok: true }`: `onOpenChange(false)` and `onSuccess()` are called.
- On `{ ok: false, code: 'LAST_ADMIN' }`: inline error with ADMIN message is visible; dialog remains open; `onSuccess` not called.
- On `{ ok: false, code: 'INVALID_STATE' }`: inline error with "must be disabled" message; dialog remains open.
- On `{ ok: false, code: 'USER_NOT_FOUND' }`: inline error with "not found" message; dialog remains open.
- On `{ ok: false, code: 'SERVER_ERROR' }`: `toast.error` called; `onOpenChange(false)` called; `onSuccess` not called.
- `actionError` is cleared when `isOpen` transitions to `true` (re-opening after a prior error shows a clean dialog).

#### Unit tests: `UserDetail` tombstone additions (`tests/unit/components/users/user-detail.test.tsx`)

Extend the existing file. Mock `deleteUserAction`.

- "Delete user" button is rendered when `user.status === 'DISABLED'` and `hasLevel(...DELETE)` is true.
- "Delete user" button is NOT rendered when `user.status === 'ACTIVE'`.
- "Delete user" button is NOT rendered when `user.status === 'PENDING'`.
- "Delete user" button is NOT rendered when `user.status === 'DELETED'`.
- "Delete user" button is NOT rendered when `hasLevel(...DELETE)` is false (only `users:EDIT` held).
- "Edit" button is NOT rendered when `user.status === 'DELETED'`.
- DELETED header renders muted name with "· Deleted" label; no action buttons except close.
- Clicking "Delete user" opens `DeleteUserDialog` (the dialog's title text is visible).
- `DeleteUserDialog` is not open on initial render.
- When `DeleteUserDialog` calls `onSuccess`, the header transitions to the DELETED state (muted name + "· Deleted").
- "Delete user", "Enable", and "Edit" buttons are all `disabled` when `isDeleteDialogOpen` is true.
- "Delete user" and "Enable" are both visible for a DISABLED user when actor holds `users:DELETE` (coexistence).
- Changing the selected user resets `isDeleted` to `false` and closes the dialog.
- Existing disable/enable buttons, edit mode, and all field groups render without regression.

#### Integration tests: tombstone action (`tests/integration/actions/delete-user.action.test.ts`)

New file. Use the test DB with `admin_user` and `no_grants_user` fixtures. Add:

- `target_user`: `APPUSER` with `status = 'DISABLED'`, no roles, no sessions.
- `target_admin_user`: `APPUSER` with `status = 'DISABLED'`, ADMIN role assigned — used for last-admin guard test.

| Session          | Input                            | Expected                                       |
| ---------------- | -------------------------------- | ---------------------------------------------- |
| `admin_user`     | `{ userId: target_user.userId }` | Returns `{ ok: true }`; see assertions below   |
| `no_grants_user` | `{ userId: target_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`     |
| (no session)     | `{ userId: target_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`     |
| `admin_user`     | `{ userId: <ACTIVE user> }`      | Returns `{ ok: false, code: 'INVALID_STATE' }` |

**`admin_user` happy-path assertions:**

- `APPUSER.status = 'DELETED'` for `target_user`.
- `APPUSER.last_modified_datetime` updated.
- No `ROLE_ASSIGN` rows for `target_user`.
- No `account` rows for `target_user`.
- No `session` rows for `target_user`.
- `AUDIT_LOG` has exactly one row: `event_type = 'USER_DELETED'`, `actor_user_id = admin_user.userId`, `target_entity = 'APPUSER'`, `target_id = target_user.userId`.
- `before_data` contains `userName`, `userEmail`, `status: 'DISABLED'`, `roles: []`.
- `after_data` contains `{ status: 'DELETED' }` and nothing else.
- `APPUSER` row still exists (no physical delete).

**Atomicity test:** Fixture with `target_user` having 1 `ROLE_ASSIGN` row and 1 `account` row. Simulate a failure after `removeUserRoleAssignments` but before `deleteAllUserAccounts` (e.g. stub `deleteAllUserAccounts` to throw). Assert: `APPUSER.status` unchanged (`DISABLED`), `ROLE_ASSIGN` row still exists, `account` row still exists, no `AUDIT_LOG` entry.

**Last-admin guard integration test:** Fixture where `target_admin_user` is the only user with ADMIN role and `status = 'DISABLED'` (no other ACTIVE/PENDING admins):

- `deleteUserAction({ userId: target_admin_user.userId })` → `{ ok: false, code: 'LAST_ADMIN' }`.
- `APPUSER.status` unchanged (`DISABLED`); `ROLE_ASSIGN` rows unchanged; no audit entry.

**Email reuse integration test:** After tombstoning `target_user` (email `foo@example.com`):

- Attempt to create a new `APPUSER` with `user_email = 'foo@example.com'` and `status = 'PENDING'`.
- Assert: the insert succeeds — no unique-constraint violation (partial index excludes DELETED).

#### Integration tests: repository (`tests/integration/db/app-user-repository.test.ts`)

Extend the existing file.

- `setUserStatus(tx, userId, 'DELETED')` sets `APPUSER.status = 'DELETED'` and updates `last_modified_datetime`.
- `removeUserRoleAssignments(tx, userId)` deletes the target user's `ROLE_ASSIGN` rows; leaves other users' assignments intact; returns `0` and does not throw when no rows exist.
- `deleteAllUserAccounts(tx, userId)` deletes both `'credential'` and `'microsoft'` account rows for the user; leaves other users' account rows intact; returns without error when no rows exist.
- `getUserRoleNames(userId)` returns an array of role name strings for assigned roles; returns `[]` when the user has no assignments.

---

## Dependencies

No new npm packages. All dependencies (`drizzle-orm`, `better-auth`, `lucide-react`, `zod`, `next`, `react`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — run the CLI only if not already added in a prior unit:

- `npx shadcn@latest add alert-dialog` — the tombstone confirmation modal. Check whether added in um10 or um13; skip if already present.
- `npx shadcn@latest add alert` — inline error display inside the dialog. Check whether added in um11 or um13.

**Lucide icons:** `Trash2` from `lucide-react`. Confirm it is available in the installed version (present since lucide-react 0.265).

No new `PERMISSIONS` migration rows — `users:DELETE` is already seeded (ADMIN holds `users:DELETE` in the default permission matrix). No schema migrations required beyond the partial unique index check in §17.1 (column and status CHECK already in place from um02).

---

## Verification Checklist

### Permission gate

- [ ] `deleteUserAction` is decorated `'use server'`
- [ ] `deleteUserAction` calls `requirePermission(PERMISSIONS.USERS, LEVELS.DELETE)` before any other logic
- [ ] A call with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] A call from a user holding only `users:EDIT` (not DELETE) returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] A call from a user holding `users:DELETE` with a valid DISABLED target returns `{ ok: true }`
- [ ] `PERMISSIONS.USERS` and `LEVELS.DELETE` constants are used (not the raw strings `'users'` / `'DELETE'`)
- [ ] The action contains no DB access — delegates entirely to `usersWriteService`

### Validation

- [ ] A non-UUID `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] An empty or missing `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `revalidatePath` is called on success and NOT called on any error path

### Precondition — DISABLED required

- [ ] `tombstoneDeleteUser` returns `INVALID_STATE` for `ACTIVE` users
- [ ] `tombstoneDeleteUser` returns `INVALID_STATE` for `PENDING` users
- [ ] `tombstoneDeleteUser` returns `INVALID_STATE` for already-`DELETED` users
- [ ] `tombstoneDeleteUser` proceeds only for `DISABLED` users
- [ ] No DB writes occur on `INVALID_STATE`

### Last-admin guard

- [ ] `tombstoneDeleteUser` returns `LAST_ADMIN` when `userHasAdminRole` is true and `countRemainingAdmins` returns `0`
- [ ] `countRemainingAdmins` is NOT called when `userHasAdminRole` returns `false` (short-circuit)
- [ ] DISABLED and DELETED admins are excluded from `countRemainingAdmins` (they were already excluded by um13's implementation)
- [ ] No DB writes occur on `LAST_ADMIN`

### Transactional atomicity

- [ ] `setUserStatus('DELETED')`, `removeUserRoleAssignments`, `deleteAllUserAccounts`, `deleteUserSessions`, and `writeAuditEvent` all execute inside one Drizzle transaction
- [ ] A failure in any of the five steps rolls back all others — no partial state can persist
- [ ] `deleteUserSessions` returning 0 (no residual sessions) does not cause an error or rollback
- [ ] `removeUserRoleAssignments` returning 0 (no role assignments) does not cause an error or rollback

### APPUSER preservation

- [ ] After tombstone, the `APPUSER` row still exists in the database
- [ ] `APPUSER.status = 'DELETED'` and `APPUSER.last_modified_datetime` is updated
- [ ] No `DELETE FROM appuser` statement exists anywhere in the new or modified code

### Role assignments

- [ ] All `ROLE_ASSIGN` rows for the target user are deleted in the same transaction
- [ ] Other users' `ROLE_ASSIGN` rows are not affected

### Account credential cleanup

- [ ] All `account` rows for the target user are deleted in the same transaction
- [ ] Other users' `account` rows are not affected
- [ ] A user with no `account` rows (e.g. PENDING user with no credential and no SSO link) does not cause an error

### Email and Entra identity reuse

- [ ] A new `APPUSER` can be inserted with the same `user_email` as a DELETED user (partial unique index confirmed working)
- [ ] `pg_indexes` shows the partial unique index `WHERE status != 'DELETED'` on `APPUSER.user_email`
- [ ] No `account` row exists for the DELETED user after tombstone, releasing the `provider_account_id` (Entra OID)

### `USER_DELETED` audit event

- [ ] `event_type = 'USER_DELETED'` (exact string matching the registry)
- [ ] `actor_user_id` is the acting admin's `userId`
- [ ] `target_entity = 'APPUSER'`; `target_id` is the deleted user's `userId`
- [ ] `before_data` contains `userName`, `userEmail`, `status: 'DISABLED'`, `roles: string[]`
- [ ] `after_data` contains `{ status: 'DELETED' }` and nothing else — no credential material
- [ ] `before_data` does NOT contain any password hash, Entra OID, or session token
- [ ] The audit entry is written inside the transaction and rolls back with it on failure

### `DeleteUserDialog` UX

- [ ] "Delete user" button is rendered only when `user.status === 'DISABLED'` AND `hasLevel(...DELETE)` is true
- [ ] "Delete user" button is NOT rendered for ACTIVE, PENDING, or DELETED users
- [ ] "Delete user" button is NOT rendered when only `users:EDIT` is held (no DELETE)
- [ ] Clicking "Delete user" opens `DeleteUserDialog`; action is NOT immediately executed
- [ ] Dialog title contains the user's name
- [ ] Dialog body lists all four consequences and the permanence/reuse statement
- [ ] Self-delete warning Alert is shown when `actorId === targetUserId`
- [ ] Self-delete warning is absent when `actorId !== targetUserId`
- [ ] "Cancel" closes the dialog without calling `deleteUserAction`
- [ ] Confirm button is `disabled` and shows `Loader2 animate-spin` while `isDeleting` is true
- [ ] Both "Cancel" and confirm are `disabled` while `isDeleting` is true
- [ ] `onOpenChange` is suppressed while `isDeleting` is true (cannot dismiss mid-flight)
- [ ] On `LAST_ADMIN`: inline error is visible inside the dialog; dialog stays open
- [ ] On `INVALID_STATE`: inline error is visible inside the dialog; dialog stays open
- [ ] On `USER_NOT_FOUND`: inline error is visible inside the dialog; dialog stays open
- [ ] On server error or forbidden: toast is shown; dialog closes
- [ ] Re-opening the dialog after a prior error shows a clean state (no stale `actionError`)

### `UserDetail` — state and DELETED header

- [ ] After a successful tombstone, the header transitions to the DELETED state (muted name + "· Deleted") immediately (before `revalidatePath` re-render)
- [ ] "Edit" button is hidden for DELETED users
- [ ] "Disable", "Enable", and "Delete user" buttons are all hidden for DELETED users
- [ ] Only the close (×) button appears in the header for DELETED users
- [ ] Changing the selected user resets `isDeleted` to `false` and closes the dialog
- [ ] "Delete user" is disabled when `mode === 'edit'` (panel is in edit mode from um11)
- [ ] "Delete user" is disabled while `isDeleteDialogOpen` is true

### Coexistence with um13 Disable/Enable

- [ ] For a DISABLED user with `users:DELETE`: "Enable", "Delete user", and "Edit" buttons all appear in the header
- [ ] For a DISABLED user with only `users:EDIT`: "Enable" and "Edit" appear; "Delete user" is absent
- [ ] Disable/Enable buttons from um13 are unchanged and continue to function correctly
- [ ] No regression in the disable confirmation dialog (`AlertDialog` from um13)

### Repository

- [ ] `setUserStatus` TypeScript union now includes `'DELETED'` — no type error when passing `'DELETED'`
- [ ] `removeUserRoleAssignments` accepts a Drizzle transaction and does not open its own
- [ ] `deleteAllUserAccounts` accepts a Drizzle transaction and does not open its own
- [ ] `getUserRoleNames` is read-only (no transaction argument); uses the main `db` client
- [ ] No business logic or audit writes in any repository function

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod`
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/delete-user.action.ts` has `'use server'` at the top; no DB access
- [ ] `components/users/delete-user-dialog.tsx` has `'use client'`; no DB or service imports
- [ ] `components/users/user-detail.tsx` has `'use client'`; no DB imports
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] Schema unit tests pass (4 scenarios per §17.8)
- [ ] Repository unit tests pass (5 scenarios per §17.8)
- [ ] `tombstoneDeleteUser` service unit tests pass (all 10 scenarios per §17.8)
- [ ] `deleteUserAction` unit tests pass (all 7 scenarios per §17.8)
- [ ] `DeleteUserDialog` unit tests pass (all 13 scenarios per §17.8)
- [ ] `UserDetail` unit tests pass (all 14 tombstone scenarios per §17.8; no regression in existing tests)
- [ ] Integration tests pass: happy path, FORBIDDEN, INVALID_STATE, atomicity rollback, last-admin guard, email reuse
- [ ] Repository integration tests pass: `setUserStatus('DELETED')`, `removeUserRoleAssignments`, `deleteAllUserAccounts`, `getUserRoleNames`

### Scope guard

- [ ] No new `PERMISSIONS` rows added — `users:DELETE` already seeded
- [ ] No schema changes to `APPUSER` or `ROLE_ASSIGN` columns
- [ ] The only migration permitted is the partial unique index on `user_email` if not already in place from um02
- [ ] No physical `DELETE FROM appuser` anywhere in the codebase
- [ ] No self-registration, JIT, or account creation logic added
- [ ] `UserTable`, `UsersPage`, and `UserForm` are unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
