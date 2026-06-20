# Spec: um20 — Map role → permission levels (EDIT)

- **Boundary:** APP
- **Dependencies:** Unit um18 (`RoleDetail`, `RoleTable`, `PermissionLevelTag`, `RoleWithMappings`, `RolePermissionMapping`, `PERMISSION_DISPLAY_NAMES`, `types/roles.ts`, `rolePermissionAssignRepository.findMappingsForRole`, `rolesRepository.findById`, `roles-read.service.ts`); Unit um19 (`roles-write.service.ts`, `validation/roles.ts`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `EffectivePermissionMap`, `requirePermission`); Unit um05 (RBAC schema — `core.role_permission_assign`; `types/rbac.ts` — `PERMISSION_NAMES`, `PermissionType`; repository stubs for all four RBAC tables); Unit um03 (`writeAuditEvent` helper).
- **Source sections:** overview §"Roles & permissions" (map role → registry entries at READ/EDIT/DELETE; DELETE ⊃ EDIT ⊃ READ; `audit_log` is READ-max), §"Audit Events" (`PERMISSION_MAPPING_CHANGED`), §"Pages — Administration" item 2, §"Roles & Default Permission Seed"; architecture §2 (folder ownership, boundary rules), §5 (RBAC mechanics — one level per role+permission pair, effective permission = union across roles highest wins, computed per request; Inv. #2 — no authz state in session), §6 (`roles:EDIT` required); code-standards §3 (Server Actions: parse → auth → service → typed result, `revalidatePath`), §4 (styling — `cva`, CSS variables, no raw hex), §7 (file organization); ui-context §3.6 (`PermissionLevelTag` tokens — READ/EDIT/DELETE ramp; `audit_log` EDIT/DELETE cells disabled in matrix), §6 (radius). Invariants: **#2** (no authz state in session — permission changes take effect on next request automatically), **#3** (always server-side), **#4** (deny by default), **#11** (audit entry atomic with mutation), **#14** (DB access only in `db/**`), **#16** (all external input validated via Zod at action boundary), **#20** (authz decisions never cached).

---

## Goal

Add `roles:EDIT`-gated permission mapping to the Roles page: a `PermissionMatrixEditor` renders an inline interactive matrix in the `RoleDetail` panel where each permission-row level change immediately persists via `setPermissionMappingAction` and writes a `PERMISSION_MAPPING_CHANGED` audit entry; `audit_log` EDIT/DELETE options are rendered disabled (READ-max enforced in both the UI and the service), and the effective permission of any affected user is updated on their next request with no session action required.

---

## Design

### PermissionMatrixEditor placement

`PermissionMatrixEditor` replaces the read-only permission matrix in `RoleDetail` when the requesting user has `roles:EDIT`. It is always visible regardless of whether the panel is in view mode or edit mode (the name/description edit mode introduced in um19 is independent). When the user only has `roles:READ`, the read-only matrix from um18 continues to render. The two renderings are mutually exclusive — never both mounted simultaneously.

This "always editable" model (rather than gating behind the edit-mode toggle) is deliberate: permission level changes are atomic, per-cell operations that save immediately. There is nothing to "cancel" — each click either commits or reverts. Tying them to the name/description Save/Cancel cycle would couple two unrelated operations and leave permission changes in an ambiguous "unsaved" state.

### Permission matrix table structure

Same `<table>` structure as the read-only matrix from um18 (4 rows, one per permission in `PERMISSION_NAMES` order: `users` → `roles` → `system_config` → `audit_log`), but the "Assigned Level" column is replaced by a **level button group**. Column headers: `Permission` | `Level` (`--text-overline`). The row order is fixed and matches `PERMISSION_NAMES` regardless of DB row order.

### Level button group (per row)

Each row has four inline `<button>` elements: `—` (no access / null) | `READ` | `EDIT` | `DELETE`.

Visual states:

| State                              | Background                                                                                           | Text                            | Border                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------- |
| Selected `—`                       | `--color-neutral-100`                                                                                | `--color-neutral-700`           | none                             |
| Selected `READ`                    | `--color-info-50` `#E7F1FD`                                                                          | `--color-info-700` `#0C4084`    | none                             |
| Selected `EDIT`                    | `--color-warning-50` `#FEF4E6`                                                                       | `--color-warning-700` `#8A5200` | none                             |
| Selected `DELETE`                  | `--color-danger-50` `#FDEAEA`                                                                        | `--color-danger-700` `#8A1717`  | none                             |
| Unselected (any)                   | transparent                                                                                          | `--text-muted`                  | `1px solid var(--border-subtle)` |
| Disabled (`audit_log` EDIT/DELETE) | `--surface-sunken`                                                                                   | `--text-disabled`               | `1px solid var(--border-subtle)` |
| Row loading                        | as above but all 4 buttons have `disabled` attribute; active button shows `Loader2` (size 12) inline |

All four buttons share: `--radius-xs` (2px), `--text-overline` sizing (11px, semibold, uppercase), `px-2 py-1`, `inline-flex items-center gap-1`. The group itself is `inline-flex gap-1` with `role="group"` and `aria-label="Permission level for {PERMISSION_DISPLAY_NAMES[name]}"`. Each button has `type="button"` and `aria-pressed={isSelected}`.

Color tokens use CSS variable references only — no raw hex in the component.

### `audit_log` READ-max treatment

The `audit_log` row enforces READ-max at three layers (defense in depth):

1. **UI:** EDIT and DELETE buttons have the `disabled` attribute and `cursor-not-allowed`. They carry `title="Audit log permissions are read-only"` for browser tooltip disclosure. The `—` and `READ` buttons are fully enabled.
2. **Server Action:** the action passes through a service guard; attempting EDIT or DELETE for `audit_log` is rejected before any DB access.
3. **Service guard:** the first step in `setRolePermissionLevel` checks `permissionName === 'audit_log' && (level === 'EDIT' || level === 'DELETE')` and short-circuits with `{ ok: false, code: 'AUDIT_LOG_READONLY' }`.

The admin may set `audit_log` to READ (adding or keeping the mapping) or to `—` (removing the mapping). Both are permitted.

### Per-change save behavior

Each level change triggers `setPermissionMappingAction` immediately on click. The flow:

1. User clicks a level button that is not the current level.
2. Optimistic update: the visual switches to the new level instantly via `useOptimistic`.
3. The clicked row's button group becomes disabled (prevents concurrent saves on the same row).
4. `setPermissionMappingAction` is called.
   5a. **Success:** loading state clears; the optimistic value is confirmed by the revalidated RSC re-render. No success toast — the visual already reflects the change and the action was deliberate.
   5b. **Failure:** optimistic value reverts; loading state clears; `toast.error('Failed to update permission. Please try again.')` is shown.

Concurrent saves on different rows are allowed (each row manages its own loading state independently). Concurrent saves on the same row are prevented by disabling that row's buttons while a save is in flight.

### Effect on active users

When a role's permission level changes, any user holding that role will see the new effective permission on their next request. This is the existing architectural behavior (Invariant #2 — authz state is never stored in the session; permissions are resolved from Postgres per request). No session revocation or cache invalidation is required — the `revalidatePath` in the action handles the admin's own view; everyone else's next request picks up the new mapping live.

---

## Implementation

### 20.1 — Validation schema (`validation/roles.ts` extension)

Add to the existing `validation/roles.ts` from um19. No new file.

```ts
export const setPermissionLevelSchema = z.object({
  roleId: z.string().uuid("Invalid role ID"),
  permissionName: z.enum(PERMISSION_NAMES),
  level: z.enum(PERMISSION_TYPES).nullable(),
});

export type SetPermissionLevelInput = z.infer<typeof setPermissionLevelSchema>;
```

`PERMISSION_NAMES` and `PERMISSION_TYPES` are imported from `types/rbac.ts` (defined in um05). `level: null` represents "no access" — removing the `role_permission_assign` row for this role+permission pair. Export `SetPermissionLevelInput` as a named export alongside the existing schemas.

This schema is the single source of truth for both the Server Action (server-side parse) and any future client-side use. No `audit_log`-specific logic in the schema — the READ-max guard lives in the service layer.

### 20.2 — Repository implementations

#### 20.2.1 — `permissionsRepository` (`db/repositories/permissions.repository.ts`)

Implement the stub from um05. Add one function:

**`findByName(name: PermissionName): Promise<Permission | null>`**

```sql
SELECT * FROM core.permissions WHERE permission_name = $name LIMIT 1
```

Use Drizzle's `eq` operator. Returns the full `Permission` row or `null`. This function exists so the write service can resolve a `permission_name` to a `permission_id` without embedding raw SQL in the service layer. No business logic; no audit writes; no imports from `auth/`, `services/`, `app/`, or `next/*`.

#### 20.2.2 — `rolePermissionAssignRepository` extensions (`db/repositories/role-permission-assign.repository.ts`)

Extend the existing file (which has `findGrantsByRoleIds` from um06 and `findMappingsForRole` from um18). Add two write functions:

**`upsertRolePermission(tx: DrizzleTransaction, data: { roleId: string; permissionId: string; permissionType: PermissionType }): Promise<void>`**

Uses Drizzle's `insert().onConflictDoUpdate()` targeting the named unique constraint `role_permission_assign_role_permission_unique` on `(ref_role_id, ref_permission_id)`:

```ts
await tx
  .insert(rolePermissionAssign)
  .values({
    rolePermissionId: crypto.randomUUID(),
    refRoleId: data.roleId,
    refPermissionId: data.permissionId,
    permissionType: data.permissionType,
    createdDatetime: new Date(),
    lastModifiedDatetime: new Date(),
  })
  .onConflictDoUpdate({
    target: [
      rolePermissionAssign.refRoleId,
      rolePermissionAssign.refPermissionId,
    ],
    set: {
      permissionType: data.permissionType,
      lastModifiedDatetime: new Date(),
    },
  });
```

Does not return the row. After two calls with the same `roleId`+`permissionId`, exactly one row exists with the most recent `permissionType`.

**`deleteRolePermission(tx: DrizzleTransaction, data: { roleId: string; permissionId: string }): Promise<void>`**

```ts
await tx
  .delete(rolePermissionAssign)
  .where(
    and(
      eq(rolePermissionAssign.refRoleId, data.roleId),
      eq(rolePermissionAssign.refPermissionId, data.permissionId),
    ),
  );
```

Idempotent — deleting a non-existent row completes without error (Drizzle does not throw on zero rows deleted).

Both functions accept a Drizzle transaction handle; they do not open their own transactions. No business logic; no audit writes.

### 20.3 — Service extension (`services/roles/roles-write.service.ts`)

Add `setRolePermissionLevel` to the existing file from um19. No new file.

**`setRolePermissionLevel(input: SetPermissionLevelInput, actorId: string): Promise<SetPermissionLevelResult>`**

```ts
type SetPermissionLevelResult =
  | { ok: true }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "AUDIT_LOG_READONLY" }
  | { ok: false; code: "PERMISSION_NOT_FOUND" };
```

Steps:

**Step 1 — `audit_log` READ-max guard.**

```ts
if (
  input.permissionName === "audit_log" &&
  (input.level === "EDIT" || input.level === "DELETE")
) {
  return { ok: false, code: "AUDIT_LOG_READONLY" };
}
```

This is the first check — before any DB reads. The `audit_log` permission has no EDIT/DELETE level in the system (overview §"Roles & Default Permission Seed"). Reject unconditionally regardless of actor.

**Step 2 — Load role (for snapshot and existence check).**

`const role = await rolesRepository.findById(input.roleId)`. If `null` → return `{ ok: false, code: 'ROLE_NOT_FOUND' }`.

**Step 3 — Resolve permission ID.**

`const permission = await permissionsRepository.findByName(input.permissionName)`. If `null` → return `{ ok: false, code: 'PERMISSION_NOT_FOUND' }`. This should never fire with the seeded data — treat as a defensive guard; the action maps it to `SERVER_ERROR`.

**Step 4 — Load current mapping (before-snapshot).**

`const currentMappings = await rolePermissionAssignRepository.findMappingsForRole(input.roleId)`. Find the entry where `permissionName === input.permissionName`. Capture `previousLevel: PermissionType | null` (null if no entry found).

**Step 5 — Short-circuit if no change.**

```ts
if (previousLevel === input.level) return { ok: true };
```

No DB write; no audit entry. Prevents spurious `PERMISSION_MAPPING_CHANGED` events when the UI echoes a redundant call.

**Step 6 — Transaction.**

```ts
await db.transaction(async (tx) => {
  if (input.level === null) {
    await rolePermissionAssignRepository.deleteRolePermission(tx, {
      roleId: input.roleId,
      permissionId: permission.permissionId,
    });
  } else {
    await rolePermissionAssignRepository.upsertRolePermission(tx, {
      roleId: input.roleId,
      permissionId: permission.permissionId,
      permissionType: input.level,
    });
  }

  await writeAuditEvent(tx, {
    eventType: "PERMISSION_MAPPING_CHANGED",
    actorUserId: actorId,
    targetEntity: "ROLE_PERMISSION_ASSIGN",
    targetId: input.roleId,
    beforeData: {
      roleName: role.roleName,
      permissionName: input.permissionName,
      level: previousLevel,
    },
    afterData: {
      roleName: role.roleName,
      permissionName: input.permissionName,
      level: input.level,
    },
  });
});
```

`roleName` is included in both snapshots so the audit log is readable without joins. On any exception the transaction rolls back; nothing is persisted.

**Step 7 — Return.**

`return { ok: true }`.

`PERMISSION_MAPPING_CHANGED` audit event shape:

- `eventType`: `'PERMISSION_MAPPING_CHANGED'`
- `actorUserId`: actorId (the admin making the change)
- `targetEntity`: `'ROLE_PERMISSION_ASSIGN'`
- `targetId`: `input.roleId`
- `beforeData`: `{ roleName, permissionName, level: previousLevel | null }`
- `afterData`: `{ roleName, permissionName, level: newLevel | null }`

`level: null` in before/after means no mapping existed / mapping was removed respectively.

### 20.4 — Server Action (`actions/roles/set-permission-level.action.ts`)

New file. `'use server'`.

```ts
type SetPermissionLevelActionResult =
  | { ok: true }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: "AUDIT_LOG_READONLY" }
  | { ok: false; code: "ROLE_NOT_FOUND" }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function setPermissionMappingAction(
  rawInput: unknown,
): Promise<SetPermissionLevelActionResult>;
```

Steps:

1. `const { userId: actorId } = await requirePermission(PERMISSIONS.ROLES, LEVELS.EDIT)` — wrap in try/catch; catch `NEXT_REDIRECT` and return `{ ok: false, code: 'FORBIDDEN' }`; all other auth failures → `{ ok: false, code: 'SERVER_ERROR' }`.

2. `const parsed = setPermissionLevelSchema.safeParse(rawInput)`. If `!parsed.success` → `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: parsed.error.flatten().fieldErrors }`.

3. Wrap in try/catch: `const result = await rolesWriteService.setRolePermissionLevel(parsed.data, actorId)`. On thrown exception → `{ ok: false, code: 'SERVER_ERROR' }`.

4. If `!result.ok`:
   - `AUDIT_LOG_READONLY` → `{ ok: false, code: 'AUDIT_LOG_READONLY' }`
   - `ROLE_NOT_FOUND` → `{ ok: false, code: 'ROLE_NOT_FOUND' }`
   - `PERMISSION_NOT_FOUND` → `{ ok: false, code: 'SERVER_ERROR' }` (data integrity issue; mask the internal code)

5. `revalidatePath('/administration/roles')`.

6. Return `{ ok: true }`.

`revalidatePath` is called only on `{ ok: true }`. No DB access in this file — delegates entirely to `rolesWriteService`. `PERMISSIONS.ROLES` and `LEVELS.EDIT` constants used (not raw strings).

### 20.5 — `PermissionMatrixEditor` component (`components/roles/permission-matrix-editor.tsx`)

Client Component (`'use client'`).

**Props:**

```ts
interface PermissionMatrixEditorProps {
  role: RoleWithMappings;
  className?: string;
}
```

`PermissionMatrixEditorProps` and the component are named exports (no default export), consistent with the project's component conventions.

**State:**

```ts
const [savingPermission, setSavingPermission] = useState<PermissionName | null>(
  null,
);
```

Tracks which permission row is currently saving. Only one row can be saving at a time (rows are independent; concurrent saves across rows are allowed but each row blocks its own re-click).

**Optimistic state** via `useOptimistic` (React 19 / Next.js 15):

```ts
const [optimisticMappings, updateOptimisticMappings] = useOptimistic(
  role.mappings,
  (
    state,
    update: { permissionName: PermissionName; level: PermissionType | null },
  ) =>
    state.map((m) =>
      m.permissionName === update.permissionName
        ? { ...m, assignedLevel: update.level }
        : m,
    ),
);
```

`optimisticMappings` is used for rendering; it reflects the pending state immediately and reverts if the action fails.

**`handleLevelChange` handler:**

```ts
async function handleLevelChange(
  permissionName: PermissionName,
  newLevel: PermissionType | null,
) {
  // Guard: no concurrent saves on the same row
  if (savingPermission === permissionName) return;

  // No-op if unchanged
  const current = optimisticMappings.find(
    (m) => m.permissionName === permissionName,
  );
  if (current?.assignedLevel === newLevel) return;

  // Optimistic update
  startTransition(() =>
    updateOptimisticMappings({ permissionName, level: newLevel }),
  );
  setSavingPermission(permissionName);

  try {
    const result = await setPermissionMappingAction({
      roleId: role.roleId,
      permissionName,
      level: newLevel,
    });

    if (!result.ok) {
      // Revert: useOptimistic reverts automatically when the transition ends
      // without a new optimistic update
      toast.error("Failed to update permission. Please try again.");
    }
    // On success: revalidatePath in action causes RSC re-render with confirmed data
  } catch {
    toast.error("Failed to update permission. Please try again.");
  } finally {
    setSavingPermission(null);
  }
}
```

Note: `useOptimistic` reverts automatically to the canonical `role.mappings` value when the transition that triggered `updateOptimisticMappings` is not followed by a committed server-side update. This is the standard React 19 pattern — no manual revert state needed.

**Render:**

```tsx
<table className={className}>
  <thead>
    <tr>
      <th /* --text-overline */>Permission</th>
      <th /* --text-overline */>Level</th>
    </tr>
  </thead>
  <tbody>
    {PERMISSION_NAMES.map((name) => {
      const mapping = optimisticMappings.find((m) => m.permissionName === name);
      const currentLevel = mapping?.assignedLevel ?? null;
      const isSaving = savingPermission === name;

      return (
        <tr key={name}>
          <td>{PERMISSION_DISPLAY_NAMES[name]}</td>
          <td>
            <LevelButtonGroup
              permissionName={name}
              currentLevel={currentLevel}
              isSaving={isSaving}
              onChange={handleLevelChange}
            />
          </td>
        </tr>
      );
    })}
  </tbody>
</table>
```

**`LevelButtonGroup` (internal sub-component, not exported separately):**

Renders the four buttons for one row. Props: `permissionName`, `currentLevel`, `isSaving`, `onChange`.

```tsx
const LEVELS_WITH_NULL = [null, "READ", "EDIT", "DELETE"] as const;

function LevelButtonGroup({
  permissionName,
  currentLevel,
  isSaving,
  onChange,
}) {
  return (
    <div
      role="group"
      aria-label={`Permission level for ${PERMISSION_DISPLAY_NAMES[permissionName]}`}
      className="inline-flex gap-1"
    >
      {LEVELS_WITH_NULL.map((level) => {
        const isSelected = currentLevel === level;
        const isAuditLock =
          permissionName === "audit_log" &&
          (level === "EDIT" || level === "DELETE");
        const isDisabled = isSaving || isAuditLock;

        return (
          <button
            key={level ?? "none"}
            type="button"
            disabled={isDisabled}
            aria-pressed={isSelected}
            title={
              isAuditLock ? "Audit log permissions are read-only" : undefined
            }
            onClick={() => !isDisabled && onChange(permissionName, level)}
            className={/* cva(...) */}
          >
            {isSaving && isSelected && (
              <Loader2 size={12} className="animate-spin" />
            )}
            {level === null ? "—" : level}
          </button>
        );
      })}
    </div>
  );
}
```

Use `cva` to define the button style variants: `{ selected: boolean; level: 'none' | 'READ' | 'EDIT' | 'DELETE'; disabled: boolean }`. The selected+level combination applies the token colors from §Design. No raw hex — CSS variable references only.

**Imports:** `setPermissionMappingAction` from `actions/roles/set-permission-level.action`; `PERMISSION_NAMES`, `PermissionType`, `PermissionName` from `types/rbac`; `PERMISSION_DISPLAY_NAMES` from `types/roles`; `RoleWithMappings` from `types/roles`; `useOptimistic`, `startTransition`, `useState` from `react`; `Loader2` from `lucide-react`; `toast` from `sonner`. No imports from `db/**` or `services/**`.

### 20.6 — `RoleDetail` update (`components/roles/role-detail.tsx`)

One targeted change: replace the read-only matrix conditional with a choice between `PermissionMatrixEditor` and the read-only matrix.

Locate the Permissions group (the section that currently always renders the read-only `<table>` matrix). Replace with:

```tsx
{/* Permissions group */}
<div>
  {/* <dt> label */}
  {canEdit
    ? <PermissionMatrixEditor role={role} />
    : /* existing read-only matrix from um18 */
  }
</div>
```

`canEdit` is already computed in um19:

```ts
const canEdit = hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT);
```

This change is the only structural edit to `RoleDetail`. The view/edit mode logic for role name/description (from um19) is untouched. The permissions section is always visible and always reflects the current mode (editable vs. read-only) based purely on the actor's `roles:EDIT` capability.

The `role` prop passed to `PermissionMatrixEditor` is the same `RoleWithMappings` that `RoleDetail` already receives — no additional data fetching or prop changes to `RolesPage` (`page.tsx`).

### 20.7 — Tests

#### Unit tests: validation (`tests/unit/validation/roles.test.ts` extension)

Add to the existing test file from um19:

**`setPermissionLevelSchema`:**

| Input                                                                   | Expected                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------ |
| `{ roleId: valid-uuid, permissionName: 'users', level: 'READ' }`        | Passes; all fields preserved                     |
| `{ roleId: valid-uuid, permissionName: 'audit_log', level: 'READ' }`    | Passes                                           |
| `{ roleId: valid-uuid, permissionName: 'users', level: null }`          | Passes; `level = null`                           |
| `{ roleId: valid-uuid, permissionName: 'audit_log', level: null }`      | Passes (schema does not block null on audit_log) |
| `{ roleId: 'not-a-uuid', permissionName: 'users', level: 'READ' }`      | Fails; `roleId` error "Invalid role ID"          |
| `{ roleId: valid-uuid, permissionName: 'billing_runs', level: 'READ' }` | Fails; `permissionName` not in enum              |
| `{ roleId: valid-uuid, permissionName: 'users', level: 'SUPERADMIN' }`  | Fails; `level` not in enum                       |
| `{ roleId: valid-uuid, permissionName: 'users' }` (level absent)        | Fails; `level` is required (not `.optional()`)   |

Schema note: `level` is `z.enum(PERMISSION_TYPES).nullable()`, not `.optional()`. The caller must explicitly pass `null` to remove a mapping; omitting the field is a validation error. This prevents accidental removals from incomplete payloads.

#### Unit tests: service (`tests/unit/services/roles-write.service.test.ts` extension)

Add to the existing test file from um19. Mock `rolesRepository`, `permissionsRepository`, `rolePermissionAssignRepository`, `writeAuditEvent`.

| Scenario                                | Setup                                                                                      | Expected                                                                                                                                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Add new mapping (null → READ)           | `findById` → role; `findByName` → permission; `findMappingsForRole` → no entry for `users` | `upsertRolePermission` called with `permissionType: 'READ'`; `writeAuditEvent` called with `PERMISSION_MAPPING_CHANGED`, `beforeData.level = null`, `afterData.level = 'READ'`; returns `{ ok: true }` |
| Update existing mapping (READ → DELETE) | `findMappingsForRole` → entry with `READ` for `users`                                      | `upsertRolePermission` called with `permissionType: 'DELETE'`; before/after correct; `{ ok: true }`                                                                                                    |
| Remove mapping (DELETE → null)          | `findMappingsForRole` → entry with `DELETE` for `roles`                                    | `deleteRolePermission` called; `afterData.level = null`; `upsertRolePermission` not called; `{ ok: true }`                                                                                             |
| No change — same level                  | `findMappingsForRole` → entry with `READ`; `input.level = 'READ'`                          | Short-circuit; no DB write; `writeAuditEvent` not called; `{ ok: true }`                                                                                                                               |
| No change — both null                   | `findMappingsForRole` → no entry; `input.level = null`                                     | Short-circuit; no DB write; `{ ok: true }`                                                                                                                                                             |
| `audit_log` EDIT rejected               | `input.permissionName = 'audit_log'`, `input.level = 'EDIT'`                               | Returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }`; `findById` not called; no DB writes                                                                                                               |
| `audit_log` DELETE rejected             | `input.permissionName = 'audit_log'`, `input.level = 'DELETE'`                             | Returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }`                                                                                                                                                    |
| `audit_log` READ allowed                | `input.permissionName = 'audit_log'`, `input.level = 'READ'`                               | Proceeds normally; `upsertRolePermission` called                                                                                                                                                       |
| `audit_log` null allowed                | `input.permissionName = 'audit_log'`, `input.level = null`                                 | Proceeds; `deleteRolePermission` called                                                                                                                                                                |
| Role not found                          | `findById` → null                                                                          | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`; no DB writes                                                                                                                                          |
| Before-snapshot captured correctly      | Existing mapping DELETE; input READ                                                        | `beforeData.level = 'DELETE'` regardless of `afterData`                                                                                                                                                |
| Transaction rollback                    | `upsertRolePermission` throws                                                              | Exception propagates; `writeAuditEvent` not called; nothing persisted                                                                                                                                  |
| `roleName` in audit snapshots           | role with `role_name = 'MANAGER'`                                                          | `beforeData.roleName = 'MANAGER'`; `afterData.roleName = 'MANAGER'`                                                                                                                                    |

#### Unit tests: action (`tests/unit/actions/set-permission-level.action.test.ts`)

New file. Mock `requirePermission`, `rolesWriteService.setRolePermissionLevel`, `revalidatePath`.

| Scenario                                      | Setup                                                                             | Expected                                                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Valid input, ADMIN session                    | `setRolePermissionLevel` → `{ ok: true }`                                         | Returns `{ ok: true }`; `revalidatePath('/administration/roles')` called                                                       |
| Valid input, `level: null`                    | `setRolePermissionLevel` → `{ ok: true }`                                         | Returns `{ ok: true }`; `revalidatePath` called                                                                                |
| Validation failure — unknown `permissionName` | Raw input `{ roleId: valid-uuid, permissionName: 'billing_runs', level: 'READ' }` | Returns `{ ok: false, code: 'VALIDATION_ERROR', fieldErrors: { permissionName: [...] } }`; `setRolePermissionLevel` not called |
| Validation failure — invalid `level`          | Raw input `{ roleId: valid-uuid, permissionName: 'users', level: 'WRITE' }`       | Returns `{ ok: false, code: 'VALIDATION_ERROR' }`                                                                              |
| `AUDIT_LOG_READONLY`                          | `setRolePermissionLevel` → `{ ok: false, code: 'AUDIT_LOG_READONLY' }`            | Returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }`; `revalidatePath` NOT called                                               |
| `ROLE_NOT_FOUND`                              | `setRolePermissionLevel` → `{ ok: false, code: 'ROLE_NOT_FOUND' }`                | Returns `{ ok: false, code: 'ROLE_NOT_FOUND' }`; `revalidatePath` NOT called                                                   |
| `PERMISSION_NOT_FOUND`                        | `setRolePermissionLevel` → `{ ok: false, code: 'PERMISSION_NOT_FOUND' }`          | Returns `{ ok: false, code: 'SERVER_ERROR' }` (internal code masked)                                                           |
| Unauthorized                                  | `requirePermission` throws non-redirect error                                     | Returns `{ ok: false, code: 'FORBIDDEN' }`                                                                                     |
| Service throws                                | `setRolePermissionLevel` throws                                                   | Returns `{ ok: false, code: 'SERVER_ERROR' }`                                                                                  |
| No `revalidatePath` on any error path         | All error variants                                                                | `revalidatePath` is NOT called in any failure case                                                                             |

