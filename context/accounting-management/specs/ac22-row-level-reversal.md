# AC22 — Row-Level Reversal

- **Unit:** 22 of 23 (`ac00-build-plan.md`) — the revision's only write-path unit
- **Dependencies:** `ac21` (drawer renders document lines — the reversal dialog reuses that line rendering), `ac20` (rows carry the `reversible` / `partiallyReversed` derivation), `ac11` (`reverseDocument`, `reverseLine`, `getReversalPreview` and their actions all exist and are **not modified**).
- **Authorizing sections:** `acctmgmt-update-overview.md` §Goals 3, 4, 5, §Features "Reversal", §Success criteria **SC6, SC7, SC8, SC10**; `_updatemodule-accounts-transactions-plan.md` §"Reversal: a row action, gated on real eligibility", decisions **D4** (hide when ineligible) and **D5** (no permission split); `acctmgmt-architecture.md` §4 (affordance visibility is not authorization), §6 **inv. #18, #21**; `acctmgmt-code-standards.md` §2.4/§9.4 (Result codes), §3.3 (per-operation actions); `acctmgmt-ai-workflow-rules.md` §7 rule 3 (hidden vs disabled).
- **Codebase verification performed for this spec:** `reverseDocumentSchema` **already** carries an optional `selectedLineIds: string[]`, and `actions/accounts/reverse-document.ts` **already** routes to `reverseDocument` vs `reverseLine` on its presence — so the checkbox UI maps onto the shipped contract with **no schema or action change**. `getReversalPreviewAction(documentId, financialAccountId)` exists and returns `ReversalPreview` with `lines[]` carrying `documentLineId`, `lineNo`, `lineKind`, `amount`, `isAllocation`, `alreadyReversed`, and the computed opposite legs (`reversalFrom/ToAccountId/Name`), plus `lastModified` as an ISO string for the CAS. `reverse-document.ts` gates on `state === "posted"` and at least one line with `reversedByLineId === null`.

---

## 1. Goal

Replace `ReversalsPanel`'s free-typed document-ID form with a reversal control on the document being reversed — rendered only where `reverseDocument` would actually succeed — and a document-bound dialog whose line checkboxes select between full and partial reversal. Done when a payment's allocation line can be reversed from the UI while its bank capture stays posted, ineligible documents show no reversal control at all, and the free-text form is gone.

## 2. Design

**Boundary: `components/accounts/**` (reversal control + dialog), `app/(app)/accounts/transactions/page.tsx` (removal of `ReversalsPanel`).** **No service, action, validation-schema, repository, migration or permission change** — the entire server contract already exists from ac11.

### 2.1 Eligibility mirrors the service; it never replaces it (inv. #18)

The control renders exactly where `reverse-document.ts` would succeed:

```
state === "posted"  AND  at least one line with reversedByLineId === null
```

ac20 already derives this as `reversible` on each row (§2.3 of that spec) — **this unit consumes that derivation and does not re-implement it.** Two implementations of one predicate is the failure mode inv. #18 exists to prevent.

Rendering is not authorization. `reverseDocument` / `reverseLine` continue to validate state, line coverage, FA ownership, `lastModified` concurrency and open period on every call, returning `DOC_STATE_INVALID`, `ALREADY_REVERSED`, `WRONG_FINANCIAL_ACCOUNT`, `CONFLICT`, `PERIOD_CLOSED` regardless of what was rendered. The existing reversal service tests must pass **unmodified** — that is the evidence this stayed a UI change.

### 2.2 Hidden, not disabled (D4)

Ineligible documents render **no reversal control** — not a greyed one. Their state badge (`Draft`, `Pending approval`, `Reversed`) already explains why, and a permanently-disabled button on every draft and pending row is clutter on the page's densest surface.

The **drawer** keeps one line of explanatory text for the two cases where an operator might expect the action and needs to know where it went: an already-reversed document names the document that reversed it (`Reversed by DBN000002`), and a pending one points to approve/reject. Informational text, not a control.

Contrast with ac19's create actions, which **disable** on missing context. Both rules live on this page and must not be conflated (workflow rules §7 rule 3): context-gating disables; document eligibility hides.

### 2.3 Two entry points, one dialog

- **Table row** — an `↺ Reverse` button in the actions column, on eligible rows only. Must `stopPropagation` so it does not also open the ac21 drawer.
- **Drawer footer** — `↺ Reverse…` for the open document.

