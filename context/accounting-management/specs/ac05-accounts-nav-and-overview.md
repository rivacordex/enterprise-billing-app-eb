# AC05 — Accounts Nav + Accounts Overview: Search, FA/BAN Detail, Live Balances, URL Context Strip

- **Unit:** 5 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac04` (real FA/BAN + bindings exist to browse; `resolveTerm` for the overdue badge). `ac02` (`account_view`, FA/BAN repositories, `ledger.repository` reads `pgledger_accounts_view`). `ac03` (nothing to seed, but sys accounts exist). Reuses the platform's `NAV_SECTIONS`, the `system_config` repository (`findActiveValue`, from `um28`/`cm01` precedent) for the 5-row search limit, and the platform route-guard.
- **Authorizing sections:** `acctmgmt-project-overview.md` *Pages & access* ("Accounts (left nav): Accounts Overview …", "Persistent selection context strip"), *Core user flow* step 2; `acctmgmt-architecture.md` §2 (`app/(app)/accounts/**` ownership — "Selection-context strip is URL-driven state shared by the first three"), §4 (`accounts-view` grants Accounts Overview + read-only everywhere); `acctmgmt-code-standards.md` §3.1 (context strip is **URL state** `?party=&fa=&ban=`, one `parseAccountsContext` parser), §3.2 (all Accounts pages `force-dynamic`), §4.1 (`amount-cell`, `payment-status-badge`, `context-strip` shared components), §8 (permission map — `accounts_view : READ`); `acctmgmt-ui-context.md` §1.1 (context-strip tokens), §2 (payment-status + derived-overdue mapping), §3 (mono ids, `tabular-nums` amounts); **Locked UI direction items 2 & 5** (3-section Overview; selection-context rule); decisions Q3 (Creditor/Debtor = customers), Q8 (overdue derived at read time), Q12 (MYR). Plan Part B P1/P2 (consolidated into Overview per locked item 2), §4 verification step **3** (API/UI balance = ledger balance — the read half testable here).
- **Note on codebase verification:** planning-folder-only session. Confirm: (a) `NAV_SECTIONS` shape and how a section+icon is added (this spec assumes the same structure `cm03`/Product used, icon lucide `Landmark`); (b) the permission-migration + registry-wiring pattern (`accounts_view` → typed constant, role grants MANAGER/USER : READ — mirror `cm01`'s seed grants); (c) the `system_config` search-limit key name convention (this spec uses `ACCOUNTS_SEARCH_RESULT_LIMIT = 5`).

---

## 1. Goal

Add the **Accounts** left-nav section and its first page `/accounts/overview` — a three-section screen (search by Creditor/Debtor with a `system_config`-driven 5-row limit; selected Financial Account detail with live receivable/unapplied/deposit balances and credit-limit utilisation; selected Billing Account detail with live A/R, `payment_status` + derived-overdue badge) — introduce the **URL-driven context strip** (`?party=&fa=&ban=`) as its first consumer, and land the `accounts_view` permission migration with route × level tests. Done when a `accounts_view:READ` holder can search a validated customer, select FA + BAN, and see balances that equal `pgledger_accounts_view` (V3 read half), with the selection persisted in the URL and every write affordance absent.

## 2. Design

First Accounts page; establishes the shared chrome (context strip, amount cell, badges) the next two pages reuse. Boundary: **`app/(app)/accounts/overview/**`, `components/accounts/{context-strip,amount-cell,payment-status-badge}.tsx`, `validation/accounts/parse-accounts-context.ts`, `services/accounts/` read use-cases (search, FA/BAN detail with balances), `db/repositories/accounts/` read bodies, the `accounts_view` permission migration + registry wiring, `NAV_SECTIONS`**. No transaction/write path.

### 2.1 Nav + routing (locked item 2)

`NAV_SECTIONS` gains an **Accounts** section (icon `Landmark`), peer of Products/Customers/Administration, with the Overview entry (Ledger Explorer/Transactions/CoA/GL Journal entries are added by their own units — ac06/ac07/ac12/ac13 — each appends its route; ac05 adds the section shell + Overview only). Page is `force-dynamic` (code-standards §3.2 — balances are live). Route declares `accounts_view : READ`.

### 2.2 The URL context strip — first consumer (code-standards §3.1, locked item 5)

Selection is **URL state**, never React context / localStorage / cookie: `?party=PTRL…&fa=FIN…&ban=BAN…`. A single `parseAccountsContext(searchParams)` helper in `validation/accounts/` is the only parser (shared with ac06/ac07). `components/accounts/context-strip.tsx` renders the persistent party/FA/BAN header (tokens per ui-context §1.1: `--acct-context-strip-bg`, mono ids). A pasted URL reproduces the exact working context. On Overview, selecting a search result sets `?party&fa`, selecting a BAN adds `&ban` — via `router.push` with updated `searchParams`, not local state. The strip shows "no selection" affordances greyed where a field is absent (ac07's Transactions will *disable actions* on the same rule; Overview just reflects state).

### 2.3 Section 1 — search (locked item 2, Q3)

Creditor/Debtor search over **customer party roles that have accounts** (Q3 — customers only; "creditor/debtor" acknowledges a customer can be in credit or debt). A condition toggle switches CUSTOMER (party role) vs NAME. Result limit is **5 rows**, read from `system_config` (`ACCOUNTS_SEARCH_RESULT_LIMIT`) via `systemConfigRepository.findActiveValue` — same mechanism and refine-hint UX as Customer search (`cm01`/`cm04`). Results list party name + `FIN…` + currency + state; selecting one sets `?party&fa` and populates section 2.

### 2.4 Section 2 — FA detail + live balances (Inv. #2)

Selected FA's base fields (name, state, related party via `account_view`'s composed `relatedParty[]`, finance PIC `CTMD…` refs, credit limit) plus **live balances, never stored** (Inv. #2), all from `pgledger_accounts_view` via `ledger_binding`:
- **Receivable balance** = Σ A/R across the FA's BANs' `receivables` accounts.
- **Unapplied cash** = the FA's `unapplied_cash` account balance (rendered via the signed-convention helper `openReceivable`/`isHeldLiability`, code-standards §2.3 — never a raw `< 0` in the component).
- **Deposit held** = the FA's `deposits` account balance.
- **Credit-limit utilisation** = receivable balance vs `credit_limit_amount` (computed in the service; the component receives display values).

All amounts via `components/accounts/amount-cell.tsx` (right-aligned, `tabular-nums`, 2dp, parentheses for negative, currency from the row — ui-context §3, code-standards §4.1).

### 2.5 Section 3 — BAN detail + payment status + derived overdue (Q8)

Selected BAN's subtype/base fields + **live A/R** (its `receivables` balance) + the bill cycle catalog name (via `ref_bill_cycle_id`) + `payment_status` badge. **Overdue is derived at read time** (Q8, Inv. #2), never stored: the service computes `derivedOverdue = openAR > 0 && now > event_at_of_open_charges + resolveTerm(override, cycleDefault)` and passes it as a prop to `payment-status-badge.tsx`, which renders the stored status **plus** the derived-overdue flag — the component never computes overdue (code-standards §4.1, ui-context §2). Until Invoicing stamps due dates, the derivation uses open-A/R charge dates + resolved term (Q8/Q14); the badge maps to the Danger family when overdue (ui-context §2).

### 2.6 Permission migration + route × level (code-standards §8)

`accounts_view` permission: migration INSERT into `core.permissions` + typed constant wiring (`PERMISSION_NAMES`, `PERMISSIONS.ACCOUNTS_VIEW`, roles display map) — mirror `cm01` §3.4. Seed grants: `MANAGER → accounts_view:EDIT`? No — `accounts_view` is read-only (grants read everywhere); grant **`MANAGER → accounts_view:READ`** and **`USER → accounts_view:READ`** (both RevOps read). No DELETE, no EDIT for this permission (EDIT lives on `accounts_transactions`/`accounts_config`). Route × level tests assert `/accounts/overview` requires `accounts_view:READ` and renders with **no write affordance** (this is the "trace a transaction without any write affordance visible" success criterion, project-overview §6).

### 2.7 Structural decisions

- **Read services, not raw queries in the page** (architecture §2 — pages contain no DB queries): `services/accounts/search-accounts.ts`, `get-financial-account-detail.ts`, `get-billing-account-detail.ts`, each composing repository reads + the balance/utilisation/overdue derivations. Pages are thin orchestrators.
- **`ledger.repository` read methods** (`balanceByLedgerAccountId`, `sumReceivablesForFinancialAccount`) are the only pgledger view callers (code-standards §6.3) — filled here (ac02 shipped skeletons).
- **No AI tokens, no marketing gradients** (ui-context §5) — dense admin chrome only.

---

## 3. Implementation

### 3.1 `NAV_SECTIONS` + route shell
Add Accounts section (icon `Landmark`) + Overview entry; `/accounts/overview/page.tsx` `force-dynamic`, guarded `accounts_view:READ`, thin orchestrator.

### 3.2 `validation/accounts/parse-accounts-context.ts` (new)
`parseAccountsContext(searchParams) → { party?: string; fa?: string; ban?: string }` with id-pattern validation; the sole context parser (code-standards §3.1).

### 3.3 `components/accounts/{context-strip,amount-cell,payment-status-badge}.tsx` (new)
Per ui-context §1.1/§2/§3 + code-standards §4.1. `payment-status-badge` takes `derivedOverdue: boolean` prop and never computes it.

### 3.4 Services + repository read bodies
`search-accounts.ts` (5-row limit via `system_config`), `get-financial-account-detail.ts` (balances/utilisation), `get-billing-account-detail.ts` (A/R + `derivedOverdue` via `resolveTerm`). Fill `ledger.repository` read methods + FA/BAN detail readers.

### 3.5 Permission migration + wiring
`accounts_view` migration + typed constants + seed grants (MANAGER/USER : READ), per §2.6.

### 3.6 Guardrail tests
- **Route × level:** `/accounts/overview` requires `accounts_view:READ`; a holder sees no write affordance; a non-holder is blocked (matrix seed for ac17's full sweep).
- **V3 (read half):** UI/service balances equal `pgledger_accounts_view` for a bound A/R account and the FA receivable sum — integration test on an ac04-onboarded + fixture-charged customer (charges inserted via test setup or a fixture transfer, since posting is ac07; use a direct `pgledger_create_transfer` in test setup to create a non-zero balance).
- **Overdue derivation:** unit test on the service — `openAR>0 && past term ⇒ derivedOverdue true`; within term ⇒ false; `openAR=0 ⇒ false`.
- **Search:** 5-row limit honored; refine hint shows at cap; CUSTOMER vs NAME toggle.
- **Context strip:** selecting a result updates `?party&fa`; selecting a BAN adds `&ban`; a pasted URL rehydrates the selection.

### 3.7 Explicitly NOT in this unit
No writes/transactions (ac07+). No Ledger Explorer/Transactions pages (ac06/ac07 — they append nav entries + reuse the context strip/components built here). No `accounts_transactions`/`accounts_config` permissions. No stored overdue flag or scheduler (Q8). No CoA/GL pages. The balance-check (zero-sum) strip is **ac06**'s (Ledger Explorer), not Overview's.

---

## 4. Dependencies (packages to install)
**None.** Reuses platform nav/guard/`system_config`, ac02–ac04 repositories/services, lucide (already present). Zero new npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `NAV_SECTIONS` Accounts entry, `app/(app)/accounts/overview/**`, `components/accounts/{context-strip,amount-cell,payment-status-badge}.tsx`, `validation/accounts/parse-accounts-context.ts`, the three read services + filled read repositories, `accounts_view` migration + typed-constant wiring + seed grants, the new tests. No write/action path.
- [ ] Page is `force-dynamic`; component uses signed-balance helpers, never a raw `< 0`; no `--ai-*`/gradient tokens. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green; permission-count assertions move by exactly one (new permission).

**Behavior — the point of the unit**
- [ ] `accounts_view:READ` holder searches (5-row limit), selects FA+BAN, sees live balances = `pgledger_accounts_view` (**V3** read half), overdue badge derived (never stored).
- [ ] Context persists in `?party&fa&ban`; pasted URL rehydrates; no write affordance anywhere.
- [ ] Route × level: page requires `accounts_view:READ`; non-holder blocked.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac05` complete, "Next Up" → `ac06`; §"Note" confirmations recorded.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (new `/accounts/overview` route in DAST surface).

Any failing item means the unit isn't done. `ac06` (Ledger Explorer) reuses this unit's context strip, amount cell, and `ledger.repository` reads, and adds the permanent zero-sum strip.
