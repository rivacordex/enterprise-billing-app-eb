# Spec: um15 — Unlock locked account (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um07 (`UserDetail` panel as a Client Component established by um11, `UserTable`, `types/users.ts` — `UserDetailView`, `UserListItem`, `usersReadService`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, badge components); Unit um04 (`lockout.repository.ts` — `getLockoutState`, `clearLockout`, `LockoutState` type, `isCurrentlyLocked` helper in `auth/lockout.ts`). Note: by the time um15 ships, `UserDetail` is a Client Component with `mode` state, `permissionMap` prop, disable/enable buttons (um13), reset-password button (um14), and role management (um12). All of that infrastructure is assumed present.
- **Source sections:** overview §"Core User Flow" item 7 (lockout, `USER_UNLOCKED`), §"User administration" (unlock), §"Pages — Administration" item 1 (unlock as `users:EDIT`), §"Audit Events" (`USER_UNLOCKED`); architecture §2 (folder ownership, boundary rules), §5 (account lockout mechanics), §6 (per-page permission matrix: `users:EDIT`); code-standards §3 (Server Actions as public endpoints, parse-then-call, `revalidatePath`), §4 (styling), §7 (file organization). Invariants: **#2** (no authz state in session), **#3** (server-side authz — action re-checks permission before writing), **#11** (audit append-only — `USER_UNLOCKED` written atomically with the UPDATE), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz never cached).

---

## Goal

Implement the admin-initiated account unlock behind `users:EDIT`: atomically clears `locked_until` and `failed_login_count` on the target `APPUSER` and writes a `USER_UNLOCKED` audit entry, so the user can sign in again; the lock chip in `UserDetail` and `UserTable` disappears on revalidation.

---

## Design

### "Unlock" button in `UserDetail`

The `UserDetail` panel (Client Component from um11) gains an "Unlock" button in the panel header's right-side action cluster. Visibility rules:

- Rendered when `user.isLocked === true` AND `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` AND `user.status !== 'DELETED'`.
- Hidden when `user.isLocked === false` or `user.isLocked` is undefined (not locked — no action to take).
- Hidden when `user.status === 'DELETED'`.
- Available for ACTIVE, PENDING, and DISABLED users who are locked. A PENDING user can reach a locked state through repeated failed temp-password attempts; a DISABLED user might be unlocked before re-enabling. Neither case should be blocked.
- Disabled while `mode === 'edit'`, `mode === 'manageRoles'`, or while any other action is in-flight (`isDisabling`, `isEnabling`, `isResetting` from prior units).

**Panel header button order** (left to right, right-side cluster):

```
[Disable | Enable]  [Unlock]  [Reset Password]  [Edit]  [×]
```

"Unlock" sits between the status-change buttons and "Reset Password". When the user is not locked, the slot is simply absent — no disabled placeholder.

**Button styling:**

```
variant: outline, success colours
border: border-[--color-success-300]
text:   text-[--color-success-700]
hover:  hover:bg-[--color-success-50]
icon:   lucide Unlock (size 14) + label "Unlock", text-sm
focus ring: --focus-ring
disabled: opacity-50 cursor-not-allowed
```

### Confirmation dialog

Clicking "Unlock" opens a shadcn `AlertDialog` before any action is taken:

- **Title:** "Unlock {user.userName}?"
- **Body:** "This will clear the account lockout and allow {user.userName} to sign in again."
- **Actions:** "Cancel" (ghost) + "Unlock" (primary style, not destructive — this is a remedial action).
- The "Unlock" confirm button shows a `Loader2 animate-spin` icon and is `disabled` while the action is in-flight (`isUnlocking === true`).
- "Cancel" is also `disabled` while `isUnlocking` is true.
- Inline error feedback inside the dialog for business-logic errors (see §Error feedback below).

The dialog is intentionally lightweight — no session implications, no credential changes, no irreversible data loss — so a brief confirmation is sufficient without the verbose warnings used by disable or reset-password.

### Error feedback

