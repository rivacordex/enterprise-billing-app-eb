# AC14 — Period Close + CSV Export: Close Action, Re-Date UX, Audited Streamed Journal CSV

- **Unit:** 14 of 17 (`ac00-build-plan.md`)
- **Dependencies:** `ac13` (GL Journal page — the export button + close action attach here; the on-screen journal is what the CSV streams). `ac07` (the `PERIOD_CLOSED` rejection built there; the posting core the re-date re-submits into). `ac02` (`accounting_period` table; `gl_journal_view`). `ac12` (`accounts_config:EDIT`; 0-unmapped precondition).
- **Authorizing sections:** `acctmgmt-project-overview.md` *Goal 5* (close safely; posting into closed period rejected with re-date; exported journal always balances), *Core user flow* step 9; `acctmgmt-architecture.md` §4 (`accounts-config` — period close, journal export), §5 (period close is a user action, not a job), §6 Module Inv. **#7** (closed periods reject postings; no reopening), **#10** (Σ debit = Σ credit in every exported period — **V6**); `acctmgmt-code-standards.md` §5.1 (the **one** Route Handler `POST /api/accounts/gl-journal-export` — audited, streamed CSV, `accounts_config:EDIT`, POST-because-it-audits), §5.3 (fixed CSV format in `journal-csv.ts`), §2.4 (`PERIOD_CLOSED` carries the open-period hint); decision **Q9** (reject with re-date — the user corrects the entry date; no force-post; no reopening in v1), Q8 (period locking IN scope). Plan §3 step 7 (month-end journal), §4 verification step **6** (balanced journal; export re-runs idempotently).
- **✓ Re-date / `event_at` model (resolved — Q2 date decisions):** `event_at` is the document's **business-event date** — captioned **"Reference Date"** in the UI since AC24 — and it drives period validation and GL-journal grouping. It is user-selectable (date-only capture, default today; `timestamptz` in the DB), may be backdated, **but a posting whose `event_at` falls in a closed period is rejected** (`PERIOD_CLOSED`, ac07). On rejection the user simply **corrects `event_at`** to an open period and re-submits — there is **no separate posting-date field** and **no original-date preservation** (`event_at` *is* the user-entered document date; nothing distinct to preserve). The manual **`entry_date`** (Q29, captioned "Entry Date"; renamed from `reference_date` by AC24) is reference-only, captured date-only, and untouched.

---

## 1. Goal

Add the two `accounts_config:EDIT` write surfaces on top of the GL Journal read page: a **period close** action on `accounting_period` (marks a month closed, `closed_at`/`closed_by`; no reopening — Q9), the **re-date UX** that catches ac07's `PERIOD_CLOSED` rejection and lets the operator correct the entry date (`event_at`) into an open period and re-submit, and **`POST /api/accounts/gl-journal-export`** — the module's single Route Handler, which streams the balanced period journal as CSV and writes an audit event (period, row count, totals) in the same request. Done when a user closes a month, downloads a CSV whose totals balance (Σ debit = Σ credit — V6), a late posting into the closed month bounces with a re-date prompt (correct the entry date), and re-running the export is idempotent.

## 2. Design

Write actions over ac13's read surface; the export is the one non-Server-Action route because it audits (code-standards §5.1). Boundary: **`app/api/accounts/gl-journal-export/route.ts`, `actions/accounts/{close-period,redate-and-post}.action.ts`, `services/accounts/{period-close,journal-csv}.ts`, the `accounting-period` repository bodies (extend), and the re-date prompt UI in Transactions**. Refines ac07's period-validation input per §⚠.

### 2.1 Period close (Q9, Inv. #7)

`close-period` action (`accounts_config:EDIT`): sets the `accounting_period(period, currency)` row to `closed`, stamps `closed_at`/`closed_by`, audits `PERIOD_CLOSED`. **No reopening** in v1 (Q9 — reopening would require a re-export procedure). A period may be closed only if it exists/open; closing is idempotent-safe (re-closing an already-closed period is a no-op or a clear error, not a second audit). If a period row doesn't exist yet for a month, closing creates-then-closes it (or the open period is implicit until first close — pick per ac02's `accounting_period` default; this spec assumes rows are created lazily on first post or on close).

### 2.2 Re-date UX (Q9 — the rejection built in ac07, the recovery built here)

ac07 already rejects a post whose `event_at` falls in a closed period with `PERIOD_CLOSED` carrying the open-period hint. This unit builds the **recovery**: the Transactions form catches `PERIOD_CLOSED`, shows the open-period hint, and offers a **re-date** — the operator corrects `event_at` (captioned "Reference Date" since AC24) to an open period, and the post is re-submitted through the same ac07 `post-document`. No silent rerouting, no force-post override (Q9); **no original-date preservation** (`event_at` is the user-entered document date). `entry_date`/`reference_info` (Q29) are untouched. `redate-and-post` is a thin action wrapping the re-submit.

### 2.3 CSV export — the one Route Handler (code-standards §5.1/§5.3)

