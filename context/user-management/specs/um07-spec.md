# Spec: um07 — Users list/detail (READ)

- **Boundary:** APP
- **Dependencies:** Unit um06 (authorization enforcement core — `requirePermission`, `resolveEffectivePermissions`, `PERMISSIONS`/`LEVELS` constants, `EffectivePermissionMap`, `hasLevel`, `(admin)` layout, `/no-access` page, root redirect).
- **Source sections:** overview §"User administration", §"Pages — Administration" item 1; architecture §2 (folder ownership, boundary rules), §5 (account lifecycle, RBAC), §6 (per-page permission matrix: `users:READ`); code-standards §3 (Next.js rules, page guard pattern, force-dynamic), §4 (styling, badge components), §7 (file organization), §8 (permission naming), §9 (per-page permission map); ui-context §3.4 (`StatusBadge` tokens), §3.5 (`AuthMethodBadge` tokens), §3.6 (`RoleBadge` tokens), §5 (typography/monospace), §6 (radius scale). Invariants: **#2** (no authz state in session), **#3** (always server-side), **#4** (deny by default), **#14** (DB access only in `db/**`), **#20** (never cache authz decisions).

---

## Goal

Build the read-only `/administration/users` page — guarded at `users:READ`, rendering a `UserTable` (name, email, auth-method badge, status, roles, last login; DELETED rows hidden behind a "Show deleted" toggle) and a `UserDetail` panel populated from a `?userId` URL search param — together with the `StatusBadge`, `AuthMethodBadge`, and `RoleBadge` shared components, the users read repository queries, the users read service, and the admin navigation sidebar, so that the seeded admin can sign in and see the full users list with correctly styled badges, statuses, roles, and last login.

---

## Design

### Page layout

The page uses a two-column master-detail layout within the admin shell:

- **Left — `UserTable`** (~65% width): card on `--surface-card`, `--shadow-sm`, `--radius-md`. Shows the full user list with controls above the table.
- **Right — `UserDetail`** (~35% width): slides in as a fixed right panel when a user is selected; replaced by an empty-state placeholder ("Select a user to view details" in `--text-muted`) when no user is selected.
- Row selection is **URL-driven**: clicking a row pushes `?userId=<user_id>` to the browser URL. This makes the selection deep-linkable and browser-back-navigable. Next.js re-renders the server-fetched detail panel without remounting the client-side table component, so the "Show deleted" toggle state persists during row selection.
- On narrow viewports, the detail panel stacks below the table.

### Admin navigation sidebar

Um07 is the first administration page to ship, so the `(admin)` layout is updated in this unit to add the persistent navigation sidebar (um06 deferred this per spec §6.6).

- Full-height left sidebar, fixed width (`16rem`), `--surface-nav` background (`#131D49` / `primary-800`), `--gradient-chrome` as a vertical depth gradient.
- Application name / logo lockup at the top (white text on navy).
- Four vertical nav links: **Users**, **Roles**, **System Configuration**, **Audit Log** — pointing to their eventual routes. Only `/administration/users` has a page in this unit; the other three render as `<Link>` elements that will 404 until their units ship. Do not hide or disable non-functional links — the nav structure is intentional scaffolding.
- Active link detection via `usePathname()` — requires a client component `components/admin-nav.tsx` (`'use client'`). Active link: `--surface-selected` (`primary-50`) left-bordered highlight with `--color-primary-200` 3px left border; inactive: `--text-on-brand` text, `--action-ghost-hover` hover wash.
- Nav links use `--text-body-sm` (13px), not overline — these are navigation items, not labels.
- Keyboard-accessible: each link is focusable with a visible focus ring (`--focus-ring`).
- The main content area sits to the right of the sidebar and fills the remaining viewport width.

### UserTable

- **Table header area** (above the `<table>`): left side shows "Users" heading (`--text-h3`, `--text-primary`) and a live row count in `--text-muted`; right side shows the "Show deleted" toggle and a stub "Add User" button.
- **"Show deleted" toggle**: shadcn `Switch` + `<label>`. Default `false` (DELETED rows hidden). Managed as `useState` in `UserTable`.
- **"Add User" button**: primary style (`--action-primary-bg`), `disabled` attribute in this unit (mutations are out of scope). Visible only when `hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT)` is true. Tooltip or `title` attribute: "Feature coming soon."
- **Columns** (in order):

  | #   | Column      | Data                          | Notes                                                      |
  | --- | ----------- | ----------------------------- | ---------------------------------------------------------- |
  | 1   | Name        | `userName`                    | Medium weight; clickable row selects user                  |
  | 2   | Email       | `userEmail`                   | `--text-body`                                              |
  | 3   | Auth Method | `AuthMethodBadge`             | SSO or LOCAL                                               |
  | 4   | Status      | `StatusBadge` + locked chip   | Locked chip shown inline if `isLocked`                     |
  | 5   | Roles       | `RoleBadge` chips, wrapping   | "—" (`--text-muted`) if no roles                           |
  | 6   | Last Login  | Formatted datetime or "Never" | Monospace font (`--font-mono`), `--text-muted` for "Never" |

