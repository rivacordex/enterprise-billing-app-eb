# Spec: um19 — Create & edit role (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um18 (`RolesPage`, `RoleTable`, `RoleDetail`, `PermissionLevelTag`, `RoleWithMappings`, `RolePermissionMapping`, `PERMISSION_DISPLAY_NAMES`, `types/roles.ts`, `rolesRepository.findAll`/`findById`, `rolePermissionAssignRepository.findMappingsForRole`, `roles-read.service.ts`, `requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `EffectivePermissionMap`); Unit um05 (RBAC schema — `core.roles`; `types/rbac.ts`); Unit um03 (`writeAuditEvent` helper).
- **Source sections:** overview §"Roles & permissions" (create/edit/describe roles; name unique; deletion blocked while assigned; seeded roles permanent), §"Audit Events" (`ROLE_CREATED`, `ROLE_UPDATED`), §"Pages — Administration" item 2; architecture §2 (folder ownership, boundary rules), §5 (role deletion blocked by service layer and FK; seeded roles permanent — Inv. #22), §6 (`roles:EDIT` required); code-standards §3 (Server Actions: parse → auth → service → typed result, `revalidatePath`), §4 (styling — `cva`, CSS variables, no raw hex), §7 (file organization), §8 (permission naming). Invariants: **#3** (server-side authz), **#11** (audit entry atomic with mutation), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached), **#22** (seeded roles permanent — deletion blocked; renaming is permitted).

---

## Goal

Add the `roles:EDIT`-gated create and edit flows to the Roles page: an admin creates a new role via a dialog form (name unique, description optional), and edits an existing role's name and description inline in the `RoleDetail` panel; both paths write `ROLE_CREATED` / `ROLE_UPDATED` to `AUDIT_LOG` atomically and refresh the list immediately.

---

## Design

### Create flow — dialog

The create-role flow lives in a `CreateRoleDialog` (shadcn `Dialog`) triggered by enabling the "Add Role" stub button from um18. It mirrors the um08 create-user dialog pattern without a multi-state success screen — role creation produces no secret to reveal, so the dialog closes immediately after success and a toast confirms the action.

**Dialog title:** "Add Role"

**On success:**

1. Dialog closes.
2. Toast: "Role created."
3. URL navigates to `?roleId=<newRoleId>`, auto-selecting the new role in `RoleDetail`.
4. List refreshes via `revalidatePath('/administration/roles')`.

**NAME_CONFLICT:** dialog stays open; the Role Name field shows an inline field-level error: "A role with this name already exists."

**SERVER_ERROR / FORBIDDEN:** dialog closes; toast error: "Something went wrong. Please try again."

### Edit flow — inline panel

The edit flow lives inline inside `RoleDetail`, matching the um11 edit-user pattern exactly.

- `RoleDetail` gains an **"Edit" button** in the panel header (left of the × close button), visible when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` and `role !== null`.
- Clicking "Edit" transitions the panel from **view mode** to **edit mode** via local state (`'view' | 'edit'`).
- **Edit mode:** the Role info group (name, description) is replaced by `RoleForm` in edit mode. The Permissions matrix group remains read-only below the form. The panel header title changes to "Edit Role"; the × close button is hidden. "Save changes" (primary, with loading spinner) and "Cancel" (ghost) buttons render at the bottom of the panel.
- **On success:** panel returns to view mode; updated values appear immediately via the `revalidatePath` server re-render.
- **On NAME_CONFLICT:** stay in edit mode; render a field-level error on the Role Name field (passed via `externalFieldErrors` prop to `RoleForm`; see §19.5).
- **On ROLE_NOT_FOUND:** stay in edit mode; render a non-dismissible inline destructive `Alert` above the form: "Role not found. It may have been deleted by another admin."
- **On FORBIDDEN / SERVER_ERROR:** toast error; stay in edit mode.

### RoleForm fields

A single `RoleForm` component shared between create and edit modes. Both modes render the same two fields:

| Field       | Type       | Required | Validation                               |
| ----------- | ---------- | -------- | ---------------------------------------- |
| Role Name   | Text input | Yes      | 1–100 chars, trimmed                     |
| Description | Textarea   | No       | Max 500 chars, trimmed; omitted → `null` |

Role Name enforces uniqueness server-side. No client-side uniqueness check. The field-level error from the server (`NAME_CONFLICT`) is surfaced via `externalFieldErrors.roleName` passed from the parent component (dialog or detail panel).

**Styling:**

- Role Name: shadcn `Input`, `type="text"`, `autoFocus` when form mounts, `autoComplete="off"`.
- Description: shadcn `Textarea`, 3-row default height, resizable vertically.
- Field-level errors: `--text-caption` (12px), `--color-danger-500` text, rendered below each input. External field errors from the server use the same styling as RHF validation errors.
- Labels: shadcn `Label`, `--text-body-sm` weight medium.

### "Edit" button styling

Ghost style, consistent with um11 Users:

- `border border-[--border-subtle] bg-transparent hover:bg-[--action-ghost-hover] text-[--text-body]`
- Lucide `Pencil` icon (size 14) + label "Edit", `text-sm`
- Focus ring: `--focus-ring`
- Placed in the panel header: `<div className="flex items-center gap-2">[Edit button][× button]</div>`

---

## Implementation

### 19.1 — Validation schemas (`validation/roles.ts`)

New file. Only `zod`. No imports from `next/*`, `db/**`, `services/**`, `auth/**`, or UI modules.

**`createRoleSchema`:**

```ts
export const createRoleSchema = z.object({
  roleName: z
    .string()
    .min(1, "Role name is required")
    .max(100, "Role name must be 100 characters or fewer")
    .trim(),
  roleDescr: z
    .string()
    .max(500, "Description must be 500 characters or fewer")
    .trim()
    .nullish()
    .transform((v) => v || null),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;
```

**`updateRoleSchema`:**

```ts
export const updateRoleSchema = z.object({
  roleId: z.string().uuid("Invalid role ID"),
  roleName: z
    .string()
    .min(1, "Role name is required")
    .max(100, "Role name must be 100 characters or fewer")
    .trim(),
  roleDescr: z
    .string()
    .max(500, "Description must be 500 characters or fewer")
    .trim()
    .nullish()
    .transform((v) => v || null),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
```

`roleId` is in `updateRoleSchema` for server-side action parsing (validates UUID shape) but is **not** a visible form field in `RoleForm` — it is injected by `RoleDetail` before calling the action.

Export both schemas and their inferred types as named exports. No default export. These schemas are the single source of truth — imported by both Server Actions (server-side parse) and `RoleForm` (client-side via `@hookform/resolvers/zod`).

**`RoleFormValues` type** — the shape the form emits (shared between create and edit):

```ts
export type RoleFormValues = {
  roleName: string;
  roleDescr: string | null;
};
```

Both `createRoleSchema` and `updateRoleSchema` parse `roleName`/`roleDescr` with identical rules; `updateRoleSchema` additionally requires `roleId`. `RoleForm`'s `onSubmit` prop uses `RoleFormValues`; the parent component adds `roleId` for the update action.

### 19.2 — Repository write functions (`db/repositories/roles.repository.ts`)

Extend the existing file from um18. All new functions follow the same boundary rules: import only `@/db/client` and `@/db/schema`; no business logic; no audit writes.

#### 19.2.1 — `findRoleByName(name: string): Promise<Role | null>`

```ts
export async function findRoleByName(name: string): Promise<Role | null>;
```

Query: `SELECT * FROM core.roles WHERE LOWER(role_name) = LOWER($name) LIMIT 1`.

Use Drizzle's `sql` template or `eq`/`ilike` operator to make the comparison case-insensitive. Returns the full `Role` row or `null`. This allows the service to distinguish a same-role conflict (edit case: found role has same `roleId` as the role being edited → not a conflict) from a different-role conflict.

No transaction argument — this is a read-before-write guard used before opening the transaction.

#### 19.2.2 — `insertRole(tx: DrizzleTransaction, data: CreateRoleInput): Promise<{ roleId: string }>`

```ts
export async function insertRole(
  tx: DrizzleTransaction,
  data: CreateRoleInput,
): Promise<{ roleId: string }>;
```

Inserts one row into `core.roles` inside the caller-supplied transaction:

```ts
{
  roleId:              crypto.randomUUID(),
  roleName:            data.roleName,
  roleDescr:           data.roleDescr ?? null,
  createdDatetime:     new Date(),
  lastModifiedDatetime: new Date(),
}
```

Returns `{ roleId }`. The UUID is generated here, not in the service.

#### 19.2.3 — `updateRoleNameDescr(tx: DrizzleTransaction, roleId: string, data: { roleName: string; roleDescr: string | null }): Promise<void>`

```ts
export async function updateRoleNameDescr(
  tx: DrizzleTransaction,
  roleId: string,
  data: { roleName: string; roleDescr: string | null },
): Promise<void>;
```

Drizzle update inside the caller-supplied transaction:

```ts
await tx
  .update(roles)
  .set({
    roleName: data.roleName,
    roleDescr: data.roleDescr,
    lastModifiedDatetime: new Date(),
  })
  .where(eq(roles.roleId, roleId));
```

Does not return the updated row. Only updates `role_name`, `role_descr`, and `last_modified_datetime` — no other columns are touched.

### 19.3 — Service (`services/roles/roles-write.service.ts`)

New file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`.

#### `createRole(input: CreateRoleInput, actorId: string): Promise<CreateRoleResult>`

```ts
type CreateRoleResult =
  | { ok: true; roleId: string }
  | { ok: false; code: "NAME_CONFLICT" };
```

Steps:

1. **Name uniqueness check.** Call `rolesRepository.findRoleByName(input.roleName)`. If a non-null result is returned → return `{ ok: false, code: 'NAME_CONFLICT' }`. Do not open a transaction.

2. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await rolesRepository.insertRole(tx, input)` → `{ roleId }`.

   b. `await writeAuditEvent(tx, { ... })` — see §19.3.1.

3. **Return** `{ ok: true, roleId }`.

On any transaction error, let the exception propagate — transaction rolls back, nothing is persisted.

#### 19.3.1 — `ROLE_CREATED` audit event

Inside the transaction, after the insert:

```ts
{
  eventType:    'ROLE_CREATED',
  actorUserId:  actorId,
  targetEntity: 'ROLES',
  targetId:     roleId,
  beforeData:   null,
  afterData:    {
    roleName:  input.roleName,
    roleDescr: input.roleDescr,
  },
}
```

`beforeData` is `null` (creation has no prior state).

#### `updateRole(input: UpdateRoleInput, actorId: string): Promise<UpdateRoleResult>`

```ts
type UpdateRoleResult =
  | { ok: true }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "NAME_CONFLICT" };
```

Steps:

1. **Load current role (before-snapshot).** Call `rolesRepository.findById(input.roleId)`. If `null` → return `{ ok: false, code: 'ROLE_NOT_FOUND' }`.

2. **Name uniqueness check.** Call `rolesRepository.findRoleByName(input.roleName)`. If a non-null result is returned **and** `foundRole.roleId !== input.roleId` → return `{ ok: false, code: 'NAME_CONFLICT' }`. If the found role is the same as the one being edited (same name, same role), this is not a conflict — proceed.

3. **Capture before-snapshot:**

   ```ts
   const before = {
     roleName: existingRole.roleName,
     roleDescr: existingRole.roleDescr,
   };
   ```

4. **Short-circuit if no change.** If `before.roleName === input.roleName && before.roleDescr === input.roleDescr` → return `{ ok: true }` without opening a transaction. No DB write, no audit entry. This prevents spurious `ROLE_UPDATED` events when the admin clicks Save with unchanged values.

5. **Transaction.** Open a Drizzle transaction and execute atomically:

   a. `await rolesRepository.updateRoleNameDescr(tx, input.roleId, { roleName: input.roleName, roleDescr: input.roleDescr })`

   b. `await writeAuditEvent(tx, { ... })` — see §19.3.2.

6. **Return** `{ ok: true }`.

#### 19.3.2 — `ROLE_UPDATED` audit event

```ts
{
  eventType:    'ROLE_UPDATED',
  actorUserId:  actorId,
  targetEntity: 'ROLES',
  targetId:     input.roleId,
  beforeData:   before,   // { roleName, roleDescr }
  afterData:    {
    roleName:  input.roleName,
    roleDescr: input.roleDescr,
  },
}
```

`beforeData` captures the state immediately before the transaction opens — not the result of the `UPDATE`. Only `roleName` and `roleDescr` are included in both snapshots; other columns are not part of this event.

### 19.4 — Server Actions

#### 19.4.1 — `createRoleAction` (`actions/roles/create-role.action.ts`)

New file. `'use server'`.

```ts
type CreateRoleActionResult =
  | { ok: true; roleId: string }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "NAME_CONFLICT" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function createRoleAction(
  rawInput: unknown,
): Promise<CreateRoleActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.ROLES, LEVELS.EDIT)` — wrap in try/catch; catch `NEXT_REDIRECT` and re-throw; other auth failures → `{ ok: false, code: 'FORBIDDEN' }`.

2. `const parsed = createRoleSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Wrap in try/catch: `const result = await rolesWriteService.createRole(parsed.data, actorId)`. On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }`.

5. `revalidatePath('/administration/roles')`.

6. Return `{ ok: true, roleId: result.roleId }`.

No DB access in this file — delegates entirely to `rolesWriteService`.

#### 19.4.2 — `updateRoleAction` (`actions/roles/update-role.action.ts`)

New file. `'use server'`.

```ts
type UpdateRoleActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "NAME_CONFLICT" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function updateRoleAction(
  rawInput: unknown,
): Promise<UpdateRoleActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.ROLES, LEVELS.EDIT)` — same error handling as above.

2. `const parsed = updateRoleSchema.safeParse(rawInput)`. If `!parsed.success` → return `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: ... }`.

3. Wrap in try/catch: `const result = await rolesWriteService.updateRole(parsed.data, actorId)`. On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok` → return `{ ok: false, code: result.code }`.

5. `revalidatePath('/administration/roles')`.

6. Return `{ ok: true }`.

No DB access. Delegates entirely to `rolesWriteService`.

### 19.5 — `RoleForm` component (`components/roles/role-form.tsx`)

Client Component (`'use client'`). Shared between create and edit modes via a discriminated union prop. Uses `react-hook-form` + `@hookform/resolvers/zod`.

**Props type:**

```ts
type RoleFormCreateProps = {
  mode: "create";
  onSubmit: (values: RoleFormValues) => Promise<void>;
  isSubmitting: boolean;
  externalFieldErrors?: { roleName?: string };
};

type RoleFormEditProps = {
  mode: "edit";
  defaultValues: { roleName: string; roleDescr: string | null };
  onSubmit: (values: RoleFormValues) => Promise<void>;
  isSubmitting: boolean;
  externalFieldErrors?: { roleName?: string };
};

type RoleFormProps = RoleFormCreateProps | RoleFormEditProps;
```

`externalFieldErrors.roleName` is set by the parent when the server returns `NAME_CONFLICT`. It is displayed below the Role Name field with the same error styling as RHF errors. The parent clears `externalFieldErrors` when the user edits the field — achieved by the parent resetting its error state in response to the input's `onChange` event (see §19.6 and §19.7 for how parents manage this).

**`useForm` setup:**

```ts
const form = useForm<RoleFormValues>({
  resolver: zodResolver(
    props.mode === "create"
      ? createRoleSchema
      : updateRoleSchema.omit({ roleId: true }),
  ),
  defaultValues:
    props.mode === "edit"
      ? {
          roleName: props.defaultValues.roleName,
          roleDescr: props.defaultValues.roleDescr ?? "",
        }
      : { roleName: "", roleDescr: "" },
});
```

Use `createRoleSchema` for create-mode client validation and `updateRoleSchema` with `roleId` omitted (via Zod `.omit({ roleId: true })`) for edit-mode client validation — the `roleId` field is not a form field and must not cause a client-side validation failure.

**`useEffect` for edit-mode default value sync** (same pattern as um11):

```ts
useEffect(() => {
  if (props.mode === "edit") {
    form.reset({
      roleName: props.defaultValues.roleName,
      roleDescr: props.defaultValues.roleDescr ?? "",
    });
  }
}, [props.mode === "edit" && props.defaultValues]);
```

Called when the role being edited changes (e.g. the user selects a different role while edit mode is open from a prior selection).

**Form `id`:** `id="role-form"` in both modes. Only one role form is ever mounted at a time (either the dialog or the detail panel, never both simultaneously), so a fixed id is safe.

**Field rendering:**

```tsx
<form id="role-form" onSubmit={form.handleSubmit(handleSubmit)}>
  {/* Role Name */}
  <FormField
    control={form.control}
    name="roleName"
    render={({ field }) => (
      <FormItem>
        <FormLabel>Role Name</FormLabel>
        <FormControl>
          <Input
            {...field}
            type="text"
            autoComplete="off"
            autoFocus
            disabled={isSubmitting}
          />
        </FormControl>
        <FormMessage />
        {/* External server-side error (NAME_CONFLICT) */}
        {externalFieldErrors?.roleName && !form.formState.errors.roleName && (
          <p className="text-xs text-[--color-danger-500]">
            {externalFieldErrors.roleName}
          </p>
        )}
      </FormItem>
    )}
  />

  {/* Description */}
  <FormField
    control={form.control}
    name="roleDescr"
    render={({ field }) => (
      <FormItem>
        <FormLabel>
          Description{" "}
          <span className="font-normal text-[--text-muted]">(optional)</span>
        </FormLabel>
        <FormControl>
          <Textarea
            {...field}
            value={field.value ?? ""}
            rows={3}
            disabled={isSubmitting}
          />
        </FormControl>
        <FormMessage />
      </FormItem>
    )}
  />