`POST /api/accounts/gl-journal-export`, body `{ period: 'YYYY-MM', currency: 'MYR' }` (Zod-validated), permission `accounts_config:EDIT`. It:
- Streams `text/csv` of `gl_journal_view` for the period — fixed format (`journal-csv.ts`, code-standards §5.3): header `gl_code,gl_name,debit,credit`, UTF-8, **CRLF**, amounts plain `1234.56` (no thousands separators), rows in the same URL-sort order as ac13's on-screen table.
- Writes the **export audit event** (period, currency, row count, Σ debit, Σ credit) in the same request — which is why it's `POST`, not `GET` (platform keeps `GET` side-effect-free, code-standards §5.1).
- Is **idempotent by construction** (pure query over immutable entries — re-running yields byte-identical CSV; a historical export is a point-in-time CSV + audit trail, plan F5).

### 2.4 Balanced guarantee (V6)

Because the CoA is 0-unmapped (ac12) and the ledger is zero-sum (Inv. #1), the exported period always balances (Σ debit = Σ credit). The export computes the totals it audits and **refuses to stream an unbalanced period** (defensive: if Σ debit ≠ Σ credit it errors with a diagnostic rather than emitting a corrupt journal — this can only happen if an upstream invariant broke, and the export is the last line of defence before finance posts to the ERP).

### 2.5 Structural decisions

- `period-close` and `journal-csv` are pure services; the route handler is thin (permission + Zod + stream + audit). The re-date is a thin re-submit over ac07.
- Period validation runs on `event_at` (the business-event date, captioned "Reference Date" in the UI since AC24) — ac07's `post-document` validates it directly; no separate posting-date field.
- No new permission (reuses `accounts_config`).

---

## 3. Implementation
### 3.1 `services/accounts/period-close.ts` — `closePeriod(period, currency, actorId)`; period lazy-create/close; audit.
### 3.2 `services/accounts/journal-csv.ts` — the fixed CSV serializer (§2.3); shared by the route and any test.
### 3.3 `app/api/accounts/gl-journal-export/route.ts` — POST, Zod body, `accounts_config:EDIT`, stream + audit + balanced-guard (§2.3/§2.4).
### 3.4 Actions — `close-period.action.ts`; `redate-and-post.action.ts` (re-submit with the corrected `event_at` — the field captioned "Reference Date" in the UI since AC24).
### 3.5 ac07 alignment — `post-document` validates **`event_at`** (the business-event date, captioned "Reference Date" since AC24) against the open period and passes it as the pgledger transfers' `event_at`; no separate posting-date field (the earlier workaround is removed).
### 3.6 Repository — `accounting-period.repository` (find/create/close); the export reads `gl_journal_view` (existing).
### 3.7 UI — close-period button + confirm on GL Journal; export button (triggers the POST download); re-date prompt in Transactions (catches `PERIOD_CLOSED`).
### 3.8 Guardrail tests — completes **V6**: close a month → a late post into it bounces with `PERIOD_CLOSED` + open-period hint; re-date **corrects** `event_at` to the open period and posts; export streams a balanced CSV (fixed format, CRLF) whose totals equal `gl_journal_view` and the on-screen table (§2 July = 16,200/16,200); re-running the export is byte-identical (idempotent); the balanced-guard refuses a (fixture-forced) unbalanced period. Route × level: export requires `accounts_config:EDIT`; a READ-only holder is blocked.

### 3.9 Explicitly NOT in this unit
No period **reopening** (Q9). No ERP API (CSV only, Q25/Q8). No dimensions in the CSV (Q25). No Accounts Settings (ac15). No bill run/invoice. No GET export (audited → POST). No schema change — re-date just corrects `event_at`; no original-date preservation, no new column.

---

## 4. Dependencies (packages to install)
**None.** CSV is hand-serialized in `journal-csv.ts` (no csv library — fixed format, code-standards §5.3). Reuses ac13 read + ac02 views + platform audit. Zero npm packages, zero extensions.

## 5. Verification checklist
**Diff hygiene**
- [ ] Added: `app/api/accounts/gl-journal-export/route.ts`, `close-period`/`redate-and-post` actions, `period-close`/`journal-csv` services, `accounting-period` repository, GL-Journal close+export buttons, Transactions re-date prompt, the ac07 `event_at` validation alignment, tests.
- [ ] The export is the **only** Route Handler in the module; it's `POST` and audits. No `GET` export. No reopening path. No `TODO`/`console.*`.

**Build gates**
- [ ] `typecheck`/`lint`/`format:check`/`test` green.

**Behavior — the point of the unit**
- [ ] Close a month → late posting bounces (`PERIOD_CLOSED` + open-period hint); re-date **corrects** `event_at` to the open period and posts.
- [ ] **V6:** export streams a balanced CSV (fixed `gl_code,gl_name,debit,credit`, CRLF, plain amounts) matching `gl_journal_view` and the on-screen table (16,200/16,200); re-run is byte-identical; unbalanced period refused.
- [ ] Export audit event records period, currency, row count, totals; requires `accounts_config:EDIT`.

**Docs in sync**
- [ ] `acctmgmt-progress-tracker.md`: `ac14` complete, "Next Up" → `ac15`; the entry-date/`event_at` model (§6) recorded.

**Pipeline**
- [ ] CI green incl. SAST + ZAP DAST baseline (the new `/api/accounts/gl-journal-export` route in DAST surface).

Any failing item means the unit isn't done. `ac15` (Accounts Settings) makes the reason-code thresholds and bill-cycle catalog editable — the config the seeds have carried since ac03.