- **Table header row**: `--text-overline` style (11px, semibold, uppercase, letter-spaced), `--color-neutral-800` text, `--border-subtle` bottom border. Non-sortable header cells are plain; sortable headers show a sort-direction chevron icon on hover/active.
- **Sortable columns**: Name, Email, Last Login. Default sort: Name ascending. Client-side sort (no server round-trip). Clicking a sorted column toggles direction; clicking a different column sets it ascending. Sort state is `useState` in `UserTable`.
- **Row hover**: `--action-ghost-hover` (`neutral-100`) background.
- **Selected row**: `--surface-selected` (`primary-50`) background; left border `3px solid var(--color-primary-500)`.
- **DELETED rows** (visible when toggle on): `--text-muted` text, `--surface-sunken` (`neutral-100`) row background, `text-line-through` on name and email.
- **Empty state**: centered `<p>` "No users found." in `--text-muted` when the filtered list is empty.
- **No pagination** in v1 — the internal RevOps team is small enough that a full list is acceptable.

### UserDetail panel

- `--surface-card` background, `--shadow-md` on the left edge (facing the table).
- **Panel header**: user's full name as `<h3>` (`--text-h3`), `StatusBadge` (and locked chip if applicable) inline below the name, close button (×, `lucide-react X` icon, ghost style) top-right that navigates to `/administration/users` (clears the `?userId` param).
- **Field groups** — read-only, rendered as a labeled field grid (`<dl>` / `<dt>` / `<dd>` pairs or equivalent accessible markup):

  | Group         | Fields                                                                                                                                              |
  | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Identity      | Full Name, Email, Phone (or "—" if null)                                                                                                            |
  | Access        | Auth Method (`AuthMethodBadge`), Roles (`RoleBadge` chips or "None assigned")                                                                       |
  | Account state | Status (`StatusBadge`), Locked (danger lock chip + "Locked until [datetime]" or "Not locked" in `--text-muted`), Last Login, Created, Last Modified |

- `<dt>` labels: `--text-overline` style, `--text-muted` color. `<dd>` values: `--text-body`, `--text-primary`.
- Dates in the detail panel use monospace font (`--font-mono`) and UTC formatting.
- **"User not found" state**: rendered when `?userId` is present but the service returned `null` — centered message "User not found." with a "Back to users" `<Link>` that clears the param.
- **No action buttons** (edit, disable, delete, reset password) in this unit — those arrive in um08+.

### StatusBadge

Pill shape (`--radius-pill`), `--text-overline` font, inline-flex with gap between icon and label. Token mapping from ui-context §3.4:

| `UserStatus` | bg tint                 | text (`-fg`)            | lucide icon                |
| ------------ | ----------------------- | ----------------------- | -------------------------- |
| `ACTIVE`     | `success-50` `#E6F6EC`  | `success-700` `#0F5C32` | `CheckCircle`              |
| `PENDING`    | `warning-50` `#FEF4E6`  | `warning-700` `#8A5200` | `Clock`                    |
| `DISABLED`   | `danger-50` `#FDEAEA`   | `danger-700` `#8A1717`  | `Ban`                      |
| `DELETED`    | `neutral-100` `#EEF0F4` | `neutral-700` `#353B46` | `Archive` + `line-through` |

Locked chip (sibling element, not a variant): `danger-50` bg, `danger-700` text, `Lock` icon, label "Locked". Rendered immediately to the right of the status pill.

Meaning never depends on color alone — each state has a distinct icon and label. Use `cva` with a `status` variant key. Export `StatusBadgeProps`.

### AuthMethodBadge

Pill shape, `--text-overline`. Token mapping from ui-context §3.5:

| `AuthMethod` | bg tint                 | text                    | lucide icon   |
| ------------ | ----------------------- | ----------------------- | ------------- |
| `SSO`        | `cyan-50` `#E2F8FA`     | `cyan-700` `#006975`    | `ShieldCheck` |
| `LOCAL`      | `neutral-100` `#EEF0F4` | `neutral-700` `#353B46` | `Key`         |

### RoleBadge

Smaller chip (slightly less padding than status badges), `--text-overline`. Token mapping from ui-context §3.6 for the three seeded roles; any unrecognised role name falls back to neutral-100 / neutral-700 (future-proof):