Both open the same dialog bound to that `documentId`. There is **no context-free entry point**: the action bar has no reversal item (ac19 §2.2), and after this unit no free-text ID input exists anywhere (**SC10**).

### 2.4 The dialog — line selection unifies the two services

On open, call the existing `getReversalPreviewAction(documentId, financialAccountId)`. Render `preview.lines`:

- lines with `alreadyReversed: true` — shown, disabled, marked "already reversed" (context for the operator; they are never submitted)
- lines with `alreadyReversed: false` — checkbox, **checked by default**

The selection drives which service runs, via the already-shipped contract:

| Selection | `selectedLineIds` sent | Service invoked | Effect on the original |
|---|---|---|---|
| All unreversed lines checked | omitted / empty | `reverseDocument` | flips to `reversed` |
| A subset checked | that subset | `reverseLine` | stays `posted` with a reduced remainder |

The dialog states which call it will make and its consequence, so the operator is not guessing. **Submit is disabled when nothing is checked** — the service would return `LINE_NOT_FOUND`, and the UI should not manufacture a call it knows will fail.

This surfaces the headline capability that exists in the service but has had no UI path: reversing a payment's **allocation** line to return funds to unapplied cash while the bank capture stays posted (`isAllocation` on the preview line makes it labellable).

### 2.5 Preview legs and approval weight (inv. #21)

The preview supplies the computed opposite legs per line (`reversalFrom/ToAccountId/Name`); render them for the checked lines so the ledger effect is visible **before** submission. Never compute legs client-side (workflow rules §4.1 — never guess a leg).

Reversal inherits the original's reason-code approval weight. The dialog **states** this before submission; it does **not** compute it (**inv. #21**) — the routing decision stays in `services/accounts/`. If the shipped preview does not expose a threshold hint, show a neutral advisory ("may require manager approval") rather than inventing a computation.

### 2.6 Concurrency

`preview.lastModified` (ISO string) is passed straight through to `reverseDocumentAction` for the existing CAS — the panel does exactly this today; preserve it. A stale value yields `CONFLICT`, which the dialog surfaces with a reload prompt rather than retrying silently.

### 2.7 Retiring `ReversalsPanel` (SC10)

`components/accounts/reversals-panel.tsx` is **deleted**, not repurposed: its free-text `docId` input, its own preview-loading state and its request-cancellation ref all exist to compensate for having no document to start from. The new dialog is document-bound by construction.

Its useful parts are preserved: the `describeReversalError` code→message mapping moves into the dialog (or a shared helper) so error vocabulary does not regress, and the line-selection interaction is reproduced with the ac21 line rendering.

### 2.8 Permissions (D5)

No permission change. `reverseDocument` and `reverseLine` both require `accounts_transactions : EDIT`, so line-level reversal carries **no separate gate** — the checkboxes select a service, not a privilege. A READ-only holder sees no reversal control on rows or in the drawer.

---

## 3. Implementation

### 3.1 `components/accounts/reversal-dialog.tsx` (new, `"use client"`)

Props: `documentId`, `financialAccountId`, `open`, `onOpenChange`. On open: `getReversalPreviewAction` → loading → lines (§2.4). Holds checkbox state, the reversal comment, the Q29 date trio (`eventAt`, `referenceDate`, `referenceInfo` — required by `documentBaseSchema`, defaults as `ReversalsPanel` does today), submits `reverseDocumentAction`, maps Result codes via the migrated `describeReversalError`, calls `router.refresh()` on success.

Sends `selectedLineIds` **only** when a strict subset is checked; omits it when all are (§2.4).

### 3.2 `components/accounts/documents-table.tsx` — actions column

Render `↺ Reverse` only when `row.reversible && canEdit` (§2.1/§2.2/§2.8). `onClick` calls `event.stopPropagation()` before opening the dialog so the row's drawer link does not also fire (§2.3).

### 3.3 `components/accounts/document-detail-drawer.tsx` — footer

Eligible + `canEdit` → `↺ Reverse…`. Ineligible → the one-line explanation from §2.2, no control. Pending → ac21's approve/reject, unchanged.

### 3.4 Page wiring

Remove `ReversalsPanel` from `transactions/page.tsx` and delete the component file. No other page change.

### 3.5 Tests

`tests/accounts/reversal-eligibility.integration.test.ts` — **SC6**, one case per branch, asserting the control's visibility predicate matches the service's outcome for the same fixture:

