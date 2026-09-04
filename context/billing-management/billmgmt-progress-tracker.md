# Progress Tracker

Update this file after every meaningful implementation change.

_Compressed 2026-08-26 — build plan is complete; per-unit narrative and test-file
enumerations were trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`._

## Current Phase

- Phase 1 — Bill Run module build. **Complete.** bm01–bm13 (the entirety of
  `bm00-build-plan.md`) are delivered.
- Phase 2 · Phase F — **bm14 (`billrun_runtime` role & the two-writer grant
  boundary) — delivered.** See
  `context/billing-management/specs/bm14-billrun-runtime-role.md`. Its
  guardrail test is DB-gated and unexecuted in this environment — see
  Outstanding, below.
- Phase 2 · Phase F — **bm15 (`_SAMPLE_*` scenario seed & placeholder-mode
  rename) — delivered.** See
  `context/billing-management/specs/bm15-sample-seed-placeholder-mode.md`. The
  seed itself is written and statically verified (imports cleanly, guard/purge
  logic reviewed) but **never executed against a real Postgres** — same
  environmental gap as every other DB-gated unit in this module (see
  Outstanding, below).
- Phase 2 · Phase G — **bm16 (Engine Registry · Two-Execution Columns ·
  `bill_run_processing` Flow (Placeholder) · M2M Record-Only) — delivered.**
  See `context/billing-management/specs/bm16-processing-flow-engine-registry.md`
  and the Delivered Units entry below. Migration `0035` is generated/reviewed
  but **not applied** — see Outstanding.

## Outstanding (environmental only — not a build unit)

- Migrations `0033_customer_bill_finalization_guard.sql` (bm13 — DB trigger
  enforcing the `ref_inv_document_id` finalization latch) and
  `0035_bill_run_two_executions.sql` (bm16 — the `workflow_*` → `processing_*`
  rename + `distribution_*`/`*_engine_ref` columns) are generated/reviewed but
  **not applied**.
- No local Postgres has been reachable in this environment for the entire
  build — every DB-gated integration test (materialize/trigger/partman/stage-
  ingest/E2E-happy-path/billrun-db-roles/etc.) was written and statically
  verified (imports cleanly, skips loudly under `DATABASE_URL` unset) but
  **never executed**.
- Before calling the module genuinely ship-ready end-to-end: run `db:migrate`,
  then `db:setup-partman-billing`, then `npm run test` (both DB-free and
  integration configs) against a real Postgres.
- Uncharged tab's indicative value stays `"—"` until a rating source exists
  (deferred with the rating engine, see bm05/bm13 below).
- `npm run db:seed-sample` (bm15) has never been run end-to-end against a real
  DB either — verify the full checklist (idempotent re-run, prod-guard trip,
  the seeded `udr_rated` CHECK/UNIQUE pass, a real bill run against the
  seeded scenario) once Postgres is reachable.
- **bm16's live-Kestra smoke gate is unmet** (spec review fold T3): no deployed
  `billrun` engine or real `bill_run_processing` flow exists anywhere yet — the
  separate workflow-management repo, its owning team, and its deploy step are
  named as `TBD` in `flows/billrun/README.md`. The checklist's "end-to-end
  against the deployed placeholder flow" item is unproven; register the
  live-Kestra smoke run as a phase-2 exit criterion when bm21 is specced.
- `bill_run.ref_tax_rate_version`'s only writer (`stampTaxRateVersion`,
  `services/billing/taxation.ts`) was retired with bm16 Fork B — no app or
  processor writer is specced for it yet (`billrun_runtime` holds no
  `bill_run` write grant, bm14 Step 9). The column stays reserved/unpopulated;
  not addressed by bm16 — revisit if a future unit needs run-level tax-version
  provenance.

## Delivered Units (bm01–bm13)

- **bm01 — Billing section & RBAC scaffold.** Permissions `billrun_view/
  operate/approve` (`PERMISSION_NAMES`, migration `0024`); seeded
  `BILLING_VIEWER` role (`db/seeds/billing.ts`); `/billing/bill-runs` route +
  guarded empty state; `Billing` nav section between Accounts and
  Administration. No domain tables.

- **bm02 — Bill Runs list + lazy materialization.** New `billing.bill_run`
  header table (migration `0025`, `BRN` id, `(cycle, period_start)` UNIQUE +
  status/run_type/approver CHECKs). `STUB_DATA_MODE` config flag.
  `currentDuePeriod` — pure, **current-month-anchored, no backfill**
  derivation. `materializeDueRuns` (idempotent, ON CONFLICT DO NOTHING) +
  `listRuns` (two-tab Current/Historical, derived operability). CSV export
  via `lib/csv.ts`'s formula-safe `csvField`.

- **bm03 — Trigger a run (+ Scoping + outbound engine).** Partitioned
  `billing.bill_run_account` (migration `0027`, hand-authored — Drizzle can't
  express `PARTITION BY`; pg_partman monthly/4-premake/**7-year detach-not-
  drop** retention, `db:setup-partman-billing`). `AccountStatus` CHECK incl.
  `EXCLUDED`. Scoping: `isPartialPeriod` (strict boundary rule) +
  `scopeAccounts`. `EngineClient` (`realEngineClient` Basic-Auth fetch /
  `stubEngineClient`, selected by `isBillRunEngineConfigured`). `triggerRun`
  — one txn: row-lock → guard `SCHEDULED` & due → scope → snapshot → engine
  call **inside the txn** (unreachable ⇒ full rollback) → `PROCESSING`.
  `BILL_RUN_TRIGGERED` audit (Change).

- **bm04 — M2M stage ingest + stage-timeline observability.** Partitioned
  `billing.bill_run_account_stage` (migration `0028`, idempotency-latch
  UNIQUE `(run, account, stage, attempt, period_partition)`). `BILLRUN_APP_
  TOKEN` service-token auth (`requireServiceToken`, fail-closed, constant-
  time compare). Two Route Handlers: `.../stage/[stage]/complete`,
  `.../status`. `handleStageSignal` — row-lock, insert-first idempotency
  latch, **Validation stage is app-computed** (overrides caller body via
  `validate-account.ts`), every other stage pass-through → `advanceAccountStatus`
  → recompute `bill_run.status` via pure `compute-run-status.ts`. Detail page
  + Workflow tab (`StageTimeline`).

- **bm05 — Draft bill generation (Claim + Aggregation).** Partitioned
  `billing.customer_bill` (migration `0029`; `ref_inv_document_id`/
  `posted_attempt`/`charge_checksum` finalization-latch columns reserved,
  unpopulated in v1). Collection (stage 3) — pure no-op, always `DONE`,
  app-computed like Validation (**no `rating.*` object exists yet** — claim/
  grant deferred to the rating engine). Aggregation (stage 4) —
  `aggregateBill`, rerun-safe `DELETE ... WHERE ref_inv_document_id IS NULL`
  + INSERT, `subtotal` is a **deterministic synthetic stub**
  (`deriveStubSubtotal`, no randomness), `tax_total="0.00"`/`total_amount=
  subtotal` in v1 (Taxation is bm06). Customers & Bills tab.

- **bm06 — Taxation.** Partitioned `billing.customer_bill_tax_item`
  (migration `0030`, first composite FK in the module, `ON DELETE CASCADE`
  onto `customer_bill`, no JSONB). `BILLRUN_TAX_RATE`/`_VERSION`/`_CATEGORY`
  config (no tax-rate catalog table — single configured rate, deferred with
  rating). Taxation (stage 6) — `taxBill`, latch-guarded, replaces tax items
  then recomputes `tax_total`/`total_amount` **entirely in SQL numeric**
  (never JS float); out-of-order taxation (no bill yet) throws `CONFLICT` →
  whole ingest txn rolls back, engine retries after Aggregation. Tax section
  added to Customers & Bills.

- **bm07 — Verification, Uncharged & Errors (+ Audit) tabs. No new table.**
  Verification (stage 6, terminal) — `verifyAccount` always records `DONE`
  (v1 has no rating/baseline) plus a **`SOFT` finding** on the same stage row
  when the unposted bill's `total_amount <= 0`; SOFT never blocks
  `PROCESSED`. Uncharged tab (`EXCLUDED` accounts, reason + window,
  indicative value always `"—"`, deep-links to `/accounts/transactions`).
  Errors tab (`PROCESSING_FAILED` accounts, `DISTINCT ON` latest HARD stage
  row). Audit tab reuses the platform `AuditLogTable` unchanged via
  `findByTargetId`.

- **bm08 — Rerun (full & partial). No new table.** `rerunRun` — one txn:
  guard `PROCESSED`/`PROCESSING_FAILED` → **audit written before the engine
  re-trigger** (`BILL_RUN_RERUN`, prior totals in `beforeData`) → uniform new
  `attempt_count` for selected accounts → later stages invalidated
  implicitly via the attempt-keyed idempotency latch (no row deletes) →
  inline re-derivation **only for accounts that already have an unposted
  bill** (delta-refresh; accounts with no bill are left for the re-triggered
  engine to re-validate/re-create) → engine re-trigger → `PROCESSING`.
  **Finalization guard absolute**: `EXCLUDED` + posted accounts always
  dropped from the eligible set. `RerunDialog` on the Errors tab + a
  run-level header control.

- **bm09 — Accounts-side INV & posting enablement (cross-module).**
  Additive only. New `billing.document_inv_seq`; `document_doc_type_check`/
  `reason_code_doc_type_check` widened to admit `'INV'` (migrations `0031`/
  `0032`). `DOC_TYPES` gains `INV` (6 members). `STANDARD_INVOICE` reason
  code (`autoPostLimit` effectively unlimited) — an INV **auto-posts from
  draft**; the run-level four-eyes (bm10) is the sole second signature.
  `INV_LEG_TEMPLATES` (charge = A/R debit + revenue credit; release = A/R
  debit + tax-payable credit). Period-close guard: `closePeriod` rejects
  with `BILL_RUN_IN_PROGRESS` while an active bill run posts into the
  period.

- **bm10 — Approve (four-eyes gate). No new table.** Five pre-approval
  checks (period open, GL mappings resolvable, no zero/negative totals,
  **four-eyes** `triggeredBy !== approverId`, all accounts terminal).
  `approveRun` — one txn: guard `PROCESSED` → checks (four-eyes checked
  first, own `FOUR_EYES_VIOLATION` result; others bucket `CHECKS_FAILED`
  with the full re-check) → stamp immutable `total_amount` (SQL SUM) →
  mark failed/excluded accounts `SKIPPED` → `APPROVED` → `BILL_RUN_APPROVED`
  audit (Change). `/billing/bill-runs/[runId]/approve` page +
  `ApproveAndPostPanel`.

- **bm11 — Post to the ledger. No new table** (columns pre-reserved by
  bm02/bm05). `postAccount` — entire per-account write in one txn: locked
  joined read (idempotent-resume check on `ref_inv_document_id`) → build one
  INV (`STANDARD_INVOICE`, `createdBy` = run's `approvedBy`) with a charge
  line + optional tax line → `postDocument` (auto-posts) → on success,
  `charge_checksum` computed **in SQL** (`md5(...)`) + stamp bill +
  `INVOICED`. **No double-post**: any failure rolls the INV back inside the
  txn; the account is then parked (non-tx write, resumable — `PERIOD_CLOSED`
  and all other posting failures are tolerated, never a run-level abort).
  `postRun` — `APPROVED → POSTING`, posts every `PROCESSED` account, then
  `POSTING → COMPLETED` (stamps `invoiced_at`+`completed_at` together;
  `DISTRIBUTING` never entered in v1) + `BILL_RUN_POSTED` audit (Additive).
  `PostingProgressView` — never auto-fires, explicit Post/Retry-failed only.

- **bm12 — Stall detection & recovery. No new table.** `isStalled(run, now,
  thresholdMinutes)` — pure, derived, never persisted.
  `BILLRUN_STALL_THRESHOLD_MINUTES` config (global, default 30).
  `EngineClient` gains `getExecutionStatus`/`killExecution` (real endpoints
  **flagged unverified** pending the deployed Kestra version). `reconcileRun`
  (Check status) — one txn, branches on engine state: `RUNNING` bumps
  heartbeat only; `FAILED`/`KILLED` → `PROCESSING_FAILED`; `SUCCESS`
  re-derives via the shared `computeRunStatus` or returns `mismatch: true`
  without forcing a status. Every branch writes `BILL_RUN_RECONCILED`.
  `cancelRun` — guard `PROCESSING` → best-effort kill → reset non-`EXCLUDED`
  accounts to `PENDING` → `CANCELLED` (nulls execution refs) →
  `BILL_RUN_CANCELLED`. Re-trigger extended to accept `CANCELLED` (new
  attempt via `maxAttemptForRun + 1`, old snapshot cleared first).
  `StallBanner` + `CancelRunDialog` on the detail page.

- **bm13 — End-to-end journey & ship gate.** Boundary/tests-CI unit, no new
  page/permission/feature. Audited every code-standards §9 guardrail and the
  three pages' route × level matrices — **all already existed**, shipped
  with the unit that introduced each behavior; nothing needed rebuilding.
  Real gaps closed:
  - **[CRITICAL] Finalization latch was service-layer-only.** Migration
    `0033` adds a `BEFORE UPDATE OR DELETE` row-level trigger on
    `billing.customer_bill` (propagates to all partitions) rejecting any
    mutation once `ref_inv_document_id IS NOT NULL`. **Not yet applied**
    (see Outstanding, above).
  - Rating-claim placeholder guardrail landed as two structural assertions
    (no `rating` schema export, no `rating-claim.ts` repository) that will
    fail the moment either lands without this guardrail being revisited.
  - New DB-gated E2E happy-path test covers materialize → trigger → M2M
    stage signals → PROCESSED → review → rerun a subset → approve (different
    four-eyes user) → post → COMPLETED → next-period operable, plus the
    finalization-trigger proof, using the app's own production seed
    functions for the Accounts GL fixture stack.
  - New DB-free route-inventory test locks the M2M surface to exactly two
    `POST`-only Route Handlers.
  - SAST (Semgrep) + OWASP ZAP DAST CI gates confirmed already covering the
    M2M endpoints; no CI file changed.

- **bm14 — `billrun_runtime` role & the two-writer grant boundary (Phase 2 ·
  Phase F).** Standalone bootstrap SQL (`db/bootstrap/billrun-db-roles.sql` +
  `.ts` runner, `npm run db:bootstrap-billrun-roles`), **not** a Drizzle
  migration (creating a role needs `CREATEROLE`, which `app_migrate` lacks) —
  exact analogue of `rating-db-roles.sql`. Creates the least-privilege
  `billrun_runtime` login (CONNECTION LIMIT 20) the workflow-management
  component's bill-run processor/distributor connect as, making the phase-2
  "two writers on `billing`" boundary a database privilege:
  - `customer_bill` — column-scoped `SELECT`/`INSERT`/`UPDATE` on the trial
    columns only, excluding the three posting stamps
    (`ref_inv_document_id`/`posted_attempt`/`charge_checksum`) from **both**
    `INSERT` and `UPDATE` — INSERT-exclusion closes a hole the
    finalization-latch trigger (bm13/`0033`) doesn't cover (it blocks
    UPDATE/DELETE of a finalized row, not an INSERT that pre-sets the latch).
    No table-level `DELETE`; deletes go through the scoped `SECURITY DEFINER`
    `billing.billrun_delete_trial_bill(run, ban)` (one account's non-finalized
    bill in one run — a table grant can't be predicate-scoped).
  - `customer_bill_tax_item` — fully worker-owned (`SELECT`/`INSERT`/
    `UPDATE`/`DELETE`); `app_runtime`'s write grant is revoked (kept
    `SELECT`) since phase 2 moves Taxation into the flow.
  - `rating.udr_rated` — `SELECT` + `UPDATE` on the same six claim columns
    `app_runtime` already holds (rating rm03), plus a **role-aware transition
    trigger** (`rating.billrun_status_guard`, fires only when
    `session_user = 'billrun_runtime'`) constraining it to the
    `RATED → BILL_DRAFT` claim — the six-column grant alone can't stop it
    writing `BILL_APPROVED`/`REJECTED`, since a column grant can't bind a
    value to a role.
  - `SELECT`-only on `bill_run`/`bill_run_account`/`billing_account`/
    `bill_cycle`; explicit `REVOKE` of all writes on run-state tables +
    `billing.document` + the four pgledger `SECURITY DEFINER` functions; no
    grant of any kind on the `kestra` database.
  - **Ordering is load-bearing (D15)**: a `DO` block (Step 0) fails loudly
    with `ORDERING:` unless rating's `REVOKE CONNECT ... FROM PUBLIC` has
    already run — provisioning order is `db:bootstrap-roles →
    db:bootstrap-rating-roles → db:bootstrap-billrun-roles`
    (`db:bootstrap-kestra-roles` is a parallel, unrelated branch).
  - New DB-gated guardrail suite,
    `tests/db/billrun-db-roles.integration.test.ts` (mirrors
    `tests/rating/grants.integration.test.ts`), asserting every **can**/
    **refused** boundary per column/table/function/database, the transition
    trigger, the Step 0 ordering guard, and re-run idempotency/convergence —
    written and statically verified (imports cleanly, skips loudly under
    `DATABASE_URL` unset) but **never executed** (see Outstanding).
    `.env.example` gains `BILLRUN_RUNTIME_DATABASE_URL` (dummy value);
    `infra/docs/db-role-verification.md` gains the password/provisioning-order
    steps and verification SQL.

- **bm15 — `_SAMPLE_*` scenario seed & placeholder-mode rename (Phase 2 ·
  Phase F).** Two independent halves in one unit:
  - **`npm run db:seed-sample`** (`db/seeds/sample/seed-billrun-sample.ts` +
    `udr-rated-sample.ts` + `get-or-create-appuser.ts`) — opt-in, prod-guarded
    (`DATABASE_URL` host allow-list + `NODE_ENV`, override via
    `ALLOW_SAMPLE_SEED=true`), **never added to `db:setup`** (a new
    `tests/guardrails/billing-sample-seed-boundary.test.ts` grep-gate fails
    the build if it ever is). Builds one `_SAMPLE_` customer → 3 billing
    accounts (2 full-period + 1 mid-period-start partial) → active
    subscriptions against a dedicated `_SAMPLE_` product offering (the
    catalog's own `db:seed-product` offerings are all `billingOnly: false`,
    which fails `createOrder`'s ORDERABLE precondition) → unclaimed
    `rating.udr_rated` charges (`status='RATED'`, plus a `BILL_NOTUSED` pair
    on one account) for the two full-period accounts, via the D28 stand-in
    factory `buildSampleUdrRatedRow` (computes `partition_period` by calling
    rating's own `rating.period_of()` SQL helper, never re-derived in JS, so
    the table's CHECK can never drift from it). Idempotent: keyed on the
    customer's registration number (`_SAMPLE_-BILLRUN-0001`), a re-run purges
    the prior graph (FK-safe order) and rebuilds.
    - **New architectural carve-out**: this is the first seed to call the
      app's own services (`createCustomer` → `onboardCustomerAccounts` →
      `transitionCustomerStatus` → `createOrder`, which self-invokes
      `instantiateOrder`) rather than hand-rolling repository inserts, so the
      fixture can't drift from what the app actually produces. That crosses
      `eslint.config.mjs`'s deny-by-default `db → services` boundary; resolved
      with a narrowly-scoped `db-seed-sample` element (`db/seeds/sample/**`
      only) carved out ahead of the general `db` rule, mirroring the file's
      existing `auth-roles`/`root-page`-style carve-outs.
    - **Resolved ambiguity**: `onboardCustomerAccounts` hardcodes its FA/BAN
      names (`"Financial Account"`/`"Master Billing Account"`) and can't be
      parametrized, so BAN #1's names are fixed up with a plain `UPDATE`
      immediately after the real onboarding call (not re-deriving the
      pgledger wiring it already did correctly). BAN #2/#3 have no owning
      service at all (no "add another billing account to an existing FA"
      service exists yet) — self-provisioned the same way
      `db/seeds/ordering-inventory.ts` does for its own story, reusing FA #1's
      `unapplied_cash`/`deposits` bindings and adding their own `receivables`
      binding.
    - **Resolved ambiguity**: the spec's precedent doc
      `_assessment-seed-files-strategy.md` does not exist anywhere in this
      repository (confirmed via repo-wide search) — its §3/§5 "Sample" seed
      class addition was skipped rather than fabricated; only
      `billmgmt-progress-tracker.md` (this entry) documents the decision.
  - **`STUB_DATA_MODE` → `BILLRUN_PLACEHOLDER_MODE` rename**, mechanical
    through `lib/config.ts` (accessor `stubDataMode` →
    `isBillrunPlaceholderMode`), `.env.example`, every consumer (the three
    bill-run pages, `bill-run-list.tsx`'s/`run-action-card.tsx`'s
    `stubDataMode` prop → `placeholderMode`), and their tests.
    `components/billing/stub-data-banner.tsx` renamed to
    `placeholder-banner.tsx` (`StubDataBanner`/`StubBadge` →
    `PlaceholderBanner`/`PlaceholderBadge`), copy replaced with the Phase-2
    review fold **D-T4** two-part message (names what's REAL — approval,
    posting, invoice numbers, rendered PDFs, distribution — not just what
    isn't). `billmgmt-ui-context.md` §6 and the two component-name references
    in `billmgmt-code-standards.md`/`billmgmt-ai-workflow-rules.md` updated to
    match. Grep-clean: no `STUB_DATA_MODE`/`StubDataBanner`/`stubDataMode`
    reference remains outside historical spec docs (bm01–bm13, left as
    written history) and this tracker.

- **bm16 — Engine Registry · Two-Execution Columns · `bill_run_processing`
  Flow (Placeholder) · M2M Record-Only (Phase 2 · Phase G, the centerpiece).**
  See `context/billing-management/specs/bm16-processing-flow-engine-registry.md`.
  Moves the processing pipeline off the app and onto the bill run processor:
  - **`services/billing/engine-registry.ts`** (new) — resolves the logical
    `billrun` engine by name to a connection + a stable identity string
    (`"billrun@<host>/<namespace>"`, or `"billrun@stub/<namespace>"`
    unconfigured), sourced from `lib/config.ts`'s extended
    `billRunEngineConfig` (`BILLRUN_ENGINE_URL`/`_AUTH`/`_NAMESPACE`, the last
    defaulting to `"billrun"`). `services/billing/engine-client.ts` is trimmed
    to a pure HTTP client — `startExecution`/`getExecutionStatus`/
    `killExecution` now take an explicit `EngineConnection`, reading no config
    of their own; `getEngineClient()` is gone. `trigger-run.ts`/
    `reconcile-run.ts`/`cancel-run.ts`/`rerun-run.ts` call `engineRegistry`,
    never the client directly.
  - **Migration `0035_bill_run_two_executions.sql`** (hand-authored, plain
    `ALTER TABLE` — `bill_run` isn't partitioned) — renames
    `workflow_execution_id/_definition_id/_definition_revision` to
    `processing_execution_id/_flow_id/_flow_revision` and adds
    `processing_engine_ref` + the four nullable `distribution_*` columns
    (bm20 populates them). `db/schema/billing/bill-run.ts` and every consumer
    (`bill-run.repository.ts`'s `markProcessing`/`markRerunProcessing`/
    `cancel`, `trigger-run.ts`, `reconcile-run.ts`, `cancel-run.ts`,
    `rerun-run.ts`) updated; `tsc`/lint green.
  - **`flows/billrun/bill_run_processing.template.yml` + `README.md`** (new) —
    a commented, undeployed Kestra skeleton documenting the six-stage
    per-account contract, each real activity a `# STUB:` marker. The real
    flow ships from a separate workflow-management repo — its name, owning
    team, and deploy step are `TBD` in the README (spec review fold T3; see
    Outstanding) pending that repo's existence. `billmgmt-architecture.md` §2
    and `billmgmt-code-standards.md` §7 record this as a deliberate deviation
    from rating's "all flow YAML lives externally" convention — `flows/rating/`
    stays untouched.
  - **`services/billing/handle-stage-signal.ts` — record-only (D5).** Every
    stage is now recorded exactly as signalled, none computed: the Phase-1
    Validation override (`validate-account.ts`) and the Aggregation/Taxation
    write side effects (`aggregate-bill.ts`/`taxation.ts`) are gone — the
    processor already wrote the stage's bill-data itself, as
    `billrun_runtime`, before signalling (write-then-signal, D6). The
    idempotency latch, the run-PROCESSING guard, and the stale-attempt no-op
    (T14 — the signal's attempt is asserted against the account's current
    attempt, satisfied by the pre-existing bm12 hardening) are unchanged.
    `verification` stays the terminal stage (unchanged resolved ambiguity,
    revisited when distribution stages land in bm20).
  - **Fork B — Phase-1 app-side compute retired.**
    `services/billing/{validate-account,aggregate-bill,taxation,verify,
    collect-claim}.ts` and their tests are deleted. `rerun-run.ts`'s inline
    Aggregation/Taxation re-derivation (bm08) is retired with them — the
    re-triggered processor re-claims and re-derives through the single
    `handle-stage-signal` path now, so rerun no longer touches
    `customer_bill`/`customer_bill_tax_item` itself. The now-orphaned
    repository writes (`customerBillRepository.{deleteTrial,insertTrial,
    findUnpostedBill,recomputeTotals,findUnpostedTotalForVerification,
    listUnpostedBillAccountIds}`, `customerBillTaxItemRepository
    .replaceForBill`, `billRunRepository.stampTaxRateVersion`) are removed
    too — zero callers remained after the five service files were deleted.
    Two new guardrail tests replace the old `collect-claim.test.ts` structural
    assertion: `tests/guardrails/billing-rating-write-boundary.test.ts` (no
    `db/repositories/billing/*.ts` writes `rating.*` — the claim is
    exclusively the processor's until `udr-status.repository.ts` lands, bm17)
    and `tests/guardrails/billing-trial-bill-compute-boundary.test.ts` (the
    five services are gone; the trial-bill/tax-item repository writes are
    gone; the only remaining app-side `customer_bill` write is
    `post-run.ts`'s posting-stamp `stampPosted` call, which `app_runtime`
    keeps per bm14).
  - **`tests/db/billing-e2e-happy-path.integration.test.ts`** (bm13's ship-gate
    journey) updated for record-only stages: two new helpers
    (`simulateProcessorAggregation`/`simulateProcessorTaxation`) stand in for
    the processor's write-then-signal, issued immediately before the matching
    stage signal — there is no live engine in this environment to produce the
    real write. DB-gated, statically verified only (see Outstanding).
  - **Resolved ambiguity (supersedes bm04/bm05/bm06/bm07 entries below):**
    the "Resolved Spec Ambiguities" bullets describing Validation/Collection/
    Verification as app-computed overrides and Aggregation/Taxation as
    app-side writes describe Phase 1 only and are superseded by this unit —
    left as written history rather than rewritten in place.

## Post-Review Hardening — notable fixes only

Every unit above went through at least one code-review pass; only fixes with
lasting behavioral relevance are kept here (full findings lists are in prior
file history).

- **bm02**: formula-safe CSV (`lib/csv.ts`), tab-scoped status filter,
  pagination clamped to last real page, materialization failure degrades
  gracefully, one business-`today` resolved once. Period-window DB CHECKs
  added (`0026`).
- **bm03–bm05**: stage error diagnostics preserved unless already terminal;
  malformed M2M JSON → 422 not 500; stage-signal body `strictObject`;
  snapshot insert batched (1000/stmt, bind-parameter limit); **aggregation
  writes a bill only for a `PROCESSING` account** (was reachable via
  untrusted M2M for EXCLUDED/PENDING/terminal accounts); terminal stage
  requires past-PENDING before completing; constant-time token compare
  guards byte length, not UTF-16 length; trial delete keys on the UNIQUE +
  latch only (not `category='trial'`, which could skip a real row).
- **bm06**: tax-item FK is `ON DELETE CASCADE` (rerun needs to wipe stale
  items with the bill); `replaceForBill`'s DELETE gained the finalization
  latch guard too (self-protecting, not reliant on caller pre-filtering);
  `listForRun` joins the full composite key (partition pruning); empty
  `BILLRUN_TAX_RATE=` no longer silently taxes at 0%.
- **bm07**: Errors read gained a sequence-monotonic tiebreaker (deterministic
  latest-failure pick); a SOFT verification finding no longer stamps a
  `PROCESSED` account's error fields; Uncharged recovery link degrades to a
  plain hint for a `billrun_view`-only viewer instead of dead-ending at
  `/no-access`.
- **bm08**: **[CRITICAL]** inline re-derivation no longer (a) throws an
  untyped error that rolled back the whole rerun when re-taxing an account
  with no trial bill, or (b) bills an account that never passed Validation —
  fixed by re-deriving only accounts that already have an unposted bill.
  Derived-counter cache extracted to a shared `computeRunCounters` helper.
  `accountIds` length-capped at 5000. Uniform rerun attempt (`SET`, not
  per-row `+1`).
- **bm09**: no behavioral fixes beyond the unit itself (additive-only,
  verified against the existing Accounts posting/period-close paths).
- **bm10**: no CRITICAL findings; minor UX/consistency fixes only.
- **bm11**: none beyond the unit's own no-double-post design, verified by
  review.
- **bm12–bm13** (two review rounds):
  - CANCELLED runs gained a re-trigger control on the detail header (was
    otherwise unreachable — a re-trigger, not a rerun, since `rerunRun`
    rejects `CANCELLED`).
  - `realEngineClient.getExecutionStatus` wraps a malformed 2xx body in
    `EngineError` instead of leaking a raw `SyntaxError`.
  - **Stale-attempt stage signals now rejected** — a straggler signal from a
    superseded execution (post cancel+re-trigger) could otherwise land on a
    fresh stage row and wrongly re-advance the current attempt's account;
    account status + `attempt_count` are now read once under the lock before
    any effect, and a mismatched attempt is an accepted no-op.
  - Route-inventory verb lock hardened (also forbids HEAD/OPTIONS, catches
    every export syntax).
  - **Re-trigger of a CANCELLED run now refuses a CLOSED accounting period**
    (new `PERIOD_CLOSED` result) — previously it would run the whole
    pipeline only to fail every INV at post with no reopen path.
  - **Re-trigger now clears the killed attempt's unposted trial bills** (was
    only clearing `bill_run_account`) — an account re-scoped away on the new
    attempt could otherwise leave a stale bill visible on Customers & Bills.
  - `reconcileRun` no longer bumps the heartbeat on the genuine-mismatch
    branch (was silently hiding a stuck run's `StallBanner` for another full
    threshold window).
  - Deferred (latent, gated on the not-yet-wired real engine): holding the
    `bill_run` lock across the engine HTTP call in reconcile/cancel; only 4
    of Kestra's execution states recognized. Both revisit when the real
    `EngineClient` is wired — the stub is synchronous today, so neither is
    live yet.

## Architecture Decisions

- **Permission names are snake_case** (`billrun_view/operate/approve`),
  matching the delivered Accounts pattern.
- **Three permissions, not one with levels** — segregation of duties
  (four-eyes: operate and approve must be independently grantable).
- **Permission rows in a migration; grants in a seed** (established split).
- **`billrun_*` are optional permissions** — the resolver omits ungranted
  permissions; avoids rippling `null` into every hardcoded
  `EffectivePermissionMap` fixture.

## Resolved Spec Ambiguities (kept so they aren't re-litigated)

- **bm04** — `POST .../status` body is `{ status: "PROCESSING_FAILED",
  error_detail? }` (never accepts a pushed `PROCESSED` — that status is
  always *derived*). `verification` is the terminal stage for this release
  (moves to `distribution` when posting/rendering/distribution stages
  land). `EXCLUDED` counts as run-recompute-terminal alongside
  `PROCESSED`/`PROCESSING_FAILED`. Validation's outcome overrides the
  caller's signal body (app-computed).
- **bm05** — Collection is app-computed (always `DONE`, no-op); Aggregation
  stays pass-through for its own stage row but triggers the `customer_bill`
  write as a side effect. `tax_total="0.00"`/`total_amount=subtotal` until
  bm06. Synthetic stub subtotal: `100.00 + (BAN suffix mod 1000) × 7.50`, sen
  arithmetic — the *mechanism* (pure fn of BAN id) matters, not the
  constants.
- **bm08** — Re-derivation gated on `fromStage` (`aggregateBill` when
  `fromStage <= aggregation`, `taxBill` when `<= taxation`). Empty
  `accountIds` ⇒ all eligible (excludes `EXCLUDED` + posted). Empty reason
  → `VALIDATION_ERROR` (matches the sibling trigger-action convention, not
  the spec's literal `VALIDATION_FAILED` string). Rerun uses one uniform
  attempt = `max(selected) + 1`. Rerun does not re-stamp `triggered_by`
  (four-eyes concern, deferred to bm10 — the DB backstop still compares
  against the *original* trigger actor).
- **bm12** — Check status IS audited (`BILL_RUN_RECONCILED`, every operator
  mutation writes exactly one audit row). Engine `KILLED` is treated the
  same as `FAILED` (both → `PROCESSING_FAILED`; revisit only if a future
  unit wants `KILLED` to route straight to `CANCELLED`). A `SUCCESS`-but-
  not-all-terminal reconcile never forces a status (re-derive via
  `computeRunStatus`, or return `mismatch: true` with no write — forcing
  would violate Inv. #12). Re-trigger from `CANCELLED` bumps the attempt
  (never reuses attempt 1 — would collide with the killed execution's stage
  rows under the idempotency latch). `resetForCancel` excludes `EXCLUDED`
  accounts (never re-entered into the pipeline, matching bm08's rerun
  convention).

## Session Notes / Environment Quirks

- Context docs live under `context/billing-management/` (renamed from an
  earlier `billling-management` triple-l typo).
- **Pre-existing, unrelated to this module**: 4 hardcoded-date-drift test
  files (`tests/actions/{create-order,resume,suspend,terminate}-
  subscription*`) fail on a clean baseline — dates now >3 days in the past
  vs. today. Confirmed via `git stash`/`git status` at every unit that this
  module never touches those files — reconfirmed at bm15 (same 14 failures,
  byte-identical, on both the pre-bm15 baseline and the bm15 working tree).
- `tests/services/billing/trigger-run.service.test.ts` needs `DATABASE_URL`/
  `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL` set in the shell (its import graph
  eagerly validates the full env schema on load) — fails with a `ZodError`
  otherwise, unrelated to any billing change.
- `tests/accounts/grep-gates.test.ts` has one BAN-narrowing false positive
  on `db/repositories/billing/bill-run-account.repository.ts`, present since
  bm09 and not touched by later units.
- All hand-authored partitioned-table migrations (`0027` bill_run_account,
  `0028` bill_run_account_stage, `0029` customer_bill, `0030`
  customer_bill_tax_item, `0033` finalization trigger) follow the `0001_
  audit.sql` precedent (Drizzle can't express `PARTITION BY`) — generated/
  reviewed but not yet applied anywhere; run `db:migrate` then
  `db:setup-partman-billing` in that order wherever the database lives.
- The four partitioned billing tables share one `partman.create_parent`
  registration each (monthly, 4-premake, 7-year detach-not-drop — distinct
  from `audit_log`'s drop-on-expiry) and the existing shared
  `run_maintenance_proc()` daily cron covers all of them; no second cron job
  was ever added.

## Open Questions

- None.

## Next Up

- **bm01–bm16 are all delivered.** The remaining action items are
  environmental (see Outstanding, above): apply migrations `0033`/`0035`, run
  `db:bootstrap-billrun-roles` (after `db:bootstrap-roles` and
  `db:bootstrap-rating-roles`), run the DB-gated suites (incl. the updated
  `billing-e2e-happy-path.integration.test.ts`) against a real Postgres, and
  run `db:seed-sample` there to verify bm15's checklist.
- **bm16's live-Kestra smoke gate is unmet** — no deployed `billrun` engine or
  real `bill_run_processing` flow exists yet; the separate workflow-management
  repo/owner/deploy step are `TBD` in `flows/billrun/README.md`. Register the
  smoke run as a phase-2 exit criterion when bm21 (not yet specced) lands.
- Phase 2 · Phase G continues past bm16 (units after it, incl. bm17's
  `udr-status.repository.ts` — the app's own RATED-release/BILL_APPROVED/
  REJECTED transitions — and bm20's distribution execution columns) — not yet
  specced in this session.