| `roleName`  | bg tint                 | text                    |
| ----------- | ----------------------- | ----------------------- |
| `ADMIN`     | `primary-50` `#EDF0FB`  | `primary-700` `#1B2A68` |
| `MANAGER`   | `cyan-50` `#E2F8FA`     | `cyan-700` `#006975`    |
| `USER`      | `neutral-100` `#EEF0F4` | `neutral-700` `#353B46` |
| _(unknown)_ | `neutral-100` `#EEF0F4` | `neutral-700` `#353B46` |

No icon. `roleName` is rendered as-is (preserving the DB casing). No `cva` needed — a simple conditional map is sufficient.

---

## Implementation

### 7.1 — Shared types (`types/users.ts`)

New file. Pure TypeScript — no runtime code, no imports from `auth/**`, `db/**`, `services/**`, or `next/*`. Derives union types from constants already defined in `types/rbac.ts` (the `AuthMethod` and `UserStatus` string-literal unions).

**`UserListItem`** — shape for table rows:

```ts
{
  userId: string;
  userName: string;
  userEmail: string;
  authMethod: AuthMethod; // 'SSO' | 'LOCAL'
  status: UserStatus; // 'PENDING' | 'ACTIVE' | 'DISABLED' | 'DELETED'
  isLocked: boolean; // true when locked_until > now()
  roles: Array<{ roleId: string; roleName: string }>;
  lastLoginDatetime: Date | null;
}
```

**`UserDetailView`** — shape for the detail panel:

```ts
{
  userId: string;
  userName: string;
  userEmail: string;
  userPhonenum: string | null;
  authMethod: AuthMethod;
  status: UserStatus;
  isLocked: boolean;
  lockedUntil: Date | null;
  roles: Array<{ roleId: string; roleName: string; assignedBy: string | null }>;
  lastLoginDatetime: Date | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
}
```

Neither type aliases Drizzle row types directly — the service maps DB rows to these shapes, keeping the DB schema decoupled from UI consumers.

### 7.2 — Repository: user read queries (`db/repositories/app-user.repository.ts`)

Add two read functions to the existing repository file. Both import only `@/db/client` and `@/db/schema`; no business logic; no audit writes.

#### 7.2.1 — `findAllWithRoles(): Promise<UserWithRolesRow[]>`

Drizzle query: left-join `core.appuser` → `core.role_assign` (on `role_assign.ref_user_id = appuser.user_id`) → `core.roles` (on `roles.role_id = role_assign.ref_role_id`). No WHERE clause — returns every user including DELETED. Order by `appuser.user_name ASC`.

The LEFT JOIN produces one raw row per role assignment; a user with three roles produces three rows. **Aggregate in-memory inside the repository function** using a `Map<userId, UserWithRolesRow>` reduction, yielding one entry per user with `roles: Array<{ roleId: string; roleName: string }>`. A user with no role assignments yields `roles: []` (empty array, never `null`).

Internal intermediate row type (not exported):

```ts
// One raw row from the LEFT JOIN — roleId/roleName null when user has no assignments
type RawUserRoleRow = {
  userId: string;
  userName: string;
  userEmail: string;
  authMethod: string;
  status: string;
  lockedUntil: Date | null;
  lastLoginDatetime: Date | null;
  roleId: string | null;
  roleName: string | null;
};
```

The aggregated `UserWithRolesRow` type (not exported beyond the repository file) adds `roles: Array<{ roleId: string; roleName: string }>` and drops the nullable role columns.

#### 7.2.2 — `findByIdWithRoles(userId: string): Promise<UserWithRolesDetailRow | null>`

Same join pattern as 7.2.1 but with `WHERE appuser.user_id = $userId` (`eq` operator). Returns `null` if no matching user. Includes additional columns needed for the detail panel: `user_phonenum`, `created_datetime`, `last_modified_datetime`, `locked_until` (already in 7.2.1 for `isLocked` computation, but here surfaced fully for display).

Aggregates roles using the same reduction as 7.2.1. If the user has roles, the aggregated `roles` array includes `assignedBy: string | null` (the `assigned_by` column from `core.role_assign`).

Internal intermediate type `UserWithRolesDetailRow` (not exported) extends `UserWithRolesRow` with `userPhonenum`, `createdDatetime`, `lastModifiedDatetime`.

### 7.3 — Service: users read (`services/users/users-read.service.ts`)

New file. Framework-agnostic — no imports from `next/*`, `app/**`, or `actions/**`. Calls the repository and maps to the public types from `types/users.ts`.

**`listUsers(): Promise<UserListItem[]>`**

1. Call `appUserRepository.findAllWithRoles()`.
2. Map each row to `UserListItem`, computing `isLocked` as `row.lockedUntil !== null && row.lockedUntil > new Date()`.
3. Return the full array including DELETED users — the caller (table component) decides what to display based on the toggle.

