# pm27 — Nav + Orders Page (Read Surface)

## Goal

Add "Orders" and "Subscriptions" to the Products nav section and ship `/products/orders` as a guarded, deep-linkable read-only list of order entries — the first visible UI of the update, with inert seams for New order (pm29) and Review (pm31).

## Design

- Nav: data-only diff to `NAV_SECTIONS` in `components/admin-nav.tsx` (pm17 pattern) — Products section order becomes View Product · Manage Products · **Orders** (lucide `ClipboardList`) · **Subscriptions** (lucide `Layers`). No `requiredPermission` on items (nav-renders-regardless convention). `/products/subscriptions` 404s until pm33 — accepted, same as pm17→pm18.
- Page follows the View Product URL-state pattern: all list state in searchParams (`q`, `status`, `page`, `sort`, `order` = selected row), parsed never trusted, invalid → defaults.
- Visual per `mockup-product-ordering.html`: status pills (TMF622 subset), violet "negotiated" pill on `hasOverride` rows, `PENDING` rows carrying a Review affordance. Status badge colors follow the ui-context token discipline — new wiring recorded in `prodmgmt-ui-context.md` in this unit (its scope note says update tokens land when the UI units are specced; that's now): `COMPLETED` → success tints, `PENDING` → warning tints, `REJECTED`/`FAILED` → danger tints, all others → neutral (unused states never render).

## Implementation

### 1. Nav — `components/admin-nav.tsx`

Two items appended to the existing "Products" section entries array; zero render-loop/type changes. Existing nav tests extended with the two new items; all prior assertions unmodified.

### 2. Page — `app/(app)/products/orders/{page,loading,error}.tsx`

`page.tsx`: `await requirePermission(PERMISSIONS.PRODUCT_ORDERS, LEVELS.READ)` → `await searchParams` → parse with `validation/ordering/orders-list.schema.ts` → `listOrders` (pm26) → compose components. Thin orchestrator — no DB, no business rules. `metadata.title` / `H1`: **"Orders"**.

### 3. Components — `components/products/ordering/`

- `order-status-badge.tsx` — `OrderStatusBadge` (pill + icon, mapping above; dark `-fg` on light `-bg`, never color-only).
- `orders-table.tsx` — `OrdersTable`: columns Order id (mono), Customer, BAN (mono), Offer (name + `(vN)` mono), Qty (right/tabular), Start, Price (`negotiated` pill or "list"), Status, Submitted (by · date), Reviewed (by · date, `— (auto)` for standard auto-completed orders, `—` for unreviewed). Row selection is a `<Link>` rewriting `?order=` (View Product pattern). Reuses the Administration table primitives (pagination, sortable headers, empty state) — never a fork.
- Inert seams (pm05→pm08 discipline): a "New order" header button (`--action-cta-bg`, the page's only accent CTA) rendering fully wired-looking but no-op with a `pm29` seam comment; a "Review" row affordance on `PENDING` rows with a `pm31` seam comment.

### 4. Ripple

`tests/app/route-manifest.test.ts` frozen manifest gains `/products/orders`. Authz-matrix entry is pm34's job (build-plan), but the page-level guard test (no-grant → `/no-access`; catalog-`products`-only principal also blocked) lands here with the page.

## Dependencies

None. pm26 committed (services consumed).

## Verification checklist

- [ ] Both nav items render for every authenticated user; active-state and collapsed-rail behavior unchanged; existing nav tests pass unmodified.
- [ ] Permitted user reaches Orders from the nav; seeded rows render with correct badges (`PENDING` badged + Review affordance; override rows show `negotiated`; standard completed order shows `— (auto)` reviewed).
- [ ] No-grant → `/no-access`; a `products : EDIT`-only principal is also blocked (permission separation, Inv. cross-check).
- [ ] Deep link `?order=PRDORD00000002&status=PENDING` reproduces the view; unknown id → empty-selection state, not an error.
- [ ] `/products/subscriptions` 404s (expected until pm33); route manifest updated for `/products/orders` only.
- [ ] Seam buttons render but perform nothing; grep finds both seam comments.
- [ ] `prodmgmt-ui-context.md` gains the OrderStatusBadge wiring section in this same change set.
- [ ] `tsc`, lint, format, full suite green; `next build` clean.
