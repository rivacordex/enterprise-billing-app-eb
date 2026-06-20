# Spec: um14 — Reset LOCAL password (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um07 (`UserDetail` panel as a Client Component, `UserTable`, `types/users.ts` — `UserDetailView`, `UserListItem`, `usersReadService`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, badge components); Unit um09 (`updateAccountPassword` repository function, `hashTempPassword` utility in `lib/temp-password.ts`, `generateTempPassword` utility, `clearForcePasswordChange` repository function established the pattern for its inverse).
- **Source sections:** overview §"Core User Flow" item 2 (LOCAL one-time temp password, `force_password_change`), §"User administration" (reset LOCAL password), §"Pages — Administration" item 1 (reset LOCAL password as `users:EDIT`), §"Audit Events" (`USER_PASSWORD_RESET`); architecture §2 (folder ownership, boundary rules), §5 (auth-method exclusivity, instant session revocation), §6 (per-page permission matrix: `users:EDIT`); code-standards §3 (Server Actions as public endpoints, parse-then-call, `revalidatePath`), §4 (styling), §7 (file organization), §8 (permission naming). Invariants: **#1** (no plaintext or reversible credentials — temp password shown in UI only, never logged or stored in plaintext), **#2** (authz state never in session), **#3** (server-side authz — action re-checks permission before writing), **#8** (sessions server-revocable — reset revokes all active sessions), **#9** (auth methods mutually exclusive — reset applies to LOCAL users only), **#11** (audit append-only — `USER_PASSWORD_RESET` written atomically with the write), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary).

---

## Goal

Implement the admin-initiated LOCAL password reset behind `users:EDIT`: generates a new cryptographically random one-time temp password, hashes it with scrypt and writes it to the user's `credential` account row, sets `force_password_change = TRUE`, deletes all of the target's active sessions, and writes `USER_PASSWORD_RESET` to the audit log — all atomically. The plaintext temp password is returned to the admin and displayed exactly once in a dismissable modal with a copy-to-clipboard button; it is never stored, logged, or retrievable after dismissal. The target user is forced through `/set-password` on their next login (implemented by um09).

---

## Design

### "Reset Password" button in `UserDetail`

The `UserDetail` panel gains a "Reset Password" button in the panel header alongside the existing action buttons from um11 and um13. Visibility rules:

