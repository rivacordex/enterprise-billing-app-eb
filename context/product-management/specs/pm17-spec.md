# PM17 — Nav: Relabel + "Manage Products" Entry

- **Unit:** 17 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** None functionally — independent of every backend unit (`pm10`–`pm16`), since the nav is a pure presentational shell keyed on hardcoded strings, not on any live product data. Sequenced here, immediately before `pm18` (Manage Products page shell), for narrative flow only — the identical role `pm00-build-plan.md`'s `pm04` played in Phase 1 (added the "Products" nav entry well before `pm05`'s page existed).
- **Authorizing sections:** `prodmgmt-project-overview-phase2.md` *Navigation & shell* ("The existing 'Product Offering' page is relabeled 'View Product' in the left nav and its page heading — same route, same components, same data logic, text-only change." / "New 'Manage Products' nav item added as a sibling of 'View Product,' both nested under the existing 'Products' section.") and *Access control* ("Nav items render regardless of permission; the page guard is what actually enforces access."); `prodmgmt-architecture-phase2.md` §2 (`components/admin-nav.tsx` row: *"Phase 2: 'Products' section now has two items — 'View Product' (relabeled) and 'Manage Products' (new), both under the same section heading."*) and §4 closing line (*"nav-renders-regardless-of-permission convention... unchanged"*); `prodmgmt-code-standards-phase2.md` §3.9 (View Product's `metadata.title`/H1 superseded to "View Product") and §7 (file tree — the nav change lives entirely in `admin-nav.tsx`, no new component file); `pm99-build-plan-phase2.md` Unit pm17 (this unit's literal contract, reproduced in the Goal below); `pm04-spec.md` (Phase 1's nav unit — the section-array edit pattern and inline icon-choice-reasoning convention this unit continues); `cm03-nav.md` plus the actual shipped `components/admin-nav.tsx` (the one existing precedent in this file for a permission-gated, greyed/locked nav item — this unit deliberately does **not** follow that pattern; see Design §2.2).

- **Codebase state verified 2026-07-22:** `components/admin-nav.tsx`'s `NAV_SECTIONS` "Products" section holds exactly one item today:
  ```ts
  {
    caption: "Products",
    items: [
      { label: "Product Offering", href: "/products/product-offering", icon: Package },
    ],
  },
  ```
  unchanged since `pm04` shipped it in Phase 1. The file's "Customer" section (added later by `cm03`) already demonstrates the optional `requiredPermission` + locked-rendering mechanism — and, per the actual shipped code (not `cm03-nav.md`'s original draft), **both** of its items gate on it: `View Customer` requires `customers:READ` and `Manage Customer` requires `customers:EDIT`, so with no `permissionMap` prop (or an insufficient one) both render as an inert `<span role="link" aria-disabled="true">` with a trailing lock icon rather than a real `<Link>`. The render loop, the `NavItem.requiredPermission` optional field, the `AdminNavProps.permissionMap` optional prop, and the fail-closed `locked` computation are all therefore already generic and already exercised by two working items — this unit needs zero changes to any of that machinery, only to the `NAV_SECTIONS` data array (see Design §2.1). `tests/components/admin-nav.test.tsx`'s first "expanded" test currently asserts five labelled links including `"Product Offering"` with `href="/products/product-offering"`; its local `permissionMap()` test fixture already has a `products` key (currently `null` in both `managerMap` and `userMap`, and never read by any item's `requiredPermission` today). No `app/(app)/products/manage-products/` page exists yet — that's `pm18` — so the new item's `href` 404s until then, the same accepted interim state `pm04` established for `/products/product-offering` before `pm05` shipped.

---

## 1. Goal

Relabel the existing "Product Offering" nav item to **"View Product"** (text-only — same `href`, same icon, same position) and add a new sibling item, **"Manage Products"** (`/products/manage-products`, new icon, no permission gate), both nested under the existing "Products" section in `components/admin-nav.tsx`, so the sidebar shows both entries well before the Manage Products page (`pm18`) exists — clicking "View Product" still works exactly as before; clicking "Manage Products" 404s until `pm18` lands.

## 2. Design

### 2.1 One array edit, zero render-loop changes

Unlike `pm04` (which built the sectioned-render loop from scratch) or `cm03` (which added the entire locked-rendering branch), this unit changes **only the data** — the `NAV_SECTIONS` "Products" section's `items` array — because both mechanisms this unit needs (rendering a plain item, and *not* declaring `requiredPermission`) already exist and are already exercised by "Product Offering" itself today. No edit to the `.map()` loop, the `NavItem`/`NavSection` types, the `locked` computation, or `AdminNavProps` is needed or in scope.