</form>
```

**`handleSubmit` adapter** — transforms RHF values before calling the `onSubmit` prop:

```ts
const handleSubmit = async (values: {
  roleName: string;
  roleDescr: string;
}) => {
  await props.onSubmit({
    roleName: values.roleName,
    roleDescr: values.roleDescr.trim() || null,
  });
};
```

Converts an empty-string `roleDescr` to `null` so the prop's `RoleFormValues` type is satisfied.

No action calls, no router calls, no toast calls inside `RoleForm`. All of those happen in the parent (dialog or detail panel).

### 19.6 — `CreateRoleDialog` component (`components/roles/create-role-dialog.tsx`)

Client Component (`'use client'`).

**Props:**

```ts
interface CreateRoleDialogProps {
  trigger: React.ReactNode; // the "Add Role" button rendered by RoleTable
}
```

**State:**

```ts
const [open, setOpen] = useState(false);
const [isSubmitting, setIsSubmitting] = useState(false);
const [nameConflict, setNameConflict] = useState(false);
```

`nameConflict` drives `externalFieldErrors={{ roleName: 'A role with this name already exists.' }}` on `RoleForm`.

**Open/close behavior:**

- Opening: `setOpen(true)` + `setNameConflict(false)`.
- Closing: `setOpen(false)` + `setNameConflict(false)`. The RHF form resets automatically on next open because the `Dialog` unmounts `RoleForm` when closed (do not use `keepMounted` / `forceMount` on the dialog content).

**Submit handler:**

```ts
const handleSubmit = async (values: RoleFormValues) => {
  setIsSubmitting(true);
  setNameConflict(false);
  try {
    const result = await createRoleAction(values);
    if (result.ok) {
      setOpen(false);
      router.push(`/administration/roles?roleId=${result.roleId}`);
      toast.success("Role created");
    } else if (result.code === "NAME_CONFLICT") {
      setNameConflict(true);
      // dialog stays open; RoleForm renders the field error
    } else {
      toast.error("Something went wrong. Please try again.");
      setOpen(false);
    }
  } finally {
    setIsSubmitting(false);
  }
};
```

Uses `useRouter` from `next/navigation`.

**Render:**

```tsx
<Dialog open={open} onOpenChange={isSubmitting ? undefined : setOpen}>
  <DialogTrigger asChild>{trigger}</DialogTrigger>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Add Role</DialogTitle>
    </DialogHeader>

    <RoleForm
      mode="create"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      externalFieldErrors={
        nameConflict
          ? { roleName: "A role with this name already exists." }
          : undefined
      }
    />

    <DialogFooter>
      <Button
        variant="ghost"
        onClick={() => setOpen(false)}
        disabled={isSubmitting}
      >
        Cancel
      </Button>
      <Button type="submit" form="role-form" disabled={isSubmitting}>
        {isSubmitting && <Loader2 size={14} className="mr-1 animate-spin" />}
        Create Role
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

