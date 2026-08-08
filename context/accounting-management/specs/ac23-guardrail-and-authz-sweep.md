# AC23 — Guardrail & Authz Sweep (Transactions Revision)

- **Unit:** 23 of 23 (`ac00-build-plan.md`) — closes the revision
- **Dependencies:** `ac18`–`ac22` all complete. `ac17` is the precedent: this unit is its equivalent for the revision, not a replacement — ac17's V1–V14 gates remain and must still pass.
- **Authorizing sections:** `acctmgmt-update-overview.md` §Success criteria **SC12, SC13, SC14** (and re-verification of SC1–SC11); `_updatemodule-accounts-transactions-plan.md` §Phased rollout (Phase 3 close-out); `acctmgmt-architecture.md` §6 **inv. #15–#21**; `acctmgmt-code-standards.md` §7.1 (test naming), §8 (page map), §9 (Result-code catalog); `acctmgmt-ai-workflow-rules.md` §8 (verification checklist).
- **Codebase verification performed for this spec:** `tests/accounts/grep-gates.test.ts` exists and is the established static-gate harness — pure `node:fs`/`node:path`, scanning the real source tree rather than a fixed file list, each gate mapped to the invariant it enforces (ac17 precedent, following `tests/guardrails/customer-module-boundaries.test.ts` from cm16). `tests/accounts/route-level-transactions.test.ts` exists and is the page's permission matrix. `tests/accounts/verification-audit.test.ts` exists as the V-completeness auditor.

---

## 1. Goal

Prove the revision did what it claimed: that `/accounts/transactions` enforces READ vs EDIT correctly across its new affordances, that the new read path never writes, that reversal eligibility is derived in exactly one place, and that the shipped reversal services are behaviourally untouched. Done when the full CI gate suite is green **with the ac11 reversal service tests passing unmodified** — the evidence this stayed a UI change.

## 2. Design

**Boundary: `tests/**` and documentation.** This unit writes **no application code**. If a gate fails, the fix lands in the owning unit's files and that unit's checklist is re-run — ac23 does not carry corrective code of its own.

### 2.1 Why a sweep unit at all

Its visible result is "the full CI gate suite is green for the revised page", which the `ac00` unit rules would normally treat as too thin. It survives as a unit for the same reason ac17 did: several of these gates are **cross-unit** and cannot be asserted from inside any single unit — no single unit can prove that eligibility is derived in exactly one place across ac20 and ac22, or that the permission matrix is complete across affordances introduced in four different units.

### 2.2 Route × level matrix — the revision's affordance table

Extends `route-level-transactions.test.ts` rather than replacing it. The page's permission (`accounts_transactions`) and levels are unchanged (code-standards §8); what changed is which affordances each level sees:

| Level | Sees | Must NOT see |
|---|---|---|
| no grant | nothing — blocked by the route guard | the page at all |
| `READ` | context strip, scope strip, banner, filters, documents table, detail drawer, lines, posted legs | action bar (all three controls), reversal control (row + drawer), approve/reject |
| `EDIT` | all of the above plus the action bar, the reversal control on eligible documents, approve/reject on pending ones | — |

**SC14** is the READ row: a read-only holder can trace a document from the table into the drawer with no write affordance rendered anywhere.

### 2.3 Static gates to add to `grep-gates.test.ts`

Each maps to an invariant and scans the source tree, so a *future* violating file fails the suite:

| Gate | Enforces | Assertion |
|---|---|---|
| Read path never writes | **inv. #15** | `list-transaction-documents.ts`, `get-transaction-document-detail.ts` and the repository's `listForContext` contain no `insert`/`update`/`delete`/`transaction(` and no pgledger function call |
| BAN scope admits FA-level | **inv. #16** | any source narrowing documents by billing account under an FA constraint also contains `IS NULL` / `isNull(` — a bare `= :ban` predicate fails |
| Context is URL-derived | **inv. #17** | no `useState`/`localStorage`/`sessionStorage`/`createContext` holding `party`, `fa` or `ban` under `app/(app)/accounts/**` or `components/accounts/**`; all five Accounts nav links carry the params |
| One eligibility derivation | **inv. #18** | the `state === "posted"` + unreversed-line predicate appears in exactly one non-service location (ac20's service); `components/accounts/**` contains no second copy |
| Five doc types only | **inv. #19** | no filter option, badge or label under `components/accounts/**` names a type outside `PAY/DEP/CRN/DBN/ADJ` — specifically no `"reversal"`, `"refund"` or `"write_off"` used **as a type** |
| Panels unwrapped | **inv. #20** | the ten create-panel modules import no `Dialog` and still export their component (from ac19) |
| No free-text reversal ID | **SC10** | `reversals-panel.tsx` is absent; no reversal input accepts a typed document id |
| Result-code catalog current | code-standards §9 | every `code: "…"` literal under `services/accounts/**` and `actions/accounts/**` appears in §9 of `acctmgmt-code-standards.md` — the reconciliation stays reconciled |

The last gate is new and deliberately guards the §9 catalog we just reconciled (49 codes) from drifting again.

### 2.4 Behavioural regressions to consolidate

Not re-implementations — this unit ensures each exists and runs together:

- **SC4** FA-level inclusion (ac20) — the predicate trap
- **SC6** eligibility branches (ac22) — six cases
- **SC7/SC8** document vs line reversal, allocation-without-capture (ac22)
- **SC2** nav context across all five links (ac18)
- **V1 zero-sum** after every posting test in ac22 (workflow rules §5)

### 2.5 The unmodified-tests gate (SC12)