- Rendered when `user.authMethod === 'LOCAL'` AND `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` AND `user.status !== 'DELETED'`.
- Hidden when `user.authMethod === 'SSO'` — SSO users have no credential row; the concept of password reset does not apply.
- Hidden when `user.status === 'DELETED'`.
- Available for ACTIVE, PENDING, and DISABLED users (resetting a DISABLED user's password so they start fresh on re-enable is a valid workflow).
- Disabled while the panel is in edit mode (`mode === 'edit'`) or while any other action is in-flight (`isDisabling`, `isEnabling`), following the same pattern as um13.

**Panel header layout** — the existing right-side action cluster from um13 gains the "Reset Password" button as one additional member. Left to right: `[Disable | Enable] [Reset Password] [Edit] [×]`. "Reset Password" sits between the status-change buttons and the "Edit" button.

**Button styling:**

```
variant: outline, warning colours
border: border-[--color-warning-300]
text: text-[--color-warning-700]
hover bg: hover:bg-[--color-warning-50]
icon: lucide KeyRound (size 14) + label "Reset Password", text-sm
focus ring: --focus-ring
disabled: opacity-50 cursor-not-allowed
```

### Confirmation dialog

Clicking "Reset Password" opens a shadcn `AlertDialog` before any action is taken:

- **Title:** "Reset {user.userName}'s password?"
- **Body:** "This will generate a new temporary password, immediately end all of {user.userName}'s active sessions, and require them to set a new password on next sign-in. The temporary password is shown once and cannot be retrieved."
- **Actions:** "Cancel" (ghost) + "Reset Password" (warning/destructive style).
- The "Reset Password" confirm button shows a `Loader2 animate-spin` icon and is `disabled` while the action is in-flight.
- Inline error feedback inside the dialog for service-layer errors (see §Error feedback).

### Temp password reveal modal

On a successful reset, the confirmation dialog closes and a **temp password reveal modal** (`Dialog`, not `AlertDialog`) opens immediately with the plaintext temp password:

- **Title:** "Temporary Password — {user.userName}"
- **Body (top to bottom):**
  1. A shadcn destructive-variant `Alert` with the text: "This password is shown only once and cannot be retrieved. Share it with {user.userName} securely."
  2. A read-only monospace display field: a `<div>` styled as an input (`--surface-input`, `--radius-md`, `font-mono`, `--text-body`, `padding: 0.5rem 0.75rem`, `letter-spacing: 0.05em`) containing the plaintext temp password, followed immediately to the right by a "Copy" icon button (`lucide Copy`, size 16, `aria-label="Copy password"`). The copy button toggles to `lucide Check` + "Copied!" (in `--color-success-600`) for 2 seconds after a successful `navigator.clipboard.writeText()`, then reverts.
  3. A "Done — I've saved the password" button (primary style, full-width below the password row).
- The modal **does not close on backdrop click** — `onInteractOutside={(e) => e.preventDefault()}` is set on `DialogContent` so the admin must explicitly click "Done". This prevents accidental dismissal before the password is copied.
- The modal **does not have a close (×) button** — the only exit is "Done".
- After "Done", the modal closes and `revalidatePath` causes the panel to re-render with updated state (the UserDetail `StatusBadge` will still reflect the same status; the visible change is that `force_password_change` is now true, shown as a "Password reset pending" note if the detail panel surfaces that field).

### Error feedback (in the confirmation dialog)

Inline shadcn `Alert` (destructive variant) rendered inside `AlertDialogContent`, above the footer, when the action returns a business error:

- `USER_NOT_FOUND`: "User not found. The record may have been deleted."
- `NOT_LOCAL_USER`: "Password reset is only available for LOCAL users."
- `INVALID_STATE`: "Password reset cannot be applied to this user's current state."

Server errors and FORBIDDEN are shown as toast notifications (error variant) and the dialog closes:

- FORBIDDEN: "You don't have permission to perform this action."
- SERVER_ERROR: "Something went wrong. Please try again."

---

## Implementation

### 14.1 — Zod validation schema (`validation/users.ts`)

Extend the existing file. Add below the schemas from um13:

```ts
export const resetPasswordSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
});

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
```

The schema is intentionally minimal — all business constraints (LOCAL-only, status guard) live in the service.

### 14.2 — Repository function (`db/repositories/app-user.repository.ts`)

Add one new function. Confirm the following functions from prior units exist and can be reused without modification:

- `findUserById(userId)` — returns at minimum `{ userId, userName, authMethod, status, forcePasswordChange }` (established in um07/um09).
- `updateAccountPassword(tx, userId, passwordHash)` — updates `account.password` where `provider_id = 'credential'` (established in um09).
- `deleteUserSessions(tx, userId)` — deletes all `session` rows for the user, returns deleted count (established in um13).

#### 14.2.1 — `setForcePasswordChange(tx, userId): Promise<void>` (new)

```ts
export async function setForcePasswordChange(
  tx: DrizzleTransaction,
  userId: string,
): Promise<void>;
```

Drizzle update inside the caller-supplied transaction:

```ts
await tx
  .update(appuser)
  .set({ forcePasswordChange: true, lastModifiedDatetime: new Date() })
  .where(eq(appuser.userId, userId));
```

This is the symmetric counterpart to `clearForcePasswordChange` from um09. It accepts a transaction handle and does not open its own transaction. No business logic; no audit writes.

### 14.3 — Service function (`services/users/users-write.service.ts`)

Add one function to the existing service file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

#### `resetLocalPassword(input, actorId): Promise<ResetLocalPasswordResult>`

```ts
type ResetLocalPasswordResult =
  | { ok: true; tempPassword: string }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCAL_USER" }
  | { ok: false; code: "INVALID_STATE" };

export async function resetLocalPassword(
  input: ResetPasswordInput,
  actorId: string,
): Promise<ResetLocalPasswordResult>;
```

Steps:

1. **Load current user (before-snapshot).** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Auth-method guard.** If `existingUser.authMethod !== 'LOCAL'` → return `{ ok: false, code: 'NOT_LOCAL_USER' }`. SSO users have no `credential` account row; the concept of password reset does not apply, and `updateAccountPassword` would silently update zero rows.

3. **State guard.** If `existingUser.status === 'DELETED'` → return `{ ok: false, code: 'INVALID_STATE' }`. ACTIVE, PENDING, and DISABLED are all valid targets.

4. **Generate and hash the temp password.** Call `generateTempPassword()` from `lib/temp-password.ts` → `tempPasswordPlaintext`. Call `hashTempPassword(tempPasswordPlaintext)` → `passwordHash`. The plaintext is held only in the local scope of this function.

5. **Capture before-state:**

   ```ts
   const before = { forcePasswordChange: existingUser.forcePasswordChange };
   ```

6. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await updateAccountPassword(tx, input.userId, passwordHash)` — writes the new scrypt hash to `account.password` where `provider_id = 'credential'`.

   b. `await setForcePasswordChange(tx, input.userId)` — sets `force_password_change = TRUE` and updates `last_modified_datetime` on `APPUSER`.

   c. `await deleteUserSessions(tx, input.userId)` — revokes all active sessions immediately; zero deleted rows is not an error.

   d. `await writeAuditEvent(tx, { eventType: 'USER_PASSWORD_RESET', actorUserId: actorId, targetEntity: 'APPUSER', targetId: input.userId, beforeData: before, afterData: { forcePasswordChange: true } })` — no password material in before/after.

7. **Return** `{ ok: true, tempPassword: tempPasswordPlaintext }`.

On any transaction error, let the exception propagate — the transaction rolls back; no partial writes. The `tempPasswordPlaintext` variable goes out of scope and is garbage-collected; it is never returned on failure.

**Critical security constraint:** `tempPasswordPlaintext` must never be assigned to a variable with a scope broader than this function. It must never appear in any log statement, error message, or returned error object. The only legal use is as the argument to `hashTempPassword` and as the `tempPassword` value in the success return.

### 14.4 — Server Action (`actions/users/reset-password.action.ts`)

New file. `'use server'`.

```ts
type ResetPasswordActionResult =
  | { ok: true; tempPassword: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "NOT_LOCAL_USER" }
  | { ok: false; code: "INVALID_STATE" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function resetPasswordAction(
  rawInput: unknown,
): Promise<ResetPasswordActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — wrap in try/catch; re-throw `NEXT_REDIRECT`; other auth failures → `{ ok: false, code: 'FORBIDDEN' }`.

2. `const parsed = resetPasswordSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Wrap service call in try/catch:

   ```ts
   const result = await usersWriteService.resetLocalPassword(
     parsed.data,
     actorId,
   );
   ```

   On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }`.

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true, tempPassword: result.tempPassword }`.

The plaintext temp password travels from the service through the action return value to the client over the encrypted Server Action channel (HTTPS). It is never written to any log or persisted on the server after the function returns.

The action has no DB access — delegates entirely to `usersWriteService`.

### 14.5 — `UserDetail` component update (`components/users/user-detail.tsx`)

The component is already a Client Component with `mode` state, `permissionMap` prop (um11), and disable/enable state (um13). This unit adds reset-password state and handlers.

**New state:**

```ts
const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);
const [isResetting, setIsResetting] = useState(false);
const [resetError, setResetError] = useState<
  "USER_NOT_FOUND" | "NOT_LOCAL_USER" | "INVALID_STATE" | null
