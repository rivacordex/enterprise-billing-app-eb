# pm42 — Release path: submit for testing, back to draft, activate

**Unit:** pm42 (Part 3). **Boundary:** `db/repositories/product-offering.ts` (status writes), `services/product/**`, `actions/product/**`, two dialogs, and the audit-event ripple. No schema, no page rebuild.
**Specs from:** `prodmgmt-architecture.md` §4 (state table), §5 (events), Inv. #6, #14, #23, #27 · `prodmgmt-code-standards.md` §1.13, §1.15, §7.7 · plan D5, §4 · `prodmgmt-update-overview.md` flow steps 8–10.
**Depends on:** pm36 (both unique indexes), pm40 (a surface to act from).

---

## Goal

Move a version through `DRAFT → TESTING → ACTIVE`, with the release preconditions checked at the `TESTING` step instead of at activation, and make activation supersede the family's previous `ACTIVE` version to `OBSOLETE` in the same transaction.

---

## Design

### D1. Three services, no shared state-machine module

`submitForTesting`, `returnToDraft`, `activateOffering`. Each re-reads its target's `lifecycle_status` under `FOR UPDATE` on `tx` immediately before writing (code-standards §1.13), each writes exactly one audit event, each returns a typed result. No `setLifecycleStatus(id, status)` helper and no action that takes a status parameter (§1.15) — a transition the state table does not list must have no code path.

### D2. Preconditions move one step earlier

`DRAFT → TESTING` requires: at least one price row; at least one specification; every mandatory specification carrying a non-null `defaultValue`. These are today's activation checks verbatim, relocated. `TESTING → ACTIVE` re-checks **nothing about content** — the version has been immutable since it left `DRAFT` (pm36's trigger), so the checks cannot have gone stale. It re-checks only the version's own status and the family's active slot.

This is the one place the update genuinely simplifies activation, and it is worth stating plainly in the spec so nobody "restores" the checks later.

### D3. Supersession is one UPDATE, guarded by the index

Inside `activateOffering`'s transaction: advisory-lock the family, find the sibling `ACTIVE` row `FOR UPDATE`, set it to `OBSOLETE`, then set the target to `ACTIVE`. Order matters — the reverse order trips `product_offering_one_active_per_family` mid-transaction. The existing `findActiveInFamily(...).for('update')` call and the advisory lock stay exactly as they are; only the status written to the superseded row changes, from `RETIRED` to `OBSOLETE`.

### D4. `returnToDraft` is not a rollback

It moves `TESTING → DRAFT` and nothing else: no content is restored, no version created, no audit rewrite. The version becomes editable again because the trigger's condition is satisfied again. It is available from `TESTING` only — an `ACTIVE` version never returns to draft (Inv. #23).

### D5. Audit events and their ripple

New: `PRODUCT_OFFERING_SUBMITTED_FOR_TESTING`, `PRODUCT_OFFERING_RETURNED_TO_DRAFT`. Changed semantics, same name: `PRODUCT_OFFERING_SUPERSEDED` now carries `afterData.lifecycleStatus = 'OBSOLETE'`; `PRODUCT_OFFERING_ACTIVATED` unchanged.

Each new type needs three edits, only two of which the compiler catches: the `AUDIT_EVENT_TYPES` entry, the `AUDIT_EVENT_CATEGORY_MAP` entry (`tsc`-caught), and the count/optgroup expectation in `tests/components/audit-log-filters.test.tsx` (**not** caught). This has bitten every write unit in this module — check it explicitly (code-standards §7.7).

### D6. What the dialogs say

