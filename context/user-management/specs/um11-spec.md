# Spec: um11 — Edit user details (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um07 (`UserDetail` panel, `UserTable`, `types/users.ts` — `UserDetailView`, `usersReadService`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, badge components); Unit um08 (`UserForm`, `createUserSchema` and pattern in `validation/users.ts`, `users-write.service.ts`, Server Action pattern, `react-hook-form` + `@hookform/resolvers/zod`); Unit um03 (`writeAuditEvent` helper).
- **Source sections:** overview §"User administration" (edit name/phone), §"Pages — Administration" item 1 (detail: edit name/phone), §"Audit Events" (`USER_UPDATED`); architecture §2 (folder ownership, boundary rules), §5 (account lifecycle), §6 (per-page permission matrix: `users:EDIT`); code-standards §3 (Server Actions, parse-then-call, `revalidatePath`), §4 (styling), §7 (file organization), §8 (permission naming). Invariants: **#3** (server-side authz), **#11** (USER_UPDATED audit, atomically with the write), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached).

---

## Goal

Add an inline edit mode to the `UserDetail` panel that allows an admin with `users:EDIT` to update a user's `user_name` and `user_phonenum`; the Server Action validates input, loads the before-snapshot, writes the update and a `USER_UPDATED` audit entry atomically in one transaction, and revalidates the page so the change is immediately reflected in both the detail panel and the user table row.

---

## Design

### Edit mode in `UserDetail`

The `UserDetail` panel gains a single "Edit" button rendered in the panel header, to the left of the close (×) button. It is visible only when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` and a user is selected (i.e. `user !== null`).

Clicking "Edit" switches the panel from **view mode** to **edit mode** without navigation or a dialog. The transition is managed as local component state (`'view' | 'edit'`) because `UserDetail` converts from a Server Component to a Client Component in this unit (see §11.4).

**View mode** (unchanged from um07/um08): all fields in the Identity group display as `<dt>`/`<dd>` read-only pairs.

**Edit mode**: the Identity group is replaced by `UserForm` rendered in edit mode (`mode='edit'`). The panel header title changes from the user's name to "Edit User Details" and the close button is hidden. Two action buttons appear at the bottom of the panel: "Save changes" (primary style, with loading spinner while the action is in-flight) and "Cancel" (ghost style, returns to view mode and discards unsaved changes). The Access and Account state groups remain visible as read-only below the form.

A failed save (validation error or server error) keeps the panel in edit mode and shows the error inline — it does not navigate away or close.

On a successful save the panel returns to view mode, displaying the updated values immediately. Because `revalidatePath` causes a server re-render, the `UserDetail` component will receive updated `user` props on the next render cycle, so no client-side state patching is needed.

### "Edit" button styling

- Ghost style: `border border-[--border-subtle] bg-transparent hover:bg-[--action-ghost-hover] text-[--text-secondary]`
- Lucide `Pencil` icon (size 14) + label "Edit", `text-sm`
- Placed in the panel header row, left of the × close button: `<div className="flex items-center gap-2">Edit button | × button</div>`
- Focus ring: `--focus-ring`

### `UserForm` edit mode

`UserForm` is extended with a discriminated union prop to support both create and edit modes. In edit mode it renders only the **Full Name** and **Phone** fields — email, auth method, and roles are not editable via this form.

The form `id` remains `"user-form-id"` in create mode; in edit mode use `id="edit-user-form"` so the panel's Save button can wire via `form="edit-user-form"` without being inside the `<form>` element.

Default values in edit mode are populated from the current `user.userName` and `user.userPhonenum` (passed as props). `react-hook-form`'s `defaultValues` is set once on mount. If the user props change (e.g. due to a background re-render), `reset(newDefaults)` is called via a `useEffect` to keep the form in sync while in view mode; when the panel is in edit mode, `reset` is deliberately not called on prop changes (the user is mid-edit).

**Validation in edit mode** uses `updateUserDetailsSchema` (same Zod schema used server-side):

- Full Name: `z.string().min(1, 'Name is required').max(255).trim()`
- Phone: `z.string().max(50).trim().nullish().transform(v => v || null)`

No `userId` field in the form — it is passed directly to the action by the parent component, not entered by the user.

### Error handling in the panel

If the Server Action returns `{ ok: false, code: 'USER_NOT_FOUND' }`, show a non-dismissible inline alert (shadcn `Alert`, destructive variant) above the form: "User not found. The record may have been deleted." Include a "Back to users" `<Link>` to `/administration/users`.

If the action returns `{ ok: false, code: 'FORBIDDEN' }` or `{ ok: false, code: 'SERVER_ERROR' }`, show a toast notification (error variant): "Something went wrong. Please try again." The panel stays in edit mode.

If client-side Zod validation fails, `react-hook-form` shows field-level errors below each input — no toast.

---

## Implementation

### 11.1 — Zod validation schema (`validation/users.ts`)

Extend the existing file (created in um08). Add below `createUserSchema`:

```ts
export const updateUserDetailsSchema = z.object({
  userId: z.string().uuid("Invalid user ID"),
  userName: z.string().min(1, "Name is required").max(255).trim(),
  userPhonenum: z
    .string()
    .max(50, "Phone number is too long")
    .trim()
    .nullish()
    .transform((v) => v || null),
});