**`getUserById(userId: string): Promise<UserDetailView | null>`**

1. Call `appUserRepository.findByIdWithRoles(userId)`.
2. Return `null` immediately if the repository returns `null`.
3. Map to `UserDetailView`, computing `isLocked` as above.

Neither function writes to `AUDIT_LOG` — read operations are not audited (overview §Audit Events). Neither throws for expected cases (user not found → `null`). On unexpected repository errors, propagate the `AppError` up to the page boundary.

### 7.4 — Shared date formatter (`lib/formatters.ts`)

New file (or extend if it exists from prior units). Pure function, no side effects, importable by both server and client modules.

**`formatDatetime(date: Date | null, fallback?: string): string`**

- Returns `fallback` (default `"Never"`) if `date` is `null`.
- Otherwise formats using `Intl.DateTimeFormat` with options `{ day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }` — produces e.g. `"15 Jun 2026 09:32"`. The exact locale string may vary by runtime locale; the key requirements are day-month-year order and 24-hour time, UTC.
- No external date library dependency.

### 7.5 — Badge components

Three new shared components in `components/`. Each is a presentational leaf — `'use client'` not required (no state, no effects, no browser APIs), so they are Server Components by default. No DB access, no business logic, no `next/*` imports.

All three use `cn()` for class composition, `cva` for variant definitions (where applicable), CSS variable tokens via Tailwind semantic classes, and icons from `lucide-react`. No raw hex values in component files.

#### 7.5.1 — `StatusBadge` (`components/status-badge.tsx`)

Props:

```ts
export interface StatusBadgeProps {
  status: UserStatus;
  isLocked?: boolean;
  className?: string;
}
```

Render:

- A `<span>` pill using `cva` with a `status` variant for the four `UserStatus` values. Each variant applies Tailwind classes mapped to the CSS variable tokens (bg-tint, text-fg, radius-pill, text-overline).
- Inside the pill: the lucide icon (`size={12}`) + the status label as text.
- DELETED variant additionally applies `line-through` to the text.
- If `isLocked === true`, render a second `<span>` chip immediately after the status pill, sharing the same outer wrapper `<span className="inline-flex items-center gap-1.5">`. Locked chip: danger tokens, `Lock` icon, label "Locked".

`cva` base classes: `inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider` (approximating `--text-overline` and `--radius-pill` via Tailwind).

#### 7.5.2 — `AuthMethodBadge` (`components/auth-method-badge.tsx`)

Props:

```ts
export interface AuthMethodBadgeProps {
  authMethod: AuthMethod;
  className?: string;
}
```

No `cva` needed — only two variants. A `const` record maps `authMethod` to `{ bg, text, icon }`. Render a single pill `<span>` with the icon + label.

#### 7.5.3 — `RoleBadge` (`components/role-badge.tsx`)

Props:

```ts
export interface RoleBadgeProps {
  roleName: string;
  className?: string;
}
```

A `const` record maps known role names (`'ADMIN'`, `'MANAGER'`, `'USER'`) to their token pairs. Any unrecognised name falls back to neutral tokens. Slightly smaller padding than status badges (`px-1.5 py-0.5`). No icon.

### 7.6 — Admin navigation sidebar (`components/admin-nav.tsx` + `app/(admin)/layout.tsx` update)

#### `components/admin-nav.tsx`

New file. `'use client'` — uses `usePathname()` from `next/navigation`.

Renders a `<nav>` element containing a vertical list of `<Link>` items for the four admin pages. Each link receives `aria-current="page"` when `pathname.startsWith(link.href)`. Active and inactive styling via `cn()` with conditional classes derived from the pathname check.

Nav items:

```ts
const NAV_ITEMS = [
  { label: "Users", href: "/administration/users" },
  { label: "Roles", href: "/administration/roles" },
  { label: "System Configuration", href: "/administration/system-config" },
  { label: "Audit Log", href: "/administration/audit-log" },
];
```

No icons on nav items in this unit (add in a later polish unit if desired). Links are full-width, padding `px-4 py-2.5`. Focus ring: `--focus-ring` (2px white inset + 2px primary-500 outer). No default exports.

#### `app/(admin)/layout.tsx` update

Replace the minimal `{children}` shell from um06 with a two-column flex layout:

```tsx
<div className="flex h-screen overflow-hidden">
  {/* Sidebar */}
  <aside
    className="flex w-64 flex-shrink-0 flex-col"
    style={{ background: "var(--surface-nav)" }}
  >
    {/* App name lockup */}
    <div className="border-b border-white/10 px-4 py-5">
      <span className="text-sm font-semibold text-white">
        Enterprise Billing
      </span>
    </div>
    <AdminNav />
  </aside>
  {/* Main content */}
  <main
    className="flex-1 overflow-y-auto"
    style={{ background: "var(--surface-app)" }}
  >
    {children}
  </main>
</div>
```