>(null);
const [tempPassword, setTempPassword] = useState<string | null>(null);
const [isCopied, setIsCopied] = useState(false);
```

Clear reset state whenever the selected user changes:

```ts
useEffect(() => {
  setResetError(null);
  setIsResetConfirmOpen(false);
  setTempPassword(null);
  setIsCopied(false);
}, [user?.userId]);
```

**Reset handler** (called when admin confirms inside the dialog):

```ts
const handleResetConfirm = async () => {
  if (!user) return;
  setIsResetting(true);
  setResetError(null);
  try {
    const result = await resetPasswordAction({ userId: user.userId });
    if (result.ok) {
      setIsResetConfirmOpen(false);
      setTempPassword(result.tempPassword);
    } else if (
      result.code === "USER_NOT_FOUND" ||
      result.code === "NOT_LOCAL_USER" ||
      result.code === "INVALID_STATE"
    ) {
      setResetError(result.code);
    } else {
      toast.error(
        result.code === "FORBIDDEN"
          ? "You don't have permission to perform this action."
          : "Something went wrong. Please try again.",
      );
      setIsResetConfirmOpen(false);
    }
  } finally {
    setIsResetting(false);
  }
};
```

**Copy handler** (inside the reveal modal):

```ts
const handleCopyPassword = async () => {
  if (!tempPassword) return;
  await navigator.clipboard.writeText(tempPassword);
  setIsCopied(true);
  setTimeout(() => setIsCopied(false), 2000);
};
```

**Button visibility logic:**

```tsx
const canEdit = hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT);
const showReset =
  canEdit &&
  user !== null &&
  user.authMethod === "LOCAL" &&
  user.status !== "DELETED";
const actionsDisabled =
  mode === "edit" || isDisabling || isEnabling || isResetting;
