# Spec: um24 — Audit Log viewer (READ)

- **Boundary:** APP
- **Dependencies:** Unit um06 (`requirePermission`, `PERMISSIONS`/`LEVELS` constants, `hasLevel`, `EffectivePermissionMap`); the accumulated `AUDIT_LOG` rows written by every prior unit (um03 onwards). No write paths or Server Actions are introduced; all prior `writeAuditEvent` and repository infrastructure is consumed as-is.
- **Source sections:** overview §"Pages — Administration" item 4 (Audit Log — read-only viewer, filterable by event type, actor, date range; `audit_log:READ`), §"Roles & Default Permission Seed" (`audit_log` is READ-max — no EDIT/DELETE level; log immutable for everyone), §"Audit Events" (all 20 event types), §"Data Model" (`AUDIT_LOG` columns); architecture §2 (folder ownership), §5 (enforcement contract), §6 (`audit_log:READ` required; READ-max); ui-context §3.7 (audit-event category color mapping → `AuditLogTable`). Invariants: **#3** (server-side auth), **#4** (deny by default), **#11** (audit log append-only; `audit_log` has no EDIT/DELETE level — no mutation path exists in this unit), **#14** (DB access only in `db/**`), **#20** (authz decisions never cached).

---

## Goal

Deliver a read-only `/administration/audit-log` page, gated at `audit_log:READ`, that renders the full `AUDIT_LOG` feed with server-side filtering by event type, actor, and date range; color-codes each row by event family; and exposes the before/after JSON detail for every entry.

---

## Design

### Page layout

The page follows the same chrome as the other three Administration pages: left nav, top bar, a `<main>` with `p-6` padding. The page heading is "Audit Log" (`--text-h1`, `--text-primary`). A muted subheading reads "A complete, immutable record of all system events." (`--text-body`, `--text-muted`).

Below the heading, the filter bar (`AuditLogFilters`) is a white card (`--surface-card`, `--shadow-sm`, `--radius-md`, `p-4`) spanning the full content width. The filter controls sit in a single responsive row that wraps at smaller viewports: **Event type** select → **Actor** select → **Date from** date input → **Date to** date input → **Apply** primary button → **Clear** ghost/outline button.

Below the filter card sits the `AuditLogTable` card (same card styling), which contains the table and, below it, the pagination row.

An empty state (no results matching filters) renders inside the table card with a centered `FileSearch` Lucide icon (`size-12`, `--text-disabled`), the text "No audit events found" (`--text-body`, `--text-muted`), and a "Clear filters" link that resets all URL params.

### Table columns and row design

The table (`w-full`, `text-sm`, `border-collapse`) has six visible columns:

| #   | Header        | Width    | Content                                                                                                                                                                                                                         |
| --- | ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | _(empty)_     | `w-2`    | 2 px left-border accent strip, colored by event category (see §3.7 token mapping below). Not a data cell — implemented as a pseudo-element or an absolutely-positioned `<div>` within the first `<td>`.                         |
| 2   | **Category**  | `w-28`   | `AuditEventCategoryBadge` — a pill chip (`--radius-pill`, `px-2 py-0.5`, `text-xs font-semibold`, `--text-overline` scale) using the `-bg`/`-fg` token pair for the row's event family.                                         |
| 3   | **Timestamp** | `w-44`   | `created_datetime` formatted as `YYYY-MM-DD HH:mm:ss UTC` (always UTC, no locale formatting), `font-mono text-xs`, `--text-muted`. Full ISO string in a `title` attribute for copy.                                             |
| 4   | **Event**     | flexible | `event_type` string (e.g. `USER_CREATED`), rendered in `font-mono text-xs --text-body`. No wrapping (`whitespace-nowrap`).                                                                                                      |
| 5   | **Actor**     | `w-40`   | `actor_user_id` resolved to `user_name`. If the actor row has since been tombstoned and `user_name` is unavailable (left-join null), display the raw `actor_user_id` in `font-mono --text-muted` with a `(deleted)` suffix.     |
| 6   | **Target**    | `w-48`   | `target_entity` + `target_id` on two lines: `target_entity` in `text-xs font-medium --text-body`; `target_id` in `font-mono text-xs --text-muted` truncated to 20 chars with `title` showing the full value.                    |
| 7   | **Detail**    | `w-10`   | A `ChevronDown` Lucide icon button (`size-4`, `--text-muted hover:--text-body`, `--radius-sm`, `p-1`, `aria-label="Show event detail"`) that expands an inline detail row. Rotates 180° when expanded (`transition-transform`). |

**Row styling:** `border-b border-[--border-subtle]`. Hover: `bg-[--color-neutral-50]`. The left-border strip in column 1 is the only color on the row itself — the category badge in column 2 provides the labeled, non-color-dependent identity of the family.

**Expanded detail row:** When the chevron is clicked, a full-width `<tr>` is inserted immediately after the parent row (no animation; instant). It contains a single `<td colSpan={7}` with `bg-[--surface-sunken] px-6 py-4`. Inside:

- A two-column grid (`grid grid-cols-2 gap-4`): **Before** and **After** panels.
- Each panel has a label (`text-xs font-semibold --text-muted uppercase tracking-wide mb-1`): "Before" / "After".
- The JSON is rendered in a `<pre className="text-xs font-mono --text-body whitespace-pre-wrap break-all bg-[--surface-card] rounded-[--radius-sm] p-3 border border-[--border-default] max-h-64 overflow-y-auto">` block.
- `JSON.stringify(value, null, 2)` is used for formatting. If `before_data` or `after_data` is `null`, the panel shows the string `"null"` in the same `<pre>` block. If the JSON value is not parseable (defensive), show the raw string.
- No diff highlighting in v1 — plain formatted JSON only.

### Event category color-coding

Per ui-context §3.7, the five categories map to status color families. Applied to both the left-border strip and the `AuditEventCategoryBadge`:

| Category | Events                                                                                                            | Left-border           | Badge `-bg`          | Badge `-fg`           |
| -------- | ----------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------- | --------------------- |
| Additive | `USER_CREATED`, `USER_ENABLED`, `ROLE_CREATED`, `ROLE_ASSIGNED`                                                   | `--color-success-500` | `--color-success-50` | `--color-success-700` |
| Change   | `USER_UPDATED`, `ROLE_UPDATED`, `PERMISSION_MAPPING_CHANGED`, `SYSTEM_CONFIG_CHANGED`, `USER_AUTH_METHOD_CHANGED` | `--color-info-500`    | `--color-info-50`    | `--color-info-700`    |
| Removal  | `USER_DISABLED`, `USER_DELETED`, `ROLE_DELETED`, `ROLE_REVOKED`                                                   | `--color-danger-500`  | `--color-danger-50`  | `--color-danger-700`  |
| Session  | `SSO_LOGIN`, `LOCAL_LOGIN`, `USER_FIRST_LOGIN`                                                                    | `--color-cyan-500`    | `--color-cyan-50`    | `--color-cyan-700`    |
| Security | `USER_LOCKED`, `USER_UNLOCKED`, `USER_PASSWORD_RESET`, `USER_PASSWORD_CHANGED`                                    | `--color-warning-500` | `--color-warning-50` | `--color-warning-700` |