`onOpenChange` is passed `undefined` while `isSubmitting` is true to block backdrop/Escape dismissal mid-flight.

`externalFieldErrors` is cleared automatically on the next open (via `setNameConflict(false)` in the open handler) and on any new submission attempt (`setNameConflict(false)` at the start of `handleSubmit`).

### 19.7 — `RoleDetail` component update (`components/roles/role-detail.tsx`)

`RoleDetail` was already specified as a Client Component in um18 (it uses `useRouter`). This unit adds the edit mode and `permissionMap` prop.

**Updated props type:**

```ts
interface RoleDetailProps {
  role: RoleWithMappings | null;
  selectedRoleId: string | null;
  permissionMap: EffectivePermissionMap; // NEW in um19
}
```

**New state:**

```ts
const [mode, setMode] = useState<"view" | "edit">("view");
const [isSaving, setIsSaving] = useState(false);
const [localError, setLocalError] = useState<"ROLE_NOT_FOUND" | null>(null);
const [nameConflict, setNameConflict] = useState(false);
```

**Reset on role change** (mirrors um11 `UserDetail`):

```ts
useEffect(() => {
  setMode("view");
  setLocalError(null);
  setNameConflict(false);
}, [role?.roleId]);
```

**Visibility of "Edit" button:**

```ts
const canEdit = hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT);
const showEdit = canEdit && role !== null && mode === "view";
```