#### Unit tests: `PermissionMatrixEditor` (`tests/unit/components/roles/permission-matrix-editor.test.tsx`)

New file. Mock `setPermissionMappingAction` and `toast`. Use `@testing-library/react`.

| Scenario                                      | Expected                                                                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Renders 4 rows                                | PERMISSION_NAMES order: Users, Roles, System Config, Audit Log                                                               |
| ADMIN role — `users` row                      | `DELETE` button has `aria-pressed="true"`; `READ`, `EDIT`, `—` have `aria-pressed="false"`                                   |
| ADMIN role — `audit_log` row                  | `READ` button has `aria-pressed="true"`; `EDIT` and `DELETE` buttons have `disabled` attribute; `—` does NOT have `disabled` |
| MANAGER role — all rows                       | `—` button has `aria-pressed="true"` in every row                                                                            |
| `audit_log` EDIT/DELETE disabled              | `EDIT` and `DELETE` buttons have `disabled` and `title="Audit log permissions are read-only"`                                |
| `users` all buttons enabled                   | No button in the `users` row has `disabled` attribute                                                                        |
| Click `READ` on `users` (current is `DELETE`) | `setPermissionMappingAction` called with `{ roleId, permissionName: 'users', level: 'READ' }`                                |
| Click the currently-selected level            | `setPermissionMappingAction` NOT called                                                                                      |
| Click `EDIT` on `audit_log`                   | `setPermissionMappingAction` NOT called (disabled button)                                                                    |
| While saving `users` row                      | `users` row buttons all have `disabled`; `roles` row buttons are NOT disabled                                                |
| Save success                                  | Buttons re-enabled; no toast                                                                                                 |
| Save failure                                  | `toast.error('Failed to update permission. Please try again.')` called; buttons re-enabled                                   |
| Aria: button group                            | `role="group"` on the group wrapper; each button has `aria-pressed`                                                          |