```

**"Reset Password" button render** (inside the right-side action cluster from um13, between the disable/enable button and the Edit button):

```tsx
{
  showReset && (
    <Button
      variant="outline"
      size="sm"
      className="border-warning-300 text-warning-700 hover:bg-warning-50"
      onClick={() => {
        setResetError(null);
        setIsResetConfirmOpen(true);
      }}
      disabled={actionsDisabled}
    >
      <KeyRound size={14} />
      Reset Password
    </Button>
  );
}
```

**Confirmation dialog** (rendered outside the panel card, alongside the disable dialog from um13):

```tsx
<AlertDialog open={isResetConfirmOpen} onOpenChange={setIsResetConfirmOpen}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>
        Reset {user?.userName}&apos;s password?
      </AlertDialogTitle>
      <AlertDialogDescription>
        This will generate a new temporary password, immediately end all of{" "}
        {user?.userName}&apos;s active sessions, and require them to set a new
        password on next sign-in. The temporary password is shown once and
        cannot be retrieved.
      </AlertDialogDescription>
    </AlertDialogHeader>

    {resetError && (
      <Alert variant="destructive" className="mt-2">
        <AlertDescription>
          {resetError === "USER_NOT_FOUND" &&
            "User not found. The record may have been deleted."}
          {resetError === "NOT_LOCAL_USER" &&
            "Password reset is only available for LOCAL users."}
          {resetError === "INVALID_STATE" &&
            "Password reset cannot be applied to this user's current state."}
        </AlertDescription>
      </Alert>
    )}

    <AlertDialogFooter>
      <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
      <Button
        variant="destructive"
        onClick={handleResetConfirm}
        disabled={isResetting}
      >
        {isResetting ? (
          <Loader2 size={14} className="mr-1 animate-spin" />
        ) : null}
        Reset Password
      </Button>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

**Temp password reveal modal** (rendered alongside the confirmation dialog, always mounted when a user is selected):

```tsx
<Dialog
  open={tempPassword !== null}
  onOpenChange={() => {
    /* controlled — only "Done" closes this */
  }}
>
  <DialogContent
    onInteractOutside={(e) => e.preventDefault()}
    onEscapeKeyDown={(e) => e.preventDefault()}
    className="max-w-md"
  >
    <DialogHeader>
      <DialogTitle>Temporary Password — {user?.userName}</DialogTitle>
    </DialogHeader>

    <Alert variant="destructive">
      <AlertDescription>
        This password is shown only once and cannot be retrieved. Share it with{" "}
        {user?.userName} securely.
      </AlertDescription>
    </Alert>

    <div className="mt-2 flex items-center gap-2">
      <div className="flex-1 rounded-md border border-[--border-default] bg-[--surface-input] px-3 py-2 font-mono text-sm tracking-wider select-all">
        {tempPassword}
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCopyPassword}
        aria-label="Copy password"
      >
        {isCopied ? (
          <>
            <Check size={14} className="text-[--color-success-600]" />
            <span className="text-[--color-success-600]">Copied!</span>
          </>
        ) : (
          <Copy size={14} />
        )}
      </Button>
    </div>

    <DialogFooter className="mt-4">
      <Button
        className="w-full"
        onClick={() => {
          setTempPassword(null);
          setIsCopied(false);
        }}
      >
        Done — I&apos;ve saved the password
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

No close (×) button on this Dialog — the only exit is the "Done" button. `onInteractOutside` and `onEscapeKeyDown` both call `e.preventDefault()` to block accidental closure.

**No changes to `UsersPage`, `UserTable`, or `UserForm`** — this unit modifies only `UserDetail` and adds new action/service/repository functions.

### 14.6 — Tests

#### Unit tests: schema (`tests/unit/validation/users.test.ts`)

Extend the existing file. Cover `resetPasswordSchema`:

| Input                                    | Expected                      |
| ---------------------------------------- | ----------------------------- |
| `{ userId: valid-uuid }`                 | Passes                        |
| `{ userId: 'not-a-uuid' }`               | Fails; `userId` error present |
| `{}` (empty)                             | Fails; `userId` required      |
| `{ userId: valid-uuid, extra: 'field' }` | Passes; extra fields stripped |

#### Unit tests: repository (`tests/unit/db/app-user-repository.test.ts`)

Extend the existing file. Use a mocked `db` client — not the integration test DB.

- `setForcePasswordChange` calls `tx.update(appuser).set({ forcePasswordChange: true, lastModifiedDatetime: ... })` with the correct `userId`.
- `setForcePasswordChange` accepts a Drizzle transaction and does not open its own transaction.
- `setForcePasswordChange` does not call `writeAuditEvent` or any other business-logic function.

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository`, `generateTempPassword`, `hashTempPassword`, and `writeAuditEvent`.