**Panel header:**

View mode:

```tsx
<div className="flex items-center justify-between">
  <div>
    <h3>{role.roleName}</h3>
    <RoleBadge roleName={role.roleName} />
  </div>
  <div className="flex items-center gap-2">
    {showEdit && (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setMode("edit");
          setLocalError(null);
          setNameConflict(false);
        }}
      >
        <Pencil size={14} /> Edit
      </Button>
    )}
    <button
      onClick={() => router.push("/administration/roles")}
      aria-label="Close"
    >
      <X size={16} />
    </button>
  </div>
</div>
```

Edit mode:

```tsx
<div className="flex items-center justify-between">
  <h3>Edit Role</h3>
  {/* no × button in edit mode */}
</div>
```

**Edit mode body:**

Replace the Role info `<dl>` group with `RoleForm`:

```tsx
{mode === 'edit' ? (
  <div>
    {localError === 'ROLE_NOT_FOUND' && (
      <Alert variant="destructive" className="mb-3">
        <AlertDescription>
          Role not found. It may have been deleted by another admin.
        </AlertDescription>
      </Alert>
    )}

    <RoleForm
      mode="edit"
      defaultValues={{ roleName: role.roleName, roleDescr: role.roleDescr ?? null }}
      onSubmit={handleEditSubmit}
      isSubmitting={isSaving}
      externalFieldErrors={nameConflict ? { roleName: 'A role with this name already exists.' } : undefined}
    />

    {/* Save / Cancel footer */}
    <div className="flex justify-end gap-2 pt-4 border-t border-[--border-subtle]">
      <Button variant="ghost" onClick={() => setMode('view')} disabled={isSaving}>
        Cancel
      </Button>
      <Button type="submit" form="role-form" disabled={isSaving}>
        {isSaving && <Loader2 size={14} className="animate-spin mr-1" />}
        Save changes
      </Button>
    </div>
  </div>
) : (
  /* existing Role info <dl> from um18 */
)}
```

The Permissions matrix group (rendered below the Role info group) remains **always visible as read-only** — in both view and edit mode. Only the Role info group toggles between `<dl>` and `RoleForm`.

**`handleEditSubmit`:**

```ts
const handleEditSubmit = async (values: RoleFormValues) => {
  if (!role) return;
  setIsSaving(true);
  setNameConflict(false);
  setLocalError(null);
  try {
    const result = await updateRoleAction({ roleId: role.roleId, ...values });
    if (result.ok) {
      setMode("view");
      // revalidatePath in the action causes updated props to flow in on next render
    } else if (result.code === "NAME_CONFLICT") {
      setNameConflict(true);
    } else if (result.code === "ROLE_NOT_FOUND") {
      setLocalError("ROLE_NOT_FOUND");
    } else {
      toast.error("Something went wrong. Please try again.");
    }
  } finally {
    setIsSaving(false);
  }
};
```

`role.roleId` is injected by `handleEditSubmit` before calling `updateRoleAction` — `roleId` is not a `RoleForm` field.

`nameConflict` is cleared on each new submit attempt so stale errors don't persist if the user corrects the name.

**No changes to the Permissions matrix rendering, empty state, or "Role not found" state from um18.**