Keep `export const dynamic = 'force-dynamic'` and `metadata`. Update `metadata.title` to `'Administration — Enterprise Billing'` (unchanged from um06).

The layout remains auth-check-free — each child page handles its own guard.

### 7.7 — `UsersPage` (`app/(admin)/administration/users/page.tsx`)

Server Component. Thin orchestrator — no business logic, no DB access.

```ts
export const dynamic = "force-dynamic";
export const metadata = { title: "Users — Enterprise Billing" };
```

**Props:** `{ searchParams: { userId?: string } }` (Next.js page prop).

**Behavior:**

1. `const { userId: actorId, permissionMap } = await requirePermission(PERMISSIONS.USERS, LEVELS.READ)` — unauthenticated or unauthorized users are redirected by the guard before any data fetch.
2. Read `const selectedUserId = searchParams.userId` (may be `undefined`).
3. Fetch in parallel:
   ```ts
   const [users, selectedUser] = await Promise.all([
     usersReadService.listUsers(),
     selectedUserId
       ? usersReadService.getUserById(selectedUserId)
       : Promise.resolve(null),
   ]);
   ```
4. Render:
   ```tsx
   <div className="flex h-full gap-4 p-6">
     <div className="min-w-0 flex-[2]">
       <UserTable
         users={users}
         selectedUserId={selectedUserId}
         permissionMap={permissionMap}
       />
     </div>
     <div className="min-w-0 flex-[1]">
       <UserDetail
         user={selectedUser}
         notFound={selectedUserId !== undefined && selectedUser === null}
       />
     </div>
   </div>
   ```

The page does not validate `searchParams.userId` beyond checking existence — a non-existent UUID is handled gracefully by the service returning `null`, which the `UserDetail` renders as "User not found."

Do not pass `actorId` to child components — it is not needed for read-only rendering and should not be exposed unnecessarily.

### 7.8 — `UserTable` (`components/users/user-table.tsx`)

Client Component (`'use client'`). Manages toggle and sort state; handles row navigation.

**Props:**

```ts
interface UserTableProps {
  users: UserListItem[];
  selectedUserId?: string;
  permissionMap: EffectivePermissionMap;
}
```

**State:**

```ts
const [showDeleted, setShowDeleted] = useState(false);
const [sortKey, setSortKey] = useState<
  "userName" | "userEmail" | "lastLoginDatetime"
>("userName");
const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
```

**Derived values** (computed during render, no `useMemo` needed at this scale):

- `filteredUsers`: `showDeleted ? users : users.filter(u => u.status !== 'DELETED')`
- `sortedUsers`: client-side sort of `filteredUsers` by `sortKey`/`sortDir`. For `lastLoginDatetime`: `null` values sort last regardless of direction.

**Row click handler:**

```ts
const router = useRouter();
const handleRowClick = (userId: string) => {
  router.push(`/administration/users?userId=${userId}`);
};
```

**"Show deleted" toggle:** shadcn `Switch` component wired to `showDeleted` state. Label: "Show deleted users" (rendered with `<label>` associated via `htmlFor`/`id`).

**Column sort:** each sortable header cell renders a `<button>` wrapping the column label + `ChevronUp`/`ChevronDown` icon (from lucide-react). Clicking toggles direction if the column is already sorted, or sets it asc if a different column is clicked.

**Last login cell:** `{user.lastLoginDatetime ? <span className="font-mono">{formatDatetime(user.lastLoginDatetime)}</span> : <span className="text-muted-foreground">Never</span>}`

**Roles cell:** `{user.roles.length > 0 ? user.roles.map(r => <RoleBadge key={r.roleId} roleName={r.roleName} />) : <span className="text-muted-foreground">—</span>}`

**"Add User" button:** `{hasLevel(permissionMap, PERMISSIONS.USERS, LEVELS.EDIT) && <Button disabled>Add User</Button>}` — visible to ADMIN (who has `users:DELETE ⊃ EDIT`) but disabled.

**DELETED row styling:** apply `cn('text-muted-foreground bg-[var(--surface-sunken)]', { 'line-through': user.status === 'DELETED' })` when `showDeleted` is true and the row is DELETED.

Imports: `useRouter`, `useState` from react/next; `UserListItem` from `@/types/users`; `EffectivePermissionMap`, `hasLevel` from `@/types/permissions`; `PERMISSIONS`, `LEVELS` from `@/auth/permission-constants`; badge components; `formatDatetime` from `@/lib/formatters`; shadcn `Switch`, `Button`.

### 7.9 — `UserDetail` (`components/users/user-detail.tsx`)