#### Unit tests: `RoleDetail` update (`tests/unit/components/roles/role-detail.test.tsx` extension)

Extend the existing test file from um18/um19:

- When `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` is true: `PermissionMatrixEditor` is rendered in the Permissions section.
- When `hasLevel(...)` is false: the read-only matrix (from um18) is rendered; `PermissionMatrixEditor` is not mounted.
- The Permissions section shows `PermissionMatrixEditor` in both view mode and edit mode (um19's toggle does not affect it).
- The read-only matrix and `PermissionMatrixEditor` are never both rendered simultaneously.

#### Integration tests: `setPermissionMappingAction` (`tests/integration/actions/set-permission-level.action.test.ts`)

New file. Test DB seeded via `db:setup` (roles ADMIN/MANAGER/USER + 4-permission ADMIN matrix). Fixtures: `admin_user` session, `no_grants_user` session.

| Session          | Input                                                                                 | Expected                                    |
| ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------- |
| `admin_user`     | `{ roleId: managerId, permissionName: 'users', level: 'READ' }` (new mapping)         | `{ ok: true }` — see assertions             |
| `admin_user`     | `{ roleId: adminId, permissionName: 'roles', level: 'READ' }` (downgrade from DELETE) | `{ ok: true }` — see assertions             |
| `admin_user`     | `{ roleId: adminId, permissionName: 'roles', level: null }` (remove mapping)          | `{ ok: true }` — see assertions             |
| `admin_user`     | `{ roleId: adminId, permissionName: 'audit_log', level: 'READ' }` (no change)         | `{ ok: true }`; no DB write; no audit row   |
| `admin_user`     | `{ roleId: adminId, permissionName: 'audit_log', level: 'EDIT' }`                     | `{ ok: false, code: 'AUDIT_LOG_READONLY' }` |
| `admin_user`     | `{ roleId: adminId, permissionName: 'audit_log', level: 'DELETE' }`                   | `{ ok: false, code: 'AUDIT_LOG_READONLY' }` |
| `admin_user`     | `{ roleId: 'non-existent-uuid', permissionName: 'users', level: 'READ' }`             | `{ ok: false, code: 'ROLE_NOT_FOUND' }`     |
| `no_grants_user` | Any valid input                                                                       | `{ ok: false, code: 'FORBIDDEN' }`          |
| (no session)     | Any valid input                                                                       | `{ ok: false, code: 'FORBIDDEN' }`          |

**Happy-path assertions — add MANAGER `users:READ`:**

- `SELECT * FROM core.role_permission_assign WHERE ref_role_id = managerId AND ref_permission_id = usersPermId` returns one row with `permission_type = 'READ'`.
- `AUDIT_LOG` has one row: `event_type = 'PERMISSION_MAPPING_CHANGED'`, `actor_user_id = admin_user.userId`, `target_entity = 'ROLE_PERMISSION_ASSIGN'`, `target_id = managerId`.
- `before_data = { roleName: 'MANAGER', permissionName: 'users', level: null }`.
- `after_data = { roleName: 'MANAGER', permissionName: 'users', level: 'READ' }`.
- **Atomicity assertion:** stub `writeAuditEvent` to throw; assert no `role_permission_assign` row was inserted.

**Downgrade ADMIN `roles` from DELETE to READ:**

- `role_permission_assign` row for `(adminId, rolesPermId)` has `permission_type = 'READ'`; exactly one row (not two).
- `AUDIT_LOG`: `before_data.level = 'DELETE'`, `after_data.level = 'READ'`.
- `last_modified_datetime` on the row is more recent than `created_datetime`.

**Remove ADMIN `roles` mapping (level → null):**

- `SELECT COUNT(*) FROM core.role_permission_assign WHERE ref_role_id = adminId AND ref_permission_id = rolesPermId` = 0 (row deleted).
- `AUDIT_LOG`: `before_data.level = 'DELETE'`, `after_data.level = null`.

**No-change (ADMIN `audit_log` already READ → send READ again):**

- `AUDIT_LOG` count for `PERMISSION_MAPPING_CHANGED` targeting `adminId` + `audit_log` remains 0 (no new row).
- `role_permission_assign` row `last_modified_datetime` is unchanged.

**`AUDIT_LOG_READONLY` (EDIT on audit_log):**

- No `role_permission_assign` row written.
- No `AUDIT_LOG` row written.

#### Integration tests: repository (`tests/integration/db/roles-repository.test.ts` extension)

Add to the existing file from um18/um19:

- `permissionsRepository.findByName('users')` returns a `Permission` row with `permission_name = 'users'` after `db:setup`.
- `permissionsRepository.findByName('roles')` returns the `roles` permission row.
- `permissionsRepository.findByName('nonexistent_page')` returns `null`.
- `rolePermissionAssignRepository.upsertRolePermission(tx, { roleId: managerId, permissionId: usersPermId, permissionType: 'READ' })`: row inserted; `SELECT` confirms `permission_type = 'READ'`.
- Calling `upsertRolePermission` again with same keys and `permissionType: 'EDIT'`: row updated; `permission_type = 'EDIT'`; `SELECT COUNT(*)` = 1 (no duplicate).
- `last_modified_datetime` on the row is updated on the second call.
- `rolePermissionAssignRepository.deleteRolePermission(tx, { roleId: managerId, permissionId: usersPermId })`: row deleted; `SELECT` returns 0 rows.
- Calling `deleteRolePermission` on a row that does not exist: completes without error; `SELECT` still 0 rows (idempotent).

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `drizzle-orm` — `eq`, `and`, `insert().onConflictDoUpdate()` for upsert pattern; already installed.
- `react` — `useOptimistic`, `startTransition`, `useState`; available in React 19 (bundled with Next.js 15).
- `lucide-react` — `Loader2` icon; already used from um08/um19.
- `sonner` — toast; already installed from um19.
- `cva` — already installed from um07.
- `vitest`, `@testing-library/react` — already installed.

No new `PERMISSIONS` migration rows — `roles:EDIT` is satisfied by ADMIN's `roles:DELETE` grant (DELETE ⊃ EDIT, per the permission hierarchy). No schema migrations required — all four RBAC tables are already in place from um05.

---

## Verification Checklist

### Action and authorization

- [ ] `setPermissionMappingAction` is decorated `'use server'`
- [ ] Calls `requirePermission(PERMISSIONS.ROLES, LEVELS.EDIT)` as the first operation
- [ ] ADMIN session (DELETE satisfies EDIT) succeeds; no-grants session returns `FORBIDDEN`; no session returns `FORBIDDEN`
- [ ] `PERMISSIONS.ROLES` and `LEVELS.EDIT` constants used — not raw strings `'roles'`/`'EDIT'`
- [ ] No DB access in the action file — delegates entirely to `rolesWriteService.setRolePermissionLevel`
- [ ] `revalidatePath('/administration/roles')` called only on `{ ok: true }`; NOT called on any error path

### Validation

- [ ] `setPermissionLevelSchema` is added to `validation/roles.ts` (existing file, not a new file)
- [ ] Schema accepts `level: null` (required field, not optional — caller must explicitly pass null)
- [ ] Schema rejects `permissionName` values not in `PERMISSION_NAMES`
- [ ] Schema rejects `level` values not in `PERMISSION_TYPES` (and not null)
- [ ] Schema rejects non-UUID `roleId`
- [ ] Schema does NOT reject EDIT/DELETE for audit_log — that guard lives in the service

### `audit_log` READ-max enforcement (defense in depth)

- [ ] Service returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }` for `audit_log` + `EDIT` before any DB reads
- [ ] Service returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }` for `audit_log` + `DELETE` before any DB reads
- [ ] Service accepts `audit_log` + `READ` and proceeds normally
- [ ] Service accepts `audit_log` + `null` (remove mapping) and proceeds normally
- [ ] Action returns `{ ok: false, code: 'AUDIT_LOG_READONLY' }` when service returns that code
- [ ] `PermissionMatrixEditor`: EDIT and DELETE buttons in `audit_log` row have `disabled` attribute
- [ ] `PermissionMatrixEditor`: EDIT/DELETE buttons carry `title="Audit log permissions are read-only"`
- [ ] `PermissionMatrixEditor`: clicking disabled EDIT/DELETE on `audit_log` does NOT call `setPermissionMappingAction`
- [ ] Integration: `audit_log` + `EDIT` from ADMIN session returns `AUDIT_LOG_READONLY`; zero new `role_permission_assign` rows; zero new `AUDIT_LOG` rows

