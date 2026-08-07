# AC19 — Action Launcher + Dialog Shells

- **Unit:** 19 of 23 (`ac00-build-plan.md`)
- **Dependencies:** `ac07`–`ac10` (the ten create-panels exist and post correctly), `ac18` (context survives sidebar navigation, so the restructured page is testable with a real selection). `ac11`'s `ReversalsPanel` and `ac16`'s `ClosurePanel` are present and **left untouched** by this unit.
- **Authorizing sections:** `acctmgmt-update-overview.md` §Goals 2, §Features "Action launcher", §Success criteria **SC1**; `_updatemodule-accounts-transactions-plan.md` §Target design ("Create-actions move into a launcher"), decisions **D1** (Account Lifecycle deferred → no tabs) and **D3** (primary vs secondary split); `acctmgmt-architecture.md` §1 (shared UI kit note), §2 (`components/accounts/**` ownership), §6 **inv. #20** (dialog wrapping preserves panel contracts); `acctmgmt-code-standards.md` §3.3 (one action per operation — unchanged), §3.5 (context-gating disables), §4.1 (shared components); `acctmgmt-ai-workflow-rules.md` §7 rule 3 (disabled ≠ hidden).
- **Codebase verification performed for this spec:** `components/ui/dialog.tsx` exports `Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger`. No `components/ui/dropdown-menu.tsx` exists. The unified **`radix-ui` v1.6.0** package is already a dependency and `components/ui/select.tsx` imports from it as `import { Select as SelectPrimitive } from "radix-ui"` — so `DropdownMenu` costs zero installs. All ten panels are `"use client"` and take only id-shaped props (`financialAccountId`, `billingAccountId`, plus `PaymentRefundPanel`'s `assignedItems`/`unappliedCashAvailable`).

---

## 1. Goal

Replace the Transactions page's thirteen simultaneously-rendered panels with a three-control action bar — **+ Payment**, **+ Note**, **More actions** (D3) — that opens each existing create-panel inside a `Dialog` with its props, Zod schema, server action and error mapping byte-identical. Done when the page renders as header + context strip + action bar (plus the still-untouched `PendingApprovalsList` and `ClosurePanel`), and every one of the ten operations posts exactly as it did before.

## 2. Design

**Boundary: `app/(app)/accounts/transactions/page.tsx`, `components/accounts/**` (new launcher + dialog wrappers), and one new `components/ui/dropdown-menu.tsx`.** No service, repository, action, schema, migration or permission change. This unit moves markup; it does not change behaviour.

### 2.1 What this unit deliberately does not fix yet

After ac19 the page still has **no transaction history** — that is ac20. `PendingApprovalsList` therefore stays exactly where it is, and `ReversalsPanel` keeps its free-text `docId` form: until a table exists there is nothing to launch a reversal from, and removing the only reversal entry point would regress the page. Both are retired by ac20/ac22 respectively. `ClosurePanel` stays permanently for this revision (D1).

This is a deliberate intermediate state, and it is coherent: every action that worked before still works, and the page is materially shorter.

### 2.2 Action bar composition (D3)

| Control | Type | Entries | Rationale |
|---|---|---|---|
| **+ Payment** | primary | Capture Payment · Allocate Payment · Payment Refund | The daily path; allocation is the most common follow-up to capture |
| **+ Note** | primary | Raise Credit Note · Raise Debit Note | Routine billing corrections |
| **More actions** | secondary | Capture Security Deposit · Reverse Deposit to Account · Refund Deposit · Write Off · Rounding Adjustment | Occasional or exceptional; deposits are lifecycle-adjacent, write-off and rounding are rare and mostly approval-gated |

**Reversal appears in none of them** — it is a row action introduced in ac22 (D4). Until then it remains `ReversalsPanel` below the bar.

"Reverse Deposit to Account" carries a one-line description in the menu (`Applies deposit to A/R — not a ledger reversal`). It creates a new `DEP` document and is **not** a ledger reversal; the name collision is an operational trap worth defusing in the UI text.

### 2.3 Context gating — disabled, not hidden (code-standards §3.5, workflow rules §7)

Menu entries disable until the URL context satisfies their requirement (Q1): **FA only** for Capture Payment, all three Deposit entries; **FA + BAN** for Allocate Payment, Payment Refund, both Notes, Write Off, Rounding Adjustment. A disabled entry carries a `title` naming what is missing ("Select a Billing Account in Overview").

This is the *opposite* rule from ac22's reversal control, which **hides**. The distinction is deliberate and documented in workflow rules §7: context-gating disables (the action exists, you lack context), eligibility hides (the action does not apply to this document). Neither is authorization — every action re-validates server-side.

If a whole menu's entries are all disabled, the trigger button itself is disabled with the same explanatory `title`.

### 2.4 Dialog wrapping — the invariant this unit exists to respect (inv. #20)

Each panel keeps its own file and its current default export unchanged. A thin wrapper supplies the dialog chrome only:

- Panel props, internal state, Zod schema, server action call, error mapping and submit semantics are **byte-identical**. A reviewer diffing a panel file should see no functional change.
- Each panel must remain renderable **outside** a dialog — the wrapper is additive, not a new required parent. This keeps the panels testable standalone and is the concrete expression of inv. #20.
- The panel's existing `<h3>` heading is dropped in favour of `DialogTitle` to avoid a duplicated heading; this is the one permitted markup change, and it is in the wrapper's composition, not inside the panel.
- On success the panel already calls `router.refresh()`. The wrapper closes the dialog on success by passing an `onSuccess` callback **only if the panel already exposes one**; where it does not, the dialog stays open showing the panel's own success message and the user closes it. Do **not** add success plumbing into panel internals in this unit — that would violate inv. #20. Any panel needing it is recorded for a follow-up, not patched here.

### 2.5 `components/ui/dropdown-menu.tsx` (new shared primitive)

Built on the already-installed unified `radix-ui` package, mirroring `select.tsx`'s import style:

```ts
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
```

Chosen over a hand-rolled button + popover `div` because the action bar is a daily-use money surface: Radix supplies keyboard navigation, focus management, `Escape`/outside-click dismissal, and correct ARIA at zero dependency cost. Styling uses existing shared tokens only — surface/border/radius per `ui-context`; **no new token, no `--ai-*`, no gradient** (`acctmgmt-ui-context.md` §5).

This is the unit's only shared-kit addition and is available to all modules thereafter. It is merged into ac19 rather than being its own unit because a primitive with no consumer has no standalone visible result (`ac00` unit rules).

### 2.6 Page structure after ac19

```
<main>
  header (h1 + subtitle)
  <ContextStrip …/>                       ← unchanged
  read-only notice when !canEdit          ← unchanged
  {canEdit && (
    <TransactionsActionBar …/>            ← NEW (three controls + ten dialogs)
    <ReversalsPanel …/>                   ← unchanged, retired by ac22
    <ClosurePanel …/>                     ← unchanged, deferred (D1)
    Pending Approvals section             ← unchanged, absorbed by ac20
  )}
</main>
```

Single scroll, **no tabs** — D1 removed the only reason this page needed them, so no `Tabs` primitive is added to the shared kit.

### 2.7 Data-fetch changes: none

`PaymentRefundPanel` needs `assignedItems` + `unappliedCashAvailable`, and the page already fetches them via `getRefundWorkbenchData`. Keep the existing server-side fetch and pass the props through the wrapper. Do **not** move this to a client fetch on dialog-open in this unit — that is a behaviour change disguised as a refactor.

---

## 3. Implementation

### 3.1 `components/ui/dropdown-menu.tsx` (new)

shadcn dropdown-menu over the installed `radix-ui` package (§2.5). Export the standard surface: `DropdownMenu`, `DropdownMenuTrigger`, `DropdownMenuContent`, `DropdownMenuItem`, `DropdownMenuLabel`, `DropdownMenuSeparator`.

### 3.2 `components/accounts/transactions-action-bar.tsx` (new, `"use client"`)

Owns the three triggers, their menus, the per-entry context-gating predicate (§2.3), and which dialog is open (a single `openAction: ActionKey | null` state — client state is correct here; it is transient UI, not selection context, so inv. #17 is not engaged). Receives `financialAccountId`, `billingAccountId`, and the refund workbench props; renders the ten dialog wrappers.

### 3.3 Dialog wrappers

One small wrapper per operation composing `Dialog` + `DialogContent` + `DialogHeader`/`DialogTitle` + the existing panel. Co-locate them in `transactions-action-bar.tsx` (or a sibling `transaction-dialogs.tsx` if the file exceeds ~250 lines) rather than ten new files — they are one-line compositions with no independent reuse.

### 3.4 `app/(app)/accounts/transactions/page.tsx`

Delete the ten inline `<section>` panel renders and the two grid wrappers; render `<TransactionsActionBar>` in their place. Keep: the guard, `parseAccountsContext`, all existing `Promise.all` data fetches, `ContextStrip`, the read-only notice, `ReversalsPanel`, `ClosurePanel`, the Pending Approvals section. Page stays `force-dynamic`.

### 3.5 Tests

New `tests/components/transactions-action-bar.test.tsx`:

- Three triggers render; each menu lists exactly the entries in the §2.2 table.
- With FA only: Capture Payment and the three Deposit entries enabled; Allocate, Refund, both Notes, Write Off, Rounding disabled with an explanatory `title`.
- With FA + BAN: all ten enabled.
- With neither: all ten disabled and all three triggers disabled.
- Opening an entry renders that panel's distinctive field (e.g. Capture Payment → "Payment Mode"); `Escape` closes.
- **Reversal is absent from all three menus** (D4/ac22 boundary).

Update `tests/accounts/route-level-transactions.test.ts` only if it asserts panel-heading text that no longer renders at page level; do not weaken its permission assertions.

Add a wrapping-integrity assertion to `tests/accounts/grep-gates.test.ts`: each of the ten panel modules still exports its component and contains no `Dialog` import — proving the shell moved outward and inv. #20 held.

### 3.6 Explicitly NOT in this unit

No documents table (ac20). No detail drawer (ac21). No row-level reversal, no change to `ReversalsPanel` (ac22). No `PendingApprovalsList` change (ac20). No `ClosurePanel` change ever in this revision (D1). No `Tabs`. No new permission, migration, service, repository method, validation schema, or document type. No change to any panel's internals.

---

## 4. Dependencies (packages to install)

**None.** `components/ui/dropdown-menu.tsx` is new source built on the already-installed unified `radix-ui` v1.6.0 (the same package `select.tsx`, `dialog.tsx` and the rest of the kit use). `lucide-react` supplies the chevron/plus icons. Zero npm installs, zero config change.

## 5. Verification checklist

**Diff hygiene**

- [ ] Added: `components/ui/dropdown-menu.tsx`, `components/accounts/transactions-action-bar.tsx` (+ optional `transaction-dialogs.tsx`), the new test. Changed: `transactions/page.tsx` (panel renders → action bar).
- [ ] **The ten panel files are unchanged** — `git diff --stat components/accounts/*-panel.tsx` shows no modification to the ten create-panels (inv. #20).
- [ ] `ReversalsPanel`, `ClosurePanel`, `PendingApprovalsList` unchanged.
- [ ] No new token, no `--ai-*`, no gradient. No `TODO`/`console.*`.

**Build gates**

- [ ] `typecheck` · `lint` · `format:check` · `test` green. Permission-count assertions do not move.

**Behavior — the point of the unit**

- [ ] **SC1:** the page renders header + context strip + three controls; no create-form is visible until its dialog is opened.
- [ ] All ten operations post exactly as before — spot-check Capture Payment, Allocate Payment and Raise Credit Note end to end and confirm the resulting documents match pre-change behaviour (same doc type, reason, legs).
- [ ] Context gating: with FA only, BAN-requiring entries are **disabled with a reason**, not hidden (§2.3); server still re-validates.
- [ ] Keyboard: each menu opens with `Enter`/`Space`, arrow-navigates, closes on `Escape`; focus returns to the trigger; dialog traps focus and restores it on close.
- [ ] Reversal is absent from the action bar; `ReversalsPanel` still works unchanged.

**Invariants**

- [ ] **Inv. #20:** panel props/schema/action/error-mapping byte-identical, and each panel still renders standalone outside a dialog.
- [ ] **Inv. #17:** no selection context moved into component state — `openAction` is transient UI state only.

**Docs in sync**

- [ ] `acctmgmt-progress-tracker.md`: `ac19` complete, "Next Up" → `ac20`. Note the new shared primitive so other modules know `DropdownMenu` is available.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline (no new route).

Any failing item means the unit isn't done. **ac20** adds the documents table and retires `PendingApprovalsList`.