### 19.8 — `RoleTable` component update (`components/roles/role-table.tsx`)

Enable the "Add Role" stub button by mounting `CreateRoleDialog` in its place. Two changes:

1. **Replace the stub button with the dialog trigger:**

```tsx
{
  hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT) && (
    <CreateRoleDialog trigger={<Button>Add Role</Button>} />
  );
}
```

2. **Remove** the `disabled` attribute and `title="Feature coming soon."` tooltip from the previous stub.

No other changes to `RoleTable`. The `permissionMap` prop already flows through from um18.

### 19.9 — `RolesPage` update (`app/(admin)/administration/roles/page.tsx`)

One addition: pass `permissionMap` to `RoleDetail`.

```tsx
<RoleDetail
  role={selectedRole}
  selectedRoleId={selectedRoleId}
  permissionMap={permissionMap} // NEW in um19
/>
```

`permissionMap` is already available from `requirePermission`. No other changes to the page.

### 19.10 — Tests

#### Unit tests: validation schemas (`tests/unit/validation/roles.test.ts`)

New file.

**`createRoleSchema`:**

| Input                                                | Expected                                                        |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `{ roleName: 'Finance', roleDescr: 'Finance team' }` | Passes; both fields preserved                                   |
| `{ roleName: '  Finance  ' }`                        | Passes; `roleName` trimmed to `'Finance'`; `roleDescr` → `null` |
| `{ roleName: '' }`                                   | Fails; `roleName` error "Role name is required"                 |
| `{ roleName: 'A'.repeat(101) }`                      | Fails; `roleName` too long                                      |
| `{ roleName: 'X', roleDescr: 'D'.repeat(501) }`      | Fails; `roleDescr` too long                                     |
| `{ roleName: 'X', roleDescr: '' }`                   | Passes; empty string transform → `null`                         |
| `{ roleName: 'X', roleDescr: null }`                 | Passes; `roleDescr = null`                                      |
| `{ roleName: 'X', roleDescr: undefined }`            | Passes; `roleDescr = null`                                      |

**`updateRoleSchema`:**

| Input                                                            | Expected                   |
| ---------------------------------------------------------------- | -------------------------- |
| `{ roleId: valid-uuid, roleName: 'Finance', roleDescr: 'Desc' }` | Passes                     |
| `{ roleId: 'not-a-uuid', roleName: 'Finance' }`                  | Fails; `roleId` error      |
| `{ roleId: valid-uuid, roleName: '' }`                           | Fails; `roleName` error    |
| `{ roleId: valid-uuid, roleName: 'X' }`                          | Passes; `roleDescr = null` |

#### Unit tests: service (`tests/unit/services/roles-write.service.test.ts`)

New file. Mock `rolesRepository` and `writeAuditEvent`.

**`createRole`:**

| Scenario                          | Setup                                                                            | Expected                                                                                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path                        | `findRoleByName` → `null`                                                        | `insertRole` called with `{ roleName, roleDescr }`; `writeAuditEvent` called with `ROLE_CREATED`, `beforeData: null`, `afterData: { roleName, roleDescr }`; returns `{ ok: true, roleId }` |
| Name conflict                     | `findRoleByName` → `{ roleId: 'other-id', ... }`                                 | Returns `{ ok: false, code: 'NAME_CONFLICT' }`; `insertRole` not called; `writeAuditEvent` not called                                                                                      |
| Name conflict is case-insensitive | `findRoleByName('Finance')` → `{ roleId: 'other-id' }` when input is `'finance'` | Returns `{ ok: false, code: 'NAME_CONFLICT' }` (the repo query is case-insensitive; service trusts the result)                                                                             |
| Transaction rollback              | `insertRole` throws                                                              | Exception propagates; `writeAuditEvent` not called; no partial writes                                                                                                                      |
| Null description                  | `roleDescr: null`                                                                | `insertRole` called with `roleDescr: null`; `afterData.roleDescr: null`                                                                                                                    |

**`updateRole`:**

