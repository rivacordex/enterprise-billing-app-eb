# Spec: um23 — System Config edit (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um22 (the `SYSTEM_CONFIG` Drizzle schema, `systemConfigRepository.findAllNonSecret()`, `SystemConfigDisplayRow` / `SystemConfigGroup` / `ConfigStatus` types, `ConfigTable`, `ConfigStatusBadge`, `EntraConfigRow`, `getSystemConfigParams()`, `groupConfigRows`, `formatRelativeTime`, and the `/administration/system-config` page); Unit um06 (`requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `EffectivePermissionMap`); Unit um03 (`writeAuditEvent` helper, `DrizzleTransaction` type from `db/types.ts`).
- **Source sections:** overview §"System configuration" (non-secret params; `is_secret` reserved, always FALSE in v1), §"Audit Events" (`SYSTEM_CONFIG_CHANGED`), §"Pages — Administration" item 3; architecture §2 (folder ownership, boundary rules), §5 (enforcement contract — Inv. #3, #11, #14, #16), §6 (`system_config:EDIT` required for mutations); code-standards §3.4 (Server Actions: parse → auth → service → typed result, `revalidatePath`), §4 (styling, CSS variable tokens), §7 (file organization), §8 (`system_config:EDIT` level), §9 (`ConfigEditor` in `actions/system-config/`). Invariants: **#3** (always server-side), **#11** (audit entry atomic with mutation), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#18** (secrets never in DB — `is_secret` is always FALSE in v1; the service hard-blocks updates to any row marked secret as defense in depth), **#20** (authz decisions never cached).

---

## Goal

Wire the `system_config:EDIT` action so an authenticated admin can update the `config_value` of any non-secret `SYSTEM_CONFIG` row via a `ConfigEditDialog` component; the update is written atomically with a `SYSTEM_CONFIG_CHANGED` `AUDIT_LOG` entry recording the actor, the before value, and the after value, and `modified_by` is set to the actor's `user_id`.

---

## Design

### Edit affordance in the table

The `ConfigTable` from um22 is a Server Component with four columns: Key | Value | Status | Last Modified. This unit adds a fifth column, **Actions**, that appears only when the caller passes `canEdit={true}`. The column header is an empty `<th>` (no label — the edit icon is self-evident); each data row in the Actions column contains a `ConfigEditDialog` component (a Client Component leaf that renders both the trigger icon button and the dialog).

The Actions column header cell uses the same `py-3 px-4` padding as the other header cells; it is right-aligned (`text-right`) and has the same `--surface-sunken` background and `--border-default` bottom border as the other header cells. Each Actions data cell is `py-2 px-4`, `text-right`.

`ConfigTable` passes `canEdit` through as a boolean prop. Group header rows (`<td colSpan={4}>` in um22) expand to `colSpan={5}` when `canEdit` is true.

RETIRED rows still show the edit button — an admin may need to correct a retired parameter's value before re-activating it (status lifecycle is reserved for a future unit; this unit does not add status editing).

The `is_secret = TRUE` guard applies only at the service layer (no secret rows are fetched by `findAllNonSecret()`, so no secret rows appear in the UI regardless).

### `ConfigEditDialog` design

A single `'use client'` component (`components/system-config/config-edit-dialog.tsx`) that owns both the trigger icon button and the shadcn `Dialog`. Using `Dialog` (not `AlertDialog`) because the edit is a form interaction, not a pure destructive confirmation.

**Trigger button**

A ghost icon button positioned in the Actions column: `Pencil` Lucide icon (size 14), `text-[--text-muted] hover:text-[--text-body]`, `rounded-[--radius-sm]`, `p-1`, `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[--ring]`. No label text — icon only with `aria-label="Edit configuration value"`.

**Dialog structure (open state)**

- `DialogTitle`: "Edit configuration"
- Read-only context block (two rows, `grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-4`):
  - Row 1: label "Group" in `text-[--text-muted]`; value `configGroup` in `font-mono text-[--text-body]`
  - Row 2: label "Key" in `text-[--text-muted]`; value `configKey` in `font-mono text-[--text-body]`
- `<label htmlFor="config-value">Value</label>` (`text-sm font-medium text-[--text-body] block mb-1`)
- shadcn `Textarea` (`id="config-value"`, `rows={4}`, `placeholder="Enter value…"`, `className="font-mono text-sm resize-y"`) — pre-populated with `initialValue ?? ''`. Font-mono because config values are often paths, names, or identifiers.
- Inline error `Alert` (danger variant: `bg-[--color-danger-50] border-[--color-danger-200] text-[--color-danger-700]`) rendered between the textarea and the footer only when an error code is returned. Messages:
  - `NOT_FOUND`: "Configuration parameter not found. It may have been modified by another admin."
  - `SECRET_ROW`: "This parameter is marked secret and cannot be edited here."
  - `FORBIDDEN`: "You don't have permission to edit configuration parameters."
  - `SERVER_ERROR`: "Something went wrong. Please try again."
- Footer buttons:
  - "Cancel" (`variant="outline"`; disabled while `isPending`; clears error state and closes dialog on click)
  - "Save changes" (`variant="default"` — primary brand; disabled while `isPending`; shows `Loader2` spinner (size 14, `animate-spin`, `mr-2`) when in-flight)

**On success:**

1. Dialog closes.
2. `toast.success('Configuration updated.')`.
3. The page re-renders automatically via Next.js revalidation triggered by `revalidatePath` inside the Server Action — no explicit `router.refresh()` call needed.

**Form state:** managed with React Hook Form + Zod resolver. The form schema covers only `configValue` (a string or null). The `configId` is a prop, not a form field, and is passed directly to the action at submit time.

**Validation (client-side, mirroring the server schema):** `z.string().max(2000).nullable()` — accepts a non-empty string up to 2000 characters or `null` (representing a cleared value). An empty string submitted from the textarea is coerced to `null` before the action call: `configValue: formValue.trim() === '' ? null : formValue.trim()`.

---

## Implementation

### 23.1 — Types additions (`types/system-config.ts`)

Extend the existing file from um22. Add:

```ts
export type UpdateConfigResult =
  | { ok: true }
  | {
      ok: false;
      code: "NOT_FOUND" | "SECRET_ROW" | "FORBIDDEN" | "SERVER_ERROR";
    };
```

Export `UpdateConfigResult` as a named export. No other changes to the file.

### 23.2 — Validation schema (`validation/system-config.ts`)

New file. No imports from `auth/**`, `db/**`, `services/**`, or `next/*`.

```ts
import { z } from "zod";

export const updateConfigValueSchema = z.object({
  configId: z.string().uuid(),
  configValue: z.string().max(2000).nullable(),
});

export type UpdateConfigInput = z.infer<typeof updateConfigValueSchema>;
```

This is the server-side schema. The client-side React Hook Form schema uses only the `configValue` field; the `configId` is passed separately at submission.

### 23.3 — Repository additions (`db/repositories/system-config.repository.ts`)

Extend the existing file from um22. Add two functions:

**`findById(configId: string, tx?: DrizzleTransaction): Promise<SystemConfigDisplayRow | null>`**

Same join shape as `findAllNonSecret()` from um22, but filtered to a single row:

```ts
const client = tx ?? db;
const result = await client
  .select({
    configId: systemConfig.configId,
    configGroup: systemConfig.configGroup,
    configVersion: systemConfig.configVersion,
    configKey: systemConfig.configKey,
    configValue: systemConfig.configValue,
    isSecret: systemConfig.isSecret,
    status: systemConfig.status,
    modifiedByUserId: systemConfig.modifiedBy,
    modifiedByName: appuser.userName,
    lastModifiedDatetime: systemConfig.lastModifiedDatetime,
  })
  .from(systemConfig)
  .leftJoin(appuser, eq(systemConfig.modifiedBy, appuser.userId))
  .where(eq(systemConfig.configId, configId))
  .limit(1);

return result[0] ?? null;
```

No `is_secret` filter — returns any row by ID. The service is responsible for blocking updates to secret rows.

**`updateValue(configId: string, configValue: string | null, modifiedBy: string, tx: DrizzleTransaction): Promise<void>`**

`tx` is required (non-optional) — this function is only ever called within a service transaction.

```ts
await tx
  .update(systemConfig)
  .set({
    configValue,
    modifiedBy: modifiedBy,
    lastModifiedDatetime: new Date(),
  })
  .where(eq(systemConfig.configId, configId));
```

Returns `void`. Does not write audit entries. Does not perform permission checks. `lastModifiedDatetime` is set to `new Date()` (server clock), not a DB-generated timestamp, to keep the value available for the `after_data` audit capture without a second query.

### 23.4 — Write service (`services/system-config/system-config-write.service.ts`)

New file. Framework-agnostic — no `next/*`, `app/**`, or `actions/**` imports.

**`updateConfigValue(input: { configId: string; configValue: string | null; actorUserId: string }): Promise<UpdateConfigResult>`**

```ts
export async function updateConfigValue(input: {
  configId: string;
  configValue: string | null;
  actorUserId: string;
}): Promise<UpdateConfigResult> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Fetch the current row
      const row = await systemConfigRepository.findById(input.configId, tx);
      if (!row) return { ok: false, code: "NOT_FOUND" };

      // 2. Defense-in-depth: block updates to secret rows (is_secret = TRUE)
      if (row.isSecret) return { ok: false, code: "SECRET_ROW" };

      // 3. Capture before_data
      const beforeData = {
        configGroup: row.configGroup,
        configKey: row.configKey,
        configValue: row.configValue,
        status: row.status,
        modifiedBy: row.modifiedByUserId ?? null,
      };

      // 4. Apply the update
      await systemConfigRepository.updateValue(
        input.configId,
        input.configValue,
        input.actorUserId,
        tx,
      );

      // 5. Capture after_data
      const afterData = {
        configGroup: row.configGroup,
        configKey: row.configKey,
        configValue: input.configValue,
        status: row.status,
        modifiedBy: input.actorUserId,
      };

      // 6. Write audit entry
      await writeAuditEvent(
        {
          eventType: "SYSTEM_CONFIG_CHANGED",
          actorUserId: input.actorUserId,
          targetEntity: "system_config",
          targetId: input.configId,
          beforeData,
          afterData,
        },
        tx,
      );

      return { ok: true };
    });
  } catch (err) {
    logger.error("updateConfigValue failed", { err });
    return { ok: false, code: "SERVER_ERROR" };
  }
}
```

The service never calls `requirePermission` — authorization is the action's responsibility. The service assumes an authorized context and receives a validated `actorUserId`.

### 23.5 — Server Action (`actions/system-config/update-config.action.ts`)

New file. `'use server'` at the top.

```ts
"use server";

import { revalidatePath } from "next/cache";
import { updateConfigValueSchema } from "@/validation/system-config";
import { requirePermission } from "@/auth";
import { PERMISSIONS, LEVELS } from "@/auth";
import { updateConfigValue } from "@/services/system-config/system-config-write.service";
import type { UpdateConfigResult } from "@/types/system-config";

export async function updateConfigAction(
  rawInput: unknown,
): Promise<UpdateConfigResult> {
  // 1. Parse
  const parsed = updateConfigValueSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "SERVER_ERROR" };

  // 2. Auth
  const authResult = await requirePermission(
    PERMISSIONS.SYSTEM_CONFIG,
    LEVELS.EDIT,
  );
  if (!authResult.ok) return { ok: false, code: "FORBIDDEN" };

  // 3. Service
  const result = await updateConfigValue({
    configId: parsed.data.configId,
    configValue: parsed.data.configValue,
    actorUserId: authResult.userId,
  });

  // 4. Revalidate on success
  if (result.ok) {
    revalidatePath("/administration/system-config");
  }

  return result;
}
```

`requirePermission` in an action context returns `{ ok: false }` (not a redirect) when the user lacks the required level — follow the pattern established in um19/um20/um21 for action-boundary auth failures. On unauthenticated, it redirects to `/login` (same as other units). No business logic in this file beyond parse → auth → service → revalidate.

The explicit return type `Promise<UpdateConfigResult>` is declared — the `FORBIDDEN` code is included in `UpdateConfigResult` (§23.1), so no additional wrapping type is needed.

### 23.6 — Components

#### 23.6.1 — `ConfigEditDialog` (`components/system-config/config-edit-dialog.tsx`)

Client Component (`'use client'`). This component owns both the trigger icon button and the `Dialog` — the RSC pattern of a self-contained interactive leaf that `ConfigTable` (Server Component) renders within each data row.

Props:

```ts
interface ConfigEditDialogProps {
  configId: string;
  configKey: string;
  configGroup: string;
  initialValue: string | null;
}
```

Internal state:

```ts
const [open, setOpen] = useState(false);
const [error, setError] = useState<string | null>(null);
const [isPending, startTransition] = useTransition();
```

React Hook Form setup:

```ts
const form = useForm<{ configValue: string }>({
  resolver: zodResolver(z.object({ configValue: z.string().max(2000) })),
  defaultValues: { configValue: initialValue ?? "" },
});
```

The form uses a plain `string` field; the `null` coercion happens at submit time (empty/whitespace-only → `null`).

**`handleSubmit`:**

```ts
async function onSubmit(values: { configValue: string }) {
  setError(null);
  const coerced =
    values.configValue.trim() === "" ? null : values.configValue.trim();
  startTransition(async () => {
    const result = await updateConfigAction({ configId, configValue: coerced });
    if (result.ok) {
      setOpen(false);
      toast.success("Configuration updated.");
    } else {
      switch (result.code) {
        case "NOT_FOUND":
          setError(
            "Configuration parameter not found. It may have been modified by another admin.",
          );
          break;
        case "SECRET_ROW":
          setError(
            "This parameter is marked secret and cannot be edited here.",
          );
          break;
        case "FORBIDDEN":
          setError(
            "You don't have permission to edit configuration parameters.",
          );
          break;
        default:
          setError("Something went wrong. Please try again.");
      }
    }
  });
}
```

**Dialog open/close:** When the dialog closes (Cancel or pressing Escape), `setError(null)` is called and the form is reset to `initialValue ?? ''` via `form.reset()`. This prevents stale error state when the dialog is reopened. Do not reset the form while `isPending` (prevent mid-flight resets).

```ts
function handleOpenChange(next: boolean) {
  if (isPending) return; // block close while in-flight
  if (!next) {
    setError(null);
    form.reset({ configValue: initialValue ?? "" });
  }
  setOpen(next);
}
```

**Render:**

```tsx
<>
  {/* Trigger */}
  <button
    type="button"
    onClick={() => setOpen(true)}
    aria-label="Edit configuration value"
    className="rounded-[--radius-sm] p-1 text-[--text-muted] hover:text-[--text-body] focus-visible:ring-2 focus-visible:ring-[--ring] focus-visible:outline-none"
  >
    <Pencil className="size-3.5" />
  </button>

  {/* Dialog */}
  <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>Edit configuration</DialogTitle>
      </DialogHeader>

      {/* Read-only context */}
      <div className="mb-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <span className="text-[--text-muted]">Group</span>
        <span className="font-mono text-[--text-body]">{configGroup}</span>
        <span className="text-[--text-muted]">Key</span>
        <span className="font-mono text-[--text-body]">{configKey}</span>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField
            control={form.control}
            name="configValue"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Value</FormLabel>
                <FormControl>
                  <Textarea
                    {...field}
                    id="config-value"
                    rows={4}
                    placeholder="Enter value…"
                    className="resize-y font-mono text-sm"
                    disabled={isPending}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {error && (
            <div
              role="alert"
              className="rounded-[--radius-md] border border-[--color-danger-200] bg-[--color-danger-50] px-4 py-3 text-sm text-[--color-danger-700]"
            >
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isPending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending && <Loader2 className="mr-2 size-3.5 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </Form>
    </DialogContent>
  </Dialog>
</>
```

Imports: `updateConfigAction` from `actions/system-config/update-config.action.ts`; `useTransition`, `useState` from `react`; shadcn `Dialog*`, `Button`, `Form*`, `Textarea`; `Pencil`, `Loader2` from `lucide-react`; `useForm` from `react-hook-form`; `zodResolver` from `@hookform/resolvers/zod`; `z` from `zod`; `toast` from the toast library already established in prior units. No imports from `db/**` or `services/**`.

#### 23.6.2 — `ConfigTable` modifications (`components/system-config/config-table.tsx`)

Extend the existing Server Component from um22. Three changes only:

**1. Add `canEdit` prop:**

```ts
interface ConfigTableProps {
  groups: SystemConfigGroup[];
  canEdit: boolean; // NEW
}
```

**2. Expand group header `colSpan`:**

```tsx
<td colSpan={canEdit ? 5 : 4}>…</td>
```

**3. Add Actions column header and per-row `ConfigEditDialog`:**

In the `<thead>` row, append after Last Modified:

```tsx
{
  canEdit && (
    <th className="w-12 border-b border-[--border-default] bg-[--surface-sunken] px-4 py-3 text-right" />
  );
}
```

In each data `<tr>`, append after Last Modified:

```tsx
{
  canEdit && (
    <td className="px-4 py-2 text-right">
      <ConfigEditDialog
        configId={row.configId}
        configKey={row.configKey}
        configGroup={row.configGroup}
        initialValue={row.configValue}
      />
    </td>
  );
}
```

No other changes to `ConfigTable`. The component remains a Server Component — `ConfigEditDialog` is a Client Component leaf inserted into the RSC tree.

Import `ConfigEditDialog` from `components/system-config/config-edit-dialog.tsx`.

### 23.7 — Page update (`app/(admin)/administration/system-config/page.tsx`)

Two targeted changes to the existing page from um22:

**1. Derive `canEdit` from the already-resolved `permissionMap`:**

```ts
// permissionMap is already returned by requirePermission — no additional fetch
const canEdit = hasLevel(permissionMap, PERMISSIONS.SYSTEM_CONFIG, LEVELS.EDIT);
```

**2. Pass `canEdit` to `ConfigTable`:**

```tsx
<ConfigTable groups={groups} canEdit={canEdit} />
```

No other changes. `metadata`, `dynamic`, `requirePermission` call, `getSystemConfigParams`, `groupConfigRows`, and the Entra section are all unchanged.

---

## Testing

### 23.8.1 — Unit tests: validation schema (`tests/unit/validation/system-config.test.ts`)

New file.

| Scenario                  | Input                                            | Expected                                                                |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Valid UUID + string value | `{ configId: valid-uuid, configValue: 'hello' }` | Parses successfully                                                     |
| Valid UUID + null value   | `{ configId: valid-uuid, configValue: null }`    | Parses successfully                                                     |
| Invalid UUID              | `{ configId: 'not-a-uuid', configValue: 'x' }`   | Parse fails                                                             |
| Value exceeds 2000 chars  | String of 2001 chars                             | Parse fails                                                             |
| Value exactly 2000 chars  | String of 2000 chars                             | Parses successfully                                                     |
| Missing configId          | `{ configValue: 'x' }`                           | Parse fails                                                             |
| Extra fields              | Additional keys on the object                    | Drizzle-stripped (zod default) or accepted — verify consistent behavior |

### 23.8.2 — Unit tests: repository additions (`tests/unit/db/system-config.repository.test.ts`)

Extend the existing file from um22. Add scenarios:

| Scenario                             | Setup                                         | Expected                                                                                       |
| ------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `findById` — found, no modifier      | Row with `modified_by = NULL`                 | Returns `SystemConfigDisplayRow` with `modifiedByName = null`                                  |
| `findById` — found, with modifier    | Row with `modified_by` set to admin UUID      | `modifiedByName` = admin's `userName`                                                          |
| `findById` — not found               | Non-existent UUID                             | Returns `null`                                                                                 |
| `findById` — secret row              | Row with `is_secret = TRUE`                   | Returns the row (no filter; the service is responsible for the block)                          |
| `updateValue` — updates three fields | Call with `configId`, new value, `modifiedBy` | Drizzle `.set()` called with `{ configValue, modifiedBy, lastModifiedDatetime }` matching args |
| `updateValue` — null value           | `configValue = null`                          | `config_value` is `null` in the `.set()` call                                                  |
| `updateValue` — uses provided tx     | Pass a mock transaction                       | The mock transaction's `.update()` is called (not the module-level `db`)                       |

### 23.8.3 — Unit tests: write service (`tests/unit/services/system-config-write.service.test.ts`)

New file. Mock `systemConfigRepository`, `writeAuditEvent`, and `db.transaction` (synchronous pass-through).

| Scenario                                     | Setup                                                                  | Expected                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Row not found                                | `findById` returns `null`                                              | `{ ok: false, code: 'NOT_FOUND' }`                                                           |
| Row is secret                                | `findById` returns row with `isSecret: true`                           | `{ ok: false, code: 'SECRET_ROW' }`                                                          |
| Successful update — string value             | `findById` returns non-secret row; `updateValue` resolves              | `{ ok: true }`; `updateValue` called with `(configId, 'new-value', actorUserId, tx)`         |
| Successful update — null value               | `configValue = null` passed                                            | `{ ok: true }`; `updateValue` called with null                                               |
| `before_data` captures original value        | `findById` returns row with `configValue: 'old'`; new value is `'new'` | `writeAuditEvent` receives `beforeData.configValue = 'old'`; `afterData.configValue = 'new'` |
| `after_data` sets `modifiedBy` to actor      | —                                                                      | `afterData.modifiedBy = actorUserId`                                                         |
| `before_data` captures original `modifiedBy` | `findById` returns row with `modifiedByUserId: 'prev-actor-id'`        | `beforeData.modifiedBy = 'prev-actor-id'`                                                    |
| Audit event type                             | Successful path                                                        | `writeAuditEvent` called with `eventType: 'SYSTEM_CONFIG_CHANGED'`                           |
| `targetEntity` and `targetId`                | Successful path                                                        | `targetEntity: 'system_config'`; `targetId: configId`                                        |
| All operations in one transaction            | Successful path                                                        | `findById`, `updateValue`, `writeAuditEvent` all receive the same `tx` reference             |
| Repository throws                            | `updateValue` throws `Error('db failure')`                             | `{ ok: false, code: 'SERVER_ERROR' }`                                                        |

### 23.8.4 — Unit tests: Server Action (`tests/unit/actions/update-config.action.test.ts`)

New file. Mock `updateConfigValueSchema`, `requirePermission`, `updateConfigValue`, `revalidatePath`.

| Scenario                               | Setup                                                                   | Expected                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Invalid input (malformed UUID)         | `rawInput = { configId: 'bad', configValue: 'x' }`                      | `{ ok: false, code: 'SERVER_ERROR' }` returned; service not called       |
| Insufficient permission                | `requirePermission` returns `{ ok: false }`                             | `{ ok: false, code: 'FORBIDDEN' }`; service not called                   |
| Service returns `NOT_FOUND`            | Valid input, authed; service returns `{ ok: false, code: 'NOT_FOUND' }` | `{ ok: false, code: 'NOT_FOUND' }`; `revalidatePath` not called          |
| Service returns `SERVER_ERROR`         | —                                                                       | `{ ok: false, code: 'SERVER_ERROR' }`; `revalidatePath` not called       |
| Successful update                      | Valid input; authed; service returns `{ ok: true }`                     | `{ ok: true }`; `revalidatePath('/administration/system-config')` called |
| Action passes `actorUserId` to service | `requirePermission` returns `{ ok: true, userId: 'actor-id' }`          | Service called with `actorUserId: 'actor-id'`                            |

### 23.8.5 — Unit tests: `ConfigEditDialog` (`tests/unit/components/system-config/config-edit-dialog.test.tsx`)

New file. Mock `updateConfigAction`, React Hook Form (or use testing-library with real form), `toast`.

| Scenario                              | Expected                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Renders trigger `Pencil` button       | `aria-label="Edit configuration value"` present; button is in document                                     |
| Click trigger → dialog opens          | `Dialog` renders with title "Edit configuration"                                                           |
| Context read-only block               | `configGroup` and `configKey` visible in dialog                                                            |
| Textarea pre-populated                | `initialValue` appears in the textarea                                                                     |
| `initialValue = null`                 | Textarea is empty string                                                                                   |
| Submit calls action with correct args | `updateConfigAction({ configId, configValue: 'new-value' })` called                                        |
| Whitespace-only textarea value        | `configValue: null` passed to action (coercion)                                                            |
| Empty textarea                        | `configValue: null` passed to action                                                                       |
| Success path                          | Dialog closes; `toast.success('Configuration updated.')` called                                            |
| `NOT_FOUND` error                     | Inline error message rendered; dialog remains open                                                         |
| `SECRET_ROW` error                    | Inline error message rendered; dialog remains open                                                         |
| `FORBIDDEN` error                     | Inline permission error message rendered; dialog remains open                                              |
| `SERVER_ERROR` error                  | Generic error message rendered; dialog remains open                                                        |
| While `isPending`                     | Submit button disabled with spinner; Cancel disabled; dialog cannot be closed (Escape/open change blocked) |
| Cancel clicked                        | Dialog closes; form resets to `initialValue`; error cleared                                                |
| Error clears on re-open               | Set error state; close dialog; reopen — no error shown                                                     |

### 23.8.6 — Unit tests: `ConfigTable` modifications (`tests/unit/components/system-config/config-table.test.tsx`)

Extend the existing file from um22. Add scenarios:

| Scenario                     | Expected                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `canEdit=false`              | No Actions column `<th>` or `<td>` in DOM; group header `colSpan` is `4`                                  |
| `canEdit=true`               | Actions column `<th>` present (empty label); `colSpan` on group header is `5`                             |
| `canEdit=true`, one row      | One `ConfigEditDialog` rendered with correct `configId`, `configKey`, `configGroup`, `initialValue` props |
| `canEdit=true`, RETIRED row  | `ConfigEditDialog` still rendered (not hidden for RETIRED)                                                |
| `canEdit=true`, empty groups | Empty-state renders; no Actions column (no table rendered)                                                |

### 23.8.7 — Unit tests: page (`tests/unit/app/system-config.page.test.tsx`)

Extend the existing file from um22. Add scenarios:

| Scenario                                                  | Expected                                 |
| --------------------------------------------------------- | ---------------------------------------- |
| `permissionMap` has `system_config:EDIT`                  | `ConfigTable` receives `canEdit={true}`  |
| `permissionMap` has only `system_config:READ`             | `ConfigTable` receives `canEdit={false}` |
| `permissionMap` has `system_config:DELETE` (implies EDIT) | `ConfigTable` receives `canEdit={true}`  |

### 23.8.8 — Integration tests: write service (`tests/integration/services/system-config-write.service.test.ts`)

New file. Uses the test DB with the um22 migration applied (seeded `app_name` row). Resets between tests.

| Scenario                                                                | Expected                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Update `app_name` value                                                 | `config_value` in DB equals new value; `modified_by` equals actor's `user_id`; `last_modified_datetime` is within 2 seconds of now                             |
| Before/after in audit log                                               | `AUDIT_LOG` contains one `SYSTEM_CONFIG_CHANGED` row; `before_data.configValue = 'Enterprise Billing System'`; `after_data.configValue = 'Billing Portal'`     |
| Actor recorded in audit                                                 | `actor_user_id = actorUserId` in the `AUDIT_LOG` row                                                                                                           |
| Update with `configValue = null`                                        | `config_value` is `NULL` in DB; `after_data.configValue = null` in audit                                                                                       |
| Update non-existent `configId`                                          | Returns `{ ok: false, code: 'NOT_FOUND' }`; no audit row written                                                                                               |
| Update secret row (manually inserted with `is_secret=TRUE`)             | Returns `{ ok: false, code: 'SECRET_ROW' }`; `config_value` unchanged; no audit row written                                                                    |
| Transaction rollback on audit write failure (mock audit INSERT to fail) | `config_value` unchanged in DB (mutation rolled back with the audit failure)                                                                                   |
| `modified_by` set correctly on second update                            | After two updates by different actors, `modified_by` reflects the second actor; `before_data` in the second audit row reflects the first actor's `modified_by` |

### 23.8.9 — Integration tests: action guard (`tests/integration/app/system-config-guard.test.ts`)

Extend the existing guard test file (or create if um22 did not create it).

| Session                                                   | Expected                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `admin_user` (has `system_config:EDIT` via DELETE ⊃ EDIT) | `updateConfigAction` proceeds to service; returns service result |
| `no_grants_user`                                          | Returns `{ ok: false, code: 'FORBIDDEN' }`                       |
| No session / unauthenticated                              | Redirects to `/login` (via `requirePermission`)                  |

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `drizzle-orm` — `eq`, `update()`, `.set()`, `.limit()`, transactions — for repository additions.
- `next` — `revalidatePath` in the Server Action.
- `react` — `useState`, `useTransition` in `ConfigEditDialog`.
- `react-hook-form` — form state management in `ConfigEditDialog`.
- `@hookform/resolvers/zod` — Zod resolver for React Hook Form.
- `zod` — `updateConfigValueSchema` in `validation/system-config.ts`.
- `lucide-react` — `Pencil` (edit trigger icon), `Loader2` (spinner) — already installed.
- shadcn `Dialog*`, `Button`, `Form*`, `Textarea` — already installed.
- Toast library (already established in prior units).
- `vitest`, `@testing-library/react` — already installed.

No new schema migrations. No new `PERMISSIONS` rows (the `system_config` permission row was seeded in um05). No new `ROLES` seed rows.

---

## Verification Checklist

### Types

- [ ] `UpdateConfigResult` exported from `types/system-config.ts` with codes `'NOT_FOUND' | 'SECRET_ROW' | 'FORBIDDEN' | 'SERVER_ERROR'`
- [ ] `types/system-config.ts` has no new imports from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] Existing `ConfigStatus`, `SystemConfigDisplayRow`, `SystemConfigGroup` types from um22 are unmodified

