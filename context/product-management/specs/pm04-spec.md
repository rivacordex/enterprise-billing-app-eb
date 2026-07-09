# PM04 — Nav Refactor: `NAV_ITEMS` → `NAV_SECTIONS`

- **Unit:** 4 of 9 (`pm00-build-plan.md`)
- **Dependencies:** Unit pm01 (route-group rename) committed and verified. Independent of pm02–pm03 (workflow §2.6 sequencing; nav renders regardless of permission — platform convention, prodmgmt-code-standards §3.8).
- **Authorizing sections:** overview *Goals #4* / *Navigation & shell* / *In Scope*; `prodmgmt-architecture.md` §2 (`components/admin-nav.tsx` row), §4 (nav-visibility convention); `prodmgmt-code-standards.md` §3.8, §7.1; `prodmgmt-ai-workflow-rules.md` §2.6.
- **Codebase state verified 2026-07-04:** `components/admin-nav.tsx` holds a flat `NAV_ITEMS` array (4 items: Users, Roles, System Configuration, Audit Log) rendered by `AdminNav`; its only consumer is `components/admin-sidebar.tsx:81` (`<AdminNav collapsed={collapsed} />`); its only test file is `tests/components/admin-nav.test.tsx` (4 tests, pathname mocked to `/administration/users`). pm01 has **not** landed yet (`app/(admin)/` still exists) — this unit must not start until it has.

---

## 1. Goal

Refactor `components/admin-nav.tsx` from the flat `NAV_ITEMS` array to a sectioned `NAV_SECTIONS` structure (caption + items per section) and add a "Products" section — peer of "Administration" — containing one item, "Product Offering" (`/products/product-offering`, lucide `Package`), while the Administration items, active-state logic, and collapsed-rail behavior render exactly as before.

## 2. Design

**One nav component, one file.** The refactor stays inside `components/admin-nav.tsx`; no second nav component, no product-specific nav file (code-standards §7.1). The component name `AdminNav`, file name, and the `collapsed` prop contract are unchanged — `admin-sidebar.tsx` is not touched.

**Structural decisions (pre-made or decided in this spec):**