| Scenario                                   | Setup                                                                                                     | Expected                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path — name and descr changed        | `findById` → existing role with different name; `findRoleByName` → `null`; `updateRoleNameDescr` succeeds | `updateRoleNameDescr` called; `writeAuditEvent` called with `ROLE_UPDATED`, correct `beforeData`/`afterData`; returns `{ ok: true }` |
| Same name, same role (edit without rename) | `findRoleByName` → `{ roleId: input.roleId }` (same role)                                                 | Not a conflict; proceeds to update                                                                                                   |
| Name conflict with another role            | `findRoleByName` → `{ roleId: 'other-role-id' }`                                                          | Returns `{ ok: false, code: 'NAME_CONFLICT' }`; `updateRoleNameDescr` not called                                                     |
| Role not found                             | `findById` → `null`                                                                                       | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`; no DB writes                                                                        |
| No change (same name and descr)            | `findById` → role with same values as input                                                               | Returns `{ ok: true }`; transaction not opened; `updateRoleNameDescr` not called; `writeAuditEvent` not called                       |
| Description cleared to null                | Existing `roleDescr: 'old'`; input `roleDescr: null`                                                      | `beforeData.roleDescr = 'old'`, `afterData.roleDescr = null`; update is called (value changed)                                       |
| Transaction rollback                       | `updateRoleNameDescr` throws                                                                              | Exception propagates; `writeAuditEvent` not called                                                                                   |
| Before-snapshot correct                    | Existing `roleName: 'Old Name'`                                                                           | `beforeData.roleName = 'Old Name'` regardless of `afterData`                                                                         |

#### Unit tests: actions (`tests/unit/actions/create-role.action.test.ts`, `tests/unit/actions/update-role.action.test.ts`)

New files. Mock `requirePermission`, `rolesWriteService`, `revalidatePath`.

**`createRoleAction`:**

| Scenario                        | Setup                                                 | Expected                                                                                                     |
| ------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Valid input, ADMIN session      | `createRole` → `{ ok: true, roleId: 'r1' }`           | Returns `{ ok: true, roleId: 'r1' }`; `revalidatePath('/administration/roles')` called                       |
| Validation failure — empty name | Raw input `{ roleName: '' }`                          | Returns `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: { roleName: [...] } }`; `createRole` not called |
| Name conflict                   | `createRole` → `{ ok: false, code: 'NAME_CONFLICT' }` | Returns `{ ok: false, code: 'NAME_CONFLICT' }`; `revalidatePath` not called                                  |
| Unauthorized                    | `requirePermission` throws                            | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                   |
| Server error                    | `createRole` throws                                   | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                                                |

**`updateRoleAction`:**

| Scenario                          | Setup                                                  | Expected                                                                            |
| --------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Valid input, ADMIN session        | `updateRole` → `{ ok: true }`                          | Returns `{ ok: true }`; `revalidatePath('/administration/roles')` called            |
| Validation failure — invalid UUID | `roleId = 'not-a-uuid'`                                | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`; `updateRole` not called          |
| Validation failure — empty name   | `roleName: ''`                                         | Returns `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: { roleName: [...] } }` |
| Name conflict                     | `updateRole` → `{ ok: false, code: 'NAME_CONFLICT' }`  | Returns `{ ok: false, code: 'NAME_CONFLICT' }`                                      |
| Role not found                    | `updateRole` → `{ ok: false, code: 'ROLE_NOT_FOUND' }` | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`                                     |
| Unauthorized                      | `requirePermission` throws                             | Returns `{ ok: false, code: 'FORBIDDEN' }`                                          |
| Server error                      | `updateRole` throws                                    | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                       |

#### Unit tests: `RoleForm` (`tests/unit/components/roles/role-form.test.tsx`)

New file. Use `@testing-library/react` + `vitest`.

- Create mode: Role Name and Description fields render; submitting with empty name shows RHF error.
- Create mode: submitting with valid values calls `onSubmit` with `{ roleName, roleDescr }`.
- Create mode: `roleDescr` empty string submits as `null` (transform applied).
- Create mode: `autoFocus` is applied to Role Name input.
- Edit mode: Role Name and Description fields render (same fields as create — no regression).
- Edit mode: `defaultValues` pre-populate Role Name and Description inputs.
- Edit mode: `onSubmit` is called with updated `RoleFormValues` shape.
- Both modes: `externalFieldErrors.roleName` renders an error below Role Name when set.
- Both modes: `isSubmitting=true` disables both inputs.
- Both modes: form uses `id="role-form"` so external submit buttons can wire via `form="role-form"`.

#### Unit tests: `CreateRoleDialog` (`tests/unit/components/roles/create-role-dialog.test.tsx`)

New file. Mock `createRoleAction`, `useRouter`, `toast`.

- Dialog is not visible when closed.
- Clicking the trigger opens the dialog; title "Add Role" is visible.
- Submit with valid values calls `createRoleAction`.
- While `isSubmitting`, the "Create Role" button is disabled and shows `Loader2`.
- On `{ ok: true }`: dialog closes; `router.push` is called with `?roleId=<newRoleId>`; `toast.success('Role created')` is called.
- On `{ ok: false, code: 'NAME_CONFLICT' }`: dialog stays open; `RoleForm` receives `externalFieldErrors.roleName`; "A role with this name already exists." is rendered.
- On `{ ok: false, code: 'SERVER_ERROR' }`: dialog closes; `toast.error` is called.
- "Cancel" closes the dialog without calling `createRoleAction`.
- `onOpenChange` is suppressed while `isSubmitting` (backdrop/Escape blocked mid-flight).
- `nameConflict` error is cleared on the next submit attempt (re-submitting after a conflict starts fresh).

#### Unit tests: `RoleDetail` edit mode (`tests/unit/components/roles/role-detail.test.tsx`)

Extend the existing test file. Mock `updateRoleAction`, `useRouter`, `toast`.

- "Edit" button is rendered when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` is true and `role !== null`.
- "Edit" button is NOT rendered when `hasLevel(...)` returns false (no-grants user).
- "Edit" button is NOT rendered when `role === null`.
- Clicking "Edit" replaces the Role info `<dl>` with `RoleForm` in edit mode; panel header changes to "Edit Role"; × close button is hidden.
- `RoleForm` in edit mode receives `defaultValues` from the current role's `roleName` and `roleDescr`.
- Permissions matrix group remains visible (read-only) in edit mode.
- "Cancel" returns to view mode; Role info `<dl>` reappears; × close button reappears.
- Submitting calls `updateRoleAction({ roleId: role.roleId, ...formValues })`.
- While `isSaving`, "Save changes" is disabled and shows `Loader2`.
- On `{ ok: true }`: `mode` resets to `'view'`.
- On `{ ok: false, code: 'NAME_CONFLICT' }`: `RoleForm` receives `externalFieldErrors.roleName`; dialog stays in edit mode; "A role with this name already exists." is rendered.
- On `{ ok: false, code: 'ROLE_NOT_FOUND' }`: inline `Alert` destructive renders above the form; panel stays in edit mode.
- On `{ ok: false, code: 'SERVER_ERROR' }`: `toast.error` is called; panel stays in edit mode.
- Changing the selected role (role prop changes) resets to view mode and clears all error states.
- `nameConflict` error is cleared on the next save attempt.

#### Integration tests: create action (`tests/integration/actions/create-role.action.test.ts`)

New file. Test DB with `admin_user` and `no_grants_user`.

| Session          | Input                                                | Expected                                                                |
| ---------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `admin_user`     | `{ roleName: 'Finance', roleDescr: 'Finance team' }` | Returns `{ ok: true, roleId: <uuid> }`; see assertions below            |
| `admin_user`     | `{ roleName: 'ADMIN' }` (seeded role name)           | Returns `{ ok: false, code: 'NAME_CONFLICT' }`; no new row              |
| `admin_user`     | `{ roleName: 'admin' }` (lowercase seeded name)      | Returns `{ ok: false, code: 'NAME_CONFLICT' }` (case-insensitive check) |
| `no_grants_user` | Valid input                                          | Returns `{ ok: false, code: 'FORBIDDEN' }`                              |
| (no session)     | Valid input                                          | Returns `{ ok: false, code: 'FORBIDDEN' }`                              |

**Happy-path assertions for `admin_user` create:**

- `SELECT * FROM core.roles WHERE role_id = <newRoleId>` returns one row with `role_name = 'Finance'`, `role_descr = 'Finance team'`.
- `AUDIT_LOG` has exactly one row: `event_type = 'ROLE_CREATED'`, `actor_user_id = admin_user.userId`, `target_entity = 'ROLES'`, `target_id = <newRoleId>`.
- `before_data` is `null`.
- `after_data` JSON contains `{ roleName: 'Finance', roleDescr: 'Finance team' }`.
- `AUDIT_LOG` row exists within the same transaction as the `roles` row (assert both exist or neither, by testing rollback: stub `writeAuditEvent` to throw and assert no `roles` row is created).

