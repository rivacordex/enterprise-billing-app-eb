# Spec: um22 — System Config view (READ)

- **Boundary:** APP / DB
- **Dependencies:** Unit um06 (authorization enforcement core — `requirePermission`, guard, `EffectivePermissionMap`, `PERMISSIONS`/`LEVELS` constants, deny-by-default routing); Unit um10 (Entra env config — `lib/config.ts`, `entraConfig`, `isSsoConfigured`, the Entra Settings display pattern and `EntraConfigRow` component established on the System Config page). Practical dependencies: um02 (Drizzle client + `core` schema), um05 (`system_config` permission row seeded in `core.permissions`), um07 (`PageHeader` component, admin shell layout patterns).
- **Source sections:** overview §"System configuration" (non-secret params via `SYSTEM_CONFIG`; non-secret Entra values from env shown read-only; `config_version`/`status` reserved for future lifecycle), §"Data Model — Config + audit" (`SYSTEM_CONFIG` schema), §"Pages — Administration" item 3, §"Roles & Default Permission Seed" (ADMIN: `system_config:DELETE`); architecture §2 (folder ownership, boundary rules), §3 (storage — `SYSTEM_CONFIG` = non-secret params, `is_secret` reserved always FALSE), §5 (Inv. #3 always server-side; Inv. #4 deny by default); architecture §6 (`/administration/system-config` requires `system_config:READ`); code-standards §3 (Server Component data-fetch pattern), §4 (styling, CSS variable tokens), §7 (file organization). Invariants: **#2** (no authz state in session), **#3** (always server-side), **#4** (deny by default), **#14** (DB access only in `db/**`), **#18** (secrets never in DB, repo, or image — `MICROSOFT_CLIENT_SECRET` never shown), **#20** (authz decisions never cached).

---

## Goal

Introduce the `SYSTEM_CONFIG` table via a just-in-time Drizzle migration with a minimal operational seed, build the `/administration/system-config` page guarded at `system_config:READ`, and render a `ConfigTable` component displaying all non-secret DB-sourced parameters grouped by `config_group`, alongside the read-only Entra values established in um10.

---

## Design

### Page layout

Single-panel layout — no detail panel or selection mechanism in this unit (config has no row-level drill-down in v1). Structure top to bottom:

- **Page header**: a plain `<h1>` "System Configuration" — no `PageHeader`/breadcrumb component exists anywhere in the codebase (the Users/Roles pages have no page-level title either), so this doesn't invent one for a single caller.
- **Configuration Parameters section**: `<h2>` "Configuration Parameters" + a `ConfigTable` component rendering DB rows grouped by `config_group`.
- **Separator**: a `<hr>` with `--border-default` styling.
- **Entra ID Settings section**: `<h2>` "Entra ID Settings" + a descriptor paragraph + `EntraConfigRow` entries for Tenant ID, Client ID, and Redirect URI.

No create, edit, or delete controls appear on this page in um22 — those come in the EDIT unit.

### ConfigTable design

A standard HTML `<table>` with these columns: **Key** | **Value** | **Status** | **Last Modified**.

Rows are grouped by `config_group`. Each group is preceded by a full-span group header row: a single `<td colSpan={4}>` containing the group name in uppercase `--text-overline` typography, `--surface-sunken` background, left-padded (`px-4 py-2`). Example: a header row "APP" above all rows where `config_group = 'app'`.

Column details:

- **Key** (`config_key`): `font-mono` (`--font-mono`), `text-sm`, `--text-body` color. Renders the raw key string (e.g. `app_name`).
- **Value** (`config_value`): body text. Values exceeding 80 characters are CSS-truncated (`max-w-xs truncate`) with the full value in a `title` attribute. Values that look like URIs (start with `http://` or `https://`) render in `--font-mono` as a visual hint.
- **Status**: `ConfigStatusBadge` — a pill chip with status-appropriate tokens (see §ConfigStatusBadge).
- **Last Modified**: a `<time>` element rendering a relative date string (e.g. "3 hours ago", "2 days ago"), with the full ISO-8601 datetime in the `datetime` attribute and `title` attribute for hover reveal. If `modifiedByName` is not null, a `<span className="text-[--text-muted] ml-1">by {modifiedByName}</span>` appears inline. If `modifiedByName` is null (seeded rows), only the relative date appears.

Table header row: `--surface-sunken` background, `--text-overline` typography, `--border-default` bottom border, `py-3 px-4` per cell.

Data rows: `py-3 px-4` per cell, `--border-subtle` bottom border. RETIRED rows render with `opacity-60` on the entire `<tr>`.

Empty state: when `groups` is empty (no non-secret rows exist), render a centered empty-state card instead of an empty table frame. The card contains: a `Settings` Lucide icon (size 32, `--text-muted` color), an `<h3>` "No configuration parameters", and a `<p>` "No system parameters have been configured."

`is_secret = TRUE` rows are never fetched and never displayed. No indicator is shown for hidden secret rows.

### ConfigStatusBadge

New component (`components/system-config/config-status-badge.tsx`). Pill shape (`--radius-pill`), `text-xs`, `font-medium`, `px-2 py-0.5`, `inline-flex items-center`. Token mapping:

| Status    | Background tint       | Text color            | Label     |
| --------- | --------------------- | --------------------- | --------- |
| `ACTIVE`  | `--color-success-50`  | `--color-success-700` | `Active`  |
| `DRAFT`   | `--color-info-50`     | `--color-info-700`    | `Draft`   |
| `RETIRED` | `--color-neutral-100` | `--color-neutral-600` | `Retired` |

No icon — status is unambiguous from label text alone for this domain.

### Entra ID Settings section

Reuses the `EntraConfigRow` component from um10 §10.8. Displays three rows:

| Label        | Value source                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| Tenant ID    | `entraConfig.tenantId` (from `lib/config.ts`)                                    |
| Client ID    | `entraConfig.clientId`                                                           |
| Redirect URI | `entraConfig.redirectUri` (`${NEXT_PUBLIC_APP_URL}/api/auth/callback/microsoft`) |

Each row: label left-aligned in `--text-muted`, value right-aligned in `--font-mono`, `--text-body`. When a value is `null`: renders "Not configured" in `--text-muted`. Redirect URI row includes a copy-to-clipboard button (same `Copy` → `Check` icon + 2-second revert pattern from um10). `MICROSOFT_CLIENT_SECRET` is never shown — not present, not masked.

If `EntraConfigRow` was inlined in the System Config page by um10 rather than extracted as its own file, um22 extracts it to `components/system-config/entra-config-row.tsx` as part of this unit.

The section includes a descriptor paragraph: "Read-only. Sourced from environment variables. Use the Redirect URI when registering this application in Microsoft Entra."

---

## Implementation

### 22.1 — `SYSTEM_CONFIG` Drizzle migration (`db/migrations/`)

New migration file. Creates the table and seeds initial rows.

**Schema (as SQL for reference — Drizzle generates the actual DDL):**

```sql
CREATE TABLE core.system_config (
  config_id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  config_group           TEXT        NOT NULL,
  config_version         INTEGER     NOT NULL DEFAULT 1,
  config_key             TEXT        NOT NULL,
  config_value           TEXT,
  is_secret              BOOLEAN     NOT NULL DEFAULT FALSE,
  status                 TEXT        NOT NULL DEFAULT 'ACTIVE'
                         CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED')),
  modified_by            UUID        REFERENCES core.appuser(user_id) ON DELETE SET NULL,
  created_datetime       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_modified_datetime TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (config_group, config_version, config_key)
);
```

`modified_by` is nullable: seeded rows have no human actor. `ON DELETE SET NULL` preserves config history if an admin account is tombstoned.

**Seed rows (same migration, after CREATE TABLE):**

| config_group | config_version | config_key | config_value                | is_secret | status   |
| ------------ | -------------- | ---------- | --------------------------- | --------- | -------- |
| `app`        | 1              | `app_name` | `Enterprise Billing System` | `FALSE`   | `ACTIVE` |

`modified_by` = `NULL`, `created_datetime` = `now()`, `last_modified_datetime` = `now()` for all seeded rows.

**Drizzle schema file** (`db/schema/system-config.ts`): define the `systemConfig` Drizzle table object within the `core` pgSchema, matching the columns above. Status column: `text('status').$type<ConfigStatus>().notNull().default('ACTIVE')` with the CHECK constraint applied via Drizzle's `.check()` or via the raw migration SQL. Export the `SystemConfig` inferred type (`typeof systemConfig.$inferSelect`). Import the `pgSchema` from `db/schema/core.schema.ts` (already established in um02).

### 22.2 — Types (`types/system-config.ts`)

New file. No runtime code. No imports from `auth/**`, `db/**`, `services/**`, or `next/*`.

```ts
export type ConfigStatus = "DRAFT" | "ACTIVE" | "RETIRED";

/** Shape returned by the repository join (system_config + appuser for modifier name). */
export interface SystemConfigDisplayRow {
  configId: string;
  configGroup: string;
  configVersion: number;
  configKey: string;
  configValue: string | null;
  isSecret: boolean;
  status: ConfigStatus;
  modifiedByUserId: string | null;
  modifiedByName: string | null; // joined from appuser.user_name; null for seeded rows
  lastModifiedDatetime: Date;
}

/** Rows grouped by configGroup for rendering. */
export interface SystemConfigGroup {
  group: string;
  rows: SystemConfigDisplayRow[];
}
```

### 22.3 — Repository (`db/repositories/system-config.repository.ts`)

New file. Drizzle queries only — no business logic, no permission checks, no audit writes.

**`findAllNonSecret(): Promise<SystemConfigDisplayRow[]>`**

Left-joins `appuser` to resolve the modifier's display name:

```ts
db.select({
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
  .where(eq(systemConfig.isSecret, false))
  .orderBy(asc(systemConfig.configGroup), asc(systemConfig.configKey));
```

Returns rows across all statuses (DRAFT, ACTIVE, RETIRED) — the page displays all non-secret config regardless of lifecycle state so an admin sees the full picture. Status filtering is a display concern handled in the component (RETIRED rows are visually muted, not hidden).

No write functions in this repository for um22. Write operations are added in the EDIT unit.

### 22.4 — Read service (`services/system-config/system-config-read.service.ts`)

New file. Framework-agnostic — no `next/*`, `app/**`, or `actions/**` imports.

**`getSystemConfigParams(): Promise<SystemConfigDisplayRow[]>`**

Thin delegating function: calls `systemConfigRepository.findAllNonSecret()` and returns the result unchanged. The service layer exists to maintain the boundary (page → service → repository) and to make the call independently testable. No additional transformation in this unit.

### 22.5 — Utility: `groupConfigRows` (`lib/format.ts` or `lib/group-config-rows.ts`)

Pure function, no external imports:

```ts
export function groupConfigRows(
  rows: SystemConfigDisplayRow[],
): SystemConfigGroup[] {
  const map = new Map<string, SystemConfigDisplayRow[]>();
  for (const row of rows) {
    const group = map.get(row.configGroup) ?? [];
    group.push(row);
    map.set(row.configGroup, group);
  }
  return Array.from(map.entries()).map(([group, rows]) => ({ group, rows }));
}
```

Row order within each group is preserved from the repository (already alphabetical by key). Group order is insertion-order from the sorted query, so effectively alphabetical by group name.

If `lib/format.ts` already exists (established in a prior unit for relative timestamps), add `groupConfigRows` there. Otherwise create `lib/group-config-rows.ts`. In either case, export `groupConfigRows` as a named export.

If a `formatRelativeTime(date: Date): string` utility does not yet exist (check prior units), add it to `lib/format.ts`:

```ts
/** Returns a human-readable relative time string, e.g. "3 hours ago", "2 days ago". */
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay > 0) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  if (diffHr > 0) return `${diffHr}  hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffMin > 0) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  return "just now";
}
```

### 22.6 — Components

#### 22.6.1 — `ConfigStatusBadge` (`components/system-config/config-status-badge.tsx`)

Server Component (no `'use client'`). Props: `{ status: ConfigStatus }`.

```tsx
const BADGE_STYLES: Record<ConfigStatus, string> = {
  ACTIVE: "bg-[--color-success-50]  text-[--color-success-700]",
  DRAFT: "bg-[--color-info-50]     text-[--color-info-700]",
  RETIRED: "bg-[--color-neutral-100] text-[--color-neutral-600]",
};
const BADGE_LABELS: Record<ConfigStatus, string> = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  RETIRED: "Retired",
};
```

Renders: `<span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_STYLES[status]}`}>{BADGE_LABELS[status]}</span>`.

