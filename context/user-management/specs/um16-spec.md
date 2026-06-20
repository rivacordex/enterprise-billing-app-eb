# Spec: um16 — Switch auth_method SSO ↔ LOCAL (EDIT) + session revocation

- **Boundary:** APP / AUTH
- **Dependencies:** Unit um07 (`UserDetail` panel, `UserDetailView` type, `types/users.ts`, `usersReadService`, `appUserRepository` read functions, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `AuthMethodBadge`); Unit um10 (`account` table with `provider_id = 'microsoft'` pattern, `auth/sso-linking.ts` — SSO account row structure confirmed; note that LOCAL → SSO relies on um10's existing first-sign-in linking flow to create the `'microsoft'` account row on next Entra sign-in).
- **Source sections:** overview §"User administration" (switch `auth_method`; SSO→LOCAL sets temp password; LOCAL→SSO clears credential; switching revokes sessions), §"Core User Flow" item 2 (LOCAL users: one-time temp password + `force_password_change`), §"Data Model" (`APPUSER.auth_method`, `APPUSER.force_password_change`, `APPUSER.failed_login_count`, `APPUSER.locked_until`; `account` table — `provider_id`:`credential`|`microsoft`, `password` column), §"Authentication & sessions" (mutually exclusive methods; DB-backed sessions, deleting rows = instant revocation), §"Audit Events" (`USER_AUTH_METHOD_CHANGED`), §"Pages — Administration" item 1 (per-page matrix: `users:EDIT`); architecture §2 (folder ownership: `actions/**` — parse/auth-check/call-service; `services/**` — business logic; `db/**` — DB access only), §3 (Storage: sessions — deleting rows = instant revocation; LOCAL → password hash in `account.password` only), §5 (auth-method change revokes sessions; mutually exclusive; LOCAL lockout state on `APPUSER`), §6 (per-page permission matrix: `users:EDIT` for auth-method switch). Invariants: **#1** (no plaintext credentials — temp password never stored or logged), **#2** (authz state never in session), **#3** (always server-side), **#8** (sessions server-revocable with zero latency — `auth_method` change revokes sessions), **#9** (two auth methods mutually exclusive per user), **#11** (USER_AUTH_METHOD_CHANGED audit), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#19** (Better-Auth field mapping — scrypt hash written only to `account.password` via Better-Auth's hash function; field mapping never bypassed).

---

## Goal

Enable an admin with `users:EDIT` to switch an existing user's `auth_method` between `SSO` and `LOCAL` from the `UserDetail` panel; SSO → LOCAL generates a one-time temporary password (`force_password_change = TRUE`), LOCAL → SSO removes the credential account and clears lockout state; both directions delete all of the user's active sessions immediately and write `USER_AUTH_METHOD_CHANGED` to `AUDIT_LOG` — enforcing the two methods as mutually exclusive and making re-authentication via the new method mandatory.

---

## Design

### Auth method switch button in UserDetail

The `UserDetail` panel gains a "Switch to [method]" button rendered inline in the **Access** field group, on the same row as the Auth Method badge. It appears as a small ghost-style button (`--text-body-sm`, `--radius-md`, `--action-ghost-*` tokens) to the right of the `AuthMethodBadge`:

- Label: **"Switch to LOCAL"** when `user.authMethod === 'SSO'`
- Label: **"Switch to SSO"** when `user.authMethod === 'LOCAL'`

Visibility conditions (all must be true):

- The actor holds `users:EDIT` (i.e., `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)`)
- `user.status !== 'DELETED'`

No additional status restriction — switching is permitted for PENDING, ACTIVE, and DISABLED users. (A PENDING user may have no sessions to revoke, which is a valid no-op for that step.)

When clicked, the button opens the `SwitchAuthMethodDialog`.

### SwitchAuthMethodDialog — states

The dialog is a shadcn `Dialog` (modal overlay) with three sequential states, managed in a single client component.

#### State 1 — Confirmation

Title: **"Switch to LOCAL authentication"** or **"Switch to SSO authentication"**.

Body: direction-specific consequence text + session-revocation warning.

**SSO → LOCAL body:**

> Switching **[userName]** to local password authentication will:
>
> - Remove their Entra SSO link
> - Generate a temporary password (shown once — share it out of band)
> - Revoke all of their active sessions immediately
>
> They will need to sign in with the temporary password and set a new one.

**LOCAL → SSO body:**

> Switching **[userName]** to Entra SSO authentication will:
>
> - Remove their password
> - Clear any account lockout
> - Revoke all of their active sessions immediately
>
> They will need to sign in via Microsoft to re-activate their account.

**Self-switch warning (shown when `targetUserId === actorId`):**

An inline `Alert` (warning variant, `--color-warning-*` tokens) rendered above the body text:

> **You are switching your own account.** Your current session will be revoked and you will be signed out immediately.

Buttons: "Cancel" (ghost) dismisses; "**Switch to LOCAL**" / "**Switch to SSO**" (primary) submits. The primary button shows a loading spinner (`Loader2` icon, animate-spin) and is disabled while the Server Action is in flight. Both buttons are `disabled` during the in-flight period.

#### State 2a — Success with temp password (SSO → LOCAL only)

Replaces the confirmation body after a successful SSO → LOCAL switch. Same layout as um08's post-creation temp password display:

- `CheckCircle` icon (`--color-success-700`) + heading **"Authentication method switched"**
- Sentence: "Share this temporary password with **[userName]** out of band. It will not be shown again."
- Monospace code block (`--font-mono`, `--surface-sunken`, `--radius-md`, full-width) containing the plaintext temp password, with a copy-to-clipboard button (lucide `Copy` → `Check` for 2 s).
- "Done" button (primary style). Clicking closes the dialog; the `UserDetail` panel and `AuthMethodBadge` re-render with `authMethod = 'LOCAL'` via `revalidatePath`.

#### State 2b — Success toast (LOCAL → SSO only)

The dialog closes immediately after a successful LOCAL → SSO switch. A shadcn `Toast` (success variant) is shown:

> "Authentication method switched to SSO. [userName] must sign in via Microsoft."

The `UserDetail` panel and `AuthMethodBadge` re-render with `authMethod = 'SSO'` via `revalidatePath`.

### UserDetail panel changes

`UserDetail` is a Server Component. To support the switch button, it requires two additional props:

```ts
interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
  permissionMap?: EffectivePermissionMap; // added in um16
  actorId?: string; // added in um16
}
```

Both new props are optional — when absent (e.g., in tests rendering UserDetail in isolation), the switch button is not rendered.

The `UsersPage` (already resolving both from `requirePermission`) passes them down:

```tsx
<UserDetail
  user={selectedUser}
  notFound={selectedUserId !== undefined && selectedUser === null}
  permissionMap={permissionMap}
  actorId={actorId}
/>
```

The note from um07 ("Do not pass `actorId` to child components") applied to read-only rendering. Um16 introduces a mutation action on the detail panel where `actorId` is needed purely to render the self-switch warning in the dialog — it is not used for any authorization decision (the Server Action re-resolves the actor server-side independently).

Within the Access field group, the layout of the Auth Method row changes from:

```
Auth Method   [SSO badge]
```

to:

```
Auth Method   [SSO badge]   [Switch to LOCAL button]
```

The row becomes `flex items-center gap-2 justify-between` (label on left, badge + button on right as a flex row). The switch button renders the `SwitchAuthMethodDialog` as a child, using an uncontrolled open-trigger pattern (dialog manages its own open state internally via a trigger prop).

### AuthMethodBadge refresh

After a successful switch in either direction, `revalidatePath('/administration/users')` causes the server to re-render the page. The `UserDetail` panel re-fetches the user and the `AuthMethodBadge` reflects the new method. No client-side state patch — server re-render is the source of truth.

---

## Implementation

### 16.1 — Validation schema (`validation/users.ts`)

Add `switchAuthMethodSchema` to the existing file. No imports from `next/*`, `db/**`, `services/**`, `auth/**`, or UI modules.

```ts
export const switchAuthMethodSchema = z.object({
  userId: z.string().uuid(),
  newAuthMethod: z.enum(["SSO", "LOCAL"]),
});

export type SwitchAuthMethodInput = z.infer<typeof switchAuthMethodSchema>;
```

This schema is imported by both the Server Action (server-side parse) and the client form (client-side type narrowing — Zod not re-executed client-side for this action since there are no freeform fields).

### 16.2 — Repository additions (`db/repositories/app-user.repository.ts`)

Add four functions to the existing repository file. All use Drizzle only — no raw SQL strings. All accept a `DrizzleTransaction` where writes are involved, so callers can compose them atomically.

#### 16.2.1 — `updateAuthMethodFields`

```ts
export async function updateAuthMethodFields(
  tx: DrizzleTransaction,
  userId: string,
  fields: {
    authMethod: "SSO" | "LOCAL";
    forcePasswordChange: boolean;
    failedLoginCount: number;
    lockedUntil: Date | null;
  },
): Promise<void>;
```

```ts
await tx
  .update(appuser)
  .set({
    authMethod: fields.authMethod,
    forcePasswordChange: fields.forcePasswordChange,
    failedLoginCount: fields.failedLoginCount,
    lockedUntil: fields.lockedUntil,
    lastModifiedDatetime: new Date(),
  })
  .where(eq(appuser.userId, userId));
```

#### 16.2.2 — `deleteAccountByProvider`

```ts
export async function deleteAccountByProvider(
  tx: DrizzleTransaction,
  userId: string,
  providerId: "credential" | "microsoft",
): Promise<void>;
```

```ts
await tx
  .delete(account)
  .where(and(eq(account.userId, userId), eq(account.providerId, providerId)));
```

A no-op if no matching row exists (e.g., LOCAL→SSO on a PENDING user who has never SSO'd in and therefore has no `'microsoft'` account row — not applicable in this direction, but the guard holds for SSO→LOCAL if the user has never SSO'd and has no `'microsoft'` row). The caller determines which `providerId` to delete per direction.

#### 16.2.3 — `createCredentialAccount`

```ts
export async function createCredentialAccount(
  tx: DrizzleTransaction,
  params: {
    userId: string;
    hashedPassword: string;
  },
): Promise<void>;
```

```ts
await tx.insert(account).values({
  id: uuid(), // generate a new UUID
  userId: params.userId,
  providerId: "credential",
  providerAccountId: params.userId, // convention: user's own ID, matching um08 and Better-Auth's credentials pattern
  password: params.hashedPassword,
  createdAt: new Date(),
  updatedAt: new Date(),
});
```

> **Implementer note — field names:** The `account` table columns are Better-Auth-managed and mapped to snake_case via the field mapping in `auth/`. Confirm exact Drizzle column names for `id`, `userId`, `providerId`, `providerAccountId`, `password`, `createdAt`, `updatedAt` from the Drizzle schema definition in `db/schema.ts`. Use the same column keys as um08's credential-account creation to remain consistent.

> **Implementer note — UUID generation:** Use the same UUID generator as the rest of the codebase (e.g., `crypto.randomUUID()` from Node built-ins, or the project's existing helper).

#### 16.2.4 — `deleteUserSessions`

```ts
export async function deleteUserSessions(
  tx: DrizzleTransaction,
  userId: string,
): Promise<{ revokedCount: number }>;
```

```ts
const result = await tx
  .delete(session)
  .where(eq(session.userId, userId))
  .returning({ id: session.id });

return { revokedCount: result.length };
```

Returns the count for audit-event metadata (number of sessions revoked). If the user has no active sessions (e.g., PENDING user who has never logged in), this is a valid no-op returning `{ revokedCount: 0 }`.

> **Implementer note — `.returning()`:** Drizzle's DELETE `.returning()` behavior differs between PostgreSQL drivers. If the driver does not support it, use a SELECT count before DELETE, or simply omit the count (it is informational only — not part of the audit event's required fields).

### 16.3 — Service: `switchAuthMethod` (`services/users/users-write.service.ts`)

Add to the existing service file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

```ts
type SwitchAuthMethodInput = {
  actorId: string;
  targetUserId: string;
  newAuthMethod: "SSO" | "LOCAL";
};

type SwitchAuthMethodResult =
  | { ok: true; newAuthMethod: "LOCAL"; tempPassword: string }
  | { ok: true; newAuthMethod: "SSO" }
  | {
      ok: false;
      code:
        | "USER_NOT_FOUND"
        | "USER_DELETED"
        | "ALREADY_METHOD"
        | "ACTOR_NOT_FOUND";
    };

export async function switchAuthMethod(
  input: SwitchAuthMethodInput,
): Promise<SwitchAuthMethodResult>;
```

Steps:

1. **Load target user.** Call `appUserRepository.findUserById(input.targetUserId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Guard: DELETED.** If `user.status === 'DELETED'` → return `{ ok: false, code: 'USER_DELETED' }`. Cannot modify a tombstoned user.

3. **Guard: already the target method.** If `user.authMethod === input.newAuthMethod` → return `{ ok: false, code: 'ALREADY_METHOD' }`. Switching to the same method is a no-op error (the UI should prevent this, but the service is the authoritative check).

4. **For SSO → LOCAL — generate and hash temp password:**

   a. Generate a cryptographically random temp password:

   ```ts
   const tempPassword = generateTempPassword();
   // e.g. crypto.randomBytes(16).toString('hex') — 32-char hex string
   // Must be at least 16 chars, mixed-case alpha + numeric, satisfying any password policy enforced at sign-in.
   // Use the same generator as um08's createUser flow for consistency.
   ```

   b. Hash using Better-Auth's scrypt implementation:

   ```ts
   const hashedPassword = await hashPassword(tempPassword);
   ```

   > **Implementer note — `hashPassword`:** Better-Auth must expose a password-hashing utility (or the underlying scrypt function) so the service can hash a credential without going through an auth HTTP endpoint. Possible export paths: `better-auth/crypto`, `better-auth/utils`, or a `ctx.password.hash` helper accessible in the auth server context. Check `node_modules/better-auth` for an exported `hashPassword` or `createHash` function. If Better-Auth does not export a standalone hash function, use `better-auth`'s admin plugin `auth.api.setPassword` (if available) inside the repository layer — **but do not make an HTTP call from the service**. As a last resort, use the same `@node-rs/bcrypt` / `@noble/hashes/scrypt` package that Better-Auth uses internally (pin to the exact version in `package.json`). Whichever approach is chosen must produce a hash that Better-Auth's credential sign-in flow accepts; validate this via the integration test in §16.7.

5. **Open a Drizzle transaction and execute atomically:**

   **For SSO → LOCAL:**

   a. `await updateAuthMethodFields(tx, targetUserId, { authMethod: 'LOCAL', forcePasswordChange: true, failedLoginCount: 0, lockedUntil: null })`

   b. `await deleteAccountByProvider(tx, targetUserId, 'microsoft')` — removes the existing SSO link (if the user has one). No-op if the user was a PENDING SSO user who never activated.

   c. `await createCredentialAccount(tx, { userId: targetUserId, hashedPassword })`

   d. `const { revokedCount } = await deleteUserSessions(tx, targetUserId)`

   e. `await writeAuditEvent(tx, authMethodChangedEvent({ actorId, targetUserId, fromMethod: 'SSO', toMethod: 'LOCAL', revokedCount }))`

   **For LOCAL → SSO:**

   a. `await updateAuthMethodFields(tx, targetUserId, { authMethod: 'SSO', forcePasswordChange: false, failedLoginCount: 0, lockedUntil: null })`

   b. `await deleteAccountByProvider(tx, targetUserId, 'credential')` — removes password from `account`.

   c. `const { revokedCount } = await deleteUserSessions(tx, targetUserId)`

   d. `await writeAuditEvent(tx, authMethodChangedEvent({ actorId, targetUserId, fromMethod: 'LOCAL', toMethod: 'SSO', revokedCount }))`

6. **Return:**
   - SSO → LOCAL: `{ ok: true, newAuthMethod: 'LOCAL', tempPassword }` — plaintext returned to caller; stored nowhere.
   - LOCAL → SSO: `{ ok: true, newAuthMethod: 'SSO' }`

On any transaction error, propagate — transaction rolls back, no partial writes. The plaintext `tempPassword` (SSO → LOCAL only) is held in memory only for the duration of the request; it is never logged, never stored.

#### 16.3.1 — `USER_AUTH_METHOD_CHANGED` audit event

```ts
function authMethodChangedEvent(params: {
  actorId: string;
  targetUserId: string;
  fromMethod: "SSO" | "LOCAL";
  toMethod: "SSO" | "LOCAL";
  revokedCount: number;
}): WriteAuditEventInput {
  return {
    eventType: "USER_AUTH_METHOD_CHANGED",
    actorUserId: params.actorId,
    targetEntity: "APPUSER",
    targetId: params.targetUserId,
    beforeData: { authMethod: params.fromMethod },
    afterData: {
      authMethod: params.toMethod,
      sessionsRevoked: params.revokedCount,
    },
  };
}
```

`beforeData` and `afterData` never include the plaintext password, the scrypt hash, the Entra OID, or any credential material. `sessionsRevoked` is informational metadata.

### 16.4 — Server Action (`actions/users/switch-auth-method.action.ts`)

New file. Uses the `'use server'` directive. Parses input, resolves the actor, checks permission, calls service, calls `revalidatePath`.

```ts
"use server";

import { requirePermission } from "@/auth/require-permission";
import { switchAuthMethodSchema } from "@/validation/users";
import { switchAuthMethod } from "@/services/users/users-write.service";
import { PERMISSIONS, LEVELS } from "@/auth/permission-constants";
import { revalidatePath } from "next/cache";

type ActionState =
  | { status: "idle" }
  | { status: "success"; newAuthMethod: "LOCAL"; tempPassword: string }
  | { status: "success"; newAuthMethod: "SSO" }
  | { status: "error"; code: string; message: string };

export async function switchAuthMethodAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState>;
```

Steps:

1. **Parse input.** `switchAuthMethodSchema.safeParse({ userId: formData.get('userId'), newAuthMethod: formData.get('newAuthMethod') })`. If parse fails → return `{ status: 'error', code: 'VALIDATION_ERROR', message: 'Invalid input.' }`.

2. **Resolve actor and check permission.** `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)`. `requirePermission` redirects on unauthenticated/unauthorized — if it returns, the actor is authorized.

3. **Call service.** `const result = await switchAuthMethod({ actorId, targetUserId: input.userId, newAuthMethod: input.newAuthMethod })`.

4. **Handle service errors:**
   - `'USER_NOT_FOUND'` → `{ status: 'error', code: 'USER_NOT_FOUND', message: 'User not found.' }`
   - `'USER_DELETED'` → `{ status: 'error', code: 'USER_DELETED', message: 'Cannot modify a deleted user.' }`
   - `'ALREADY_METHOD'` → `{ status: 'error', code: 'ALREADY_METHOD', message: 'User already uses this authentication method.' }`

5. **On success:**

   ```ts
   revalidatePath("/administration/users");

   if (result.newAuthMethod === "LOCAL") {
     return {
       status: "success",
       newAuthMethod: "LOCAL",
       tempPassword: result.tempPassword,
     };
   }
   return { status: "success", newAuthMethod: "SSO" };
   ```

   > **Important — `tempPassword` in action return value:** The plaintext temp password is returned as part of the Server Action result only to drive the success UI. Next.js serializes Server Action results over an encrypted connection. The password must not be written to any log, must not appear in `afterData` of the audit event, and must not be stored in any database column. It lives in memory from the service call through the action return.

The action does **not** re-authorize by checking `target.userId !== actorId` — self-switching is permitted. The consequence (own session revoked) is communicated via the UI warning in §Design.

### 16.5 — `SwitchAuthMethodDialog` (`components/users/switch-auth-method-dialog.tsx`)

Client Component (`'use client'`). Manages dialog open state and the three visual states (confirm → success/temp-password or success/toast-then-close).

**Props:**

```ts
interface SwitchAuthMethodDialogProps {
  targetUserId: string;
  targetUserName: string;
  currentAuthMethod: "SSO" | "LOCAL";
  actorId: string;
}
```

**Derived constants (computed from props, not state):**

```ts
const newAuthMethod = currentAuthMethod === "SSO" ? "LOCAL" : "SSO";
const isSelfSwitch = actorId === targetUserId;
```

**State:**

```ts
const [open, setOpen] = useState(false);
const [actionState, formAction, isPending] = useActionState(
  switchAuthMethodAction,
  { status: "idle" },
);
```

The `<form>` contains two hidden inputs (`userId`, `newAuthMethod`) and no visible form fields. The submit button triggers the action.

**Dialog state machine (derived from `actionState.status`):**

- `'idle'` → render Confirmation state (State 1)
- `'error'` → render Confirmation state with an inline error alert (shadcn `Alert`, destructive variant) above the body, showing `actionState.message`. Keep the form live so the admin can retry.
- `'success'` + `newAuthMethod === 'LOCAL'` → render temp password state (State 2a). The dialog cannot be dismissed until the admin clicks "Done" — do not allow closing by clicking the overlay or pressing Escape while in this state (`onOpenChange` override when `actionState.status === 'success' && actionState.newAuthMethod === 'LOCAL'`).
- `'success'` + `newAuthMethod === 'SSO'` → close the dialog and fire a success toast (State 2b).

**Trigger button:**

```tsx
<Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
  Switch to {newAuthMethod === "LOCAL" ? "LOCAL" : "SSO"}