| Scenario                         | Setup                                                                                                                                                         | Expected                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path — ACTIVE LOCAL user   | `findUserById → { authMethod: 'LOCAL', status: 'ACTIVE', forcePasswordChange: false }`; `generateTempPassword → 'TmpPass123!'`; `hashTempPassword → 'hashed'` | `updateAccountPassword` called with `'hashed'`; `setForcePasswordChange` called; `deleteUserSessions` called; `writeAuditEvent` called with `USER_PASSWORD_RESET`, `beforeData = { forcePasswordChange: false }`, `afterData = { forcePasswordChange: true }`; returns `{ ok: true, tempPassword: 'TmpPass123!' }` |
| Happy path — PENDING LOCAL user  | `findUserById → { authMethod: 'LOCAL', status: 'PENDING', forcePasswordChange: true }`                                                                        | Same writes; `beforeData = { forcePasswordChange: true }`; returns `{ ok: true, tempPassword: ... }`                                                                                                                                                                                                               |
| Happy path — DISABLED LOCAL user | `findUserById → { authMethod: 'LOCAL', status: 'DISABLED', forcePasswordChange: false }`                                                                      | All writes proceed; returns `{ ok: true, tempPassword: ... }`                                                                                                                                                                                                                                                      |
| User not found                   | `findUserById → null`                                                                                                                                         | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; no writes; `writeAuditEvent` not called                                                                                                                                                                                                                           |
| SSO user                         | `findUserById → { authMethod: 'SSO', status: 'ACTIVE' }`                                                                                                      | Returns `{ ok: false, code: 'NOT_LOCAL_USER' }`; no writes                                                                                                                                                                                                                                                         |
| DELETED user                     | `findUserById → { authMethod: 'LOCAL', status: 'DELETED' }`                                                                                                   | Returns `{ ok: false, code: 'INVALID_STATE' }`; no writes                                                                                                                                                                                                                                                          |
| Zero sessions deleted            | `deleteUserSessions → 0`                                                                                                                                      | No error; transaction commits; returns `{ ok: true, tempPassword: ... }`                                                                                                                                                                                                                                           |
| Transaction rollback             | `setForcePasswordChange` throws mid-transaction                                                                                                               | Exception propagates; `writeAuditEvent` not called; no partial writes                                                                                                                                                                                                                                              |
| Temp password not in audit data  | ACTIVE LOCAL user happy path                                                                                                                                  | Inspect all `writeAuditEvent` call arguments — assert no argument contains the plaintext temp password or the hash                                                                                                                                                                                                 |

#### Unit tests: action (`tests/unit/actions/reset-password.action.test.ts`)

New file. Mock `requirePermission`, `usersWriteService.resetLocalPassword`, and `revalidatePath`.

| Scenario                            | Setup                                                 | Expected                                                                                              |
| ----------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Valid input, ADMIN session, success | Service → `{ ok: true, tempPassword: 'TmpPass123!' }` | Returns `{ ok: true, tempPassword: 'TmpPass123!' }`; `revalidatePath('/administration/users')` called |
| Invalid UUID                        | `userId = 'not-a-uuid'`                               | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; service not called; `revalidatePath` not called    |
| User not found                      | Service → `{ ok: false, code: 'USER_NOT_FOUND' }`     | Returns `{ ok: false, code: 'USER_NOT_FOUND' }`; `revalidatePath` not called                          |
| SSO user                            | Service → `{ ok: false, code: 'NOT_LOCAL_USER' }`     | Returns `{ ok: false, code: 'NOT_LOCAL_USER' }`                                                       |
| DELETED user                        | Service → `{ ok: false, code: 'INVALID_STATE' }`      | Returns `{ ok: false, code: 'INVALID_STATE' }`                                                        |
| Unauthorized                        | `requirePermission` throws                            | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                            |
| Server error                        | Service throws                                        | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                                         |

#### Unit tests: `UserDetail` reset UI (`tests/unit/components/user-detail.test.tsx`)

Extend the existing test file (established in um11, extended in um13). Mock `resetPasswordAction`.