No hardcoded hex values — CSS variables only.

#### 22.6.2 — `ConfigTable` (`components/system-config/config-table.tsx`)

Server Component. Props: `{ groups: SystemConfigGroup[] }`.

Receives pre-grouped, pre-ordered data (grouping is done in the page, not here). Renders the full table structure as described in §Design.

Empty state branch: if `groups.length === 0` or all groups have zero rows, render the empty-state card (`<div>` with centered layout, `Settings` Lucide icon, heading, body). Do not render a `<table>` element in this case.

Value truncation: compare `(configValue ?? '').length > 80` for the truncation check. URI detection: `configValue?.startsWith('http://') || configValue?.startsWith('https://')`.

Timestamp rendering: call `formatRelativeTime(row.lastModifiedDatetime)` from `lib/format.ts`. The `<time>` element: `datetime={row.lastModifiedDatetime.toISOString()}` and `title={row.lastModifiedDatetime.toISOString()}`.

RETIRED row: add `className="opacity-60"` to the `<tr>`.

Imports: `ConfigStatusBadge`, `SystemConfigGroup` type, `formatRelativeTime` from `lib/format.ts`, `Settings` from `lucide-react`. No imports from `db/**`, `services/**`, or `auth/**`.

#### 22.6.3 — `EntraConfigRow` (`components/system-config/entra-config-row.tsx`)