### Permission mapping CRUD

- [ ] Adding a new mapping (null → READ for MANAGER `users`): one row inserted in `role_permission_assign` with `permission_type = 'READ'`
- [ ] Updating an existing mapping (DELETE → READ for ADMIN `roles`): `permission_type` updated; `last_modified_datetime` updated; exactly one row exists (no duplicate)
- [ ] Removing a mapping (DELETE → null for ADMIN `roles`): row deleted; query returns 0 rows
- [ ] Removing a non-existent mapping (null → null short-circuit): no DB write; completes without error
- [ ] No change (same level): neither `upsertRolePermission` nor `deleteRolePermission` is called; no `AUDIT_LOG` row written; returns `{ ok: true }`

### `PERMISSION_MAPPING_CHANGED` audit event

- [ ] `event_type = 'PERMISSION_MAPPING_CHANGED'`
- [ ] `target_entity = 'ROLE_PERMISSION_ASSIGN'`
- [ ] `target_id` = the role's `role_id` UUID
- [ ] `actor_user_id` = the acting admin's `user_id`
- [ ] `before_data` contains `{ roleName, permissionName, level }` where `level` is `PermissionType | null`
- [ ] `after_data` contains `{ roleName, permissionName, level }` with the new level
- [ ] `roleName` in both snapshots matches the role's `role_name` at the time of the action
- [ ] Audit row is written atomically in the same transaction as the `role_permission_assign` write
- [ ] No audit row is written on short-circuit (no-change)
- [ ] No audit row is written when `AUDIT_LOG_READONLY` is returned
- [ ] Atomicity integration test: stubbing `writeAuditEvent` to throw leaves `role_permission_assign` unchanged (transaction rolled back)

