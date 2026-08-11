# pm26 — Repositories + Orders Read Services

## Goal

Build the repositories for all five pm25 tables (insert-only where invariants mandate) and the framework-agnostic orders read services (`listOrders`, `getOrderDetail`) returning typed read models — proven by unit tests against the pm25 seeds.

## Design

- Repository placement follows the accounts precedent: `db/repositories/ordering/*.repository.ts`, `db/repositories/inventory/*.repository.ts`.
- **Permanently insert-only** (Inv. #16/#18): `order-item-price-override.repository.ts` and `inventory-status-history.repository.ts` export inserts + finders and nothing else — asserted structurally by a guardrail test in this unit (pm03 precedent).
- Read models live in `types/ordering.ts`; services return them, never raw Drizzle rows (code-standards §2.7).
- List-price display resolves from the catalog's immutable price rows via the **existing** derived-effectivity query in `db/repositories/product-offering-price.ts` — never reimplemented (build-plan note; Inv. #17: the pinned version may be `RETIRED`, reads must not filter on `ACTIVE`).

## Implementation

### 1. Repositories

- `ordering/product-order.repository.ts`: `insertOrder(tx, …)`, `findById`, `findByIdForUpdate` (single-row `FOR UPDATE` — pm16 pattern, used by pm30), `findList(params)` (joined list query: order + item + offering name/version + customer org name + exists(override) flag; filter `status`, text search on customer name/order id; sort; paginate), `updateStatus(tx, id, {status, reviewedBy?, reviewedAt?, completedAt?, failureReason?})` — the only update, status-workflow columns only.
- `ordering/product-order-item.repository.ts`: `insertItem(tx, …)`, `findByOrderId`. No update/delete (Inv. #15 write-once).
- `ordering/order-item-price-override.repository.ts`: `insertOverride(tx, …)`, `findByItemId`. **No update/delete, ever.**
- `inventory/product-inventory.repository.ts`: `insertInventory(tx, …)`, `findById`, `findByIdForUpdate`, `findList(params)`, `updateStatus(tx, id, {status, endDate?})`, `updateCharacteristics(tx, id, characteristics)`. No other update surface; core columns (offering, qty, start_date) have no update path (Inv. #15).
- `inventory/inventory-status-history.repository.ts`: `insertTransition(tx, …)`, `findByInventoryId` (ordered by `created_at`). **No update/delete, ever.**

### 2. Read models — `types/ordering.ts`

- `OrderListRow`: `orderId, customerName, customerPartyRoleId, billingAccountId, offeringName, offeringVersion, quantity, startDate, hasOverride, status, submittedByName, submittedAt, reviewedByName | null, reviewedAt | null`.
- `OrderDetail`: header fields + `item` (offering id/name/version, quantity, startDate, orderedCharacteristics) + `prices: OrderPriceLine[]` where `OrderPriceLine = { priceType, priceName, listAmount | null (tiered), currency, overrideAmount | null, effectiveAmount }` — the override-else-catalog resolution (Inv. #16) computed here, once, for every consumer.

### 3. Services — `services/ordering/`

- `list-orders.ts` — `listOrders(params)`: parsed params in, `OrderListRow[]` + pagination out. No `next/*` imports.
- `get-order-detail.ts` — `getOrderDetail(orderId)`: header + item + characteristics + `OrderPriceLine[]` built from `findByItemId` overrides merged over the catalog's effective price rows for the pinned version (resolved on today's date).

### 4. Guardrail tests (owned here)

Structural: the two insert-only repository modules export no `update*`/`delete*` (assert exported names, pm03 pattern). Behavioral: `getOrderDetail` on the seeded override order shows `effectiveAmount` 420.00 for recurring and list for one-time; on the standard order, all `overrideAmount` null; list filter `status=PENDING` returns exactly the seeded pending order; `RETIRED`-version read works (retire the seeded offering version in test setup, re-read detail — Inv. #17).

## Dependencies

None. pm25 committed.

## Verification checklist

- [ ] Unit tests green against pm25 seeds: list filter/search/sort/pagination, detail assembly, override-else-catalog per §4.
- [ ] Structural no-mutation-export asserts green for both insert-only repos.
- [ ] `services/ordering/*` has no `next/*` import (grep-gate).
- [ ] SQL exists only under `db/**`; services call repositories only.
- [ ] `tsc`, lint, format, full suite green.
