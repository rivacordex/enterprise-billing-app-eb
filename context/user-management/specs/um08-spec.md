# Spec: um08 — Create user (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um07 (users list/detail page, `UserTable`, `UserDetail`, badge components, `types/users.ts`, `usersReadService`, `appUserRepository` read functions, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`); Unit um03 (audit-write helper, `writeAuditEvent`); Unit um05 (RBAC schema — `ROLES`, `ROLE_ASSIGN`; roles read repository; `RoleBadge`).
- **Source sections:** overview §"User administration" (create PENDING, LOCAL temp password), §"Core User Flow" item 2, §"Audit Events" (`USER_CREATED`), §"Pages — Administration" item 1; architecture §2 (folder ownership, boundary rules), §5 (account lifecycle, auth-method exclusivity), §6 (per-page permission matrix: `users:EDIT`); code-standards §3 (Server Actions as public endpoints, parse-then-call, `revalidatePath`), §7 (file organization), §8 (permission naming). Invariants: **#1** (no plaintext credentials — temp password returned once, never stored or logged), **#3** (server-side authz), **#11** (USER_CREATED audit), **#14** (DB only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#19** (Better-Auth field mapping — password stored only as scrypt hash in `account`).

---

## Goal

Enable an admin to create a new `APPUSER` (status `PENDING`) from the Users page by filling a dialog form with name, email, phone, `auth_method`, and initial roles; the Server Action validates input, creates the user and their initial role assignments in a single transaction, writes `USER_CREATED` to `AUDIT_LOG`, and — for `LOCAL` users only — generates a cryptographically random one-time temporary password (hashed to `account.password`, `force_password_change = TRUE`), returning the plaintext to the UI where it is displayed once in a post-submit success state and never again.

---

## Design

### Dialog layout

The create-user flow lives in a shadcn `Dialog` (modal overlay), not an inline panel or drawer. Rationale: creation is a focused, bounded action that shouldn't disrupt the master-detail layout already used for list + detail. The `Dialog` is triggered by the "Add User" button in `UserTable` (currently a disabled stub from um07; this unit enables it).

The `Dialog` has two visual states managed by a single component:

**State 1 — Form.** Renders `UserForm` with all input fields. The dialog title is "Add User". A "Cancel" button (ghost style) dismisses the dialog. A "Create User" submit button (primary style) submits the form. The submit button shows a loading spinner and is disabled while the Server Action is in flight.

**State 2 — Success (LOCAL only).** After successful creation of a LOCAL user, the form is replaced by a success panel:

- A `CheckCircle` icon (success-700 color) and heading "User created".
- A sentence: "Share this temporary password with the user out of band. It will not be shown again."
- The password rendered in a monospace code block (`--font-mono`, `--surface-sunken` background, `--radius-md`, full-width) with a copy-to-clipboard button (lucide `Copy` icon, ghost style) to its right. The copy button shows a `Check` icon for 2 seconds after a successful copy.
- A "Done" button (primary style). Clicking it closes the dialog and navigates to `?userId=<newUserId>` so the new user is auto-selected in the detail panel.

For **SSO users**, there is no State 2 — after successful creation the dialog closes immediately, the list re-renders with the new user, and a toast notification ("User created") confirms the action. The new user is auto-selected (`?userId=<newUserId>`).

### UserForm fields

Rendered in a single-column layout, standard vertical field spacing.

| Field            | Type                       | Required | Validation                                                   |
| ---------------- | -------------------------- | -------- | ------------------------------------------------------------ |
| Email - Username | Email input                | Yes      | Valid email, max 255 chars, trimmed, lowercased              |
| Full Name        | Text input                 | Yes      | 1–255 chars, trimmed                                         |
| Phone            | Text input                 | No       | Max 50 chars, trimmed; omitted → `null`                      |
| Auth Method      | Radio group                | Yes      | `SSO` or `LOCAL`; default `LOCAL`                            |
| Initial Roles    | Multi-select checkbox list | No       | Zero or more valid `roleId` UUIDs from the loaded roles list |

The **Auth Method** field uses a drop down list (single select item only): each line shows the method and very short one-line description:

- SSO: "No password - via Entra ID"
- LOCAL: "Email and password. Temp password"

The **Initial Roles** field renders a list of available roles fetched server-side before the dialog opens. Each role is a labeled checkbox showing a `RoleBadge` and the role name. If no roles exist (edge case), an inline message "No roles available" is shown.