</Button>
```

**Dialog close behavior:** When the dialog closes (Cancel, or "Done" after SSO→LOCAL success, or programmatic close after LOCAL→SSO), reset `actionState` to `'idle'` via `startTransition(() => setOpen(false))`. Since `useActionState` does not expose a reset function directly, use a `key` prop on the `<form>` element to force re-mount on dialog close, which clears the action state.

**Toast (LOCAL → SSO success):**

```ts
useEffect(() => {
  if (actionState.status === "success" && actionState.newAuthMethod === "SSO") {
    setOpen(false);
    toast.success(
      `Authentication method switched to SSO. ${targetUserName} must sign in via Microsoft.`,
    );
  }
}, [actionState]);
```

Uses the project's existing `toast` utility (shadcn `Toaster` + `toast` from `sonner` or equivalent — use whatever is established in prior units).

**Temp password display (SSO → LOCAL, State 2a):** Reuse the `TempPasswordDisplay` component from um08 if it was extracted as a shared component, or inline the same pattern: monospace code block + copy button with `Check`/`Copy` icon swap.

### 16.6 — `UserDetail` changes (`components/users/user-detail.tsx`)

The `UserDetail` Server Component is updated to:

1. Accept two new optional props (`permissionMap` and `actorId` — see §Design).
2. Render `SwitchAuthMethodDialog` in the Auth Method row of the Access field group, when conditions are met.

The Access field group's Auth Method row changes from:

```tsx
<dd>
  <AuthMethodBadge authMethod={user.authMethod} />
