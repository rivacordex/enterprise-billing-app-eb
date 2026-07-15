# CM06 — Manage Customer: Search Page

- **Unit:** 6 of 16 (`cm00-build-plan.md`)
- **Dependencies:** `cm02` (`searchCustomers`), `cm04` (`CustomerSearchPanel`, `CustomerResultsTable`, `validation/customer/search-params.schema.ts` — all reused **unchanged**), `cm03` (nav link + the corrected `/customers/manage` path) verified and merged.
- **Authorizing sections:** `custmgmt-project-overview.md` *Core user flow* steps 2–4; `custmgmt-architecture.md` §2 (`app/(app)/customers/manage/` row — "declares `customers : EDIT`"), §4; `custmgmt-code-standards.md` §3.1, §4.6, §7 (file tree), §8; `custmgmt-ui-context.md` §7 (`--action-cta-bg` for "Add new customer"); general `code-standards.md` §3.6, §3.11.
- **Note on codebase verification:** no live-repo mount this session (as `cm01`–`cm05`). This unit is intentionally thin — it is almost entirely a re-skin of `cm04` at a higher permission level plus one new entry point, so this spec is correspondingly short; padding it out would misrepresent how little is actually new here.

---

## 1. Goal

Build `app/(app)/customers/manage/page.tsx` as a thin RSC orchestrator, identical in search behavior to `cm04`'s View Customer search page but guarded at `customers:EDIT`, reusing `CustomerSearchPanel` and `CustomerResultsTable` **unchanged** (only different `basePath`/`baseHref` prop values), with one addition: an "Add new customer" entry point to `/customers/manage/new` (`cm07`, not yet built — accepted interim 404, same pattern as every prior cross-unit link in this build plan). Visible result: a MANAGER reaches the same empty-start search experience under Manage as under View; a USER hitting `/customers/manage` directly (bypassing the greyed-out nav item from `cm03`) is rejected server-side, not just visually discouraged.

## 2. Design

### 2.1 This is deliberately not a new component tree

`code-standards §4.6` is explicit: "one `CustomerResultsTable` component shared by View and Manage, not forked per page." Nothing about search itself differs between the two pages — same match rule, same cap/hint, same empty-start behavior (`cm02`'s `searchCustomers` has no permission-level parameter; it means the same thing to both callers). So this unit's entire job is: swap the guard level, swap the two `basePath`/`baseHref` string props, and add the one thing View doesn't have — a way to create a customer.

### 2.2 Decisions

1. **Guard is `requirePermission('customers', 'EDIT')`** — the only functional difference from `cm04`'s page body. A USER (holding `customers:READ` only, per `cm01`'s seed) is redirected to `/no-access` here even though they'd pass on `/customers/view`; this is the guard `cm03`'s greyed/locked nav item was anticipating (§2.3.5 of that spec) — this unit is what makes that lock icon's promise real, since until now nothing actually enforced it server-side.
2. **Row links point to `/customers/manage/[id]`** (`cm08`, the edit page — not yet built) via `basePath="/customers/manage"` passed to the same `CustomerResultsTable` from `cm04`. No fork, no new results-table variant.
3. **"Add new customer" is a prominent, always-visible CTA**, not conditioned on having searched first. The overview's flow narrates search-then-create as the *recommended* order ("Search the intended name first ... Confirm the customer does not already exist. Click Add new customer"), but nothing in scope requires *disabling* creation until a search happens — this unit renders the CTA as a persistent, small nudge-copy pairing instead of a hard gate: the button is always clickable, with a one-line caption underneath ("Search first to confirm this customer doesn't already exist") rather than a disabled state that would fight the overview's own non-blocking framing (`registration_number` collisions are still caught server-side in `cm07` regardless of whether the user searched first).
4. **The CTA uses `--action-cta-bg`** (ui-context §7: "the featured CTA for 'Add new customer' and 'Add contact'") — this is the first place that token is consumed; `cm11`'s "Add contact" button will reuse it, not redefine it.
5. **No new searchParams schema, no new badge, no new indicator.** Everything visual this page needs (`OrganizationStatusBadge`, `CustomerStatusBadge`, the results table, the search panel, the `q` schema) already exists from `cm04`. This unit adds exactly one component: the CTA button block (small enough to inline in the page, not worth its own file — see §3.1).

### 2.3 What this unit explicitly does NOT do

No `/customers/manage/new` page (`cm07`). No `/customers/manage/[id]` edit page (`cm08`). No mutation, no `actions/customer/*`. No fork of `CustomerSearchPanel`/`CustomerResultsTable` — both imported and used exactly as `cm04` built them. No authz-matrix file (`cm16`, though the EDIT-vs-USER guardrail is this unit's own test, per `cm00`'s "Guardrail tests owned here" note).

## 3. Implementation

### 3.1 Page — `app/(app)/customers/manage/page.tsx` (new)

```tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { Plus } from 'lucide-react'

import { requirePermission } from '@/auth/guard'
import { LEVELS, PERMISSIONS } from '@/auth/permission-constants'
import { CustomerSearchPanel } from '@/components/customers/customer-search-panel'
import { CustomerResultsTable } from '@/components/customers/customer-results-table'
import { searchCustomers } from '@/services/customer/search-customers'
import { customerSearchParamsSchema } from '@/validation/customer/search-params.schema'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Manage Customer' }

export default async function ManageCustomerSearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}): Promise<React.JSX.Element> {
  await requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT)

  const raw = await searchParams
  const parsed = customerSearchParamsSchema.parse({ q: firstValue(raw.q) })

  const results = parsed.q ? await searchCustomers(parsed.q) : null

  return (
    <main className="space-y-6 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-h1 font-semibold text-foreground">Manage Customer</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Search for an existing customer, or add a new one.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Link
            href="/customers/manage/new"
            className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--action-cta-bg)] px-3 py-2 text-body-sm font-semibold text-white"
          >
            <Plus size={16} aria-hidden />
            Add new customer
          </Link>
          <span className="text-caption text-muted-foreground">
            Search first to confirm this customer doesn't already exist.
          </span>
        </div>
      </header>

      <CustomerSearchPanel query={parsed.q} baseHref="/customers/manage" />

      {results !== null && (
        <CustomerResultsTable results={results} basePath="/customers/manage" />
      )}
    </main>
  )
}

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
```

- `firstValue`, the guard-first ordering, the empty-query short-circuit (`results !== null`), and the overall shape are **line-for-line the same pattern as `cm04`** — only the guard's level argument, the header copy, the CTA block, and the two `basePath`/`baseHref` values differ. This duplication is accepted: each page is a ~40-line thin orchestrator, and extracting a shared "search page shell" for two call sites this small would be premature abstraction (general code-standards §1.13, "pure functions and small modules" — not "zero duplication at any cost").
- `metadata.title` is `"Manage Customer"`, per code-standards §3.9's fixed-per-route-group rule (mirrors `cm04`'s `"View Customer"`).

### 3.2 `loading.tsx` / `error.tsx` — `app/(app)/customers/manage/`

Same shape as `cm04`'s View equivalents (skeleton search bar + muted row bars; Client Component error boundary reporting to GlitchTip). No new pattern.

### 3.3 Guardrail tests owned by this unit

- `tests/app/customers-manage-page.test.tsx` (mirrors `cm04`'s page test, mock `requirePermission`, `searchCustomers`):
  - **EDIT passes**: a MANAGER-shaped grant renders the page normally, including the CTA.
  - **USER → `/no-access`** — this is the unit's authz-matrix entry (`cm00`'s "Guardrail tests owned here"): a session holding `customers:READ` only (not `EDIT`) is redirected to `/no-access` when hitting `/customers/manage` **directly** (not via the nav) — proving `cm03`'s greyed/locked nav treatment is cosmetic and this guard is the real boundary, exactly as that spec's own checklist flagged as depending on this unit.
  - **Empty query / deep link / tampered `q`** — identical assertions to `cm04`'s three cases, since the parsing logic is byte-identical.
  - **CTA present and points to `/customers/manage/new`** regardless of search state (present with `q` empty, present with results, present with zero results).
- No new tests needed for `CustomerSearchPanel`/`CustomerResultsTable` themselves — `cm04`'s test suite already covers their behavior; this unit only asserts they receive the correct `basePath="/customers/manage"` / `baseHref="/customers/manage"` props (a shallow render-prop assertion, not a re-test of their internals).

No existing test assertions change — new route, and `cm04`'s components are consumed, not modified.

### 3.4 Explicitly NOT in this unit

No `/customers/manage/new` (`cm07`) or `/customers/manage/[id]` (`cm08`) page. No edit to `CustomerSearchPanel`, `CustomerResultsTable`, or `search-params.schema.ts` (all reused verbatim from `cm04`). No `actions/customer/*`, no mutation. No authz-matrix file (`cm16`).

---

## 4. Dependencies (packages to install)

**None.** `lucide-react` (`Plus`), `next/link`, Zod, vitest + Testing Library already installed. No DB/schema change.

## 5. Verification checklist

**Diff hygiene**
- [ ] Changed/added: `app/(app)/customers/manage/page.tsx` + `loading.tsx` + `error.tsx` (new), the new test file. Nothing else — in particular, no edit to any `cm04` file.
- [ ] `CustomerSearchPanel` and `CustomerResultsTable` are imported, not copied or forked.
- [ ] `requirePermission(PERMISSIONS.CUSTOMERS, LEVELS.EDIT)` is the first statement of the page body.
- [ ] No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `npm run test` green — zero pre-existing assertions change (including every `cm04` test, untouched).

**Behavior — the point of the unit**
- [ ] Signed in as a MANAGER, clicking "Manage Customer" in the nav lands the same empty-start search experience as View, plus the "Add new customer" CTA.
- [ ] Signed in as a USER, directly navigating to `/customers/manage` (typing the URL, not clicking the locked nav item) redirects to `/no-access` — this is the guardrail `cm03`'s checklist explicitly deferred to this unit.
- [ ] Search behaves identically to `cm04` (same matches, same cap/hint, same empty-start state).
- [ ] "Add new customer" navigates to `/customers/manage/new` (currently a 404 until `cm07` — accepted interim state, no crash) and is present regardless of whether a search has been performed.
- [ ] Clicking an organization name in results navigates to `/customers/manage/<partyRoleId>` (currently a 404 until `cm08` — accepted interim state).

**Docs in sync**
- [ ] `custmgmt-progress-tracker.md` marks `cm06` complete with the commit reference.

**Pipeline**
- [ ] CI green end-to-end including SAST/ZAP DAST baseline (new EDIT-guarded route — DAST sees `/no-access` for both an unauthenticated principal and a READ-only one).

Any failing item means the unit isn't done. `cm07` (create customer + add-new page) and `cm08` (edit page + update-organization) both depend on the exact `/customers/manage/new` and `/customers/manage/[id]` paths this page already links to.