If um10 created this as a standalone file, no change needed. If it was inlined in the page, extract it here. Props:

```ts
interface EntraConfigRowProps {
  label: string;
  value: string | null;
  copyable?: boolean; // default false; renders copy button when true
}
```

Server Component for the row wrapper; the copy button is a `'use client'` sub-component (`CopyButton` — the same `Copy` → `Check` 2-second-revert pattern from um10's `TempPasswordDisplay`). When `value` is null: renders "Not configured" in `text-[--text-muted]`. Value styling: `font-mono text-sm text-[--text-body]`. Row layout: `<div className="flex items-center justify-between py-2 border-b border-[--border-subtle]">`.

### 22.7 — Page (`app/(admin)/administration/system-config/page.tsx`)

Server Component. No `'use client'` directive.

```ts
export const dynamic = "force-dynamic";
export const metadata = { title: "System Configuration — Enterprise Billing" };
```

**Full page algorithm:**

```ts
// 1. Guard — resolves user + permissionMap or redirects
const { userId, permissionMap } = await requirePermission(
  PERMISSIONS.SYSTEM_CONFIG,
  LEVELS.READ,
);

// 2. Fetch config rows from DB
const rows = await getSystemConfigParams();

// 3. Group for rendering
const groups = groupConfigRows(rows);

// 4. Entra values — read server-side only
import "server-only"; // not needed if lib/config.ts already guards; import for belt-and-suspenders
const entraDisplay = {
  tenantId: entraConfig.tenantId,
  clientId: entraConfig.clientId,
  redirectUri: entraConfig.redirectUri,
};
```

`entraConfig` is imported from `@/lib/config` (already `'server-only'`). `MICROSOFT_CLIENT_SECRET` is never referenced or passed to any component.

**Render structure:**

```tsx
<div className="space-y-6">
  <PageHeader
    title="System Configuration"
    breadcrumbs={[
      { label: "Administration" },
      { label: "System Configuration" },
    ]}
  />

  <section>
    <h2 className="mb-4 font-semibold text-[--text-h2]">
      Configuration Parameters
    </h2>
    <div className="overflow-hidden rounded-[--radius-md] border border-[--border-default] bg-[--surface-card]">
      <ConfigTable groups={groups} />
    </div>
  </section>

  <hr className="border-[--border-default]" />

  <section>
    <h2 className="mb-1 font-semibold text-[--text-h2]">Entra ID Settings</h2>
    <p className="mb-4 text-sm text-[--text-muted]">
      Read-only. Sourced from environment variables. Use the Redirect URI when
      registering this application in Microsoft Entra.
    </p>
    <div className="divide-y divide-[--border-subtle] rounded-[--radius-md] border border-[--border-default] bg-[--surface-card]">
      <EntraConfigRow label="Tenant ID" value={entraDisplay.tenantId} />
      <EntraConfigRow label="Client ID" value={entraDisplay.clientId} />
      <EntraConfigRow
        label="Redirect URI"
        value={entraDisplay.redirectUri}
        copyable
      />
    </div>
  </section>
</div>
```

The `permissionMap` returned by `requirePermission` is available for the EDIT unit to conditionally render action controls without re-fetching. In um22 it is not passed to any component.

`dynamic = 'force-dynamic'` is declared explicitly even though `(admin)/layout.tsx` already sets it — per code-standards, each page declares it for resilience against layout restructuring.

---

## Testing

### 22.8.1 — Unit tests: repository (`tests/unit/db/system-config.repository.test.ts`)

New file. Mock the Drizzle client.

| Scenario               | Setup                                                                  | Expected                              |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------- |
| Excludes secret rows   | Mix of `is_secret=TRUE` and `FALSE` rows                               | Only `FALSE` rows returned            |
| Ordering               | Three rows: group `z`, key `b`; group `a`, key `c`; group `a`, key `a` | Order: `(a,a), (a,c), (z,b)`          |
| Resolves modifier name | Row with `modified_by` set to admin UUID                               | `modifiedByName` = admin's `userName` |
| Null modifier          | Row with `modified_by = NULL`                                          | `modifiedByName = null`               |
| Empty table            | No rows                                                                | Returns `[]`                          |

### 22.8.2 — Unit tests: service (`tests/unit/services/system-config-read.service.test.ts`)

New file. Mock `systemConfigRepository`.

- `getSystemConfigParams()` delegates to `findAllNonSecret()` and returns the result unmodified.
- When repository returns `[]`, service returns `[]`.
- Service does not call any other repository function.

### 22.8.3 — Unit tests: `groupConfigRows` (`tests/unit/lib/format.test.ts` or `tests/unit/lib/group-config-rows.test.ts`)

Add to the lib utilities test file (or create if it does not exist).

- Empty input `[]` → returns `[]`.
- Single group: all rows placed under one `SystemConfigGroup`.
- Two distinct groups: two entries in the result, each containing their respective rows.
- Intra-group row order is preserved (not re-sorted).
- Group order matches the insertion order of the first appearance of each group name.

### 22.8.4 — Unit tests: `ConfigStatusBadge` (`tests/unit/components/system-config/config-status-badge.test.tsx`)

Mock `@testing-library/react`.

- `ACTIVE`: renders text "Active"; contains the `--color-success-50` background class.
- `DRAFT`: renders text "Draft"; contains the `--color-info-50` background class.
- `RETIRED`: renders text "Retired"; contains the `--color-neutral-100` background class.

### 22.8.5 — Unit tests: `ConfigTable` (`tests/unit/components/system-config/config-table.test.tsx`)

- `groups=[]`: empty-state card renders (`Settings` icon present, no `<table>` in DOM).
- Single group, two rows: group header row renders; both rows present with correct key and value text.
- Long value (length > 80): `truncate` class present; `title` attribute equals full value.
- URI value: `font-mono` class present on the value cell.
- `modifiedByName` not null: "by {name}" text appears in the row.
- `modifiedByName` null: no "by" text in the row.
- RETIRED row: `<tr>` has `opacity-60` class.
- `is_secret = TRUE` rows: never appear (repository filtered them out — verify the component receives only non-secret data and passes it through without filtering itself).

### 22.8.6 — Unit tests: page (`tests/unit/app/system-config.page.test.tsx`)

Mock `requirePermission`, `getSystemConfigParams`, `entraConfig`, `groupConfigRows`.

- Calls `requirePermission(PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ)`.
- No-permission session: `requirePermission` throws redirect to `/no-access`.
- `getSystemConfigParams` result is passed (after grouping) to `ConfigTable`.
- `entraDisplay` values from `entraConfig` are passed to `EntraConfigRow` components.
- No component receives `clientSecret` or any reference to `MICROSOFT_CLIENT_SECRET`.

### 22.8.7 — Integration tests: repository (`tests/integration/db/system-config.repository.test.ts`)

Uses the test DB with the migration applied.

- `findAllNonSecret()` returns the seeded `app_name` row after migration.
- Insert a row with `is_secret = TRUE`; `findAllNonSecret()` does not include it.
- Insert rows in two groups (`app`, `billing`); result is ordered group-alphabetically then key-alphabetically.
- Row with `modified_by = NULL`: `modifiedByName` is `null`.
- Insert a row with `modified_by` = seeded admin's UUID; `modifiedByName` equals that admin's `userName`.

### 22.8.8 — Integration tests: migration (`tests/integration/db/system-config.migration.test.ts`)

- `core.system_config` table exists after migration.
- `UNIQUE (config_group, config_version, config_key)` constraint: inserting a duplicate triple raises a unique-violation error.
- `CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED'))`: inserting `status = 'UNKNOWN'` raises a check-constraint error.
- `is_secret` defaults to `FALSE` when not specified.
- `config_version` defaults to `1` when not specified.
- Seeded `app_name` row exists: `config_group='app'`, `config_version=1`, `config_key='app_name'`, `config_value='Enterprise Billing System'`, `is_secret=FALSE`, `status='ACTIVE'`, `modified_by=NULL`.
- `modified_by` FK: inserting a non-existent UUID raises a FK-violation error; inserting `NULL` succeeds.
- `ON DELETE SET NULL`: tombstoning the referenced admin sets `modified_by` to `NULL` on affected rows (verify via a targeted FK-cascade test).

---

## Dependencies

No new npm packages. All required packages are installed from prior units:

- `drizzle-orm` — `eq`, `asc`, `leftJoin` for repository queries.
- `next` — Server Component patterns, `metadata` export.
- `lucide-react` — `Settings` icon for the empty-state card; `Copy`, `Check` for the clipboard button in `EntraConfigRow`.
- `vitest`, `@testing-library/react` — test runner and component testing.

No new `PERMISSIONS` migration rows — `system_config` was seeded in um05. No new `ROLES` seed rows.

---

## Verification Checklist

### Migration and schema

- [ ] `core.system_config` table exists after migration runs
- [ ] Columns present: `config_id` (UUID PK, `gen_random_uuid()`), `config_group` (TEXT NOT NULL), `config_version` (INT NOT NULL DEFAULT 1), `config_key` (TEXT NOT NULL), `config_value` (TEXT nullable), `is_secret` (BOOLEAN NOT NULL DEFAULT FALSE), `status` (TEXT NOT NULL DEFAULT 'ACTIVE'), `modified_by` (UUID FK → `core.appuser`, nullable, ON DELETE SET NULL), `created_datetime` (TIMESTAMPTZ NOT NULL), `last_modified_datetime` (TIMESTAMPTZ NOT NULL)
- [ ] `UNIQUE (config_group, config_version, config_key)` constraint is enforced (duplicate insert raises error)
- [ ] `CHECK (status IN ('DRAFT', 'ACTIVE', 'RETIRED'))` is enforced (invalid value raises error)
- [ ] Seeded row: `config_group='app'`, `config_key='app_name'`, `config_value='Enterprise Billing System'`, `is_secret=FALSE`, `status='ACTIVE'`, `modified_by=NULL`
- [ ] Drizzle `systemConfig` schema object is defined in `db/schema/system-config.ts` within the `core` pgSchema
- [ ] `SystemConfig` inferred type is exported from the schema file
- [ ] No new `PERMISSIONS` rows were added (the `system_config` permission row exists from um05)

### Types

- [ ] `ConfigStatus = 'DRAFT' | 'ACTIVE' | 'RETIRED'` exported from `types/system-config.ts`
- [ ] `SystemConfigDisplayRow` interface exported with all fields including `modifiedByName: string | null`
- [ ] `SystemConfigGroup` interface exported
- [ ] `types/system-config.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`

### Repository

- [ ] `systemConfigRepository.findAllNonSecret()` is implemented (not a stub)
- [ ] Only `is_secret = FALSE` rows are returned; `is_secret = TRUE` rows are excluded
- [ ] Result is ordered `config_group ASC`, then `config_key ASC`
- [ ] `modifiedByName` is populated via left join on `appuser.user_name` for rows with a non-null `modified_by`
- [ ] `modifiedByName` is `null` for rows with `modified_by = NULL`
- [ ] All statuses (ACTIVE, DRAFT, RETIRED) are included — no status filter applied in the query
- [ ] Repository has no imports from `auth/**`, `services/**`, `app/**`, or `actions/**`
- [ ] No write functions are present in this repository for um22

### Service

- [ ] `getSystemConfigParams()` calls `systemConfigRepository.findAllNonSecret()` and returns the result unchanged
- [ ] Service file has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] Service does not transform, filter, or sort the repository output