### `PermissionMatrixEditor`

- [ ] Has `'use client'` directive
- [ ] Renders 4 rows in `PERMISSION_NAMES` order: Users, Roles, System Config, Audit Log
- [ ] Each row has a button group with 4 options: `—`, `READ`, `EDIT`, `DELETE`
- [ ] The currently-assigned level's button has `aria-pressed="true"`; others have `aria-pressed="false"`
- [ ] ADMIN role: `users` row — `DELETE` selected; `audit_log` row — `READ` selected
- [ ] MANAGER role: all 4 rows show `—` selected
- [ ] `audit_log` row: `EDIT` and `DELETE` have `disabled`; `READ` and `—` do NOT have `disabled`
- [ ] Selected buttons use level token colors (info-50/info-700 for READ, warning-50/warning-700 for EDIT, danger-50/danger-700 for DELETE, neutral-100/neutral-700 for `—`); CSS variable references only — no raw hex
- [ ] Unselected buttons use ghost styling (`--text-muted`, `--border-subtle`)
- [ ] Clicking an unselected, enabled level triggers `setPermissionMappingAction` with correct `{ roleId, permissionName, level }`
- [ ] Clicking the currently-selected level does NOT trigger `setPermissionMappingAction`
- [ ] While a save is in flight for one row, that row's buttons are all disabled; other rows' buttons remain enabled
- [ ] Loading button shows `Loader2` (12px) inline on the currently-selected button during save
- [ ] On success: buttons re-enabled; no success toast
- [ ] On failure: `toast.error('Failed to update permission. Please try again.')` shown; visual reverts to previous level; buttons re-enabled
- [ ] Optimistic update: visual reflects new level immediately on click (before server responds)
- [ ] `role="group"` on the button group wrapper with `aria-label="Permission level for {displayName}"`
- [ ] No imports from `db/**` or `services/**`

