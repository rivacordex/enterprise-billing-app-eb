# pm43 — Withdrawal path: stop selling and retire

**Unit:** pm43 (Part 3). **Boundary:** `db/repositories/product-offering.ts`, one new read on `db/repositories/inventory/product-inventory.repository.ts`, `services/product/**`, `actions/product/**`, two dialogs. No schema, no page rebuild.
**Specs from:** `prodmgmt-architecture.md` §3.6, §4, Inv. #6, #17, #21, #23, #26 · `prodmgmt-code-standards.md` §1.14, §6.15 · plan D5, §4.1 · `prodmgmt-update-overview.md` flow steps 11–12, criterion 11.
**Depends on:** pm42 (`OBSOLETE` is produced by activation; this unit adds the manual route into it and the route out).

---

## Goal

Let a user stop selling a live version without a replacement (`ACTIVE → OBSOLETE`), and retire an obsolete version only once no subscription still bills from it (`OBSOLETE → RETIRED`), with the refusal naming how many subscriptions block it.

---

## Design

### D1. `OBSOLETE` has two producers, `RETIRED` has one gate

Activation supersedes (pm42) and stop-selling withdraws (this unit) — both produce `OBSOLETE`, and both mean "not orderable, still billed". `RETIRED` is reachable only from `OBSOLETE`, only through the subscription gate. There is no `ACTIVE → RETIRED` path; removing it is the point of the new status.

### D2. The gate's predicate, written once

A subscription counts as live when:

```sql
status <> 'TERMINATED' OR (end_date IS NULL OR end_date >= current_date)
```