Inline shadcn `Alert` (destructive variant) rendered inside `AlertDialogContent`, above the footer, when the action returns a business error:

- `USER_NOT_FOUND`: "User not found. The record may have been deleted."
- `NOT_LOCKED`: "This account is no longer locked. Refresh the page to see the current state."
- `INVALID_STATE`: "Unlock cannot be applied to this user's current state."

Server and permission errors are shown as toast notifications (error variant) and the dialog closes:

- `FORBIDDEN`: "You don't have permission to perform this action."
- `SERVER_ERROR`: "Something went wrong. Please try again."

### Visible result after success

On `{ ok: true }`, the confirmation dialog closes, `revalidatePath('/administration/users')` is called, and Next.js re-renders the server data. The lock chip disappears from both the `UserDetail` panel and the `UserTable` row immediately because `isLocked` is recomputed from the cleared `locked_until` field.

No reveal modal is needed — unlike reset-password, there is no sensitive one-time value to surface.

---

## Implementation

### 15.1 — Zod validation schema (`validation/users.ts`)

Extend the existing file. Add below the schemas from um14:

```ts
export const unlockAccountSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type UnlockAccountInput = z.infer<typeof unlockAccountSchema>;
```

The schema is intentionally minimal — all business constraints (lock state check, status guard) live in the service.

### 15.2 — Repository function (`db/repositories/lockout.repository.ts`)

The existing file from um04 already has `getLockoutState`, `recordFailedAttempt`, and `clearLockout`. Add one new function.

#### 15.2.1 — `adminClearLockout(tx: DrizzleTransaction, userId: string): Promise<void>` (new)

```ts
export async function adminClearLockout(
  tx: DrizzleTransaction,
  userId: string,
): Promise<void>;
```

Drizzle UPDATE inside the caller-supplied transaction:

```ts
await tx
  .update(appuser)
  .set({
    failedLoginCount: 0,
    lockedUntil: null,
    lastModifiedDatetime: new Date(),
  })
  .where(eq(appuser.userId, userId));
```

This is the transaction-aware counterpart to the existing `clearLockout` (which operates outside a transaction and is used on login success with no audit). `adminClearLockout` accepts a transaction handle, does not open its own transaction, writes no audit entry, and contains no business logic. It updates `last_modified_datetime` because this is an admin-initiated mutation on the `APPUSER` row.

**Why a separate function and not reusing `clearLockout`?** `clearLockout` does not accept a transaction handle (it runs an independent UPDATE) and is not designed for the audit-wrapped transaction the service needs. Reusing it would make atomicity impossible.

### 15.3 — Service function (`services/users/users-write.service.ts`)

Add one function to the existing service file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

#### `unlockAccount(input: UnlockAccountInput, actorId: string): Promise<UnlockAccountResult>`

```ts
type UnlockAccountResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCKED" }
  | { ok: false; code: "INVALID_STATE" };

export async function unlockAccount(
  input: UnlockAccountInput,
  actorId: string,
): Promise<UnlockAccountResult>;
```

Steps:

1. **Load current user.** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Status guard.** If `existingUser.status === 'DELETED'` → return `{ ok: false, code: 'INVALID_STATE' }`.

3. **Lock state check.** Call `lockoutRepository.getLockoutState(input.userId)` → `lockState`. If `!isCurrentlyLocked(lockState)` (i.e., `lockedUntil` is null or in the past) → return `{ ok: false, code: 'NOT_LOCKED' }`. This handles the race condition where the lock expired between the page render and the action firing.

4. **Capture before-state** (for audit):

   ```ts
   const before = {
     failedLoginCount: lockState.failedLoginCount,
     lockedUntil: lockState.lockedUntil?.toISOString() ?? null,
   };
   ```

5. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await lockoutRepository.adminClearLockout(tx, input.userId)` — sets `failed_login_count = 0`, `locked_until = NULL`, `last_modified_datetime = NOW()`.

   b. `await writeAuditEvent(tx, { eventType: 'USER_UNLOCKED', actorUserId: actorId, targetEntity: 'APPUSER', targetId: input.userId, beforeData: before, afterData: { failedLoginCount: 0, lockedUntil: null } })` — atomically with the UPDATE.

6. **Return** `{ ok: true }`.

On any transaction error, let the exception propagate — the transaction rolls back, leaving the APPUSER row and AUDIT_LOG unchanged.

**Audit event fields:**

| Field              | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| `event_type`       | `'USER_UNLOCKED'`                                          |
| `actor_user_id`    | `actorId` (the admin performing the unlock)                |
| `target_entity`    | `'APPUSER'`                                                |
| `target_id`        | `input.userId`                                             |
| `before_data`      | `{ failedLoginCount: <count>, lockedUntil: <ISO string> }` |
| `after_data`       | `{ failedLoginCount: 0, lockedUntil: null }`               |
| `created_datetime` | `NOW()` (written by `writeAuditEvent`)                     |

Contrast with `USER_LOCKED` (written in um04 by the sign-in hook with `actor_user_id: null` — system actor). `USER_UNLOCKED` always has a human `actor_user_id`.

### 15.4 — Server Action (`actions/users/unlock-account.action.ts`)

New file. `'use server'`.

```ts
type UnlockAccountActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCKED" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function unlockAccountAction(
  rawInput: unknown,
): Promise<UnlockAccountActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — wrap in try/catch; re-throw `NEXT_REDIRECT`; other auth failures → `{ ok: false, code: 'FORBIDDEN' }`.

2. `const parsed = unlockAccountSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Wrap service call in try/catch:

   ```ts
   const result = await usersWriteService.unlockAccount(parsed.data, actorId);
   ```

   On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }`.

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true }`.

The action has no direct DB access — delegates entirely to `usersWriteService`. `revalidatePath` is called only on success.

### 15.5 — `UserDetail` component update (`components/users/user-detail.tsx`)

The component is already a Client Component with `mode` state, `permissionMap` prop, disable/enable state (um13), reset-password state (um14), and role management (um12). This unit adds unlock state and handlers.

**New state:**

```ts
const [isUnlockConfirmOpen, setIsUnlockConfirmOpen] = useState(false);
const [isUnlocking, setIsUnlocking] = useState(false);
const [unlockError, setUnlockError] = useState<
  "USER_NOT_FOUND" | "NOT_LOCKED" | "INVALID_STATE" | null
>(null);
```

Clear unlock state whenever the selected user changes (add to the existing `useEffect` from um11 that already resets `mode`, and the other state from um13/um14):

```ts
useEffect(() => {
  // ... existing resets from prior units ...
  setUnlockError(null);
  setIsUnlockConfirmOpen(false);
}, [user?.userId]);
```

**Unlock handler** (called when admin confirms inside the dialog):

```ts
const handleUnlockConfirm = async () => {
  if (!user) return;
  setIsUnlocking(true);
  setUnlockError(null);
  try {
    const result = await unlockAccountAction({ userId: user.userId });
    if (result.ok) {
      setIsUnlockConfirmOpen(false);
    } else if (
      result.code === "USER_NOT_FOUND" ||
      result.code === "NOT_LOCKED" ||
      result.code === "INVALID_STATE"
    ) {
      setUnlockError(result.code);
    } else {
      toast.error(
        result.code === "FORBIDDEN"
          ? "You don't have permission to perform this action."
          : "Something went wrong. Please try again.",
      );
      setIsUnlockConfirmOpen(false);
    }
  } finally {
    setIsUnlocking(false);
  }
};
```

**Button visibility and disabled logic:**

```tsx
const canEdit = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT);
const showUnlock =
  canEdit && user !== null && user.isLocked && user.status !== "DELETED";
const actionsDisabled =
  mode === "edit" ||
  mode === "manageRoles" ||
  isDisabling ||
  isEnabling ||
  isResetting ||
  isUnlocking;