Field-level validation errors are shown below each input using the standard error text style (`--text-danger`, `--text-body-sm`). The form uses `react-hook-form` + `@hookform/resolvers/zod` with the same Zod schema used server-side (imported from `validation/users.ts`).

### Email uniqueness conflict

If the Server Action returns an `EMAIL_CONFLICT` error (email is already in use by a non-DELETED user), the dialog stays open and the Email field shows an inline error: "A user with this email already exists." This does not constitute a validation error (it cannot be caught client-side by Zod) and is returned as a structured action result, not a thrown error.

### Post-creation list refresh

The Server Action calls `revalidatePath('/administration/users')`. After the action resolves, the page re-fetches the user list server-side. The dialog closes (or transitions to State 2) and the new user appears in the refreshed list.

### "Add User" button

The stub button in `UserTable` (from um07, always disabled) is replaced:

- The button is enabled and clickable when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is true (always true for ADMIN in v1).
- Clicking opens the `CreateUserDialog`.
- The `permissionMap` prop already passes through `UserTable` — no prop changes needed.
- Remove the `disabled` attribute and the "Feature coming soon." `title` tooltip.

---

## Implementation

### 8.1 — Zod validation schema (`validation/users.ts`)

New file (or extend if it exists). No imports from `next/*`, `db/**`, `services/**`, `auth/**`, or UI modules. Only `zod`.

**`createUserSchema`**:

```ts
export const createUserSchema = z.object({
  userName: z.string().min(1, "Name is required").max(255).trim(),
  userEmail: z.string().email("Invalid email").max(255).trim().toLowerCase(),
  userPhonenum: z
    .string()
    .max(50)
    .trim()
    .nullish()
    .transform((v) => v || null),
  authMethod: z.enum(["SSO", "LOCAL"]),
  roleIds: z.array(z.string().uuid()).default([]),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
```

Export both the schema and the inferred type. The schema is the single source of truth — imported by both the Server Action (server-side parse) and `UserForm` (via `@hookform/resolvers/zod`).

### 8.2 — Temp password generator (`lib/temp-password.ts`)

New file. Server-only (no `'use client'`). No exports other than `generateTempPassword` and `hashTempPassword`.

**`generateTempPassword(): string`**

Uses `crypto.randomBytes(18).toString('base64url')` — yields a 24-character URL-safe string (~144 bits of entropy). No external dependency. Never logs the result.

**`hashTempPassword(plaintext: string): Promise<string>`**

Hashes using Better-Auth's exported password utility (`import { hashPassword } from 'better-auth/crypto'` or the equivalent internal scrypt helper Better-Auth exposes). This ensures the hash format is identical to what Better-Auth produces for normal credential sign-ins, so the sign-in flow accepts the temp password unchanged.

If Better-Auth does not expose a public hashing function, use the `@node-rs/bcrypt` or `scrypt` package already installed by Better-Auth, replicating the same parameters. Document the hash format choice in a comment.

Neither function is importable by client components — add `'server-only'` at the top of the file.

### 8.3 — Repository: write functions (`db/repositories/app-user.repository.ts`)

Add to the existing repository file. All functions use the Drizzle `db` client and run within a caller-supplied transaction where noted. No business logic. No audit writes.

#### 8.3.1 — `insertAppUser(tx, data): Promise<{ userId: string }>`

Inserts one row into `core.appuser`. Accepts a transaction handle `tx`. Fields:

```ts
{
  userId:               crypto.randomUUID(),   // generated here
  userName:             data.userName,
  userEmail:            data.userEmail,
  userPhonenum:         data.userPhonenum ?? null,
  emailVerified:        true,                  // no email verification flow in v1
  authMethod:           data.authMethod,
  status:               'PENDING',
  forcePasswordChange:  data.authMethod === 'LOCAL',
  failedLoginCount:     0,
  lockedUntil:          null,
  lastLoginDatetime:    null,
  createdDatetime:      new Date(),
  lastModifiedDatetime: new Date(),
}
```

Returns `{ userId }`. The generated UUID is produced by `crypto.randomUUID()` at the repository level (not in the service), consistent with how the seeded admin is created.

#### 8.3.2 — `insertCredentialAccount(tx, userId, passwordHash): Promise<void>`

Inserts one row into `core.account` with:

```ts
{
  accountId:          crypto.randomUUID(),
  userId:             userId,
  providerId:         'credential',
  providerAccountId:  userId,   // Better-Auth convention for local: use user_id
  password:           passwordHash,
  // OAuth token columns: null (not used for credential provider)
  createdAt:          new Date(),
  updatedAt:          new Date(),
}
```