#### Integration tests: update action (`tests/integration/actions/update-role.action.test.ts`)

New file. Test DB with `admin_user` and `no_grants_user`. Fixture: a `test_role` inserted with `role_name = 'TestRole'`, `role_descr = null`.

| Session          | Input                                                                              | Expected                                          |
| ---------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `admin_user`     | `{ roleId: test_role.roleId, roleName: 'TestRoleRenamed', roleDescr: 'New desc' }` | Returns `{ ok: true }`; see assertions below      |
| `admin_user`     | `{ roleId: test_role.roleId, roleName: 'ADMIN' }`                                  | Returns `{ ok: false, code: 'NAME_CONFLICT' }`    |
| `admin_user`     | `{ roleId: test_role.roleId, roleName: 'TestRole' }` (same name, no change)        | Returns `{ ok: true }`; no DB write; no audit row |
| `admin_user`     | `{ roleId: 'non-existent-uuid', roleName: 'X' }`                                   | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`   |
| `no_grants_user` | Valid input                                                                        | Returns `{ ok: false, code: 'FORBIDDEN' }`        |

**Happy-path assertions:**

- `APPUSER` role row has `role_name = 'TestRoleRenamed'`, `role_descr = 'New desc'`, `last_modified_datetime` updated.
- `AUDIT_LOG` row: `event_type = 'ROLE_UPDATED'`, `before_data = { roleName: 'TestRole', roleDescr: null }`, `after_data = { roleName: 'TestRoleRenamed', roleDescr: 'New desc' }`.
- Atomicity: stub `writeAuditEvent` to throw; assert `role_name` is unchanged.

**No-change assertion (short-circuit):**

- Input same name and same description as existing. Assert `last_modified_datetime` is unchanged and no `AUDIT_LOG` row with `ROLE_UPDATED` is written.

#### Integration tests: repository (`tests/integration/db/roles-repository.test.ts`)

Extend the existing file.

- `findRoleByName('ADMIN')` returns the ADMIN role after `db:setup`.
- `findRoleByName('admin')` returns the ADMIN role (case-insensitive).
- `findRoleByName('nonexistent')` returns `null`.
- `insertRole(tx, { roleName: 'Finance', roleDescr: null })` inserts a row; `SELECT` confirms it exists; returned `roleId` is a valid UUID.
- `updateRoleNameDescr(tx, roleId, { roleName: 'Renamed', roleDescr: 'Desc' })` updates the row; `SELECT` confirms changes; `last_modified_datetime` is updated.
- `updateRoleNameDescr` does not update any column other than `role_name`, `role_descr`, `last_modified_datetime`.

---

## Dependencies

No new npm packages beyond what prior units installed. Verify the following are available; install if missing:

- `react-hook-form` — already installed from um08 (used by `UserForm`).
- `@hookform/resolvers` — already installed from um08.
- `zod` — already installed.
- `drizzle-orm` — already installed.
- `lucide-react` — already installed; requires `Pencil` and `Loader2` icons (both present since lucide-react 0.265).

**shadcn/ui components** — run the CLI if not already added:

- `npx shadcn@latest add dialog` — for `CreateRoleDialog`. Check if already added in um08 for `CreateUserDialog`; skip if present.
- `npx shadcn@latest add textarea` — for the Description field in `RoleForm`. Check if added in a prior unit; install only if absent.
- `npx shadcn@latest add alert` — for the `ROLE_NOT_FOUND` inline alert in `RoleDetail`. Check if already added in um11 or um13; skip if present.
- `npx shadcn@latest add sonner` — for toast notifications. Check if already added in um08; skip if present.

All shadcn components are added to `components/ui/` and must not be hand-edited beyond token wiring (code-standards §4.1).

No new `PERMISSIONS` migration rows — `roles:EDIT` is already seeded (ADMIN holds `roles:DELETE` which satisfies EDIT). No schema migrations required — the `role_name` unique constraint is already in place from um05.

---

## Verification Checklist

### Action and authorization

- [ ] `createRoleAction` is decorated `'use server'`; `updateRoleAction` is decorated `'use server'`
- [ ] Both actions call `requirePermission(PERMISSIONS.ROLES, LEVELS.EDIT)` before any other logic
- [ ] Calling either action with no session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] Calling either action with a no-grants session returns `{ ok: false, code: 'FORBIDDEN' }`
- [ ] `PERMISSIONS.ROLES` and `LEVELS.EDIT` constants are used (not raw strings)
- [ ] Neither action contains DB access — delegates entirely to `rolesWriteService`
- [ ] `revalidatePath('/administration/roles')` is called on success; NOT called on any error path

### Validation

- [ ] Empty `roleName` returns `VALIDATION_ERROR` with `fieldErrors.roleName`
- [ ] `roleName` > 100 chars returns `VALIDATION_ERROR`
- [ ] `roleDescr` > 500 chars returns `VALIDATION_ERROR`
- [ ] Empty string and null `roleDescr` are both accepted and stored as `null`
- [ ] `updateRoleSchema` requires a valid UUID `roleId`; non-UUID returns `VALIDATION_ERROR`
- [ ] `createRoleSchema` and `updateRoleSchema` are the same schemas used by actions (server-side) and `RoleForm` (client-side)

### Create role

- [ ] Submitting a valid new role name creates a `roles` row with `status` PENDING — wait, roles don't have status. Correct: creates a `roles` row with the given `role_name` and `role_descr`
- [ ] New role appears in `RoleTable` after the dialog closes (list refreshed via `revalidatePath`)
- [ ] After creation, URL changes to `?roleId=<newRoleId>` and the new role is selected in `RoleDetail`
- [ ] Toast "Role created" is shown
- [ ] `AUDIT_LOG` row: `event_type = 'ROLE_CREATED'`, `actor_user_id = actorId`, `before_data = null`, `after_data = { roleName, roleDescr }`
- [ ] Audit row is written in the same transaction as the `roles` row insert

### Name uniqueness (create and edit)

- [ ] Creating a role with the same name as an existing role (case-insensitive) returns `NAME_CONFLICT`
- [ ] `NAME_CONFLICT` on create: dialog stays open; field error "A role with this name already exists." appears on the Role Name field
- [ ] `NAME_CONFLICT` on edit: panel stays in edit mode; field error appears on the Role Name field
- [ ] Editing a role to keep its current name is NOT a conflict (same role, same name)
- [ ] No `roles` row is inserted on `NAME_CONFLICT`; no `AUDIT_LOG` row is written

### Edit role

- [ ] "Edit" button is visible in `RoleDetail` when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` is true
- [ ] "Edit" button is absent when `hasLevel(...)` is false
- [ ] "Edit" button is absent when no role is selected
- [ ] Clicking "Edit" shows `RoleForm` in edit mode with Role Name and Description pre-populated
- [ ] Permissions matrix remains read-only and visible during edit mode
- [ ] Panel header changes to "Edit Role"; × close button is hidden
- [ ] "Cancel" returns to view mode; original values reappear; × close button reappears
- [ ] "Save changes" is `disabled` and shows `Loader2` while `isSaving`
- [ ] On `{ ok: true }`, panel returns to view mode; updated name/description appear (via `revalidatePath` re-render)
- [ ] Saving with no changes (same name, same description) returns `{ ok: true }` without a DB write or audit entry
- [ ] On `ROLE_NOT_FOUND`, an inline destructive `Alert` appears above the form; panel stays in edit mode
- [ ] On `SERVER_ERROR`, `toast.error` is called; panel stays in edit mode
- [ ] Selecting a different role while edit mode is open resets to view mode and clears all error states