### Utilities

- [ ] `groupConfigRows(rows)` returns `[]` for empty input
- [ ] `groupConfigRows` produces one `SystemConfigGroup` per distinct `config_group`
- [ ] Row order within each group is preserved from input
- [ ] `formatRelativeTime(date)` exists in `lib/format.ts` (added if not present from prior units)

### Components

- [ ] `ConfigStatusBadge` renders "Active" / "Draft" / "Retired" label for the three statuses
- [ ] `ConfigStatusBadge` uses only CSS variable tokens (no hardcoded hex values in className)
- [ ] `ConfigTable` renders group headers for each distinct `config_group`
- [ ] `ConfigTable` renders Key, Value, Status, Last Modified columns with correct headers
- [ ] `config_key` values render in `--font-mono`
- [ ] Value exceeding 80 characters: `truncate` class present, full value in `title` attribute
- [ ] URI-shaped value: `font-mono` class present
- [ ] `modifiedByName` non-null: "by {name}" text appears in Last Modified cell
- [ ] `modifiedByName` null: no "by ..." text in the cell
- [ ] `<time>` element has `datetime` attribute set to ISO-8601 string
- [ ] RETIRED row: `<tr>` has `opacity-60` class
- [ ] Empty state (`groups=[]`): `Settings` icon and "No configuration parameters" text render; no `<table>` element in the DOM
- [ ] `EntraConfigRow` component exists in `components/system-config/entra-config-row.tsx` (extracted from um10 inline if necessary)
- [ ] Redirect URI `EntraConfigRow` has `copyable` prop wired to a copy-to-clipboard client component
- [ ] "Not configured" renders (in `--text-muted`) when an Entra value is `null`
- [ ] `MICROSOFT_CLIENT_SECRET` does not appear in any component prop, rendered output, or import