### Validation schema

- [ ] `validation/system-config.ts` is a new file
- [ ] `updateConfigValueSchema` accepts a valid UUID `configId` and a `string | null` `configValue`
- [ ] `configValue` is constrained to `max(2000)` and accepts `null`
- [ ] Invalid UUID fails parsing
- [ ] Value exceeding 2000 characters fails parsing
- [ ] `UpdateConfigInput` type is exported
- [ ] No imports from `auth/**`, `db/**`, `services/**`, or `next/*`

### Repository additions

- [ ] `systemConfigRepository.findById(configId, tx?)` is implemented
- [ ] `findById` left-joins `appuser` to resolve `modifiedByName` (same join as `findAllNonSecret`)
- [ ] `findById` returns `null` for non-existent `configId` (not `undefined`, not a throw)
- [ ] `findById` does NOT filter by `is_secret` — it returns any row by ID
- [ ] `systemConfigRepository.updateValue(configId, configValue, modifiedBy, tx)` is implemented (tx is non-optional)
- [ ] `updateValue` sets `config_value`, `modified_by`, `last_modified_datetime`; no other columns modified
- [ ] `updateValue` uses the provided `tx` (not the module-level `db` client)
- [ ] `updateValue` accepts `configValue = null` without type error
- [ ] No repository function imports from `auth/**`, `services/**`, `app/**`, or `actions/**`
- [ ] Existing `findAllNonSecret()` from um22 is unmodified