### `RoleDetail` integration

- [ ] When `hasLevel(permissionMap, PERMISSIONS.ROLES, LEVELS.EDIT)` is true: `PermissionMatrixEditor` renders in the Permissions section with the current role's `RoleWithMappings`
- [ ] When `hasLevel(...)` is false: the read-only matrix from um18 renders; `PermissionMatrixEditor` is not mounted
- [ ] `PermissionMatrixEditor` is visible in both view mode and edit mode (the name/description edit toggle does not gate it)
- [ ] The read-only matrix and `PermissionMatrixEditor` are never simultaneously rendered
- [ ] No changes required to `RolesPage` (`page.tsx`) — `permissionMap` already flows through from um19
- [ ] `RoleDetail` edits are limited to the permissions section conditional — all other panel logic from um18/um19 is untouched

### Repository

- [ ] `permissionsRepository.findByName('users')` returns the seeded `users` `Permission` row after `db:setup`
- [ ] `permissionsRepository.findByName('nonexistent')` returns `null`
- [ ] `upsertRolePermission` inserts a row when no conflict; confirms `permission_type` is correct
- [ ] `upsertRolePermission` updates `permission_type` and `last_modified_datetime` when the unique constraint fires; exactly one row afterward
- [ ] `deleteRolePermission` deletes the target row; confirms 0 rows remain
- [ ] `deleteRolePermission` on a non-existent row completes without error (idempotent)
- [ ] Neither write function contains business logic, permission checks, or audit writes
- [ ] Both write functions accept a Drizzle transaction handle and do not open their own transactions

