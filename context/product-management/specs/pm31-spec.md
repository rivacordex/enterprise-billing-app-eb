# pm31 — Review UI + Actions

## Goal

Let an eligible reviewer approve or reject a `PENDING` order from the Orders page: a review panel showing list-vs-negotiated pricing side by side, wired to pm30 — filling pm27's Review seam.

## Design

- The review surface is the Orders page's selection panel (driven by `?order=`, per pm27's URL-state design), not a separate route — deep-linkable, back-button-safe, and reuses `getOrderDetail` (pm26) unchanged.
- Eligibility is resolved server-side per request and passed down as props (`canReview: boolean` = MANAGER role ∧ EDIT ∧ not submitter): buttons render disabled with an explanatory tooltip for ineligible viewers — UX only; pm30 enforces regardless (platform Inv. #3).
- Visuals per `mockup-product-ordering.html` review view: context strip, order summary (`kv` grid), pricing table with Δ% column (list vs negotiated, negative deltas in danger text), info banner stating approval re-validates at approval time.

## Implementation

### 1. Actions — `actions/ordering/{approve-order.action.ts, reject-order.action.ts}`

Standard shape: `requirePermission(PRODUCT_ORDERS, EDIT)` → `safeParse` (`review-order.schema.ts` approve/reject variants) → pm30 service → `revalidatePath('/products/orders')` (+ subscriptions on approve) → typed result. Every pm30 code mapped to a user-readable message — including the stale-precondition codes, surfaced as "Cannot approve: <reason>. The order remains pending; reject it if no longer valid." Appended to `EXPECTED_ORDERING_ACTION_FILES`.

### 2. Components — `components/products/ordering/`

- `order-review-panel.tsx` — `OrderReviewPanel`: composed by the page for the selected order; sections — summary (customer, BAN + cycle/terms, offer + version, qty, start date, characteristics as `key: value` inline text), pricing table (`OrderPriceLine[]`: price type, list, negotiated, Δ% computed display-side from the two amounts, tabular-nums), submitted/reviewed metadata. For non-`PENDING` orders it renders read-only detail (no buttons) — the same panel serves as the order detail view for all statuses.
- `review-actions.tsx` — `ReviewActions`: Approve (accent, confirmation dialog restating list vs negotiated totals) and Reject (danger, `AlertDialog` with required reason field) — rendered only when `status === 'PENDING'`; disabled + tooltip when `!canReview` ("You submitted this order" / "Requires MANAGER role").
- Page change: `orders/page.tsx` resolves `canReview` (guard identity + `actorHasRole` + submitter comparison) and threads it; fills pm27's Review seam (row affordance → sets `?order=`).

### 3. Tests

Component: panel renders detail for each seeded status; buttons only on `PENDING`; disabled states for submitter and non-manager; reject requires reason. Action: `FORBIDDEN` path with service never called (pm20 precedent); success path revalidates both product pages.

## Dependencies

None. pm27 (page + seam), pm30 (services) committed.

## Verification checklist

- [ ] In the browser: a manager (≠ submitter) approves the seeded `PENDING` order — toast, row flips `COMPLETED` with reviewed by/at, subscription visible in the DB (and in the UI after pm33).
- [ ] The submitter sees Approve/Reject disabled with the tooltip; forcing the action returns `SELF_REVIEW`.
- [ ] A non-manager EDIT holder sees disabled buttons; forced call returns `NOT_MANAGER`.
- [ ] Reject with reason → `REJECTED`, reason displayed in the panel, no inventory row.
- [ ] Stale approval path surfaces the concrete precondition message and leaves the order `PENDING`.
- [ ] Deep link `?order=<pending-id>` opens the review panel directly.
- [ ] `EXPECTED_ORDERING_ACTION_FILES` = create/approve/reject; `tsc`, lint, format, full suite, `next build` green.