### Write service

- [ ] `services/system-config/system-config-write.service.ts` is a new file
- [ ] `updateConfigValue` has an explicit return type of `Promise<UpdateConfigResult>`
- [ ] Row not found → `{ ok: false, code: 'NOT_FOUND' }`; no DB writes executed
- [ ] Secret row (`isSecret = true`) → `{ ok: false, code: 'SECRET_ROW' }`; no DB writes executed
- [ ] All operations (`findById`, `updateValue`, `writeAuditEvent`) run within a single `db.transaction()`
- [ ] `before_data` contains `configGroup`, `configKey`, `configValue` (original), `status`, `modifiedBy` (original actor or null)
- [ ] `after_data` contains `configGroup`, `configKey`, `configValue` (new), `status`, `modifiedBy` (actorUserId)
- [ ] `writeAuditEvent` receives `eventType: 'SYSTEM_CONFIG_CHANGED'`, `targetEntity: 'system_config'`, `targetId: configId`
- [ ] Entire function body wrapped in `try/catch`; any thrown error → `{ ok: false, code: 'SERVER_ERROR' }`
- [ ] Service has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] Service does not call `requirePermission`

### Server Action

- [ ] `'use server'` directive at the top of `actions/system-config/update-config.action.ts`
- [ ] `updateConfigValueSchema.safeParse(rawInput)` called before any auth check
- [ ] Parse failure → `{ ok: false, code: 'SERVER_ERROR' }` returned; service not called
- [ ] `requirePermission(PERMISSIONS.SYSTEM_CONFIG, LEVELS.EDIT)` called; insufficient level → `{ ok: false, code: 'FORBIDDEN' }`
- [ ] `PERMISSIONS.SYSTEM_CONFIG` and `LEVELS.EDIT` constants used (not raw strings)
- [ ] `revalidatePath('/administration/system-config')` called only when `result.ok === true`
- [ ] `actorUserId` sourced from `requirePermission` return value (not from input)
- [ ] No business logic beyond parse → auth → service → revalidate
- [ ] Explicit return type `Promise<UpdateConfigResult>` declared

