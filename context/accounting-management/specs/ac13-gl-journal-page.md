# AC13 — GL Journal Page: Period Selector, Balanced Summary, Drill-Down, Trial-Balance Toggle

- **Unit:** 13 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac12` (`accounts_config` permission; a 0-unmapped CoA — the precondition for a balanced journal). `ac07`–`ac10` (posted documents whose entries this page aggregates). `ac02` (`gl_journal_view`, `gl_resolution_view`; `accounting_period`). `ac06` (leg-rendering reused in drill-down).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Ledger & GL* ("GL Journal per period with drill-down, trial-balance toggle"), *Goal 4* (traceable to GL line); `acctmgmt-architecture.md` §6 Module Inv. **#10** (Σ debit = Σ credit — **V6** surfaced on screen); `acctmgmt-code-standards.md` §4.3 (dense tables, URL sort), §8 (`accounts_config:READ` view/drill-down); `acctmgmt-ui-context.md` §3 (GL total row + zero-sum figure = `--text-h4`; debit/credit by column position, never color), §1.1 (`--acct-balance-broken` for `Σ debit ≠ Σ credit`); **Locked UI direction item 7** (manual export + overview); decision Q25 (no dimensions — single grouping). Plan Part B **P5** (period selector, journal summary with Σ total row, drill-down, trial-balance toggle), §2 (`gl_journal_view` July table totalling 16,200/16,200), §4 verification step **6** (Σ debit = Σ credit; per-code totals reconcile to `pgledger_entries_view`).
- **Note on codebase verification:** planning-folder-only session. Confirm the month-picker component convention and the `gl_journal_view` period-filter shape (this spec filters on `event_at` `YYYY-MM`).

---

## 1. Goal

Add `/accounts/gl-journal` (permission `accounts_config`) — a period selector (month on `event_at` + currency), a journal summary rendering `gl_journal_view` per GL code (debit / credit columns) with a **Σ debit = Σ credit total row** (highlighted `--acct-balance-broken` if ever unequal — V6 on screen), a drill-down expanding any GL-code row to its contributing `pgledger_entries_view` legs (via `gl_resolution_view`), and a trial-balance toggle (cumulative-to-date vs period-movement). Done when the ac07–ac10 postings for a period reconcile to GL lines on screen — the §2 July scenario totals 16,200 / 16,200 — and every journal line drills to its source entries with one click.

## 2. Design

Read-only reporting surface over `gl_journal_view`; no writes (export + close are ac14). Boundary: **`app/(app)/accounts/gl-journal/**`, `services/accounts/gl-journal.ts` (period summary, drill-down, trial-balance), the `gl-journal`/`gl-resolution` repository read methods (extend)**. No schema change, no new permission (reuses `accounts_config`).

### 2.1 Period selector (P5.1)

Month picker on `event_at` + currency (MYR default, Q12). Selection is a **URL param** (`?period=2026-07&currency=MYR`) so a shared link reproduces the view and a future export matches on-screen scope. `force-dynamic` (live read).

### 2.2 Journal summary + balanced total row (P5.2 — V6, ui-context §3)

`gl_journal_view` for the period as a dense table: per GL code — `gl_code`, name, **debit**, **credit** (positive entry = debit, negative = credit — plan §1.3). Debit vs credit communicated by **column position, never color** (ui-context §3). A **total row** sums both columns; when `Σ debit = Σ credit` it renders normally (`--text-h4`, `tabular-nums`), when unequal it renders `--acct-balance-broken` — V6 surfaced permanently (it can only be unequal if something upstream is broken, so red is a five-alarm signal, like ac06's zero-sum strip). Amounts via `amount-cell` (2dp, `tabular-nums`).

### 2.3 Drill-down to source entries (P5.3)

A GL-code row expands to the contributing `pgledger_entries_view` legs resolved to it via `gl_resolution_view` — each with account name + kind chip (ac06 rendering), `event_at`, `metadata.doc`, and signed amount. This closes the trace chain: document → line → transfer → entry → **GL code** (project-overview Goal 4). Per-code totals reconcile to the `pgledger_entries_view` sums (V6 second half).

### 2.4 Trial-balance toggle (P5.5)

Same data, **cumulative-to-date** (all entries up to and including the period end) instead of **period-movement** (entries within the period) — a toggle (URL param `?view=trial|movement`). Cheap to add, high finance value; both computed from `gl_journal_view` with a different `event_at` bound.

### 2.5 Structural decisions

- Read services only; repositories are the only `gl_journal_view`/`gl_resolution_view`/`pgledger_entries_view` callers.
- **Sort is a URL param** (code-standards §4.3) so the ac14 CSV export (next unit) matches exactly what's on screen.
- No dimensions (Q25) — single grouping by GL code; the `dim_*` escrow is not surfaced.

---

## 3. Implementation
### 3.1 Route + nav — append GL Journal; `/accounts/gl-journal/page.tsx` `force-dynamic`, guarded `accounts_config:READ`.
### 3.2 `services/accounts/gl-journal.ts` — `periodSummary(period, currency, view)`, `codeDrilldown(gl_code, period, currency)`, both movement + trial-balance bounds.
### 3.3 Repository read methods — `gl-journal.repository` over `gl_journal_view`; drill-down over `gl_resolution_view` + `pgledger_entries_view`.
### 3.4 UI — period selector, summary table + total row (V6 highlight), expandable drill-down rows, trial-balance toggle.
### 3.5 Guardrail test — **V6** `tests/accounts/v06-journal-balance.integration.test.ts`: reproduce the §2 July scenario (onboard + DBN charge + PAY capture/allocation via ac07 flows) → `gl_journal_view` totals **16,200 / 16,200**; Σ debit = Σ credit for the period; per-GL-code totals reconcile to `pgledger_entries_view` sums; a deliberately imbalanced fixture flips the total row to broken (indicator reacts); drill-down of GL 1200 lists the contributing A/R entries.
### 3.6 Route × level — `/accounts/gl-journal` requires `accounts_config:READ`; USER (no `accounts_config`) blocked; no write affordance (export/close are ac14).

### 3.7 Explicitly NOT in this unit
No CSV export or period close (ac14 — this page is read-only; the export button + close action land in ac14). No CoA editing (ac12). No dimensions (Q25). No new permission/schema.

---

## 4. Dependencies (packages to install)
**None.** Reuses ac12 permission + ac02 views + ac06 rendering. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `app/(app)/accounts/gl-journal/**`, `services/accounts/gl-journal.ts`, extended `gl-journal` repository, nav entry, the V6 test. No write path, no new permission/schema.
- [ ] `force-dynamic`; debit/credit by column not color; URL sort/period/view params; no AI/gradient tokens. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] **V6:** July scenario totals 16,200 / 16,200; Σ debit = Σ credit; per-code totals reconcile to entry sums; imbalance flips the total row red.
- [ ] Drill-down expands any GL code to its source entries (trace to GL line complete).
- [ ] Trial-balance toggle switches cumulative vs period-movement.
- [ ] Route × level: `accounts_config:READ`; USER blocked; no write affordance.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac13` complete, "Next Up" → `ac14`.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (`/accounts/gl-journal`).

Any failing item means the unit isn't done. `ac14` (period close + CSV export) adds the write actions on top of this read surface — closing a period and streaming the balanced journal this page displays.
