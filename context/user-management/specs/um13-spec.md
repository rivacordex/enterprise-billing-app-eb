# Spec: um13 — Disable / re-enable user (EDIT) + instant revocation + last-admin guard

- **Boundary:** APP
- **Dependencies:** Unit um07 (`UserDetail` panel converted to Client Component, `UserTable`, `types/users.ts` — `UserDetailView`, `UserListItem`, `usersReadService`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, badge components); Unit um08 (`users-write.service.ts`, Server Action pattern, `writeAuditEvent`); Unit um11 (`updateUserDetailsAction` pattern for `actions/users/`, `UserDetail` with `permissionMap` prop, `EffectivePermissionMap`).
- **Source sections:** overview §"User administration" (disable/re-enable, instant session kill), §"Core User Flow" item 8 (offboarding), §"Pages — Administration" item 1 (disable/re-enable — instant), §"Audit Events" (`USER_DISABLED`, `USER_ENABLED`); architecture §2 (folder ownership, boundary rules), §5 (account lifecycle: `PENDING → ACTIVE → DISABLED → DELETED`, instant revocation, last-admin guard), §6 (per-page permission matrix: `users:EDIT`); code-standards §3 (Server Actions, parse-then-call, `revalidatePath`), §4 (styling), §7 (file organization), §8 (permission naming). Invariants: **#3** (server-side authz), **#8** (sessions server-revocable with zero latency), **#11** (audit append-only, atomically with write), **#13** (last ADMIN-capable account cannot be disabled), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached).

---

## Goal

Implement the paired disable and enable user actions behind `users:EDIT`: disabling sets `status = DISABLED` and immediately deletes all of the target's `session` rows inside the same transaction so the user's next request fails at once; enabling sets `status = ACTIVE`; a last-admin guard blocks any disable attempt that would leave zero non-DISABLED, non-DELETED ADMIN-role users; both state transitions write `USER_DISABLED` / `USER_ENABLED` to the audit log atomically with the status update.

---

## Design

### Disable / Enable buttons in `UserDetail`

The `UserDetail` panel gains two mutually exclusive action buttons rendered in the panel header alongside the existing "Edit" button from um11. Only one is visible at a time based on the target user's current status:

- **"Disable" button** — visible when `user.status` is `ACTIVE` or `PENDING` AND `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)`. Danger outline style (see §Button styling).
- **"Enable" button** — visible when `user.status` is `DISABLED` AND `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)`. Primary outline style.
- Neither button is rendered when `user.status` is `DELETED` or when no user is selected.

Both buttons are disabled while the panel is in edit mode (`mode === 'edit'`) from um11 to prevent concurrent mutations.

**Panel header layout** (left to right): `[user name / "Edit User Details"] — [spacer] — [Disable | Enable] [Edit] [×]`. All three action buttons and the close button share one `<div className="flex items-center gap-2">` on the right side of the header.

### Disable confirmation dialog

Disabling a user kills their sessions immediately. Before executing, a shadcn `AlertDialog` confirmation modal is shown:

- **Title:** "Disable {user.userName}?"
- **Body:** "This will immediately end all of {user.userName}'s active sessions. They will be blocked from signing in until re-enabled."
- **Actions:** "Cancel" (ghost) + "Disable user" (destructive, danger bg).
- The dialog is opened by clicking "Disable" and closed by either Cancel or a completed action (success or error).
- The "Disable user" confirm button shows a `Loader2 animate-spin` icon and becomes `disabled` while the action is in-flight.

### Enable action

Enabling does not require a confirmation dialog — it is non-destructive and the admin can see the current `DISABLED` status clearly before clicking. Clicking "Enable" executes the action immediately. The button shows a loading spinner while in-flight and is disabled during that period.

### Error feedback

- **Last-admin blocked** (`LAST_ADMIN`): inline destructive shadcn `Alert` inside the dialog (disable) or below the button (enable, though this code path cannot occur for enable): "Cannot disable this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first."
- **User not found** (`USER_NOT_FOUND`): inline `Alert` — "User not found. The record may have been deleted."
- **Invalid state** (`INVALID_STATE`): inline `Alert` — "This action cannot be applied to a user with status {current status}." (Edge case: concurrent state change between load and submit.)
- **Server error** / **Forbidden**: toast notification (error variant) — "Something went wrong. Please try again."

On a successful disable or enable the dialog closes (if open), the panel returns to its normal header, and `revalidatePath` triggers a server re-render so both the `UserDetail` `StatusBadge` and the `UserTable` row reflect the new status immediately.

### Button styling

**"Disable" button:**

```
variant: outline, danger colours
border: border-[--color-danger-300]
text: text-[--color-danger-700]
hover bg: hover:bg-[--color-danger-50]
icon: lucide Ban (size 14) + label "Disable", text-sm
focus ring: --focus-ring
```

**"Enable" button:**

```
variant: outline, success/primary colours
border: border-[--color-success-300]
text: text-[--color-success-700]
hover bg: hover:bg-[--color-success-50]
icon: lucide CheckCircle (size 14) + label "Enable", text-sm
focus ring: --focus-ring
```