The category label displayed in the badge is the category name in title case: "Additive", "Change", "Removal", "Session", "Security".

### Filter bar design

All five filter controls are horizontally aligned with `gap-3`. Each control has a `<label>` (visually hidden via `sr-only` — tooltips suffice in a dense bar) plus an `aria-label` on the control itself.

- **Event type** — `<select>` with `<optgroup>` per category. First option is `<option value="">All events</option>`. Under each `<optgroup label="Category Name">`, one `<option>` per event type (value = the `event_type` string, label = the same string). Width: `w-48`.
- **Actor** — `<select>` populated from `actors` prop (all APPUSER rows that appear as `actor_user_id` in any `AUDIT_LOG` row, joined to get `user_name`). First option: `<option value="">All actors</option>`. Each subsequent option: value = `user_id`, label = `user_name` (with `(deleted)` suffix if the user is tombstoned). Width: `w-44`.
- **Date from** — `<input type="date">` with `aria-label="From date"`. Width: `w-36`.
- **Date to** — `<input type="date">` with `aria-label="To date"`. Width: `w-36`.
- **Apply** — primary button (`--action-primary-bg`), label "Apply".
- **Clear** — outline/ghost button, label "Clear", visible only when any filter param is active in the current URL (i.e. `eventType`, `actorUserId`, `dateFrom`, or `dateTo` is non-empty in `searchParams`).

`AuditLogFilters` reads current values from `useSearchParams()` to pre-populate all controls on mount. On Apply, it calls `router.replace(pathname + '?' + newParams)` (not `push` — filter changes should not create history entries). On Clear, it calls `router.replace(pathname)`.

### Pagination

Below the table, a pagination row (`flex items-center justify-between pt-4 border-t border-[--border-subtle]`) shows:

- Left: "Showing X–Y of Z events" in `text-sm --text-muted`.
- Right: Previous (`ChevronLeft`) and Next (`ChevronRight`) icon buttons. Each button navigates via `router.replace` updating the `page` URL param. Disabled styling (`opacity-50 cursor-not-allowed`) when at the first or last page respectively.

Default page size: **50 rows** per page. `page` param is 1-indexed; defaults to `1`. Page size is fixed — no user-configurable control in v1.

Pagination controls are a `'use client'` component (`AuditLogPagination`) that reads `page` from `useSearchParams()` and the `total` / `pageSize` from props.

---

## Implementation

### 24.1 — Types (`types/audit-log.ts`)

New file. No imports from `auth/**`, `db/**`, `services/**`, or `next/*`.

```ts
export type AuditEventType =
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "USER_DELETED"
  | "USER_FIRST_LOGIN"
  | "ROLE_CREATED"
  | "ROLE_UPDATED"
  | "ROLE_DELETED"
  | "ROLE_ASSIGNED"
  | "ROLE_REVOKED"
  | "PERMISSION_MAPPING_CHANGED"
  | "SYSTEM_CONFIG_CHANGED"
  | "SSO_LOGIN"
  | "LOCAL_LOGIN"
  | "USER_PASSWORD_RESET"
  | "USER_PASSWORD_CHANGED"
  | "USER_LOCKED"
  | "USER_UNLOCKED"
  | "USER_AUTH_METHOD_CHANGED";

export type AuditEventCategory =
  | "Additive"
  | "Change"
  | "Removal"
  | "Session"
  | "Security";

export const AUDIT_EVENT_CATEGORY_MAP: Record<
  AuditEventType,
  AuditEventCategory
> = {
  USER_CREATED: "Additive",
  USER_ENABLED: "Additive",
  ROLE_CREATED: "Additive",
  ROLE_ASSIGNED: "Additive",
  USER_UPDATED: "Change",
  ROLE_UPDATED: "Change",
  PERMISSION_MAPPING_CHANGED: "Change",
  SYSTEM_CONFIG_CHANGED: "Change",
  USER_AUTH_METHOD_CHANGED: "Change",
  USER_DISABLED: "Removal",
  USER_DELETED: "Removal",
  ROLE_DELETED: "Removal",
  ROLE_REVOKED: "Removal",
  SSO_LOGIN: "Session",
  LOCAL_LOGIN: "Session",
  USER_FIRST_LOGIN: "Session",
  USER_LOCKED: "Security",
  USER_UNLOCKED: "Security",
  USER_PASSWORD_RESET: "Security",
  USER_PASSWORD_CHANGED: "Security",
};

export interface AuditLogRow {
  auditId: string;
  eventType: AuditEventType;
  category: AuditEventCategory;
  actorUserId: string;
  actorUserName: string | null; // null when actor has been tombstoned
  actorDeleted: boolean; // true when actor status = 'DELETED'
  targetEntity: string;
  targetId: string;
  beforeData: unknown; // parsed JSON or null
  afterData: unknown; // parsed JSON or null
  createdDatetime: Date;
}

export interface AuditLogFiltersInput {
  eventType: AuditEventType | null;
  actorUserId: string | null;
  dateFrom: Date | null; // inclusive; start of day UTC
  dateTo: Date | null; // inclusive; end of day UTC
}

export interface AuditLogPage {
  rows: AuditLogRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditLogActorOption {
  userId: string;
  userName: string | null;
  isDeleted: boolean;
}
```

### 24.2 — Validation schema (`validation/audit-log-filters.schema.ts`)

New file. Parses raw URL `searchParams` strings into typed filter values. No imports from `auth/**`, `db/**`, `services/**`, or `next/*`.

```ts
import { z } from "zod";
import { AUDIT_EVENT_TYPES, type AuditEventType } from "@/types/audit";

const eventTypeSchema = z
  .string()
  .refine((v): v is AuditEventType =>
    (AUDIT_EVENT_TYPES as readonly string[]).includes(v),
  )
  .nullable()
  .catch(null);

export const auditLogSearchParamsSchema = z.object({
  eventType: eventTypeSchema,
  actorUserId: z.string().uuid().nullable().catch(null),
  dateFrom: z.string().date().nullable().catch(null), // ISO date string YYYY-MM-DD
  dateTo: z.string().date().nullable().catch(null),
  page: z.coerce.number().int().min(1).catch(1),
});

export type AuditLogSearchParams = z.infer<typeof auditLogSearchParamsSchema>;
```

All fields are optional/nullable and fall back gracefully. An invalid `eventType` string (not in the 20-event set) is treated as `null` (no filter). An invalid UUID `actorUserId` is treated as `null`. An invalid date string is treated as `null`. A missing field is treated the same as an invalid one. This means a tampered or absent URL param never throws — the page simply loads unfiltered.

Parsing is done with `.parse()` (not `.safeParse()`) in the page: each field uses `.catch(<fallback>)` rather than `.default(<fallback>)`, so an invalid _or_ missing value for that field is replaced with the fallback at the point of failure — the call never throws and never needs an outer `safeParse`/`success` check. (`.default()` would only cover the missing-field case; an invalid-but-present value would still fail the parse.)