`SubmitForTestingDialog` is a plain confirmation, not a danger dialog: *"`<Name>` v`<n>` becomes read-only while in testing. Return it to draft to make further changes."* Precondition failures never appear as dialog copy — they render as field-level errors in the panel that owns them (no prices → the prices panel; an unresolved mandatory spec → that spec's row), so the user is told where to fix it.

`ActivateOfferingDialog` keeps its accent confirm button and gains the revised copy: *"`<Name>` v`<n>` becomes orderable. The version currently active becomes obsolete — existing subscriptions keep billing from it unchanged."* Both carry the optional Reason field, captured in the audit payload, never a column.

---

## Implementation

### I1. Repository

Add to `product-offering.ts`: `setLifecycleStatusForTransition` is **not** added. Instead three narrow writers — `markTesting`, `markDraft`, `markActive` — each taking `(tx, offeringId)` and writing one status, plus the existing `retireOffering` left untouched until pm43 re-purposes it. Each writer updates `last_modified` and `last_edited_by`. Narrow writers keep §1.15 true at the repository layer as well as the service layer.

### I2. `services/product/submit-for-testing.ts` (new)

Transaction: locked status read → refuse unless `DRAFT` (`OFFERING_NOT_DRAFT`) → load specifications and prices under the same `tx` → `NO_PRICE_ROWS` / `SPECIFICATIONS_NOT_RESOLVED` → `markTesting` → audit. Reuse `activate-offering.ts`'s existing precondition code verbatim rather than re-deriving it, then delete it from there.

### I3. `services/product/return-to-draft.ts` (new)

Transaction: locked status read → refuse unless `TESTING` (`OFFERING_NOT_TESTING`) → `markDraft` → audit with the optional reason.

### I4. `services/product/activate-offering.ts` (rewrite)

Transaction: advisory lock the family → locked status read → refuse unless `TESTING` (`OFFERING_NOT_TESTING` — the old `OFFERING_NOT_DRAFT` code is replaced, and its callers updated) → find sibling `ACTIVE` `FOR UPDATE` → if present, `markObsolete` + `PRODUCT_OFFERING_SUPERSEDED` → `markActive` + `PRODUCT_OFFERING_ACTIVATED`. Remove the precondition block that moved to I2 and the pre-transaction reads it used.

### I5. Actions

`submit-for-testing.action.ts`, `return-to-draft.action.ts`, and the updated `activate-offering.action.ts` — all `products : EDIT`, all following the standard shape, all revalidating both product pages. Extend the guardrail's `PRODUCT_ACTION_FILES` map with the two new files.

### I6. UI

`SubmitForTestingDialog` (new), `ActivateOfferingDialog` (copy revision), and the version header's action visibility from pm37's allowed-actions `Record`: Submit for testing on `DRAFT`; Back to draft and Activate on `TESTING`. The precondition hints in the panels (pm40 I6) become live: the prices panel's hint disappears once a price exists.

### I7. Tests

- `tests/db/product-release-path.integration.test.ts`: the three transitions succeed from their legal predecessors; every illegal ordered pair returns its typed code; submit refuses with no prices and with an unresolved mandatory spec; activation with no sibling leaves the family with one `ACTIVE`; activation with a sibling produces exactly one `ACTIVE` and one `OBSOLETE`, with two audit rows.
- Concurrency: two near-simultaneous activations of sibling `TESTING` versions — exactly one wins, the loser fails on the lock or the index, and the family never holds two `ACTIVE` rows (the existing pm16 test, updated for the new predecessor status).
- Grandfathering: a subscription pinned to the superseded version resolves the same prices after activation, and that version now reads `OBSOLETE` (this is guardrail 16's updated assertion — it lands here, not in pm45).
- `tests/components/audit-log-filters.test.tsx`: updated counts per D5.

---

## Dependencies

**Packages to install: none.**

---

## Verification checklist

- [ ] `DRAFT → TESTING` succeeds only with ≥ 1 price, ≥ 1 specification and every mandatory specification resolved; each failure returns its own code and renders at the field that caused it.
- [ ] `TESTING → DRAFT` restores editability; the trigger allows child writes again immediately.
- [ ] `TESTING → ACTIVE` supersedes the family's previous `ACTIVE` to `OBSOLETE` in the same transaction; exactly one `ACTIVE` remains.
- [ ] `DRAFT → ACTIVE` directly is impossible through every entry point (service, action, UI).
- [ ] Two concurrent activations leave exactly one `ACTIVE`; the index or the lock rejects the loser.
- [ ] A subscription pinned to the superseded version bills identically afterwards; its version reads `OBSOLETE`.
- [ ] Each transition writes exactly one audit event in the same transaction; `PRODUCT_OFFERING_SUPERSEDED.afterData.lifecycleStatus` is `OBSOLETE`.
- [ ] The audit-filter test's counts are updated and green (the non-`tsc` ripple).
- [ ] No `setLifecycleStatus`-style helper exists in any layer; no action takes a status parameter.
- [ ] `tsc --noEmit`, ESLint, Prettier clean.

**Definition of done:** a draft is submitted, reviewed in testing, returned once for a fix, resubmitted and activated — and the version it replaced reads `OBSOLETE` while its subscribers' bills do not move.