Both buttons are `disabled` while any action is in-flight (`isDisabling` or `isEnabling` state is true).

---

## Implementation

### 13.1 — Zod validation schemas (`validation/users.ts`)

Extend the existing file. Add below the schemas from um11:

```ts
export const disableUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export const enableUserSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type DisableUserInput = z.infer<typeof disableUserSchema>;
export type EnableUserInput = z.infer<typeof enableUserSchema>;
```

Both schemas are intentionally minimal — the status transition logic lives in the service, not the schema. `userId` is validated as a UUID string; an invalid UUID returns a `VALIDATION_ERROR` before any DB access.

### 13.2 — Repository functions (`db/repositories/app-user.repository.ts`)

Add four functions to the existing repository file. No business logic; no audit writes; all functions that mutate accept a Drizzle transaction handle and do not open their own transactions.

#### 13.2.1 — `setUserStatus(tx, userId, status): Promise<void>`

```ts
export async function setUserStatus(
  tx: DrizzleTransaction,
  userId: string,
  status: "ACTIVE" | "DISABLED",
): Promise<void>;
```

Drizzle update inside the caller-supplied transaction:

```ts
await tx
  .update(appuser)
  .set({ status, lastModifiedDatetime: new Date() })
  .where(eq(appuser.userId, userId));
```

Does not return the updated row. Used for both the disable path (`status = 'DISABLED'`) and the enable path (`status = 'ACTIVE'`).

#### 13.2.2 — `deleteUserSessions(tx, userId): Promise<number>`

```ts
export async function deleteUserSessions(
  tx: DrizzleTransaction,
  userId: string,
): Promise<number>;
```

Drizzle delete inside the caller-supplied transaction:

```ts
const result = await tx.delete(session).where(eq(session.userId, userId));
```

Returns the count of deleted rows (for audit context — the service may include it in logs but does not expose it in the action result). Zero deleted rows is not an error — a user with no active sessions is still disabled correctly.

#### 13.2.3 — `countRemainingAdmins(userId: string): Promise<number>`

```ts
export async function countRemainingAdmins(userId: string): Promise<number>;
```

No transaction argument — this is a read-only query run before the transaction opens to evaluate the guard. Uses the main `db` client (not a tx).

Drizzle query: count distinct `APPUSER.user_id` values that:

- Have at least one `ROLE_ASSIGN` row joining to `ROLES` where `role_name = 'ADMIN'`
- Have `APPUSER.status NOT IN ('DISABLED', 'DELETED')`
- Have `APPUSER.user_id != userId` (exclude the target being disabled)

```ts
const rows = await db
  .select({ count: count() })
  .from(appuser)
  .innerJoin(roleAssign, eq(roleAssign.refUserId, appuser.userId))
  .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
  .where(
    and(
      eq(roles.roleName, "ADMIN"),
      notInArray(appuser.status, ["DISABLED", "DELETED"]),
      ne(appuser.userId, userId),
    ),
  );

return rows[0]?.count ?? 0;
```

Returns the count of admins that would remain active/pending if `userId` were disabled. If this returns `0` and the target has the ADMIN role, the disable is blocked.

#### 13.2.4 — `userHasAdminRole(userId: string): Promise<boolean>`

```ts
export async function userHasAdminRole(userId: string): Promise<boolean>;
```

Read-only, no transaction. Checks whether the target user has the ADMIN role assigned:

```ts
const rows = await db
  .select({ roleId: roles.roleId })
  .from(roleAssign)
  .innerJoin(roles, eq(roles.roleId, roleAssign.refRoleId))
  .where(and(eq(roleAssign.refUserId, userId), eq(roles.roleName, "ADMIN")))
  .limit(1);

return rows.length > 0;
```

Called by the service before `countRemainingAdmins` to short-circuit the more expensive count for non-ADMIN users.

**Note:** `findUserById` (an existing repository function from um09/um10/um11) is reused by the service for before-snapshot reads. Confirm the function exists and returns at minimum `{ userId, userName, status, authMethod }`.

### 13.3 — Service functions (`services/users/users-write.service.ts`)

Add two functions to the existing service file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

#### 13.3.1 — `disableUser(input, actorId): Promise<DisableUserResult>`

```ts
type DisableUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "INVALID_STATE" };

export async function disableUser(
  input: DisableUserInput,
  actorId: string,
): Promise<DisableUserResult>;
```

Steps:

1. **Load current user (before-snapshot).** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **State guard.** If `existingUser.status` is `DISABLED` or `DELETED` → return `{ ok: false, code: 'INVALID_STATE' }`. (Only ACTIVE and PENDING users can be disabled.)

3. **Last-admin guard.** Call `appUserRepository.userHasAdminRole(input.userId)`. If `true`, call `appUserRepository.countRemainingAdmins(input.userId)`. If the count is `0` → return `{ ok: false, code: 'LAST_ADMIN' }`. If `userHasAdminRole` returns `false`, skip the count query entirely.

4. **Capture before-state:**

   ```ts
   const before = { status: existingUser.status };
   ```

5. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await setUserStatus(tx, input.userId, 'DISABLED')`

   b. `await deleteUserSessions(tx, input.userId)` — instant revocation; zero deleted rows is acceptable.

   c. `await writeAuditEvent(tx, { eventType: 'USER_DISABLED', actorUserId: actorId, targetEntity: 'APPUSER', targetId: input.userId, beforeData: before, afterData: { status: 'DISABLED' } })`

6. **Return** `{ ok: true }`.

On any transaction error, let the exception propagate — the transaction rolls back; no partial writes (status change, session deletions, and audit entry are one atomic unit).

#### 13.3.2 — `enableUser(input, actorId): Promise<EnableUserResult>`

```ts
type EnableUserResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" };

export async function enableUser(
  input: EnableUserInput,
  actorId: string,
): Promise<EnableUserResult>;
```

Steps:

1. **Load current user (before-snapshot).** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **State guard.** If `existingUser.status` is not `DISABLED` → return `{ ok: false, code: 'INVALID_STATE' }`. (Only DISABLED users can be enabled. PENDING users re-activate via the normal first-login flow; DELETED users cannot be re-enabled.)

3. **Capture before-state:**

   ```ts
   const before = { status: "DISABLED" };
   ```

4. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await setUserStatus(tx, input.userId, 'ACTIVE')` — enable always sets ACTIVE regardless of what the status was prior to disabling.

   b. `await writeAuditEvent(tx, { eventType: 'USER_ENABLED', actorUserId: actorId, targetEntity: 'APPUSER', targetId: input.userId, beforeData: before, afterData: { status: 'ACTIVE' } })`

5. **Return** `{ ok: true }`.

No session creation is needed — the user will authenticate normally via SSO or LOCAL on their next sign-in attempt.

### 13.4 — Server Actions

#### 13.4.1 — `disableUserAction` (`actions/users/disable-user.action.ts`)

New file. `'use server'`.

```ts
type DisableUserActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "LAST_ADMIN" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function disableUserAction(
  rawInput: unknown,
): Promise<DisableUserActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — wrap in try/catch; re-throw `NEXT_REDIRECT`; other auth failures → `{ ok: false, code: 'FORBIDDEN' }`.

2. `const parsed = disableUserSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Wrap service call in try/catch:

   ```ts
   const result = await usersWriteService.disableUser(parsed.data, actorId);
   ```

   On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }` (pass service codes through directly).

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true }`.

The action has no DB access — delegates entirely to `usersWriteService`.

#### 13.4.2 — `enableUserAction` (`actions/users/enable-user.action.ts`)

New file. `'use server'`. Mirrors the disable action structure.

```ts
type EnableUserActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function enableUserAction(
  rawInput: unknown,
): Promise<EnableUserActionResult>;
```

Steps:

1. `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — same pattern as disable.
2. `enableUserSchema.safeParse(rawInput)` — validation.
3. `usersWriteService.enableUser(parsed.data, actorId)` — wrapped in try/catch → `SERVER_ERROR`.
4. Pass service codes through. No `LAST_ADMIN` code for enable (not applicable).
5. `revalidatePath('/administration/users')` on success.
6. Return `{ ok: true }`.

### 13.5 — `UserDetail` component update (`components/users/user-detail.tsx`)

The component is already a Client Component with `mode` state and `permissionMap` prop from um11. This unit adds disable/enable state and handlers.

**New state:**

```ts
const [isConfirmOpen, setIsConfirmOpen] = useState(false); // AlertDialog visibility
const [isDisabling, setIsDisabling] = useState(false); // disable action in-flight
const [isEnabling, setIsEnabling] = useState(false); // enable action in-flight
const [actionError, setActionError] = useState<
  "LAST_ADMIN" | "USER_NOT_FOUND" | "INVALID_STATE" | null
>(null);
```

Clear `actionError` whenever the selected user changes:

```ts
useEffect(() => {
  setActionError(null);
  setIsConfirmOpen(false);
}, [user?.userId]);
```

**Disable handler:**

```ts
const handleDisableConfirm = async () => {
  if (!user) return;
  setIsDisabling(true);
  setActionError(null);
  try {
    const result = await disableUserAction({ userId: user.userId });
    if (result.ok) {
      setIsConfirmOpen(false);
      // revalidatePath triggers server re-render; updated status arrives in next render
    } else if (
      result.code === "LAST_ADMIN" ||
      result.code === "USER_NOT_FOUND" ||
      result.code === "INVALID_STATE"
    ) {
      setActionError(result.code);
    } else {
      toast.error("Something went wrong. Please try again.");
      setIsConfirmOpen(false);
    }
  } finally {
    setIsDisabling(false);
  }
};
```

**Enable handler:**

```ts
const handleEnable = async () => {
  if (!user) return;
  setIsEnabling(true);
  setActionError(null);
  try {
    const result = await enableUserAction({ userId: user.userId });
    if (result.ok) {
      // revalidatePath triggers server re-render
    } else if (
      result.code === "USER_NOT_FOUND" ||
      result.code === "INVALID_STATE"
    ) {
      setActionError(result.code);
    } else {
      toast.error("Something went wrong. Please try again.");
    }
  } finally {
    setIsEnabling(false);
  }
};
```

**Button visibility logic** (in the view-mode panel header):

```tsx
const canEdit = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT);
const showDisable =
  canEdit &&
  user !== null &&
  (user.status === "ACTIVE" || user.status === "PENDING");