### 2.2 Deliberately no `requiredPermission` on "Manage Products" — do not copy the Customer-section pattern

This is the one decision in this unit worth over-explaining, because the file already contains a working, tested precedent (`cm03`'s "Manage Customer") for gating a nav item on `requiredPermission` and rendering it greyed/locked — and copying that pattern here would be the natural-looking but *wrong* move. Two authorizing sources are explicit and specific that the Product module does not do this:

- `prodmgmt-project-overview-phase2.md`'s *Access control* section: *"Nav items render regardless of permission; the page guard is what actually enforces access."*
- `prodmgmt-architecture-phase2.md` §4's closing line, calling out by name that the *"nav-renders-regardless-of-permission convention... [is] unchanged"* from Phase 1.

Both `View Product` (unchanged) and the new `Manage Products` item therefore get **no** `requiredPermission` field at all — a user with no `products` grant at any level still sees and can click "Manage Products," and is stopped by `pm18`'s page guard (`requirePermission(PERMISSIONS.PRODUCTS, LEVELS.EDIT)`), not by the nav. This is a real, intentional cross-module inconsistency — Customer chose the greyed-lock UX for its own reasons (`custmgmt-project-overview.md`'s Core User Flow explicitly narrates "a USER sees 'Manage Customer' greyed out with a lock icon"), Product's own overview never asks for that treatment anywhere — and it is not this unit's job to "fix" that inconsistency by silently adding a lock to Manage Products for symmetry. If a future reviewer flags the inconsistency, the answer is "confirmed intentional, cite `prodmgmt-architecture-phase2.md` §4," not a silent edit here.

### 2.3 Item order and position

"View Product" keeps its current first position in the array — it is relabeled in place, not moved. "Manage Products" is appended as the second item, matching both the build plan's own "sibling item" framing and `prodmgmt-code-standards-phase2.md` §8's permission-map table, which lists the View Product row before the Manage Products row.

### 2.4 Icon choice: `PackagePlus`

Checked against every icon already imported in this file (`Building2`, `Lock`, `Package`, `ScrollText`, `Settings`, `ShieldHalf`, `UserCog`, `Users` — no collisions) and verified present in the installed `lucide-react` (`^1.20.0` per `package.json`; `node_modules/lucide-react/dist/esm/icons/package-plus.mjs` exists). `Package` (View Product, unchanged) / `PackagePlus` (Manage Products, new) mirrors the same "same semantic family, distinct glyph" choice this file already made twice — `Building2`/`UserCog` for Customer's view/manage pair, and `Users`/`UserCog` for User Management vs. Customer administration — rather than reaching into an unrelated icon family or risking a near-duplicate of `Settings` (System Configuration) or `ShieldHalf` (Roles). Extend the existing icon-rationale comment block (the one currently ending in "...distinct from `Settings`'s gear-only meaning and from `Users` (already User Management's).") with one more sentence: `PackagePlus` for Manage Products — same catalog/goods family as `Package` (View Product), signaling the create/mutate capability the same way `Building2`/`UserCog` stay in one semantic domain while remaining visually distinct; no glyph collision with any existing nav or badge icon.

### 2.5 Route stays dead until `pm18` — accepted, not worked around

`/products/manage-products` has no page yet. Clicking the new item yields the Next.js default not-found, identical in kind to the `pm04`→`pm05` gap and the `cm03`→`cm04`/`cm06` gap already accepted elsewhere in this codebase's build history. Do not add a placeholder page (that is `pm18`'s job) and do not hide or disable the item while it's dead — it must render as a normal, clickable link from the moment this unit ships.

### 2.6 Flagged, not silently absorbed: the "View Product" page `H1`/`metadata.title` rename

`prodmgmt-code-standards-phase2.md` §3.9 is explicit that the existing page's `metadata.title` and `H1` are superseded to "View Product" — but neither this unit's literal contract in `pm99-build-plan-phase2.md` (*"Builds: `components/admin-nav.tsx`..."*, boundary *"Frontend shell component"*) nor `pm18`'s (*"Builds: `app/(app)/products/manage-products/page.tsx`..."*) actually assigns that one-line text edit to a specific unit. This is a real gap between the authorizing docs, called out here rather than either silently expanding this unit's boundary or silently dropping the requirement, per the build plan's own "not blocking, but not to be assumed silently" precedent (`_change-product-crud-plan.md`'s "Open items" section). **Recommendation:** fold it into this unit anyway — it is the same text-only-rename character as the nav relabel, touches `app/(app)/products/product-offering/page.tsx`'s heading/metadata only (no data, component, or import changes), and carries zero risk of pulling write-path code into the read-only page. This is called out as a build-time confirmation, not silently decided: if the implementer or reviewer prefers to hold it for `pm18` instead, that is an acceptable alternative — just don't let it fall through the crack between the two units unnoticed.