</dd>
```

to:

```tsx
<dd className="flex items-center gap-2">
  <AuthMethodBadge authMethod={user.authMethod} />
  {canSwitch && (
    <SwitchAuthMethodDialog
      targetUserId={user.userId}
      targetUserName={user.userName}
      currentAuthMethod={user.authMethod}
      actorId={actorId!}
    />
  )}
</dd>
```

Where:

```ts
const canSwitch =
  permissionMap !== undefined &&
  actorId !== undefined &&
  hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT) &&
  user.status !== "DELETED";
```

No other sections of `UserDetail` change. The `usersReadService.getUserById` return type and shape are unchanged; no new data needs to be fetched for the switch.

### 16.7 — Tests

#### Unit tests: `switchAuthMethod` service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository` (all four new functions) and `writeAuditEvent`. Use a mock transaction that runs callbacks synchronously.

| Scenario                                        | Setup                                                                                                      | Expected                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSO → LOCAL, ACTIVE user                        | `findUserById` → `{ authMethod:'SSO', status:'ACTIVE' }`; `activateSsoUser`/hashing mocked                 | `updateAuthMethodFields` called with `{ authMethod:'LOCAL', forcePasswordChange:true, failedLoginCount:0, lockedUntil:null }`; `deleteAccountByProvider` called with `'microsoft'`; `createCredentialAccount` called; `deleteUserSessions` called; `USER_AUTH_METHOD_CHANGED` written; returns `{ ok:true, newAuthMethod:'LOCAL', tempPassword: <non-empty string> }` |
| SSO → LOCAL, PENDING user (never SSO'd)         | Same as above; `deleteAccountByProvider` is a no-op (no row to delete)                                     | All same as above; no error from the no-op delete                                                                                                                                                                                                                                                                                                                     |
| LOCAL → SSO, ACTIVE user                        | `findUserById` → `{ authMethod:'LOCAL', status:'ACTIVE' }`                                                 | `updateAuthMethodFields` called with `{ authMethod:'SSO', forcePasswordChange:false, failedLoginCount:0, lockedUntil:null }`; `deleteAccountByProvider` called with `'credential'`; `deleteUserSessions` called; `USER_AUTH_METHOD_CHANGED` written; returns `{ ok:true, newAuthMethod:'SSO' }`                                                                       |
| LOCAL → SSO, DISABLED user (has lockout state)  | `findUserById` → `{ authMethod:'LOCAL', status:'DISABLED', failedLoginCount:5, lockedUntil: <past Date> }` | `updateAuthMethodFields` called with `lockedUntil:null`, `failedLoginCount:0`; returns `{ ok:true, newAuthMethod:'SSO' }`                                                                                                                                                                                                                                             |
| User not found                                  | `findUserById` → `null`                                                                                    | Returns `{ ok:false, code:'USER_NOT_FOUND' }`; no writes                                                                                                                                                                                                                                                                                                              |
| User is DELETED                                 | `findUserById` → `{ status:'DELETED', authMethod:'SSO' }`                                                  | Returns `{ ok:false, code:'USER_DELETED' }`; no writes                                                                                                                                                                                                                                                                                                                |
| Already the target method                       | `findUserById` → `{ authMethod:'LOCAL', status:'ACTIVE' }`; `newAuthMethod = 'LOCAL'`                      | Returns `{ ok:false, code:'ALREADY_METHOD' }`; no writes                                                                                                                                                                                                                                                                                                              |
| Transaction rollback — `writeAuditEvent` throws | Mid-transaction throw                                                                                      | Exception propagates; `auth_method` on `APPUSER` unchanged; no partial writes                                                                                                                                                                                                                                                                                         |
| Audit event shape (SSO → LOCAL)                 | Happy path                                                                                                 | `writeAuditEvent` called with `eventType='USER_AUTH_METHOD_CHANGED'`, `actorUserId=actorId`, `targetEntity='APPUSER'`, `targetId=targetUserId`, `beforeData={ authMethod:'SSO' }`, `afterData` containing `{ authMethod:'LOCAL', sessionsRevoked: <number> }`; `afterData` does NOT contain `tempPassword` or `hashedPassword`                                        |
| Audit event shape (LOCAL → SSO)                 | Happy path                                                                                                 | Same shape; `beforeData={ authMethod:'LOCAL' }`, `afterData={ authMethod:'SSO', sessionsRevoked: <number> }`                                                                                                                                                                                                                                                          |
| Temp password is non-empty and not hashed       | SSO → LOCAL happy path                                                                                     | `result.tempPassword` is a non-empty plain string; `result.tempPassword !== hashedPassword` (mock the hasher to return a distinct value)                                                                                                                                                                                                                              |

#### Unit tests: Server Action (`tests/unit/actions/switch-auth-method.action.test.ts`)

Mock `requirePermission`, `switchAuthMethod` service, `revalidatePath`. No real DB.

| Scenario                         | Setup                                                                                    | Expected                                                                                                                          |
| -------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Valid SSO → LOCAL input          | Parse succeeds; service returns `{ ok:true, newAuthMethod:'LOCAL', tempPassword:'abc' }` | `revalidatePath` called with `'/administration/users'`; returns `{ status:'success', newAuthMethod:'LOCAL', tempPassword:'abc' }` |
| Valid LOCAL → SSO input          | Service returns `{ ok:true, newAuthMethod:'SSO' }`                                       | Returns `{ status:'success', newAuthMethod:'SSO' }`                                                                               |
| Invalid form data (bad UUID)     | `userId = 'not-a-uuid'`                                                                  | Returns `{ status:'error', code:'VALIDATION_ERROR' }`; service not called                                                         |
| Service returns `USER_NOT_FOUND` | Service returns `{ ok:false, code:'USER_NOT_FOUND' }`                                    | Returns `{ status:'error', code:'USER_NOT_FOUND', message: <non-empty string> }`                                                  |
| Service returns `USER_DELETED`   | Service returns `{ ok:false, code:'USER_DELETED' }`                                      | Returns `{ status:'error', code:'USER_DELETED', message: <non-empty string> }`                                                    |
| Service returns `ALREADY_METHOD` | Service returns `{ ok:false, code:'ALREADY_METHOD' }`                                    | Returns `{ status:'error', code:'ALREADY_METHOD', message: <non-empty string> }`                                                  |

#### Unit tests: `SwitchAuthMethodDialog` component (`tests/unit/components/users/switch-auth-method-dialog.test.tsx`)

Use `@testing-library/react` + `vitest`. Mock `switchAuthMethodAction`.

- Trigger button label is "Switch to LOCAL" when `currentAuthMethod='SSO'`
- Trigger button label is "Switch to SSO" when `currentAuthMethod='LOCAL'`
- Clicking the trigger opens the dialog; confirmation text is present
- Self-switch warning (`isSelfSwitch = true`) renders the warning Alert inside the dialog
- No self-switch warning when `actorId !== targetUserId`
- Confirm button is disabled and shows spinner while action is in flight
- On `{ status:'success', newAuthMethod:'SSO' }`: dialog closes; `toast.success` is called
- On `{ status:'success', newAuthMethod:'LOCAL', tempPassword:'xyz' }`: temp password `'xyz'` is rendered; "Done" button is present; dialog does not close on overlay click
- On `{ status:'error' }`: error alert is rendered inside the dialog; dialog remains open

#### Unit tests: `UserDetail` changes (`tests/unit/components/users/user-detail.test.tsx`)

Extend the existing test file.

- When `permissionMap` is absent: no "Switch to" button rendered
- When `permissionMap` grants `users:EDIT` and `user.status !== 'DELETED'`: "Switch to [method]" button rendered
- When `user.status === 'DELETED'`: no "Switch to" button rendered, even with `users:EDIT`
- When `actorId === user.userId` and the dialog is opened: the self-switch warning Alert is present

#### Integration tests (`tests/integration/services/switch-auth-method.test.ts`)

Against the test DB. Fixtures as needed (ACTIVE SSO user, ACTIVE LOCAL user with lockout state, PENDING SSO user).

| Test                                                   | Assertion                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SSO → LOCAL (ACTIVE user)                              | `appuser.auth_method = 'LOCAL'`; `appuser.force_password_change = true`; `account` row with `provider_id='credential'` exists; `account` row with `provider_id='microsoft'` absent; all session rows for user deleted; `AUDIT_LOG` has `USER_AUTH_METHOD_CHANGED`; `tempPassword` is a non-empty string that can be verified against the stored hash using Better-Auth's verify function |
| SSO → LOCAL (PENDING user, no prior SSO `account` row) | Same result; no error from missing `'microsoft'` account row                                                                                                                                                                                                                                                                                                                             |
| LOCAL → SSO (ACTIVE user with lockout)                 | `appuser.auth_method = 'SSO'`; `appuser.force_password_change = false`; `appuser.failed_login_count = 0`; `appuser.locked_until = null`; `account` row with `provider_id='credential'` absent; all session rows deleted; `AUDIT_LOG` has `USER_AUTH_METHOD_CHANGED`                                                                                                                      |
| Session revocation (ACTIVE user with 2 sessions)       | Insert 2 session rows for the target user before the call; after the call, both rows are gone; `sessionsRevoked` in `afterData` is `2`                                                                                                                                                                                                                                                   |
| Session revocation (PENDING user, 0 sessions)          | 0 session rows before; no error; `sessionsRevoked` is `0`                                                                                                                                                                                                                                                                                                                                |
| Transaction atomicity                                  | Simulate a DB error mid-transaction (e.g., make `writeAuditEvent` throw); assert `auth_method` unchanged, no `account` changes, no session deletions                                                                                                                                                                                                                                     |
| Hash round-trip (SSO → LOCAL)                          | After the switch, simulate a credential sign-in by calling Better-Auth's credential verification (or its hash-verify function) with the returned `tempPassword` against the stored hash; assert verification succeeds                                                                                                                                                                    |

---

## Dependencies

No new npm packages are required beyond what prior units have installed. Verify the following before implementation:

- **Better-Auth password hashing export:** Locate whether `better-auth` exports a standalone `hashPassword` or `verifyPassword` function (check `node_modules/better-auth` exported symbols). If not directly exported, identify the internal scrypt implementation it depends on (e.g., `@node-rs/bcrypt`, `@noble/hashes`) and use the same package at the same version. The hash produced must be verifiable by Better-Auth's credential sign-in path.
- **shadcn/ui components** — run the CLI only if not already added in a prior unit:
  - `npx shadcn@latest add toast` (or `sonner`) — success toast for LOCAL → SSO. Use whichever toast mechanism prior units established.
  - `npx shadcn@latest add alert` — confirmation dialog inline error and self-switch warning. Likely already added in um09 or um10; skip if present.

No new `PERMISSIONS` rows and no schema migrations required. All relevant columns (`auth_method`, `force_password_change`, `failed_login_count`, `locked_until`) and tables (`account`, `session`, `AUDIT_LOG`) are already in place from um02 and um03.

---

## Verification Checklist

### Guard and permission

- [ ] `switchAuthMethodAction` calls `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` before any business logic
- [ ] An unauthenticated request to the action redirects to `/login`
- [ ] A request from a no-grants (non-ADMIN) user is rejected by `requirePermission`
- [ ] The "Switch to [method]" button in `UserDetail` is hidden when `permissionMap` grants less than `users:EDIT`
- [ ] The "Switch to [method]" button is hidden when `user.status === 'DELETED'`
- [ ] The "Switch to [method]" button is visible for PENDING, ACTIVE, and DISABLED users when actor holds `users:EDIT`

### SSO → LOCAL happy path

- [ ] After the switch: `appuser.auth_method = 'LOCAL'` in the DB
- [ ] `appuser.force_password_change = true` in the DB
- [ ] A `credential` account row exists for the user in the `account` table
- [ ] The stored `account.password` is a non-plaintext scrypt hash (not the plaintext temp password)
- [ ] The `'microsoft'` account row (if it existed) has been deleted
- [ ] All session rows for the target user have been deleted
- [ ] The temp password is displayed once in the UI's success state (State 2a)
- [ ] The temp password is not visible anywhere after "Done" is clicked
- [ ] The `AuthMethodBadge` in `UserDetail` shows `LOCAL` after the dialog closes
- [ ] `AUDIT_LOG` has a `USER_AUTH_METHOD_CHANGED` row with `before_data.authMethod='SSO'`, `after_data.authMethod='LOCAL'`
- [ ] `after_data` in the audit event does NOT contain the plaintext or hashed password

### LOCAL → SSO happy path

- [ ] After the switch: `appuser.auth_method = 'SSO'` in the DB
- [ ] `appuser.force_password_change = false` in the DB
- [ ] `appuser.failed_login_count = 0` in the DB
- [ ] `appuser.locked_until = null` in the DB
- [ ] The `credential` account row has been deleted from the `account` table
- [ ] All session rows for the target user have been deleted
- [ ] A success toast is shown; the dialog closes
- [ ] The `AuthMethodBadge` in `UserDetail` shows `SSO` after the dialog closes
- [ ] `AUDIT_LOG` has a `USER_AUTH_METHOD_CHANGED` row with `before_data.authMethod='LOCAL'`, `after_data.authMethod='SSO'`
- [ ] After LOCAL → SSO, the user can sign in via Entra (um10's SSO linking creates the `'microsoft'` account row on first SSO sign-in)
- [ ] After LOCAL → SSO, the user cannot sign in via the credential form (no `credential` account row exists)

### Session revocation

- [ ] All session rows for the target user are deleted within the same transaction as the `auth_method` update
- [ ] A target user with 0 sessions does not cause an error (valid no-op)
- [ ] The `sessionsRevoked` count in `AUDIT_LOG.after_data` matches the number of session rows deleted
- [ ] The actor's own session is NOT deleted unless `actorId === targetUserId` (self-switch)
- [ ] On a self-switch, the actor's session is revoked and their next request (after the action resolves) redirects to `/login`

### Confirmation dialog UX

- [ ] Dialog title reflects the direction: "Switch to LOCAL authentication" or "Switch to SSO authentication"
- [ ] The body lists all three consequences for the relevant direction (remove SSO link / remove password, temp password / clear lockout, revoke sessions)
- [ ] The self-switch warning Alert is shown when `targetUserId === actorId`
- [ ] The self-switch warning is not shown when `targetUserId !== actorId`
- [ ] The primary confirm button is disabled and shows a spinner while the action is in flight
- [ ] Both buttons (Cancel and confirm) are disabled during the in-flight period
- [ ] Cancel closes the dialog without making any changes
- [ ] An `actionState.status === 'error'` result renders an inline error Alert inside the dialog; the dialog stays open for retry

### State 2a — temp password display (SSO → LOCAL)

- [ ] The temp password is rendered in a monospace code block
- [ ] The copy-to-clipboard button copies the temp password and shows a `Check` icon for 2 seconds
- [ ] The "Done" button closes the dialog
- [ ] Pressing Escape or clicking the dialog overlay does NOT close the dialog while in State 2a (temp password is not confirmed seen yet)
- [ ] After "Done" is clicked, the temp password is no longer accessible in the UI

### State 2b — success toast (LOCAL → SSO)

- [ ] A success toast appears with the switched user's name and "must sign in via Microsoft"
- [ ] The dialog closes automatically after a successful LOCAL → SSO switch

### Transaction atomicity

- [ ] If `updateAuthMethodFields` throws mid-transaction: `account` table unchanged, sessions unchanged, no `AUDIT_LOG` row written
- [ ] If `createCredentialAccount` throws mid-transaction (SSO → LOCAL): `auth_method` on `APPUSER` unchanged, sessions unchanged, no audit row written
- [ ] If `deleteUserSessions` throws mid-transaction: `auth_method` and `account` changes rolled back, no audit row written
- [ ] If `writeAuditEvent` throws mid-transaction: all prior steps rolled back — `auth_method`, `account`, and sessions unchanged
- [ ] The audit event and all data changes are committed in the same transaction (no split writes)

### Mutual exclusivity enforcement

- [ ] After SSO → LOCAL: the user has exactly one `account` row with `provider_id = 'credential'`; no `'microsoft'` row
- [ ] After LOCAL → SSO: the user has no `account` rows until the next Entra sign-in creates the `'microsoft'` row
- [ ] Attempting to switch to the same method (e.g., LOCAL → LOCAL) returns `{ status:'error', code:'ALREADY_METHOD' }`

### Audit

- [ ] `USER_AUTH_METHOD_CHANGED` is the exact `event_type` value written (matching the registry in the overview)
- [ ] `actor_user_id` is the acting admin's `userId`, not the target user's
- [ ] `target_entity = 'APPUSER'`, `target_id = targetUserId`
- [ ] `before_data` contains only `{ authMethod: <prior method> }`
- [ ] `after_data` contains `{ authMethod: <new method>, sessionsRevoked: <count> }`
- [ ] No plaintext password, scrypt hash, or Entra OID appears in `before_data` or `after_data`
- [ ] App DB role can INSERT into `AUDIT_LOG` but cannot UPDATE or DELETE (invariant from um03; not modified by um16)

### Credential security

- [ ] The plaintext temp password is never written to any DB column, log line, or server response body beyond the Server Action return value
- [ ] The scrypt hash is stored only in `account.password` and nowhere else
- [ ] `tsc --noEmit` confirms `tempPassword` is not present in `WriteAuditEventInput` or any audit-related type
- [ ] The temp password does not appear in any `console.*` or `logger.*` call

### Boundary and TypeScript

- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `db/repositories/app-user.repository.ts` has no business logic — only Drizzle queries
- [ ] `actions/users/switch-auth-method.action.ts` has `'use server'` at the top
- [ ] `components/users/switch-auth-method-dialog.tsx` has `'use client'` at the top; no DB access or direct service calls
- [ ] `components/users/user-detail.tsx` has no DB imports — data received as props only
- [ ] `validation/users.ts` has no imports from `next/*`, `db/**`, `services/**`, `auth/**`, or UI modules
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] `vitest run` passes all `switchAuthMethod` service unit tests (10 scenarios per §16.7)
- [ ] `vitest run` passes all `switchAuthMethodAction` unit tests (6 scenarios per §16.7)
- [ ] `vitest run` passes all `SwitchAuthMethodDialog` component unit tests (8 scenarios per §16.7)
- [ ] `vitest run` passes all `UserDetail` change unit tests (4 scenarios per §16.7)
- [ ] Integration tests pass: SSO→LOCAL (ACTIVE), SSO→LOCAL (PENDING no-op delete), LOCAL→SSO (lockout cleared), session revocation counts, atomicity rollback, hash round-trip

### Scope guard

- [ ] No other user fields (name, phone, roles, status) are modified by this unit
- [ ] No new `PERMISSIONS` rows were added
- [ ] No schema migrations were added or required
- [ ] The `requirePermission` call and all prior unit guard patterns are unmodified
- [ ] The um10 SSO first-sign-in linking flow (`auth/sso-linking.ts`) is unmodified — it handles `'microsoft'` account creation on next sign-in after LOCAL → SSO switch
- [ ] The credential sign-in hook from um03 (lockout logic on `failed_login_count`) is unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
