# Spec: um09 — Forced first-login password change (`/set-password`) + LOCAL activation

- **Boundary:** AUTH / APP
- **Dependencies:** Unit um08 (creates LOCAL users with `force_password_change = TRUE`, `status = PENDING`, `account.password` holding the scrypt-hashed temp password; `hashTempPassword` in `lib/temp-password.ts`; `appUserRepository` write functions; `writeAuditEvent`); Unit um06 (authenticated layout, `requirePermission`, `resolveEffectivePermissions`, `(admin)` layout — the guard added here extends the session-resolution helper established there); Unit um03 (sign-in hook — writes `LOCAL_LOGIN` at temp-password sign-in, sets `last_login_datetime`, establishes the session that this unit's guard detects).
- **Source sections:** overview §"Core User Flow" item 4 (LOCAL activation), §"Authentication & sessions" (forced first-login change, scrypt), §"Audit Events" (`USER_FIRST_LOGIN`, `USER_PASSWORD_CHANGED`); architecture §2 (folder ownership: `app/(auth)/**` owns `/set-password`; boundary rules), §5 (account lifecycle PENDING → ACTIVE, auth-method exclusivity), §6 (per-page permission matrix: `/set-password` is session-gated with `force_password_change = TRUE`); code-standards §3 (Server Actions as public endpoints, parse-then-call). Invariants: **#1** (no plaintext credentials — new password hashed before any persistence), **#2** (authz state never in session — `force_password_change` loaded from DB), **#3** (server-side authz — action re-checks the flag before writing), **#4** (deny by default), **#11** (audit every mutation — `USER_PASSWORD_CHANGED` and `USER_FIRST_LOGIN` written), **#14** (DB only in `db/**`), **#16** (all external input validated via Zod at the action boundary), **#19** (Better-Auth field mapping — password stored only as scrypt hash in `account`).

---

## Goal

Intercept every authenticated page route when the session's user has `force_password_change = TRUE` and redirect to `/set-password`; the `SetPasswordForm` collects and validates a new password; on submission the Server Action hashes the new password, clears the flag, writes `USER_PASSWORD_CHANGED` to `AUDIT_LOG`, and — if the user was `PENDING` — atomically flips status to `ACTIVE` and writes `USER_FIRST_LOGIN`, so that a newly created LOCAL user completes activation the first time they sign in.

---

## Design

### `/set-password` page layout

The page lives in `app/(auth)/set-password/` alongside the existing `/login` page — no admin sidebar, no navigation. It renders a centered, single-column card (same visual framing as `/login`): max-width `28rem`, `--surface-card` background, `--shadow-md`, `--radius-lg`, `padding: 2rem`.

Card contents top-to-bottom:

1. App logo / name lockup (same as `/login` — reuse the logo component if one exists).
2. Heading `<h1>` "Set your password" (`--text-h2` size, `--text-primary` color).
3. Context paragraph: "You're signing in for the first time. Please set a new password to continue." (`--text-body`, `--text-muted`). This sentence is conditional — render it only when the user status is `PENDING`. If an ACTIVE user with a re-issued temp password lands here (admin reset path), the paragraph is omitted; only the heading and form render.
4. `<SetPasswordForm />` — the client-form component.
5. "Sign out" text link below the card (`--text-body-sm`, `--text-muted`), aligned center. Calls `authClient.signOut()` and redirects to `/login`. This lets a user who landed here by mistake (e.g., shared machine) exit without setting a password.

### SetPasswordForm fields

Single-column layout, standard vertical field spacing.

| Field            | Type           | Required | Notes                                                                     |
| ---------------- | -------------- | -------- | ------------------------------------------------------------------------- |
| New Password     | Password input | Yes      | Show/hide toggle (lucide `Eye` / `EyeOff`); `autoComplete="new-password"` |
| Confirm Password | Password input | Yes      | Show/hide toggle; `autoComplete="new-password"`                           |

Both fields use the same show/hide toggle state independently (separate `useState` per field). Neither field shows the typed value by default.

The submit button "Set Password" (primary style, full-width) shows a loading spinner (`Loader2` icon, `animate-spin`) and is `disabled` while the Server Action is in flight. The button is also disabled while the form has unresolved validation errors.

Field-level validation errors appear below the relevant input in `--text-danger` / `--text-body-sm`. A form-level mismatch error ("Passwords do not match") is shown beneath the Confirm Password field.

After successful submission the page navigates away via `redirect('/')` server-side — no client-side success state is needed on this form.

### Password requirements

Enforced by the shared Zod schema (client + server):

- Minimum 12 characters.
- Maximum 128 characters.
- No character-class complexity rules in v1 — length-only enforcement.

These constraints are shown as helper text below the New Password field at all times (not only on error): "At least 12 characters." (`--text-body-sm`, `--text-muted`).

### Force-password-change guard

The guard is implemented **at the session-resolution layer** in `auth/`, not in Next.js `middleware.ts`. Rationale: `force_password_change` lives on `APPUSER` (a Postgres column), not in the session cookie — the check requires a DB read, which the edge runtime cannot perform with Drizzle. The authenticated session resolver already reads `APPUSER` to check `status = ACTIVE` (established in um06); adding the `force_password_change` check is a single additional condition in the same read path.

**Routes exempt from the redirect:** `/set-password` itself and the Better-Auth handler at `/api/auth/**`. Both are naturally exempt — `/set-password` uses its own separate resolver (`resolveForcePasswordChangeSession`), and `/api/auth/**` Route Handlers never call the authenticated-session helper.

The guard **does not use Next.js `middleware.ts`** for anything related to `force_password_change`. The existing middleware (if any, from um06) handles only cookie-level session presence checks; DB-dependent checks remain in the layout/page layer.

### Activation logic (PENDING → ACTIVE)

The status transition is driven by the user's `status` at the time the action executes, not by any session flag. The action reads `status` from `APPUSER` inside the same transaction that writes the new password. If `status = PENDING`, the action additionally sets `status = ACTIVE` and writes `USER_FIRST_LOGIN`. If `status = ACTIVE` (admin-reset path), neither status change nor `USER_FIRST_LOGIN` is written — only `USER_PASSWORD_CHANGED`.

This means the guard and the action both independently validate `force_password_change = TRUE`; the action is the authoritative enforcement point (defense in depth per invariant #3).

---

## Implementation

### 9.1 — Auth helper: `resolveAuthenticatedUser` extension (`auth/session.ts`)

The authenticated-session resolver established in um06 already reads `APPUSER` to verify `status = ACTIVE`. Extend it to also read `force_password_change`.

**After the `status = ACTIVE` check, add:**

```ts
if (user.forcePasswordChange) {
  redirect("/set-password");
}
```

This `redirect` executes before returning the user object, so all callers of `resolveAuthenticatedUser` automatically enforce the constraint — the `(admin)` layout, the root redirect page, and `/no-access` all get the guard for free with no changes to those files beyond picking up the updated helper.

The resolver returns `forcePasswordChange` as part of its user shape so callers can read it if needed (even though, after the guard, it will always be `FALSE` for callers that reach further).

**Callers to verify after this change (no edits required — just confirm they pick up the updated helper):**

- `app/(admin)/layout.tsx`
- `app/page.tsx` (root redirect)
- `app/no-access/page.tsx`

### 9.2 — Auth helper: `resolveForcePasswordChangeSession` (`auth/session.ts`)

Add a second exported helper specifically for the `/set-password` page. This helper is the **inverse** of the standard guard.

```ts
export async function resolveForcePasswordChangeSession(): Promise<{
  userId: string;
  userName: string;
  status: "PENDING" | "ACTIVE";
}> {
  const session = await getSession(); // Better-Auth's session getter

  if (!session?.user?.id) {
    redirect("/login");
  }

  const user = await appUserRepository.findUserById(session.user.id);

  if (!user || user.status === "DISABLED" || user.status === "DELETED") {
    redirect("/login");
  }

  if (!user.forcePasswordChange) {
    redirect("/"); // already completed — send to root
  }

  return {
    userId: user.userId,
    userName: user.userName,
    status: user.status as "PENDING" | "ACTIVE",
  };
}
```

This helper redirects away from `/set-password` if the user does not need to change their password, preventing it from being accessed directly by an already-activated user.

### 9.3 — Repository additions (`db/repositories/app-user.repository.ts`)

Add three focused write functions. All accept a Drizzle transaction handle `tx` and make no audit writes.

#### 9.3.1 — `updateAccountPassword(tx, userId, passwordHash): Promise<void>`

```sql
UPDATE core.account
SET    password   = $passwordHash,
       updated_at = NOW()
WHERE  user_id    = $userId
  AND  provider_id = 'credential'
```

Targets the single `credential` account row for the user. Throws if no row is updated (should never occur for a LOCAL user, but fail loudly).

#### 9.3.2 — `clearForcePasswordChange(tx, userId): Promise<void>`

```sql
UPDATE core.appuser
SET    force_password_change   = FALSE,
       last_modified_datetime  = NOW()
WHERE  user_id = $userId
```

#### 9.3.3 — `activateUser(tx, userId): Promise<{ wasActivated: boolean }>`

```sql
UPDATE core.appuser
SET    status                 = 'ACTIVE',
       last_modified_datetime = NOW()
WHERE  user_id = $userId
  AND  status  = 'PENDING'
```

Returns `{ wasActivated: true }` if the UPDATE affected one row (status was PENDING), `{ wasActivated: false }` otherwise (status was already ACTIVE). The return value controls whether `USER_FIRST_LOGIN` is written.

#### 9.3.4 — `findUserById` (extend or confirm existing)

The helper `resolveForcePasswordChangeSession` (§9.2) calls `appUserRepository.findUserById(userId)`. This function likely already exists from um06/um07. Confirm it returns `forcePasswordChange` and `status`. If it does not return `forcePasswordChange`, extend the SELECT to include that column.

### 9.4 — Validation schema (`validation/password.ts`)

New file. Imports only `zod`. No `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports.

```ts
import { z } from "zod";

export const setPasswordSchema = z
  .object({
    newPassword: z
      .string()
      .min(12, "Password must be at least 12 characters.")
      .max(128, "Password must be at most 128 characters."),
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type SetPasswordInput = z.infer<typeof setPasswordSchema>;
```

The schema is the single source of truth — imported by both the Server Action (server-side parse) and `SetPasswordForm` (via `zodResolver`).

### 9.5 — Service (`services/users/users-auth.service.ts`)

New file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`. Imports from `db/repositories/`, `lib/temp-password.ts` (for `hashTempPassword`), `auth/` (audit helper), and `types/`.

#### `setPassword(userId: string, newPasswordPlaintext: string): Promise<SetPasswordResult>`

```ts
type SetPasswordResult =
  | { ok: true; wasFirstLogin: boolean }
  | { ok: false; code: "FORCE_CHANGE_NOT_REQUIRED" }
  | { ok: false; code: "USER_NOT_FOUND" };
```

Steps:

1. **Load current user state.** Call `appUserRepository.findUserById(userId)`. If `null` or `status` is `DISABLED`/`DELETED` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Guard: verify flag is still set.** If `!user.forcePasswordChange` → return `{ ok: false, code: 'FORCE_CHANGE_NOT_REQUIRED' }`. This is a defensive check; the page-level guard should prevent reaching this path, but the service must not assume it.

3. **Hash new password.** Call `hashTempPassword(newPasswordPlaintext)` from `lib/temp-password.ts` → `passwordHash`. The plaintext is held only in the local scope of this function.

4. **Snapshot pre-state.** Record `wasStatusPending = user.status === 'PENDING'` before the transaction opens.

5. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `updateAccountPassword(tx, userId, passwordHash)`.

   b. `clearForcePasswordChange(tx, userId)`.

   c. `const { wasActivated } = await activateUser(tx, userId)`. (Only changes DB state when `wasStatusPending = true`; the `WHERE status = 'PENDING'` clause makes it a no-op for ACTIVE users.)

   d. Write `USER_PASSWORD_CHANGED` audit event (§9.5.1) inside the transaction.

   e. If `wasActivated`: write `USER_FIRST_LOGIN` audit event (§9.5.2) inside the transaction.

6. **Return.** `{ ok: true, wasFirstLogin: wasActivated }`.

On any transaction error, allow the exception to propagate — the transaction rolls back, nothing is persisted. The action catches and maps to a generic server error.

The plaintext `newPasswordPlaintext` is never assigned to a broader-scoped variable, never logged, and never written to the DB or `AUDIT_LOG`.

#### 9.5.1 — `USER_PASSWORD_CHANGED` audit event

```ts
{
  eventType:    'USER_PASSWORD_CHANGED',
  actorUserId:  userId,      // the user changing their own password
  targetEntity: 'APPUSER',
  targetId:     userId,
  beforeData:   null,
  afterData:    { forcePasswordChange: false },
}
```

`before_data` is `null` — no password-related data is recorded. `after_data` captures that the flag was cleared; no hash or plaintext is ever present in audit data.

#### 9.5.2 — `USER_FIRST_LOGIN` audit event

Written only when `wasActivated = true`.

```ts
{
  eventType:    'USER_FIRST_LOGIN',
  actorUserId:  userId,
  targetEntity: 'APPUSER',
  targetId:     userId,
  beforeData:   { status: 'PENDING' },
  afterData:    { status: 'ACTIVE' },
}
```

### 9.6 — Server Action (`actions/auth/set-password.action.ts`)

`'use server'`. Imports `setPasswordSchema` from `validation/password.ts`, `resolveForcePasswordChangeSession` from `auth/session.ts`, `setPassword` from `services/users/users-auth.service.ts`, `redirect` from `next/navigation`.

```ts
export async function setPasswordAction(
  rawInput: unknown,
): Promise<SetPasswordActionResult> { ... }

type SetPasswordActionResult =
  | { ok: true }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { ok: false; code: 'FORBIDDEN' }
  | { ok: false; code: 'SERVER_ERROR' }
```

Steps:

1. **Resolve session.** Call `resolveForcePasswordChangeSession()`. This call may `redirect('/login')` or `redirect('/')` internally; those redirects propagate as Next.js `NEXT_REDIRECT` throws — **do not catch them** (let them propagate so Next.js processes the redirect). Only catch non-redirect errors. If the function returns a user, proceed.

2. **Parse input.** `const parsed = setPasswordSchema.safeParse(rawInput)`. If `!parsed.success` → return `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. **Call service.** `const result = await setPassword(session.userId, parsed.data.newPassword)`.

4. **Map service errors.**
   - `FORCE_CHANGE_NOT_REQUIRED` → return `{ ok: false, code: 'FORBIDDEN' }`.
   - `USER_NOT_FOUND` → return `{ ok: false, code: 'FORBIDDEN' }`.
   - Unexpected thrown error → return `{ ok: false, code: 'SERVER_ERROR' }`.

5. **On success.** Call `redirect('/')`. This is a server-side redirect — it throws `NEXT_REDIRECT` internally and Next.js processes it. The action does not `return` after `redirect()`.

The action never logs the plaintext password. `parsed.data.newPassword` is passed directly to the service and goes out of scope.

### 9.7 — `/set-password` page (`app/(auth)/set-password/page.tsx`)

Server Component. No `'use client'`.

```ts
import { resolveForcePasswordChangeSession } from '@/auth/session'
import { SetPasswordForm }                   from '@/components/auth/set-password-form'

export const dynamic = 'force-dynamic'

export default async function SetPasswordPage() {
  const { userName, status } = await resolveForcePasswordChangeSession()
  const isFirstLogin = status === 'PENDING'

  return (
    <main className="...">   {/* centered flex layout */}
      <div className="...">  {/* card */}
        {/* Logo */}
        <h1>Set your password</h1>
        {isFirstLogin && (
          <p>You&apos;re signing in for the first time. Please set a new password to continue.</p>
        )}
        <SetPasswordForm />
        <a href="/api/auth/sign-out?callbackUrl=/login">Sign out</a>
      </div>
    </main>
  )
}
```

`force-dynamic` is required because `resolveForcePasswordChangeSession` reads the session cookie, which varies per request.

The `userName` value is available if the page needs to personalise the heading (e.g., "Hi, {firstName}") — include it only if the design calls for it; the heading is "Set your password" by default.

The "Sign out" link targets Better-Auth's sign-out endpoint. Confirm the exact URL against the Better-Auth config in `auth/` — it may be `/api/auth/sign-out` with a `callbackUrl` query param, or a dedicated handler path.

### 9.8 — `SetPasswordForm` component (`components/auth/set-password-form.tsx`)

Client Component (`'use client'`). No props. Calls `setPasswordAction` directly.

**State:**

```ts
const [showNew, setShowNew] = useState(false);
const [showConfirm, setShowConfirm] = useState(false);
const [serverError, setServerError] = useState<string | null>(null);
```

Uses `react-hook-form` with `useForm<SetPasswordInput>` + `zodResolver(setPasswordSchema)`. Default values: `newPassword: ''`, `confirmPassword: ''`.

**On submit:**

```ts
const onSubmit = async (values: SetPasswordInput) => {
  setServerError(null);
  const result = await setPasswordAction(values);

  // If redirect() was called server-side, this line is never reached.
  // Only handle error cases:
  if (!result?.ok) {
    if (result?.code === "VALIDATION_ERROR") {
      // Set field errors from server
      Object.entries(result.fieldErrors).forEach(([field, messages]) => {
        form.setError(field as keyof SetPasswordInput, {
          message: messages[0],
        });
      });
    } else {
      setServerError("Something went wrong. Please try again.");
    }
  }
};
```

Note: when `setPasswordAction` issues a `redirect('/')`, Next.js performs a navigation and the component unmounts — `result` is never received. The handler only runs for actual error return values.

**New Password field:**

```tsx
<div>
  <label htmlFor="newPassword">New Password</label>
  <div className="relative">
    <Input
      id="newPassword"
      type={showNew ? "text" : "password"}
      autoComplete="new-password"
      {...form.register("newPassword")}
    />
    <button
      type="button"
      onClick={() => setShowNew((v) => !v)}
      aria-label={showNew ? "Hide password" : "Show password"}
    >
      {showNew ? <EyeOff size={16} /> : <Eye size={16} />}
    </button>
  </div>
  <p className="helper-text">At least 12 characters.</p>
  {form.formState.errors.newPassword && (
    <p className="error-text">{form.formState.errors.newPassword.message}</p>
  )}
</div>
```

**Confirm Password field:** same structure as New Password, bound to `confirmPassword`, no helper text, uses `showConfirm` state.

**Submit button:**

```tsx
<Button type="submit" disabled={isSubmitting} className="w-full">
  {isSubmitting ? <Loader2 className="animate-spin" size={16} /> : null}
  Set Password
</Button>
```

**Server error banner:** if `serverError` is non-null, render a shadcn `Alert` (destructive variant) above the submit button: `<Alert variant="destructive"><AlertDescription>{serverError}</AlertDescription></Alert>`.

The form component does NOT import `setPasswordSchema` for client-side validation beyond what `zodResolver` already handles — `zodResolver(setPasswordSchema)` is the only wiring needed.

### 9.9 — Extend `resolveAuthenticatedUser` callers (no edits — verification only)

After the change in §9.1, verify that the three existing callers still typecheck and behave correctly:

- `app/(admin)/layout.tsx` — already calls the helper; now automatically redirects to `/set-password` when `force_password_change = TRUE`.
- `app/page.tsx` — root redirect page; same.
- `app/no-access/page.tsx` — same.

No code edits are required in these files beyond ensuring they consume the updated helper. Run `tsc --noEmit` to confirm.

### 9.10 — Tests

#### Unit tests: service (`tests/unit/services/users-auth.service.test.ts`)

Mock `appUserRepository`, `hashTempPassword`, and `writeAuditEvent`.

| Scenario                             | Setup                                                                                                       | Expected                                                                                                                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PENDING user sets password           | `findUserById` → `{ status:'PENDING', forcePasswordChange:true }`; `activateUser` → `{ wasActivated:true }` | `updateAccountPassword` called with a hash; `clearForcePasswordChange` called; `activateUser` called; `USER_PASSWORD_CHANGED` + `USER_FIRST_LOGIN` both written; returns `{ ok:true, wasFirstLogin:true }` |
| ACTIVE user with reset sets password | `findUserById` → `{ status:'ACTIVE', forcePasswordChange:true }`; `activateUser` → `{ wasActivated:false }` | `updateAccountPassword` + `clearForcePasswordChange` called; only `USER_PASSWORD_CHANGED` written (no `USER_FIRST_LOGIN`); returns `{ ok:true, wasFirstLogin:false }`                                      |
| `force_password_change = FALSE`      | `findUserById` → `{ status:'ACTIVE', forcePasswordChange:false }`                                           | Returns `{ ok:false, code:'FORCE_CHANGE_NOT_REQUIRED' }`; no writes                                                                                                                                        |
| User not found                       | `findUserById` → `null`                                                                                     | Returns `{ ok:false, code:'USER_NOT_FOUND' }`; no writes                                                                                                                                                   |
| Transaction error                    | `updateAccountPassword` throws                                                                              | Exception propagates; `writeAuditEvent` not called; DB is in pre-transaction state                                                                                                                         |
| Plaintext not in audit               | PENDING user happy path                                                                                     | Inspect all `writeAuditEvent` call arguments — assert no argument contains the raw password string                                                                                                         |

#### Unit tests: action (`tests/unit/actions/set-password.action.test.ts`)

Mock `resolveForcePasswordChangeSession`, `setPassword` (service), and `redirect`.

| Scenario                       | Setup                                                            | Expected                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Valid input, PENDING user      | `setPassword` → `{ ok:true, wasFirstLogin:true }`                | `redirect('/')` called once                                                                                  |
| Valid input, ACTIVE user reset | `setPassword` → `{ ok:true, wasFirstLogin:false }`               | `redirect('/')` called once                                                                                  |
| Validation failure — too short | `newPassword: '123'`                                             | Returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ newPassword:[...] } }`; `setPassword` not called |
| Validation failure — mismatch  | `newPassword` ≠ `confirmPassword`                                | Returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ confirmPassword:[...] } }`                       |
| Session redirect (no session)  | `resolveForcePasswordChangeSession` throws `NEXT_REDIRECT`       | Re-throws; `setPassword` not called                                                                          |
| `FORCE_CHANGE_NOT_REQUIRED`    | `setPassword` → `{ ok:false, code:'FORCE_CHANGE_NOT_REQUIRED' }` | Returns `{ ok:false, code:'FORBIDDEN' }`                                                                     |
| Server error                   | `setPassword` throws                                             | Returns `{ ok:false, code:'SERVER_ERROR' }`                                                                  |

Assert `redirect` is never called on error paths.

#### Unit tests: `SetPasswordForm` (`tests/unit/components/set-password-form.test.tsx`)

Use `@testing-library/react` + `vitest`. Mock `setPasswordAction`.

- Both password fields render as `type="password"` by default.
- Clicking "Show password" toggle on New Password switches its `type` to `text`; Confirm Password field is unaffected.
- Clicking the toggle again reverts to `type="password"`.
- Submitting with `newPassword` < 12 chars shows an error below that field; `setPasswordAction` not called.
- Submitting with `newPassword` ≠ `confirmPassword` shows "Passwords do not match." below Confirm field.
- Submit button is disabled and shows spinner while action is in flight (mock with a delayed promise).
- When `setPasswordAction` returns `{ ok:false, code:'SERVER_ERROR' }`, an alert banner appears.
- When `setPasswordAction` returns a `VALIDATION_ERROR`, the relevant field shows the server-returned error.

#### Unit tests: `resolveForcePasswordChangeSession` (`tests/unit/auth/session.test.ts`)

Mock `getSession` and `appUserRepository.findUserById`.

| Scenario                                 | Setup                                                              | Expected                                         |
| ---------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| No session                               | `getSession` → `null`                                              | `redirect('/login')` called                      |
| Session, user not found                  | `getSession` → `{ user: { id:'u1' } }`; `findUserById` → `null`    | `redirect('/login')` called                      |
| Session, user DISABLED                   | `findUserById` → `{ status:'DISABLED', forcePasswordChange:true }` | `redirect('/login')` called                      |
| Session, `forcePasswordChange=false`     | `findUserById` → `{ status:'ACTIVE', forcePasswordChange:false }`  | `redirect('/')` called                           |
| Session, PENDING, flag true              | `findUserById` → `{ status:'PENDING', forcePasswordChange:true }`  | Returns `{ userId, userName, status:'PENDING' }` |
| Session, ACTIVE, flag true (admin reset) | `findUserById` → `{ status:'ACTIVE', forcePasswordChange:true }`   | Returns `{ userId, userName, status:'ACTIVE' }`  |

#### Unit tests: authenticated-session guard extension (`tests/unit/auth/session.test.ts`)

Add to the existing test file for `resolveAuthenticatedUser`.

| Scenario                                 | Setup                                                            | Expected                                              |
| ---------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| ACTIVE user, `forcePasswordChange=false` | Standard happy path                                              | Returns user; no redirect                             |
| ACTIVE user, `forcePasswordChange=true`  | `findUserById` → `{ status:'ACTIVE', forcePasswordChange:true }` | `redirect('/set-password')` called; user not returned |
| PENDING user, `forcePasswordChange=true` | Same shape                                                       | `redirect('/set-password')` called                    |

#### Integration tests (`tests/integration/set-password.test.ts`)

Use the test DB. Fixtures: `local_pending_user` (PENDING, `force_password_change=TRUE`, temp password hashed in `account`); `local_active_user` (ACTIVE, `force_password_change=TRUE`, temp password hashed — simulates admin password reset); `admin_user` (ACTIVE, `force_password_change=FALSE`).

**Happy path — first login (PENDING):**

1. Sign in as `local_pending_user` — session is created.
2. Call `setPasswordAction({ newPassword: 'TestPassword123', confirmPassword: 'TestPassword123' })` with that session.
3. Assert:
   - `account.password` is updated (hash differs from the original temp hash).
   - The new hash verifies against the new plaintext (use Better-Auth's `verifyPassword` or equivalent).
   - `appuser.force_password_change = FALSE`.
   - `appuser.status = 'ACTIVE'`.
   - `AUDIT_LOG` contains a `USER_PASSWORD_CHANGED` entry: `actor_user_id = local_pending_user.userId`, `before_data = NULL`, `after_data = { forcePasswordChange: false }`. No password material in any audit column.
   - `AUDIT_LOG` contains a `USER_FIRST_LOGIN` entry: `actor_user_id = local_pending_user.userId`, `before_data = { status: 'PENDING' }`, `after_data = { status: 'ACTIVE' }`.
   - `redirect('/')` was issued.

**Admin-reset path (ACTIVE):**

1. Call `setPasswordAction` with `local_active_user` session.
2. Assert:
   - `account.password` updated.
   - `appuser.force_password_change = FALSE`.
   - `appuser.status` remains `ACTIVE`.
   - `AUDIT_LOG` contains `USER_PASSWORD_CHANGED`.
   - `AUDIT_LOG` does NOT contain `USER_FIRST_LOGIN`.

**Guard — already-activated user cannot reach `/set-password`:**

1. Call `resolveForcePasswordChangeSession` with `admin_user` session (`force_password_change=FALSE`).
2. Assert `redirect('/')` is called; no user object returned.

**Guard — authenticated routes redirect PENDING user:**

1. Call `resolveAuthenticatedUser` with `local_pending_user` session (`force_password_change=TRUE`).
2. Assert `redirect('/set-password')` is called; user object not returned.

**Guard — unauthenticated request to `/set-password`:**

1. Call `resolveForcePasswordChangeSession` with no session.
2. Assert `redirect('/login')` is called.

**Transaction atomicity:**

1. Simulate `clearForcePasswordChange` throwing mid-transaction.
2. Assert `account.password` is unchanged from original, `force_password_change` remains `TRUE`, no `AUDIT_LOG` rows written.

---

## Dependencies

No new npm packages are expected. Verify the following before implementation:

- `react-hook-form` and `@hookform/resolvers` — already installed in um08; confirm available.
- `better-auth` — already installed; the password hashing path (`hashTempPassword` in `lib/temp-password.ts`) established in um08 is reused unchanged.

**shadcn/ui components** — run the CLI only if not already added by prior units:

- `npx shadcn@latest add alert` — used for the server-error banner in `SetPasswordForm`. If an alert component already exists from prior units, skip.

The `Input`, `Button`, `Label` components are assumed available from um03/um06/um07. Lucide icons `Eye`, `EyeOff`, `Loader2` are available via `lucide-react` (already a dependency of shadcn projects).

---

## Verification Checklist

### Guard — authenticated routes

- [ ] A session with `force_password_change = TRUE` calling `resolveAuthenticatedUser` issues `redirect('/set-password')`
- [ ] A session with `force_password_change = FALSE` calling `resolveAuthenticatedUser` does NOT redirect and returns the user
- [ ] `app/(admin)/layout.tsx` gets the redirect for free after the helper change (no direct edit to the layout required)
- [ ] Root redirect page (`app/page.tsx`) gets the redirect for free
- [ ] `/no-access` page gets the redirect for free
- [ ] Better-Auth Route Handlers at `/api/auth/**` are never affected (they do not call `resolveAuthenticatedUser`)
- [ ] Sign-out can be initiated from `/set-password` (the "Sign out" link is present and functional)

### `/set-password` page access control

- [ ] Visiting `/set-password` with no session redirects to `/login`
- [ ] Visiting `/set-password` with a session where `force_password_change = FALSE` redirects to `/`
- [ ] Visiting `/set-password` with a session where `force_password_change = TRUE` renders the form
- [ ] A DISABLED or DELETED user session redirects to `/login`
- [ ] The context paragraph "You're signing in for the first time…" is rendered only when `status = PENDING`
- [ ] The context paragraph is absent for an ACTIVE user with a reset temp password

### Form validation

- [ ] Submitting with `newPassword` fewer than 12 characters shows an error on that field; `setPasswordAction` is not called
- [ ] Submitting with `newPassword` more than 128 characters shows an error; `setPasswordAction` is not called
- [ ] Submitting with `confirmPassword` not matching `newPassword` shows "Passwords do not match." on the confirm field
- [ ] Submitting with valid matching passwords ≥ 12 chars calls `setPasswordAction`
- [ ] The same `setPasswordSchema` is used by both the action (server-side) and the form (client-side via `zodResolver`)
- [ ] Helper text "At least 12 characters." is visible below the New Password field at all times (not only on error)

### Password fields UX

- [ ] Both password fields render as `type="password"` by default
- [ ] Clicking the New Password show/hide toggle changes only that field's visibility
- [ ] Clicking the Confirm Password show/hide toggle changes only that field's visibility
- [ ] Both toggles have accessible `aria-label` values ("Show password" / "Hide password")
- [ ] Submit button shows a loading spinner and is disabled while the action is in flight
- [ ] Submit button is re-enabled if the action returns an error

### Action — authorization

- [ ] `setPasswordAction` is decorated `'use server'`
- [ ] Calling the action with no session results in `redirect('/login')` propagating (not swallowed)
- [ ] Calling the action when `force_password_change = FALSE` returns `{ ok:false, code:'FORBIDDEN' }`
- [ ] `resolveForcePasswordChangeSession` is called before any input parsing in the action

### Action — validation errors

- [ ] Short password returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ newPassword:[...] } }`
- [ ] Mismatched confirm returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ confirmPassword:[...] } }`
- [ ] `setPasswordAction` receiving server validation errors sets them on the correct form fields
- [ ] A server error (`SERVER_ERROR`) shows the alert banner in the form; the form is not cleared

### Database state after success

- [ ] `account.password` is updated with a new scrypt hash for the user
- [ ] The new hash verifies against the submitted new password (not the old temp password)
- [ ] The new hash is not equal to the old temp password hash
- [ ] `appuser.force_password_change = FALSE` after success
- [ ] `appuser.status = 'ACTIVE'` after success from a PENDING user
- [ ] `appuser.status` remains `ACTIVE` after success from an already-ACTIVE user (admin reset)
- [ ] `appuser.last_modified_datetime` is updated

### Audit — `USER_PASSWORD_CHANGED`

- [ ] `AUDIT_LOG` contains a `USER_PASSWORD_CHANGED` row after any successful set-password
- [ ] `actor_user_id = userId` (the user acting on their own credential)
- [ ] `target_entity = 'APPUSER'`, `target_id = userId`
- [ ] `before_data = NULL`
- [ ] `after_data = { forcePasswordChange: false }` (no password material)
- [ ] No column in the `AUDIT_LOG` row contains the plaintext or hashed new password
- [ ] App DB role can INSERT but not UPDATE or DELETE on `AUDIT_LOG` (invariant from um03)

### Audit — `USER_FIRST_LOGIN`

- [ ] `AUDIT_LOG` contains a `USER_FIRST_LOGIN` row when the user was PENDING at action execution time
- [ ] `AUDIT_LOG` does NOT contain `USER_FIRST_LOGIN` when the user was already ACTIVE
- [ ] `before_data = { status: 'PENDING' }`, `after_data = { status: 'ACTIVE' }` for `USER_FIRST_LOGIN`
- [ ] `USER_FIRST_LOGIN` is written inside the same transaction as `USER_PASSWORD_CHANGED` (both rows appear or neither does)

### Transaction atomicity

- [ ] If `updateAccountPassword` fails, neither `force_password_change` nor `status` changes, and no audit rows are written
- [ ] If `clearForcePasswordChange` fails, `account.password` reverts (transaction rolls back), no audit rows written
- [ ] If `writeAuditEvent` fails (either call), the entire transaction rolls back — password hash and status are unchanged

### Post-success redirect

- [ ] After successful submission, the browser navigates to `/`
- [ ] The root redirect page (`app/page.tsx`) routes the now-ACTIVE user to their first accessible page (ADMIN → `/administration/users`)
- [ ] The user is no longer redirected to `/set-password` after activation (`force_password_change = FALSE`)

### Credential exclusivity and security

- [ ] Only LOCAL users (`auth_method = 'LOCAL'`) can have `force_password_change = TRUE`; this is enforced by um08 (SSO users never get the flag) — add an assertion test confirming the action returns `FORBIDDEN` if somehow called for an SSO user with no `credential` account row
- [ ] The old temp password is no longer accepted after a successful set-password (test: attempt to sign in with temp password post-activation and confirm rejection by Better-Auth)
- [ ] The plaintext `newPassword` is never present in any log, console output, or server response field other than the transient action call

### Boundary and TypeScript

- [ ] `validation/password.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/users/users-auth.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/auth/set-password.action.ts` has `'use server'` and no direct DB access
- [ ] `app/(auth)/set-password/page.tsx` has `export const dynamic = 'force-dynamic'`
- [ ] `components/auth/set-password-form.tsx` has `'use client'` and no direct DB or service imports
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] Service unit tests pass (6 scenarios per §9.10)
- [ ] Action unit tests pass (7 scenarios per §9.10)
- [ ] `SetPasswordForm` unit tests pass (6 scenarios per §9.10)
- [ ] `resolveForcePasswordChangeSession` unit tests pass (6 scenarios per §9.10)
- [ ] `resolveAuthenticatedUser` guard extension tests pass (3 scenarios per §9.10)
- [ ] Integration tests pass: PENDING happy path (DB assertions, both audit events), ACTIVE reset path (no `USER_FIRST_LOGIN`), guard scenarios, atomicity rollback
- [ ] Old temp password rejected post-activation (integration)

### Scope guard

- [ ] No admin-facing UI was added (this unit owns only the auth-facing `/set-password` route and the session guard)
- [ ] No changes to `app/(admin)/**` page or component files — only the shared session helper in `auth/` is modified
- [ ] No new `PERMISSIONS` registry rows (no permission check is needed for `/set-password` — it is session-gated by `force_password_change`, not RBAC)
- [ ] The password-reset flow triggered by an admin (setting `force_password_change = TRUE` on an ACTIVE user) is NOT implemented here — that action belongs to the user-edit unit; this unit only handles the user-facing completion of the flow
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