export type UpdateUserDetailsInput = z.infer<typeof updateUserDetailsSchema>;
```

`userId` is in the schema for server-side action parsing (Zod validates the UUID shape) but is not rendered as a form field — it is injected by the action wrapper before parsing.

### 11.2 — Repository: update function (`db/repositories/app-user.repository.ts`)

Add one function to the existing repository file. No business logic; no audit writes.

#### `updateUserNamePhone(tx, userId, data): Promise<void>`

```ts
export async function updateUserNamePhone(
  tx: DrizzleTransaction,
  userId: string,
  data: { userName: string; userPhonenum: string | null },
): Promise<void>;
```

Drizzle update (inside the caller-supplied transaction):

```ts
await tx
  .update(appuser)
  .set({
    userName: data.userName,
    userPhonenum: data.userPhonenum,
    lastModifiedDatetime: new Date(),
  })
  .where(eq(appuser.userId, userId));
```

Does not return the updated row — the service reads the before-snapshot in a separate `findUserById` call before opening the transaction.

**`findUserById`** — verify this function already exists from um09/um10 (`appUserRepository.findUserById`). If it returns at minimum `{ userId, userName, userPhonenum, status, authMethod }`, no changes are needed. If it does not exist, add:

```ts
export async function findUserById(userId: string): Promise<{
  userId: string;
  userName: string;
  userPhonenum: string | null;
  status: string;
  authMethod: string;
} | null>;
```

Query: `SELECT user_id, user_name, user_phonenum, status, auth_method FROM core.appuser WHERE user_id = $userId LIMIT 1`. Returns `null` if no row.

### 11.3 — Service: `updateUserDetails` (`services/users/users-write.service.ts`)

Add to the existing service file (established in um08). Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

```ts
type UpdateUserDetailsResult =
  | { ok: true }
  | { ok: false; code: "USER_NOT_FOUND" };

export async function updateUserDetails(
  input: UpdateUserDetailsInput,
  actorId: string,
): Promise<UpdateUserDetailsResult>;
```

Steps:

1. **Load current user (before-snapshot).** Call `appUserRepository.findUserById(input.userId)`. If `null` → return `{ ok: false, code: 'USER_NOT_FOUND' }`.

2. **Capture before-state:**

   ```ts
   const before = {
     userName: existingUser.userName,
     userPhonenum: existingUser.userPhonenum,
   };
   ```

3. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await updateUserNamePhone(tx, input.userId, { userName: input.userName, userPhonenum: input.userPhonenum })`

   b. `await writeAuditEvent(tx, { ... })` — see §11.3.1.

4. **Return** `{ ok: true }`.

On any transaction error, let the exception propagate — the transaction rolls back, no partial writes.

#### 11.3.1 — `USER_UPDATED` audit event

