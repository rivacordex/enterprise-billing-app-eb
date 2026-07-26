# AC03 — Seed Set + GL Health: sys Ledger Accounts, Chart of Accounts, GL Mappings, Reason Codes, Bill Cycles

- **Unit:** 3 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac02` (all 10 tables + the three views exist; `ledger.repository.ts` wraps `pgledger_create_account`; `gl_resolution_view` is the thing this unit's test proves is total). `ac01` transitively (the `sys.*` accounts are real `billing.pgledger` accounts). `core.appuser` for the seed-write provenance convention (nullable `last_edited_by`).
- **Authorizing sections:** `acctmgmt-project-overview.md` *In scope* ("Seeds: sys ledger accounts, CoA, GL mappings, reason codes, bill cycles"), *Ledger & GL* ("Sys accounts per posting nature", "unmapped-account health check"); `acctmgmt-architecture.md` §3 (naming `sys.{nature}.{ccy}`), §6 Module Inv. #10 (GL resolution total, 0 unmapped before export — **V5**), #11 (catalogs retire never delete); `acctmgmt-code-standards.md` §1.6 (seeds gated like code — 0 unmapped, seed test asserts it), §6.2 (natural keys), §7 (`db/seeds/accounts/`); decisions **Q19** (posting nature → sys account), **Q20** (`auto_post_limit`; sensitive natures seed limit 0), Q12 (single MYR `sys.*` family), Q13 (bill-cycle catalog seeded + default), Q26 (CoA mastered here). Plan Part A §2 (the exact seed rows: bill_cycle, reason_code, gl_account, gl_mapping, and the `sys.*`/GL correspondences), §4 verification step 5 (**V5** — 0 unmapped after seeding *and* after onboarding a new BAN/FA).
- **Note on codebase verification:** planning-folder-only session. Confirm at implementation time: the live `db:setup`/seed-composite script name and ordering (this spec assumes a `db:seed-accounts` script run after `db:migrate`, mirroring `cm01`'s `db:seed-customer`); and the acting-user convention for seed writes (`last_edited_by = NULL`, per `cm01`/Product precedent).

---

## 1. Goal

Ship one idempotent seed script (`db/seeds/accounts/`) that creates, in one transaction: the six `sys.*` pgledger accounts for MYR (one per posting nature that needs a counter-account plus cash/tax — Q19), the Chart of Accounts (`gl_account` rows), the role- and system-account GL mapping rules (`gl_mapping`), the reason-code catalog with per-code `auto_post_limit` and posting nature (Q19/Q20), and the bill-cycle catalog with a designated default (Q13) — such that `gl_resolution_view` resolves **every** pgledger account (the six `sys.*` now, and every future `ban.*`/`fa.*` by role rule) to exactly one `is_postable` GL code. Done when the seed runs idempotently onto an ac02 database and the V5 seed test asserts **0 unmapped accounts** both immediately after seeding and after inserting a fixture BAN/FA with its three bindings.

## 2. Design

No UI. "Design" is the seed content and the health guarantee. Boundary: **`db/seeds/accounts/**` + `package.json` (script + `db:setup` wiring) + the V5 test** — reusing `ac02`'s `ledger.repository.ts` (for `pgledger_create_account`) and the catalog repositories' insert seams. No schema change, no migration (this unit inserts rows into ac02's tables; it never alters them). No services/actions/pages.

### 2.1 The seed is gated like code (code-standards §1.6, Inv. #10)

The whole point of ac03 is that after it runs, the GL health check is **0 unmapped** — a single unmapped internal account silently corrupts the eventual journal export (ac14). So the seed set and the V5 test ship together, and the test asserts the invariant on both the seeded `sys.*` accounts and a freshly-onboarded fixture BAN/FA (proving the *role-based* mapping rules — not per-account rows — cover accounts that don't exist yet). This is the module's first proof that "onboarding 1,000 BANs adds zero mapping rows" (plan §1.3).

### 2.2 sys accounts — one pgledger account per posting nature that needs a counter-account (Q19)

Created via `pgledger_create_account(name, 'MYR')` (default `allow_negative_balance = true`, so credit-normal sys accounts go negative freely — ac01 §2.4). Names follow `sys.{nature}.{ccy}` (architecture §3). Six for MYR:

| pgledger name | Purpose (Q19) |
|---|---|
| `sys.cash.MYR` | settlement/bank clearing — all payment modes (Q22) |
| `sys.revenue.MYR` | recognised revenue (DBN charges) |
| `sys.revenue_adj.MYR` | goodwill CRN/DBN adjustments |
| `sys.write_off.MYR` | bad-debt write-offs |
| `sys.rounding.MYR` | rounding/small-balance residue |
| `sys.tax_payable.MYR` | tax collected, owed to authority |
| *(deposit movement uses no dedicated sys account)* | deposit legs move between `sys.cash` and the FA `deposits`/`unapplied_cash` accounts (Q16) — `deposit_movement` nature steers to `sys.cash`, not a separate sys account |

**sys accounts get no `ledger_binding` row** (architecture §3 — bindings are for TMF-owned FA/BAN accounts; sys accounts are referenced by name). Their GL resolution is by the `system_account` mapping selector (§2.4), not a binding role. The seed records the returned `pgla_…` ids only as needed for the `gl_mapping.selector = 'sys.revenue.MYR'` name references (the selector is the *name*, not the id — so mappings are stable across environments where ULIDs differ).

> **`deposit_movement` clarification (resolved in-spec, recorded here not silently):** the POSTING_NATURES union (code-standards §2.1) includes `deposit_movement`, but Q16's deposit legs are `deposits ↔ sys.cash` and `deposits ↔ unapplied_cash` — none needs a `sys.deposit_movement` account. So this unit seeds **no** `sys.deposit_movement` account; the nature exists to *label* deposit reason codes and steer their cash leg to `sys.cash`. If a later finance requirement wants deposit movements in their own GL line, add a `sys.deposit_movement.MYR` account + mapping then — additive, no migration. Flagged for ac08 (deposit ops) so it steers to `sys.cash`, matching the sample story (`deposits → sys.cash`).

### 2.3 Chart of Accounts (`gl_account`) — Q26, plan §2

Seed the CoA exactly as plan §2 (minimal set covering every scenario), summary nodes `is_postable = false`, leaves `true`:

`1000` Current Assets (summary) · `1050` Cash Clearing · `1200` Accounts Receivable · `2000` Current Liabilities (summary) · `2200` SST Payable · `2300` Unapplied Customer Receipts · `2400` Customer Deposits · `4000` Service Revenue · `4090` Revenue Adjustments · `6100` Bad Debt Expense · `6900` Rounding Differences. Each with `account_class`, `normal_balance` (debit for assets/expenses, credit for liabilities/revenue), `parent_gl_code`, `state = active`.

### 2.4 GL mappings (`gl_mapping`) — role rules + system-account rules (plan §2)

Nine rows; **role selectors have `currency = NULL`** (all currencies), **system-account selectors carry `MYR`**:

| selector_type | selector | currency | ref_gl_code |
|---|---|---|---|
| ledger_role | `receivables` | — | 1200 |
| ledger_role | `unapplied_cash` | — | 2300 |
| ledger_role | `deposits` | — | 2400 |
| system_account | `sys.revenue.MYR` | MYR | 4000 |
| system_account | `sys.revenue_adj.MYR` | MYR | 4090 |
| system_account | `sys.write_off.MYR` | MYR | 6100 |
| system_account | `sys.rounding.MYR` | MYR | 6900 |
| system_account | `sys.tax_payable.MYR` | MYR | 2200 |
| system_account | `sys.cash.MYR` | MYR | 1050 |

Every target is `is_postable` (checked at seed time — a mapping to a summary node is a seed bug the test catches). The three role rules are what make `gl_resolution_view` cover future `ban.*.receivables`/`fa.*.unapplied_cash`/`fa.*.deposits` accounts with zero per-account rows (V5's "after onboarding" half).

### 2.5 Reason codes (`reason_code`) — Q19/Q20, plan §2

Nine rows; `auto_post_limit` per Q20, sensitive natures at **0** (always four-eyes):

| reason_code | doc_type | posting_nature | auto_post_limit |
|---|---|---|---|
| CUST_PAYMENT | PAY | cash | 100000.00 |
| ADVANCE_PAYMENT | PAY | cash | 100000.00 |
| PAYMENT_REFUND | PAY | cash | **0** |
| SEC_DEPOSIT | DEP | deposit_movement | 50000.00 |
| DEP_REVERSE | DEP | deposit_movement | **0** |
| DEP_REFUND | DEP | deposit_movement | **0** |
| GOODWILL_CREDIT | CRN | revenue_adj | 1000.00 |
| MANUAL_CHARGE | DBN | revenue | 10000.00 |
| BAD_DEBT_WRITEOFF | ADJ | write_off | **0** |
| ROUNDING_ADJ | ADJ | rounding | 10.00 |

All `state = active`. `PAYMENT_REFUND` (PAY, nature `cash`, limit 0 = always four-eyes) funds ac07's payment-refund op — the bank payout of a customer overpayment / unapplied remainder (`sys.cash → unapplied_cash`); it shares the `cash` nature (steers to `sys.cash`) with the capture reasons. These are the working config until Accounts Settings (ac15) makes them editable — the build plan's JIT rationale ("seeds carry working config until then").

### 2.6 Bill cycles (`bill_cycle`) + default (Q13)

Two rows per plan §2: `BCY000001` Monthly – Day 1 (cycle_day 1, payment_due_days 30), `BCY000002` Monthly – Day 15 (cycle_day 15, payment_due_days 30), both `active`. The **default cycle** for the Q2 wizard is designated via a `core.system_config` row (`config_group = 'accounts'`, key e.g. `ACCOUNTS_DEFAULT_BILL_CYCLE`, value `BCY000001`) — same mechanism `cm01` used for `CUSTOMER_SEARCH_RESULT_LIMIT`, read later by ac04's wizard and editable in ac15. Seed it here so ac04 has a default to read.

> **Wizard-defaults config seeded here (recorded):** ac04's wizard and ac15's "wizard defaults" need config rows. This unit seeds the minimal set the onboarding path reads: `ACCOUNTS_DEFAULT_BILL_CYCLE` (= `BCY000001`) and `ACCOUNTS_DEFAULT_CURRENCY` (= `MYR`, Q12 read-only). The **default credit limit** open item (plan §5 "Remaining") is resolved as *manual per-customer, pre-filled from an optional `ACCOUNTS_DEFAULT_CREDIT_LIMIT` config* — seed that key too (empty/`null` value = no pre-fill), so ac04 reads a stable key and ac15 can set it. If you prefer a hard default, only the seeded value changes, not the shape.

### 2.7 Structural decisions

- **Standalone idempotent script**, `cm01`/Product `seed` pattern: `postgres` + `drizzle` `max:1`, skip-if-present pre-checks per catalog, everything in **one transaction**, `lib/logger` (never `console.*`), `process.exit(1)` on failure. Runs **after** `db:migrate` (needs ac02 tables) and can run before or after other modules' seeds (no cross-dependency).
- **sys-account creation is idempotent by name**: pre-check `pgledger_accounts_view` for `sys.cash.MYR` etc. before creating — re-running the seed never creates a second `sys.revenue.MYR`.
- **No `AUDIT_LOG`** for seed inserts (deployment-time infrastructure, same rationale as `seed-rbac`).
- **No permission grants here** — the three `accounts_*` permissions are page-migration concerns (ac05/ac07/ac12), not seed data.

---

## 3. Implementation

### 3.1 `db/seeds/accounts/seed-accounts.ts` (new)
One transaction, ordered: (1) sys pgledger accounts via `ledger.repository.pgledgerCreateAccount` (§2.2, idempotent by name); (2) `gl_account` rows (§2.3); (3) `gl_mapping` rows (§2.4, assert each target `is_postable`); (4) `reason_code` rows (§2.5); (5) `bill_cycle` rows (§2.6); (6) `core.system_config` wizard-default rows (§2.6). Each step skip-if-present. Split helpers per catalog (`seed-sys-accounts.ts`, `seed-coa.ts`, `seed-gl-mappings.ts`, `seed-reason-codes.ts`, `seed-bill-cycles.ts`, `seed-wizard-defaults.ts`) composed by `seed-accounts.ts` if the file grows — match the repo's seed-file convention.

### 3.2 `package.json`
`"db:seed-accounts": "node --env-file=.env --import tsx db/seeds/accounts/seed-accounts.ts"`; extend `db:setup` to run it after `db:migrate` (order vs other module seeds irrelevant).

### 3.3 Guardrail test owned by this unit — **V5**
`tests/accounts/v05-gl-resolution.integration.test.ts` (named for the plan, code-standards §7.1): after `db:seed-accounts` on a fresh ac02 DB —
- **0 unmapped, seeded state:** `select count(*) from billing.gl_resolution_view where gl_code is null` = 0 across the six `sys.*` accounts.
- **0 unmapped, after onboarding:** insert a fixture FA+BAN + their three `ledger_binding` rows pointing at three freshly-created `pgledger_create_account` accounts (`ban.*.receivables`, `fa.*.unapplied_cash`, `fa.*.deposits`) → re-run the count = still 0 (**proves role rules cover new accounts with no new mapping rows** — V5's headline).
- **Resolution is unambiguous:** every resolved account maps to exactly one `is_postable` code (the `gl_mapping` UNIQUE + the `is_postable` seed assertion).
- **Catalog integrity:** the ten reason codes exist with the exact `auto_post_limit`s (§2.5, incl. the four 0s — DEP_REVERSE, DEP_REFUND, BAD_DEBT_WRITEOFF, PAYMENT_REFUND); two bill cycles + the `ACCOUNTS_DEFAULT_BILL_CYCLE = BCY000001` config; CoA has the 11 codes with correct `is_postable`/`normal_balance`.
- **Idempotency:** re-running `db:seed-accounts` is a no-op (counts unchanged).

### 3.4 Explicitly NOT in this unit
No schema change/migration. No onboarding service or wizard (**ac04** — this unit's fixture bindings are *test* inserts, not the onboarding path). No pages, nav, permissions, actions, services. No `money.ts`. No Accounts Settings CRUD (ac15 makes these catalogs editable; ac03 only seeds them). No `sys.deposit_movement` account (§2.2). No second-currency sys family (Q12 — additive later).

---

## 4. Dependencies (packages to install)
**None.** Uses ac01/ac02 tooling and repositories only. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `db/seeds/accounts/*.ts`, `package.json` (`db:seed-accounts` + `db:setup` wiring), `tests/accounts/v05-gl-resolution.integration.test.ts`. No schema/migration file changed; no page/service/action/component path exists.
- [ ] No `TODO`/`console.*`; seed uses `lib/logger`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Seed guardrails (the point of the unit)**
- [ ] Fresh DB `db:setup` (migrate → seed) completes; re-running `db:seed-accounts` is idempotent (no duplicate `sys.*`, catalog, or config rows).
- [ ] **V5 green:** `gl_resolution_view` has 0 unmapped after seeding **and** after onboarding a fixture FA/BAN with three bindings.
- [ ] Six `sys.*` MYR pgledger accounts exist (cash, revenue, revenue_adj, write_off, rounding, tax_payable); no `sys.deposit_movement`; sys accounts have no `ledger_binding` rows.
- [ ] Ten reason codes with exact limits (DEP_REVERSE/DEP_REFUND/BAD_DEBT_WRITEOFF/PAYMENT_REFUND = 0); 11 CoA codes; 9 mappings all targeting `is_postable` codes; two bill cycles + `ACCOUNTS_DEFAULT_BILL_CYCLE = BCY000001` and `ACCOUNTS_DEFAULT_CURRENCY = MYR` config rows.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac03` complete, "Next Up" → `ac04`; the `deposit_movement`/no-sys-account and credit-limit-default resolutions (§2.2, §2.6) recorded as intentional.

**Pipeline**
- [ ] CI green (SAST; DAST unchanged).

Any failing item means the unit isn't done. `ac04` (onboarding wizard) must not start until this is merged — the wizard reads the default bill cycle and default currency this unit seeds, and creates the real bindings whose role rules V5 just proved resolve.
