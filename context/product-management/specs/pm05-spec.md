# PM05 — Page: Guard + searchParams + Offerings Table

- **Unit:** 5 of 9 (`pm00-build-plan.md`)
- **Dependencies:** pm01 (route-group rename `(admin)` → `(app)`), pm02 (data layer: `validation/product/offering-list.schema`, `PERMISSIONS.PRODUCTS`, `types/product.ts`), pm03 (repositories + `services/product`: `listOfferings`, `getOfferingDetail`, read models) — **all verified and merged**. pm04 (nav "Products" section) supplies the link that reaches this page; it is independent and may land in either order, but the *visible result* ("reaches the working table from the nav") requires pm04 too. pm05 must not start before pm02+pm03 are merged (`pm00-build-plan.md` dependency graph).
- **Authorizing sections:** overview *User Flow steps 2–4*, *Features — Catalog listing*, *Navigation & shell*, *Success Criteria*; `prodmgmt-architecture.md` §2 (`app/(app)/products/product-offering/` row — "thin orchestrator composing `components/`, no DB queries, no raw SQL"), §4 (page guard `requirePermission('products','READ')` → `/no-access`; nav permission-blind; READ gates everything — Inv. #10), §5 (price effectivity resolved at query time, no jobs); `prodmgmt-ui-context.md` §1 (`LifecycleBadge`), §5–§6 (mono IDs, tabular-nums, empty states, no gradients); `prodmgmt-code-standards.md` §2.6 (`?offering=` format-validated), §3.2–§3.3 (URL param list, lenient `.catch()` parse), §3.8 (nav permission-blind), §7 (`components/products/` tree); platform `architecture.md` §2 (boundary: UI → services → repositories), §5 (guard, 3-layer defense), Inv. #9 (page in authz matrix — deferred to pm09); general `code-standards.md` §1.5 (parse-at-the-edge), §2.4 (explicit return types), §3 (RSC/`"use client"` split).
- **Codebase state assumed at start (re-verify before implementing):** pm01–pm03 merged. Concretely: `app/(app)/` exists (no `app/(admin)/`); `auth/guard.ts` exports `requirePermission(name, level)` returning `{ userId, userEmail, permissionMap }` and calling `redirect("/no-access")` on insufficient level (verified 2026-07-04); `auth/permission-constants.ts` `PERMISSIONS` includes `PRODUCTS: "products"` and `LEVELS.READ` (PRODUCTS added by pm02 §3.4.2); `validation/product/offering-list.schema.ts` exports `offeringListSearchParamsSchema`, `OfferingListSearchParams`, `OFFERING_SORT_VALUES`; `services/product/list-offerings.ts` exports `listOfferings(params): Promise<OfferingListPage>`; `services/product/get-offering-detail.ts` exports `getOfferingDetail(id, now?): Promise<OfferingDetail | null>`; `types/product.ts` exports `OfferingListRow`, `OfferingListPage`, `OfferingDetail`, `LIFECYCLE_STATUSES`, `LifecycleStatus`. Established page/component patterns this unit mirrors: the master-detail page shell and `?…=` selection of `app/(app)/administration/users/page.tsx` (`?userId=`, `router.push`, `key={selectedId}` on the detail, `notFound` prop); the URL-driven server-side list controls of `app/(app)/administration/audit-log/page.tsx` + `components/audit-log/audit-log-filters.tsx` + `audit-log-pagination.tsx` (`"use client"`, `useRouter`/`usePathname`/`useSearchParams`, **Apply** button, `router.replace`, `page=1` reset on filter change); the `cva`-based badge of `components/status-badge.tsx` (the `LifecycleBadge` model); `lib/formatters.ts` `formatDatetime(date, locale, timezone, fallback)`; config accessors `getAppLocale()` / `getAppTimezone()` from `services/system-config/app-config-read.service`.

---

## 1. Goal

Deliver `app/(app)/products/product-offering/page.tsx` as a thin RSC orchestrator that guards the route with `requirePermission('products','READ')` (no grant → `/no-access`), parses the URL searchParams through the pm02 list schema (tampered URL → defaults, never a 500), calls `services/product` to render the **offerings table** — ID, name, `LifecycleBadge`, version, sellable flag, last modified — with server-side search, `lifecycle_status` filter (RETIRED hidden by default), column sort, and pagination all held in the URL, and writes `?offering=` on row selection so the view is deep-linkable and back-button-safe. The page lands the full four-section layout shell with empty/placeholder states for detail (§2), specifications (§3), and prices (§4); pm06–pm08 fill those regions. Visible result: a permitted user reaches a working, deep-linkable offerings table from the nav; an unpermitted user is bounced to `/no-access`.

## 2. Design

### 2.1 Boundary & composition

Boundary is **frontend only**: the RSC page plus `components/products/**` (`prodmgmt-architecture.md` §2, code-standards §7). The page is a thin orchestrator — it runs the guard, parses searchParams, calls **only** `services/product` use cases (never a repository, never raw SQL, no `next/*` data fetching beyond the RSC contract), and composes client components. No `actions/`, no `app/api/`, no mutation code (read-only v1, Inv. #11).

The page is a **Server Component** (`export const dynamic = "force-dynamic"`, matching the Administration pages — permissions resolve per request). The interactive controls (search box, status filter, sortable headers, pagination, row click) are **client components** under `components/products/`, receiving data + current URL state as props and pushing state changes back into the URL. This is the exact RSC/`"use client"` split the audit-log page already uses; the users page supplies the master-detail selection half.

### 2.2 Page layout (four-section shell)

Per overview *User Flow* steps 3–7, the page is a single four-section vertical layout — **not** the side-by-side two-pane of the Users page:

```
┌───────────────────────────────────────────────┐
│ Header: "Product Offering" + subtitle          │
├───────────────────────────────────────────────┤
│ Section 1 — Offerings table (full width)        │  ← pm05 (this unit)
│   search · status filter · sortable headers ·   │
│   rows · pagination                             │
├───────────────────────────────────────────────┤
│ Section 2 — Selected offering detail (full width)│  ← pm05 scaffold, pm06 fills
├──────────────────────┬────────────────────────┤
│ Section 3 — Specs     │ Section 4 — Prices       │  ← pm05 scaffold, pm06→08 fill
│ (bottom-left)         │ (bottom-right)           │
└──────────────────────┴────────────────────────┘
```

Sections 2–4 are wrapped in an **`OfferingDetailRegion`** (new, `components/products/`) that owns the "no selection" and "not found" empty states for all three at once (decision below). Flat, data-dense, no marketing gradients (ui-context §0.2, §5).

### 2.3 Pre-made decisions (cited)

1. **Full four-section scaffold in pm05** *(user decision 2026-07-04)*. pm05 lands the whole page skeleton — header, table, and the detail/specs/prices region with empty + not-found states — so the layout is real from this unit. pm06 replaces the detail placeholder with populated detail, pm07 the specs placeholder, pm08 the prices placeholder. To keep the unit boundary clean, pm05's `OfferingDetailRegion` renders **only** empty/placeholder states; it does not render any offering *field* (that is pm06's surface). The populated branch is a single `{/* pm06: populated detail */}` seam per section.
2. **`?offering=` selection wiring lives here** (pm06 dependency note: "selection + guard + `getOfferingDetail` already wired"). The page calls `getOfferingDetail(parsed.offering, now)` when `parsed.offering !== null`, and threads the result (or `null`) into `OfferingDetailRegion`. pm05 uses the result **only** to decide empty vs not-found vs "has selection" — it does not render fields. `now` is `new Date()` at request time (architecture §5: effectivity resolved at query time, per-request).
3. **Guard is READ-only, deny-by-default** (architecture §4, Inv. #10). `await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ)` is the first statement; insufficient grant → `redirect("/no-access")` inside the guard. READ gates the *entire* page including the (future) prices section — no partial rendering under a weaker check, no per-section guard. The returned `permissionMap` is **not** used for any edit affordance in v1 (no CTA — ui-context §5); it is destructured only if a later unit needs it, else left unbound.
4. **Parse at the edge, never trust the URL** (general §1.5, code-standards §3.3). searchParams are run through `offeringListSearchParamsSchema` (pm02) which `.catch()`-defaults every field, so a tampered/garbage URL yields the default view (empty search, RETIRED hidden, `sort=name` asc, `page=1`, `offering=null`) and never throws. The page passes the **parsed** object to the service — the service never sees raw searchParams (pm03 §3.5).
5. **RETIRED hidden by default is service behavior** (pm02 §3.6, pm03 Design #5): `status: null` ⇒ service excludes RETIRED. The status filter offers `All (non-retired)` = default and an explicit choice per `LIFECYCLE_STATUSES` (choosing `RETIRED` shows only retired rows). The page adds **no** RETIRED logic of its own.
6. **Search uses an explicit Apply button + Enter key + loading state** *(user decision 2026-07-04; consistency with `audit-log-filters.tsx`)*. The search box does not auto-navigate on keystroke; the user types and clicks **Apply** or presses **Enter** in the field. Applying resets `page` to `1` (audit-log precedent) and preserves the current `offering` selection, `status`, and `sort`. A **Clear** button appears when a search term is active. While the RSC re-render is in flight, controls show a pending state via `useTransition` / `router` navigation state (see §3.4).
7. **Column sort = clickable headers**, server-side, URL-driven (overview: "sort columns"; "Server-side paginated, sortable table driven entirely by URL searchParams"). Clicking a sortable header sets `sort` to that column ascending; clicking the already-active column toggles the `-` descending prefix (the `OFFERING_SORT_VALUES` encoding, pm02 Design #10). Sortable columns: `name`, `product_offering_id`, `lifecycle_status`, `version`, `last_modified` (the five columns rendered; `is_sellable` is display-only, not in `OFFERING_SORT_VALUES`, so its header is not clickable). Sorting resets `page` to `1` and preserves `q`, `status`, `offering`.
8. **History model — select=push, list=replace** *(user decision 2026-07-04)*. Row selection (`?offering=`) uses `router.push` so the browser Back button deselects / returns to the prior selection (Users-page precedent, "back-button-safe"). List-state changes (search, filter, sort, page) use `router.replace` so history isn't polluted by every keystroke or sort toggle (audit-log precedent). Both preserve the other params via `URLSearchParams` merge. Deep links (`?offering=…&q=…&sort=…&page=…`) reproduce the exact view (the pm05 guardrail).
9. **Deterministic empty & not-found states** (ui-context §6). Table with zero matching rows → an in-table empty row ("No offerings match your filters", `--text-muted` on `--surface-sunken`, icon). Detail region with `offering=null` → "Select an offering to view its details". Detail region with a non-null `offering` that `getOfferingDetail` resolved to `null` (unknown/tampered ID that still passes the `PRDOFR\d{6}` regex) → "Offering not found" not-found state. These three are pm05's owned guardrail surfaces.
10. **`LifecycleBadge` is a new shared component** in `components/products/` (build plan pm05; ui-context §1), modeled exactly on `components/status-badge.tsx` (cva variants, `-bg` tint + `-fg` text, icon + label, `--radius-pill`). It is created here because the table is its first consumer; pm06 reuses it in the detail section. Icons/colors per ui-context §1: `ACTIVE` check-circle success, `DRAFT` pencil-line warning, `RETIRED` archive neutral (and the RETIRED **row** renders muted).
11. **Typography/format** (ui-context §5): `product_offering_id` and `version` in `--font-mono` with `tabular-nums`; `last_modified` via `lib/formatters.formatDatetime(date, locale, timezone)` with `locale`/`timezone` resolved server-side (`getAppLocale()` / `getAppTimezone()`) and threaded as props (client components can't read config — um28/um29 precedent). Sellable flag renders as a quiet chip only when notable (see §3.3).

### 2.4 What pm05 explicitly does NOT do

No detail/spec/price **field rendering** (pm06–08). No `LifecycleBadge`/`PriceTypeBadge` usage beyond the table's lifecycle column (`PriceTypeBadge` is pm08). No authz-matrix entry (pm09 owns the matrix + guardrail sweep). No mutation, no CTA, no `actions/`, no `app/api/`. No new service or repository code (consumes pm03 as-is). No nav change (pm04).

## 3. Implementation

### 3.1 Page — `app/(app)/products/product-offering/page.tsx` (new)

Thin orchestrator, Server Component. Shape (mirrors audit-log + users pages):

```tsx
import type { Metadata } from "next";
import { Suspense } from "react";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { OfferingTable } from "@/components/products/offering-table";
import { OfferingDetailRegion } from "@/components/products/offering-detail-region";
import { listOfferings } from "@/services/product/list-offerings";
import { getOfferingDetail } from "@/services/product/get-offering-detail";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";
import { offeringListSearchParamsSchema } from "@/validation/product/offering-list.schema";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Product Offering — Enterprise Billing",
};

export default async function ProductOfferingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  // products is page-level READ (Inv. #10) — READ gates the whole page,
  // including the future prices section; no per-section guard follows.
  await requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ);

  const raw = await searchParams;
  // Lenient parse (pm02 §3.6): every field .catch()-defaults, so a tampered
  // URL renders the default view and never 500s.
  const parsed = offeringListSearchParamsSchema.parse({
    q: firstValue(raw.q),
    status: firstValue(raw.status) ?? null,
    sort: firstValue(raw.sort),
    page: firstValue(raw.page) ?? 1,
    offering: firstValue(raw.offering) ?? null,
  });

  const timezone = getAppTimezone(); // sync accessor — outside Promise.all
  const [offeringPage, selectedOffering, locale] = await Promise.all([
    listOfferings(parsed),
    parsed.offering
      ? getOfferingDetail(parsed.offering)
      : Promise.resolve(null),
    getAppLocale(),
  ]);

  return (
    <main className="space-y-6 p-6">
      <header>
        <h1 className="text-h1 font-semibold text-foreground">Product Offering</h1>
        <p className="mt-1 text-body text-muted-foreground">
          Browse the read-only catalog of product offerings, their
          specifications, and prices.
        </p>
      </header>

      <Suspense>
        <OfferingTable
          rows={offeringPage.rows}
          total={offeringPage.total}
          page={offeringPage.page}
          pageSize={offeringPage.pageSize}
          selectedOfferingId={parsed.offering}
          query={parsed.q}
          status={parsed.status}
          sort={parsed.sort}
          locale={locale}
          timezone={timezone}
        />
      </Suspense>

      <OfferingDetailRegion
        key={parsed.offering ?? "none"}
        hasSelection={parsed.offering !== null}
        notFound={parsed.offering !== null && selectedOffering === null}
        // pm06–08 will consume `offering={selectedOffering}` here.
      />
    </main>
  );
}
```

- `firstValue(value)` — the same `Array.isArray(value) ? value[0] : value` helper as the audit-log page (searchParams can be arrays). Define it locally in the file (audit-log precedent) or lift to a shared util only if a second product page needs it.
- `getOfferingDetail(parsed.offering)` uses the service's default `now = new Date()` (pm03 §3.6) — per-request clock, no injected value in production.
- `key={parsed.offering ?? "none"}` remounts the detail region on selection change (users-page precedent) so pm06's populated state can't leak stale data across selections.
- **Guard is line 1 of the body** — nothing (not even searchParams parsing) runs before it (platform §5 defense-in-depth).

### 3.2 `components/products/lifecycle-badge.tsx` (new)

`cva`-based, copied structurally from `status-badge.tsx`, keyed by `LifecycleStatus` (`types/product.ts`). Per ui-context §1:

```tsx
import { Archive, CheckCircle, PencilLine } from "lucide-react";
import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { LifecycleStatus } from "@/types/product";

const lifecycleBadgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider",
  {
    variants: {
      status: {
        ACTIVE:
          "bg-[color:var(--color-success-50)] text-[color:var(--color-success-700)]",
        DRAFT:
          "bg-[color:var(--color-warning-50)] text-[color:var(--color-warning-700)]",
        RETIRED:
          "bg-[color:var(--color-neutral-100)] text-[color:var(--color-neutral-700)]",
      } satisfies Record<LifecycleStatus, string>,
    },
  },
);

const LIFECYCLE_ICONS = {
  ACTIVE: CheckCircle,
  DRAFT: PencilLine,
  RETIRED: Archive,
} as const satisfies Record<LifecycleStatus, typeof CheckCircle>;

const LIFECYCLE_LABELS = {
  ACTIVE: "Active",
  DRAFT: "Draft",
  RETIRED: "Retired",
} as const satisfies Record<LifecycleStatus, string>;
```

Render: `<span>` with icon (`size={12}`, `aria-hidden`) + label, never white-on-tint, icon always present (ui-context §6 — meaning never depends on color alone). Pure presentational component; no `"use client"` needed (it renders inside the client table but is import-clean either way). Confirm the `--color-success-*` / `--color-warning-*` / `--color-neutral-*` custom properties exist in `globals.css` (they back `status-badge.tsx`, so they do; ui-context §1 supplies the exact hexes if a token is missing — define in `globals.css`, never inline hex, code-standards §4.3).

### 3.3 `components/products/offering-table.tsx` (new, `"use client"`)

Owns search + status filter + sortable headers + rows + pagination + row selection. One component (or a small in-file set: `OfferingTable`, `OfferingSearchBar`, `OfferingStatusFilter`, `OfferingTableRow`, `OfferingPagination`) — keep it in `components/products/` per the tree; extract sub-files only if any exceeds the codebase's soft component-size norm.

Props: `rows: OfferingListRow[]`, `total`, `page`, `pageSize`, `selectedOfferingId: string | null`, `query: string`, `status: LifecycleStatus | null`, `sort: (typeof OFFERING_SORT_VALUES)[number]`, `locale: string`, `timezone: string`.

**URL helpers** (mirror audit-log): read current params via `useSearchParams`; build the next URL by cloning into `new URLSearchParams`, mutating the relevant key(s), and calling `router.replace` (list state) or `router.push` (selection). Centralize in small handlers:

- `applySearch(next: string)` — set/delete `q`, set `page=1`, `router.replace`. Triggered by Apply button click **and** `onKeyDown` Enter in the input (decision §2.3.6).
- `clearSearch()` — delete `q`, set `page=1`, `router.replace`; the local input state also clears.
- `applyStatus(next: LifecycleStatus | "")` — set/delete `status`, set `page=1`, `router.replace`. `""` = default (non-retired).
- `applySort(column)` — compute next `sort` (toggle `-` if already active on that column, else column asc), set `page=1`, preserve `q`/`status`/`offering`, `router.replace`.
- `goToPage(n)` — set `page=n`, preserve everything else, `router.replace`.
- `selectRow(id)` — set `offering=id`, preserve list params, `router.push`.

**Search bar**: controlled `<input>` seeded from `query` prop via `useState`; **Apply** button (`@/components/ui/button`) + Enter-key handler; **Clear** button shown when `query` non-empty. `aria-label="Search offerings by name"`. Escape the value? No — the service escapes `%`/`_` for ilike (pm03 §3.2); the client passes the raw string.

**Status filter**: `<select>` (audit-log `<select>` styling) — options `All` (value `""`, the non-retired default), `Active`, `Draft`, `Retired` from `LIFECYCLE_STATUSES`. `onChange` → `applyStatus`. `aria-label="Filter by lifecycle status"`.

**Table** (`status-badge`/`user-table` visual language — `border-collapse`, `text-overline` uppercase muted headers, `--surface-sunken` header row, `--border-subtle` row borders, hover tint):

| Column | Header | Sortable (`sort` key) | Cell |
|---|---|---|---|
| ID | `ID` | `product_offering_id` | `--font-mono` `tabular-nums`, `row.productOfferingId` |
| Name | `Name` | `name` | `text-foreground` medium, `row.name` |
| Status | `Lifecycle` | `lifecycle_status` | `<LifecycleBadge status={row.lifecycleStatus} />` |
| Version | `Version` | `version` | `--font-mono` `tabular-nums`, `row.version` |
| Sellable | `Sellable` | — (not in `OFFERING_SORT_VALUES`) | chip per §2.3.11 |
| Last modified | `Last Modified` | `last_modified` | `formatDatetime(row.lastModified, locale, timezone)`, whitespace-nowrap |

- **Sortable headers**: a `<button>` inside `<th>` (keyboard-focusable), showing a `ChevronUp`/`ChevronDown` when it's the active `sort` column (direction from the `-` prefix), calling `applySort(column)`. `aria-sort` set to `ascending`/`descending`/`none` on each `<th>`.
- **Sellable cell** (ui-context §3): render a quiet neutral `Sellable` chip (`shopping-cart` icon) when `row.isSellable` is true; when `row.isSellable` is false **and** `row.lifecycleStatus === "ACTIVE"`, render the warning-tinted **"Not sellable"** chip (the combination Billing Ops must notice); otherwise render "—". (Note: `OfferingListRow` exposes `isSellable` + `lifecycleStatus`, so this rule is computable from the list row — pm03 §3.1.)
- **RETIRED row muting** (ui-context §1): when `row.lifecycleStatus === "RETIRED"`, add `--text-muted` to the row (retired rows only appear when the user explicitly filters to Retired).
- **Selected row**: when `row.productOfferingId === selectedOfferingId`, apply `--surface-selected` (ui-context §5). Whole row is clickable (`onClick={() => selectRow(row.productOfferingId)}`, `role="button"`, `tabIndex=0`, Enter/Space handler, `aria-current` when selected) — users-page interaction.
- **Empty state**: `rows.length === 0` → single full-span row, centered, muted icon + "No offerings match your filters" on `--surface-sunken` (ui-context §6).

**Pagination**: reuse the audit-log pagination shape (Prev/Next + "Page X of Y" + "Showing a–b of N offerings"), but as a product component using `goToPage` (which `router.replace`s and preserves all other params — critically the `offering` selection). `totalPages = Math.ceil(total / pageSize)`; Prev disabled on page 1, Next disabled on last page; render only when `total > 0`.

**Loading/pending state** (decision §2.3.6): wrap navigations in `useTransition` — `const [isPending, startTransition] = useTransition()` and call `startTransition(() => router.replace(...))`. While `isPending`, dim the table (`opacity-60 transition-opacity`) and disable the Apply/Clear/pagination controls so double-submits can't race. This is additive to the audit-log pattern (which lacked an explicit pending state).

### 3.4 `components/products/offering-detail-region.tsx` (new)

The four-section-shell wrapper for sections 2–4, rendering **only** empty + not-found states in pm05:

Props (pm05): `hasSelection: boolean`, `notFound: boolean`. (pm06 will add `offering: OfferingDetail | null`; the prop is intentionally omitted now so pm06's diff adds it — decision §2.3.1.)

Behavior:

- `notFound === true` (a well-formed `PRDOFR…` id that resolved to no row) → a single not-found card spanning the region: `archive`/`search-x` icon, "Offering not found", muted, on `--surface-sunken` — "the selected offering no longer exists or the link is stale."
- `hasSelection === false` → "Select an offering to view its details, specifications, and prices." muted, on `--surface-sunken`.
- `hasSelection === true && notFound === false` → renders the three-section frame (Detail full-width; Specs bottom-left / Prices bottom-right via a `grid gap-4 lg:grid-cols-2`) with a per-section placeholder (`{/* pm06: populated detail */}`, `{/* pm07: specs cards */}`, `{/* pm08: prices cards */}`) so pm06–08 each land in a known seam. In pm05 the populated branch shows a neutral "Loading offering details…"-style placeholder is **not** used (data is already resolved server-side); instead each section shows a minimal titled empty frame ("Details", "Specifications", "Prices") so the layout is visible and testable. Keep these placeholders trivially replaceable.

Server component is fine (no interactivity); it receives booleans only. Sections use `--surface-card` on `--surface-app`, `--border-default` (ui-context §5).

### 3.5 Guardrail tests owned by this unit

Component/RSC tests under `tests/` (vitest + Testing Library; patterns: `tests/components/audit-log-*`, `tests/components/user-table.test.tsx`, and any existing page/guard test). The three pm05-owned guardrails are **deep link reproduces the view**, **unknown ID → empty/not-found state**, and **guard blocks no-grant**.

- `tests/components/offering-table.test.tsx` —
  - Renders the six columns and one row per `OfferingListRow`; ID/version render mono; `LifecycleBadge` shows the row's status label.
  - **Sort**: clicking the `Name` header when inactive navigates to `?sort=name&page=1` (preserving `q`/`status`/`offering`); clicking it again toggles `?sort=-name`; clicking `Version` sets `?sort=version`. Assert `router.replace` called with the expected URL (mock `next/navigation` like the audit-log tests). Non-sortable `Sellable` header renders no sort button and no `aria-sort` toggle.
  - **Search**: typing + clicking **Apply** navigates to `?q=<term>&page=1`; pressing **Enter** in the field does the same; **Clear** removes `q`. Page reset to 1 on each. `router.replace` (not `push`).
  - **Status filter**: selecting `Retired` navigates to `?status=RETIRED&page=1`; selecting `All` removes `status`.
  - **Pagination**: Next/Prev call `goToPage` preserving `offering` and `q`; disabled at bounds; hidden when `total === 0`.
  - **Row selection**: clicking a row calls `router.push` with `?offering=PRDOFR…` and preserves the current list params; the selected row carries `--surface-selected` / `aria-current`.
  - **Empty state**: `rows: []` renders the "No offerings match your filters" row, no data rows.
  - **RETIRED muting** and **Not-sellable** chip: a RETIRED row is muted; an ACTIVE + `isSellable:false` row shows the "Not sellable" warning chip.
- `tests/components/offering-detail-region.test.tsx` —
  - `hasSelection:false` → "Select an offering…" empty state; no section frames.
  - `hasSelection:true, notFound:true` → "Offering not found" state.
  - `hasSelection:true, notFound:false` → the three titled section frames render (Details / Specifications / Prices) — the seams pm06–08 fill.
- `tests/components/lifecycle-badge.test.tsx` — each `LifecycleStatus` renders its label + a (non-decorative-to-AT-hidden) icon; class contains the correct token per status (pattern: `status-badge` test if one exists).
- `tests/app/product-offering-page.test.tsx` (or the repo's page-test location) — **guard + parse + deep-link** behavior. Mock `requirePermission`, `listOfferings`, `getOfferingDetail`, `getAppLocale`/`getAppTimezone`:
  - **No grant**: `requirePermission` throws the redirect (mock it to throw a sentinel, as the guard does via `redirect()`), assert the page does not render the table and the redirect is invoked with `products`/`READ` — i.e. the guard is the first call and gates everything (Inv. #10). If the repo has an established guard-test helper (used by the audit-log/users page tests), follow it verbatim.
  - **Deep link reproduces the view**: given `searchParams = { q:"5G", status:"ACTIVE", sort:"-last_modified", page:"2", offering:"PRDOFR000001" }`, assert `listOfferings` is called with exactly the parsed object (`{ q:"5G", status:"ACTIVE", sort:"-last_modified", page:2, offering:"PRDOFR000001" }`) and `getOfferingDetail` with `"PRDOFR000001"`.
  - **Tampered URL → defaults**: `searchParams = { status:"BOGUS", sort:"drop table", page:"-3", offering:"PRDSMD000001" }` ⇒ `listOfferings` called with `{ q:"", status:null, sort:"name", page:1, offering:null }` and `getOfferingDetail` **not** called (offering defaulted to `null`). (This exercises the pm02 `.catch()` schema end-to-end.)
  - **Unknown but well-formed ID → not-found**: `offering:"PRDOFR999999"`, `getOfferingDetail` mocked → `null`; assert `OfferingDetailRegion` receives `notFound:true` / `hasSelection:true`.

No existing test assertions change — pm05 adds a brand-new route and new components; it edits no prior page. (The only cross-cutting page count that could exist is a route-manifest/authz test; the authz-matrix entry is **pm09**, so pm05 adds no matrix row and must not trip a "matrix ↔ routes in sync" test if one exists — if such a test exists and fails on the new unlisted route, that is a **pm09** concern flagged, not silenced here. Verify at implementation time whether pm01's route-manifest test enumerates pages; if it does, add `/products/product-offering` to that manifest as the conscious, called-out exception.)

### 3.6 Commit

One commit, e.g. `product offering page: guard + searchParams + offerings table (pm05)`. Contents: exactly `app/(app)/products/product-offering/page.tsx` (new), `components/products/lifecycle-badge.tsx` + `offering-table.tsx` + `offering-detail-region.tsx` (new), and the four new test files (plus a one-line route-manifest addition **iff** §3.5 finds such a test). Explicitly **not** in this commit: any `services/**`, `db/**`, `validation/**` change (pm02/pm03 own those); `components/admin-nav.tsx` (pm04); any `actions/product/`, `app/api/product*`, or mutation code; any authz-matrix file (pm09); any `PriceTypeBadge`, spec-chip, or price/spec field rendering (pm07/pm08); any dependency or lockfile change. Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` Unit 5 entry) stays outside the app-repo commit.

## 4. Dependencies

**No new npm packages.** Everything is already installed: `lucide-react` (icons), `class-variance-authority` + `cn` (badge), `next/navigation` hooks, `@/components/ui/button`, vitest + Testing Library. No DB, schema, or migration change (pm05 is UI-only). Requires pm02's `offeringListSearchParamsSchema` + `PERMISSIONS.PRODUCTS` and pm03's `listOfferings` / `getOfferingDetail` / read models already merged.

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**

- [ ] `git status` shows only: `app/(app)/products/product-offering/page.tsx` (new), `components/products/lifecycle-badge.tsx` + `offering-table.tsx` + `offering-detail-region.tsx` (new), the four new test files (and, only if §3.5 applies, a one-line route-manifest edit). Nothing else.
- [ ] No `services/**`, `db/**`, `validation/**`, `actions/**`, `app/api/**`, or `components/admin-nav.tsx` change.
- [ ] Page is a thin orchestrator: no raw SQL, no repository import, no DB client import; it imports only `services/product`, config accessors, the guard, and `components/products/**` (architecture §2).
- [ ] `requirePermission(PERMISSIONS.PRODUCTS, LEVELS.READ)` is the first statement of the page body; no per-section or weaker guard anywhere (Inv. #10).
- [ ] searchParams reach `listOfferings` only via `offeringListSearchParamsSchema.parse(...)` — the service never sees raw params (general §1.5).
- [ ] No `PriceTypeBadge`, spec chips, price/spec/detail **field** rendering (pm06–08); `OfferingDetailRegion` renders only empty/placeholder states.
- [ ] No CTA / edit affordance; `permissionMap` not used to gate any UI (v1 read-only, ui-context §5).
- [ ] No `TODO`, commented-out code, or `console.*` (the pm06–08 seams are `{/* … */}` JSX comments marking where the next unit lands — acceptable, and named by unit).

**Build gates**

- [ ] `npm run typecheck` green — props typed to the pm03 read models (`OfferingListRow`, `OfferingListPage`, `OfferingDetail`), `sort` typed to `OFFERING_SORT_VALUES`.
- [ ] `npm run lint` and `npm run format:check` green (boundary rule: no `next/*` server import inside a `"use client"` component beyond `next/navigation`).
- [ ] `npm run test` green — both vitest configs; **zero pre-existing assertions change** (new route + new components only).

**Behavior — the point of the unit**

- [ ] Signed in with `products : READ`, clicking "Product Offering" in the nav (pm04) lands the table showing the two seeded offerings (`TOREMOVE-Template-5G-…`, `TOREMOVE-Template-Enterprise-IoT-…`), RETIRED hidden by default.
- [ ] **Guard**: a user **without** `products : READ` is redirected to `/no-access`; the table never renders (deny by default, Inv. #10).
- [ ] **Search**: typing a name substring + **Apply** (or **Enter**) filters server-side and resets to page 1; **Clear** restores the full list; a `%`/`_` in the term matches literally (pm03 escaping) and doesn't error.
- [ ] **Filter**: choosing `Retired` shows only retired rows (muted); `All` returns to the non-retired default.
- [ ] **Sort**: clicking `Name` sorts asc, again sorts desc (chevron flips, `aria-sort` updates); `Version` and `Last Modified` sort numerically/chronologically; `Sellable` header is not clickable.
- [ ] **Pagination**: with page size 5 (pm03 config) and ≥ 6 rows present, Next/Prev page through; "Showing a–b of N", "Page X of Y"; selecting an offering then paging preserves `?offering=`.
- [ ] **Selection + deep link**: clicking a row sets `?offering=PRDOFR…` (URL updates, row highlights, detail region leaves the "Select an offering" state); reloading that URL reproduces the exact view (selection + list state); Back button deselects (push), while Back over a search/sort/page change does not step through every keystroke (replace).
- [ ] **Empty/not-found**: a filter matching nothing shows the in-table empty state; `?offering=PRDOFR999999` (well-formed, nonexistent) shows "Offering not found"; a malformed `?offering=xyz` is defaulted to no-selection by the schema (no crash).
- [ ] **Loading state**: applying a search / changing pages briefly dims the table and disables controls (`useTransition`), preventing double-submit races.
- [ ] Layout: the four-section shell is visible (table; detail; specs bottom-left / prices bottom-right) with placeholders — flat, no gradients (ui-context §0.2).

**Docs in sync**

- [ ] No companion-doc edit required: architecture §2/§4 already record this page and its guard as planned; the authz-matrix entry is **pm09**, not here.
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm05 complete with the commit reference.

**Pipeline**

- [ ] CI green end-to-end on the branch, including pm01's rename-invariance test (Administration pages unchanged under `(app)`) and SAST/DAST baseline (new read-only route, no new findings; the route has a working `products : READ` guard so DAST sees `/no-access` for an unauthenticated/unpermitted principal).

Any failing item means the unit is not done (workflow §8). Unit pm06 (offering detail section) may start once this commit is verified and merged — it consumes the `?offering=` selection, guard, and `getOfferingDetail` wiring landed here, and replaces the `OfferingDetailRegion` detail placeholder with populated fields.
