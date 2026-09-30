# pm64 — Rollback

**Unit:** pm64 (Part 5). **Boundary:** `services/product/ratecard/rollback-version.ts` (new), `actions/product/rollback-ratecard-version.action.ts` (new — `EXPECTED_PRODUCT_ACTION_FILES` **+1**, and the list has now moved by **exactly three**), the `RATECARD_VERSION_ROLLED_BACK` audit type and its ripple, and this unit's live-DB and concurrency tests. **No UI** — pm66 builds the dialog.
**Specs from:** `prodmgmt-update-overview.md` (Core User Flow step 9) · `_updatemodule-ratecard-lookup-plan-v2.md` **RC11**, **RV1, RV3**, **D-A7**, _User flows_ › _Undo a bad activation_ · `prodmgmt-architecture.md` §3.6, §5 (Audit), Inv. **#45, #46** · `prodmgmt-code-standards.md` §1.13, §1.37, §1.43, §3.21, §3.22, §6.30, §7.9 · `prodmgmt-ai-workflow-rules.md` §4.3, §7.4, §8.8.
**Depends on:** **pm63** (the lock, the status transitions and the counts, all reused in the other direction).

---

## Goal

Return a `SUPERSEDED` version to `ACTIVE` and demote the current one, under the same lock and in one transaction — **editing no row of either version**, because a rollback is a status change and not an edit.

---

## Design

### D1. Rollback is a status change, and that is the whole design