### Audit

- [ ] `ROLE_CREATED`: `event_type = 'ROLE_CREATED'`, `targetEntity = 'ROLES'`, `targetId = roleId`, `beforeData = null`, `afterData = { roleName, roleDescr }`
- [ ] `ROLE_UPDATED`: `event_type = 'ROLE_UPDATED'`, `targetEntity = 'ROLES'`, `targetId = roleId`, `beforeData` has pre-change values, `afterData` has post-change values
- [ ] If `roleName` and `roleDescr` are unchanged on edit, no `ROLE_UPDATED` event is written
- [ ] Audit write is inside the same transaction as the mutation in both create and edit paths

### `RoleForm`

- [ ] `RoleForm` renders Role Name and Description fields in both create and edit modes
- [ ] Create mode: Role Name has `autoFocus`; Description is optional
- [ ] Edit mode: inputs pre-populate from `defaultValues`
- [ ] Form `id="role-form"` in both modes so external submit buttons wire via `form="role-form"`
- [ ] `externalFieldErrors.roleName` renders below Role Name when set, using danger color
- [ ] `isSubmitting=true` disables both inputs
- [ ] Empty-string `roleDescr` submits as `null`
- [ ] `RoleForm` has no action calls, router calls, or toast calls — pure form UI

### `CreateRoleDialog`

- [ ] Dialog opens when "Add Role" trigger is clicked
- [ ] "Add Role" button in `RoleTable` is no longer disabled; `CreateRoleDialog` is mounted when `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` is true
- [ ] "Add Role" trigger is absent when `hasLevel(...)` returns false
- [ ] Submit button wired via `form="role-form"`; calls `createRoleAction`
- [ ] "Cancel" closes the dialog without calling the action
- [ ] `onOpenChange` is suppressed while `isSubmitting` is true (backdrop/Escape blocked mid-flight)
- [ ] Dialog unmounts `RoleForm` on close (no `keepMounted`/`forceMount`); form state resets on next open
- [ ] `nameConflict` error is cleared at the start of each new submit attempt

### Repository

- [ ] `findRoleByName('ADMIN')` returns the ADMIN role row (case-insensitive match)
- [ ] `findRoleByName('nonexistent')` returns `null`
- [ ] `insertRole` inserts a row with the correct `role_name`, `role_descr`, `created_datetime`, `last_modified_datetime`; returned `roleId` is a valid UUID
- [ ] `updateRoleNameDescr` only updates `role_name`, `role_descr`, and `last_modified_datetime` — no other columns
- [ ] Both write functions accept a Drizzle transaction handle and do not open their own transactions
- [ ] No business logic or audit writes in any repository function

### Boundary and TypeScript

- [ ] `validation/roles.ts` imports only `zod` — no `next/*`, `db/**`, `services/**`, `auth/**`, or UI imports
- [ ] `services/roles/roles-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/roles/create-role.action.ts` and `update-role.action.ts` have no DB access
- [ ] `components/roles/role-form.tsx` has `'use client'`; no DB or service imports
- [ ] `components/roles/create-role-dialog.tsx` has `'use client'`; no DB or service imports
- [ ] `components/roles/role-detail.tsx` has `'use client'`; no DB or service imports
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] All `createRoleSchema` / `updateRoleSchema` unit tests pass (8 + 4 scenarios per §19.10)
- [ ] All `createRole` service unit tests pass (5 scenarios per §19.10)
- [ ] All `updateRole` service unit tests pass (8 scenarios per §19.10)
- [ ] All `createRoleAction` unit tests pass (5 scenarios per §19.10)
- [ ] All `updateRoleAction` unit tests pass (7 scenarios per §19.10)
- [ ] All `RoleForm` unit tests pass (9 scenarios per §19.10)
- [ ] All `CreateRoleDialog` unit tests pass (9 scenarios per §19.10)
- [ ] All `RoleDetail` edit mode unit tests pass (14 scenarios per §19.10)
- [ ] Integration tests pass: create happy path (DB assertions, audit), NAME_CONFLICT (create + case-insensitive), FORBIDDEN, no-change short-circuit
- [ ] Integration tests pass: update happy path, NAME_CONFLICT, ROLE_NOT_FOUND, FORBIDDEN, no-change
- [ ] Repository integration tests pass: `findRoleByName` (found, case-insensitive, null), `insertRole`, `updateRoleNameDescr`

### Scope guard

- [ ] No permission mapping create/edit/delete was added (that is um20)
- [ ] No role deletion was added (that is um21)
- [ ] The Permissions matrix in `RoleDetail` remains read-only in both view and edit mode
- [ ] No new `PERMISSIONS` migration rows added (`roles:EDIT` is already seeded)
- [ ] No schema migrations added (unique constraint on `role_name` already in place from um05)
- [ ] `RoleDetail` read-only rendering from um18 is unmodified except for the new `permissionMap` prop and edit mode additions
- [ ] `RolesPage` change is minimal: adds `permissionMap` prop to `<RoleDetail>`
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