### Page

- [ ] `app/(admin)/administration/system-config/page.tsx` exists
- [ ] `export const dynamic = 'force-dynamic'` is present
- [ ] `export const metadata = { title: 'System Configuration — Enterprise Billing' }` is present
- [ ] `requirePermission(PERMISSIONS.SYSTEM_CONFIG, LEVELS.READ)` is called at the top before any data fetching
- [ ] `getSystemConfigParams()` is called to fetch DB rows
- [ ] Rows are passed through `groupConfigRows()` before being given to `ConfigTable`
- [ ] `entraConfig` is imported from `@/lib/config` (server-only module)
- [ ] Entra values are read from `entraConfig`, not from `SYSTEM_CONFIG` DB rows
- [ ] `MICROSOFT_CLIENT_SECRET` is never referenced or passed to any component
- [ ] Page renders correctly when `SYSTEM_CONFIG` has no non-secret rows (empty-state via `ConfigTable`)
- [ ] Page renders correctly when Entra is not configured: all three `EntraConfigRow` entries show "Not configured"
- [ ] No edit, create, or delete controls are rendered

### Route × level enforcement

- [ ] `system_config:READ` (ADMIN, who holds DELETE ⊃ READ): page renders; `requirePermission` returns context
- [ ] Any user without `system_config:READ` (no-grants user, MANAGER, USER in v1): redirected to `/no-access`
- [ ] Unauthenticated request: redirected to `/login`
- [ ] PENDING, DISABLED, or DELETED user: sessions deleted, redirected to `/login` (via `requirePermission` behavior from um06)