Server Component. Receives pre-fetched data as props.

**Props:**

```ts
interface UserDetailProps {
  user: UserDetailView | null;
  notFound?: boolean;
}
```

**Render — not-found state** (`user === null` or `notFound === true`):

```tsx
<div className="flex h-full flex-col items-center justify-center gap-3 text-center">
  <p className="text-muted-foreground">
    {notFound ? "User not found." : "Select a user to view details."}
  </p>
  {notFound && (
    <Link
      href="/administration/users"
      className="text-sm text-primary underline"
    >
      Back to users
    </Link>
  )}
</div>
```

**Render — user found**: panel card with `--shadow-md` left border. Structure:

```
[Panel header]
  <h3>{user.userName}</h3>
  <StatusBadge status={user.status} isLocked={user.isLocked} />
  <Link href="/administration/users"><X /></Link>  ← close button

[Field group: Identity]
  Full Name / Email / Phone

[Field group: Access]
  Auth Method / Roles

[Field group: Account state]
  Status / Locked / Last Login / Created / Last Modified
```

Dates formatted with `formatDatetime`. `lockedUntil` displayed as `"Locked until {formatDatetime(user.lockedUntil)}"` in danger-700 text when `user.isLocked`, else `"Not locked"` in `--text-muted`.

Roles rendered as: `{user.roles.length > 0 ? user.roles.map(r => <RoleBadge key={r.roleId} roleName={r.roleName} />) : <span className="text-muted-foreground">None assigned</span>}`

All field labels: `--text-overline` style, `--text-muted` color (`text-[11px] font-semibold uppercase tracking-wider text-muted-foreground`). All field values: `--text-body`, `--text-primary`.

Close `<Link>` is a ghost-style icon button, top-right of the panel header, `href="/administration/users"`.

### 7.10 — `loading.tsx` and `error.tsx`

**`app/(admin)/administration/users/loading.tsx`**

Skeleton for the two-column layout using shadcn `Skeleton`. Left side: a card-shaped div with a skeleton header row and 5 skeleton table rows (each a horizontal strip). Right side: a card-shaped div with skeleton blocks for a detail panel. Uses `animate-pulse`. No auth dependency.

**`app/(admin)/administration/users/error.tsx`**

Client Component (`'use client'`). Receives `error: Error` and `reset: () => void` props from Next.js error boundary. Uses `useEffect(() => { telemetry.captureException(error) }, [error])` (calling the `lib/` telemetry helper). Renders a centered error card: heading "Unable to load users", body "Something went wrong. Please try again.", a "Retry" `<button>` that calls `reset()`. No stack trace, no `error.message` exposed in the UI. Accessible heading level `<h2>`.

### 7.11 — Tests

#### Unit tests: badge components (`tests/unit/components/`)

Use `@testing-library/react` + `vitest`. No DB. Three test files:

**`status-badge.test.tsx`**: render `StatusBadge` for each of the four statuses; assert the correct label text is present. Render with `isLocked={true}`; assert both the status label and "Locked" text are present. Render `DELETED`; assert "archive" icon role or aria-label is present (or text fallback).

**`auth-method-badge.test.tsx`**: render `SSO` and `LOCAL`; assert correct label text.

**`role-badge.test.tsx`**: render `ADMIN`, `MANAGER`, `USER`, and an unknown role name; assert label text equals the input; assert no crash on unknown name.

#### Unit tests: service (`tests/unit/services/users-read.service.test.ts`)

Mock `appUserRepository` entirely. Cover:

| Scenario                           | Input                                         | Expected                             |
| ---------------------------------- | --------------------------------------------- | ------------------------------------ |
| `listUsers()` maps rows            | One user row with `lockedUntil = null`        | `isLocked: false`                    |
| `listUsers()` detects lock         | One user row with `lockedUntil = future Date` | `isLocked: true`                     |
| `listUsers()` detects expired lock | One user row with `lockedUntil = past Date`   | `isLocked: false`                    |
| `listUsers()` includes DELETED     | Mix of statuses including DELETED             | All users returned including DELETED |
| `listUsers()` empty                | No rows                                       | Returns `[]`                         |
| `getUserById()` found              | Valid user row                                | Returns `UserDetailView`             |
| `getUserById()` not found          | `null` from repo                              | Returns `null`                       |

#### Unit tests: formatter (`tests/unit/lib/formatters.test.ts`)

- `formatDatetime(null)` → `"Never"`
- `formatDatetime(null, 'N/A')` → `"N/A"`
- `formatDatetime(new Date('2026-06-15T09:32:00Z'))` → string containing `"Jun"`, `"2026"`, `"09:32"` (loose assertion tolerating locale variations)
- Pure function — no imports from `next/*` or DB

