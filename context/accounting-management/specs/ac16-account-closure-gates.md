# AC16 — Account Closure Gates: Zero-Balance BAN/FA Closure, Guided Settle-First Path, Customer CLOSED Block

- **Unit:** 16 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac08` (deposit reverse/refund — steps of the settle-first path). `ac10` (write-off — the residue step). `ac11` (reversal — correction step). `ac07` (allocation — the apply step; live balances). `ac04`/`ac02` (FA/BAN `state` columns, bindings, balances). **Customer `cm10`** (the `→ CLOSED` transition this unit gates).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Account management* ("Zero-balance-gated closure with guided settle-first path"), *Core user flow* step 8; `acctmgmt-architecture.md` §6 Module Inv. **#12** (closure requires zero; closure is the final ledger event — **V14** closure half); `acctmgmt-code-standards.md` §2.4 (`CLOSURE_BLOCKED`), §1.5 (balances read live in the closing service, never trusted input), §1.3 (accounts transition to `closed`, zero-balance gated — never hard-deleted); decision **Q11** (BAN closes at A/R = 0; FA closes at unapplied = 0, deposits = 0, all BANs closed; Customer → CLOSED blocked while accounts open; guided settle-first path: apply deposit → refund remainder → write off residue; closure is the last ledger event). Plan §4 verification step **14** (lifecycle ends deposits = 0, unapplied = 0, **Q11 closure eligibility true**).
- **Note on codebase verification:** planning-folder-only session. Confirm cm10's `→ CLOSED` transition seam so ac16 can inject the open-accounts gate (mirror ac04's VALIDATED touchpoint — the Customer transition calls an Accounts service).

---

## 1. Goal

Add BAN and FA closure gated on zero balances (Q11): **close-BAN** requires A/R = 0; **close-FA** requires unapplied = 0, deposits = 0, and all its BANs closed — each reading balances live and setting `state = closed` as the account's final ledger event. Add the **guided settle-first path** that walks an operator from live balances to zero using the existing operations (reverse deposit → allocate → refund remainder → write off residue), and **block the Customer → CLOSED transition** while any of the customer's accounts remain open. Done when an account can be walked from balances to closed, a closure attempt with non-zero balances is blocked (`CLOSURE_BLOCKED`) with the guided remedy, and no ledger event can occur on a closed account.

## 2. Design

The lifecycle's terminal chapter — it composes ac07–ac11 operations behind gates, adding no new posting mechanism. Boundary: **`services/accounts/{close-billing-account,close-financial-account,closure-eligibility}.ts`, `validation/accounts/close-account.schema.ts`, `actions/accounts/{close-billing-account,close-financial-account}.ts`, the closure UI + guided settle-first wizard on Accounts Overview (or a closure panel), and the Customer → CLOSED gate touchpoint**. No schema change (ac02's `state` columns), no new permission (`accounts_transactions:EDIT` to close — closing moves money-account state; confirm vs `accounts_config` — this spec uses `accounts_transactions:EDIT` since closure is an operational, not config, act; flag if Khek prefers config).

### 2.1 Zero-balance gates (Q11, Inv. #12, code-standards §1.5)

- **close-BAN:** read the BAN's `receivables` balance live; if ≠ 0 → `CLOSURE_BLOCKED` (with the open A/R figure + guided remedy). If 0 → `billing_account.state = closed`.
- **close-FA:** read the FA's `unapplied_cash` and `deposits` balances live **and** verify every BAN under it is `closed`; any non-zero or any open BAN → `CLOSURE_BLOCKED`. If all clear → `financial_account.state = closed`.
- Balances are **always read live inside the closing service** (Inv. #2, code-standards §1.5) — a balance in the action payload is display data, never the gate input. The gate can't be spoofed by a stale client figure.

### 2.2 Closure is the final ledger event (Q11, Inv. #12)

A `closed` account rejects all new postings — every operation service (ac07–ac11) checks owner `state` and refuses to post against a `closed` FA/BAN (`DOC_STATE_INVALID`/`ACCOUNT_CLOSED`). So closure is genuinely the last event on the ledger; nothing moves afterward. (Reactivation is out of scope — closure is terminal, matching ac04's "no reactivation" note.)

### 2.3 Guided settle-first path (Q11)

When closure is blocked, the UI offers a **guided path** assembling existing operations to drive balances to zero, in order:
1. **Reverse deposit** (ac08 `DEP_REVERSE`) — release held deposit into unapplied.
2. **Allocate** (ac07 allocation) — apply unapplied against open A/R.
3. **Refund remainder** (ac08 `DEP_REFUND`) — pay out any unapplied left.
4. **Write off residue** (ac10 `BAD_DEBT_WRITEOFF`) — clear any tiny uncollectable A/R remainder.
Each step is the real operation (with its own approval routing — reverse/refund/write-off are all four-eyes), not a shortcut; the wizard just sequences them and re-checks eligibility after each, surfacing which gate still blocks. This is exactly the V14 lifecycle (ac08) ending at Q11 eligibility — ac16 turns that end-state into an actual closure.

### 2.4 Customer → CLOSED block (Q11 — touchpoint)

The Customer module's `→ CLOSED` transition (cm10) is **blocked while any of the customer's accounts (FA or any BAN) remain open**. Like ac04's VALIDATED wizard, this is a Customer-UI touchpoint calling an Accounts service (`closure-eligibility.customerHasOpenAccounts(partyRoleId)`); the Customer transition action checks it and refuses with a message pointing to the open accounts + the guided path. The Accounts service owns the check; Customer never queries `billing.*` directly (code-standards §3.4).

### 2.5 Structural decisions

- `closure-eligibility.ts` centralizes the three checks (BAN, FA, customer) so the gate is defined once and reused by the close actions, the guided wizard's re-checks, and the Customer touchpoint.
- Closure sets `state = closed` and audits `ACCOUNT_CLOSED`; no ledger transfer is posted by closure itself (it's a state change after the last real transfer) — but it is only permitted at zero, so the ledger is genuinely settled.
- No delete anywhere (Inv. #11/§1.3) — closed is a state, rows persist.

---

## 3. Implementation
### 3.1 `services/accounts/closure-eligibility.ts` — `canCloseBillingAccount`, `canCloseFinancialAccount`, `customerHasOpenAccounts`; all read live balances/states.
### 3.2 `services/accounts/{close-billing-account,close-financial-account}.ts` — gate + `state = closed` + audit.
### 3.3 Operation guards — extend ac07–ac11 services to reject posting against a `closed` FA/BAN (`ACCOUNT_CLOSED`).
### 3.4 Validation/actions — `close-account.schema.ts`; `close-billing-account`/`close-financial-account` actions (`accounts_transactions:EDIT`; §2 flag).
### 3.5 UI — closure panel + guided settle-first wizard (§2.3) on Accounts Overview; re-check eligibility after each step.
### 3.6 Customer touchpoint — inject the open-accounts gate into cm10's `→ CLOSED` path (§2.4).
### 3.7 Guardrail tests — closure integration: close-BAN blocked at A/R ≠ 0, succeeds at 0; close-FA blocked while unapplied/deposits ≠ 0 or any BAN open, succeeds when all clear; **the guided path** (reverse → allocate → refund → write off) drives an account from balances to closed (extends V14 to actual closure); a posting against a closed FA/BAN rejected (`ACCOUNT_CLOSED`); Customer → CLOSED blocked while accounts open, allowed once all closed. V1 zero-sum preserved throughout.

### 3.8 Explicitly NOT in this unit
No reactivation/reopening of a closed account. No new operations (closure composes ac07–ac11). No new ledger accounts. No period logic (ac14). No settings (ac15). The final CI/guardrail sweep is ac17.

---

## 4. Dependencies (packages to install)
**None.** Composes existing operations + state changes. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `closure-eligibility`/`close-billing-account`/`close-financial-account` services, `close-account` schema + two actions, closed-account guards in ac07–ac11 services, closure UI + guided wizard, Customer → CLOSED gate, tests. No schema/migration/permission change.
- [ ] No delete path; balances read live in the gate; no `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] close-BAN gated on A/R = 0; close-FA gated on unapplied = 0, deposits = 0, all BANs closed — live-read, `CLOSURE_BLOCKED` otherwise.
- [ ] Guided settle-first path walks an account from balances to closed (reverse → allocate → refund → write off).
- [ ] A closed FA/BAN rejects all new postings (`ACCOUNT_CLOSED`) — closure is the last ledger event.
- [ ] Customer → CLOSED blocked while any account open; allowed once all closed.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac16` complete, "Next Up" → `ac17`; the closure-permission choice (§2) recorded/confirmed.

**Pipeline**
- [ ] CI green incl. SAST + DAST.

Any failing item means the unit isn't done. `ac17` (guardrail & authz sweep) is the final gate — the full route × level matrix, V1–V14 completeness audit, and grep gates across everything ac01–ac16 built.