### Boundary and TypeScript

- [ ] `setPermissionLevelSchema` and `SetPermissionLevelInput` are added to `validation/roles.ts` (not a new file)
- [ ] `services/roles/roles-write.service.ts` extension has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `actions/roles/set-permission-level.action.ts` is a new file with `'use server'`; no DB access
- [ ] `components/roles/permission-matrix-editor.tsx` is a new file with `'use client'`; no DB or service imports
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] All `setPermissionLevelSchema` unit tests pass (8 scenarios)
- [ ] All `setRolePermissionLevel` service unit tests pass (13 scenarios)
- [ ] All `setPermissionMappingAction` action unit tests pass (10 scenarios)
- [ ] All `PermissionMatrixEditor` unit tests pass (12 scenarios)
- [ ] `RoleDetail` integration tests pass: EDIT grants → `PermissionMatrixEditor` rendered; READ-only → read-only matrix rendered; both modes visible
- [ ] Action integration tests pass: add mapping, downgrade mapping, remove mapping, no-change short-circuit, `AUDIT_LOG_READONLY` (EDIT + DELETE), `ROLE_NOT_FOUND`, `FORBIDDEN`, atomicity
- [ ] Repository integration tests pass: `findByName` (found, not found), `upsertRolePermission` (insert + update), `deleteRolePermission` (delete + idempotent)

### Scope guard

- [ ] No role deletion added (um21)
- [ ] No role assignment/revocation via Roles page added (um13 — on the Users page)
- [ ] No new `PERMISSIONS` migration rows added
- [ ] No schema migrations added
- [ ] `PermissionLevelTag` from um18 is not re-implemented — button styling in `PermissionMatrixEditor` uses the same token set but is a distinct `<button>` element; the two are visually consistent but not composed (buttons ARE the interactive affordance, not a tag inside a button)
- [ ] The read-only matrix rendering in `RoleDetail` for users without `roles:EDIT` is unchanged from um18
- [ ] `roles-write.service.ts` from um19 is extended (not replaced); `createRole` and `updateRole` are untouched
- [ ] `validation/roles.ts` from um19 is extended (not replaced); existing schemas are untouched
- [ ] `RolesPage` (`page.tsx`) requires no changes in this unit
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