Called only for LOCAL users. For SSO users, no `account` row is created at this point — Better-Auth creates it on first Entra login.

#### 8.3.3 — `insertRoleAssignments(tx, userId, roleIds, assignedByUserId): Promise<void>`

Bulk-inserts rows into `core.role_assign` for each `roleId` in `roleIds`. If `roleIds` is empty, does nothing (no insert). Uses Drizzle's batch insert. Each row:

```ts
{
  roleAssignId:    crypto.randomUUID(),
  refUserId:       userId,
  refRoleId:       roleId,
  assignedBy:      assignedByUserId,
  createdDatetime: new Date(),
}
```

#### 8.3.4 — `findUserByEmail(email: string): Promise<{ userId: string; status: string } | null>`

SELECT from `core.appuser` WHERE `user_email = $email` AND `status != 'DELETED'` (partial unique index excludes DELETED, but the service still checks explicitly). Returns `{ userId, status }` or `null`. Used for the email-uniqueness guard in the service.

No `tx` parameter — this is a read used before the transaction opens.

### 8.4 — Service: users write (`services/users/users-write.service.ts`)

New file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`. Imports from `db/repositories/`, `lib/`, and `types/`.

#### `createUser(input: CreateUserInput, actorId: string): Promise<CreateUserResult>`

```ts
type CreateUserResult =
  | { ok: true; userId: string; tempPassword: string | null }
  | { ok: false; code: "EMAIL_CONFLICT" };
```

Steps:

1. **Email uniqueness check.** Call `appUserRepository.findUserByEmail(input.userEmail)`. If a non-null result is returned → return `{ ok: false, code: 'EMAIL_CONFLICT' }`. Do not open a transaction.

2. **Generate credentials (LOCAL only).** If `input.authMethod === 'LOCAL'`, call `generateTempPassword()` → `plaintext`. Call `hashTempPassword(plaintext)` → `passwordHash`. For SSO, both are `null`.

3. **Transaction.** Open a Drizzle transaction and run the following as a unit:

   a. `insertAppUser(tx, input)` → `{ userId }`.

   b. If LOCAL: `insertCredentialAccount(tx, userId, passwordHash)`.

   c. If `input.roleIds.length > 0`: `insertRoleAssignments(tx, userId, input.roleIds, actorId)`.

   d. `writeAuditEvent(tx, { ... })` — see §8.4.1.

4. **Return.** `{ ok: true, userId, tempPassword: plaintext ?? null }`.

The plaintext password (if generated) is held only in memory within this function call and returned to the action, which returns it to the client. It is never assigned to a variable outside this scope, never logged, and never written to the DB.

On any transaction error, let the exception propagate — the transaction rolls back, nothing is persisted. The action catches and maps it to a generic server error.

#### 8.4.1 — Audit event for USER_CREATED

Call `writeAuditEvent` (from um03) inside the transaction, after the inserts succeed:

```ts
{
  eventType:    'USER_CREATED',
  actorUserId:  actorId,
  targetEntity: 'APPUSER',
  targetId:     userId,
  beforeData:   null,
  afterData:    {
    userName:    input.userName,
    userEmail:   input.userEmail,
    authMethod:  input.authMethod,
    status:      'PENDING',
    roles:       input.roleIds,   // array of roleId strings
  },
}
```

`before_data` is `null` (creation has no prior state). `after_data` captures the essential new-user snapshot. Role names are not resolved here — `roleIds` is sufficient for the audit trail.

### 8.5 — Server Action (`actions/users/create-user.action.ts`)

New file. `'use server'`. Imports `createUserSchema` from `validation/users.ts`, `requirePermission` from `auth/`, `createUserService` from `services/users/users-write.service.ts`, `revalidatePath` from `next/cache`.

```ts
export async function createUserAction(
  rawInput: unknown,
): Promise<CreateUserActionResult> { ... }

type CreateUserActionResult =
  | { ok: true;  userId: string; tempPassword: string | null }
  | { ok: false; code: 'VALIDATION_ERROR'; fieldErrors: Record<string, string[]> }
  | { ok: false; code: 'EMAIL_CONFLICT' }
  | { ok: false; code: 'FORBIDDEN' }
  | { ok: false; code: 'SERVER_ERROR' }
```

Steps:

1. `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — if unauthenticated or unauthorized, the guard throws/redirects, which this action catches and maps to `{ ok: false, code: 'FORBIDDEN' }`. (The guard may redirect; in a Server Action context, wrap in try/catch so the redirect does not leak as an unhandled error — catch the `NEXT_REDIRECT` error and re-throw it to allow Next.js to process the redirect normally.)