1. **Section order — Products above Administration** *(decision 2026-07-04, this spec)*. Domain modules render first, platform administration last; future modules (`Customers`, `Bill Runs`) insert above Administration in the same pattern.
2. **Expanded mode:** each section renders its caption `<span>` with the **exact existing caption classes** (`px-4 pt-2 pb-1 text-[15px] font-semibold text-[color:var(--text-on-brand)]/60`), followed by its items with the **byte-identical item markup** (left-border accent, `--surface-selected` active pill, hover, focus ring, label fade transition). Non-first sections add `mt-2` on the caption for section separation — the only expanded-mode visual delta besides the new section itself.
3. **Collapsed rail:** captions stay hidden (existing behavior). Sections are separated by a **thin divider** *(decision 2026-07-04, this spec)*: `<hr aria-hidden className="mx-3 my-2 border-t border-[color:var(--text-on-brand)]/10" />` — the same hairline token the sidebar header/footer already use. The divider renders **only between sections** (never before the first or after the last) and **only when collapsed**; expanded mode relies on captions for grouping, per the "rule replaces the caption" reading.
4. **Item behavior unchanged:** active detection (`pathname === href || pathname.startsWith(href + "/")`), `aria-current="page"`, collapsed `title` tooltip, icon sizing (18 collapsed / 16 expanded), and the DOM-present visually-clipped label all stay as-is — the item render code moves inside a nested map, its output does not change.
5. **Nav renders regardless of permission** (architecture §4, code-standards §3.8). No permission check is added; an ungranted user sees the item and is stopped by the pm05 page guard.
6. **Interim dead link accepted:** `/products/product-offering` has no page until pm05, so clicking the new item yields the Next.js default not-found until then. This is the pm00 sequencing decision ("sequenced here so the link has a page shortly after") — do not add a placeholder page (that is pm05's unit) and do not hide the item.

## 3. Implementation

### 3.1 `NAV_SECTIONS` data structure

Replace `NAV_ITEMS` with:

```ts
type NavItem = { label: string; href: string; icon: LucideIcon };
type NavSection = { caption: string; items: ReadonlyArray<NavItem> };

const NAV_SECTIONS: ReadonlyArray<NavSection> = [
  {
    caption: "Products",
    items: [
      {
        label: "Product Offering",
        href: "/products/product-offering",
        icon: Package,
      },
    ],
  },
  {
    caption: "Administration",
    items: [
      { label: "Users", href: "/administration/users", icon: Users },
      { label: "Roles", href: "/administration/roles", icon: ShieldHalf },
      { label: "System Configuration", href: "/administration/system-config", icon: Settings },
      { label: "Audit Log", href: "/administration/audit-log", icon: ScrollText },
    ],
  },
];
```

- Add `Package` to the existing `lucide-react` import; all other icons unchanged.
- The four Administration item objects are copied verbatim — same labels, hrefs, icons, order.
- Keep the existing icon-choice comment (ShieldHalf rationale) with the structure; extend it with one line noting `Package` for Product Offering (catalog/goods family, no glyph collision with existing nav or badge icons).
- The structure is module-private (not exported) — nothing else consumes it today; export it only when a future unit needs it.

### 3.2 Render loop

Outer `<nav className="flex flex-col py-2">` unchanged. Inside, map over `NAV_SECTIONS`:

```tsx
{NAV_SECTIONS.map((section, index) => (
  <Fragment key={section.caption}>
    {collapsed && index > 0 && (
      <hr aria-hidden className="mx-3 my-2 border-t border-[color:var(--text-on-brand)]/10" />
    )}
    {!collapsed && (
      <span className={cn("px-4 pt-2 pb-1 text-[15px] font-semibold text-[color:var(--text-on-brand)]/60", index > 0 && "mt-2")}>
        {section.caption}
      </span>
    )}
    {section.items.map((item) => (
      /* existing item JSX, moved verbatim — no class, attribute, or logic edits */
    ))}
  </Fragment>
))}
```

- Import `Fragment` from `react` (keyed fragment).
- The item `<Link>` block is **moved, not modified** — the diff inside it must be pure indentation.
- Keep the existing "caption is hidden in the collapsed rail (um28-spec §2.5)" comment on the caption branch.

### 3.3 Tests — `tests/components/admin-nav.test.tsx`

Existing four tests keep their assertions (Administration caption, four labelled links, `aria-current` on Users, caption hidden collapsed, `title` tooltips collapsed) — extend, don't rewrite:

1. **Expanded** — extend the caption test: `Products` caption is also in the document; add `Product Offering` to the labelled-link loop (now 5 links) with `href="/products/product-offering"` asserted via `toHaveAttribute("href", …)` on the new link.
2. **Expanded, section order** — the `Products` caption precedes the `Administration` caption in the DOM (`compareDocumentPosition` or index into `screen.getAllByText`).
3. **Expanded, no divider** — `container.querySelectorAll("hr")` has length 0.
4. **Active state on product route** — a second `describe` block re-mocking `usePathname` to `/products/product-offering` (use `vi.mocked` / a mutable mock variable rather than a duplicate file): `Product Offering` link has `aria-current="page"`, `Users` does not.
5. **Collapsed** — extend the existing tests: `Products` caption also hidden; `Product Offering` link present with `title="Product Offering"`; `container.querySelectorAll("hr")` has length 1 (exactly one divider for two sections).

No other test file changes. The pm01 route-manifest test is unaffected — this unit adds no `page.tsx`.

### 3.4 Commit

One commit, e.g. `refactor nav to NAV_SECTIONS; add Products section (pm04)`. Contents: exactly `components/admin-nav.tsx` + `tests/components/admin-nav.test.tsx`. Explicitly **not** in this commit: `components/admin-sidebar.tsx`, any `app/**` file (no product page — pm05), any `db/`, `services/`, `validation/` file, any permission or guard code, any dependency or config change.

Plan-folder bookkeeping (`prodmgmt-progress-tracker.md` entry for Unit pm04) is updated in the plan directory, outside the app repo commit.

## 4. Dependencies

**None.** No npm packages added, removed, or upgraded (pm00: "no new npm packages anywhere"). `Package` ships with the already-installed `lucide-react`.

## 5. Verification checklist

Run before declaring the unit done (general workflow §8; prodmgmt-workflow §8):

**Diff hygiene**
- [ ] `git status` shows exactly 2 modified files: `components/admin-nav.tsx`, `tests/components/admin-nav.test.tsx`. Nothing else.
- [ ] The item `<Link>` JSX diff is indentation-only — no class, attribute, or logic change inside it.
- [ ] No second nav component or file created; `AdminNav` name and `collapsed` prop unchanged; `admin-sidebar.tsx` untouched.
- [ ] No permission check added to the nav (code-standards §3.8).
- [ ] No `TODO`, commented-out code, or `console.*` introduced.

**Build gates**
- [ ] `npm run typecheck` green.
- [ ] `npm run lint` green.
- [ ] `npm run format:check` green.
- [ ] `npm run test` green — both vitest configs; all pre-existing admin-nav assertions pass unchanged.

**Behavior — Administration unchanged (the "exactly as before" claim)**
- [ ] Dev-server: expanded sidebar shows "Products" (Product Offering) above "Administration" (Users, Roles, System Configuration, Audit Log); all four Administration links navigate and highlight exactly as on `main`.
- [ ] Active state: visiting each Administration page marks only its item `aria-current="page"` with the left-border accent pill, identical to `main`.
- [ ] Collapse toggle: rail shows 5 icons with one hairline divider between the Products and Administration groups; active item is the centered light square; `title` tooltips present; expand/collapse label fade (200ms) unchanged.
- [ ] Sidebar collapse cookie persistence still works (no `admin-sidebar.tsx` change should affect it — confirm anyway).
- [ ] Clicking "Product Offering" navigates to `/products/product-offering` and shows the default not-found (accepted interim state, §2.6) — no error boundary, no crash.

**Docs in sync**
- [ ] No companion-doc edits required: architecture §2 / code-standards §7.1 already record this refactor as planned; no permission map change (nav is permission-blind).
- [ ] `prodmgmt-progress-tracker.md` (plan folder) marks Unit pm04 complete with the commit reference.

**Pipeline**
- [ ] CI green end-to-end on the branch, including the pm01 rename-invariance test (no route changes) and SAST/DAST baseline (no new findings — one shell component changed).

Any failing item means the unit is not done (workflow §8). Unit pm05 (page: guard + searchParams + offerings table) may start once this commit is verified and merged — pm05 also requires pm02–pm03.