## 3. Implementation

### 3.1 `NAV_SECTIONS` — edit the "Products" section only

```ts
const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    caption: "Products",
    items: [
      {
        label: "View Product",
        href: "/products/product-offering",
        icon: Package,
      },
      {
        label: "Manage Products",
        href: "/products/manage-products",
        icon: PackagePlus,
      },
    ],
  },
  // "Customer" and "Administration" sections: untouched, byte-identical.
];
```

- Only the `label` field of the existing "Product Offering" item changes (to `"View Product"`) — its `href` and `icon` are untouched.
- The new "Manage Products" object has no `requiredPermission` key at all (Design §2.2) — do not add one, even set to a permissive-looking value.
- "Customer" and "Administration" section objects are not touched in this diff — copied verbatim, not even reformatted.

### 3.2 Icon import — add `PackagePlus`

Add `PackagePlus` to the existing `lucide-react` import, keeping the list's existing alphabetical order:

```ts
import {
  Building2,
  Lock,
  Package,
  PackagePlus,
  ScrollText,
  Settings,
  ShieldHalf,
  UserCog,
  Users,
  type LucideIcon,
} from "lucide-react";
```

Extend the icon-rationale comment block above `NAV_SECTIONS` with the one sentence from Design §2.4 — append it after the existing `Manage Customer`/`UserCog` sentence, don't rewrite the earlier ones.

### 3.3 Render loop, types, permission plumbing — no changes

