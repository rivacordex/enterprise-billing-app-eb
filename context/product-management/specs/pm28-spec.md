# pm28 — Order Submission Backend

## Goal

Implement `createOrder` — the update's core transaction: validate everything, then atomically insert order + item (+ overrides) and either instantiate the subscription and complete (standard path) or park `PENDING` (override path). Proven by live-DB integration tests before any UI exists.

## Design

- **One transaction, TOCTOU-checked (Inv. #19).** Pre-transaction reads may inform early failure, but every precondition is re-read inside `db.transaction` under `FOR UPDATE` immediately before writing. This is the first transaction spanning `customer` + `billing` + `product` + both new schemas.
- **Cross-module access per the revised architecture §2 rule (ac04 precedent):** in-transaction locked re-checks use the other modules' repositories directly — `partyRoleRepository`, `billingAccountRepository`, `productOfferingRepository` (which already exposes forUpdate finders from pm13/pm16). Where a locked single-row finder is missing, add it as a disclosed, additive repository method (flagged per ai-workflow §7.3): `partyRoleRepository.findStatusByIdForUpdate`, `billingAccountRepository.findStateByIdForUpdate`.
- Validation rules and error codes are the update's contract; the same set is re-run verbatim by pm30's approval (factored accordingly).

## Implementation

### 1. Shared validation core — `services/ordering/order-preconditions.ts`

`checkOrderPreconditions(tx, input, now)` — used by pm28 and pm30 (never duplicated):

| Check | Rule | Error code |
|---|---|---|
| Party | `party_role.status = 'ACTIVE'` (Q14 — `VALIDATED` rejected) | `CUSTOMER_NOT_ACTIVE` |
| BAN | `billing_account.state <> 'closed'` (Q15; delivered states: `active/suspended/closed`) and BAN belongs to the party's FA | `BILLING_ACCOUNT_CLOSED` / `BILLING_ACCOUNT_MISMATCH` |
| Offering | `lifecycle_status = 'ACTIVE' ∧ billing_only ∧ is_sellable` (Q16) | `OFFERING_NOT_ORDERABLE` |
| Prices | ≥ 1 price row on the version | `NO_PRICE_ROWS` |
| Overrides | each `priceType` exists on the version with `pricing_model = 'flat'`; currency = BAN currency | `OVERRIDE_PRICE_TYPE_INVALID` / `OVERRIDE_CURRENCY_MISMATCH` |
| Start date | ≥ `now` − 3 days (authoritative, injectable `now` — pm15 pattern) | `BACKDATED_START_TOO_FAR` |

### 2. `services/ordering/create-order.ts`

`createOrder(input: CreateOrderInput, actorId, now = () => new Date())`:

1. Open `db.transaction`. Locked reads (§1 checks, all on `tx`).
2. Insert `product_order` (status set below) + `product_order_item` (+ override rows if any).
3. **No override:** insert `product_inventory` (status `ACTIVE`, `instance_characteristics` := `ordered_characteristics`, quantity/start copied) + first `inventory_status_history` row (`NULL → ACTIVE`, `effective_date = start_date`, reason `order <id> completed`) → `updateStatus` order `COMPLETED` (+ `completed_at`) → audit events `PRODUCT_ORDER_CREATED`, `PRODUCT_INVENTORY_CREATED`, `PRODUCT_ORDER_COMPLETED` — all inside the same transaction.
4. **Override present:** order commits as `PENDING`; audit `PRODUCT_ORDER_CREATED` + `PRODUCT_ORDER_PENDING_APPROVAL`. No inventory rows.
5. Precondition failure inside the transaction → abort, return `{ok:false, code}` — no order row persists (Q1). An unexpected repository or inventory write failure **after** order insertion likewise rolls the whole transaction back, leaving **no persisted order row** — `createOrder` is one flat `db.transaction`, so no partial state ever commits (§4 crash-injection proof; ac04/V7 atomicity precedent). Compensating the order to `FAILED` (persisting the row with a `failure_reason` instead of rolling back) is **deferred future work**, not implemented by this unit; `FAILED` / `PRODUCT_ORDER_FAILED` are seeded but never written here.

Result type: `CreateOrderResult = {ok:true, orderId, inventoryId | null, status} | {ok:false, code: …}`.

### 3. Audit event ripple

`AUDIT_EVENT_TYPES` + `AUDIT_EVENT_CATEGORY_MAP` gain the six order events + `PRODUCT_INVENTORY_CREATED`; `tests/components/audit-log-filters.test.tsx` count/optgroup updated **in this unit** (ai-workflow §7.6 — bites every write unit; check explicitly).

### 4. Integration tests (live-DB script, pm16 precedent)

- Standard path: order + item + inventory + history + 3 audit rows appear atomically; crash injection between item insert and inventory insert leaves no committed partial state.
- Override path: `PENDING`, override rows present, zero inventory, zero `COMPLETED` audit.
- Each §1 error code fires when the UI is bypassed (direct service call with a `VALIDATED` party, a `closed` BAN, a `DRAFT`/`RETIRED`/non-sellable/non-billing-only offering, a tiered override target, a 4-day backdate).
- TOCTOU: party flipped to `SUSPENDED` by a concurrent transaction between form-read and submit → submission fails with `CUSTOMER_NOT_ACTIVE`, no rows.

## Dependencies

None (npm). pm26 committed (repositories). Disclosed additive methods on `party-role.ts` and `accounts/billing-account.repository.ts` per Design.

## Verification checklist

- [ ] All §4 integration tests green against the live dev DB (script cleaned up after, `PMORDVERIFY-` prefix convention).
- [ ] `checkOrderPreconditions` is the single source of the validation set (grep: no duplicated party/BAN/offering checks elsewhere).
- [ ] Every mutation transaction writes its audit events inside the same transaction; audit-filter test updated.
- [ ] No `next/*` imports; SQL only in `db/**`; the two cross-module repository additions are locked single-row finders only.
- [ ] `tsc`, lint, format, full suite green.