### Tests

- [ ] All repository unit tests pass (5 scenarios per §22.8.1)
- [ ] All service unit tests pass (3 scenarios per §22.8.2)
- [ ] All `groupConfigRows` unit tests pass (5 scenarios per §22.8.3)
- [ ] All `ConfigStatusBadge` unit tests pass (3 scenarios per §22.8.4)
- [ ] All `ConfigTable` unit tests pass (8 scenarios per §22.8.5)
- [ ] All page unit tests pass (4 scenarios per §22.8.6)
- [ ] All repository integration tests pass (5 scenarios per §22.8.7)
- [ ] All migration integration tests pass (8 assertions per §22.8.8)
- [ ] `vitest run` passes with no failures across all new test files

### Boundary enforcement

- [ ] `types/system-config.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `db/repositories/system-config.repository.ts` has no imports from `auth/**`, `services/**`, `app/**`, or `actions/**`
- [ ] `services/system-config/system-config-read.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `components/system-config/config-table.tsx` has no imports from `db/**` or `services/**`
- [ ] `app/(admin)/administration/system-config/page.tsx` does not import from `db/**` directly
- [ ] `lib/config.ts` (from um10) retains `'server-only'` — any client-side import fails at build time
- [ ] No `console.*` in any new or modified file — diagnostics via `lib/logger`
- [ ] `tsc --noEmit` clean across all new and modified files
- [ ] ESLint clean including import-boundary rules

### Scope guard

- [ ] No Server Actions were added — mutations are out of scope for this READ unit
- [ ] `SYSTEM_CONFIG` is not written to from any new code path in this unit (only the migration seed writes rows)
- [ ] No `SYSTEM_CONFIG_CHANGED` audit event is written
- [ ] No new `PERMISSIONS` rows were added via migration (the `system_config` row was seeded in um05)
- [ ] The um10 Entra SSO flow, login page, and `lib/config.ts` are unmodified by this unit
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
