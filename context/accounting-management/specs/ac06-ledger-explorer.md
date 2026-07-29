# AC06 — Ledger Explorer: Account Picker, Transfers Grid, Two-Leg Drawer, Permanent Zero-Sum Strip

- **Unit:** 6 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac05` (context strip, `amount-cell`, `parseAccountsContext`, `accounts_view` permission, `ledger.repository` reads, nav section shell all exist). `ac01`/`ac02` (`pgledger_transfers_view`, `pgledger_entries_view`, `pgledger_accounts_view`, `ledger_binding` for name resolution). `ac04` (onboarding-created accounts to trace).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Goal 4* ("Make every ringgit traceable: document → lines → transfers → entries → GL code"), *Pages & access* ("Ledger Explorer"); `acctmgmt-architecture.md` §4 (`accounts-view` grants Ledger Explorer, read-only); `acctmgmt-code-standards.md` §3.1 (shared context strip), §4.1 (`balance-check-strip.tsx` — the zero-sum indicator), §4.3 (dense tables: `text-sm`, sticky header, server pagination, sort as URL param); `acctmgmt-ui-context.md` §1.1 (`--acct-balance-ok`/`--acct-balance-broken`), §1.2 (account-kind chips `ban.*`/`fa.*`/`sys.*`), §3 (mono ids, dense grid); **Locked UI direction item 3** (trace any transaction to its ledger entries); decisions Q10 (pgledger views), plan Part B **P3** (Ledger Explorer layout: account picker + filters, transfers grid, transfer detail drawer, balance-check strip), §4 verification step **1** (zero-sum — surfaced permanently in the UI here).
- **Note on codebase verification:** planning-folder-only session. Confirm: the server-pagination + URL-sort pattern used by existing dense tables (Product/Customer search grids) so this grid matches; the `pgledger_*_view` column names (this spec uses the plan §1.1 columns: transfers `from_account_id/to_account_id/amount/event_at/created_at/metadata`; entries `transfer_id/account_id/amount(signed)/account_previous_balance/account_current_balance`).

---

## 1. Goal

Add `/accounts/ledger` — a read-only forensic window over the `billing.pgledger` views: an account picker searchable by the `ban.*`/`fa.*`/`sys.*` naming convention (kind chips), a paginated transfers grid (from/to names, amount, `event_at` vs `created_at`, metadata), a transfer-detail drawer showing both signed legs with previous/current balances, and a **permanent zero-sum strip** in the header that surfaces verification test V1 (`Σ balances = 0` per currency) live in the UI. Done when an `accounts_view:READ` holder can pick an onboarding-created account and trace its transfers end to end, the drawer makes the double-entry legs visible, and the strip reads green `Σ = 0` (and would go `bg-destructive` if it ever weren't).

## 2. Design

Second Accounts page; pure read over pgledger. Boundary: **`app/(app)/accounts/ledger/**`, `components/accounts/balance-check-strip.tsx` + account-kind chip rendering, `services/accounts/ledger-explorer.ts` read use-cases, `db/repositories/accounts/ledger.repository.ts` read methods (extend)**. Nav entry appended. No write path, no new permission (reuses `accounts_view`).

### 2.1 Account picker + kind chips (ui-context §1.2)

Search any pgledger account by name convention: typing resolves against `pgledger_accounts_view.name` (`ban.{BAN}.receivables`, `fa.{FIN}.unapplied_cash|deposits`, `sys.{nature}.{ccy}`). Each result carries a **kind chip** — `ban.*` (primary tokens `--acct-chip-ban-*`), `fa.*` (cyan `--acct-chip-fa-*`), `sys.*` (neutral `--acct-chip-sys-*`) — ids rendered mono (ui-context §3). Selecting an account sets a URL param (`?account=pgla_…&from=…&to=…`) — the Ledger Explorer's own URL state; it also honors the **shared context strip** (`?ban`/`?fa` from ac05): arriving with a BAN selected pre-picks that BAN's `receivables` account, so a user tracing from Overview lands on the right ledger account (locked item 5 continuity). The picker resolves a `ban.*`/`fa.*` name back to its TMF owner via `ledger_binding` for a friendly label.

### 2.2 Transfers grid (Part B P3.2, code-standards §4.3)

Dense table (`text-sm`, sticky header, `--radius-none`) of `pgledger_transfers_view` rows for the selected account (as from **or** to), with `event_at` range filter and metadata search (`doc`, `ban`, `type`). Columns: from-account name, to-account name (both resolved to friendly `ban.*`/`fa.*`/`sys.*` names + kind chip), amount (`amount-cell`), `event_at`, `created_at` (shown distinctly — a re-dated posting has `event_at ≠ created_at`, foreshadowing Q9), and a metadata peek (`doc`). **Server pagination**; **sort is a URL param** (so any future export matches on-screen order — code-standards §4.3). Amounts are unsigned transfer amounts here (direction is conveyed by from/to columns, not sign — the signed convention appears in the drawer).

### 2.3 Transfer-detail drawer — both legs (Part B P3.3)

Clicking a transfer opens a drawer showing the **two `pgledger_entries_view` legs** (debit + credit) for that `transfer_id`: each leg's account name + kind chip, **signed** amount, and `account_previous_balance → account_current_balance` (the running-balance columns). This is where the signed convention is taught (negative = credit) — the drawer uses the same signed-balance helpers as ac05 for consistent presentation, never raw `< 0`. The drawer also shows the transfer's `metadata.doc`/`ban`/`type` and, once documents post (ac07+), the `metadata.doc` will link to the document (rendered as plain text now — plan Part B open decision "doc refs link nowhere until a doc surface exists"; ac07 makes the doc real, ac07+ can wire the link). When a transfer resolves to a document, the drawer/doc detail also surfaces the document's `reference_info` and `reference_date` (Q29) alongside `event_at`.

### 2.4 Permanent zero-sum strip — V1 in the UI (code-standards §4.1, ui-context §1.1)

`components/accounts/balance-check-strip.tsx` in the page header: computes `Σ balance` over `pgledger_accounts_view` per currency and renders **green `Σ = 0`** (`--acct-balance-ok`) or **`bg-destructive`** with the non-zero figure (`--acct-balance-broken`) — verification test V1 surfaced permanently, "the page's most reassuring pixel." It is a live read on every page load (`force-dynamic`); it never caches. Because the ledger is zero-sum by construction (pgledger invariant, Inv. #1), it is always green in a correct system — a red strip is a five-alarm signal, which is exactly why it is always visible.

### 2.5 Structural decisions

- **Read services only** (`services/accounts/ledger-explorer.ts`): `searchLedgerAccounts`, `listTransfersForAccount` (paginated, filtered), `getTransferLegs`, `zeroSumByCurrency`. Pages orchestrate; repositories are the only `pgledger_*_view` callers (code-standards §6.3).
- **Name resolution is centralized**: a `resolveLedgerAccountLabel(name)` helper maps a pgledger name to `{kind, ownerId?, ownerLabel?}` (via `ledger_binding` for `ban.*`/`fa.*`, direct for `sys.*`) — reused by picker, grid, and drawer so a name renders one way everywhere.
- **No new permission, no write.** Everything is `accounts_view:READ`.

---

## 3. Implementation

### 3.1 Route + nav
Append Ledger Explorer to the Accounts nav; `/accounts/ledger/page.tsx` `force-dynamic`, guarded `accounts_view:READ`, thin orchestrator honoring both `?account/from/to` and the shared `?ban/fa` context.

### 3.2 `components/accounts/balance-check-strip.tsx` (new) + kind-chip rendering
Zero-sum strip per §2.4; kind chips per ui-context §1.2 (extract a small `LedgerKindChip` if reused across picker/grid/drawer).

### 3.3 `services/accounts/ledger-explorer.ts` + repository read methods
`searchLedgerAccounts`, `listTransfersForAccount` (server pagination + `event_at`/metadata filters + URL sort), `getTransferLegs`, `zeroSumByCurrency`, `resolveLedgerAccountLabel`. Extend `ledger.repository.ts` with the transfer/entry/zero-sum readers (only pgledger-view caller).

### 3.4 Guardrail tests
- **V1 in UI:** `zeroSumByCurrency` returns 0 for MYR on an onboarded+fixture-charged DB; a deliberately imbalanced fixture (test-only direct entry) flips the strip to broken — proving the indicator actually reacts (not hard-green).
- **Trace end-to-end:** pick an onboarding-created `ban.*.receivables`, list its transfers (after a fixture transfer), open the drawer, assert both legs with correct signed amounts + previous/current balances.
- **Picker/grid:** kind chips correct per `ban.*`/`fa.*`/`sys.*`; `event_at` filter + metadata search narrow results; URL sort round-trips; server pagination.
- **Route × level:** `/accounts/ledger` requires `accounts_view:READ`; no write affordance.

### 3.5 Explicitly NOT in this unit
No writes (append-only view; the page never posts). No document links (docs don't exist until ac07 — `metadata.doc` renders as text). No GL/journal aggregation (ac13). No Transactions page (ac07). No new permission. No period/close awareness (`event_at` vs `created_at` is shown but the re-date UX is ac14). No trial-balance or CoA views.

---

## 4. Dependencies (packages to install)
**None.** Reuses ac05 chrome + pgledger views. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `app/(app)/accounts/ledger/**`, `components/accounts/balance-check-strip.tsx` (+ kind chip), `services/accounts/ledger-explorer.ts`, extended `ledger.repository.ts`, nav entry, tests. No write/action path, no new permission.
- [ ] `force-dynamic`; signed helpers not raw `< 0`; dense-table tokens (`--radius-none`, `text-sm`), no AI/gradient tokens. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] Pick an onboarding-created account → transfers grid → drawer shows both signed legs with previous/current balances (trace end to end).
- [ ] **V1 strip** reads green `Σ=0`; an imbalanced fixture flips it to `bg-destructive` (indicator reacts).
- [ ] Kind chips (`ban.*`/`fa.*`/`sys.*`) correct; `event_at`/metadata filters + URL sort + server pagination work.
- [ ] Route × level: `accounts_view:READ`; no write affordance.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac06` complete, "Next Up" → `ac07`.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (`/accounts/ledger` route).

Any failing item means the unit isn't done. `ac07` (document core + PAY) posts the first real transfers, which this Explorer then traces — the two are the read/write halves of the same ledger.