```ts
{
  eventType:    'USER_UPDATED',
  actorUserId:  actorId,
  targetEntity: 'APPUSER',
  targetId:     input.userId,
  beforeData:   before,          // { userName, userPhonenum }
  afterData:    {
    userName:    input.userName,
    userPhonenum: input.userPhonenum,
  },
}
```

`beforeData` captures the values at the point the service read them — immediately before the transaction opens. `afterData` captures the values written. Only the two editable fields are included; other user fields are not part of this event.

### 11.4 — `UserDetail` component update (`components/users/user-detail.tsx`)

Convert from a Server Component to a **Client Component** (`'use client'`). The component's data contract is unchanged — it receives `user: UserDetailView | null`, `notFound?: boolean`, and now additionally `permissionMap: EffectivePermissionMap`.

**Prop addition to `UserDetailProps`:**

```ts
interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
  permissionMap: EffectivePermissionMap; // NEW — passed from UsersPage
}
```

**New state:**

```ts
const [mode, setMode] = useState<"view" | "edit">("view");
const [isSaving, setIsSaving] = useState(false);
```

**`useEffect` to reset mode when selected user changes:**

```ts
useEffect(() => {
  setMode("view");
}, [user?.userId]);
```

This ensures navigating to a different user while edit mode is open resets to view mode rather than showing the previous user's form.

**View mode** (when `mode === 'view'`): renders the existing panel structure from um07/um08, plus the "Edit" button in the header when the user is not null and `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)`.

**Edit mode** (when `mode === 'edit'`): replaces the Identity group with `UserForm` in edit mode:

```tsx
<UserForm
  mode="edit"
  defaultValues={{ userName: user.userName, userPhonenum: user.userPhonenum }}
  onSubmit={handleEditSubmit}
  isSubmitting={isSaving}
/>
```

The panel header title shows "Edit User Details" (`<h3>`) in edit mode (close button hidden). Save/Cancel buttons render at the bottom of the panel below all field groups:

```tsx
<div className="flex justify-end gap-2 border-t border-[--border-subtle] pt-4">
  <Button variant="ghost" onClick={() => setMode("view")} disabled={isSaving}>
    Cancel
  </Button>
  <Button type="submit" form="edit-user-form" disabled={isSaving}>
    {isSaving ? <Loader2 className="animate-spin" size={14} /> : null}
    Save changes
  </Button>
</div>
```

**`handleEditSubmit`:**

```ts
const handleEditSubmit = async (values: UpdateUserDetailsInput) => {
  setIsSaving(true);
  try {
    const result = await updateUserDetailsAction({
      ...values,
      userId: user!.userId,
    });
    if (result.ok) {
      setMode("view");
      // revalidatePath in the action causes the page to re-render with updated props
    } else if (result.code === "USER_NOT_FOUND") {
      // show inline alert — handled in render via a localError state
      setLocalError("USER_NOT_FOUND");
    } else {
      toast.error("Something went wrong. Please try again.");
    }
  } finally {
    setIsSaving(false);
  }
};
```

Add `const [localError, setLocalError] = useState<'USER_NOT_FOUND' | null>(null)`. Clear `localError` when entering edit mode.

**`UsersPage` change:** Pass `permissionMap` to `UserDetail`:

```tsx
<UserDetail
  user={selectedUser}
  notFound={selectedUserId !== undefined && selectedUser === null}
  permissionMap={permissionMap} // NEW
/>
```

### 11.5 — `UserForm` update (`components/users/user-form.tsx`)

Extend `UserForm` with a discriminated union prop type that preserves the um08 create-mode API exactly and adds a new edit-mode variant.

**Updated props type:**

```ts
type RoleOption = {
  roleId: string;
  roleName: string;
  roleDescr: string | null;
};

type UserFormCreateProps = {
  mode: "create";
  roles: RoleOption[];
  onSubmit: (values: CreateUserInput) => Promise<void>;
  isSubmitting: boolean;
};

type UserFormEditProps = {
  mode: "edit";
  defaultValues: { userName: string; userPhonenum: string | null };
  onSubmit: (values: UpdateUserDetailsInput) => Promise<void>;
  isSubmitting: boolean;
};

type UserFormProps = UserFormCreateProps | UserFormEditProps;
```

