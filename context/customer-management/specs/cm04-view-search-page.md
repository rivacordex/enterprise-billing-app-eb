# CM04 — View Customer: Search Page

- **Unit:** 4 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm02` (`searchCustomers`, `CustomerSearchResult`/`CustomerSearchResults` read models) and `cm03` (nav link + the corrected `/customers/view` path) verified and merged.
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* steps 2–3, 10, *Features* ("Search and viewing"); `custmgmt-architecture.md` §2 (`app/(app)/customers/view/` row — "declares `customers : READ`"), §4 (permission matrix); `custmgmt-code-standards.md` §3.1–§3.2, §3.7, §3.9, §4.6, §7 (file tree); `custmgmt-ui-context.md` §1–§2 (badge colors/icons), §7 (mono IDs, `--surface-selected`); platform `architecture.md` §2 (boundary — thin orchestrator), §5 (guard, defense in depth); general `code-standards.md` §1.5 (parse at the edge), §3.3, §3.6, §3.8, §3.11.
- **Note on codebase verification:** no live-repo mount this session (as `cm01`–`cm03`). This spec reconstructs the closest precedent — `pm05-spec.md`, Product's "page: guard + searchParams + table" unit — but **the shape differs substantially**: Product built a single-page master-detail view (`?offering=` selection on the same page); Customer's own file tree (`custmgmt-code-standards.md` §7) puts View Customer's detail at a **separate route**, `[id]/page.tsx` (`cm05`), so this unit has no `?id=`-selection logic, no detail-region scaffold, and no per-column sort/pagination (search results are capped + hinted, never paginated, per the overview). Only the guard, parse-at-the-edge, empty/not-found-state, and `useTransition` pending-state patterns carry over from `pm05`.

---

## 1. Goal

Build `app/(app)/customers/view/page.tsx` as a thin RSC orchestrator guarded at `customers:READ`, parsing a single `q` URL searchParam through a lenient Zod schema, calling `searchCustomers` (`cm02`) and rendering results via the shared `CustomerSearchPanel` + `CustomerResultsTable` components — empty start state (no table at all) until a query is submitted, capped/hinted results once one is. Clicking a result row navigates to `/customers/view/[id]` (`cm05`, not yet built — an accepted interim 404, same pattern as Product's `pm04`→`pm05` gap). Visible result: a READ-permitted user reaches an empty search box from the nav, searches, sees correctly-matched and capped results with a refine-search hint when the cap is hit, and the exact view is reproducible via `?q=`.

## 2. Design

### 2.1 Boundary & composition

Frontend only: the RSC page plus `components/customers/customer-search-panel.tsx` and `components/customers/customer-results-table.tsx` (architecture §2, code-standards §7). The page is a thin orchestrator — guard, parse, call `services/customer` only, compose components. No `actions/`, no `app/api/`, no mutation code (this unit is read-only, matching the module's own read-before-write sequencing even though the module overall ships full CRUD).

The page is a Server Component (`export const dynamic = 'force-dynamic'` — authz resolves per request, platform Inv. #20). The search input is a client component (`CustomerSearchPanel`) that reads/writes the `q` URL param; `CustomerResultsTable` needs no interactivity of its own (no sort, no pagination, no in-page selection state — a row click is a real navigation, not a `?id=` update) and is a **Server Component**, simplifying on `pm05`'s client table.

### 2.2 Decisions

1. **Guard is `requirePermission('customers', 'READ')`, the first statement of the page body** (architecture §4, platform §5 defense-in-depth) — no grant → `/no-access`. This is the same guard `cm06`'s Manage search page will call at `EDIT`; nothing here is shared code beyond the guard helper itself (no premature abstraction across the two pages).
2. **Empty query never renders a table at all** — not even an empty-results message (code-standards §3.1: "Neither page pre-loads a result list — both render an empty search box until a query is submitted"). The page distinguishes three states: **(a)** `q` empty/whitespace → search box only; **(b)** `q` non-empty, zero matches → `CustomerResultsTable`'s own empty-state row ("No customers match your search"); **(c)** `q` non-empty, ≥ 1 match → populated rows, optionally the refine-search hint.
3. **No pagination, no column sort — capped + hinted instead** (overview *Search and viewing*: "capped at the `system_config` limit ... with a match-count hint," not "sortable, paginated table" the way Product's catalog is). `CustomerSearchResults.hasMore` (`cm02`) drives a one-line hint below the table: *"Showing the first {limit} matches — refine your search for more precise results."* No `page`/`sort` URL params exist on this page at all — simpler than `pm05`'s five-param contract.
4. **Row navigation is a real link, not a `?id=` param** — `custmgmt-code-standards.md` §7's file tree puts the detail page at `app/(app)/customers/view/[id]/page.tsx`, a separate route (unlike Product's one-page `?offering=` model). Each row is (or wraps) a `<Link href={`/customers/view/${result.partyRoleId}`}>` — full navigation, browser Back/Forward work for free, no selection state to keep in the URL on this page.
5. **`CustomerResultsTable` is a Server Component.** With no sort, pagination, or selection-highlight state to manage client-side, there is no interactivity left in the table itself — only `CustomerSearchPanel` needs `'use client'`. This is a deliberate simplification versus `pm05`'s client `OfferingTable` (general code-standards §3.2: add `'use client'` only for state/effects/browser APIs — the table here has none).
6. **Search UX mirrors the established Apply/Enter/Clear + `useTransition` pattern** (`pm05` §2.3.6, audit-log precedent) for consistency across the app, scaled down (no filter/sort/page to reset — only `q` itself, no `page` param to reset since there is no pagination): typing + **Apply** or **Enter** navigates to `?q=<term>` via `router.replace` (list-state change, not a "selection," so `replace` not `push` — `pm05`'s history-model rule §2.3.8 applies identically here even without pagination); **Clear** removes `q` entirely, returning to the empty start state. `useTransition` dims the panel/table region and disables Apply/Clear while the RSC re-render is in flight, preventing double-submit races.
7. **`OrganizationStatusBadge` and `CustomerStatusBadge` are built now, first-consumed by this table** (mirrors `pm05`'s `LifecycleBadge`, "created here because the table is its first consumer" — `cm05`'s detail page reuses both). Colors/icons are **verbatim** from `custmgmt-ui-context.md` §1–§2 — this spec does not invent a palette:
   - `OrganizationStatusBadge`: `REGISTERED` warning family + `clipboard-list` icon; `ACTIVE` success + `check-circle`; `INACTIVE` neutral + `pause-circle`; `SUSPENDED` danger + `alert-octagon`; `DISSOLVED` neutral + `archive` (row muted); `MERGED` neutral + `git-merge` (row muted).
   - `CustomerStatusBadge`: `INITIALIZED` warning + `pencil-line`; `VALIDATED` info + `shield-check`; `ACTIVE` success + `check-circle`; `SUSPENDED` danger + `alert-octagon`; `CLOSED` neutral + `archive` (row muted/strikethrough).
   - Both dark `-fg` text on light `-bg` tint, never white-on-tint, icon always present (ui-context §8 — color never carries the distinction alone, since `SUSPENDED` looks identical between the two badge families by design and the four neutral terminal/dormant states are disambiguated only by icon + label).
8. **Row muting** — a row whose `customerStatus === 'CLOSED'` or whose `organizationStatus` is a terminal state (`DISSOLVED`/`MERGED`) renders muted (`--text-muted`), same treatment `pm05` gave RETIRED rows. This is a display nicety, not a filter — `searchCustomers` (`cm02`) never excludes any status from results; the overview places no "hide closed customers" requirement on View Customer (unlike Product's RETIRED-hidden-by-default, which **is** a documented service-layer rule — no equivalent exists here, so nothing is hidden, only visually de-emphasized).
9. **The `q` searchParams schema is a new, small file — introduced just-in-time, not a `cm02` gap.** `cm02`'s validation scope was entity field shapes + transitions + specification well-formedness; a URL search-param schema is page-specific plumbing that Product also built in its data-layer unit (`pm02`) only because Product's page needed five params at once. Customer's page needs exactly one. This unit adds `validation/customer/search-params.schema.ts` now, first-needed, consistent with the "dependencies just in time" build-plan rule rather than retrofitting `cm02`.
10. **Deterministic ordering already comes from `cm02`'s repository** (`organization.name ASC, party_role_id ASC`) — this page adds no ORDER BY of its own; it renders exactly the order `searchCustomers` returns.

### 2.3 What this unit explicitly does NOT do

No detail-page content (organization/role/contact sections — `cm05`). No Manage Customer anything (`cm06`+). No mutation, no CTA, no `actions/customer/*`. No filter/sort/pagination UI (none exists for this page, §2.2.3). No authz-matrix file (final sweep is `cm16`, though the guard-blocks-no-grant case is tested here as this page's own guardrail, matching `pm05`'s "deep link reproduces the view / unknown ID → empty state / guard blocks no-grant" trio, adapted to this page's simpler contract).

## 3. Implementation

### 3.1 `validation/customer/search-params.schema.ts` (new)

```ts
import { z } from 'zod'

export const customerSearchParamsSchema = z.object({
  q: z.string().trim().max(200).catch(''),
})
export type CustomerSearchParams = z.infer<typeof customerSearchParamsSchema>
```

Lenient `.catch()` default per general code-standards §3.3 — a garbage/oversized `q` value never 500s, it just falls back to an empty query (empty start state). Shared verbatim by `cm06`'s Manage search page — one schema, not two copies (the file lives in `validation/customer/`, not colocated with this page, precisely so `cm06` can import it unchanged).

### 3.2 Page — `app/(app)/customers/view/page.tsx` (new)

```tsx
import type { Metadata } from 'next'

import { requirePermission } from '@/auth/guard'
import { LEVELS, PERMISSIONS } from '@/auth/permission-constants'
import { CustomerSearchPanel } from '@/components/customers/customer-search-panel'
import { CustomerResultsTable } from '@/components/customers/customer-results-table'
import { searchCustomers } from '@/services/customer/search-customers'
import { customerSearchParamsSchema } from '@/validation/customer/search-params.schema'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'View Customer' }

export default async function ViewCustomerSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ)

  const raw = await searchParams
  const parsed = customerSearchParamsSchema.parse({ q: firstValue(raw.q) })

  const results = parsed.q ? await searchCustomers(parsed.q) : null

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">View Customer</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Search for an enterprise customer by organization or trading name.
        </p>
      </header>

      <CustomerSearchPanel query={parsed.q} baseHref="/customers/view" />

      {results !== null && (
        <CustomerResultsTable results={results} basePath="/customers/view" />
      )}
    </main>
  )
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
```

- **Guard is line 1 of the body** — nothing (not even searchParams parsing) runs before it (defense-in-depth, matches `pm05` §3.1).
- `results !== null` (not `results.results.length > 0`) is the empty-start-vs-has-query distinction — `searchCustomers` is only ever called when `parsed.q` is truthy, so an empty query never touches `services/customer` at all (mirrors `cm02`'s own "empty query never hits the database" rule, kept consistent end to end).
- `basePath="/customers/view"` is threaded into `CustomerResultsTable` so it builds `/customers/view/${partyRoleId}` links — the same component instance is reused by `cm06` with `basePath="/customers/manage"` (code-standards §4.6, "one `CustomerResultsTable` component shared by View and Manage, not forked per page").

### 3.3 `components/customers/customer-search-panel.tsx` (new, `'use client'`)

Props: `query: string`, `baseHref: string`.

```tsx
'use client'

export function CustomerSearchPanel({ query, baseHref }: { query: string; baseHref: string }) {
  const router = useRouter()
  const [value, setValue] = useState(query)
  const [isPending, startTransition] = useTransition()

  function apply(): void {
    const params = new URLSearchParams()
    if (value.trim()) params.set('q', value.trim())
    startTransition(() => {
      router.replace(params.toString() ? `${baseHref}?${params}` : baseHref)
    })
  }

  function clear(): void {
    setValue('')
    startTransition(() => router.replace(baseHref))
  }

  return (
    <div className={cn('flex items-center gap-2', isPending && 'opacity-60')}>
      <input
        aria-label="Search customers by organization or trading name"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
        disabled={isPending}
        className={/* existing input chrome */}
      />
      <Button onClick={apply} disabled={isPending}>Apply</Button>
      {query && <Button variant="ghost" onClick={clear} disabled={isPending}>Clear</Button>}
    </div>
  )
}
```

- `router.replace`, not `push` — a search-term change is list state, not a navigable "selection" (`pm05` §2.3.8's history model, applied identically even though this page has nothing else in the URL to preserve).
- Local `value` state seeded from the `query` prop so the field reflects the current URL on load/back-navigation; typing doesn't navigate until Apply/Enter (no auto-navigate-on-keystroke, same rationale as `pm05` §2.3.6).
- `aria-label` since there's no visible `<label>` element — the input's purpose is stated in the header copy above it (general code-standards §4.9 still wants every input labelled, satisfied via `aria-label`).

### 3.4 `components/customers/customer-results-table.tsx` (new, Server Component)

Props: `results: CustomerSearchResults`, `basePath: string`.

```tsx
export function CustomerResultsTable({ results, basePath }: { results: CustomerSearchResults; basePath: string }) {
  if (results.results.length === 0) {
    return (
      <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-8 text-center text-muted-foreground">
        No customers match your search.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <table className="w-full border-collapse text-body-sm">
        <thead className="bg-[color:var(--surface-sunken)] text-overline uppercase text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left">Organization</th>
            <th className="px-3 py-2 text-left">Trading Name</th>
            <th className="px-3 py-2 text-left">Organization Status</th>
            <th className="px-3 py-2 text-left">Customer Status</th>
            <th className="px-3 py-2 text-left">Customer ID</th>
          </tr>
        </thead>
        <tbody>
          {results.results.map((row) => {
            const muted = row.customerStatus === 'CLOSED' || row.organizationStatus === 'DISSOLVED' || row.organizationStatus === 'MERGED'
            return (
              <tr key={row.partyRoleId} className={cn('border-b border-border', muted && 'text-muted-foreground')}>
                <td className="px-3 py-2">
                  <Link href={`${basePath}/${row.partyRoleId}`} className="hover:underline">
                    {row.organizationName}
                  </Link>
                </td>
                <td className="px-3 py-2">{row.tradingName ?? '—'}</td>
                <td className="px-3 py-2"><OrganizationStatusBadge status={row.organizationStatus} /></td>
                <td className="px-3 py-2"><CustomerStatusBadge status={row.customerStatus} /></td>
                <td className="px-3 py-2 font-mono tabular-nums text-muted-foreground">{row.partyRoleId}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {results.hasMore && (
        <p className="text-body-sm text-muted-foreground">
          Showing the first {results.limit} matches — refine your search for more precise results.
        </p>
      )}
    </div>
  )
}
```

- Whole cell (not the whole row) is the clickable `<Link>` — unlike `pm05`'s whole-row-clickable table (which needed `onClick`/`role="button"` because it was managing `?offering=` selection state), a plain semantic link is sufficient and simpler here since this **is** real navigation (general code-standards §4.9: keyboard-reachable, focus-visible — a real `<a>` gets this for free, no extra ARIA needed).
- No `--surface-selected` highlighting — there's no "currently selected" row concept on a page that navigates away entirely on click.

### 3.5 `components/customers/organization-status-badge.tsx` (new)

`cva`-based, modeled structurally on `pm05`'s `LifecycleBadge` (§2.2.7), keyed by `OrganizationStatus`, using the exact token/icon mapping from `custmgmt-ui-context.md` §1:

```tsx
const organizationStatusBadgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
  {
    variants: {
      status: {
        REGISTERED: 'bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]',
        ACTIVE: 'bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]',
        INACTIVE: 'bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]',
        SUSPENDED: 'bg-[color:var(--color-danger-50)] text-[color:var(--color-danger-700)]',
        DISSOLVED: 'bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]',
        MERGED: 'bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]',
      } satisfies Record<OrganizationStatus, string>,
    },
  },
)

const ORGANIZATION_STATUS_ICONS = {
  REGISTERED: ClipboardList,
  ACTIVE: CheckCircle,
  INACTIVE: PauseCircle,
  SUSPENDED: AlertOctagon,
  DISSOLVED: Archive,
  MERGED: GitMerge,
} as const satisfies Record<OrganizationStatus, LucideIcon>

const ORGANIZATION_STATUS_LABELS = {
  REGISTERED: 'Registered', ACTIVE: 'Active', INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended', DISSOLVED: 'Dissolved', MERGED: 'Merged',
} as const satisfies Record<OrganizationStatus, string>
```

Confirm `--color-danger-50`/`--color-danger-700` and `--color-info-50`/`--color-info-700` (needed by `CustomerStatusBadge` next) exist in `globals.css` already (base semantic families per `context/ui-context.md`, inherited unchanged — this module doc explicitly says it does not redefine them); if either is missing, add it to `globals.css` using the literal hex from `custmgmt-ui-context.md` §1–§2 (`#D92D2D`/`#8A1717` danger, `#1A73D9`/`#0C4084` info) rather than inlining hex in the component (code-standards §4.3).

### 3.6 `components/customers/customer-status-badge.tsx` (new)

Same construction as §3.5, keyed by `CustomerStatus`, per `custmgmt-ui-context.md` §2: `INITIALIZED` → warning + `PencilLine`; `VALIDATED` → info + `ShieldCheck`; `ACTIVE` → success + `CheckCircle`; `SUSPENDED` → danger + `AlertOctagon`; `CLOSED` → neutral + `Archive`.

### 3.7 `loading.tsx` / `error.tsx` — `app/(app)/customers/view/`

Per general code-standards §3.11: `loading.tsx` a simple skeleton (search bar shape + a few muted row-shaped bars); `error.tsx` a Client Component reporting to GlitchTip via the `lib/` telemetry helper and showing a non-leaking "Something went wrong loading customers" message with a retry action — same shape as every other module's route-segment error boundary, no new pattern invented.

### 3.8 Guardrail tests owned by this unit

- `tests/app/customers-view-page.test.tsx` (or the repo's page-test location, matching `pm05`'s `tests/app/product-offering-page.test.tsx` pattern) — mock `requirePermission`, `searchCustomers`:
  - **Guard blocks no-grant**: no `customers:READ` → the redirect sentinel fires before `searchCustomers` is ever called.
  - **Empty query**: `searchParams = {}` → `searchCustomers` **not called**, no table rendered, only the search panel.
  - **Deep link reproduces the view**: `searchParams = { q: 'Acme' }` → `searchCustomers` called with exactly `'Acme'`; results render.
  - **Tampered/oversized `q` → default**: a 500-character `q` or an array value falls back to `''` (schema `.catch()`), no crash, empty-start state renders.
- `tests/components/customer-search-panel.test.tsx` — typing + Apply navigates to `?q=<term>` via `router.replace`; Enter key does the same; Clear removes `q` and clears the local field; pending state disables both buttons.
- `tests/components/customer-results-table.test.tsx` — zero results renders the empty-state message, no table; ≥ 1 result renders the five columns with correct badge per row; a `CLOSED`/`DISSOLVED`/`MERGED` row is muted; `hasMore: true` renders the refine-search hint with the correct `limit`; `hasMore: false` renders no hint; each row's organization-name link points to `${basePath}/${partyRoleId}`.
- `tests/components/organization-status-badge.test.tsx` / `customer-status-badge.test.tsx` — each status renders its label + a non-decorative-to-AT icon; class contains the correct token per status (pattern: `pm05`'s `lifecycle-badge.test.tsx`).

No existing test assertions change — this unit adds a brand-new route and new components, editing no prior page (same note `pm05` made about itself).

### 3.9 Explicitly NOT in this unit

No `[id]/page.tsx` detail content (`cm05`). No Manage Customer page, action, or component (`cm06`+). No sort/pagination UI (none exists for this page). No `OrganizationTypeBadge`, `PreferredIndicator`, `StatusTransitionControl`, `InconsistencyBanner`, or `SpecificationEditor` (all needed by later units, not this one — built when first consumed). No authz-matrix file (`cm16`). No `actions/customer/*`, `app/api/customer*`, or mutation code.

---

## 4. Dependencies (packages to install)

**None.** `lucide-react`, `class-variance-authority`, `next/navigation` hooks, `@/components/ui/button`, Zod, vitest + Testing Library are already installed. No DB/schema change — this unit is UI-only, consuming `cm02`'s services as-is.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `validation/customer/search-params.schema.ts`, `app/(app)/customers/view/page.tsx` + `loading.tsx` + `error.tsx` (new), `components/customers/customer-search-panel.tsx` + `customer-results-table.tsx` + `organization-status-badge.tsx` + `customer-status-badge.tsx` (new), the new test files. Nothing else.
- [ ] No `services/**`, `db/**`, `actions/**`, `app/api/**`, or `components/admin-nav.tsx` change.
- [ ] Page is a thin orchestrator: no repository or DB import; only `services/customer/search-customers`, the guard, and `components/customers/**`.
- [ ] `requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.READ)` is the first statement of the page body.
- [ ] searchParams reach `searchCustomers` only via the parsed, `.catch()`-defaulted `q` — never a raw param.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck` green — props typed to `cm02`'s `CustomerSearchResults`/`CustomerSearchResult`.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change.

**Behavior — the point of the unit**
- [ ] Signed in with `customers:READ`, clicking "View Customer" in the nav (`cm03`) lands an empty search box — no table, no empty-results message.
- [ ] **Guard**: a user without `customers:READ` is redirected to `/no-access`.
- [ ] **Search**: typing an organization or trading-name substring + Apply (or Enter) shows matching, capped results; Clear returns to the empty start state.
- [ ] **Hint**: with more matches than `CUSTOMER_SEARCH_RESULT_LIMIT`, the refine-search hint shows with the correct limit; with fewer, it doesn't.
- [ ] **Badges**: organization and customer statuses render with the exact colors/icons from `custmgmt-ui-context.md` §1–§2; a `CLOSED`/`DISSOLVED`/`MERGED` row is visibly muted.
- [ ] **Deep link**: reloading `?q=<term>` reproduces the exact result set.
- [ ] **Navigation**: clicking an organization name navigates to `/customers/view/<partyRoleId>` (currently a 404 until `cm05` — accepted interim state, no crash).
- [ ] **Loading state**: applying/clearing a search briefly dims the panel and disables its buttons (`useTransition`).

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm04` complete with the commit reference.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline (new read-only route with a working `customers:READ` guard — DAST sees `/no-access` for an unpermitted principal).

Any failing item means the unit isn't done. `cm05` (View Customer detail page) may start once this commit is verified and merged — it consumes the same guard pattern and both new badge components; `cm06` (Manage Customer search page) reuses `search-params.schema.ts` and `CustomerResultsTable` unchanged.
