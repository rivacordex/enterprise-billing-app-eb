# AC04 — Customer Onboarding: Atomic FA/BAN/Ledger/Binding Creation on Customer → VALIDATED

- **Unit:** 4 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac03` (catalogs seeded — the wizard reads the seeded default bill cycle + default currency + optional default credit-limit config; `sys.*` accounts exist though onboarding creates only FA/BAN/binding accounts). `ac02` (FA/BAN/ledger_binding tables + repositories; `ledger.repository.pgledgerCreateAccount`). **Customer `cm10`** (`transitionCustomerStatus` / `compareAndUpdateStatus` on `party_role`, the `INITIALIZED → VALIDATED` edge, `CUSTOMER_TRANSITIONS`) — the wizard hooks that exact transition.
- **Authorizing sections:** `acctmgmt-project-overview.md` *Goal 1* (FA + BAN + 3 ledger accounts + 3 bindings in one transaction), *Core user flow* step 1, *Account management* ("Returning customers … explicit re-creation only, no silent duplicates"); `acctmgmt-architecture.md` §2 (**Customer-module touchpoint, locked item 9** — wizard in Customer UI calls `services/accounts/`), §6 Module Inv. #5 (atomic posting/onboarding), #9 (binding completeness — **V2**), #13 (terms freeze — resolved term at creation); `acctmgmt-code-standards.md` §3.4 (wizard is Customer UI calling an Accounts service; Customer never touches `billing.*`), §8 (onboarding needs `accounts_transactions:EDIT` **and** the Customer transition permission, both in the action); decisions **Q2** (wizard on VALIDATED, atomic, returning-customer surface), Q12 (currency read-only MYR), Q13 (cycle from active catalog + default), Q14 (payment-terms override captured beside credit limit), Q15 (three pots: receivables/unapplied_cash/deposits), Q28 (`ref_party_role_id`). Plan §3 story step 1 (the exact one-transaction contents), §4 verification steps **2** (binding integrity) and **7** (atomicity — forced mid-transaction failure leaves zero orphans).
- **Note on codebase verification:** planning-folder-only session. Confirm at implementation time: (a) `cm10`'s `transitionCustomerStatus` transaction seam — whether ac04 wraps it, or calls the onboarding service *inside* the same `db.transaction` (this spec chooses the latter, §2.2; reconcile against cm10's actual signature); (b) the Customer module's VALIDATED-transition UI location and how a wizard step is injected (this spec assumes `cm10`'s `CustomerRoleForm`/`StatusTransitionControl` is where the VALIDATED path opens the wizard); (c) the exact `party_role` id/name columns for the `ref_party_role_id` FK.

---

## 1. Goal

Build `onboard-customer-accounts` — the Accounts service that, in **one DB transaction** with the Customer → `VALIDATED` status change, creates the customer's Financial Account (`FIN…`), first Billing Account (`BAN…`), the three pgledger accounts (`fa.{id}.unapplied_cash`, `fa.{id}.deposits`, `ban.{id}.receivables`), and the three `ledger_binding` rows — driven by a Q2 wizard rendered in the Customer module's VALIDATED transition (currency read-only MYR, bill cycle from the active catalog, credit limits, optional net-terms override) — plus the returning-customer surface that shows prior/closed accounts and forces explicit re-creation. Done when validating a customer produces a working FA+BAN+3 accounts+3 bindings, a forced failure after the FA/BAN insert but before ledger creation rolls back with **zero orphan rows** (V7), and every onboarded customer has exactly one `receivables`, one `unapplied_cash`, and one `deposits` binding with matching currency (V2).

## 2. Design

The only UI is the wizard step injected into the Customer module's existing VALIDATED transition (locked item 9); the account-creation logic is a framework-agnostic Accounts service. Boundary: **`services/accounts/onboard-customer-accounts.ts`, `validation/accounts/onboard-customer-accounts.schema.ts`, `actions/accounts/onboard-customer-accounts.ts`** (or the transition action extended — §2.2), **`app/(app)/customers/**` wizard UI + returning-customer surface**, and the filled-in insert bodies of `financial-account`/`billing-account`/`ledger-binding` repositories + `ledger.repository`. The Customer module UI calls the Accounts service; it **never** imports a `billing.*` repository (code-standards §3.4).

### 2.1 The touchpoint (locked item 9, code-standards §3.4)

The wizard is Customer-module UI. When a MANAGER moves a customer `INITIALIZED → VALIDATED` (cm10's `StatusTransitionControl`), an inline account-setup step opens instead of an immediate save. Confirming it invokes an action that calls `services/accounts/onboard-customer-accounts.ts`. The Accounts service owns the FA/BAN/ledger/binding transaction; the Customer module contributes only the party-role status change. This keeps the schema boundary intact (Customer owns `customer.*`, Accounts owns `billing.*`) while the *transaction* spans both — which is legal because both schemas live in one Postgres (architecture §3).

### 2.2 One transaction spanning status + accounts (Q2, Inv. #5) — how it composes with cm10

Q2 is explicit: "Status change + FA/BAN creation + ledger accounts + bindings commit in one transaction." So the VALIDATED transition and onboarding are **one atomic unit**, not two sequential saves. Design: the onboarding action opens a single `db.transaction(tx => …)` that (1) runs cm10's compare-and-update to set `party_role.status = VALIDATED` (reusing `partyRoleRepository.compareAndUpdateStatus` unchanged — same optimistic-lock semantics, cm10 §2.2), then (2) calls `onboardCustomerAccounts(tx, …)` for the FA/BAN/ledger/binding rows, then (3) writes the audit event(s). Any failure anywhere — a pgledger error, a binding conflict, a stale lock — rolls back **everything**: no VALIDATED status without accounts, no accounts without VALIDATED, no orphan FA/BAN/ledger/binding (V7). The onboarding service takes the `tx` handle (never opens its own connection) so the caller controls the boundary (code-standards §1.2).

**Ordering inside the transaction** (V7's forced-failure point sits between 2b and 2c):
1. `compareAndUpdateStatus(party_role → VALIDATED)` — fails fast on stale lock (`CONFLICT`) or invalid edge (`INVALID_TRANSITION`) before any account work.
2a. Insert `financial_account` (`FIN…`, `ref_party_role_id`, currency, credit limit).
2b. Insert `billing_account` (`BAN…`, `ref_financial_account_id = FIN…`, cycle, terms override, credit limit).
2c. `pgledger_create_account` ×3: `fa.{FIN}.unapplied_cash`, `fa.{FIN}.deposits`, `ban.{BAN}.receivables` (all MYR).
2d. Insert three `ledger_binding` rows mapping each owner+role to its `pgla_…` id.
3. Audit: `ACCOUNTS_ONBOARDED` (+ the customer-status audit cm10 already writes).

### 2.3 The wizard (Q2/Q12/Q13/Q14)

Fields, pre-filled from ac03's seeded config, rendered in the Customer VALIDATED step:
- **Currency** — read-only `MYR` (Q12; from `ACCOUNTS_DEFAULT_CURRENCY`). Shown, not editable.
- **Bill cycle** — select from `bill_cycle` where `state = active` (Q13); default = `ACCOUNTS_DEFAULT_BILL_CYCLE` (`BCY000001`). A `retired` cycle can never be picked (options are active-only; server re-validates, Inv. #11).
- **FA credit limit** and **BAN credit limit** — numeric; pre-filled from `ACCOUNTS_DEFAULT_CREDIT_LIMIT` if set, else blank (the resolved-in-ac03 "manual per-customer, pre-filled from optional default" decision).
- **Payment-terms override** (Q14) — optional integer net-days on the BAN (`payment_due_days_override`); blank = use cycle default. Captured beside credit limit per Q14; **resolved term = coalesce(override, cycle.payment_due_days)** is computed at read time by a shared `resolveTerm()` helper (defined here, reused by the overdue derivation in ac05) — the override is *stored*, the resolution is *derived* (Inv. #13).
- **rating_type** — `postpaid` only (Q23); not offered as a choice.

Confirmation shows the created ledger account names (plan §3 F1 — "making the underlay visible builds operator trust").

### 2.4 Returning-customer surface (Q2)

A returning customer is a **new `party_role`** for an organization that previously had accounts (possibly closed). Q2: they "see prior/closed accounts and must explicitly create new ones — no silent duplicates." Design: before opening the wizard, the transition step queries `account_view`/`financial_account` for any FA whose `ref_party_role_id` belongs to the same organization (via the Customer module's org→role relationship). If prior accounts exist, the wizard shows them (id, state, created date) and requires an explicit "Create new accounts" confirmation — it never auto-reuses or auto-duplicates. There is no "reactivate closed account" path in this unit (closure is terminal, ac16); re-creation always makes fresh `FIN…`/`BAN…` ids.

### 2.5 The three ledger accounts + bindings (Q15, Inv. #9, V2)

Exactly three pgledger accounts per onboarded customer, exactly three bindings:
| binding.owner_type | owner_id | ledger_role | pgledger name |
|---|---|---|---|
| financial_account | `FIN…` | `unapplied_cash` | `fa.{FIN}.unapplied_cash` |
| financial_account | `FIN…` | `deposits` | `fa.{FIN}.deposits` |
| billing_account | `BAN…` | `receivables` | `ban.{BAN}.receivables` |

All MYR; **binding currency = owner currency = pgledger account currency** (Inv. #9) — the service passes one `currency` through all three creates and both inserts; V2 asserts they match. The `ledger_binding` triple-UNIQUE (ac02) guarantees *at most one* per role; V2's integration test guarantees *existence* of all three (the cross-table check a constraint can't express). `allow_negative_balance` stays default `true` for `unapplied_cash` and `deposits` (they hold credit/liability balances); `receivables` also default-true (a credit balance = customer overpaid). No account is created with `allow_negative_balance => false` in this unit.

### 2.6 Permissions (dual check, code-standards §8)

The onboarding action checks **both** `accounts_transactions : EDIT` (creating money accounts) **and** the Customer module's own VALIDATED-transition permission — both server-side, independent of which UI rendered the wizard. Neither alone suffices. (This is the one action that spans two modules' permissions; ac17's authz sweep records it explicitly.)

### 2.7 Structural decisions

- **`onboardCustomerAccounts(tx, input)` returns `Result`** (code-standards §2.4), never throws — codes `CONFLICT` (stale party-role lock), `INVALID_TRANSITION` (not on the VALIDATED edge), `CYCLE_RETIRED` (picked cycle no longer active), plus a generic ledger-failure surfaced as rollback. The wizard maps each to a field/banner.
- **No auto-BAN-count**: the wizard creates exactly one BAN (the "Master Billing Account"); adding more BANs later is out of this unit (a future "Add Billing Account" flow — plan F1; not in ac00's list, so deferred).
- **`resolveTerm()` lives in `services/accounts/term-resolution.ts`** (architecture §2 names it) — created here, the single source for `coalesce(override, cycle default)`, reused by every read-time overdue derivation (ac05+) and the future Invoicing stamping (Inv. #13). Pure function, unit-tested here (V10's resolution half is testable now — ac15 owns the full V10).

---

## 3. Implementation

### 3.1 `services/accounts/onboard-customer-accounts.ts` (new)
`onboardCustomerAccounts(tx, { partyRoleId, currency, billCycleId, faCreditLimit, banCreditLimit, paymentDueDaysOverride }, actorId): Promise<Result<{ financialAccountId, billingAccountId, ledgerAccountNames }, 'CYCLE_RETIRED' | …>>`. Validates the cycle is `active` (else `CYCLE_RETIRED`), performs §2.2 steps 2a–2d using the ac02 repositories + `ledger.repository`, returns the created ids/names. Takes `tx`; opens no connection. `services/accounts/term-resolution.ts` `resolveTerm(override, cycleDefault)` (§2.7).

### 3.2 `validation/accounts/onboard-customer-accounts.schema.ts` (new)
Zod: `partyRoleId` (PTRL pattern), `billCycleId` (BCY pattern), `currency` (fixed `MYR` literal for now), `faCreditLimit`/`banCreditLimit` (money strings — validated via the money schema; note `money.ts` arrives in ac07, so this unit validates format with a decimal-string regex and defers arithmetic), `paymentDueDaysOverride` (positive int, optional). Merged with cm10's `optimisticLockSchema` (the party-role `last_modified`).

### 3.3 Action — `actions/accounts/onboard-customer-accounts.ts` (new)
Dual permission check (§2.6). Opens the single `db.transaction`: cm10 `compareAndUpdateStatus(VALIDATED)` → `onboardCustomerAccounts(tx, …)` → audit. Maps `Result` codes to the wizard. This is the seam cm10's VALIDATED path calls (§"Note" (a) — reconcile whether it *extends* cm10's transition action or is a distinct action the wizard calls; prefer distinct, so cm10's plain non-VALIDATED transitions are untouched).

### 3.4 Wizard UI — `app/(app)/customers/**` (extend)
Inject the account-setup step into cm10's VALIDATED transition (§"Note" (b)): fields per §2.3, active-cycle options, confirmation screen showing created ledger names. On non-VALIDATED transitions, cm10's control is unchanged.

### 3.5 Returning-customer surface — `app/(app)/customers/**` (extend)
Per §2.4: query prior accounts for the org, render read-only list with explicit "Create new accounts" gate. A small `account-view.repository` reader (ac02) backs it — Customer UI calls the *service/action*, not the repo directly (code-standards §3.4); expose a thin `listPriorAccountsForParty` service if needed.

### 3.6 Repository bodies filled
`financial-account.repository.insert`, `billing-account.repository.insert`, `ledger-binding.repository.insert`, and `ledger.repository.pgledgerCreateAccount` bodies (ac02 shipped skeletons). All take `tx`.

### 3.7 Guardrail tests — **V2** + **V7**
- `tests/accounts/v02-binding-integrity.integration.test.ts`: onboard a customer → exactly one `receivables` (BAN), one `unapplied_cash` (FA), one `deposits` (FA) binding; all three pgledger accounts MYR; binding currency = owner currency = ledger currency. Attempting onboarding twice for the same party role does not silently duplicate (returning-customer gate).
- `tests/accounts/v07-onboarding-atomicity.integration.test.ts`: force a failure after the FA/BAN insert but before/at `pgledger_create_account` (inject via a repository stub or a deliberate constraint violation) → assert full rollback: no `financial_account`, no `billing_account`, no pgledger account, no binding, **and** `party_role.status` still `INITIALIZED` (the status change rolls back too, §2.2).
- `tests/services/onboard-customer-accounts.service.test.ts`: `CYCLE_RETIRED` when a retired cycle is passed; `resolveTerm(45, 30) = 45`, `resolveTerm(null, 30) = 30` (§2.7).
- Component test: VALIDATED transition opens the wizard; non-VALIDATED does not; returning customer sees prior accounts and requires explicit confirmation.
- V1 zero-sum re-asserted after onboarding (workflow rules §5) — onboarding creates accounts at 0 balance, so `Σ = 0` holds trivially.

### 3.8 Explicitly NOT in this unit
No money movement (no transfers — onboarding creates accounts at zero; PAY/DEP/etc. are ac07+). No Accounts pages/nav/`accounts_view` permission (**ac05**). No `money.ts` (ac07 — this unit validates money *format* only, no arithmetic). No "Add Billing Account" (extra BANs) flow. No account closure/reactivation (ac16). No overdue badge rendering (ac05 consumes `resolveTerm`). No Accounts Settings editing of the defaults (ac15).

---

## 4. Dependencies (packages to install)
**None.** Reuses ac02/ac03 repositories, cm10's transition primitives, and existing Zod/Drizzle tooling. Zero new npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `services/accounts/onboard-customer-accounts.ts` + `term-resolution.ts`, `validation/accounts/onboard-customer-accounts.schema.ts`, `actions/accounts/onboard-customer-accounts.ts`, the Customer wizard + returning-customer UI edits, filled repository insert bodies, the new tests. No Accounts page/nav/permission yet.
- [ ] Customer UI imports no `billing.*` repository (code-standards §3.4) — only the Accounts service/action.
- [ ] No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green; only deliberate cm10-integration assertions change.

**Behavior — the point of the unit**
- [ ] Validating a customer creates FA + BAN + 3 pgledger accounts + 3 bindings, all MYR; confirmation shows the ledger account names.
- [ ] **V7:** forced failure mid-transaction rolls back everything — no orphan FA/BAN/ledger/binding, `party_role.status` reverts to `INITIALIZED`.
- [ ] **V2:** exactly one binding per role per onboarded customer; currencies match across owner/binding/ledger.
- [ ] Returning customer sees prior/closed accounts and must explicitly create new ones — no silent duplicate.
- [ ] A retired bill cycle cannot be selected (options) and is rejected server-side (`CYCLE_RETIRED`).
- [ ] `resolveTerm` returns override when set, cycle default when null.
- [ ] Action rejects a caller lacking either `accounts_transactions:EDIT` or the Customer transition permission.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac04` complete, "Next Up" → `ac05`; §"Note" reconciliations (cm10 seam, wizard injection point, party_role columns) recorded.

**Pipeline**
- [ ] CI green (SAST; DAST — no new routes, wizard is within existing Customer routes).

Any failing item means the unit isn't done. `ac05` (Accounts nav + Overview) must not start until this is merged — Overview browses the real FA/BAN this wizard creates and shows their live balances.