**Edit mode rendering:**

```tsx
if (props.mode === "edit") {
  // useForm<UpdateUserDetailsInput> with zodResolver(updateUserDetailsSchema)
  // defaultValues from props.defaultValues
  // <form id="edit-user-form" onSubmit={...}>
  //   <FormField name="userName" ...>  Full Name input
  //   <FormField name="userPhonenum" ...>  Phone input
  // </form>
  // No email, auth method, or roles fields
}
```

A `useEffect` resets the form when `props.defaultValues` changes (user-change detection):

```ts
useEffect(() => {
  if (props.mode === "edit") {
    form.reset(props.defaultValues);
  }
}, [props.mode === "edit" && props.defaultValues]);
```

**Create mode:** no changes to existing logic from um08.

**Form ID:** edit mode uses `id="edit-user-form"`; create mode retains `id="create-user-form"`. Do not swap or reuse the same ID — the two forms may both be mounted at once on wider viewports.

The existing `UserFormCreateProps` fields (`roles`, `onSubmit: CreateUserInput`, `isSubmitting`) are unchanged. No callers of create-mode `UserForm` require updates.

### 11.6 — Server Action (`actions/users/update-user-details.action.ts`)

New file. `'use server'`.

```ts
export async function updateUserDetailsAction(
  rawInput: unknown,
): Promise<UpdateUserDetailsActionResult>;

type UpdateUserDetailsActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "USER_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` — wrap in try/catch; catch `NEXT_REDIRECT` and re-throw; other auth failures → return `{ ok: false, code: 'FORBIDDEN' }`.