- "Reset Password" button is rendered when `user.authMethod === 'LOCAL'`, `hasLevel(...EDIT)` is true, and `user.status === 'ACTIVE'`.
- "Reset Password" button is rendered for PENDING and DISABLED LOCAL users.
- "Reset Password" button is NOT rendered when `user.authMethod === 'SSO'`.
- "Reset Password" button is NOT rendered when `user.status === 'DELETED'`.
- "Reset Password" button is NOT rendered when `hasLevel(...EDIT)` is false.
- Clicking "Reset Password" opens the `AlertDialog` (title "Reset {userName}'s password?" is visible); action not yet called.
- "Cancel" closes the dialog without calling `resetPasswordAction`.
- "Reset Password" confirm button is disabled and shows `Loader2 animate-spin` while `isResetting` is true.
- When `resetPasswordAction` returns `{ ok: false, code: 'USER_NOT_FOUND' }`, the inline error appears inside the dialog; the dialog stays open.
- When `resetPasswordAction` returns `{ ok: false, code: 'NOT_LOCAL_USER' }`, the inline error appears inside the dialog.
- When `resetPasswordAction` returns `{ ok: false, code: 'INVALID_STATE' }`, the inline error appears inside the dialog.
- When `resetPasswordAction` returns `{ ok: false, code: 'SERVER_ERROR' }`, a toast is shown and the dialog closes.
- When `resetPasswordAction` returns `{ ok: false, code: 'FORBIDDEN' }`, a toast is shown and the dialog closes.
- When `resetPasswordAction` returns `{ ok: true, tempPassword: 'TmpPass123!' }`, the confirmation dialog closes and the temp password reveal modal opens, displaying "TmpPass123!".
- The temp password reveal modal cannot be closed by pressing Escape.
- The temp password reveal modal cannot be closed by clicking the backdrop.
- Clicking "Copy" in the reveal modal calls `navigator.clipboard.writeText` with the temp password; the button changes to a "Copied!" state.
- After 2 seconds, the "Copied!" button reverts to the copy icon.
- Clicking "Done — I've saved the password" closes the reveal modal; `tempPassword` state is cleared.
- After dismissing the reveal modal, the reveal modal is not re-openable (the temp password is gone from state).
- The "Reset Password" button is disabled when `mode === 'edit'`.
- The "Reset Password" button is disabled while `isDisabling` is true (from um13).
- The "Reset Password" button is disabled while `isEnabling` is true (from um13).
- Changing the selected user clears `resetError`, closes the confirmation dialog, and clears `tempPassword`.
- Existing disable/enable functionality, Edit button, close button, and field groups render without regression.

#### Integration tests: reset password action (`tests/integration/actions/reset-password.action.test.ts`)

Use the test DB with `admin_user` and `no_grants_user`. Fixtures: `local_active_user` (ACTIVE, `auth_method = 'LOCAL'`, `force_password_change = FALSE`) with a live `session` row; `sso_user` (ACTIVE, `auth_method = 'SSO'`).

| Session        | Input                                  | Expected                                                                   |
| -------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| admin_user     | `{ userId: local_active_user.userId }` | Returns `{ ok: true, tempPassword: <non-empty string> }`; DB asserts below |
| no_grants_user | `{ userId: local_active_user.userId }` | Returns `{ ok: false, code: 'FORBIDDEN' }`                                 |
| admin_user     | `{ userId: sso_user.userId }`          | Returns `{ ok: false, code: 'NOT_LOCAL_USER' }`                            |

For the `admin_user` happy-path test, assert:

- `account.password` has changed from the original hash.
- The new hash in `account.password` verifies against the returned `tempPassword` using Better-Auth's `verifyPassword` or equivalent.
- `appuser.force_password_change = TRUE`.
- `appuser.last_modified_datetime` is greater than the value before the call.
- The `session` row for `local_active_user` no longer exists.
- `AUDIT_LOG` contains a `USER_PASSWORD_RESET` entry with:
  - `event_type = 'USER_PASSWORD_RESET'`
  - `actor_user_id = admin_user.userId`
  - `target_entity = 'APPUSER'`
  - `target_id = local_active_user.userId`
  - `before_data` contains `{ forcePasswordChange: false }` (the prior value)
  - `after_data` contains `{ forcePasswordChange: true }`
  - No column in the row contains the plaintext temp password or any password hash.
- The `tempPassword` returned by the action matches a string of non-zero length; it is not the old password.

**Atomicity test:** Simulate `setForcePasswordChange` throwing mid-transaction:

- `account.password` is unchanged from original.
- `force_password_change` remains FALSE.
- No session rows were deleted.
- No `AUDIT_LOG` rows were written.

**DISABLED user test:** Fixture `local_disabled_user` (DISABLED, `auth_method = 'LOCAL'`):

- `resetPasswordAction({ userId: local_disabled_user.userId })` with `admin_user` → returns `{ ok: true, tempPassword: ... }`; `force_password_change = TRUE`; sessions deleted; audit entry written.

**DELETED user test:** Fixture `local_deleted_user` (`status = 'DELETED'`):

- `resetPasswordAction({ userId: local_deleted_user.userId })` → returns `{ ok: false, code: 'INVALID_STATE' }`; no writes.

#### Integration tests: repository (`tests/integration/db/app-user-repository.test.ts`)

Extend the existing file.

- `setForcePasswordChange(tx, userId)` sets `appuser.force_password_change = TRUE` and updates `last_modified_datetime`.
- `setForcePasswordChange(tx, userId)` does not affect any other column on `APPUSER`.
- `setForcePasswordChange` called on a user where `force_password_change` is already TRUE succeeds without error (idempotent).

---

## Dependencies