Versions are immutable (RC11, RV3, Inv. #46). A superseded version's rows are exactly as they were when it was live — exactly its uploaded file (RV3). So restoring it needs no reconstruction: **flip two statuses and the card is back where it was.**

This is what "versions are immutable" buys, and it is worth naming in review because the obvious alternative — re-deriving the old state — would be both wrong and expensive.

### D2. Activation and rollback have the same shape

With carry-forward removed (D-A7), activation (pm63) and rollback are both two status flips under one lock, and **neither writes rows**. **If a unit finds itself writing an `INSERT … SELECT` here, it has misunderstood the model** (workflow §5.7).

The consequence is honest and must be stated rather than hidden: rolling back **loses** the additions the superseded version never had. That is what rolling back _means_. The way to keep them is to upload a corrected version, not to make rollback merge.

### D3. Same lock, same `tx` read, same TOCTOU discipline

Lock the card's current `ACTIVE` `FOR UPDATE` and the target `SUPERSEDED` version; **re-read both statuses on `tx` immediately before the decision** (§1.13, §1.37). One transaction: demote the current `ACTIVE` to `SUPERSEDED`, promote the target to `ACTIVE`, write the audit event, commit.

`superseded_by_version_id` needs a decision, and it is the one field where rollback is not symmetric with activation. The outgoing version (the one being demoted) gains `superseded_by_version_id = <the target>`. The target's own `superseded_by_version_id` — pointing at the version that originally replaced it — is **cleared**, because it is no longer superseded. Lineage is a statement about the present, not a log; the log is the audit trail. Write that in the doc-block, because the alternative (leaving a stale pointer on a live version) makes the version list render a lie.

### D4. The counts, computed in the other direction

The audit payload carries the same change counts, **computed in the other direction** — target against current `ACTIVE` rather than incoming against outgoing. pm62's diff does this without modification (pm62 D6): it compares two row sets, and which one is "new" is the caller's.

pm66's rollback confirmation repeats the same counts (§4.26, ui-context §10.6). Computing them **inside the transaction against the locked versions** — not from what the client was shown — is the same rule pm63 D8 sets, for the same reason.

### D5. A second `ACTIVE` is still refused by the index

The partial unique index (Inv. #45) does not care which direction the transition came from. The service check stays too (§6.30): the index changes the failure mode, it does not replace the check.

**The race that matters is activate-vs-rollback.** Two users, one card: one activating a `DRAFT`, one rolling back to a `SUPERSEDED` version. They must **serialize on the lock** rather than producing two `ACTIVE` versions. This module's standing lesson applies — **concurrency is proven, not assumed** — so the pair is tested, looped 4×, the way approve-vs-reject and suspend-vs-terminate were.

### D6. `ratecard : EDIT`, and no DELETE exists

Rollback is `ratecard : EDIT` (§8), the same level as upload and activate. **The module defines no `ratecard : DELETE`** (workflow §3.11) — nothing on this page deletes anything: versions are immutable, a correction is a new upload, and a rollback is a status change.

This unit is the natural place someone would add a "discard" for symmetry. **It is not built** (C2, and pm66 D-C2). A discard would be a fourth mutation, a fourth action file, a fourth audit type and a delete — four scope rules at once.

### D7. The third audit type, and the list closes at three

`RATECARD_VERSION_ROLLED_BACK`, in the same transaction as the write (§1.43). Full three-part ripple including the **non-`tsc`-caught** assertion in `tests/components/audit-log-filters.test.tsx` (§6.18, workflow §7.4).

This is the **third and last** new audit type (workflow §3.12) and the **third and last** action file: `EXPECTED_PRODUCT_ACTION_FILES` has now moved by **exactly three** (§3.21). Assert the total here, not only the increment — an accidental fourth is much easier to see against a stated total than against three separate +1s.

---

## Implementation

### I1. `services/product/ratecard/rollback-version.ts`

D3's transaction using pm60's locked read and `setVersionStatus`; the lineage rule of D3; the counts of D4 from pm62's diff. Framework-agnostic, no `next/*`. Typed result union, never a throw. Doc-block states D2 — **rollback writes no rows, like activation** (D-A7).

### I2. `actions/product/rollback-ratecard-version.action.ts`

`requirePermission('ratecard', 'EDIT')` → `isRedirectError` catch → `safeParse` the version id → one service call → `revalidatePath('/products/rate-card')` → typed result.

### I3. Audit

`RATECARD_VERSION_ROLLED_BACK` with the full ripple (D7).

### I4. Tests — live-DB, with the race looped 4×

1. Rolling back restores a `SUPERSEDED` version to `ACTIVE` and demotes the current one, in **one** transaction.
2. **Both versions' rows are byte-identical before and after** — the headline assertion, and the one that proves D1.
3. No rows were written: neither version's row count changed (D2).
4. Lineage: the demoted version points at the target; the target's own `superseded_by_version_id` is **cleared** (D3).
5. Exactly **one** audit event, carrying the change counts computed **in the other direction**, inside the transaction.
6. **A concurrent activate/rollback pair, looped 4×, serializes on the lock** and never leaves two `ACTIVE` versions (D5).
7. A direct attempt to produce a second `ACTIVE` is refused by the partial unique index; the service refuses it first with a typed code.
8. Rolling back to a version that is not `SUPERSEDED` (a `DRAFT`, or the current `ACTIVE`) is refused with a typed code and no write.
9. Rolling back when there is no current `ACTIVE` succeeds — the target simply becomes `ACTIVE`; assert no null-pointer path.
10. A rollback followed by a re-activation of the newer version restores it exactly, both directions byte-clean (the "undo the undo" case).
11. `ratecard : READ` is refused at the action guard with no partial effect.
12. **`EXPECTED_PRODUCT_ACTION_FILES` has moved by exactly three** across pm61 + pm63 + pm64, and `AUDIT_EVENT_TYPES` has gained exactly three.

### I5. Documentation

1. **Code-standards §7 tree** — `rollback-version.ts` and its action marked landed under **pm64**.
2. **Code-standards §3.21** — the movement **closed at three**, stated as a total.
3. **Architecture §5 (Audit)** — the third type marked landed; the list of three closed.
4. **`pm00-build-plan.md`** — record D2's honest consequence (a rollback loses keys added since) in the hand-off register, so it is a known property rather than a support ticket.
5. **`pm00-build-plan.md`** — **C2** restated as declined: _"Discard draft" is not built_, with the four scope rules it would break, so pm66 does not re-open it on its own.

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run test` (live-DB integration **and** concurrency, against disposable ephemeral containers), `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** pm63 merged. **G-RC3** for the permission the guard names.

---

## Verification checklist

Immutability — the headline

- [ ] **Both versions' rows are byte-identical before and after a rollback.**
- [ ] No rows are written; neither row count changes.
- [ ] No `INSERT … SELECT` appears anywhere in this unit's path.

Transaction and lock

- [ ] Demote and promote are **one transaction**; both statuses are read on `tx`, `FOR UPDATE`, immediately before the decision.
- [ ] **A concurrent activate/rollback pair, looped 4×, serializes** and never produces two `ACTIVE` versions.
- [ ] A second `ACTIVE` is refused by the index, and by the service check before it.

Lineage and refusals

- [ ] The demoted version points at the target; the target's own `superseded_by_version_id` is cleared.
- [ ] Rolling back to a `DRAFT` or to the current `ACTIVE` is refused with a typed code and no write.
- [ ] Rolling back with no current `ACTIVE` succeeds.
- [ ] Undo-the-undo restores exactly, both directions byte-clean.
- [ ] `ratecard : READ` is refused at the action guard with no partial effect.

Audit and the closing totals

- [ ] Exactly one `RATECARD_VERSION_ROLLED_BACK`, in the same transaction, carrying the change counts computed **in the other direction, server-side**.
- [ ] All three parts of the ripple landed, including the assertion `tsc` does not catch.
- [ ] **`EXPECTED_PRODUCT_ACTION_FILES` has moved by exactly three** across pm61/pm63/pm64 — asserted as a total.
- [ ] **`AUDIT_EVENT_TYPES` has gained exactly three.**
- [ ] `revalidatePath` names `/products/rate-card` only.

Boundaries

- [ ] **No "discard draft" action, no `ratecard : DELETE`, no fourth audit type, no fourth action file** (C2).
- [ ] No row of any version is edited, in any layer.
- [ ] `tsc --noEmit`, ESLint, Prettier and the unit's suites green.

**Definition of done:** a bad activation is undone by flipping two statuses — the previous version comes back exactly as it was, byte for byte, because nothing was ever edited in the first place — and the three mutations the rate card will ever have are now all built, counted and closed.