### `ConfigEditDialog` component

- [ ] File is `'use client'` at the top
- [ ] Trigger is a `<button>` with `aria-label="Edit configuration value"` and `Pencil` icon (size 14)
- [ ] Trigger click opens the `Dialog`
- [ ] `DialogTitle` is "Edit configuration"
- [ ] Read-only context block displays `configGroup` and `configKey`
- [ ] Textarea pre-populated with `initialValue ?? ''`
- [ ] Textarea has `id="config-value"`, `rows={4}`, `font-mono` class, `resize-y`
- [ ] Empty/whitespace-only textarea value is coerced to `null` before action call
- [ ] Submit calls `updateConfigAction({ configId, configValue: <coerced> })`
- [ ] `isPending` via `useTransition`: submit button disabled with `Loader2` spinner; Cancel disabled; `handleOpenChange` blocks close
- [ ] Cancel closes dialog, resets form to `initialValue ?? ''`, clears error
- [ ] Success: dialog closes, `toast.success('Configuration updated.')` called
- [ ] `NOT_FOUND`, `SECRET_ROW`, `FORBIDDEN`, `SERVER_ERROR` each render distinct inline error text; dialog remains open
- [ ] Error clears when dialog is closed (via `handleOpenChange`)
- [ ] No imports from `db/**` or `services/**`
- [ ] No hardcoded hex values — CSS variable tokens only

