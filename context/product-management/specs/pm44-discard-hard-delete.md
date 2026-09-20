# pm44 — Discard: hard delete of a never-released version

**Unit:** pm44 (Part 3). **Boundary:** `db/repositories/product-offering.ts`, `services/product/delete-offering.ts`, `actions/product/delete-offering.action.ts`, `DeleteVersionDialog`, and the removal of the old discard path. No schema — pm35's cascade and pm36's trigger already carry it.
**Specs from:** `prodmgmt-architecture.md` §3.4, Inv. #23, #25 · `prodmgmt-code-standards.md` §1.11, §6.16 · plan D6 · `prodmgmt-update-overview.md` flow step 13, criterion 8.
**Depends on:** pm36 (cascade must pass the trigger), pm42 (`TESTING` exists and is discardable).

---

## Goal

Delete a `DRAFT` or `TESTING` version that was never `ACTIVE`, together with its specifications and prices, in one transaction — and remove the old behaviour where discarding merely set a draft to `RETIRED`.

---

## Design

### D1. Deletable means "never released", not "currently unreleased"

The guard is the row's **current** status being `DRAFT` or `TESTING`. That is sufficient, and provably so: a version reaches `OBSOLETE` or `RETIRED` only from `ACTIVE`, and nothing returns an `ACTIVE` version to `DRAFT` (Inv. #23). So a row that is `DRAFT` or `TESTING` today has never been `ACTIVE`, and no history table or audit lookup is needed to establish it. State this reasoning in the service's comment — the next reader will otherwise wonder whether the check is strong enough.

### D2. Count the children, then let the cascade remove them *(corrected as-built)*

> **Original design (explicit child-delete-first) is superseded — it is impossible for a `TESTING` parent.** pm36's trigger rejects an explicit child `DELETE` while the parent is still present and not `DRAFT` (verified in `0040_product_family_guards.sql`: the `OLD`-parent branch RAISEs when the losing parent exists and is not `DRAFT`), and only exempts the child delete when the parent row is being deleted in the **same** statement (the SELECT finds nothing → `NOT FOUND` passes). architecture §3.5 and code-standards §6.8 state this explicitly: **parent-first cascade is the only path that works for a `TESTING` parent.** The original "children go first, explicitly" only ever held for `DRAFT`.

The service therefore **counts** specifications, then prices, then **deletes only the parent offering row** — inside one transaction — and lets pm35's `ON DELETE cascade` remove the children. Two facts make this exact and safe:

- The row counts for the audit payload (D4) are captured by the two count reads taken **just before** the parent delete, under the parent's `FOR UPDATE` lock and over a `FOR UPDATE`-locked child subquery, so the counted rows are exactly the rows the cascade removes (a concurrent child INSERT is blocked by the parent lock via its FK; a concurrent explicit child DELETE is blocked by the child-row locks).
- The cascade is the **deletion mechanism**, not a backstop here: for a `TESTING` parent it is the only permitted path, and pm36's trigger exempts it because the parent row is deleted first (the trigger's "parent not found ⇒ allow" clause).

Prove it (I6): a test asserts the `PRODUCT_OFFERING_DELETED` payload carries the exact spec/price counts **and** that the children are gone after the parent delete — so a bug that dropped the counts, or one that failed to remove the children, fails the test.

### D3. Nothing can reference a deletable row

`ordering.product_order_item` and `inventory.product_inventory` FK the offering with `ON DELETE restrict`, and both are only ever created against an `ACTIVE` version. A `DRAFT` or `TESTING` row therefore has no referents, and the restrict can never fire. The service does not pre-check for referents; if the FK ever does fire, that is a genuine invariant breach and the transaction must fail loudly rather than be worked around.

### D4. The audit event is the only survivor