2. Parse: `const parsed = createUserSchema.safeParse(rawInput)`. If `!parsed.success`, return `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Call `createUserService.createUser(parsed.data, actorId)`.

4. If `!result.ok`, return the service result mapped to the action result type.

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true, userId: result.userId, tempPassword: result.tempPassword }`.

The action never logs the `tempPassword` value. The `tempPassword` field in the return value is the only time the plaintext exists outside the service scope.

### 8.6 — Roles read for dialog (`services/roles/roles-read.service.ts`)

Add (or extend if it exists from um05) a function:

**`listRoles(): Promise<Array<{ roleId: string; roleName: string; roleDescr: string | null }>>`**

Calls the roles repository (`findAllRoles()`, added in um05 or added now if not present). Returns all roles ordered by `role_name ASC`. Used to populate the Initial Roles checkbox list in the dialog. No audit. Read-only.

If `db/repositories/roles.repository.ts` already has a `findAllRoles()` from um05, use it. If not, add it now: `SELECT role_id, role_name, role_descr FROM core.roles ORDER BY role_name ASC`.

### 8.7 — `CreateUserDialog` component (`components/users/create-user-dialog.tsx`)

Client Component (`'use client'`). Manages dialog open state and the two visual states (form vs. success).

**Props:**

```ts
interface CreateUserDialogProps {
  roles: Array<{ roleId: string; roleName: string; roleDescr: string | null }>;
  trigger: React.ReactNode; // the "Add User" button rendered by UserTable
}
```

**State:**

```ts
const [open, setOpen] = useState(false);
const [dialogState, setDialogState] = useState<"form" | "success">("form");
const [successData, setSuccessData] = useState<{
  userId: string;
  tempPassword: string | null;
} | null>(null);
```

**Dialog open/close behavior:**

- Opening: `setOpen(true)` + reset form + `setDialogState('form')`.
- Closing from the form (Cancel button or dialog backdrop): `setOpen(false)` + reset form state.
- Closing from success state (Done button): `setOpen(false)` + `router.push('/administration/users?userId=' + successData.userId)` + reset.
- The dialog `onOpenChange` handler: if the new value is `false` and `dialogState === 'success'`, navigate to the new user before closing.

**On form submit:**

```ts
const handleSubmit = async (values: CreateUserInput) => {
  const result = await createUserAction(values);

  if (result.ok) {
    if (result.tempPassword) {
      setSuccessData({
        userId: result.userId,
        tempPassword: result.tempPassword,
      });
      setDialogState("success");
    } else {
      // SSO: close immediately and navigate
      setOpen(false);
      router.push("/administration/users?userId=" + result.userId);
      toast.success("User created");
    }
  } else if (result.code === "EMAIL_CONFLICT") {
    form.setError("userEmail", {
      message: "A user with this email already exists.",
    });
  } else {
    toast.error("Something went wrong. Please try again.");
  }
};
```

Uses `useRouter` from `next/navigation` and a toast utility (shadcn `Sonner` or equivalent already installed).

### 8.8 — `UserForm` component (`components/users/user-form.tsx`)

Client Component (`'use client'`). Pure form — no Server Action call, no routing. Receives `onSubmit` and `roles` as props.

**Props:**

```ts
interface UserFormProps {
  roles: Array<{ roleId: string; roleName: string; roleDescr: string | null }>;
  onSubmit: (values: CreateUserInput) => Promise<void>;
  isSubmitting: boolean;
}
```

Uses `react-hook-form` with `useForm<CreateUserInput>` + `zodResolver(createUserSchema)`. Default values: `authMethod: 'LOCAL'`, `roleIds: []`.

**Field implementation:**

- **Full Name**: shadcn `Input`, `type="text"`, `autoComplete="off"`. Error message below.
- **Email**: shadcn `Input`, `type="email"`, `autoComplete="off"`. Error message below.
- **Phone**: shadcn `Input`, `type="tel"`, `autoComplete="off"`. No error shown unless >50 chars (rare; validation message: "Phone number is too long.").
- **Auth Method**: two radio cards in a horizontal `flex` row (stack vertically on narrow viewport). Use shadcn `RadioGroup` + `RadioGroupItem`. Each card: full-width padded box, `--surface-card` background, `--radius-md`, `--border-subtle` border; selected: `--color-primary-500` border (2px solid), `--surface-selected` background. The `AuthMethodBadge` is rendered inside the card. The description text uses `--text-body-sm` and `--text-muted`.
- **Initial Roles**: a `<fieldset>` with `<legend>` "Initial Roles (optional)". Each role is a `<label>` containing a shadcn `Checkbox` (controlled via `react-hook-form` `Controller`) + `RoleBadge` + role description in `--text-muted`. If `roles` is empty, show `<p className="text-muted-foreground text-sm">No roles available.</p>`. Use `Controller` with `field.onChange(checked ? [...field.value, roleId] : field.value.filter(id => id !== roleId))`.

