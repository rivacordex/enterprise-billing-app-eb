# pm32 — Subscription Lifecycle Backend + Read Services

## Goal

Implement the subscription read services (`listSubscriptions`, `getSubscriptionDetail`) and the four lifecycle write services (suspend / resume / terminate / edit characteristics) with guarded transitions, append-only history, and the Q19/Q20 date rules — proven by concurrency tests before any UI exists.

## Design

- Read services live here, not pm26 — just-in-time (first consumer is pm33) and shaped by what the write path appends (build-plan note).
- Transition matrix (Q8/Q9, Inv. #18): `ACTIVE → SUSPENDED` (suspend), `SUSPENDED → ACTIVE` (resume), `ACTIVE | SUSPENDED → TERMINATED` (terminate, terminal). Everything else → `INVALID_TRANSITION`. Current status is always re-derived from a locked read inside the transaction (pm16 `retireOffering` post-ship-fix pattern) — never from the caller's snapshot.
- Date rules: every `effective_date` / `end_date` obeys the 3-day backdating tolerance (Q19, authoritative service check with injectable `now`) and inclusive-billed semantics (Q20 — suspend `effective_date` = first non-billed day; terminate `end_date` = last billed day, CHECK ≥ `start_date`). Additional ordering rule: a new transition's `effective_date` must be ≥ the latest history row's `effective_date` (`EFFECTIVE_DATE_BEFORE_PRIOR`) — windows must derive in order.
- `instance_characteristics` is the sole editable field (Inv. #15): its own service, own audit event, no status interaction.

## Implementation

### 1. Read services — `services/inventory/`

- `list-subscriptions.ts` — `listSubscriptions(params)`: `SubscriptionListRow[]` (`inventoryId, customerName, billingAccountId, offeringName, offeringVersion, hasOverride, quantity, startDate, endDate, status`) + pagination; filters `status`, text search; **no `ACTIVE`-version filter on the offering join** (Inv. #17 — pinned versions may be `RETIRED`).
- `get-subscription-detail.ts` — `getSubscriptionDetail(id)`: row + `instance_characteristics` + ordered `StatusHistoryEntry[]` (`from, to, effectiveDate, reason, changedByName, createdAt`) + derived `suspensionWindows: {from, to | null}[]` computed from consecutive SUSPENDED/ACTIVE transitions — computed here, once, as the reference derivation the bill run will later reuse. Read models in `types/inventory.ts`.

### 2. Write services — `services/inventory/`

Common shape (each its own file): open `db.transaction` → `productInventoryRepository.findByIdForUpdate` → `SUBSCRIPTION_NOT_FOUND` / transition-matrix check on the **locked** status → date checks (`BACKDATED_EFFECTIVE_TOO_FAR`, `EFFECTIVE_DATE_BEFORE_PRIOR`; terminate also `END_BEFORE_START` via the CHECK, surfaced as a typed code) → `insertTransition` + `updateStatus` (+ `end_date` on terminate) → audit event — one transaction.

- `suspend-subscription.ts` (`reason` required) → `PRODUCT_INVENTORY_SUSPENDED`
- `resume-subscription.ts` → `PRODUCT_INVENTORY_RESUMED`
- `terminate-subscription.ts` (`reason` required; allowed from `ACTIVE` or `SUSPENDED`) → `PRODUCT_INVENTORY_TERMINATED`
- `update-instance-characteristics.ts`: locked read (any non-`TERMINATED` status), Zod-validated record, `updateCharacteristics` + `PRODUCT_INVENTORY_CHARACTERISTICS_UPDATED` with before/after payload. Never touches status, dates, quantity, or offering (Inv. #15).

### 3. Tests (unit + live-DB script)

- Suspend 08-10 + resume 08-20 → exactly two history rows; `suspensionWindows` = `[{from: 08-10, to: 08-20}]`; open window (`to: null`) for an unresumed suspension.
- Every illegal transition rejected (`resume` an `ACTIVE`, `suspend` a `TERMINATED`, any action on `TERMINATED`).
- Date rules: > 3-day backdate rejected on all four actions; out-of-order `effective_date` rejected; terminate before `start_date` rejected.
- Concurrency (≥ 4 runs): two simultaneous suspends → one wins, one `INVALID_TRANSITION`; suspend vs terminate → one winner; history never gains an out-of-order or contradictory row.
- Gap-free invariant: after every test, latest history row's `to_status` equals the row's `status` column (Inv. #18 derivability assert — write it as a reusable helper the pm34 sweep also calls).

## Dependencies

None (npm). pm26 committed (repositories). Audit ripple (4 event types) handled here as in pm28/pm30.

## Verification checklist

- [ ] All §3 tests green, races repeated with consistent outcomes.
- [ ] Structural: history repo still exports no update/delete; no service writes `inventory_status_history` except via `insertTransition`.
- [ ] Derivability helper green after every mutation test.
- [ ] `services/inventory/*` framework-agnostic (no `next/*`); read models only (no raw rows).
- [ ] Audit-filter test updated; `tsc`, lint, format, full suite green.