const showEnable = canEdit && user !== null && user.status === "DISABLED";
const actionsDisabled = mode === "edit" || isDisabling || isEnabling;
```

**Panel header render (view mode):**

```tsx
<div className="flex items-center justify-between">
  <h3>{user.userName}</h3>
  <div className="flex items-center gap-2">
    {showDisable && (
      <Button
        variant="outline"
        size="sm"
        className="border-danger-300 text-danger-700 hover:bg-danger-50"
        onClick={() => {
          setActionError(null);
          setIsConfirmOpen(true);
        }}
        disabled={actionsDisabled}
      >
        <Ban size={14} />
        Disable
      </Button>
    )}
    {showEnable && (
      <Button
        variant="outline"
        size="sm"
        className="border-success-300 text-success-700 hover:bg-success-50"
        onClick={handleEnable}
        disabled={actionsDisabled}
      >
        {isEnabling ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <CheckCircle size={14} />
        )}
        Enable
      </Button>
    )}
    {/* existing Edit button from um11 */}
    {/* existing × close button */}
  </div>
</div>
```

**Inline error alert** (rendered above the field groups when `actionError` is set, in view mode):

```tsx
{
  actionError && (
    <Alert variant="destructive">
      <AlertDescription>
        {actionError === "LAST_ADMIN" &&
          "Cannot disable this user — they are the only remaining ADMIN. Assign the ADMIN role to another user first."}
        {actionError === "USER_NOT_FOUND" &&
          "User not found. The record may have been deleted."}
        {actionError === "INVALID_STATE" &&
          "This action cannot be applied to a user in their current state."}
      </AlertDescription>
    </Alert>
  );
}
```

**Confirmation dialog** (rendered outside the panel card, always mounted when a user is selected):

```tsx
<AlertDialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Disable {user?.userName}?</AlertDialogTitle>
      <AlertDialogDescription>
        This will immediately end all of {user?.userName}'s active sessions.
        They will be blocked from signing in until re-enabled.
      </AlertDialogDescription>
    </AlertDialogHeader>

    {actionError && (
      <Alert variant="destructive" className="mt-2">
        <AlertDescription>
          {/* same error message map as above */}
        </AlertDescription>
      </Alert>
    )}

    <AlertDialogFooter>
      <AlertDialogCancel disabled={isDisabling}>Cancel</AlertDialogCancel>
      <Button
        variant="destructive"
        onClick={handleDisableConfirm}
        disabled={isDisabling}
      >
        {isDisabling ? (
          <Loader2 size={14} className="mr-1 animate-spin" />
        ) : null}
        Disable user
      </Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

When the action returns `LAST_ADMIN`, the dialog stays open and renders the inline error inside `AlertDialogContent` so the admin can read the explanation before dismissing. For `USER_NOT_FOUND` or `INVALID_STATE`, the dialog closes and the error renders in the panel.

**No changes to `UsersPage`, `UserTable`, or `UserForm`** — this unit modifies only `UserDetail` and adds new actions/service functions/repository functions.

### 13.6 — `UserListItem` and `StatusBadge` (no changes required)

`UserListItem.status` and `UserDetail.status` already carry the `UserStatus` union from `types/users.ts`. The `StatusBadge` already renders `DISABLED` correctly with `Ban` icon and danger-50/700 tokens from um07. The `revalidatePath` after a successful action causes the page to re-fetch and the table row's badge updates automatically. No component changes needed.

### 13.7 — Tests

#### Unit tests: schemas (`tests/unit/validation/users.test.ts`)

Extend the existing file. Cover `disableUserSchema` and `enableUserSchema`:

| Input                                    | Expected                                                             |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `{ userId: valid-uuid }`                 | Passes for both schemas                                              |
| `{ userId: 'not-a-uuid' }`               | Fails; `userId` error for both schemas                               |
| `{}` (empty)                             | Fails; `userId` required for both schemas                            |
| `{ userId: valid-uuid, extra: 'field' }` | Passes; extra fields stripped (Drizzle strict mode not applied here) |

#### Unit tests: repository (`tests/unit/db/app-user-repository.test.ts`)

New test file (or extend). Use a mocked `db` client — not the integration test DB. Focus on the query shape only; integration tests cover actual DB results.