**Buttons:** rendered outside `UserForm` in `CreateUserDialog` via the dialog footer — not inside the form component itself. `UserForm` exposes the `handleSubmit` via a `ref` or by accepting an `id` prop so the dialog's submit button can be wired via `form="user-form-id"`. Use the `id` approach: `<form id="create-user-form" onSubmit={...}>`.

### 8.9 — Temp password success panel (`components/users/temp-password-display.tsx`)

Client Component (`'use client'`). Renders only the success/password state — extracted for testability.

**Props:**

```ts
interface TempPasswordDisplayProps {
  tempPassword: string;
  onDone: () => void;
}
```

**Layout:**

```
[CheckCircle icon, success-700 color, size 32]
[<h3> "User created"]
[<p> "Share this temporary password with the user out of band. It will not be shown again."]
[
  <code className="font-mono ...">{tempPassword}</code>
  [Copy button]
]
[Done button → calls onDone()]
```

**Copy behavior:**

```ts
const [copied, setCopied] = useState(false);
const handleCopy = () => {
  navigator.clipboard.writeText(tempPassword);
  setCopied(true);
  setTimeout(() => setCopied(false), 2000);
};
```

Copy button icon: `Copy` when `!copied`, `Check` (success-700) when `copied`. `aria-label` toggles between "Copy password" and "Copied".

The `<code>` block: `--surface-sunken` background, `--radius-md`, `px-3 py-2`, `--font-mono`, `text-sm`, `select-all` cursor, `word-break: break-all` (prevents overflow on long tokens). The entire code+copy row: `flex items-center gap-2 w-full`.

The warning paragraph: `--text-body-sm`, `--color-warning-700` text (or `--text-muted` if no warning token is available), `font-medium`. Accompanies it with a `AlertTriangle` lucide icon (inline, `size={14}`).

### 8.10 — `UsersPage` update (`app/(admin)/administration/users/page.tsx`)

The page is a Server Component. Two changes:

1. Fetch roles for the dialog alongside the users list:

   ```ts
   const [users, selectedUser, roles] = await Promise.all([
     usersReadService.listUsers(),
     selectedUserId
       ? usersReadService.getUserById(selectedUserId)
       : Promise.resolve(null),
     rolesReadService.listRoles(),
   ]);
   ```

2. Pass `roles` down to `UserTable`:
   ```tsx
   <UserTable
     users={users}
     selectedUserId={selectedUserId}
     permissionMap={permissionMap}
     roles={roles}           {/* NEW */}
   />
   ```

No other changes to the page.

### 8.11 — `UserTable` update (`components/users/user-table.tsx`)

Three changes:

1. Add `roles: Array<{ roleId: string; roleName: string; roleDescr: string | null }>` to `UserTableProps`.

2. Replace the disabled "Add User" stub with the dialog trigger:

   ```tsx
   {
     hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT) && (
       <CreateUserDialog roles={roles} trigger={<Button>Add User</Button>} />
     );
   }
   ```

3. Remove the `title="Feature coming soon."` tooltip and the `disabled` attribute from what was the stub button (now it is the `trigger` prop passed to `CreateUserDialog`).

No other changes to `UserTable`.

### 8.12 — Tests

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Mock `appUserRepository`, `generateTempPassword`, `hashTempPassword`, and `writeAuditEvent`. Test the service in isolation.