2. `const parsed = updateUserDetailsSchema.safeParse(rawInput)`. If `!parsed.success` → return `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Call `usersWriteService.updateUserDetails(parsed.data, actorId)`.

4. If `!result.ok` → map service code to action result.

5. `revalidatePath('/administration/users')`.

6. Return `{ ok: true }`.

The action has no DB access — delegates entirely to the service.

### 11.7 — Tests

#### Unit tests: schema (`tests/unit/validation/users.test.ts`)

Extend or create. Cover `updateUserDetailsSchema`:

| Input                                                                    | Expected                         |
| ------------------------------------------------------------------------ | -------------------------------- |
| `{ userId: valid-uuid, userName: 'Alice', userPhonenum: '+1 555 0100' }` | Passes; `userPhonenum` preserved |
| `{ userId: valid-uuid, userName: 'Alice', userPhonenum: null }`          | Passes; `userPhonenum = null`    |
| `{ userId: valid-uuid, userName: 'Alice', userPhonenum: '' }`            | Passes; transform → `null`       |
| `{ userId: valid-uuid, userName: 'Alice', userPhonenum: undefined }`     | Passes; transform → `null`       |
| `{ userId: valid-uuid, userName: '' }`                                   | Fails; `userName` error          |
| `{ userId: valid-uuid, userName: 'A'.repeat(256) }`                      | Fails; `userName` too long       |
| `{ userId: 'not-a-uuid', userName: 'Alice' }`                            | Fails; `userId` error            |
| `{ userId: valid-uuid, userPhonenum: 'x'.repeat(51) }`                   | Fails; `userPhonenum` too long   |

#### Unit tests: service (`tests/unit/services/users-write.service.test.ts`)

Extend the existing file. Mock `appUserRepository` and `writeAuditEvent`.

| Scenario                            | Setup                                                                                      | Expected                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path — name and phone updated | `findUserById` → `{ userName: 'Old', userPhonenum: null }`; `updateUserNamePhone` succeeds | `updateUserNamePhone` called with new values; `writeAuditEvent` called with `USER_UPDATED`, `beforeData = { userName:'Old', userPhonenum:null }`, `afterData = { userName:'New', userPhonenum:'+1...' }` |
| Phone cleared (set to null)         | `findUserById` → `{ ..., userPhonenum: '+1 555' }`; input `userPhonenum: null`             | `afterData.userPhonenum = null`; update called                                                                                                                                                           |
| User not found                      | `findUserById` → `null`                                                                    | Returns `{ ok:false, code:'USER_NOT_FOUND' }`; no transaction opened; `writeAuditEvent` not called                                                                                                       |
| Transaction rollback                | `updateUserNamePhone` throws mid-transaction                                               | Exception propagates; `writeAuditEvent` not called; no partial write                                                                                                                                     |
| Before-snapshot captured correctly  | `findUserById` → `{ userName:'Old Name' }`                                                 | `beforeData.userName` = `'Old Name'` regardless of what `afterData` is                                                                                                                                   |

#### Unit tests: action (`tests/unit/actions/update-user-details.action.test.ts`)

New file. Mock `requirePermission`, `usersWriteService.updateUserDetails`, `revalidatePath`.

| Scenario                        | Setup                                           | Expected                                                                                            |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Valid input, ADMIN session      | Service → `{ ok:true }`                         | Returns `{ ok:true }`; `revalidatePath('/administration/users')` called                             |
| Validation failure — empty name | rawInput missing `userName`                     | Returns `{ ok:false, code:'VALIDATION_ERROR', fieldErrors:{ userName:[...] } }`; service not called |
| Invalid UUID in userId          | `userId = 'not-a-uuid'`                         | Returns `{ ok:false, code:'VALIDATION_ERROR' }`                                                     |
| User not found                  | Service → `{ ok:false, code:'USER_NOT_FOUND' }` | Returns `{ ok:false, code:'USER_NOT_FOUND' }`                                                       |
| Unauthorized                    | `requirePermission` throws                      | Returns `{ ok:false, code:'FORBIDDEN' }`                                                            |
| Server error                    | Service throws                                  | Returns `{ ok:false, code:'SERVER_ERROR' }`                                                         |

#### Unit tests: `UserDetail` edit mode (`tests/unit/components/user-detail.test.tsx`)

New file or extend. Use `@testing-library/react` + `vitest`. Mock `updateUserDetailsAction`.

- "Edit" button is rendered when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is true and user is not null.
- "Edit" button is not rendered when permission check is false.
- Clicking "Edit" renders the form (inputs for name and phone appear; Identity `<dd>` values disappear).
- Clicking "Cancel" returns to view mode; read-only values reappear.
- Submitting the form with valid values calls `updateUserDetailsAction` with `{ userId, userName, userPhonenum }`.
- While `isSaving` is true, the Save button is disabled.
- When action returns `{ ok:false, code:'USER_NOT_FOUND' }`, inline alert is shown in edit mode.
- When action returns `{ ok:false, code:'SERVER_ERROR' }`, toast error is shown (spy `toast.error`).
- When action returns `{ ok:true }`, mode resets to `'view'`.
- When `user.userId` changes (simulate by re-rendering with a different user prop), mode resets to `'view'`.

#### Unit tests: `UserForm` edit mode (`tests/unit/components/user-form.test.tsx`)

Extend the existing test file.

- Rendering `<UserForm mode="edit" ...>` shows Name and Phone inputs; does NOT show Email, Auth Method, or Roles fields.
- Rendering `<UserForm mode="create" ...>` still shows all 5 fields (no regression).
- Default values pre-populate Name and Phone inputs in edit mode.
- Submitting edit form with empty name shows a `react-hook-form` validation error.
- `onSubmit` in edit mode is called with `UpdateUserDetailsInput` shape (mocked function + assert).

#### Integration tests: action guard (`tests/integration/actions/update-user-details.action.test.ts`)

Use the test DB with `admin_user` and `no_grants_user`. Fixtures: a `target_user` APPUSER with `userName = 'Original Name'`, `userPhonenum = null`.

| Session        | Input                                                                              | Expected                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| admin_user     | `{ userId: target_user.userId, userName: 'Updated', userPhonenum: '+1 555 9999' }` | Returns `{ ok:true }`; `APPUSER.user_name = 'Updated'`; `APPUSER.user_phonenum = '+1 555 9999'`; `AUDIT_LOG` has `USER_UPDATED` entry |
| no_grants_user | Valid input                                                                        | Returns `{ ok:false, code:'FORBIDDEN' }`                                                                                              |
| (no session)   | Valid input                                                                        | Returns `{ ok:false, code:'FORBIDDEN' }`                                                                                              |

For the `admin_user` happy-path test, assert:

- `AUDIT_LOG` row: `event_type = 'USER_UPDATED'`, `actor_user_id = admin_user.userId`, `target_entity = 'APPUSER'`, `target_id = target_user.userId`.
- `before_data` JSON contains `{ userName: 'Original Name', userPhonenum: null }`.
- `after_data` JSON contains `{ userName: 'Updated', userPhonenum: '+1 555 9999' }`.
- `APPUSER.last_modified_datetime` is updated (greater than the value before the call).
- Audit and APPUSER update are in the same transaction: simulate a write failure and assert neither is committed (if feasible in the test setup; otherwise document as a service-level transaction test).

---

## Dependencies

No new npm packages required. All dependencies (`react-hook-form`, `@hookform/resolvers`, `zod`, `lucide-react`, `better-auth`, `drizzle-orm`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — no new components required. `Alert`, `Button`, `Input`, `Form`, `Sonner` (toast) are all present from um08/um09.

No new `PERMISSIONS` rows and no schema migrations required. `users:EDIT` is already seeded. `APPUSER` columns `user_name`, `user_phonenum`, and `last_modified_datetime` are in place from um02.

---

## Verification Checklist

### Action and authorization

- [ ] `updateUserDetailsAction` is decorated `'use server'`
- [ ] `requirePermission(PERMISSIONS.USERS, LEVELS.EDIT)` is called before any other logic in the action
- [ ] Calling the action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling the action with an ADMIN session and valid input returns `{ ok: true }`
- [ ] `revalidatePath('/administration/users')` is called on success
- [ ] `PERMISSIONS.USERS` constant is used (not the raw string `'users'`)
- [ ] The action has no DB access — delegates entirely to `usersWriteService`

### Validation

- [ ] Missing or empty `userName` returns `VALIDATION_ERROR` with `fieldErrors.userName`
- [ ] `userName` exceeding 255 chars returns `VALIDATION_ERROR`
- [ ] `userId` that is not a valid UUID returns `VALIDATION_ERROR` with `fieldErrors.userId`
- [ ] `userPhonenum` exceeding 50 chars returns `VALIDATION_ERROR`
- [ ] Null, undefined, and empty-string `userPhonenum` are all accepted and stored as `null`
- [ ] `updateUserDetailsSchema` is the same schema used server-side (action) and client-side (`UserForm` in edit mode)

### Service and audit

- [ ] `updateUserDetails` loads the user before opening the transaction and captures the before-snapshot
- [ ] A non-existent `userId` returns `{ ok: false, code: 'USER_NOT_FOUND' }` with no DB writes
- [ ] The `AUDIT_LOG` row is written inside the same transaction as the `APPUSER` update
- [ ] `event_type` is `'USER_UPDATED'`
- [ ] `actor_user_id` equals the acting admin's `user_id`
- [ ] `target_entity = 'APPUSER'`, `target_id = <targetUserId>`
- [ ] `before_data` contains the `userName` and `userPhonenum` values from before the update
- [ ] `after_data` contains the `userName` and `userPhonenum` values as submitted
- [ ] If the DB update throws mid-transaction, the audit row is also rolled back (no partial write)
- [ ] `last_modified_datetime` on `APPUSER` is updated to the current time

### Repository

- [ ] `updateUserNamePhone` only updates `user_name`, `user_phonenum`, and `last_modified_datetime` — no other fields
- [ ] `updateUserNamePhone` accepts a Drizzle transaction handle and does not open its own transaction
- [ ] `findUserById` returns `null` for a non-existent UUID
- [ ] Neither function contains business logic or audit writes

### `UserDetail` — view mode (no regression)

- [ ] Existing read-only field display is unchanged when `mode === 'view'`
- [ ] `StatusBadge`, `AuthMethodBadge`, `RoleBadge`, monospace dates, and close button all render correctly
- [ ] "User not found." and "Select a user to view details." states are unaffected
- [ ] `UserDetail` now accepts `permissionMap` prop without breaking existing renders

### `UserDetail` — edit mode UI

- [ ] "Edit" button appears in the panel header when a user is selected and `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is true
- [ ] "Edit" button does not appear when `hasLevel(...)` is false
- [ ] "Edit" button does not appear when no user is selected (empty or not-found states)
- [ ] Clicking "Edit" shows the form with pre-populated Name and Phone inputs; read-only Identity `<dd>` values disappear
- [ ] Panel header title changes to "Edit User Details" in edit mode; close (×) button is hidden
- [ ] "Cancel" returns to view mode without saving; read-only values reappear with original data
- [ ] "Save changes" button is `disabled` while the Server Action is in-flight
- [ ] "Save changes" button shows a `Loader2 animate-spin` icon while saving
- [ ] The Access and Account state groups remain visible as read-only during edit mode
- [ ] Navigating to a different user (change in `user.userId`) resets to view mode automatically