Explicitly confirm (don't just assume) that `NavItem`, `NavSection`, `AdminNavProps`, the `.map()` render loop, and the `locked` computation in `components/admin-nav.tsx` are unmodified by this unit's diff. Both new/changed items flow through the exact same generic rendering path "Product Offering" already used and "View Customer"/"Manage Customer" already use for the locked branch — there is nothing product-specific left to build here.

### 3.4 Page heading — `app/(app)/products/product-offering/page.tsx` (see Design §2.6)

If folding in per the recommendation: change the page's `metadata.title` and its rendered `H1` text from "Product Offering" to "View Product," text only. No other line in this file changes — no data fetching, no component swap, no import added or removed. If instead deferred to `pm18`, do not touch this file in this unit's diff at all; note the deferral explicitly in the commit message and the progress-tracker entry (§5) so it isn't lost.

### 3.5 Tests — `tests/components/admin-nav.test.tsx` (extend, don't rewrite)

Working from the actual current file (reproduced in full in the research for this spec), make exactly these edits:

1. **"shows the Products and Administration captions and all five labelled links"** (expanded, `managerMap`) — becomes **six** labelled links: replace `"Product Offering"` with `"View Product"` in the loop array, add `"Manage Products"` to it. Update the trailing href assertion to target `"View Product"` (still asserting `href="/products/product-offering"`), and add a new assertion: `screen.getByRole("link", { name: "Manage Products" })` has `href="/products/manage-products"`.
2. **New assertion in the same test (or a new `it`): "Manage Products" renders as a real, unlocked link even with no `permissionMap` prop at all** — render `<AdminNav />` with no props, assert `screen.getByRole("link", { name: "Manage Products" })` exists and has **no** `aria-disabled` attribute. This is the regression guard that specifically distinguishes this unit's item from `cm03`'s fail-closed-locked "Manage Customer" — it must stay a plain link under every permission state, including the complete absence of a map.
3. **"marks the active route with aria-current=page"** — unaffected; still targets `"Users"`/`"Roles"`.
4. **"renders the Products caption before the Administration caption"** — unaffected.
5. **"has no divider between sections"** — unaffected; this unit doesn't add a section, only an item within an existing one, so the expanded-mode divider count (`0`) and the collapsed-mode divider count (currently driven by section count, not item count) do not change.
6. **"AdminNav — expanded, active state on product route"** describe block — rename the label asserted from `"Product Offering"` to `"View Product"`; `mockPathname` stays `"/products/product-offering"` (the route itself is unchanged).
7. **New describe block: "AdminNav — active state on manage-products route"** — set `mockPathname = "/products/manage-products"`; assert `"Manage Products"` has `aria-current="page"` and `"View Product"` does not, mirroring the existing product-offering active-state test's shape.
8. **"keeps all five links reachable with a title tooltip"** (collapsed) — becomes six: add `"Manage Products"` to the loop array (rename `"Product Offering"` to `"View Product"` in it too), asserting `title="Manage Products"` the same way every other collapsed item is checked.
9. **Every existing "Customer" section test** (`managerMap`/`userMap`-driven, `cm03`'s locked-rendering assertions, the divider-count-of-2-in-collapsed-mode assertion) — unaffected by this unit; the `Products` section's item count doesn't factor into any of those assertions. Confirm they still pass unmodified rather than assuming it.

### 3.6 Commit

One commit (plus, if §2.6/§3.4 is folded in, the page-heading file in the same commit — call this out explicitly in the commit message either way). Contents: `components/admin-nav.tsx`, `tests/components/admin-nav.test.tsx`, and optionally `app/(app)/products/product-offering/page.tsx` (text-only diff, §3.4). Explicitly **not** in this commit: any file under `app/(app)/products/manage-products/`, `actions/product/`, `services/product/`, `db/`, or `validation/`; any change to the "Customer" or "Administration" section objects; any change to `AdminNav`'s props, types, or render loop; any dependency or config change.

Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` entry for Unit pm17, including which way §2.6's page-heading question was resolved) is updated in the plan directory, outside the app repo commit.

## 4. Dependencies

**None.** No npm packages added, removed, or upgraded. `PackagePlus` ships with the already-installed `lucide-react` (`^1.20.0`, confirmed present in `node_modules`). No DB, schema, validation, service, or Server Action change of any kind — this is a frontend-shell-only unit.

## 5. Verification checklist

**Diff hygiene**
- [ ] `git status` shows only `components/admin-nav.tsx`, `tests/components/admin-nav.test.tsx`, and (only if §2.6/§3.4 was folded in) `app/(app)/products/product-offering/page.tsx`. Nothing else.
- [ ] The "Customer" and "Administration" `NAV_SECTIONS` objects are byte-identical to before this unit.
- [ ] No `requiredPermission` key appears anywhere on the "Manage Products" (or the relabeled "View Product") item object.
- [ ] `NavItem`, `NavSection`, `AdminNavProps`, the render loop, and the `locked` computation are all unmodified — diff them explicitly, don't just trust "I didn't mean to touch that."
- [ ] No second nav component or file created; `AdminNav`'s name, file, and `collapsed`/`permissionMap` prop contracts unchanged; `admin-sidebar.tsx` untouched.
- [ ] No `TODO`, commented-out code, or `console.*` introduced.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — all pre-existing `admin-nav` assertions pass (with the deliberate label-rename edits from §3.5), all new assertions pass, and every "Customer" section test passes completely unmodified.

**Behavior — the point of the unit**
- [ ] Dev-server, expanded sidebar: "Products" section shows "View Product" then "Manage Products," in that order; "View Product" navigates to `/products/product-offering` and behaves exactly as "Product Offering" did before this unit (same active-state highlighting).
- [ ] Clicking "Manage Products" navigates to `/products/manage-products` and shows the default Next.js not-found page — no error boundary, no crash, no lock icon, no dimmed/disabled rendering.
- [ ] This holds identically for a user with no `products` grant at all, a user with `products:READ` only, and a user with `products:EDIT`/`DELETE` — "Manage Products" looks and behaves the same (a plain clickable link) in every case, confirming the nav truly renders regardless of permission for this item.
- [ ] Collapsed rail: "Manage Products" appears with its `PackagePlus` icon and a `title="Manage Products"` tooltip; divider count between sections is unchanged from before this unit (still reflects section count, not item count).
- [ ] "Customer" section's existing greyed/locked behavior (`cm03`) is completely unaffected — re-verify, don't just assume, since both features live in the same render loop.
- [ ] If §2.6 was folded in: `/products/product-offering` now shows "View Product" as its page heading and browser-tab title; every other aspect of the page (data, filters, components) is pixel-identical to before this unit.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm17 complete with the commit reference, and records explicitly which way the §2.6 page-heading question was resolved (folded into this unit, or deferred to `pm18`) so `pm18`'s own implementer doesn't have to re-derive it.

**Pipeline**
- [ ] CI green end-to-end on the branch — one shared shell component (plus, optionally, one page's text) changed; no new route surface yet (the manage-products route has no page), so the SAST/DAST baseline should show no new findings.

Any failing item means the unit is not done. Unit `pm18` (Manage Products page shell) depends on this unit's nav entry existing and being reachable, and — per `pm99`'s dependency graph — also depends on Units `pm10`–`pm16` for real data to display; it may start once this commit is verified and merged, independent of the backend units' own timing.
