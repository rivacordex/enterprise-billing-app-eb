# pm30 — Approval Backend

## Goal

Implement `approveOrder` / `rejectOrder`: a MANAGER-role holder of `product_orders : EDIT` who is not the submitter approves (full re-validation under locks, then instantiation) or rejects (terminal, no inventory) a `PENDING` order — proven under concurrency before any UI exists.

## Design

- **Authority = permission + role + identity (architecture §4, user-confirmed 2026-08-09):** `product_orders : EDIT` **and** the `MANAGER` role (rows exist in `core.ROLES` via `seed-rbac`) **and** actor ≠ `submitted_by`. This is the codebase's first role-*name* check in a service; it is deliberately minimal and documented as such.
- **Approval is not a status flip (Inv. #19).** The entire pm28 precondition set re-runs on `tx` under locks at approval time — a `PENDING` order approved days later must not instantiate against a suspended party, closed BAN, or retired-and-replaced offering. Shared via `checkOrderPreconditions` (pm28 §1), never duplicated.
- Concurrency: approve-vs-approve and approve-vs-reject serialize on the order row (`findByIdForUpdate`, re-read status, abort unless still `PENDING`) — pm16 `retireOffering` pattern.

## Implementation

### 1. Role helper — `db/repositories/role-assign.repository.ts` + `auth/`

Additive repository method `findRoleNamesByUserId(userId): string[]` (join `role_assign` → `roles.role_name`). Thin `auth/` helper `actorHasRole(userId, roleName)` — resolved live per request, never cached (platform Inv. #15), never read from the session.

### 2. Service — `services/ordering/review-order.ts`

- `approveOrder(orderId, actorId, now = …)`:
  1. `actorHasRole(actorId, 'MANAGER')` → else `{ok:false, code:'NOT_MANAGER'}`.
  2. `db.transaction`: `findByIdForUpdate` → `ORDER_NOT_FOUND` / status ≠ `PENDING` → `ORDER_NOT_PENDING`; `actorId === submitted_by` → `SELF_REVIEW` (service check; DB CHECK backstops).
  3. Re-run `checkOrderPreconditions(tx, …)` — any failure returns its concrete code (`CUSTOMER_NOT_ACTIVE`, …) and the order **stays `PENDING`** (transaction aborts; the reviewer sees why and can reject).
  4. Instantiate exactly as pm28 §2.3 (inventory + history + audit), `updateStatus` → `COMPLETED` with `reviewed_by = actorId`, `reviewed_at`, `completed_at`; audit `PRODUCT_ORDER_APPROVED` + `PRODUCT_INVENTORY_CREATED` + `PRODUCT_ORDER_COMPLETED`.
- `rejectOrder(orderId, actorId, reason)`: same steps 1–2; sets `REJECTED` + `failure_reason = reason` + `reviewed_by/reviewed_at`; audit `PRODUCT_ORDER_REJECTED`. Terminal; no inventory. Reason required (Zod, pm25).
- Shared instantiation code between pm28 and this unit factored into one exported module function `instantiateOrder(tx, order, item, actorId, now, review?)` in `services/ordering/instantiate-order.ts` — one definition of "create the subscription", two callers. The optional `review` argument carries the approval path's `reviewed_by`/`reviewed_at` metadata, stamped onto the same `COMPLETED` update; the standard `createOrder` path omits it (an auto-completed order was never reviewed). `now` is the injected clock both callers already thread through.

### 3. Integration + concurrency tests (live-DB script)

- Happy approve: subscription + history + audit rows; `reviewed_*` stamped; order `COMPLETED`.
- Reject: `REJECTED`, reason stored, zero inventory.
- `SELF_REVIEW` (service) and the DB CHECK (direct SQL attempt) both fire.
- `NOT_MANAGER`: EDIT-holder without the role is refused; role revocation takes effect on next call (live resolution).
- Stale approval: party suspended after submission → approve fails `CUSTOMER_NOT_ACTIVE`, order still `PENDING`, zero inventory.
- Races (run repeatedly, pm16 discipline): two concurrent approves → exactly one `COMPLETED` + one `ORDER_NOT_PENDING`, exactly one inventory row; approve vs reject → exactly one winner, never both effects.

## Dependencies

None (npm). pm28 committed (`checkOrderPreconditions`, instantiation factoring).

## Verification checklist

- [ ] All §3 tests green, races run ≥ 4× each with consistent outcomes.
- [ ] `checkOrderPreconditions` verified as the single validation source for both submit and approve (grep).
- [ ] Role check is live per request (test: revoke MANAGER between two calls → second refused); nothing role-related cached or session-stored.
- [ ] Audit ripple (`_APPROVED`, `_REJECTED` event types + category map + audit-filter test) handled in this unit.
- [ ] `tsc`, lint, format, full suite green.
