# AC17 — Guardrail & Authz Sweep: Route × Level Matrix, V1–V14 Audit, Grep Gates, Docs Sync

- **Unit:** 17 of 17 (`ac00-build-plan.md`) — the final gate, following the `cm16` precedent.
- **Dependencies:** `ac01`–`ac16` (everything). This unit adds no feature — it audits the whole module.
- **Authorizing sections:** `acctmgmt-project-overview.md` *Success criteria* (all six items — the 14 V-tests, atomic onboarding, full RevOps vocabulary, sample scenario reproduction, closed-period behaviour, three-permission RBAC server-side); `acctmgmt-architecture.md` §6 (all 14 Module Invariants — each "testable and CI-enforced"); `acctmgmt-code-standards.md` §1.1 (only `post-document` calls transfer functions), §1.3 (no delete functions), §2.2 (money arithmetic only in `money.ts`), §2.3 (signed-balance helpers, no raw `< 0`), §6.3 (pgledger only via repositories/functions/views), §6.4 (fork integrity — `pgledger:transform` in sync), §7.1 (V-tests named `v01…v14`), §8 (permission map — the route × level source of truth); plan §4 (V1–V14 definitions). Precedent: `cm16-authz-guardrail-sweep.md`.
- **Note on codebase verification:** planning-folder-only session. Confirm the existing grep-gate/CI harness `cm16` established (this unit extends the same mechanism to the Accounts module) and the route-guard test-matrix helper.

---

## 1. Goal

Ship the module's completeness gate: the full **route × level matrix** across all six Accounts pages + the export route (every permission × level combination asserted, server-side, per code-standards §8), a **V1–V14 completeness audit** confirming every verification test exists, is named per convention, and passes, the **grep gates** (no `pgledger_create_transfer(s)` outside `post-document`; no pgledger function/view call outside `db/repositories/accounts/`; no money arithmetic outside `money.ts`; no delete functions on `billing.*`; no stored balance column; no raw `< 0` on a balance outside the signed helpers; `pgledger:transform` in sync), and a **docs-sync** pass. Done when the full CI gate suite is green and every one of the 14 module invariants has a passing enforcement.

## 2. Design

No feature code, no schema, no UI — only tests, static-analysis gates, and doc updates (cm16 precedent). Boundary: **`tests/accounts/**` (matrix + audit), the CI grep-gate config/scripts, and the module docs**. Adds no runtime surface (DAST unchanged from ac16).

### 2.1 Route × level matrix (code-standards §8)

One matrix test asserting, for each page/route, that every relevant `(permission, level, holder)` combination resolves correctly — access granted only at the documented level, denied otherwise, **enforced server-side independent of nav visibility** (the project-overview success criterion: an `accounts_view`-only user can trace a transaction Overview → GL line with **no write affordance**). Coverage:

| Surface | Permission : Level |
|---|---|
| `/accounts/overview` | `accounts_view : READ` |
| `/accounts/ledger` | `accounts_view : READ` |
| `/accounts/transactions` | `accounts_transactions : READ` (view) / `EDIT` (draft/submit/post-within-limit/approve) |
| `/accounts/chart-of-accounts` | `accounts_config : READ` / `EDIT` |
| `/accounts/gl-journal` | `accounts_config : READ` / `EDIT` (export/close) |
| `/administration/accounts-settings` | `accounts_config : EDIT` (flows doc `: READ`) |
| `POST /api/accounts/gl-journal-export` | `accounts_config : EDIT` |