#### Integration tests: page guard (`tests/integration/app/users-page.test.ts`)

Extends the route × level matrix from um06. Use the existing test DB fixtures (admin_user, no_grants_user). Mock `usersReadService.listUsers` to return a minimal array (guard test only):

| Session        | Expected                                          |
| -------------- | ------------------------------------------------- |
| admin_user     | `requirePermission` returns context (no redirect) |
| no_grants_user | `redirect('/no-access')`                          |
| (no session)   | `redirect('/login')`                              |

Test that `requirePermission(PERMISSIONS.USERS, LEVELS.READ)` is called — not that the page renders pixels.

#### Integration tests: repository (`tests/integration/db/app-user-repository.test.ts`)

Against the test DB with the seeded admin. These extend the existing repository test file from earlier units:

- `findAllWithRoles()` returns at least one user; the seeded admin is present with `roles: [{ roleName: 'ADMIN', ... }]`.
- `findAllWithRoles()` returns each user exactly once even when the user has multiple role assignments (insert a second role on a test user, assert the array length stays 1 for that user with `roles.length === 2`).
- `findAllWithRoles()` returns `roles: []` (empty array, not `null`) for a user with no role assignments.
- `findByIdWithRoles(adminId)` returns the seeded admin with roles.
- `findByIdWithRoles('00000000-0000-0000-0000-000000000000')` returns `null`.

---

## Dependencies

No new npm packages beyond what shadcn/ui components may require. All framework dependencies (`next`, `react`, `drizzle-orm`, `lucide-react`, `cva`, `clsx`, `tailwind-merge`, `vitest`, `@testing-library/react`) are installed from prior units.

**shadcn/ui components** — run the CLI if not already added in a prior unit:

- `npx shadcn@latest add switch` — "Show deleted" toggle in `UserTable`.
- `npx shadcn@latest add skeleton` — loading skeleton in `users/loading.tsx`.

Both are added to `components/ui/` (the managed vendor layer per code-standards §4.1) and must not be hand-edited beyond token wiring.

---

## Verification Checklist

### Page, routing, and guard

- [ ] `GET /administration/users` with an ADMIN session renders the page (HTTP 200)
- [ ] `GET /administration/users` with no session redirects to `/login`
- [ ] `GET /administration/users` with an ACTIVE no-grants session redirects to `/no-access`
- [ ] `app/(admin)/administration/users/page.tsx` has `export const dynamic = 'force-dynamic'`
- [ ] `page.tsx` calls `requirePermission(PERMISSIONS.USERS, LEVELS.READ)` as the first `await` before any data fetch
- [ ] `page.tsx` uses `PERMISSIONS.USERS` constant (not the raw string `'users'`)
- [ ] `page.tsx` metadata title is `'Users — Enterprise Billing'`
- [ ] `app/(admin)/administration/users/loading.tsx` exists and renders a two-column skeleton
- [ ] `app/(admin)/administration/users/error.tsx` exists, reports to telemetry, renders a non-leaking error message, exposes no `error.message` or stack trace

### Data fetching