| Scenario                               | Setup                                             | Expected                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Creates LOCAL user successfully        | `findUserByEmail` → null; `authMethod: 'LOCAL'`   | `insertAppUser` called with `status:'PENDING'`, `forcePasswordChange:true`; `insertCredentialAccount` called with the hash; `writeAuditEvent` called with `USER_CREATED`; returns `{ ok:true, tempPassword: <plaintext> }` |
| Creates SSO user successfully          | `findUserByEmail` → null; `authMethod: 'SSO'`     | `insertAppUser` called; `insertCredentialAccount` NOT called; returns `{ ok:true, tempPassword: null }`                                                                                                                    |
| Assigns initial roles                  | `roleIds: ['uuid-1','uuid-2']`; SSO               | `insertRoleAssignments` called with both IDs and the `actorId`                                                                                                                                                             |
| No role assignments when roleIds empty | `roleIds: []`                                     | `insertRoleAssignments` NOT called                                                                                                                                                                                         |
| Email conflict                         | `findUserByEmail` → `{ userId, status:'ACTIVE' }` | Returns `{ ok:false, code:'EMAIL_CONFLICT' }`; no transaction opened                                                                                                                                                       |
| DELETED email is reusable              | `findUserByEmail` → null (query excludes DELETED) | `insertAppUser` proceeds normally                                                                                                                                                                                          |
| Transaction rollback on insert error   | `insertAppUser` throws                            | Exception propagates; `writeAuditEvent` not called                                                                                                                                                                         |

#### Unit tests: temp password (`tests/unit/lib/temp-password.test.ts`)

- `generateTempPassword()` returns a string of length 24.
- `generateTempPassword()` called twice produces two different strings (probabilistic; acceptable for a unit test).
- `generateTempPassword()` returns only URL-safe characters matching `/^[A-Za-z0-9_-]+$/`.
- `hashTempPassword(plaintext)` returns a string that does not contain the plaintext (hash is not reversible).

#### Unit tests: action (`tests/unit/actions/create-user.action.test.ts`)

Mock `requirePermission`, `createUserService.createUser`, `revalidatePath`.