The strongest available evidence that the revision was UI-only: the ac11 reversal service tests and the V-series must pass **with zero edits**.

```
git diff --stat <revision-base>..HEAD -- tests/accounts/v*.test.ts
```

must be empty. Any edit to a V-test during ac18–ac22 means a behavioural change slipped in and the owning unit must be re-examined. Wire this as an explicit check, not a habit.

Note the one legitimate exception recorded in ac19/ac20: `route-level-transactions.test.ts` **does** change (affordances moved). That file is not a V-test and is outside this gate's scope.

### 2.6 Documentation sync

The revision touched six context docs. Confirm each landed and is consistent:

| Doc | Expected state |
|---|---|
| `acctmgmt-architecture.md` | inv. #15–#21 present; §1 nav/read-layer rows; §3 scope predicate |
| `acctmgmt-code-standards.md` | §2.4 rewritten; §9 catalog (49 codes) matches shipped code; §4.1 `doc-state-badge` derived prop |
| `acctmgmt-ui-context.md` | §2 partially-reversed → Warning; owning-component note |
| `acctmgmt-ai-workflow-rules.md` | §1.1 dual decision logs; §4.4 resolution routing; §7 disabled-vs-hidden |
| `acctmgmt-update-overview.md` | SC1–SC14 all satisfied |
| `acctmgmt-progress-tracker.md` | ac18–ac23 complete; deferred items listed |

Re-run the §9 gate (§2.3) after any code change in this unit — it is the one doc assertion that is machine-checkable.

### 2.7 Deferred items to record, not fix

Carried forward explicitly so they are not mistaken for oversights:

1. **Account Lifecycle / `ClosurePanel` relocation (D1)** — its own change.
2. **`INTERNAL_ERROR` single-use** in `actions/accounts/reverse-document.ts` (code-standards §9.8).
3. **Generic `NOT_FOUND` overlapping** four specific codes (§9.8).
4. **Reject mutation** for pending documents, if ac21 found none (ac21 §2.4).
5. Bulk row actions, saved filter views, CSV export of the documents table.

---

## 3. Implementation

### 3.1 Extend `tests/accounts/route-level-transactions.test.ts`

Add the §2.2 affordance matrix: no-grant blocked; READ sees table + drawer and **zero** write affordances (assert absence of the action-bar triggers, the reversal control, and approve/reject); EDIT sees all three.

### 3.2 Extend `tests/accounts/grep-gates.test.ts`

Add the eight gates in §2.3, each named for its invariant and scanning the source tree in the existing harness style.

### 3.3 `tests/accounts/transactions-revision-audit.test.ts` (new)

Mirrors `verification-audit.test.ts` for the revision: asserts each SC has at least one mapped, passing test, and fails with the specific SC number when one is missing — so a future contributor deleting a regression test is told exactly what they broke.

### 3.4 Unmodified-tests check (§2.5)

Add the `git diff --stat` assertion over `tests/accounts/v*.test.ts` to the audit test (or the CI job if the harness cannot shell out). Failure message must name SC12 and explain that a V-test edit implies a behavioural change.

### 3.5 Documentation pass

Verify the §2.6 table; update `acctmgmt-progress-tracker.md` with ac18–ac23 complete and the §2.7 deferred list.

### 3.6 Explicitly NOT in this unit

No application code. No new permission, migration, table, column, document type or Result code. No corrective refactor — a failing gate is fixed in its owning unit. No re-opening of D1–D7 (workflow rules §1.1).

---

## 4. Dependencies (packages to install)

**None.** Vitest, Testing Library and the `node:fs`-based grep-gate harness all exist. Zero npm installs.

## 5. Verification checklist

**Diff hygiene**

- [ ] Changed: `route-level-transactions.test.ts`, `grep-gates.test.ts`. Added: `transactions-revision-audit.test.ts`. Docs per §2.6.
- [ ] **Zero application-code files changed** in this unit.

**Build gates**

- [ ] `typecheck` · `lint` · `format:check` · `test` green. Permission-count assertions unchanged across the whole revision — ac18–ac23 added none.

**Behavior — the point of the unit**

- [ ] **SC14 / §2.2 matrix:** READ sees table + drawer with no action bar, no reversal control, no approve/reject; EDIT sees all three; no-grant is blocked.
- [ ] All eight static gates in §2.3 pass, and each fails when deliberately violated in a scratch commit (a gate that cannot fail is not a gate — verify at least the inv. #16 and inv. #18 gates this way).
- [ ] **SC12:** `git diff --stat` over `tests/accounts/v*.test.ts` is empty; the ac11 reversal service tests pass unmodified.
- [ ] **SC13:** `npm run typecheck`, `npm run lint` and `tests/accounts/route-level-transactions.test.ts` all pass.
- [ ] SC1–SC11 re-verified end to end on a seeded customer: nav handoff → capture → table row (FA-level) → drawer → reverse an allocation line → V1 zero-sum holds.

**Invariants**

- [ ] **#15–#21** each have a passing gate or behavioural test; the audit test names any SC lacking coverage.

**Docs in sync**

- [ ] All six docs in §2.6 verified; §9 catalog still matches shipped code (machine-checked).
- [ ] `acctmgmt-progress-tracker.md`: ac18–ac23 complete; §2.7 deferred items recorded with owners.

**Pipeline**

- [ ] CI green incl. SAST + ZAP DAST baseline. DAST surface unchanged — the revision added no route.

Any failing item means the revision isn't done. On completion the Transactions revision (D1–D7) is closed; the next Accounts work is the deferred Account Lifecycle change (D1).