`PRODUCT_OFFERING_DELETED`, written in the same transaction, `beforeData` carrying the version's id, name, `version`, `lifecycle_status`, `family_offering_id`, and the counts of specifications and prices removed; `afterData: null`. This is the module's one place where the audit log holds something the tables no longer do — acceptable precisely because the content was never billable (Inv. #7's scope is pricing and rating sources).

### D5. `PRODUCT_OFFERING_DISCARDED` is removed, not repurposed

The old event type goes from `AUDIT_EVENT_TYPES` and its category map, and the audit-filter test's counts change. Existing rows carrying it stay in the log and still render — the type list drives the filter's options, not the display of historical rows. Verify that: a stored `PRODUCT_OFFERING_DISCARDED` row must still render in the audit log after the type is removed from the list, or the removal needs the type kept as a display-only legacy entry. Decide from the code, and record which.

### D6. Discard is absent, never disabled

The affordance renders on `DRAFT` and `TESTING` only. On every other status there is no Discard control at all (code-standards §1.20) — not greyed out, not tooltipped.

---

## Implementation

### I1. Repository

`deleteOffering(tx, offeringId)` in `product-offering.ts`: deletes the **parent** row only, returning its fields for the audit payload (`RETURNING`); pm35's `ON DELETE cascade` removes the children (D2). No `WHERE status = …` clause — the service owns the status decision under its lock, and a silent 0-row delete would be worse than a refusal. Alongside it, two narrow **count** reads (`countSpecificationsForOffering`, `countPricesForOffering`), each over a `FOR UPDATE`-locked child subquery so the audit count matches exactly what the cascade removes. *(The original "separate narrow child deletes" is dropped — an explicit child delete is rejected by the trigger for a `TESTING` parent, D2.)*

### I2. `services/product/delete-offering.ts` (new)

Transaction: locked status read → refuse unless `DRAFT` or `TESTING` (`OFFERING_NOT_DELETABLE`, carrying the observed status) → count specifications → count prices → delete the offering (the cascade removes the counted children, D2) → write `PRODUCT_OFFERING_DELETED` with D4's payload. Return `{ ok: true, offeringId, familyId, familyRemains, specificationsRemoved, pricesRemoved }` so the UI can confirm concretely and navigate off the deleted version (I3).

If the deleted version was the family's only row, the family ceases to exist — that is correct and needs no cleanup: `family_offering_id` is a self-reference, not a separate table.

### I3. Action

`delete-offering.action.ts`, `requirePermission(PRODUCTS, DELETE)`, standard shape, revalidating both product pages. After a successful delete the UI must navigate away from the deleted `?version=` — the action returns the family id so the page can redirect to the family's remaining primary version, or to the bare list when the family is gone.

### I4. Remove the old path

In the rewritten `retire-offering.ts` (pm43) the discard branch is already gone; this unit removes the last traces: `PRODUCT_OFFERING_DISCARDED` from the type list and category map, the `RetireOfferingDialog`'s two-copy-state switch (now three separate dialogs), and the code-standards §1.11 example text if it still mentions the merged call.

### I5. UI

`DeleteVersionDialog` (new): danger `AlertDialog`, copy per `prodmgmt-ui-context.md` §7 stating the counts — *"Discarding `<Name>` v`<n>` deletes this version with its `<x>` specifications and `<y>` prices. It never went live and this cannot be undone."* The counts come from the already-loaded panels, and the service reports the actual numbers back on success. Optional Reason field, carried into the audit payload.

### I6. Tests

- `tests/db/product-delete-offering.integration.test.ts`: deleting a `DRAFT` with 2 specs and 2 prices removes exactly those five rows; siblings in the family are untouched; the audit row carries the right counts; deleting a `TESTING` version behaves identically; `ACTIVE`, `OBSOLETE` and `RETIRED` each return `OFFERING_NOT_DELETABLE` with the observed status; a direct SQL `DELETE` of an `ACTIVE` version's price is still refused by the trigger.
- Family effects: deleting a family's only version leaves no orphan rows; deleting a branch leaves the root's `family_offering_id` graph intact; the open-version index frees up so a new draft can be created immediately afterwards.
- Count/cascade contract (D2): the `PRODUCT_OFFERING_DELETED` payload carries the exact spec/price counts **and** the children are gone after the parent delete (proving the cascade ran). Written so a bug that dropped the counts, or one that failed to remove the children, fails the test. *(The original "explicit child-delete is the path that runs" assertion is dropped — the cascade is the deletion path, mandated by the trigger for a `TESTING` parent, D2.)*
- Authz: `EDIT`-only is refused.
- D5's check: a pre-existing `PRODUCT_OFFERING_DISCARDED` audit row still renders in the audit log.

---

## Dependencies

**Packages to install: none.**

---

## Verification checklist

- [ ] Discarding a `DRAFT` or `TESTING` version deletes it with all its specifications and prices in one transaction.
- [ ] `ACTIVE`, `OBSOLETE` and `RETIRED` versions cannot be deleted by any path — service, action, or UI.
- [ ] The audit event records id, name, version, status, family and both removed counts; nothing else survives.
- [ ] Sibling versions and the family's lineage are untouched; deleting the only version leaves no orphans.
- [ ] After a delete the open-version index permits a new draft immediately.
- [ ] The UI navigates off the deleted version rather than rendering a stale selection.
- [ ] `PRODUCT_OFFERING_DISCARDED` is removed from the type list and the discard-sets-`RETIRED` path is gone; historical rows still render (D5).
- [ ] Discard requires `products : DELETE`; the control is absent — not disabled — on every other status.
- [ ] Audit-filter test counts updated; `tsc --noEmit`, ESLint, Prettier clean.

**Definition of done:** a mistaken draft disappears entirely, leaving one audit line describing what was removed — and the same button does not exist for anything a customer could have ordered.