A `TERMINATED` subscription with a future `end_date` is still billed to that date (inclusive-billed, Inv. #21), so it blocks. The predicate lives in **one** place — `productInventoryRepository.countLiveForOfferingForUpdate` — and is never restated in a service, a page or a test fixture (code-standards §6.15).

### D3. The cross-module read follows the established rule

This is an in-transaction precondition re-check against another module's table, so it calls that module's **repository's locked finder directly**, never `services/inventory/**` (code-standards §1.14, the ac04 precedent). The finder is the only code this unit adds under `db/repositories/inventory/`, it is read-only, and it takes `tx` so the count is taken inside `retireOffering`'s transaction with `FOR UPDATE` on the matching inventory rows — otherwise a subscription created between the count and the status write would be orphaned onto a retired version.

### D4. The count is returned, not just tested

`RETIRE_BLOCKED_BY_SUBSCRIPTIONS` carries `liveCount: number`, so the dialog can say "4 subscriptions still bill from this version" without a second query. A boolean would force the UI to either stay vague or re-count.

### D5. Retiring changes nothing but a label

No row is deleted, no price is touched, no subscription is repointed. A past period stays reproducible, and bill-run reruns read the stored `customer_bill_line` snapshot anyway (bm29 D19). The dialog copy says so explicitly, because "retire" sounds destructive and users hesitate.

### D6. Both transitions are `products : DELETE`

Stop-selling and retiring both change what the catalog offers, so they sit with discard on the `DELETE` level, not `EDIT` (architecture §4). An `EDIT`-only principal reaches neither — asserted in the authz matrix, both directions.

---

## Implementation

### I1. `db/repositories/inventory/product-inventory.repository.ts` — `countLiveForOfferingForUpdate`

```
async countLiveForOfferingForUpdate(tx, productOfferingId): Promise<number>
```
Selects the matching `product_inventory` rows with D2's predicate `FOR UPDATE`, returns the count. Add a comment naming `services/product/retire-offering.ts` as its only caller and code-standards §1.14 as the reason it lives here rather than in a product-side service. The repository's existing mutation surface (`updateStatus`, `updateCharacteristics`) is untouched — Inv. #18's write-once guardrail must still pass unchanged.

### I2. Repository writers

Add `markObsolete` and re-purpose `retireOffering` in `product-offering.ts` so it writes `RETIRED` and nothing else. Both update `last_modified` and `last_edited_by`. Narrow writers only, per pm42 I1.

### I3. `services/product/obsolete-offering.ts` (new)

Transaction: locked status read → refuse unless `ACTIVE` (`OFFERING_NOT_ACTIVE`) → `markObsolete` → one `PRODUCT_OFFERING_OBSOLETED` audit event with the optional reason. No family lock needed: leaving the active slot empty cannot violate either index.

### I4. `services/product/retire-offering.ts` (rewrite)

Transaction: locked status read → refuse unless `OBSOLETE` (`OFFERING_NOT_OBSOLETE`) → `countLiveForOfferingForUpdate` → if > 0 return `RETIRE_BLOCKED_BY_SUBSCRIPTIONS` with `liveCount` → `retireOffering` → one `PRODUCT_OFFERING_RETIRED` audit event carrying the reason and the observed count (zero, recorded as evidence).

Delete the old dual-purpose logic: the `PRODUCT_OFFERING_DISCARDED` branch goes away entirely here (pm44 owns discard), and with it the comment block describing "one repository call, two audit events".

### I5. Actions

`obsolete-offering.action.ts` (new) and the rewritten `retire-offering.action.ts`, both `requirePermission(PRODUCTS, DELETE)`, both following the standard shape, both revalidating the two product pages. Extend `PRODUCT_ACTION_FILES`.

### I6. UI

- `ObsoleteOfferingDialog` (new): danger `AlertDialog`, confirm "Stop selling", copy per `prodmgmt-ui-context.md` §7, optional Reason.
- `RetireOfferingDialog` (re-purposed): shown on `OBSOLETE` only. When `liveCount > 0` the confirm button is replaced by the blocked message — the dialog does not offer an action it will refuse. The count is passed in from the page's own read, and re-checked server-side regardless.
- Version-header visibility from pm37's allowed-actions `Record`: Stop selling on `ACTIVE`, Retire on `OBSOLETE`, neither anywhere else.

### I7. Page read for the blocked state

`page.tsx` fetches the live count for the selected version only when its status is `OBSOLETE` — one extra statement on that status alone, never on the list and never on other statuses. State the number in the query-budget test rather than leaving it implicit.

### I8. Audit events

`PRODUCT_OFFERING_OBSOLETED` added to `AUDIT_EVENT_TYPES` and `AUDIT_EVENT_CATEGORY_MAP`; `PRODUCT_OFFERING_RETIRED` retained with its new meaning. Update `tests/components/audit-log-filters.test.tsx`'s counts — the ripple that `tsc` does not catch.

### I9. Tests

- `tests/db/product-withdrawal-path.integration.test.ts`: `ACTIVE → OBSOLETE` succeeds and is refused from every other status; `OBSOLETE → RETIRED` succeeds at zero live subscriptions; blocked with an `ACTIVE` subscription; blocked with a `SUSPENDED` one; blocked with a `TERMINATED` one whose `end_date` is today and one whose `end_date` is in the future; allowed with a `TERMINATED` one whose `end_date` was yesterday; the returned `liveCount` matches.
- Race: a subscription inserted against the version while `retireOffering` holds its locks — the retire either sees it and blocks, or the insert waits and then fails against a `RETIRED` version; never both succeed.
- Billing regression: a bill run over a period covered by an `OBSOLETE` and by a `RETIRED` version still produces identical charges (Inv. #17).
- Authz: an `EDIT`-only principal is refused both actions.

---

## Dependencies

**Packages to install: none.**

---

## Verification checklist

- [ ] Stop selling moves `ACTIVE → OBSOLETE` and is refused from every other status.
- [ ] Retire is refused while any subscription is not `TERMINATED`, or is `TERMINATED` with `end_date` today or later; the message names the count.
- [ ] Retire succeeds at zero, writing one audit event that records the observed count.
- [ ] The live-subscription predicate exists in exactly one place in the codebase (grep proves it).
- [ ] The cross-module read is a locked repository finder called from the product service; no `services/inventory/**` import exists in `services/product/**`.
- [ ] Inventory's write surface is unchanged; Inv. #18's guardrail passes untouched.
- [ ] A bill run over a period covered by an `OBSOLETE` or `RETIRED` version produces identical charges.
- [ ] Both actions require `products : DELETE`; an `EDIT`-only principal is refused.
- [ ] The blocked-state read runs only for an `OBSOLETE` selection; the query budget reflects it.
- [ ] Audit filter counts updated; `tsc --noEmit`, ESLint, Prettier clean.

**Definition of done:** a product is withdrawn from sale while its subscribers keep billing, and it can only be retired once the last of them has actually stopped.