### `UserDetail` — save flow

- [ ] Submitting the edit form calls `updateUserDetailsAction` with `{ userId, userName, userPhonenum }`
- [ ] On `{ ok: true }`, panel returns to view mode
- [ ] On `{ ok: false, code: 'USER_NOT_FOUND' }`, an inline destructive alert is shown within the panel (not a toast); panel stays in edit mode
- [ ] On `{ ok: false, code: 'SERVER_ERROR' }` or `FORBIDDEN`, a toast error is shown; panel stays in edit mode
- [ ] After a successful save, the updated name appears in the panel header (via `revalidatePath` server re-render)
- [ ] After a successful save, the updated name appears in the `UserTable` row (via `revalidatePath` server re-render)

### `UserForm` edit mode

- [ ] `<UserForm mode="edit" ...>` renders only Full Name and Phone fields — no Email, Auth Method, or Roles
- [ ] `<UserForm mode="create" ...>` still renders all five fields (no regression from um08)
- [ ] Default values from `props.defaultValues` pre-populate the Name and Phone inputs
- [ ] Empty Name shows a field-level validation error before submitting
- [ ] Phone > 50 chars shows a field-level validation error before submitting
- [ ] Null and empty-string phone are both accepted (no client-side error)
- [ ] `onSubmit` in edit mode is called with `UpdateUserDetailsInput` (not `CreateUserInput`)
- [ ] Form `id="edit-user-form"` so the Save button can wire via `form="edit-user-form"`
- [ ] Create-mode form still uses `id="create-user-form"` (no regression)