### `ConfigTable` modifications

- [ ] `ConfigTableProps` now includes `canEdit: boolean`
- [ ] `canEdit=false`: no Actions `<th>` or `<td>` rendered; group header `colSpan={4}`
- [ ] `canEdit=true`: Actions `<th>` (empty, right-aligned, `w-12`) appears; group header `colSpan={5}`
- [ ] `canEdit=true`: each non-secret data row contains a `ConfigEditDialog` with correct props
- [ ] RETIRED rows show `ConfigEditDialog` (not hidden)
- [ ] `ConfigTable` remains a Server Component (no `'use client'` directive added)
- [ ] `ConfigEditDialog` import added; no other new imports
- [ ] All um22 rendering behavior (empty state, group headers, status badge, truncation, RETIRED opacity) is unmodified

### Page modifications

- [ ] `canEdit = hasLevel(permissionMap, PERMISSIONS.SYSTEM_CONFIG, LEVELS.EDIT)` is derived from the already-resolved `permissionMap`
- [ ] `<ConfigTable groups={groups} canEdit={canEdit} />` — `canEdit` prop is passed
- [ ] `permissionMap` is NOT re-fetched — it comes from the single `requirePermission` call
- [ ] No other changes to the page: `metadata`, `dynamic`, `requirePermission`, `getSystemConfigParams`, `groupConfigRows`, Entra section are all unchanged

