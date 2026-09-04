# bm15 — `_SAMPLE_*` Scenario Seed & Placeholder-Mode Rename

**Unit:** bm15 (Phase 2 · Phase F). **Boundary:** `db/seeds/sample/**` (new) + `lib/config.ts` config/UI rename. **Specs from:** `_updatemodule-billing-billrun-phase2-plan.md` §15 **D2/D3/D28/D32**, `billmgmt-architecture.md` §3 (`BILLRUN_PLACEHOLDER_MODE`), `bm00-build-plan.md` Unit 15. **Precedent:** `_assessment-seed-files-strategy.md` §3/§5 (local sample-customer pattern, prod guard).

> **Workflow-management framing.** In placeholder mode the workflow management component's **bill run processor** runs the pipeline with placeholder logic over **seeded** charge data rather than production `udr_rated` output. This unit provides that seeded data and renames the mode flag/badge so the two facts — placeholder logic + seeded data — read as one, loud, non-production state.

## Goal

Ship a **prod-guarded `db:seed-sample`** that builds a complete, unmistakably-marked `_SAMPLE_*` bill-run scenario end-to-end — a sample customer → onboarded billing account(s) → active subscription(s) → seeded `rating.udr_rated` charges for the demo period — so a freshly-deployed non-production app can run a real bill run; and rename phase-1's `STUB_DATA_MODE` to **`BILLRUN_PLACEHOLDER_MODE`** with the `PlaceholderBanner`/`PlaceholderBadge` copy.

## Design

**The `_SAMPLE_*` convention (D32) — never in production.** Two hard rules make sample data impossible to ship to prod:

- **It is never in `db:setup`.** `db:seed-sample` is an **opt-in** script, run manually in dev/test/demo only — exactly like the deferred-demo pattern in the seed strategy. The mandatory `db:setup` chain is untouched.
- **It refuses to run against a production target.** The seed's first act is a guard (reusing the `local-seed-sample-customer.ts` precedent): abort unless `DATABASE_URL`'s host is a known non-prod host (`localhost`/`127.0.0.1`/`db`/`postgres`) **and** `NODE_ENV !== 'production'`; overridable only by an explicit `ALLOW_SAMPLE_SEED=true` for a deliberate non-local demo box. A production connection string trips the guard and exits non-zero before writing a row.

**Marked at two levels (D32).**

- **Artifact:** the seed file, the npm target, and the log lines are all `sample`/`_SAMPLE_`-named.
- **Data:** every row it writes carries a visible/forensic `_SAMPLE_` marker so it is recognizable in the UI and bulk-purgeable — the sample customer/accounts are named `_SAMPLE_ …`, and the seeded `rating.udr_rated` rows carry `source_file = '_SAMPLE_billrun'`. Purge predicates use `starts_with(col, '_SAMPLE_')` / `col LIKE '\_SAMPLE\_%' ESCAPE '\'` — **never** a bare `LIKE '_SAMPLE_%'` (the leading `_` is a wildcard, D32).

**Composed from real services, not hand-rolled inserts.** The customer/account/subscription half calls the application's own services (`createCustomer` → `onboardCustomerAccounts` → `createOrder`/`instantiateOrder`) so the fixture can't drift out of shape with what the app actually produces (the §5 precedent). Only the `rating.udr_rated` charges are inserted directly (rating has no runtime write path from the app), against the app-repo `db/schema/rating/udr-rated.ts` typed schema.