| Fixture | Control | Service |
|---|---|---|
| posted, all lines unreversed | shown | succeeds |
| posted, some lines reversed | shown | succeeds on remainder |
| posted, all lines reversed | **hidden** | `ALREADY_REVERSED` |
| `draft` | **hidden** | `DOC_STATE_INVALID` |
| `pending_approval` | **hidden** | `DOC_STATE_INVALID` |
| `reversed` | **hidden** | `ALREADY_REVERSED` |

`tests/accounts/reversal-line-selection.integration.test.ts` — **SC7, SC8**:

- All lines checked → `reverseDocument` path → original becomes `reversed`.
- Subset checked → `reverseLine` path → original stays `posted`; remainder still reversible; a second reversal of the remainder then flips it to `reversed`.
- **SC8:** reversing a `PAY` allocation line leaves the capture line posted and returns the amount to `unapplied_cash`.
- Stale `lastModified` → `CONFLICT`.
- **V1 zero-sum holds after every posting assertion** (workflow rules §5).

`tests/components/reversal-dialog.test.tsx`: already-reversed lines rendered disabled and never submitted; submit disabled with nothing checked; the stated call flips between `reverseDocument`/`reverseLine` as boxes toggle; legs shown for checked lines only.

**SC10:** extend `tests/accounts/grep-gates.test.ts` — no source file under `components/accounts/` contains a free-text document-ID input for reversal, and `reversals-panel.tsx` no longer exists.

**Unmodified-tests gate:** the ac11 reversal service tests (`v13-line-reversal-conservation.property.test.ts`, `v04-cash-conservation.property.test.ts`) must pass with **zero edits**.

### 3.6 Explicitly NOT in this unit

No change to `reverse-document.ts`, `reverse-line.ts`, `get-reversal-preview.ts`, their actions, or `reverse-document.schema.ts`. No new Result code, permission, migration, table, column or document type. No manager-only gate on line-level reversal (D5). No `ClosurePanel` change (D1). No bulk reversal.

---

## 4. Dependencies (packages to install)

**None.** The reversal services, actions, schema and preview type all exist from ac11; `Dialog` and `Checkbox` are already in `components/ui/`. Zero npm installs, zero migrations, zero server-side change.

## 5. Verification checklist

**Diff hygiene**

- [ ] Added: `reversal-dialog.tsx`, the three test files. Changed: `documents-table.tsx` (actions column), `document-detail-drawer.tsx` (footer), `transactions/page.tsx`. **Deleted:** `reversals-panel.tsx`.
- [ ] `git diff` shows **no change** under `services/accounts/`, `actions/accounts/`, `validation/accounts/`, `db/`.
- [ ] No new Result code; error messages reuse the migrated `describeReversalError`.

**Build gates**

- [ ] `typecheck` · `lint` · `format:check` · `test` green; permission-count assertions do not move.

**Behavior — the point of the unit**

- [ ] **SC6:** the control appears on exactly the posted-with-unreversed-lines documents and on no others; all six branches in §3.5 verified.
- [ ] **SC7:** all lines checked → `reverseDocument`, original `reversed`; subset → `reverseLine`, original stays `posted` and the remainder is still reversible.
- [ ] **SC8:** a payment's allocation line reverses while its capture stays posted; funds return to unapplied cash; **V1 zero-sum holds**.
- [ ] **SC10:** no free-text document-ID input exists anywhere; every reversal starts from a document.
- [ ] Row `↺ Reverse` does not also open the drawer (`stopPropagation`).
- [ ] Ineligible documents show no control; the drawer explains why in text.
- [ ] Approval-inheriting reversal states the requirement before submission and is routed by the service, not the UI.
- [ ] A READ-only holder sees no reversal control on rows or in the drawer (D5/§2.8).

**Invariants**

- [ ] **#18:** eligibility mirrors the service — the ac11 service tests pass **unmodified**, and no second copy of the predicate exists (the UI consumes ac20's `reversible`).
- [ ] **#21:** approval weight is inherited and stated, never computed in the UI.
- [ ] **#19:** the reversal document reuses the original's `docType`; no sixth type appears anywhere.

**Docs in sync**

- [ ] `acctmgmt-progress-tracker.md`: `ac22` complete, "Next Up" → `ac23`. Record `reversals-panel.tsx` as removed.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline.

Any failing item means the unit isn't done. **ac23** runs the full guardrail and authz sweep across ac18–ac22.