### Audit

- [ ] `event_type` is `'SYSTEM_CONFIG_CHANGED'` (not any other string)
- [ ] `target_entity` is `'system_config'`; `target_id` is the row's `configId`
- [ ] `before_data.configValue` contains the value before the update
- [ ] `after_data.configValue` contains the new value (including `null` if cleared)
- [ ] `after_data.modifiedBy` equals `actorUserId`
- [ ] `actor_user_id` equals `actorUserId` in the `AUDIT_LOG` row
- [ ] Audit entry is written atomically in the same transaction as the `updateValue` call
- [ ] No audit entry is written for `NOT_FOUND`, `SECRET_ROW`, or `SERVER_ERROR` outcomes (transaction rolls back or is not reached)

### Defense-in-depth: secret row guard

- [ ] `updateConfigValue` service returns `{ ok: false, code: 'SECRET_ROW' }` for any row with `isSecret = true`
- [ ] `updateValue` repository function is NOT called when `SECRET_ROW` is returned
- [ ] Integration test: manually inserted secret row cannot be updated via `updateConfigValue`
- [ ] `findAllNonSecret()` (um22) means secret rows never appear in the UI; `findById` returning them does not create a UI exposure because the trigger button only appears for rendered rows

### Tests

- [ ] All validation schema unit tests pass (7 scenarios per §23.8.1)
- [ ] All repository unit tests pass (7 scenarios per §23.8.2)
- [ ] All write service unit tests pass (12 scenarios per §23.8.3)
- [ ] All Server Action unit tests pass (6 scenarios per §23.8.4)
- [ ] All `ConfigEditDialog` unit tests pass (15 scenarios per §23.8.5)
- [ ] All `ConfigTable` modification unit tests pass (5 scenarios per §23.8.6)
- [ ] All page modification unit tests pass (3 scenarios per §23.8.7)
- [ ] All write service integration tests pass (8 scenarios per §23.8.8)
- [ ] All action guard integration tests pass (3 scenarios per §23.8.9)
- [ ] `vitest run` passes with no failures across all new and modified test files

### Boundary enforcement

- [ ] `validation/system-config.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `services/system-config/system-config-write.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `components/system-config/config-edit-dialog.tsx` has no imports from `db/**` or `services/**`
- [ ] `actions/system-config/update-config.action.ts` has no direct DB queries or business logic
- [ ] `app/(admin)/administration/system-config/page.tsx` does not import from `db/**` directly
- [ ] No `console.*` in any new or modified file — diagnostics via `lib/logger`
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] ESLint clean including import-boundary rules

### Scope guard

- [ ] No new `PERMISSIONS` migration rows added — `system_config` was seeded in um05
- [ ] No schema migrations added — `SYSTEM_CONFIG` table was created in um22
- [ ] `config_key`, `config_group`, `config_version`, `status`, and `is_secret` are not editable via this unit
- [ ] The Entra ID Settings section (read-only, env-sourced) is unmodified
- [ ] `EntraConfigRow`, `ConfigStatusBadge`, `getSystemConfigParams`, `groupConfigRows`, `formatRelativeTime` from um22 are unmodified
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