### 24.3 — Repository (`db/repositories/audit-log.repository.ts`)

New file. All imports from `drizzle-orm` and `db/schema`. No imports from `auth/**`, `services/**`, `app/**`, or `actions/**`.

**`findFiltered(filters: AuditLogFiltersInput, page: number, pageSize: number): Promise<{ rows: AuditLogRow[], total: number }>`**

Executes two queries in sequence (not a transaction — reads only): a `count` query for pagination, then a `select` query for the page data. Both share the same WHERE clause helper built from `filters`.

WHERE clause construction (using Drizzle's `and()`, `eq()`, `gte()`, `lte()`, `sql`):

- `eventType` present: `eq(auditLog.eventType, filters.eventType)`
- `actorUserId` present: `eq(auditLog.actorUserId, filters.actorUserId)`
- `dateFrom` present: `gte(auditLog.createdDatetime, filters.dateFrom)`
- `dateTo` present: `lte(auditLog.createdDatetime, filters.dateTo)` — `dateTo` is passed in as end-of-day (23:59:59.999 UTC) by the service, not raw date boundary
- All active clauses combined with `and()`

Select shape (left-joins `appuser` on `actorUserId = userId`):

```ts
{
  auditId:         auditLog.auditId,
  eventType:       auditLog.eventType,
  actorUserId:     auditLog.actorUserId,
  actorUserName:   appuser.userName,       // null if tombstoned or left-join miss
  actorStatus:     appuser.status,         // to derive actorDeleted
  targetEntity:    auditLog.targetEntity,
  targetId:        auditLog.targetId,
  beforeData:      auditLog.beforeData,
  afterData:       auditLog.afterData,
  createdDatetime: auditLog.createdDatetime,
}
```

Order: `desc(auditLog.createdDatetime)` — newest first.

Offset pagination: `.offset((page - 1) * pageSize).limit(pageSize)`.

The repository maps raw rows to `AuditLogRow[]`, computing `category` via `AUDIT_EVENT_CATEGORY_MAP[row.eventType]` and `actorDeleted` via `row.actorStatus === 'DELETED'`.

**`findActors(): Promise<AuditLogActorOption[]>`**

Returns all distinct `actor_user_id` values from `AUDIT_LOG` joined to `APPUSER` for the name and status. Used to populate the Actor filter dropdown. Ordered `asc(appuser.userName)` with tombstoned actors last (`nulls last` if `userName` is null).

```ts
const rows = await db
  .selectDistinct({
    userId: auditLog.actorUserId,
    userName: appuser.userName,
    status: appuser.status,
  })
  .from(auditLog)
  .leftJoin(appuser, eq(auditLog.actorUserId, appuser.userId))
  .orderBy(asc(appuser.userName));

return rows.map((r) => ({
  userId: r.userId,
  userName: r.userName,
  isDeleted: r.status === "DELETED",
}));
```

### 24.4 — Read service (`services/audit-log/audit-log-read.service.ts`)

New file. Framework-agnostic — no `next/*`, `app/**`, or `actions/**` imports.

**`getAuditLog(params: AuditLogSearchParams): Promise<AuditLogPage>`**

Converts the validated URL params into `AuditLogFiltersInput`:

- `dateFrom`: if non-null, `new Date(params.dateFrom + 'T00:00:00.000Z')` (start of day UTC)
- `dateTo`: if non-null, `new Date(params.dateTo + 'T23:59:59.999Z')` (end of day UTC)
- `eventType` and `actorUserId` passed through as-is (already validated)

Then calls `auditLogRepository.findFiltered(filters, params.page, PAGE_SIZE)` where `PAGE_SIZE = 50` (module-level constant).

Returns:

```ts
{
  rows: result.rows,
  total: result.total,
  page: params.page,
  pageSize: PAGE_SIZE,
}
```

**`getAuditLogActors(): Promise<AuditLogActorOption[]>`**

Thin wrapper: returns `auditLogRepository.findActors()`. Exists so the service boundary is preserved and tests mock the service, not the repository directly.

### 24.5 — Components

#### 24.5.1 — `AuditEventCategoryBadge` (`components/audit-log/audit-event-category-badge.tsx`)

Server Component (no `'use client'` — pure render, no state). Accepts `category: AuditEventCategory` as a prop and renders the pill badge. CSS variable tokens only — no hardcoded hex.

```ts
interface AuditEventCategoryBadgeProps {
  category: AuditEventCategory;
}
```

Token mapping (inline object — not a separate constant file since it's a leaf UI concern):

```ts
const CATEGORY_TOKENS: Record<AuditEventCategory, { bg: string; fg: string }> =
  {
    Additive: { bg: "var(--color-success-50)", fg: "var(--color-success-700)" },
    Change: { bg: "var(--color-info-50)", fg: "var(--color-info-700)" },
    Removal: { bg: "var(--color-danger-50)", fg: "var(--color-danger-700)" },
    Session: { bg: "var(--color-cyan-50)", fg: "var(--color-cyan-700)" },
    Security: { bg: "var(--color-warning-50)", fg: "var(--color-warning-700)" },
  };
```

Render: `<span style={{ backgroundColor: tokens.bg, color: tokens.fg }} className="inline-flex items-center px-2 py-0.5 rounded-[--radius-pill] text-[11px] font-semibold tracking-wide uppercase whitespace-nowrap">{category}</span>`.

#### 24.5.2 — `AuditLogFilters` (`components/audit-log/audit-log-filters.tsx`)

`'use client'`. Imports `useSearchParams`, `useRouter`, `usePathname` from `next/navigation`. No imports from `db/**` or `services/**`.

Props:

```ts
interface AuditLogFiltersProps {
  actors: AuditLogActorOption[];
}
```

The `EVENT_TYPE_OPTIONS` constant (grouped by category) is defined at module level inside this file:

```ts
const EVENT_TYPE_OPTIONS: {
  category: AuditEventCategory;
  events: AuditEventType[];
}[] = [
  {
    category: "Additive",
    events: ["USER_CREATED", "USER_ENABLED", "ROLE_CREATED", "ROLE_ASSIGNED"],
  },
  {
    category: "Change",
    events: [
      "USER_UPDATED",
      "ROLE_UPDATED",
      "PERMISSION_MAPPING_CHANGED",
      "SYSTEM_CONFIG_CHANGED",
      "USER_AUTH_METHOD_CHANGED",
    ],
  },
  {
    category: "Removal",
    events: ["USER_DISABLED", "USER_DELETED", "ROLE_DELETED", "ROLE_REVOKED"],
  },
  {
    category: "Session",
    events: ["SSO_LOGIN", "LOCAL_LOGIN", "USER_FIRST_LOGIN"],
  },
  {
    category: "Security",
    events: [
      "USER_LOCKED",
      "USER_UNLOCKED",
      "USER_PASSWORD_RESET",
      "USER_PASSWORD_CHANGED",
    ],
  },
];
```

Internal state: `useState` for each of the four filter field values (`eventType`, `actorUserId`, `dateFrom`, `dateTo`), initialized from `useSearchParams()` on mount via `useEffect` (or directly as `useState` initializer reading `searchParams.get(...) ?? ''`).

**`handleApply`**: builds a `URLSearchParams` object from the four field values (omitting empty strings), always resets `page` to `1`, then calls `router.replace(pathname + '?' + params.toString())`.

**`handleClear`**: sets all four state values to `''`, calls `router.replace(pathname)`.

The **Clear** button renders only when any of the four `searchParams` values is non-empty. Derive this from `useSearchParams()` directly (not from local state) so the button appears correctly after a page navigation.

Render:

```tsx
<div className="rounded-[--radius-md] bg-[--surface-card] p-4 shadow-[--shadow-sm]">
  <div className="flex flex-wrap items-end gap-3">
    {/* Event Type */}
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="filter-event-type">
        Event type
      </label>
      <select
        id="filter-event-type"
        aria-label="Event type"
        value={eventType}
        onChange={(e) => setEventType(e.target.value)}
        className="h-9 w-48 rounded-[--radius-sm] border border-[--border-strong] bg-[--surface-card] px-3 text-sm text-[--text-body] focus:ring-2 focus:ring-[--border-focus] focus:outline-none"
      >
        <option value="">All events</option>
        {EVENT_TYPE_OPTIONS.map((group) => (
          <optgroup key={group.category} label={group.category}>
            {group.events.map((et) => (
              <option key={et} value={et}>
                {et}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>

    {/* Actor */}
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="filter-actor">
        Actor
      </label>
      <select
        id="filter-actor"
        aria-label="Actor"
        value={actorUserId}
        onChange={(e) => setActorUserId(e.target.value)}
        className="h-9 w-44 rounded-[--radius-sm] border border-[--border-strong] bg-[--surface-card] px-3 text-sm text-[--text-body] focus:ring-2 focus:ring-[--border-focus] focus:outline-none"
      >
        <option value="">All actors</option>
        {actors.map((a) => (
          <option key={a.userId} value={a.userId}>
            {a.userName ?? a.userId}
            {a.isDeleted ? " (deleted)" : ""}
          </option>
        ))}
      </select>
    </div>

    {/* Date From */}
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="filter-date-from">
        From date
      </label>
      <input
        id="filter-date-from"
        type="date"
        aria-label="From date"
        value={dateFrom}
        onChange={(e) => setDateFrom(e.target.value)}
        className="h-9 w-36 rounded-[--radius-sm] border border-[--border-strong] bg-[--surface-card] px-3 text-sm text-[--text-body] focus:ring-2 focus:ring-[--border-focus] focus:outline-none"
      />
    </div>

    {/* Date To */}
    <div className="flex flex-col gap-1">
      <label className="sr-only" htmlFor="filter-date-to">
        To date
      </label>
      <input
        id="filter-date-to"
        type="date"
        aria-label="To date"
        value={dateTo}
        onChange={(e) => setDateTo(e.target.value)}
        className="h-9 w-36 rounded-[--radius-sm] border border-[--border-strong] bg-[--surface-card] px-3 text-sm text-[--text-body] focus:ring-2 focus:ring-[--border-focus] focus:outline-none"
      />
    </div>

    {/* Actions */}
    <Button onClick={handleApply}>Apply</Button>
    {hasActiveFilters && (
      <Button variant="outline" onClick={handleClear}>
        Clear
      </Button>
    )}
  </div>
</div>
```

`hasActiveFilters` is derived from the current `useSearchParams()`, not from local state, to survive page refreshes:

```ts
const sp = useSearchParams();
const hasActiveFilters = [
  "eventType",
  "actorUserId",
  "dateFrom",
  "dateTo",
].some((k) => !!sp.get(k));
```

#### 24.5.3 — `AuditLogTable` (`components/audit-log/audit-log-table.tsx`)

`'use client'`. Manages expand/collapse state per row. No data fetching — receives `rows: AuditLogRow[]` as a prop.

Internal state:

```ts
const [expanded, setExpanded] = useState<Set<string>>(new Set());

function toggleRow(auditId: string) {
  setExpanded((prev) => {
    const next = new Set(prev);
    next.has(auditId) ? next.delete(auditId) : next.add(auditId);
    return next;
  });
}
```

Renders a `<table className="w-full border-collapse text-sm">` with `<thead>` and `<tbody>`. Column headers (`py-3 px-4 text-left text-xs font-semibold text-[--text-muted] uppercase tracking-wide bg-[--surface-sunken] border-b border-[--border-default]`):

- Column 1: no header, `w-2`, no padding
- Column 2: "Category", `w-28`
- Column 3: "Timestamp", `w-44`
- Column 4: "Event"
- Column 5: "Actor", `w-40`
- Column 6: "Target", `w-48`
- Column 7: _(empty — expand toggle)_, `w-10`, `text-right`

For each `row` in `rows`, two `<tr>` elements are rendered:

**Primary `<tr>` (always visible):**

```tsx
<tr
  key={row.auditId}
  className="border-b border-[--border-subtle] hover:bg-[--color-neutral-50]"
>
  {/* Col 1: left-border accent strip */}
  <td
    className="w-2 p-0"
    aria-hidden="true"
    style={{ backgroundColor: CATEGORY_BORDER_COLORS[row.category] }}
  />

  {/* Col 2: category badge */}
  <td className="px-4 py-3">
    <AuditEventCategoryBadge category={row.category} />
  </td>

  {/* Col 3: timestamp */}
  <td
    className="px-4 py-3 whitespace-nowrap"
    title={row.createdDatetime.toISOString()}
  >
    <span className="font-mono text-xs text-[--text-muted]">
      {formatAuditTimestamp(row.createdDatetime)}
    </span>
  </td>

  {/* Col 4: event type */}
  <td className="px-4 py-3 whitespace-nowrap">
    <span className="font-mono text-xs text-[--text-body]">
      {row.eventType}
    </span>
  </td>

  {/* Col 5: actor */}
  <td className="px-4 py-3">
    {row.actorUserName && !row.actorDeleted ? (
      <span className="text-sm text-[--text-body]">{row.actorUserName}</span>
    ) : row.actorUserName && row.actorDeleted ? (
      <span className="text-sm text-[--text-muted]">
        {row.actorUserName} <span className="text-xs">(deleted)</span>
      </span>
    ) : (
      <span
        className="font-mono text-xs text-[--text-muted]"
        title={row.actorUserId}
      >
        {row.actorUserId.slice(0, 8)}… (deleted)
      </span>
    )}
  </td>

  {/* Col 6: target */}
  <td className="px-4 py-3">
    <div className="text-xs font-medium text-[--text-body]">
      {row.targetEntity}
    </div>
    <div
      className="max-w-[180px] truncate font-mono text-xs text-[--text-muted]"
      title={row.targetId}
    >
      {row.targetId}
    </div>
  </td>

  {/* Col 7: expand toggle */}
  <td className="px-4 py-3 text-right">
    <button
      type="button"
      onClick={() => toggleRow(row.auditId)}
      aria-label={
        expanded.has(row.auditId) ? "Hide event detail" : "Show event detail"
      }
      aria-expanded={expanded.has(row.auditId)}
      className="rounded-[--radius-sm] p-1 text-[--text-muted] hover:text-[--text-body] focus-visible:ring-2 focus-visible:ring-[--border-focus] focus-visible:outline-none"
    >
      <ChevronDown
        className={`size-4 transition-transform duration-150 ${expanded.has(row.auditId) ? "rotate-180" : ""}`}
      />
    </button>
  </td>
</tr>
```

`CATEGORY_BORDER_COLORS` is a module-level constant:

```ts
const CATEGORY_BORDER_COLORS: Record<AuditEventCategory, string> = {
  Additive: "var(--color-success-500)",
  Change: "var(--color-info-500)",
  Removal: "var(--color-danger-500)",
  Session: "var(--color-cyan-500)",
  Security: "var(--color-warning-500)",
};
```

`formatAuditTimestamp(date: Date): string` is a module-level helper:

```ts
function formatAuditTimestamp(date: Date): string {
  return (
    date
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "") + " UTC"
  );
  // e.g. "2026-06-17 09:14:22 UTC"
}
```

**Expanded detail `<tr>` (conditionally rendered immediately after primary row):**

```tsx
{
  expanded.has(row.auditId) && (
    <tr key={`${row.auditId}-detail`}>
      <td
        colSpan={7}
        className="border-b border-[--border-subtle] bg-[--surface-sunken] px-6 py-4"
      >
        <div className="grid grid-cols-2 gap-4">
          {(["Before", "After"] as const).map((label) => {
            const value = label === "Before" ? row.beforeData : row.afterData;
            return (
              <div key={label}>
                <div className="mb-1 text-xs font-semibold tracking-wide text-[--text-muted] uppercase">
                  {label}
                </div>
                <pre className="max-h-64 overflow-y-auto rounded-[--radius-sm] border border-[--border-default] bg-[--surface-card] p-3 font-mono text-xs break-all whitespace-pre-wrap text-[--text-body]">
                  {value !== null && value !== undefined
                    ? JSON.stringify(value, null, 2)
                    : "null"}
                </pre>
              </div>
            );
          })}
        </div>
      </td>
    </tr>
  );
}
```

**Empty state** (when `rows.length === 0`): renders a single `<tr>` with `<td colSpan={7}>` containing a centered column layout:

```tsx
<tr>
  <td colSpan={7} className="py-16 text-center">
    <FileSearch className="mx-auto mb-3 size-12 text-[--text-disabled]" />
    <p className="text-sm text-[--text-muted]">No audit events found</p>
  </td>
</tr>
```

`AuditEventCategoryBadge` is imported from `components/audit-log/audit-event-category-badge.tsx`. This Client Component renders a Server Component inside it — which is valid because `AuditEventCategoryBadge` has no server-only imports and can be imported by a Client Component.

#### 24.5.4 — `AuditLogPagination` (`components/audit-log/audit-log-pagination.tsx`)

`'use client'`. Props:

```ts
interface AuditLogPaginationProps {
  total: number;
  page: number;
  pageSize: number;
}
```

```ts
const totalPages = Math.ceil(total / pageSize);
const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
const end = Math.min(page * pageSize, total);
```

Uses `useRouter`, `usePathname`, `useSearchParams` to navigate. On Previous/Next click, calls `router.replace(pathname + '?' + newParams)` where `newParams` copies the current search params and sets `page` to the new value.

Render:

```tsx
<div className="flex items-center justify-between border-t border-[--border-subtle] pt-4">
  <span className="text-sm text-[--text-muted]">
    Showing {start}–{end} of {total} events
  </span>
  <div className="flex items-center gap-1">
    <button
      type="button"
      onClick={handlePrev}
      disabled={page <= 1}
      aria-label="Previous page"
      className="rounded-[--radius-sm] p-1 text-[--text-muted] hover:text-[--text-body] focus-visible:ring-2 focus-visible:ring-[--border-focus] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ChevronLeft className="size-4" />
    </button>
    <span className="px-2 text-sm text-[--text-muted]">
      Page {page} of {totalPages || 1}
    </span>
    <button
      type="button"
      onClick={handleNext}
      disabled={page >= totalPages}
      aria-label="Next page"
      className="rounded-[--radius-sm] p-1 text-[--text-muted] hover:text-[--text-body] focus-visible:ring-2 focus-visible:ring-[--border-focus] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
    >
      <ChevronRight className="size-4" />
    </button>
  </div>
</div>
```

### 24.6 — Page (`app/(admin)/administration/audit-log/page.tsx`)

Async Server Component. `'use server'` is NOT added — this is a Next.js page, not a Server Action.

```ts
import type { Metadata } from 'next'
import { requirePermission } from '@/auth'
import { PERMISSIONS, LEVELS } from '@/auth'
import { auditLogSearchParamsSchema } from '@/validation/audit-log-filters.schema'
import { getAuditLog, getAuditLogActors } from '@/services/audit-log/audit-log-read.service'
import { AuditLogFilters }    from '@/components/audit-log/audit-log-filters'
import { AuditLogTable }      from '@/components/audit-log/audit-log-table'
import { AuditLogPagination } from '@/components/audit-log/audit-log-pagination'
import { Suspense } from 'react'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Audit Log | Administration',
}

interface Props {
  searchParams: Record<string, string | string[] | undefined>
}

export default async function AuditLogPage({ searchParams }: Props) {
  await requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.READ)
  // requirePermission redirects to /login if unauthenticated;
  // returns void (or redirects to /no-access) if insufficient level.
  // Since audit_log is READ-max, READ is the only valid level check here.

  // Parse search params leniently — invalid values fall back to defaults
  const rawParams = {
    eventType:   searchParams.eventType   as string | undefined,
    actorUserId: searchParams.actorUserId as string | undefined,
    dateFrom:    searchParams.dateFrom    as string | undefined,
    dateTo:      searchParams.dateTo      as string | undefined,
    page:        searchParams.page        as string | undefined,
  }
  const parsed = auditLogSearchParamsSchema.parse({
    eventType:   rawParams.eventType   ?? null,
    actorUserId: rawParams.actorUserId ?? null,
    dateFrom:    rawParams.dateFrom    ?? null,
    dateTo:      rawParams.dateTo      ?? null,
    page:        rawParams.page        ?? 1,
  })

  const [auditPage, actors] = await Promise.all([
    getAuditLog(parsed),
    getAuditLogActors(),
  ])

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-[--text-h1] font-semibold text-[--text-primary]">Audit Log</h1>
        <p className="mt-1 text-sm text-[--text-muted]">
          A complete, immutable record of all system events.
        </p>
      </div>

      <Suspense>
        <AuditLogFilters actors={actors} />
      </Suspense>

      <div className="bg-[--surface-card] rounded-[--radius-md] shadow-[--shadow-sm] overflow-hidden">
        <AuditLogTable rows={auditPage.rows} />
        {auditPage.total > 0 && (
          <div className="px-4 pb-4">
            <Suspense>
              <AuditLogPagination
                total={auditPage.total}
                page={auditPage.page}
                pageSize={auditPage.pageSize}
              />
            </Suspense>
          </div>
        )}
      </div>
    </main>
  )
}
```

`AuditLogFilters` and `AuditLogPagination` use `useSearchParams()` internally, which requires them to be wrapped in `<Suspense>` at the RSC boundary (Next.js requirement for Client Components reading search params in static rendering contexts; `force-dynamic` makes this less critical but the Suspense wrapper is correct practice).

`requirePermission` for a READ-level page returns without a value (or redirects); the page proceeds normally. No `permissionMap` is needed beyond the guard — there are no conditional mutations to show/hide.

---

## Dependencies

No new npm packages. All required packages are already installed from prior units:

- `drizzle-orm` — `and()`, `eq()`, `gte()`, `lte()`, `desc()`, `asc()`, `selectDistinct()` — for repository queries.
- `next` — `useRouter`, `usePathname`, `useSearchParams` in client components; `Metadata` type on the page.
- `react` — `useState`, `Suspense` in client components.
- `zod` — `auditLogSearchParamsSchema` in `validation/audit-log-filters.schema.ts`.
- `lucide-react` — `ChevronDown`, `ChevronLeft`, `ChevronRight`, `FileSearch` — already installed.
- shadcn `Button` — already installed.
- `vitest`, `@testing-library/react` — already installed.

No new schema migrations. No new `PERMISSIONS` rows — the `audit_log` permission row was seeded in um05. No Server Actions (this unit introduces no mutations).

---

## Verification Checklist

### Types

- [ ] `AuditEventType` union covers all 20 event types from the overview §"Audit Events" exactly — no additions, no omissions
- [ ] `AUDIT_EVENT_CATEGORY_MAP` covers all 20 event types; each maps to exactly one of the five `AuditEventCategory` values
- [ ] `AuditLogRow` includes `category`, `actorDeleted`, and typed `beforeData`/`afterData` as `unknown` (not `any`)
- [ ] `AuditLogFiltersInput` uses `Date | null` (not string) for `dateFrom`/`dateTo`
- [ ] `AuditLogPage` includes `total`, `page`, `pageSize` alongside `rows`
- [ ] `AuditLogActorOption` includes `isDeleted` boolean
- [ ] `types/audit-log.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`

### Validation schema

- [ ] `auditLogSearchParamsSchema` is in `validation/audit-log-filters.schema.ts`
- [ ] Invalid `eventType` (not in the 20-event set) is coerced to `null` (parse does not throw)
- [ ] Invalid UUID `actorUserId` is coerced to `null` (parse does not throw)
- [ ] Invalid date strings for `dateFrom`/`dateTo` are coerced to `null` (parse does not throw)
- [ ] `page` coerced to integer, minimum 1, defaults to 1
- [ ] All fields optional/nullable — a completely empty object (bare page load) parses to all-null filters and `page: 1`
- [ ] `AuditLogSearchParams` type exported
- [ ] No imports from `auth/**`, `db/**`, `services/**`, or `next/*`

### Repository

- [ ] `auditLogRepository.findFiltered` is in `db/repositories/audit-log.repository.ts`
- [ ] Left-joins `APPUSER` on `actor_user_id = user_id` to resolve `actorUserName` and `actorStatus`
- [ ] Null `actorUserName` (tombstoned actor — left-join miss) is handled without throwing
- [ ] WHERE clause correctly applies each non-null filter: `eq` for `eventType` and `actorUserId`; `gte` for `dateFrom`; `lte` for `dateTo`
- [ ] `dateTo` filter uses end-of-day UTC boundary (set by the service, not the repository)
- [ ] Results ordered `desc(createdDatetime)` — newest first
- [ ] Offset pagination: `offset((page - 1) * pageSize).limit(pageSize)` applied correctly
- [ ] `total` count query uses the same WHERE clause as the data query
- [ ] Repository maps `actorStatus === 'DELETED'` to `actorDeleted: boolean`
- [ ] Repository maps `AUDIT_EVENT_CATEGORY_MAP[row.eventType]` to `category` on each row
- [ ] `findActors` returns distinct actors ordered by `userName` ascending; tombstoned actors (null name) appear last
- [ ] No imports from `auth/**`, `services/**`, `app/**`, or `actions/**`
- [ ] No `UPDATE` or `DELETE` queries on `AUDIT_LOG` (append-only; no mutation paths in this unit)

### Read service

- [ ] `getAuditLog` converts `dateFrom` string to start-of-day UTC (`T00:00:00.000Z`)
- [ ] `getAuditLog` converts `dateTo` string to end-of-day UTC (`T23:59:59.999Z`)
- [ ] `PAGE_SIZE` constant is `50` and is not user-configurable
- [ ] Returns `{ rows, total, page, pageSize }` matching `AuditLogPage` type
- [ ] `getAuditLogActors` is a thin wrapper over `findActors()` — no business logic
- [ ] No imports from `next/*`, `app/**`, or `actions/**`
- [ ] No write operations (no calls to `writeAuditEvent` or any repository mutator)

### `AuditEventCategoryBadge`

- [ ] Server Component — no `'use client'` directive
- [ ] Renders a pill (`--radius-pill`) with the category name in `uppercase tracking-wide` style
- [ ] Uses CSS variable tokens exclusively — no hardcoded hex values
- [ ] All five categories render with the correct `-bg` and `-fg` token pair per §3.7 of ui-context
- [ ] No imports from `db/**` or `services/**`

### `AuditLogFilters`

- [ ] `'use client'` directive present
- [ ] Event type `<select>` uses `<optgroup>` per category; first option is "All events" (value `""`)
- [ ] All 20 event types appear as `<option>` elements under the correct `<optgroup>`
- [ ] Actor `<select>` renders one option per actor from the `actors` prop; first option is "All actors" (value `""`)
- [ ] Tombstoned actors display `(deleted)` suffix in the option label
- [ ] Date From and Date To are `<input type="date">` with appropriate `aria-label`
- [ ] All four controls are pre-populated from `useSearchParams()` on mount
- [ ] Apply calls `router.replace` with all four params (empty strings omitted) and `page` reset to `1`
- [ ] Clear calls `router.replace(pathname)` and resets all four local state values to `''`
- [ ] Clear button is only visible when at least one of the four filter URL params is non-empty (derived from `useSearchParams()`, not local state)
- [ ] No imports from `db/**` or `services/**`
- [ ] No hardcoded hex values

### `AuditLogTable`

- [ ] `'use client'` directive present
- [ ] Column 1 is a 2px-wide strip cell (`w-2 p-0`) whose `backgroundColor` is set via inline `style` using `CATEGORY_BORDER_COLORS[row.category]`
- [ ] `CATEGORY_BORDER_COLORS` uses CSS variable strings (`var(--color-success-500)` etc.), not hardcoded hex
- [ ] Column 2 renders `<AuditEventCategoryBadge category={row.category} />`
- [ ] Column 3 renders `formatAuditTimestamp(row.createdDatetime)` in `font-mono text-xs` with full ISO string in `title` attribute
- [ ] `formatAuditTimestamp` produces `"YYYY-MM-DD HH:mm:ss UTC"` format (no milliseconds, no "T" separator)
- [ ] Column 4 renders `row.eventType` in `font-mono text-xs` with `whitespace-nowrap`
- [ ] Column 5 actor cell: active non-deleted → `user_name`; deleted with name → name + "(deleted)"; deleted without name → truncated UUID + "(deleted)"
- [ ] Column 6 target cell: `target_entity` on first line; `target_id` truncated with `title` on second line
- [ ] Column 7 chevron button has `aria-label="Show event detail"` / `"Hide event detail"` toggling with `aria-expanded`
- [ ] Chevron rotates 180° when row is expanded (`rotate-180` Tailwind class applied conditionally)
- [ ] Expanded detail row spans all 7 columns (`colSpan={7}`)
- [ ] Expanded detail renders a two-column grid: "Before" and "After" panels
- [ ] Each panel renders `JSON.stringify(value, null, 2)` in a `<pre>` block with `font-mono text-xs`
- [ ] `null` `before_data` / `after_data` renders the string `"null"` in the `<pre>` block (not an empty block)
- [ ] `<pre>` block has `max-h-64 overflow-y-auto` to prevent runaway tall rows
- [ ] Empty state (zero rows): renders `FileSearch` icon + "No audit events found" message spanning all 7 columns
- [ ] No imports from `db/**` or `services/**`
- [ ] No hardcoded hex values — CSS variable tokens only

### `AuditLogPagination`

- [ ] `'use client'` directive present
- [ ] "Showing X–Y of Z events" label is correct at first page, middle page, last page, and zero-result state
- [ ] Previous button disabled when `page <= 1`
- [ ] Next button disabled when `page >= totalPages`
- [ ] Previous/Next navigation calls `router.replace` with the updated `page` param, preserving all other search params
- [ ] `totalPages` computed as `Math.ceil(total / pageSize)` — handles zero-total edge case
- [ ] No imports from `db/**` or `services/**`

### Page

- [ ] Route is `app/(admin)/administration/audit-log/page.tsx`
- [ ] `export const dynamic = 'force-dynamic'` is set
- [ ] `metadata.title` is `'Audit Log | Administration'`
- [ ] `requirePermission(PERMISSIONS.AUDIT_LOG, LEVELS.READ)` is called — `LEVELS.READ` specifically, not EDIT or DELETE (audit_log is READ-max)
- [ ] `getAuditLog` and `getAuditLogActors` are called concurrently with `Promise.all`
- [ ] `AuditLogFilters` and `AuditLogPagination` are wrapped in `<Suspense>` (required for `useSearchParams` in client components)
- [ ] Pagination row is not rendered when `auditPage.total === 0`
- [ ] `searchParams` values are normalized: `undefined` → `null` before passing to the schema; string arrays are not forwarded (only the first value is used if present)
- [ ] Page does not import from `db/**` directly
- [ ] No Server Actions defined or imported on this page

### Permission guard

- [ ] `requirePermission` with `LEVELS.READ` is the guard — not EDIT or DELETE
- [ ] Unauthenticated request → redirect to `/login`
- [ ] Authenticated user without `audit_log:READ` → redirect to `/no-access`
- [ ] `audit_log` permission has no EDIT or DELETE level — the guard call with `LEVELS.READ` is the only valid permission check for this route (invariant #11: audit_log is READ-max)
- [ ] No mutation paths exist on this page (no Server Actions, no form submissions, no route handlers that write)

### Color coding

- [ ] All 20 event types are covered by `AUDIT_EVENT_CATEGORY_MAP` with no gaps
- [ ] Category-to-color assignments exactly match ui-context §3.7:
  - Additive → success (green)
  - Change → info (blue)
  - Removal → danger (red)
  - Session → cyan
  - Security → warning (amber)
- [ ] Both the left-border strip and `AuditEventCategoryBadge` use the same category for a given row
- [ ] Category badge uses `-bg` tint for background and `-fg` for text (not white-on-tint — per ui-context §8)

### Filter behavior

- [ ] Applying filters resets `page` to `1`
- [ ] Filter values survive a page refresh (stored in URL, not only in component state)
- [ ] Clearing filters removes all four filter params and `page` from the URL
- [ ] An invalid `eventType` in the URL (tampered or stale) does not cause a 500 — falls back to "All events"
- [ ] An invalid UUID `actorUserId` in the URL does not cause a 500 — falls back to "All actors"
- [ ] A malformed date in `dateFrom`/`dateTo` does not cause a 500 — falls back to no date filter
- [ ] `dateFrom` boundary is start-of-day UTC; `dateTo` boundary is end-of-day UTC (events on the `dateTo` date are included)

### Tests

#### Unit — validation schema (`tests/validation/audit-log-filters.schema.test.ts`)

| Scenario                             | Expected                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------- |
| All fields absent (bare page load)   | Parses to `{ eventType: null, actorUserId: null, dateFrom: null, dateTo: null, page: 1 }` |
| Valid `eventType` (`USER_CREATED`)   | `eventType = 'USER_CREATED'`                                                              |
| Invalid `eventType` (`FAKE_EVENT`)   | `eventType = null`                                                                        |
| Valid UUID `actorUserId`             | `actorUserId = <uuid>`                                                                    |
| Invalid `actorUserId` (`not-a-uuid`) | `actorUserId = null`                                                                      |
| Valid `dateFrom` (`2026-01-01`)      | `dateFrom = '2026-01-01'`                                                                 |
| Invalid `dateFrom` (`not-a-date`)    | `dateFrom = null`                                                                         |
| `page = '3'`                         | `page = 3` (coerced to integer)                                                           |
| `page = '0'`                         | Fails min(1) → parse error or coerces to 1 (verify consistent behavior)                   |
| `page` absent                        | `page = 1`                                                                                |

#### Integration — repository (`tests/db/audit-log-repository.integration.test.ts`)

| Scenario                                                         | Expected                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| `findFiltered` — no filters                                      | Returns all rows ordered newest-first                         |
| `findFiltered` — `eventType` filter                              | Only rows with matching `eventType` returned                  |
| `findFiltered` — `actorUserId` filter                            | Only rows with matching `actorUserId` returned                |
| `findFiltered` — `dateFrom` filter                               | Only rows with `createdDatetime >= dateFrom` returned         |
| `findFiltered` — `dateTo` filter                                 | Only rows with `createdDatetime <= dateTo` returned           |
| `findFiltered` — all filters combined                            | AND logic: only rows matching all four criteria               |
| `findFiltered` — page 2, pageSize 50                             | `offset(50)` applied; returns second page                     |
| `findFiltered` — actor tombstoned                                | Left-join miss: `actorUserName = null`, `actorDeleted = true` |
| `findFiltered` — maps `category` from `AUDIT_EVENT_CATEGORY_MAP` | `category` field present and correct for each row             |
| `findFiltered` — zero results                                    | Returns `{ rows: [], total: 0 }`                              |
| `findActors` — multiple distinct actors                          | Returns one entry per distinct actor, ordered by name asc     |
| `findActors` — tombstoned actor                                  | Included; `isDeleted = true`                                  |

#### Unit — read service (`tests/services/audit-log-read.service.test.ts`)

| Scenario                     | Expected                                                   |
| ---------------------------- | ---------------------------------------------------------- |
| `dateFrom = '2026-01-15'`    | `findFiltered` receives `Date('2026-01-15T00:00:00.000Z')` |
| `dateTo = '2026-01-20'`      | `findFiltered` receives `Date('2026-01-20T23:59:59.999Z')` |
| `dateFrom = null`            | `findFiltered` receives `dateFrom: null`                   |
| Returns `AuditLogPage` shape | `{ rows, total, page, pageSize: 50 }`                      |
| `page = 3`                   | `findFiltered` called with `page = 3`                      |
| `getAuditLogActors`          | Delegates to `findActors()`                                |

#### Unit — `AuditEventCategoryBadge` (`tests/components/audit-event-category-badge.test.tsx`)

| Scenario                    | Expected                                                                     |
| --------------------------- | ---------------------------------------------------------------------------- |
| Renders "Additive"          | Badge with text "Additive"; `style.backgroundColor` contains `success` token |
| Renders "Removal"           | Badge with text "Removal"; `style.backgroundColor` contains `danger` token   |
| Renders all five categories | Each renders correct label; no throws                                        |

#### Unit — `AuditLogFilters` (`tests/components/audit-log-filters.test.tsx`)

| Scenario                                            | Expected                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Renders without filters active                      | All selects at default ("All events", "All actors"); date inputs empty; no Clear button |
| Apply with event type selected                      | `router.replace` called with `eventType=USER_CREATED&page=1`                            |
| Apply resets page to 1                              | Even if current URL has `page=3`, Apply resets to `page=1`                              |
| Clear button appears when `eventType` in URL        | Clear button rendered                                                                   |
| Clear button calls `router.replace(pathname)`       | No filter params in URL after clear                                                     |
| Actor dropdown renders tombstoned actor with suffix | Option text contains "(deleted)"                                                        |
| All 20 event types appear in the select             | Each in the correct `<optgroup>`                                                        |

#### Unit — `AuditLogTable` (`tests/components/audit-log-table.test.tsx`)

| Scenario                             | Expected                                                     |
| ------------------------------------ | ------------------------------------------------------------ |
| Empty `rows` array                   | Empty state rendered with `FileSearch` icon and message      |
| Renders a row                        | Six visible cells; chevron button present                    |
| Active non-deleted actor             | `user_name` rendered in actor column                         |
| Deleted actor with name              | Name + "(deleted)" text                                      |
| Deleted actor without name           | Truncated UUID + "(deleted)"                                 |
| Click chevron on row                 | Detail row appears; `aria-expanded="true"`                   |
| Click chevron again                  | Detail row collapses; `aria-expanded="false"`                |
| Detail row — non-null `before_data`  | JSON-stringified content in Before `<pre>`                   |
| Detail row — null `before_data`      | String `"null"` in Before `<pre>`                            |
| Multiple rows expanded independently | Each row tracks own expand state                             |
| `formatAuditTimestamp` output        | `"2026-06-17 09:14:22 UTC"` format (no "T", no milliseconds) |

#### Unit — `AuditLogPagination` (`tests/components/audit-log-pagination.test.tsx`)

| Scenario       | Expected                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Page 1 of 3    | Previous disabled; Next enabled; "Showing 1–50 of 120 events"           |
| Page 2 of 3    | Both enabled; "Showing 51–100 of 120 events"                            |
| Page 3 of 3    | Previous enabled; Next disabled; "Showing 101–120 of 120 events"        |
| Zero results   | "Showing 0–0 of 0 events"; both buttons disabled                        |
| Next click     | `router.replace` called with `page=<current+1>`, other params preserved |
| Previous click | `router.replace` called with `page=<current-1>`, other params preserved |

#### Unit — page (`tests/app/audit-log-page.test.tsx`)

| Scenario                          | Expected                                                           |
| --------------------------------- | ------------------------------------------------------------------ |
| No session                        | `requirePermission` redirects to `/login`                          |
| User without `audit_log:READ`     | `requirePermission` redirects to `/no-access`                      |
| Valid session with READ           | `getAuditLog` and `getAuditLogActors` called; page renders         |
| `searchParams.page = '2'`         | `getAuditLog` receives `page: 2`                                   |
| `searchParams.eventType = 'FAKE'` | Schema coerces to `null`; `getAuditLog` receives `eventType: null` |
| `auditPage.total = 0`             | `AuditLogPagination` not rendered                                  |

#### Integration — repository (`tests/integration/db/audit-log.repository.test.ts`)

Uses test DB with all prior migrations applied (has real `AUDIT_LOG` rows from seeded actions).

| Scenario                                                            | Expected                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `findFiltered` — no filters — returns all rows ordered newest-first | `rows[0].createdDatetime >= rows[1].createdDatetime`               |
| `findFiltered` — `eventType = 'USER_CREATED'`                       | All returned rows have `eventType = 'USER_CREATED'`                |
| `findFiltered` — `actorUserId = admin_uuid`                         | All rows have `actorUserId = admin_uuid`                           |
| `findFiltered` — `dateFrom` yesterday                               | No rows older than yesterday returned                              |
| `findFiltered` — `dateTo` yesterday, `dateFrom` two days ago        | Only rows in that window returned                                  |
| `findFiltered` page 2 — fewer rows than offset                      | `rows` is empty; `total` still reflects full count                 |
| `findActors` — all actors in the log                                | Returns one entry per distinct actor with correct `isDeleted` flag |

#### Integration — page guard (`tests/integration/app/audit-log-guard.test.ts`)

| Session                           | Expected                                               |
| --------------------------------- | ------------------------------------------------------ |
| Admin user (has `audit_log:READ`) | Page renders; `getAuditLog` receives validated filters |
| User with no grants               | Redirects to `/no-access`                              |
| No session                        | Redirects to `/login`                                  |

### Boundary enforcement

- [ ] `validation/audit-log-filters.schema.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `services/audit-log/audit-log-read.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] `components/audit-log/*.tsx` files have no imports from `db/**` or `services/**`
- [ ] `app/(admin)/administration/audit-log/page.tsx` has no direct imports from `db/**`
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] `tsc --noEmit` clean across all new files
- [ ] ESLint clean including import-boundary rules

### Scope guard

- [ ] No Server Actions defined or imported in this unit — it is READ-only
- [ ] No `UPDATE` or `DELETE` SQL on `AUDIT_LOG` in any new file
- [ ] No new `PERMISSIONS` migration rows — `audit_log` was seeded in um05
- [ ] No new schema migrations — `AUDIT_LOG` table was created in um03
- [ ] `audit_log` permission level check uses `LEVELS.READ` — not `LEVELS.EDIT` or `LEVELS.DELETE` (audit_log is READ-max per Invariant #11 and the permission seed matrix)
- [ ] No "Export" / CSV-download feature — read-only viewer only in v1
- [ ] No diff highlighting on before/after JSON — plain formatted JSON only in v1
- [ ] No configurable page size — fixed at 50 rows
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