**The scenario shape** (small, deterministic, demonstrates the pipeline's branches):

- 1 `_SAMPLE_` customer, onboarded onto the existing seeded bill cycle (`seed-bill-cycles.ts`, "Monthly – Day 1").
- ~3 billing accounts: **2 full-period** (bill cleanly) + **1 partial-period** (mid-period subscription start → exercises Scoping `EXCLUDED` → the Uncharged tab).
- `rating.udr_rated` charges for the two full-period accounts for the demo period; a couple of rows at `status = 'BILL_NOTUSED'` on one account (exercises the "deliberately not charged" surface). All at `status = 'RATED'` (unclaimed) so the processor's Collection stage can claim them `RATED → BILL_DRAFT`.

**Idempotent + re-runnable.** Keyed on the sample customer's registration number (`_SAMPLE_-BILLRUN-0001`); a second run purges the prior `_SAMPLE_*` graph (charges → subscriptions → accounts → customer, respecting FKs) then rebuilds, so a re-seed is clean.

**Placeholder-mode rename (mechanical).** `STUB_DATA_MODE → BILLRUN_PLACEHOLDER_MODE` is a rename of one config key and its ~10 consumers; `StubDataBanner`/`StubBadge → PlaceholderBanner`/`PlaceholderBadge` with new copy. No behavior change beyond the copy and the flag name — it stays an environment flag threaded server-side as a prop (never a per-run column).

## Implementation

### 1. `db/seeds/sample/seed-billrun-sample.ts` (new) — the scenario orchestrator

A standalone seed following the sibling shape (own `main()`, own `postgres()`/`drizzle()` client, explicit `process.exit()`), structured as:

1. **Guard** — `assertNonProductionTarget()` (host allow-list + `NODE_ENV` + `ALLOW_SAMPLE_SEED` override); abort loudly otherwise.
2. **Purge** — delete any existing `_SAMPLE_*` graph (idempotency), in FK-safe order, using the `_SAMPLE_` markers.
3. **Customer + accounts** — `createCustomer({ name: '_SAMPLE_ Nusantara Demo Sdn Bhd', registrationNumber: '_SAMPLE_-BILLRUN-0001', … })` → `onboardCustomerAccounts(...)` onto the seeded "Monthly – Day 1" bill cycle (financial + billing accounts + pgledger, via the real wizard path).
4. **Subscriptions** — `createOrder(...)` + `instantiateOrder(...)` against a seeded `_SAMPLE_` (or existing catalog) product offering to activate a recurring subscription per account; one account gets a **mid-period** start date to be partial-period.
5. **Charges** — insert `rating.udr_rated` rows for the full-period accounts for the demo period via §2.
6. **Log** a summary (customer id, account ids/BANs, udr row counts) and the exact run window so the operator knows which period to trigger.

### 2. `db/seeds/sample/udr-rated-sample.ts` (new) — the sample charge factory

Composes **valid** `rating.udr_rated` rows against the app-repo `db/schema/rating/udr-rated.ts` schema (the D28 coordination — rating has not exposed a runtime factory; this billing-owned, **sample-seed-only** helper stands in until it does, and is swapped for rating's factory if/when it lands):

- Canonical `udr_key` (sorted keys, UTC, fixed formats), `partition_period = rating.period_of(start_datetime)` (call rating's `IMMUTABLE` helper so the CHECK passes), `status = 'RATED'`, `is_live` generated.
- `source_file = '_SAMPLE_billrun'`; the rating-provenance columns (`rating_engine_version`, `rating_flow_revision`) set to a `'_SAMPLE_'` sentinel; amounts small deterministic values; currency matching the account.
- Inserted through the seed's privileged connection (the seed role owns the tables — **not** `billrun_runtime`, D28).
- Rows scoped to `(ref_bill_run_id = NULL, ban, attempt = NULL)` — **unclaimed**; the processor claims them.

### 3. `package.json` + guardrail wiring

- Add `"db:seed-sample": "node --conditions=react-server --env-file=.env --import tsx db/seeds/sample/seed-billrun-sample.ts"` — **not** added to `db:setup`.
- A CI/grep guard asserting `db:seed-sample` never appears in the `db:setup` chain (so a future edit can't silently wire sample data into the mandatory path).

### 4. Placeholder-mode rename — `STUB_DATA_MODE → BILLRUN_PLACEHOLDER_MODE`

- **`lib/config.ts`** — rename the config key + its Zod entry + the exported accessor (`isStubDataMode → isBillrunPlaceholderMode` or equivalent); update `tests/lib/config.test.ts`.
- **`.env.example`** — rename the var, update the comment to describe placeholder mode (placeholder billing logic + seeded `_SAMPLE_*` data).
- **Consumers** (rename the import/prop through each): `app/(app)/billing/bill-runs/page.tsx`, `[runId]/page.tsx`, `[runId]/approve/page.tsx`, `components/billing/run-action-card.tsx`, `bill-run-list.tsx`, and the tests referencing the flag.
- **`components/billing/stub-data-banner.tsx → placeholder-banner.tsx`** — rename the file + exports (`StubDataBanner/StubBadge → PlaceholderBanner/PlaceholderBadge`); copy → **"Placeholder pipeline — billing steps return success; figures are seeded test data, not production charges."** Wire per `billmgmt-ui-context.md` §6 (Warning family, unmissable, every tab + list-row chip).

### 5. Docs

- `_assessment-seed-files-strategy.md` — add `db/seeds/sample/` as the **Sample** class home (the `_SAMPLE_*` convention, D32); note `db:seed-sample` is opt-in and prod-guarded.
- `billmgmt-progress-tracker.md` — bm15 delivered; record the scenario shape + the D28 stand-in factory decision.

## Dependencies

- **No new npm packages.** Reuses `postgres`/`tsx`, the existing seed-runner idiom, and the app's own `createCustomer` / `onboardCustomerAccounts` / `createOrder` / `instantiateOrder` services.
- **Env:** `ALLOW_SAMPLE_SEED` (new, optional — only to permit a non-local demo box); the existing `DATABASE_URL`.
- **External prerequisites (must already exist):**
  - **Rating** `rating.udr_rated` schema (rm01) — **present in the codebase** (`db/schema/rating/udr-rated.ts`, migration `0034`) + `rating.period_of()` helper.
  - Phase-1 mandatory seeds (`seed-bill-cycles`, `seed-accounts`, `seed-product`, `ordering-inventory`) — for the bill cycle, GL/sys accounts, and a product offering the sample subscription attaches to.
  - The customer/accounts/ordering services above (delivered).
  - _(Preferred future)_ rating's own `udr_rated` row-factory (D28) — swap §2 to it when it exists.

## Verification checklist

- [ ] `db:seed-sample` builds the full graph on a fresh dev DB: 1 `_SAMPLE_` customer, ~3 accounts (2 full-period, 1 partial), active subscriptions, and unclaimed `_SAMPLE_billrun` `udr_rated` rows (incl. ≥1 `BILL_NOTUSED`).
- [ ] **Prod guard:** with a non-local `DATABASE_URL` (or `NODE_ENV=production`) and no `ALLOW_SAMPLE_SEED`, the seed **aborts before any write** and exits non-zero.
- [ ] `db:seed-sample` is **absent from `db:setup`**; the CI grep guard fails the build if it is ever added.
- [ ] Re-running `db:seed-sample` is idempotent — it purges the prior `_SAMPLE_*` graph (via the markers, FK-safe) and rebuilds; row counts are stable.
- [ ] Every seeded row is `_SAMPLE_`-marked (customer/account names, `udr_rated.source_file='_SAMPLE_billrun'`); a `starts_with(..,'_SAMPLE_')` purge removes the whole graph and nothing else.
- [ ] The seeded `udr_rated` rows are valid — pass the `partition_period = period_of(start_datetime)` CHECK and the live-row UNIQUE; all at `status='RATED'`, unclaimed.
- [ ] `BILLRUN_PLACEHOLDER_MODE` replaces `STUB_DATA_MODE` in `lib/config.ts`, `.env.example`, every consumer, and the tests; `tsc`/lint/tests green; no lingering `STUB_DATA_MODE`/`StubDataBanner` reference (grep-clean).
- [ ] With the flag on and the sample seeded, every run shows the `PlaceholderBanner` with the new copy on every tab + the list chip.
- [ ] Docs updated (seed strategy + progress tracker); no secret committed.

## Phase-2 review folds (2026-08-28)

From the design review (`_updatemodule-billing-billrun-phase2-plan.md` §17).

**D-T4 (P1) — PlaceholderBanner copy: name what's REAL.** The single-line copy ("billing steps return success; figures are seeded test data") reads as "all fake", but posting, invoice numbers, rendered PDFs and distribution are real — a trust risk where the operator consumes real `INV…` numbers and moves real ledger entries. Replace §4's copy (and `billmgmt-ui-context.md` §6) with the two-part message:

> **"Placeholder pipeline — the workflow engine runs the bill run, but the billing steps are placeholders and `udr_rated` is seeded `_SAMPLE_` test data. Approval, posting, invoice numbers, rendered PDFs and distribution are wired end-to-end and REAL."**

Unchanged: Warning family, unmissable, on every tab + the list-row chip, paired with a warning icon. Verification addition: the banner explicitly names posting/invoice-numbers/PDFs/distribution as real.