```

**"Unlock" button render** (in the panel header action cluster, between Disable/Enable and Reset Password):

```tsx
{
  showUnlock && (
    <Button
      variant="outline"
      size="sm"
      className="border-success-300 text-success-700 hover:bg-success-50"
      onClick={() => {
        setUnlockError(null);
        setIsUnlockConfirmOpen(true);
      }}
      disabled={actionsDisabled}
    >
      <Unlock size={14} />
      Unlock
    </Button>
  );
}
```

**Confirmation dialog** (rendered outside the panel card, alongside dialogs from um13/um14):

```tsx
<AlertDialog open={isUnlockConfirmOpen} onOpenChange={setIsUnlockConfirmOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Unlock {user?.userName}?</AlertDialogTitle>
      <AlertDialogDescription>
        This will clear the account lockout and allow {user?.userName} to sign
        in again.
      </AlertDialogDescription>
    </AlertDialogHeader>

    {unlockError && (
      <Alert variant="destructive" className="mt-2">
        <AlertDescription>
          {unlockError === "USER_NOT_FOUND" &&
            "User not found. The record may have been deleted."}
          {unlockError === "NOT_LOCKED" &&
            "This account is no longer locked. Refresh the page to see the current state."}
          {unlockError === "INVALID_STATE" &&
            "Unlock cannot be applied to this user's current state."}
        </AlertDescription>
      </Alert>
    )}

    <AlertDialogFooter>
      <AlertDialogCancel disabled={isUnlocking}>Cancel</AlertDialogCancel>
      <Button onClick={handleUnlockConfirm} disabled={isUnlocking}>
        {isUnlocking ? (
          <Loader2 size={14} className="mr-1 animate-spin" />
        ) : null}
        Unlock
      </Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

No reveal modal is needed after success — the UI simply revalidates and the lock chip disappears.

**No changes to `UsersPage`, `UserTable`, `UserForm`, or any other component** — this unit modifies only `UserDetail` and adds new action/service/repository functions.

---

## Dependencies

No new npm packages required. All framework dependencies (`drizzle-orm`, `better-auth`, `lucide-react`, `zod`, `next`, `react`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — all required components (`AlertDialog`, `Alert`, `Button`) were added in prior units (um13/um14). Confirm present before running CLI.

**lucide-react icon** — `Unlock` must be imported from `lucide-react`. Verify it is available in the installed version (present since v0.263). No version bump required.

No new `PERMISSIONS` migration rows required — `users:EDIT` is already seeded. No schema migrations required — `failed_login_count` and `locked_until` are already on `APPUSER` from um02.

---

## Verification Checklist

### Action and authorization

- [ ] `unlockAccountAction` is decorated `'use server'`
- [ ] The action calls `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` as the first `await` before any other logic
- [ ] Calling the action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with an ADMIN session on a locked user returns `{ ok: true }`
- [ ] `revalidatePath('/administration/users')` is called on success and NOT called on any failure path
- [ ] `PERMISSIONS.USERS` constant is used (not the raw string `'users'`)
- [ ] The action has no direct DB access — delegates entirely to `usersWriteService`

### Validation

- [ ] A non-UUID `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] A missing `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `unlockAccountSchema` is the schema used at the action boundary
- [ ] Extra fields in `rawInput` are stripped by Zod (not returned as errors, not passed to service)

### Service — guards

- [ ] `unlockAccount` returns `USER_NOT_FOUND` when `findUserById` returns null, with no DB writes
- [ ] `unlockAccount` returns `INVALID_STATE` when `status === 'DELETED'`, with no DB writes
- [ ] `unlockAccount` returns `NOT_LOCKED` when `isCurrentlyLocked(lockState) === false` (both null and past-timestamp cases), with no DB writes
- [ ] `unlockAccount` proceeds to the transaction for ACTIVE, PENDING, and DISABLED locked users
- [ ] `getLockoutState` is called only after the existence and status guards pass

### Service — transaction atomicity

- [ ] `adminClearLockout` and `writeAuditEvent` are called inside the same Drizzle transaction
- [ ] A failure in `writeAuditEvent` rolls back the `adminClearLockout` update — `failed_login_count` and `locked_until` are unchanged
- [ ] A failure in `adminClearLockout` means `writeAuditEvent` is never called
- [ ] No partial write is possible — both operations commit or neither does

### Service — audit event

- [ ] `event_type = 'USER_UNLOCKED'`
- [ ] `actor_user_id = actorId` (the admin, not null — contrast with `USER_LOCKED` which uses null for the system)
- [ ] `target_entity = 'APPUSER'`
- [ ] `target_id = input.userId` (the target user)
- [ ] `before_data.failedLoginCount` matches the value read by `getLockoutState` before the transaction
- [ ] `before_data.lockedUntil` is a non-null ISO string (the lock was confirmed active before the transaction)
- [ ] `after_data = { failedLoginCount: 0, lockedUntil: null }`

### Repository — `adminClearLockout`

- [ ] Sets `failed_login_count = 0`, `locked_until = NULL`, and `last_modified_datetime = NOW()` on the target APPUSER row
- [ ] Does NOT touch any other column on APPUSER
- [ ] Accepts a Drizzle transaction handle and does not open its own transaction
- [ ] Contains no business logic or audit writes
- [ ] Is idempotent — calling it on an already-unlocked user succeeds without error (sets 0 → 0 and NULL → NULL)
- [ ] Does NOT reuse or call the existing `clearLockout` function from um04 (different signature — `clearLockout` has no transaction handle)

### DB state after successful unlock

- [ ] `appuser.failed_login_count = 0`
- [ ] `appuser.locked_until = NULL`
- [ ] `appuser.last_modified_datetime` is updated to the time of the action
- [ ] `AUDIT_LOG` contains exactly one `USER_UNLOCKED` row for the operation
- [ ] No other APPUSER columns are modified (name, email, status, auth_method, etc. unchanged)
- [ ] The `USER_UNLOCKED` audit row is present even if queried immediately after the action (atomicity confirmed)

### Sign-in continuity after unlock

- [ ] After unlock, the sign-in hook's `isCurrentlyLocked` check returns `false` for the previously locked user (integration: call `getLockoutState` after the action and assert `lockedUntil === null`)
- [ ] A LOCAL user who was locked can successfully sign in after admin unlock (integration: full sign-in flow against the test DB)
- [ ] The sign-in success resets `failed_login_count` via `clearLockout` as normal (existing um04 behaviour unchanged)

### `UserDetail` — "Unlock" button visibility

- [ ] "Unlock" button is rendered for an ACTIVE user when `user.isLocked === true` and `hasLevel(...EDIT)` is true
- [ ] "Unlock" button is rendered for a PENDING locked user
- [ ] "Unlock" button is rendered for a DISABLED locked user
- [ ] "Unlock" button is NOT rendered when `user.isLocked === false`
- [ ] "Unlock" button is NOT rendered when `user.status === 'DELETED'`
- [ ] "Unlock" button is NOT rendered when `hasLevel(...EDIT)` is false
- [ ] "Unlock" button is NOT rendered when no user is selected

### `UserDetail` — button disabled states

- [ ] "Unlock" button is disabled when `mode === 'edit'`
- [ ] "Unlock" button is disabled when `mode === 'manageRoles'`
- [ ] "Unlock" button is disabled while `isDisabling` is true (from um13)
- [ ] "Unlock" button is disabled while `isEnabling` is true (from um13)
- [ ] "Unlock" button is disabled while `isResetting` is true (from um14)
- [ ] "Unlock" button is disabled while `isUnlocking` is true

### `UserDetail` — confirmation dialog

- [ ] Clicking "Unlock" opens the `AlertDialog` without triggering the action
- [ ] The dialog title contains the target user's name
- [ ] The dialog body mentions clearing the lockout and allowing sign-in
- [ ] "Cancel" closes the dialog without calling `unlockAccountAction`
- [ ] The "Unlock" confirm button is disabled and shows `Loader2 animate-spin` while `isUnlocking` is true
- [ ] "Cancel" is disabled while `isUnlocking` is true
- [ ] On `USER_NOT_FOUND`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `NOT_LOCKED`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `INVALID_STATE`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `SERVER_ERROR`, a toast is shown and the dialog closes
- [ ] On `FORBIDDEN`, a toast is shown and the dialog closes
- [ ] On `{ ok: true }`, the dialog closes with no modal or reveal step
- [ ] After success, the lock chip is absent from the `UserDetail` panel (revalidated server data)
- [ ] After success, the lock chip is absent from the `UserTable` row for that user (revalidated server data)

### `UserDetail` — state management

- [ ] Changing the selected user clears `unlockError` and closes the confirmation dialog
- [ ] `unlockError` is cleared when the admin opens the dialog again after a prior error
- [ ] Existing disable/enable (um13), reset-password (um14), role management (um12), Edit button, close button, and field groups render without regression
- [ ] `isUnlocking` resets to `false` in the `finally` block on both success and failure

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/unlock-account.action.ts` has no DB access and is decorated `'use server'`
- [ ] `components/users/user-detail.tsx` has `'use client'`; no DB or service imports
- [ ] `db/repositories/lockout.repository.ts` functions import only from `@/db/client` and `@/db/schema`
- [ ] `adminClearLockout` does not import or call `writeAuditEvent` — audit is the service's responsibility
- [ ] `isCurrentlyLocked` from `auth/lockout.ts` is used for the NOT_LOCKED guard — not an inline comparison
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite — unit tests

#### Schema (`tests/unit/validation/users.test.ts`)

Extend the existing file. Cover `unlockAccountSchema`:

| Input                                    | Expected                      |
| ---------------------------------------- | ----------------------------- |
| `{ userId: valid-uuid }`                 | Passes                        |
| `{ userId: 'not-a-uuid' }`               | Fails; `userId` error present |
| `{}` (empty)                             | Fails; `userId` required      |
| `{ userId: valid-uuid, extra: 'field' }` | Passes; extra fields stripped |

#### Repository (`tests/unit/db/lockout-repository.test.ts`)

Extend the existing file. Use a mocked `db` client.

- `adminClearLockout(tx, userId)` calls `tx.update(appuser).set({ failedLoginCount: 0, lockedUntil: null, lastModifiedDatetime: ... })` with the correct `userId`.
- `adminClearLockout(tx, userId)` does not call `writeAuditEvent` or any service function.
- `adminClearLockout` accepts a transaction handle and does not open its own transaction.

#### Service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository`, `lockoutRepository`, `isCurrentlyLocked`, and `writeAuditEvent`.

| Scenario                          | Setup                                                                                                                                    | Expected                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Happy path — ACTIVE locked user   | `findUserById → { status: 'ACTIVE' }`; `getLockoutState → { failedLoginCount: 5, lockedUntil: future Date }`; `isCurrentlyLocked → true` | `adminClearLockout` called; `writeAuditEvent` called with `USER_UNLOCKED`, correct before/after; returns `{ ok: true }` |
| Happy path — PENDING locked user  | `findUserById → { status: 'PENDING' }`; `isCurrentlyLocked → true`                                                                       | Same writes; returns `{ ok: true }`                                                                                     |
| Happy path — DISABLED locked user | `findUserById → { status: 'DISABLED' }`; `isCurrentlyLocked → true`                                                                      | Same writes; returns `{ ok: true }`                                                                                     |
| User not found                    | `findUserById → null`                                                                                                                    | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; `getLockoutState` not called; no writes                                |
| DELETED user                      | `findUserById → { status: 'DELETED' }`                                                                                                   | Returns `{ ok: false, code: 'INVALID_STATE' }`; `getLockoutState` not called; no writes                                 |
| Not locked (null)                 | `findUserById → { status: 'ACTIVE' }`; `isCurrentlyLocked → false`; `lockedUntil: null`                                                  | Returns `{ ok: false, code: 'NOT_LOCKED' }`; no writes                                                                  |
| Not locked (expired)              | `findUserById → { status: 'ACTIVE' }`; `isCurrentlyLocked → false`; `lockedUntil: past Date`                                             | Returns `{ ok: false, code: 'NOT_LOCKED' }`; no writes                                                                  |
| Transaction rollback              | `adminClearLockout` throws mid-transaction                                                                                               | Exception propagates; `writeAuditEvent` not called; no partial writes                                                   |
| Audit before_data accuracy        | ACTIVE locked user with `failedLoginCount: 3`, `lockedUntil: specificDate`                                                               | `writeAuditEvent` called with `before_data = { failedLoginCount: 3, lockedUntil: specificDate.toISOString() }`          |

#### Action (`tests/unit/actions/unlock-account.action.test.ts`)

New file. Mock `requirePermission`, `usersWriteService.unlockAccount`, and `revalidatePath`.

| Scenario                            | Setup                                             | Expected                                                                                           |
| ----------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Valid input, ADMIN session, success | Service → `{ ok: true }`                          | Returns `{ ok: true }`; `revalidatePath('/administration/users')` called                           |
| Invalid UUID                        | `userId = 'not-a-uuid'`                           | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; service not called; `revalidatePath` not called |
| User not found                      | Service → `{ ok: false, code: 'USER_NOT_FOUND' }` | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; `revalidatePath` not called                       |
| Not locked                          | Service → `{ ok: false, code: 'NOT_LOCKED' }`     | Returns `{ ok: false, code: 'NOT_LOCKED' }`; `revalidatePath` not called                           |
| DELETED user                        | Service → `{ ok: false, code: 'INVALID_STATE' }`  | Returns `{ ok: false, code: 'INVALID_STATE' }`; `revalidatePath` not called                        |
| Unauthorized                        | `requirePermission` throws                        | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                         |
| Server error                        | Service throws                                    | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                                      |

#### `UserDetail` component (`tests/unit/components/user-detail.test.tsx`)

Extend the existing file. Mock `unlockAccountAction`.

- "Unlock" button is rendered when `user.isLocked === true`, `hasLevel(...EDIT)` is true, and `user.status === 'ACTIVE'`.
- "Unlock" button is rendered for PENDING and DISABLED locked users.
- "Unlock" button is NOT rendered when `user.isLocked === false`.
- "Unlock" button is NOT rendered when `user.status === 'DELETED'`.
- "Unlock" button is NOT rendered when `hasLevel(...EDIT)` is false.
- Clicking "Unlock" opens the `AlertDialog`; `unlockAccountAction` is not called.
- "Cancel" closes the dialog without calling `unlockAccountAction`.
- The "Unlock" confirm button is disabled and shows `Loader2 animate-spin` while `isUnlocking` is true.
- When `unlockAccountAction` returns `{ ok: true }`, the dialog closes; no modal appears.
- When `unlockAccountAction` returns `{ ok: false, code: 'USER_NOT_FOUND' }`, the inline error appears; the dialog stays open.
- When `unlockAccountAction` returns `{ ok: false, code: 'NOT_LOCKED' }`, the inline error appears; the dialog stays open.
- When `unlockAccountAction` returns `{ ok: false, code: 'INVALID_STATE' }`, the inline error appears; the dialog stays open.
- When `unlockAccountAction` returns `{ ok: false, code: 'SERVER_ERROR' }`, a toast is shown and the dialog closes.
- When `unlockAccountAction` returns `{ ok: false, code: 'FORBIDDEN' }`, a toast is shown and the dialog closes.
- "Unlock" button is disabled when `mode === 'edit'`.
- "Unlock" button is disabled when `mode === 'manageRoles'`.
- "Unlock" button is disabled while `isDisabling` is true.
- "Unlock" button is disabled while `isEnabling` is true.
- "Unlock" button is disabled while `isResetting` is true.
- Changing the selected user clears `unlockError` and closes the confirmation dialog.
- Existing disable/enable, reset-password, role management, Edit button, close button, and field groups render without regression.

### Test suite — integration tests

#### Unlock action (`tests/integration/actions/unlock-account.action.test.ts`)

New file. Use the test DB with `admin_user` and `no_grants_user`. Fixtures: `locked_local_user` (ACTIVE, `auth_method = 'LOCAL'`, `failed_login_count = 5`, `locked_until = NOW() + 15 min`); `unlocked_local_user` (ACTIVE, `auth_method = 'LOCAL'`, `failed_login_count = 0`, `locked_until = NULL`).

| Session          | Input                                    | Expected                                    |
| ---------------- | ---------------------------------------- | ------------------------------------------- |
| `admin_user`     | `{ userId: locked_local_user.userId }`   | Returns `{ ok: true }`; DB asserts below    |
| `no_grants_user` | `{ userId: locked_local_user.userId }`   | Returns `{ ok: false, code: 'FORBIDDEN' }`  |
| `admin_user`     | `{ userId: unlocked_local_user.userId }` | Returns `{ ok: false, code: 'NOT_LOCKED' }` |

For the `admin_user` happy-path test, assert after the action:

- `appuser.failed_login_count = 0`
- `appuser.locked_until = NULL`
- `appuser.last_modified_datetime` is greater than the value before the call
- `AUDIT_LOG` contains exactly one `USER_UNLOCKED` row with:
  - `actor_user_id = admin_user.userId`
  - `target_entity = 'APPUSER'`
  - `target_id = locked_local_user.userId`
  - `before_data.failedLoginCount = 5`
  - `before_data.lockedUntil` is a non-null ISO string
  - `after_data = { failedLoginCount: 0, lockedUntil: null }`

**Atomicity test:** Simulate `writeAuditEvent` throwing mid-transaction:

- `appuser.failed_login_count` remains 5
- `appuser.locked_until` remains non-null
- No `USER_UNLOCKED` row in `AUDIT_LOG`

**PENDING locked user test:** Fixture `locked_pending_user` (PENDING, `auth_method = 'LOCAL'`, locked):

- `unlockAccountAction({ userId: locked_pending_user.userId })` with `admin_user` → returns `{ ok: true }`; `failed_login_count = 0`; `locked_until = NULL`; audit entry written.

**DISABLED locked user test:** Fixture `locked_disabled_user` (DISABLED, locked):

- `unlockAccountAction({ userId: locked_disabled_user.userId })` with `admin_user` → returns `{ ok: true }`; `failed_login_count = 0`; `locked_until = NULL`; audit entry written.

**DELETED user test:** Fixture `deleted_user` (`status = 'DELETED'`):

- `unlockAccountAction({ userId: deleted_user.userId })` → returns `{ ok: false, code: 'INVALID_STATE' }`; no writes.

**Expired lock (race condition) test:** Set `locked_until` to 1 second in the past before calling the action:

- Returns `{ ok: false, code: 'NOT_LOCKED' }`; `failed_login_count` and `locked_until` unchanged; no `USER_UNLOCKED` audit row.

#### Repository (`tests/integration/db/lockout-repository.test.ts`)

Extend the existing file.

- `adminClearLockout(tx, userId)` sets `failed_login_count = 0` and `locked_until = NULL` for a locked user.
- `adminClearLockout(tx, userId)` updates `last_modified_datetime`.
- `adminClearLockout(tx, userId)` does not affect any other column on APPUSER.
- `adminClearLockout` called on a user where `failed_login_count = 0` and `locked_until = NULL` succeeds without error (idempotent).

### Scope guard

- [ ] No changes to the sign-in lockout hook (um04) — `clearLockout` and `isCurrentlyLocked` are only consumed, not modified
- [ ] No changes to `UsersPage`, `UserTable`, `UserForm`, or any component other than `UserDetail`
- [ ] No new `PERMISSIONS` migration rows added — `users:EDIT` is already seeded
- [ ] No schema migrations added — `failed_login_count` and `locked_until` are already on `APPUSER`
- [ ] The existing `clearLockout` function in `lockout.repository.ts` is NOT modified (used on login success by um04 hook; must remain unchanged to avoid regressions)
- [ ] No disable/re-enable, password-reset, tombstone-delete, or auth-method-switch functionality added
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