| Scenario           | Setup                                                         | Expected                                                                                                     |
| ------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Valid LOCAL input  | `createUser` → `{ ok:true, userId:'u1', tempPassword:'abc' }` | Returns `{ ok:true, userId:'u1', tempPassword:'abc' }`; `revalidatePath` called with `/administration/users` |
| Valid SSO input    | `createUser` → `{ ok:true, userId:'u2', tempPassword:null }`  | Returns `{ ok:true, ..., tempPassword:null }`                                                                |
| Validation failure | Raw input missing `userName`                                  | Returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ userName:['...'] } }`; `createUser` not called   |
| Email conflict     | `createUser` → `{ ok:false, code:'EMAIL_CONFLICT' }`          | Returns `{ ok:false, code:'EMAIL_CONFLICT' }`                                                                |
| Unauthorized       | `requirePermission` throws                                    | Returns `{ ok:false, code:'FORBIDDEN' }`                                                                     |
| Server error       | `createUser` throws                                           | Returns `{ ok:false, code:'SERVER_ERROR' }`                                                                  |

Assert `tempPassword` is never logged (spy on `console.log`/`console.error` in the action test; assert no call contains the temp password string).

#### Unit tests: `TempPasswordDisplay` (`tests/unit/components/temp-password-display.test.tsx`)

Use `@testing-library/react` + `vitest`. Mock `navigator.clipboard.writeText`.

- Renders the temp password string inside a `<code>` element.
- Clicking "Copy password" calls `navigator.clipboard.writeText` with the temp password.
- After clicking copy, the button label/aria-label changes to "Copied".
- After 2 seconds (fake timers), the label reverts to "Copy password".
- Clicking "Done" calls the `onDone` callback.
- The warning phrase "will not be shown again" is present in the rendered output.

#### Integration tests: action guard (`tests/integration/actions/create-user.action.test.ts`)

Extends the route × level matrix. Use the test DB with admin_user and no_grants_user.

| Session        | Input                   | Expected                                                                          |
| -------------- | ----------------------- | --------------------------------------------------------------------------------- |
| admin_user     | Valid `CreateUserInput` | Returns `ok:true`; APPUSER row exists in DB; `AUDIT_LOG` has `USER_CREATED` entry |
| no_grants_user | Valid `CreateUserInput` | Returns `{ ok:false, code:'FORBIDDEN' }`                                          |
| (no session)   | Valid `CreateUserInput` | Returns `{ ok:false, code:'FORBIDDEN' }`                                          |

For the `admin_user` happy-path test, assert:

- The `APPUSER` row has `status = 'PENDING'` and `force_password_change = TRUE` (LOCAL).
- The `account` row exists with `provider_id = 'credential'` and a non-empty `password` hash (LOCAL).
- The hash does not equal the plaintext password.
- The `AUDIT_LOG` row has `event_type = 'USER_CREATED'`, `actor_user_id = admin_user.userId`, `before_data = null`, `after_data` JSON containing `userEmail`.

For SSO: assert no `account` row is created.

#### Integration tests: email uniqueness (`tests/integration/services/users-write.service.test.ts`)

- Insert a test ACTIVE user with email `test@example.com`. Call `createUser` with the same email. Assert `{ ok:false, code:'EMAIL_CONFLICT' }` and no new APPUSER row.
- Insert a test DELETED user with email `deleted@example.com`. Call `createUser` with the same email. Assert `{ ok:true }` — DELETED emails are reusable.

---

## Dependencies

No new npm packages are expected beyond what prior units installed. Verify the following are available before implementation; install if missing:

- `react-hook-form` — form state management in `UserForm`. (`npm install react-hook-form`)
- `@hookform/resolvers` — Zod adapter. (`npm install @hookform/resolvers`)
- `better-auth` (already installed) — confirm the scrypt/password hashing export path. If the public API does not expose a hash function, install `@node-rs/bcrypt` matching Better-Auth's pinned version, or use Node.js built-in `crypto.scrypt` with parameters matching Better-Auth's defaults.

**shadcn/ui components** — run the CLI if not already added:

- `npx shadcn@latest add dialog` — modal container for the create-user flow.
- `npx shadcn@latest add checkbox` — role selection in `UserForm`.
- `npx shadcn@latest add radio-group` — auth method selector in `UserForm`.
- `npx shadcn@latest add sonner` — toast notifications (SSO success, error fallback). If a toast system was installed in a prior unit, skip.

All shadcn components are added to `components/ui/` (managed vendor layer, per code-standards §4.1) and must not be hand-edited beyond token wiring.

---

## Verification Checklist

### Action and authorization

- [ ] `createUserAction` is decorated `'use server'`
- [ ] `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` is called before any other logic in the action
- [ ] Calling the action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with an ADMIN session and valid input returns `{ ok: true }`
- [ ] `revalidatePath('/administration/users')` is called on success
- [ ] `PERMISSIONS.USERS` constant is used (not the raw string `'users'`)

### Validation

- [ ] Missing `userName` returns `VALIDATION_ERROR` with `fieldErrors.userName`
- [ ] Invalid email format returns `VALIDATION_ERROR` with `fieldErrors.userEmail`
- [ ] `authMethod` value other than `'SSO'` or `'LOCAL'` returns `VALIDATION_ERROR`
- [ ] `roleIds` containing a non-UUID string returns `VALIDATION_ERROR`
- [ ] Empty `roleIds` array is accepted (defaults to `[]`)
- [ ] `userPhonenum` absent or null is accepted
- [ ] `createUserSchema` is the same schema used by both the action (server parse) and `UserForm` (client validation)

### LOCAL user creation

- [ ] `APPUSER` row is inserted with `status = 'PENDING'` and `force_password_change = TRUE`
- [ ] `account` row is inserted with `provider_id = 'credential'` and a non-empty `password` (hash)
- [ ] `password` column does not contain the plaintext temp password
- [ ] `tempPassword` returned by the action is a 24-character URL-safe string
- [ ] `tempPassword` is never written to `AUDIT_LOG` (`after_data` does not contain it)
- [ ] `tempPassword` is never logged via `console.*` or the telemetry logger
- [ ] After forced password change in a later session, the old temp password is no longer accepted (this is a cross-unit concern — note it, do not test here)

### SSO user creation

- [ ] `APPUSER` row is inserted with `status = 'PENDING'` and `force_password_change = FALSE`
- [ ] No `account` row is created for SSO users
- [ ] `tempPassword` in the action result is `null`

### Role assignments

- [ ] If `roleIds` is non-empty, `role_assign` rows are inserted for each ID with `assigned_by = actorId`
- [ ] If `roleIds` is empty, no `role_assign` rows are inserted
- [ ] Role assignments are part of the same transaction as the APPUSER insert (a failed insert rolls back both)

### Audit

- [ ] `AUDIT_LOG` row exists after successful creation with `event_type = 'USER_CREATED'`
- [ ] `actor_user_id` equals the creating admin's `user_id`
- [ ] `target_entity = 'APPUSER'`, `target_id = <newUserId>`
- [ ] `before_data` is `null`
- [ ] `after_data` contains `userName`, `userEmail`, `authMethod`, `status: 'PENDING'`, `roles`
- [ ] `after_data` does not contain `tempPassword` or any password hash
- [ ] Audit write is inside the same transaction as user creation (rollback removes the audit row too)
- [ ] App DB role can INSERT into `AUDIT_LOG` but not UPDATE or DELETE (invariant from earlier units)

### Email uniqueness

- [ ] Creating a user with the email of an ACTIVE user returns `{ ok:false, code:'EMAIL_CONFLICT' }`
- [ ] Creating a user with the email of a PENDING user returns `{ ok:false, code:'EMAIL_CONFLICT' }`
- [ ] Creating a user with the email of a DISABLED user returns `{ ok:false, code:'EMAIL_CONFLICT' }`
- [ ] Creating a user with the email of a DELETED user succeeds (DELETED excluded by partial unique index and the service read query)

### Dialog — form state

- [ ] "Add User" button in `UserTable` is no longer disabled; clicking it opens the dialog
- [ ] "Add User" button is hidden when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is false (hypothetical non-ADMIN in future)
- [ ] All five fields render: Full Name, Email, Phone, Auth Method (radio cards), Initial Roles (checkboxes)
- [ ] Auth Method defaults to `LOCAL`
- [ ] Both radio cards show the correct `AuthMethodBadge` and description text
- [ ] Selecting SSO radio card shows the SSO description; LOCAL shows the LOCAL description
- [ ] Role checkboxes render a `RoleBadge` per role
- [ ] If the roles list is empty, "No roles available." is shown
- [ ] Client-side validation fires on submit before the action is called (missing name, invalid email)
- [ ] Field-level error text appears beneath each invalid field
- [ ] "Cancel" button closes the dialog and resets the form
- [ ] Clicking the dialog backdrop (or pressing Escape) closes the dialog and resets the form (when in form state)
- [ ] Submit button shows a loading spinner and is disabled while the action is in-flight

### Dialog — EMAIL_CONFLICT

- [ ] When the action returns `EMAIL_CONFLICT`, the dialog stays open
- [ ] The email field shows the inline error "A user with this email already exists."
- [ ] No toast is shown for an email conflict

### Dialog — success state (LOCAL)

- [ ] After successful LOCAL user creation, the form is replaced by the success panel
- [ ] The temp password is rendered inside a `<code>` element in monospace font
- [ ] The warning text "will not be shown again" is visible
- [ ] "Copy password" button calls `navigator.clipboard.writeText` with the password
- [ ] After clicking copy, the button shows a `Check` icon and "Copied" aria-label for 2 seconds, then reverts
- [ ] "Done" button closes the dialog
- [ ] After clicking "Done", the URL changes to `?userId=<newUserId>` and the new user is selected in `UserDetail`
- [ ] Closing the dialog via backdrop or Escape in the success state also navigates to the new user

### Dialog — success state (SSO)

- [ ] After successful SSO user creation, the dialog closes immediately (no State 2)
- [ ] A success toast "User created" is shown
- [ ] URL changes to `?userId=<newUserId>` and the new user is selected in `UserDetail`

### Post-creation list

- [ ] The new user appears in `UserTable` after the dialog closes (list refreshed via `revalidatePath`)
- [ ] The new user has `StatusBadge` showing `PENDING`
- [ ] A LOCAL new user shows `AuthMethodBadge` LOCAL; SSO shows SSO
- [ ] If initial roles were assigned, `RoleBadge` chips appear for the new user in the table row

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `lib/temp-password.ts` has `'server-only'` at the top; importing it in a client component fails at build time
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/create-user.action.ts` has no DB access — delegates entirely to the service
- [ ] `UserForm` has no direct Server Action call — it receives `onSubmit` as a prop
- [ ] `tsc --noEmit` clean across all new files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] `vitest run` passes all service unit tests (7 scenarios per §8.12)
- [ ] `vitest run` passes all action unit tests (6 scenarios per §8.12)
- [ ] `vitest run` passes temp password unit tests (length, uniqueness, charset, hash ≠ plaintext)
- [ ] `vitest run` passes `TempPasswordDisplay` unit tests (render, copy, done callback, warning text)
- [ ] Integration tests pass: ADMIN creates LOCAL user (DB assertions), ADMIN creates SSO user (no account row), no-grants forbidden, email conflict
- [ ] Integration tests pass: email reuse after DELETED user succeeds; email reuse after non-DELETED user fails

### Scope guard

- [ ] No edit-user, disable-user, delete-user, reset-password, or unlock functionality was added
- [ ] No `PERMISSIONS` migration rows were added (no new permission required; `users:EDIT` is already seeded)
- [ ] `UserDetail` panel contains no action buttons (those arrive in later units)
- [ ] The `(admin)/layout.tsx` sidebar, `force-dynamic`, and `metadata` from prior units are unchanged
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