- `setUserStatus` calls `tx.update(appuser).set({ status: 'DISABLED', lastModifiedDatetime: ... })` with the correct `userId`.
- `deleteUserSessions` calls `tx.delete(session).where(eq(session.userId, userId))`.
- `deleteUserSessions` returns `0` when no sessions exist — no error thrown.
- `countRemainingAdmins` query excludes the target `userId` from the count.
- `userHasAdminRole` returns `true` when a matching `ROLE_ASSIGN` + `ROLES` row exists; `false` otherwise.

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository` and `writeAuditEvent`.

**`disableUser` scenarios:**

| Scenario                           | Setup                                                              | Expected                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path — ACTIVE user disabled  | `findUserById → { status: 'ACTIVE' }`, `userHasAdminRole → false`  | `setUserStatus` called with `'DISABLED'`; `deleteUserSessions` called; `writeAuditEvent` called with `USER_DISABLED`, `beforeData = { status: 'ACTIVE' }`, `afterData = { status: 'DISABLED' }`; returns `{ ok: true }` |
| Happy path — PENDING user disabled | `findUserById → { status: 'PENDING' }`, `userHasAdminRole → false` | Same pattern; `beforeData = { status: 'PENDING' }`                                                                                                                                                                      |
| User not found                     | `findUserById → null`                                              | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; no DB writes; `writeAuditEvent` not called                                                                                                                             |
| Already DISABLED                   | `findUserById → { status: 'DISABLED' }`                            | Returns `{ ok: false, code: 'INVALID_STATE' }`; no DB writes                                                                                                                                                            |
| DELETED user                       | `findUserById → { status: 'DELETED' }`                             | Returns `{ ok: false, code: 'INVALID_STATE' }`; no DB writes                                                                                                                                                            |
| Last-admin guard triggered         | `userHasAdminRole → true`, `countRemainingAdmins → 0`              | Returns `{ ok: false, code: 'LAST_ADMIN' }`; transaction not opened; `writeAuditEvent` not called                                                                                                                       |
| Admin user, other admins remain    | `userHasAdminRole → true`, `countRemainingAdmins → 2`              | Guard passes; disable proceeds normally                                                                                                                                                                                 |
| Non-admin user, no count query     | `userHasAdminRole → false`                                         | `countRemainingAdmins` NOT called; disable proceeds                                                                                                                                                                     |
| Transaction rollback               | `setUserStatus` throws mid-transaction                             | Exception propagates; `writeAuditEvent` not called; no partial write                                                                                                                                                    |

**`enableUser` scenarios:**

| Scenario                           | Setup                                   | Expected                                                                                                                                                                                |
| ---------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path — DISABLED user enabled | `findUserById → { status: 'DISABLED' }` | `setUserStatus` called with `'ACTIVE'`; `writeAuditEvent` called with `USER_ENABLED`, `beforeData = { status: 'DISABLED' }`, `afterData = { status: 'ACTIVE' }`; returns `{ ok: true }` |
| User not found                     | `findUserById → null`                   | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; no DB writes                                                                                                                           |
| Non-DISABLED user — ACTIVE         | `findUserById → { status: 'ACTIVE' }`   | Returns `{ ok: false, code: 'INVALID_STATE' }`; no DB writes                                                                                                                            |
| Non-DISABLED user — PENDING        | `findUserById → { status: 'PENDING' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`                                                                                                                                          |
| Non-DISABLED user — DELETED        | `findUserById → { status: 'DELETED' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`                                                                                                                                          |
| Transaction rollback               | `setUserStatus` throws                  | Exception propagates; `writeAuditEvent` not called                                                                                                                                      |

#### Unit tests: actions (`tests/unit/actions/`)

Two new test files. Mock `requirePermission`, the relevant service function, and `revalidatePath`.

**`disable-user.action.test.ts`:**

| Scenario                   | Setup                                             | Expected                                                                 |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Valid input, ADMIN session | Service → `{ ok: true }`                          | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called |
| Invalid UUID               | `userId = 'not-a-uuid'`                           | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; service not called    |
| Last admin                 | Service → `{ ok: false, code: 'LAST_ADMIN' }`     | Returns `{ ok: false, code: 'LAST_ADMIN' }`; `revalidatePath` NOT called |
| User not found             | Service → `{ ok: false, code: 'USER_NOT_FOUND' }` | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`                          |
| Invalid state              | Service → `{ ok: false, code: 'INVALID_STATE' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`                           |
| Unauthorized               | `requirePermission` throws                        | Returns `{ ok: false, code: 'FORBIDDEN' }`                               |
| Server error               | Service throws                                    | Returns `{ ok: false, code: 'SERVER_ERROR' }`                            |

**`enable-user.action.test.ts`:**

| Scenario                   | Setup                                             | Expected                                                                 |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Valid input, ADMIN session | Service → `{ ok: true }`                          | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called |
| Invalid UUID               | `userId = 'not-a-uuid'`                           | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`                        |
| User not found             | Service → `{ ok: false, code: 'USER_NOT_FOUND' }` | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`                          |
| Invalid state              | Service → `{ ok: false, code: 'INVALID_STATE' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`                           |
| Unauthorized               | `requirePermission` throws                        | Returns `{ ok: false, code: 'FORBIDDEN' }`                               |
| Server error               | Service throws                                    | Returns `{ ok: false, code: 'SERVER_ERROR' }`                            |

#### Unit tests: `UserDetail` disable/enable UI (`tests/unit/components/user-detail.test.tsx`)

Extend the existing test file (established in um11). Mock `disableUserAction` and `enableUserAction`.

- "Disable" button is rendered when user status is `ACTIVE` and `hasLevel(...EDIT)` is true.
- "Disable" button is rendered when user status is `PENDING` and `hasLevel(...EDIT)` is true.
- "Enable" button is rendered when user status is `DISABLED` and `hasLevel(...EDIT)` is true.
- Neither button is rendered when user status is `DELETED`.
- Neither button is rendered when `hasLevel(...EDIT)` is false.
- Clicking "Disable" opens the confirmation `AlertDialog` (title "Disable {userName}?" is visible).
- Clicking "Cancel" in the dialog closes it without calling `disableUserAction`.
- Clicking "Disable user" in the dialog calls `disableUserAction({ userId })`.
- While `isDisabling` is true, the "Disable user" confirm button is `disabled` and shows a spinner.
- When `disableUserAction` returns `{ ok: false, code: 'LAST_ADMIN' }`, the inline error message about ADMIN is visible inside the dialog; the dialog remains open.
- When `disableUserAction` returns `{ ok: false, code: 'USER_NOT_FOUND' }`, the dialog closes and the inline error appears in the panel.
- When `disableUserAction` returns `{ ok: true }`, the dialog closes.
- Clicking "Enable" calls `enableUserAction({ userId })` without a dialog.
- While `isEnabling` is true, the "Enable" button is `disabled` and shows a spinner.
- When `enableUserAction` returns `{ ok: false, code: 'USER_NOT_FOUND' }`, the inline error appears in the panel.
- When `enableUserAction` returns `{ ok: true }`, no error is shown.
- "Disable" and "Enable" buttons are `disabled` when `mode === 'edit'` (panel is in edit mode from um11).
- Changing the selected user (`user.userId`) clears `actionError` and closes the dialog.
- Existing read-only view mode, Edit button, close button, and all field groups render without regression.

#### Integration tests: disable action (`tests/integration/actions/disable-user.action.test.ts`)

Use the test DB with `admin_user` and `no_grants_user`. Fixtures: a `target_user` APPUSER with status `ACTIVE`; a live `session` row for `target_user`.

| Session        | Input                            | Expected                                                                                                                              |
| -------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| admin_user     | `{ userId: target_user.userId }` | Returns `{ ok: true }`; `APPUSER.status = 'DISABLED'`; `session` row for `target_user` deleted; `AUDIT_LOG` has `USER_DISABLED` entry |
| no_grants_user | `{ userId: target_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                                            |
| (no session)   | `{ userId: target_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                                            |

For the `admin_user` happy-path test, assert:

- `AUDIT_LOG` row: `event_type = 'USER_DISABLED'`, `actor_user_id = admin_user.userId`, `target_entity = 'APPUSER'`, `target_id = target_user.userId`.
- `before_data` JSON contains `{ status: 'ACTIVE' }`.
- `after_data` JSON contains `{ status: 'DISABLED' }`.
- `APPUSER.last_modified_datetime` is greater than the value before the call.
- The `session` row for `target_user` no longer exists.
- Status update, session deletion, and audit entry are atomic: simulate a write failure mid-transaction and assert none of the three are committed.

**Last-admin guard integration test:** Fixture where `admin_user` is the only ACTIVE/PENDING user with ADMIN role:

- `disableUserAction({ userId: admin_user.userId })` → returns `{ ok: false, code: 'LAST_ADMIN' }`.
- `APPUSER.status` remains `ACTIVE`; no sessions deleted; no audit entry written.

#### Integration tests: enable action (`tests/integration/actions/enable-user.action.test.ts`)

Fixture: `target_user` with status `DISABLED`, no active sessions.

| Session        | Input                            | Expected                                                                                  |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------------- |
| admin_user     | `{ userId: target_user.userId }` | Returns `{ ok: true }`; `APPUSER.status = 'ACTIVE'`; `AUDIT_LOG` has `USER_ENABLED` entry |
| no_grants_user | `{ userId: target_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                |

For the `admin_user` happy-path test, assert:

- `AUDIT_LOG` row: `event_type = 'USER_ENABLED'`, `actor_user_id = admin_user.userId`, `target_entity = 'APPUSER'`, `target_id = target_user.userId`.
- `before_data` JSON contains `{ status: 'DISABLED' }`.
- `after_data` JSON contains `{ status: 'ACTIVE' }`.
- `APPUSER.last_modified_datetime` updated.

**Invalid-state integration test:** Attempt `enableUserAction({ userId: active_user.userId })` → returns `{ ok: false, code: 'INVALID_STATE' }`; `APPUSER.status` unchanged.

#### Integration tests: repository (`tests/integration/db/app-user-repository.test.ts`)

Extend the existing file.

- `setUserStatus(tx, userId, 'DISABLED')` sets `APPUSER.status = 'DISABLED'` and updates `last_modified_datetime`.
- `setUserStatus(tx, userId, 'ACTIVE')` sets `APPUSER.status = 'ACTIVE'`.
- `deleteUserSessions(tx, userId)` removes the target user's session row(s); leaves other users' sessions untouched.
- `deleteUserSessions(tx, userId)` returns `0` and does not throw when the user has no sessions.
- `countRemainingAdmins(targetUserId)` returns `1` when one other ACTIVE admin exists; returns `0` when the target is the only ADMIN.
- `countRemainingAdmins` excludes DISABLED and DELETED ADMIN users from the count.
- `userHasAdminRole(userId)` returns `true` for a user with ADMIN role assigned; `false` for a user with no role or only non-ADMIN roles.

---

## Dependencies

No new npm packages required. All framework dependencies (`drizzle-orm`, `better-auth`, `lucide-react`, `zod`, `next`, `react`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — run the CLI if not already added:

- `npx shadcn@latest add alert-dialog` — the disable confirmation modal. Added to `components/ui/`; do not hand-edit beyond token wiring. Check whether `AlertDialog` was added in a prior unit (e.g. um10 for unlock confirmation) before re-running.
- `npx shadcn@latest add alert` — the inline error `Alert` component. Check whether added in a prior unit (um11).

`Sonner` (toast) is already present from um08/um09.

No new `PERMISSIONS` migration rows required — `users:EDIT` is already seeded. No schema migrations required — `APPUSER.status` and `session` table columns are in place from um02.

---

## Verification Checklist

### Actions and authorization

- [ ] `disableUserAction` is decorated `'use server'`
- [ ] `enableUserAction` is decorated `'use server'`
- [ ] Both actions call `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` before any other logic
- [ ] Calling either action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling either action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling `disableUserAction` with an ADMIN session and valid input for an ACTIVE user returns `{ ok: true }`
- [ ] Calling `enableUserAction` with an ADMIN session and valid input for a DISABLED user returns `{ ok: true }`
- [ ] `revalidatePath('/administration/users')` is called on success and not called on failure
- [ ] `PERMISSIONS.USERS` constant is used in both actions (not the raw string `'users'`)
- [ ] Neither action contains DB access — both delegate entirely to `usersWriteService`

### Validation

- [ ] A non-UUID `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }` for both actions
- [ ] An empty or missing `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }` for both actions
- [ ] `disableUserSchema` and `enableUserSchema` are the schemas used at the action boundary

### Last-admin guard

- [ ] `disableUserAction` with the only remaining ACTIVE/PENDING ADMIN user returns `{ ok: false, code: 'LAST_ADMIN' }`
- [ ] DISABLED and DELETED ADMIN users are excluded from the remaining-admin count
- [ ] PENDING ADMIN users are counted (they are admin-capable)
- [ ] Disabling a non-ADMIN user does not trigger the count query (`userHasAdminRole` short-circuits it)
- [ ] Disabling an ADMIN user when at least one other ACTIVE/PENDING ADMIN exists proceeds normally
- [ ] `{ ok: false, code: 'LAST_ADMIN' }` results in no DB writes (no status change, no session deletion, no audit entry)

### Service — disable

- [ ] `disableUser` loads the before-snapshot before opening the transaction
- [ ] `disableUser` returns `USER_NOT_FOUND` when the target does not exist, with no DB writes
- [ ] `disableUser` returns `INVALID_STATE` for a user whose status is already `DISABLED` or `DELETED`
- [ ] `disableUser` allows disabling both `ACTIVE` and `PENDING` users
- [ ] `setUserStatus`, `deleteUserSessions`, and `writeAuditEvent` are all called inside the same transaction
- [ ] `deleteUserSessions` returning `0` (no active sessions) does not cause an error or rollback
- [ ] A transaction failure rolls back all three operations atomically — no partial writes
- [ ] `event_type = 'USER_DISABLED'`, `actor_user_id = actorId`, `target_entity = 'APPUSER'`, `target_id = targetUserId`
- [ ] `before_data` contains the status value from before the transaction
- [ ] `after_data` contains `{ status: 'DISABLED' }`

### Service — enable

- [ ] `enableUser` loads the before-snapshot before opening the transaction
- [ ] `enableUser` returns `USER_NOT_FOUND` when the target does not exist, with no DB writes
- [ ] `enableUser` returns `INVALID_STATE` for ACTIVE, PENDING, and DELETED users
- [ ] `enableUser` only accepts `DISABLED` users
- [ ] `setUserStatus` is called with `'ACTIVE'` (not the previous status — enable always restores to ACTIVE)
- [ ] `setUserStatus` and `writeAuditEvent` are called inside the same transaction
- [ ] `event_type = 'USER_ENABLED'`, `before_data = { status: 'DISABLED' }`, `after_data = { status: 'ACTIVE' }`
- [ ] No session creation in the enable path

### Repository

- [ ] `setUserStatus` updates only `status` and `last_modified_datetime` — no other columns
- [ ] `setUserStatus` accepts a Drizzle transaction and does not open its own transaction
- [ ] `deleteUserSessions` deletes only the target user's sessions — other users' sessions are untouched
- [ ] `deleteUserSessions` accepts a Drizzle transaction and does not open its own transaction
- [ ] `countRemainingAdmins` excludes the target `userId` from the count
- [ ] `countRemainingAdmins` excludes users with `status = 'DISABLED'` and `status = 'DELETED'`
- [ ] `userHasAdminRole` returns `true` only when a `ROLE_ASSIGN` row linking the user to `role_name = 'ADMIN'` exists
- [ ] No business logic or audit writes in any repository function

### Instant revocation

- [ ] After a successful `disableUserAction`, the target's `session` row no longer exists in the DB
- [ ] A request made with the target's former session token after disable returns a 401/403 (no valid session row)
- [ ] Re-enabling the user does not restore sessions — the user must sign in again
- [ ] A user with no active sessions at disable time is disabled without error

### `UserDetail` — Disable button

- [ ] "Disable" button appears when `user.status === 'ACTIVE'` and `hasLevel(...EDIT)` is true
- [ ] "Disable" button appears when `user.status === 'PENDING'` and `hasLevel(...EDIT)` is true
- [ ] "Disable" button does not appear when `user.status === 'DISABLED'`
- [ ] "Disable" button does not appear when `user.status === 'DELETED'`
- [ ] "Disable" button does not appear when `hasLevel(...EDIT)` is false
- [ ] Clicking "Disable" opens the `AlertDialog` without immediately triggering the action
- [ ] `AlertDialog` title contains the user's name
- [ ] `AlertDialog` body describes session termination
- [ ] "Cancel" closes the dialog without calling `disableUserAction`
- [ ] "Disable user" button is disabled and shows `Loader2 animate-spin` while `isDisabling` is true
- [ ] On `LAST_ADMIN`, the dialog stays open and the inline error is visible inside the dialog
- [ ] On `USER_NOT_FOUND` or `INVALID_STATE`, the dialog closes and the inline error appears in the panel
- [ ] On server error or forbidden, a toast is shown and the dialog closes

### `UserDetail` — Enable button

- [ ] "Enable" button appears when `user.status === 'DISABLED'` and `hasLevel(...EDIT)` is true
- [ ] "Enable" button does not appear for ACTIVE, PENDING, or DELETED users
- [ ] Clicking "Enable" directly calls `enableUserAction` without a confirmation dialog
- [ ] "Enable" button is disabled and shows `Loader2 animate-spin` while `isEnabling` is true
- [ ] On `USER_NOT_FOUND` or `INVALID_STATE`, the inline error appears in the panel
- [ ] On server error or forbidden, a toast is shown

### `UserDetail` — state management

- [ ] Both "Disable" and "Enable" buttons are disabled when `mode === 'edit'`
- [ ] Changing the selected user (`user.userId`) clears `actionError` and closes the confirmation dialog
- [ ] After a successful disable, the `StatusBadge` in the panel updates to `DISABLED` (via `revalidatePath` re-render)
- [ ] After a successful enable, the `StatusBadge` in the panel updates to `ACTIVE`
- [ ] After a successful disable, the `UserTable` row `StatusBadge` also updates
- [ ] Existing view/edit mode, Edit button, close button, field groups, and error states from um11 render without regression

### `UserDetail` — no regression from um11

- [ ] Existing "Edit" button appears at `users:EDIT` level
- [ ] Edit mode (name/phone form, Save/Cancel) is fully functional
- [ ] Panel header layout `[name/title] — [Disable | Enable] [Edit] [×]` renders in a single row without overflow
- [ ] All badge components, date formatting, and field groups are unchanged

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/disable-user.action.ts` and `enable-user.action.ts` have no DB access
- [ ] `components/users/user-detail.tsx` has `'use client'`; no DB or service imports
- [ ] Repository functions import only from `@/db/client` and `@/db/schema`
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] Schema unit tests pass — valid UUID, invalid UUID, empty input for both schemas
- [ ] `disableUser` service unit tests pass — all 9 scenarios per §13.7
- [ ] `enableUser` service unit tests pass — all 6 scenarios per §13.7
- [ ] `disableUserAction` unit tests pass — all 7 scenarios per §13.7
- [ ] `enableUserAction` unit tests pass — all 6 scenarios per §13.7
- [ ] `UserDetail` unit tests pass — all 17 disable/enable UI scenarios per §13.7
- [ ] Repository unit tests pass (mock-based query shape verification)
- [ ] Disable action integration tests pass: ADMIN disables, FORBIDDEN, last-admin guard, atomicity
- [ ] Enable action integration tests pass: ADMIN enables, FORBIDDEN, invalid-state
- [ ] Repository integration tests pass: `setUserStatus`, `deleteUserSessions`, `countRemainingAdmins`, `userHasAdminRole`

### Scope guard

- [ ] No tombstone-delete functionality was added (that is um14+)
- [ ] No password reset, unlock, role assignment, or auth-method change was added
- [ ] No new `PERMISSIONS` rows were added — `users:EDIT` is already seeded
- [ ] No schema migrations were added — no new columns or tables
- [ ] `UserTable`, `UsersPage`, and `UserForm` are unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