- [ ] `usersReadService.listUsers()` returns the seeded admin in the list
- [ ] `usersReadService.listUsers()` includes DELETED users in the returned array (filtering is the table component's responsibility)
- [ ] `usersReadService.listUsers()` sets `isLocked: true` when `lockedUntil` is in the future; `false` when `null` or past
- [ ] `usersReadService.getUserById(adminUserId)` returns a `UserDetailView` with `roles` containing the ADMIN role
- [ ] `usersReadService.getUserById('nonexistent-uuid')` returns `null`
- [ ] Neither service function imports from `next/*`, `app/**`, or `actions/**`
- [ ] Neither service function writes to `AUDIT_LOG`

### Repository

- [ ] `findAllWithRoles()` returns each user exactly once (aggregation eliminates join duplicates)
- [ ] `findAllWithRoles()` returns `roles: []` (empty array) for users with no role assignments — not `null`
- [ ] A user with two role assignments appears in the result with `roles.length === 2`
- [ ] `findByIdWithRoles(userId)` returns `null` for a non-existent UUID
- [ ] Both repository functions import only from `@/db/client` and `@/db/schema`
- [ ] No business logic or audit writes in the repository

### UserTable component

- [ ] The seeded admin appears in the table with correct name, email, `AuthMethodBadge` (LOCAL), `StatusBadge` (ACTIVE), `RoleBadge` (ADMIN)
- [ ] Last login "Never" is displayed in `--text-muted` for a user who has never logged in
- [ ] Last login datetime is rendered in monospace font
- [ ] DELETED users are hidden by default (toggle off)
- [ ] Toggling "Show deleted" reveals DELETED rows; those rows have muted/strikethrough styling
- [ ] Clicking a row pushes `?userId=<userId>` to the URL
- [ ] The selected row is highlighted with `--surface-selected` background and a left border accent
- [ ] Column sort on Name, Email, Last Login works client-side without a server round-trip
- [ ] `null` last login values sort last in both ascending and descending sort
- [ ] "Add User" button is visible to ADMIN (who holds `users:EDIT` via DELETE ⊃ EDIT) and is disabled
- [ ] Empty state "No users found." is rendered when the filtered list is empty
- [ ] "Show deleted" `Switch` has an associated `<label>` linked via `htmlFor`/`id`

### UserDetail panel

- [ ] Panel is in empty-state ("Select a user to view details.") when no `?userId` param is present
- [ ] Panel shows name, email, phone, `AuthMethodBadge`, `StatusBadge`, roles, last login, created, last modified for the selected user
- [ ] Locked chip appears alongside the status badge when `isLocked` is true
- [ ] "User not found." is shown when `?userId` is present but the service returned `null`
- [ ] "Back to users" link is shown in the not-found state
- [ ] Close (×) `<Link>` navigates to `/administration/users` without the `?userId` param
- [ ] All date fields use monospace font and UTC formatting
- [ ] No edit controls, form inputs, or action buttons are present in this unit
- [ ] `lockedUntil` field shows "Not locked" in `--text-muted` when `isLocked` is false

### Badge components

- [ ] `StatusBadge` renders for all four statuses with the correct icon (`CheckCircle` / `Clock` / `Ban` / `Archive`)
- [ ] `StatusBadge` with `isLocked={true}` renders a "Locked" chip with the `Lock` icon alongside the main status pill
- [ ] `StatusBadge` DELETED renders with `line-through` text decoration
- [ ] `AuthMethodBadge` SSO: cyan colors, `ShieldCheck` icon
- [ ] `AuthMethodBadge` LOCAL: neutral colors, `Key` icon
- [ ] `RoleBadge` ADMIN: `primary-50` bg, `primary-700` text
- [ ] `RoleBadge` unknown role name: neutral fallback colors, no crash
- [ ] All three badges use `--radius-pill` shape and `--text-overline` typographic style
- [ ] No badge component contains hardcoded hex values — all colors via CSS variable tokens

### Navigation sidebar

- [ ] `app/(admin)/layout.tsx` renders a full-height left sidebar (`AdminNav`) and a scrollable main content area
- [ ] Sidebar uses `--surface-nav` background (`#131D49`)
- [ ] All four nav links are present (Users, Roles, System Configuration, Audit Log)
- [ ] "Users" link receives `aria-current="page"` and active styling on `/administration/users`
- [ ] Sidebar nav links are keyboard-navigable with a visible focus ring

### Formatter

- [ ] `formatDatetime(null)` returns `"Never"`
- [ ] `formatDatetime(null, 'N/A')` returns `"N/A"`
- [ ] `formatDatetime(new Date('2026-06-15T09:32:00Z'))` returns a string containing "Jun", "2026", and "09:32"
- [ ] `formatDatetime` has no imports from `next/*`, `db/**`, or `services/**`

### Boundary and TypeScript

- [ ] `types/users.ts` has no imports from `auth/**`, `db/**`, `services/**`, or `next/*`
- [ ] `services/users/users-read.service.ts` has no imports from `next/*`, `app/**`, or `actions/**`
- [ ] Badge components have no DB access, no business logic, no `next/*` imports
- [ ] `components/users/user-table.tsx` and `components/users/user-detail.tsx` import repository functions via the service, not directly
- [ ] `tsc --noEmit` clean across all new files
- [ ] No `console.*` in any new file — diagnostics via `lib/logger`
- [ ] ESLint clean including import-boundary rules

### Test suite

- [ ] `vitest run` passes all badge unit tests (StatusBadge × 4 statuses + locked, AuthMethodBadge × 2, RoleBadge × 3 + fallback)
- [ ] `vitest run` passes all service unit tests (7 scenarios per §7.11)
- [ ] `vitest run` passes formatter unit tests (null, custom fallback, valid date)
- [ ] Route guard integration tests pass for admin, no-grants, and unauthenticated sessions
- [ ] Repository integration tests pass: dedup, empty roles array, null for non-existent ID

### Scope guard

- [ ] No Server Actions were added (mutations are in um08+)
- [ ] No create/edit/disable/delete/reset-password user functionality was added
- [ ] `UserDetail` panel contains no form inputs and no action buttons
- [ ] No new `PERMISSIONS` migration rows were added (no new permission required for this unit)
- [ ] The `(admin)/layout.tsx` `force-dynamic` declaration and `metadata` export from um06 are preserved
- [ ] Architecture, overview, code-standards, and ui-context docs are untouched; this spec file is the unit-of-record