Plus the **workflow rules that are not permission levels** (code-standards §8): MANAGER-vs-USER approval routing is the reason-code threshold + `approved_by ≠ created_by` service check (Inv. #6), asserted here as a cross-cutting property — a USER cannot post above a limit, a creator cannot approve their own doc, regardless of holding `accounts_transactions:EDIT`. And the **dual-permission** onboarding action (ac04 — `accounts_transactions:EDIT` **and** the Customer transition permission).

### 2.2 V1–V14 completeness audit (plan §4, code-standards §7.1)

Assert all 14 verification tests exist, are named `tests/accounts/v01…v14`, and pass — mapping each to its owning unit and invariant:

| V | Property | Owner |
|---|---|---|
| V1 | zero-sum per currency after every posting | ac01 (+ re-run everywhere) |
| V2 | binding integrity (3 per customer, currency match) | ac04 |
| V3 | API/UI balance = ledger balance | ac05/ac07 |
| V4 | cash-application conservation (property) | ac11 |
| V5 | GL resolution completeness (0 unmapped) | ac03/ac12 |
| V6 | GL journal balance (Σ debit = Σ credit) | ac13/ac14 |
| V7 | onboarding atomicity (rollback, 0 orphans) | ac04 |
| V8 | payment_status derivation | ac07 |
| V9 | bill-cycle catalog integrity | ac15 |
| V10 | term resolution + freeze | ac04/ac15 |
| V11 | document state machine (threshold, approver≠creator, atomic, unbalanced, closed-period) | ac07 |
| V12 | posting-nature steering (revenue_adj/write_off → 4090/6100) | ac09/ac10 |
| V13 | line-level reversal conservation (property) | ac11 |
| V14 | deposit lifecycle → zero + closure eligibility | ac08/ac16 |

The audit fails if any V-test is missing, misnamed, skipped, or red.

### 2.3 Grep gates (static analysis — the invariants a test can't fully cover)

CI grep/AST gates, each mapped to an invariant/standard:
- **`pgledger_create_transfer(s)` appears only in `services/accounts/post-document.ts`** (code-standards §1.1, Inv. #3).
- **pgledger functions/views (`pgledger_*`) referenced only under `db/repositories/accounts/`** (code-standards §6.3, Inv. #4).
- **No `parseFloat`/`Number(`/`* / + -` arithmetic on an amount outside `services/accounts/money.ts`** (code-standards §2.2) — amounts stay `string`.
- **No raw `< 0` / `> 0` comparison on a balance string** outside the signed-balance helpers (code-standards §2.3).
- **No delete function** (`delete`/`DROP`/DML delete) on any `billing.*` module table in repositories (code-standards §1.3, Inv. #11).
- **No monetary balance column** in any `billing` module table (Inv. #2) — schema scan.
- **`pgledger:transform` in sync** — re-run yields no diff (Inv. #14).
- **No `--ai-*`/gradient tokens** on any `/accounts/**` or accounts-settings surface (ui-context §5).

### 2.4 Docs sync

- `acctmgmt-progress-tracker.md`: all 17 units complete; module ACTIVE/shipped.
- Confirm every §"Note on codebase verification" and every in-spec resolved decision across ac01–ac16 (the ULID-helper check, migration indices, the ac08 deposit leg-direction reconciliation, the ac09 tax-line design, the ac14 entry-date/re-date model, the ac16 closure-permission choice, the credit-limit default) is recorded as resolved — no open flags left dangling.
- Architecture §6 invariants ↔ V-tests cross-reference verified (each invariant has its enforcing test).

### 2.5 Structural decisions

- Pure gate unit — if any V-test, matrix cell, or grep gate is added-but-failing, this unit isn't done; it does not paper over a gap by weakening a gate.
- Property tests (V4/V13) already live beside integration tests (code-standards §7.2) — this unit only audits their presence/health, doesn't move them.

---

## 3. Implementation
### 3.1 `tests/accounts/route-level-matrix.test.ts` — the §2.1 matrix across all six pages + export route + the workflow-rule + dual-permission cross-cuts.
### 3.2 `tests/accounts/verification-audit.test.ts` — the §2.2 V1–V14 presence/naming/health audit.
### 3.3 CI grep gates — the §2.3 static checks wired into the existing lint/CI harness (cm16 mechanism).
### 3.4 Docs — §2.4 progress tracker + invariant↔V cross-reference + resolved-flags confirmation.
### 3.5 Full-suite run — all V1–V14 + matrix + grep gates green end-to-end.

### 3.6 Explicitly NOT in this unit
No feature, schema, UI, permission, or migration. No new invariants (only enforcement of the existing 14). No weakening of any gate to pass.

---

## 4. Dependencies (packages to install)
**None** (unless a grep-gate step needs a lint plugin the repo lacks — reuse cm16's harness; add nothing new if avoidable). Zero runtime packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `tests/accounts/{route-level-matrix,verification-audit}.test.ts`, CI grep-gate config, doc updates. No feature/schema/UI/permission/migration change.
- [ ] No gate weakened; no `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green — full suite.

**The point of the unit**
- [ ] **Route × level matrix** green across all six pages + export route; server-side enforcement independent of nav; `accounts_view`-only user has zero write affordance.
- [ ] **V1–V14** all present, correctly named, passing; each mapped to its invariant.
- [ ] **Grep gates** green: transfer calls only in `post-document`; pgledger only via repositories; money arithmetic only in `money.ts`; no raw `< 0` on balances; no delete functions; no stored balance column; `pgledger:transform` in sync; no AI/gradient tokens.
- [ ] Workflow rules (threshold routing, approver≠creator) and the dual-permission onboarding asserted.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: all 17 units complete, module shipped; every resolved in-spec flag and §"Note" confirmed; invariant↔V cross-reference verified.

**Pipeline**
- [ ] Full CI gate suite green end-to-end (SAST + ZAP DAST baseline; DAST surface unchanged from ac16).

Any failing item means the module isn't done. This is the last unit — a green ac17 is the module's definition-of-done (project-overview §"Success criteria").