No new npm packages required. All framework dependencies (`drizzle-orm`, `better-auth`, `lucide-react`, `zod`, `next`, `react`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — run the CLI only if not already added by prior units:

- `npx shadcn@latest add dialog` — for the temp password reveal modal. Distinct from `AlertDialog` — `Dialog` allows fully custom content and controllable close prevention. Check whether `Dialog` was added in a prior unit (e.g. um10 or um11) before re-running.
- `npx shadcn@latest add alert-dialog` — already added in um13 for the disable confirmation; confirm present.
- `npx shadcn@latest add alert` — already added in um13; confirm present.

`Sonner` (toast) is already present from um08/um09. `lucide-react` icons `KeyRound`, `Copy`, `Check`, `Loader2` are available via `lucide-react` (already a dependency).

No new `PERMISSIONS` migration rows required — `users:EDIT` is already seeded. No schema migrations required — `APPUSER.force_password_change` and the `account` table are in place from um02/um03.

---

## Verification Checklist

### Action and authorization

- [ ] `resetPasswordAction` is decorated `'use server'`
- [ ] The action calls `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` before any other logic
- [ ] Calling the action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with an ADMIN session and a valid LOCAL user returns `{ ok: true, tempPassword: <non-empty string> }`
- [ ] `revalidatePath('/administration/users')` is called on success and NOT called on any failure
- [ ] `PERMISSIONS.USERS` constant is used (not the raw string `'users'`)
- [ ] The action has no direct DB access — delegates entirely to `usersWriteService`

### Validation

- [ ] A non-UUID `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] A missing `userId` returns `{ ok: false, code: 'VALIDATION_ERROR' }`
- [ ] `resetPasswordSchema` is the schema used at the action boundary

### Service — guards

- [ ] `resetLocalPassword` returns `USER_NOT_FOUND` when `findUserById` returns null, with no writes
- [ ] `resetLocalPassword` returns `NOT_LOCAL_USER` when `authMethod === 'SSO'`, with no writes
- [ ] `resetLocalPassword` returns `INVALID_STATE` when `status === 'DELETED'`, with no writes
- [ ] `resetLocalPassword` accepts ACTIVE, PENDING, and DISABLED LOCAL users
- [ ] `generateTempPassword` is called only after all guards pass (not on failure paths)

### Service — password generation and storage

- [ ] `generateTempPassword()` is called to produce the plaintext; the result is passed to `hashTempPassword()`
- [ ] `updateAccountPassword` is called with the hash — not the plaintext
- [ ] The plaintext temp password does not appear in any `writeAuditEvent` argument
- [ ] The hash does not appear in any `writeAuditEvent` argument
- [ ] `{ ok: true, tempPassword: <plaintext> }` is returned — not the hash
- [ ] The returned `tempPassword` matches what was generated: a hash of it verifies against `account.password` post-transaction

### Service — transaction atomicity

- [ ] `updateAccountPassword`, `setForcePasswordChange`, `deleteUserSessions`, and `writeAuditEvent` are all called inside the same Drizzle transaction
- [ ] A failure in `setForcePasswordChange` rolls back the password update — `account.password` is unchanged
- [ ] A failure in `writeAuditEvent` rolls back all prior operations — password, flag, and sessions are unchanged
- [ ] `deleteUserSessions` returning 0 (no active sessions) does not cause an error or rollback
- [ ] No partial write is possible — all four operations commit or none do

### Service — audit event

- [ ] `event_type = 'USER_PASSWORD_RESET'`
- [ ] `actor_user_id = actorId` (the admin, not the target)
- [ ] `target_entity = 'APPUSER'`
- [ ] `target_id = input.userId` (the target user)
- [ ] `before_data` contains the prior value of `forcePasswordChange` (may be true if a second reset is issued before the user logs in)
- [ ] `after_data = { forcePasswordChange: true }`
- [ ] No password material (plaintext, hash, or fragment) appears in any column of the `AUDIT_LOG` row

### Repository — `setForcePasswordChange`

- [ ] Updates only `force_password_change = TRUE` and `last_modified_datetime` — no other columns
- [ ] Accepts a Drizzle transaction handle and does not open its own transaction
- [ ] Contains no business logic or audit writes
- [ ] Is idempotent — calling it when `force_password_change` is already TRUE succeeds without error

### DB state after successful reset

- [ ] `account.password` is updated to a new scrypt hash for the `credential` provider row
- [ ] The new hash verifies against the returned `tempPassword`
- [ ] The old password is no longer accepted for sign-in (test: attempt sign-in with previous password and confirm rejection by Better-Auth)
- [ ] `appuser.force_password_change = TRUE`
- [ ] `appuser.last_modified_datetime` is updated
- [ ] All `session` rows for the target user are deleted
- [ ] Other users' session rows are untouched

### Set-password flow continuity

- [ ] After a reset, the target user can sign in with the new `tempPassword` via the LOCAL sign-in form
- [ ] After sign-in with the temp password, the `force_password_change = TRUE` guard (implemented in um09) redirects to `/set-password`
- [ ] After completing `/set-password`, `force_password_change` is cleared and the user lands normally

### `UserDetail` — "Reset Password" button visibility

- [ ] "Reset Password" button is rendered for LOCAL users with status ACTIVE when `hasLevel(...EDIT)` is true
- [ ] "Reset Password" button is rendered for LOCAL users with status PENDING
- [ ] "Reset Password" button is rendered for LOCAL users with status DISABLED
- [ ] "Reset Password" button is NOT rendered for LOCAL users with status DELETED
- [ ] "Reset Password" button is NOT rendered for SSO users regardless of status
- [ ] "Reset Password" button is NOT rendered when `hasLevel(...EDIT)` is false
- [ ] "Reset Password" button is NOT rendered when no user is selected

### `UserDetail` — confirmation dialog

- [ ] Clicking "Reset Password" opens the `AlertDialog` without immediately triggering the action
- [ ] The dialog title contains the target user's name
- [ ] The dialog body mentions session termination and "shown once"
- [ ] "Cancel" closes the dialog without calling `resetPasswordAction`
- [ ] The "Reset Password" confirm button is disabled and shows `Loader2 animate-spin` while `isResetting` is true
- [ ] On `USER_NOT_FOUND`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `NOT_LOCAL_USER`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `INVALID_STATE`, the inline error appears inside the dialog; the dialog stays open
- [ ] On `SERVER_ERROR` or `FORBIDDEN`, a toast is shown and the dialog closes
- [ ] While `isResetting` is true, the "Cancel" button is also disabled

### `UserDetail` — temp password reveal modal

- [ ] The modal opens immediately after `resetPasswordAction` returns `{ ok: true }`
- [ ] The modal displays the returned `tempPassword` in a monospace element
- [ ] The modal title contains the target user's name
- [ ] The warning about "shown only once" is visible in the modal
- [ ] The modal does NOT close when the user presses Escape (`onEscapeKeyDown` is prevented)
- [ ] The modal does NOT close when the user clicks outside (`onInteractOutside` is prevented)
- [ ] The modal has no close (×) button
- [ ] Clicking "Copy" calls `navigator.clipboard.writeText` with the exact temp password string
- [ ] After "Copy", the button changes to a "Copied!" success state for 2 seconds, then reverts
- [ ] Clicking "Done — I've saved the password" closes the modal and clears `tempPassword` from state
- [ ] After closing the modal, the temp password is no longer accessible in component state
- [ ] The modal cannot be re-opened without performing a new reset

### `UserDetail` — state management

- [ ] "Reset Password" button is disabled when `mode === 'edit'`
- [ ] "Reset Password" button is disabled while `isDisabling` is true (from um13)
- [ ] "Reset Password" button is disabled while `isEnabling` is true (from um13)
- [ ] Changing the selected user clears `resetError`, closes the confirmation dialog, and clears `tempPassword`
- [ ] Existing disable/enable, Edit button, close button, field groups, and error states from um11 and um13 render without regression

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/reset-password.action.ts` has no DB access and has `'use server'`
- [ ] `components/users/user-detail.tsx` has `'use client'`; no DB or service imports
- [ ] `db/repositories/app-user.repository.ts` functions import only from `@/db/client` and `@/db/schema`
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] Schema unit tests pass — valid UUID, invalid UUID, empty input
- [ ] `setForcePasswordChange` repository unit tests pass
- [ ] `resetLocalPassword` service unit tests pass — all 9 scenarios per §14.6
- [ ] `resetPasswordAction` unit tests pass — all 7 scenarios per §14.6
- [ ] `UserDetail` reset UI unit tests pass — all scenarios per §14.6
- [ ] Reset action integration tests pass: ADMIN resets ACTIVE/DISABLED, FORBIDDEN, NOT_LOCAL_USER, INVALID_STATE, atomicity
- [ ] `setForcePasswordChange` repository integration tests pass (idempotency, column scope)

### Security

- [ ] The plaintext temp password is never written to any log, console output, or file
- [ ] The plaintext temp password does not appear in any `AUDIT_LOG` column
- [ ] The hash does not appear in any `AUDIT_LOG` column
- [ ] The action returns the plaintext only on `{ ok: true }` — error paths return no password material
- [ ] The old password is rejected by Better-Auth sign-in after a successful reset

### Scope guard

- [ ] No unlock functionality was added (that is um12)
- [ ] No auth-method switch functionality was added (separate unit)
- [ ] No tombstone-delete functionality was added (um15+)
- [ ] No new `PERMISSIONS` rows were added — `users:EDIT` is already seeded
- [ ] No schema migrations were added — no new columns or tables
- [ ] `UserTable`, `UsersPage`, and `UserForm` are unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