### Boundary and TypeScript

- [ ] `validation/users.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/users/users-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/users/update-user-details.action.ts` has no DB access — delegates to the service
- [ ] `components/users/user-detail.tsx` has `'use client'` and no DB or service imports
- [ ] `UserDetail` does not call `appUserRepository` or any service directly
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] `vitest run` passes all `updateUserDetailsSchema` unit tests (8 scenarios per §11.7)
- [ ] `vitest run` passes all service unit tests (5 scenarios per §11.7)
- [ ] `vitest run` passes all action unit tests (6 scenarios per §11.7)
- [ ] `vitest run` passes `UserDetail` edit mode unit tests (9 scenarios per §11.7)
- [ ] `vitest run` passes `UserForm` edit mode unit tests (6 scenarios per §11.7)
- [ ] Integration tests pass: ADMIN updates user (DB assertions, audit), no-grants forbidden, no session forbidden

### Scope guard

- [ ] No email editing was added (email is immutable in this unit)
- [ ] No `auth_method` switching was added
- [ ] No role assignment or revocation was added
- [ ] No disable/enable, password reset, unlock, or tombstone functionality was added
- [ ] No new `PERMISSIONS` migration rows were added (`users:EDIT` is already seeded)
- [ ] No schema migrations were added (no column or table changes)
- [ ] The `(admin)/layout.tsx` sidebar, `force-dynamic`, and `metadata` from prior units are unchanged
- [ ] `UserTable` and `UsersPage` are unmodified except for passing `permissionMap` to `UserDetail`
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec is the unit-of-record
