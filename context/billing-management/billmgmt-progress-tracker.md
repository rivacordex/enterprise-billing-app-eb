# Progress Tracker

Update this file after every meaningful implementation change.

> **Pending restructure — `context/workflow-management/specs/wfm01-engine-restructure.md`.** Path references below (`flows/billrun/…`) record the **current** on-disk layout and stay accurate until `wfm01` executes in the code repo. After that move they become function-first: `workflow-management/flows/bill-run-processor/…` and `workflow-management/flows/bill-run-distributor/…`. Do not rewrite historical entries pre-emptively.
>
> **~~Pending~~ — `wfm01` HAS executed (commit `0b31f50`, on `dev1`).** The note
> above is retained as history: `rating-engine/` is now `workflow-management/`
> and the function-first flow paths it describes are the live layout. Historical
> entries below are deliberately NOT rewritten, per that note — read any
> `rating-engine/…` or `flows/billrun/…` path below as its
> `workflow-management/…` equivalent.

> **2026-09-11 — local dev stack re-provisioned and verified on the post-`wfm01`
> layout.** Brought up from a full `down -v` with:
>
> ```
> docker compose -f docker-compose.dev.yml -f workflow-management/dev/docker-compose.dev.yml up -d --build
> ```
>
> Seven services: `db` (:5432), `setup`, `app` (:3000), `azurite` (:10000),
> `kestra-setup`, `workflow-engine` (Kestra 1.3.35, :8085) and the new one-shot
> `flow-deploy`. There is **no Caddy/`engine-tls` service** — the local TLS
> proxy was an unpushed experiment and is not needed; the app talks to the
> engine over plain HTTP locally.
>
> Verified facts (supersede any "not applied"/"never started"/"no local Postgres"
> wording below):
>
> - **39 migrations applied**; **9 `partman.part_config` parents** registered
>   (`core.audit_log`, the six `billing.*`, `rating.process_log`,
>   `rating.udr_rated`); `cron.job` holds `audit-log-partman-maintenance`.
> - **Every seed ran** (admin, RBAC/14 permissions, product, customer, accounts,
>   ordering, billing, rating catalog). `azurite` is serving, and Kestra is
>   actively using its `kestra-internal` blob container.
> - **The `billrun` namespace now exists.** `flow-deploy` deployed all six flows
>   idempotently (`--no-delete`): `rating.{ran-usage-rating, completeness-check,
>   log-sweep, stranded-batch-reconcile}` and `billrun.{bill_run_processing,
>   bill_run_distribution}`. This closes the "no `billrun` namespace / no flows"
>   half of bm16/bm20's live-Kestra smoke gate; the gate itself still needs a
>   real triggered run asserted end to end.
>
> **Three bring-up fixes applied (they had existed only in an uncommitted working
> tree and were lost in a reset, so the committed stack could not start):**
>
> 1. `docker-compose.dev.yml` — `setup` ran `db:setup && db:setup-partman`, but
>    `db:setup` already chains `db:setup-partman{,-billing,-rating}`. The
>    trailing call is removed.
> 2. `workflow-management/dev/docker-compose.dev.yml` — `kestra-setup` had no
>    `depends_on` and raced both `db` and `setup`. It and `setup` share the
>    `node_modules` volume and both run `npm install`; the concurrent installs
>    corrupted it (observed: `ENOTEMPTY … rmdir '/app/node_modules/rolldown/dist'`
>    in `setup`, `TAR_ENTRY_ERROR` in `kestra-setup`), which needs a `down -v` to
>    recover. Now gated on `db` healthy + `setup` completed.
> 3. `db/bootstrap/{audit,billing,rating}-partman-setup.sql` — all nine
>    `create_parent` calls are wrapped in an
>    `IF NOT EXISTS (SELECT 1 FROM partman.part_config …)` guard. `create_parent`
>    is not idempotent (it aborts with
>    `duplicate key value violates unique constraint "part_config_parent_table_pkey"`),
>    so **any** `setup` re-run against a persisted `pgdata` failed the whole
>    bootstrap and blocked `app` on `service_completed_successfully`. Verified
>    after the fix: a plain `down` + `up -d` on preserved volumes re-ran `setup`
>    to **exit 0** with all data intact. A `down -v` is no longer required to
>    restart the stack.
>
> Still genuinely outstanding: a real posted run, `db:seed-sample`'s checklist,
> the DB-gated integration suites, and bm18's Chromium-in-container render. The
> DB-gated suites must **NOT** be pointed at this stack's `DATABASE_URL` — they
> `DROP SCHEMA … CASCADE` and would wipe the seed data just provisioned.

_Compressed 2026-08-26 — build plan is complete; per-unit narrative and test-file
enumerations were trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`._

## Current Phase

- Phase 2 · Phase I — **bm21 (Phase-2 Ship Gate) — delivered** (audit +
  cross-cutting closures; DB-gated proof still environmental, see
  Outstanding). See
  `context/billing-management/specs/bm21-phase2-ship-gate.md` and the
  Delivered Units entry below. **Phase 2 (bm14–bm21) is feature-complete.**
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
- Phase 2 · Phase G — **bm17 (`udr_rated` Approve/Reject/Release Lifecycle +
  Reject Action) — delivered.** See
  `context/billing-management/specs/bm17-udr-lifecycle-reject.md` and the
  Delivered Units entry below.
- Phase 2 · Phase H — **bm18 (Rendering Foundation + Draft PRO-FORMA
  Preview) — delivered.** See
  `context/billing-management/specs/bm18-rendering-draft-preview.md` and the
  Delivered Units entry below. The container-build/render proof (bm18's
  checklist item 1) is statically reviewed only — no container runtime was
  reachable to actually `docker build` the image and render a PDF from it;
  see Outstanding.
- Phase 2 · Phase H — **bm19 (Posting on Real Charges + Final Render &
  Store) — delivered.** See
  `context/billing-management/specs/bm19-posting-real-charges-final-render.md`
  and the Delivered Units entry below. Migrations `0036`/`0037` are
  generated/reviewed but **not applied**, and the render/store step is
  unproven against a real blob store or a real Chromium browser in this
  environment — see Outstanding.
- Phase 2 · Phase H — **bm20 (Distribution Flow + `bill_run_distribution` +
  Distribution Tab) — delivered**, including the 2026-08-28 Phase-2 review
  folds (T1/T2/T11/D-T1/D-T3) that were already folded into the spec. See
  `context/billing-management/specs/bm20-distribution-flow.md` and the
  Delivered Units entry below. Migration `0038_bill_run_distribution.sql` is
  generated/reviewed but **not applied** — see Outstanding.

## Outstanding (environmental only — not a build unit)

- Migrations `0033_customer_bill_finalization_guard.sql` (bm13 — DB trigger
  enforcing the `ref_inv_document_id` finalization latch),
  `0035_bill_run_two_executions.sql` (bm16 — the `workflow_*` → `processing_*`
  rename + `distribution_*`/`*_engine_ref` columns),
  `0036_bill_run_invoices.sql` (bm19 — the stored-invoice table + its
  immutability trigger), and `0037_document_customer_bill_latch.sql` (bm19
  T5 — the structural one-INV-per-bill latch, plus the two CodeRabbit-review
  CHECKs: customer-bill ref both-null-or-both-set + INV-only) are
  generated/reviewed but **not applied**.
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
- **Kestra Basic-Auth username is a coupled triple — update the Key Vault
  secret on any rename.** The operator login was renamed
  `rating-ops@example.invalid` → `workflow-ops@billing.ops` across
  `workflow-engine-container-app.bicep` (engine accepts), `azure-pipelines.yml`
  `deploy_workflow_flows` (`--user`), and the local `.env`/`dev/.env.example`.
  The APP authenticates to the engine via the **out-of-band `billrun-engine-auth`
  Key Vault secret** (billing's `engine-client.ts` base64-encodes the whole
  `<username>:<password>`), which is NOT in git — its username half must be
  updated to `workflow-ops@billing.ops` in lockstep, or every app→engine call
  (trigger / check-status / cancel) 401s after the next deploy against a live
  engine. **Action before next prod deploy:** rotate `billrun-engine-auth` so its
  username matches.
- **bm16/bm20's live-Kestra smoke gate is unmet** (spec review fold T3,
  formalized as an explicit 3-item phase-2 exit criterion by bm21 — see
  `flows/billrun/README.md`): no deployed `billrun` engine or real
  `bill_run_processing`/`bill_run_distribution` flow exists anywhere yet —
  the separate workflow-management repo, its owning team, and its deploy
  step are still `_TBD_`. bm21 shipped the runnable half
  (`npm run billrun:live-kestra-smoke`, wired as the off-by-default
  `billrun_live_kestra_smoke` Azure Pipelines stage) but it has **never
  been run against a real engine** — there isn't one. Run it (and resolve
  the three `_TBD_` lines) once a real `billrun` namespace exists.
- `bill_run.ref_tax_rate_version`'s only writer (`stampTaxRateVersion`,
  `services/billing/taxation.ts`) was retired with bm16 Fork B — no app or
  processor writer is specced for it yet (`billrun_runtime` holds no
  `bill_run` write grant, bm14 Step 9). The column stays reserved/unpopulated;
  not addressed by bm16 — revisit if a future unit needs run-level tax-version
  provenance.
- **bm18's container-image Chromium proof is unverified end-to-end.** No
  container runtime was reachable in this environment to `docker build .`
  against the new `node:22-bookworm-slim`-based `Dockerfile` and confirm
  `renderDraftInvoice` actually produces a PDF from *that* image (only a dev
  machine with Playwright installed via `npm install` was exercised, via
  unit/integration-style tests that mock Chromium — see
  `infra/docs/rendering-image-size.md`'s Verification section). Build and
  smoke-test the image before treating bm18 as ship-ready. The local Docker
  dev stack (`docker-compose.dev.yml`) was deliberately **not** migrated off
  `node:22-alpine`, so `Preview PRO-FORMA →` will fail there too until that
  stack is revisited — same category of gap.
- **bm19's render/store step is unproven against real infrastructure.** No
  container/Docker runtime, reachable Postgres, or installed Chromium was
  available in this environment, so: (1) the `azurite` docker-compose
  service has never actually been started and connected to; (2)
  `renderFinalInvoice`/`blobStore.putInvoice` have only ever run against
  mocked Playwright/`@azure/storage-blob` (unit tests) — never a real
  Chromium render into a real (even emulated) blob store; (3) migration
  `0036`'s partitioned table + immutability trigger + the fifth
  `partman.create_parent` registration have never executed against a real
  Postgres (same gap as every other DB-gated item above). Before treating
  bm19 as ship-ready: apply `0036`, run `db:setup-partman-billing`, bring up
  `docker-compose.dev.yml` (or a real Azure Storage account), and post a run
  end-to-end to confirm a `bill_run_invoices` row + a real blob object are
  produced and the stored-invoice download route serves bytes matching the
  stored checksum.
- **bm20's migration and live-engine paths are unproven, same category of gap
  as every unit above.** Migration `0038_bill_run_distribution.sql` (the
  `bill_run.distribution_attempt` column + the new partitioned table) is
  generated/reviewed but **not applied**; `db:setup-partman-billing` now
  registers a sixth parent (`bill_run_distribution`) and must be re-run.
  `triggerDistribution`/`rerunDistribution` were only ever exercised against
  the mockable `stubEngineClient` (unit tests) — no deployed `billrun` engine
  hosts a `bill_run_distribution` flow anywhere (the same gap bm16 recorded
  for `bill_run_processing`; `flows/billrun/README.md`'s owning team/repo/
  deploy step are still `TBD`). Before treating bm20 as ship-ready: apply
  `0038`, run `db:setup-partman-billing`, deploy a real (or placeholder)
  `bill_run_distribution` flow built to `flows/billrun/
  bill_run_distribution.template.yml`'s contract, and post a run end-to-end
  to confirm the loopback delivers, `bill_run_distribution` rows land, and a
  forced failure + Rerun/force-complete actually reaches `COMPLETED` against
  the live engine.
- **`tests/db/billing-e2e-happy-path.integration.test.ts` (the ship-gate
  journey) — extended by bm21 for the reject leg + the D10 safety net (T8);
  still DB-gated and unexecuted in this environment.** History: fixed for
  bm20's lifecycle by a 2026-09-09 CodeRabbit review fold (`POSTING →
  INVOICED` then a separate `triggerDistribution` call, landing on
  `DISTRIBUTING` rather than the bm11-era immediate `COMPLETED`). bm21 then
  replaced the old "rerun a subset" demonstration with a real reject →
  blocked-approval → rerun-rejected → re-process leg (bm17 model (b)), and
  — because auditing the D10 gap (T8) surfaced a genuine unenforced
  correctness hole (see the bm21 Delivered Units entry) — changed what the
  distribution tail now asserts: the run reaches `DISTRIBUTION_FAILED`
  (not a silent `COMPLETED`) while `banBilled` is render-pending, then a
  simulated retry-render + real `rerunDistribution` + a second
  `recordDistributionOutcome` reaches `COMPLETED` for real. Every DB-gated
  suite in this module (this file, `billrun-db-roles`, `materialize-runs`,
  `trigger-run`, and the rest) remains written and statically verified
  (imports cleanly, `tsc`/lint clean, `describe.skipIf(!databaseUrl)`) but
  **never executed against a real Postgres in this environment** — per this
  session's own memory/established convention, DB-gated integration tests
  are never run against the shared local dev DB (it would wipe seed data
  and break login); run them against a disposable/CI database before
  treating bm21 (or anything in Phase 2) as end-to-end proven.

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

- **bm17 — `udr_rated` Approve/Reject/Release Lifecycle + Reject Action
  (Phase 2 · Phase G).** See
  `context/billing-management/specs/bm17-udr-lifecycle-reject.md`. Lands the
  app's own half of the `udr_rated` lifecycle — the processor (bm14/bm16)
  owns only the `RATED`/`REJECTED → BILL_DRAFT` claim; the app owns the three
  human-gate transitions:
  - **`db/repositories/billing/udr-status.repository.ts`** (new) — the app's
    only `UPDATE rating.udr_rated`, the phase-2 flip of the bm13/bm16
    guardrail (`tests/guardrails/billing-rating-write-boundary.test.ts`, now
    asserting this is the app's SOLE sanctioned writer, column-scoped to the
    six claim columns). Three functions, each run inside the caller's txn:
    `markApproved` (`BILL_DRAFT → BILL_APPROVED`, run-scoped), `markRejected`
    (`BILL_DRAFT → REJECTED`, account-scoped), `release` (`BILL_DRAFT →
    RATED` + clears the claim columns, run- or account-scoped) — the
    `status = 'BILL_DRAFT'` predicate on every write is what guarantees none
    ever touches a `BILL_APPROVED`/posted row.
  - **Reject — model (b), operator reruns, run stays `PROCESSED`.**
    `services/billing/reject-run.ts` (`reject-run.schema.ts` validates
    `{billRunId, scope: 'all'|'selected', banIds[], reason}`, empty reason ⇒
    `VALIDATION_ERROR`) — one txn: guard `PROCESSED` → resolve the eligible
    set (only `PROCESSED`/postable accounts, minus any posted — a
    `PROCESSING_FAILED`/`EXCLUDED` account has no trial bill and is already
    headed for `SKIPPED` at approval, not "sent back to reprocess") → AUDIT
    FIRST (`BILL_RUN_REJECTED`, prior totals + reason, same discipline as
    rerun/bm08) → `udr-status.markRejected` → delete the rejected accounts'
    unposted trial `customer_bill` rows (new `customerBillRepository
    .deleteUnpostedForAccounts`, tax items cascade) → stamp the
    `REJECTED_PENDING_REPROCESS` marker (new `types/billing.ts` constant) on
    each account's latest CURRENT-ATTEMPT stage row (new
    `billRunAccountStageRepository.findLatestForAccount`/`stampMarker`).
    `bill_run_account.status` is left UNTOUCHED (still `PROCESSED` — no new
    `AccountStatus` member); the run never leaves `PROCESSED`.
  - **`no_rejected_pending`** — the 6th pre-approval check
    (`PRE_APPROVAL_CHECKS`/`PreApprovalChecksProps` extended), backed by new
    `billRunAccountStageRepository.listRejectedPendingForRun`: joins the
    marker to the account's CURRENT `attempt_count` — this attempt-keyed join
    is what makes a rerun's attempt bump implicitly clear the marker (no
    explicit "clear" write exists anywhere; Phase-2 review fold T6). Fails
    approval with remediation "Rerun the rejected accounts, then approve.";
    enforced server-side regardless of UI state.
  - **Approve** (`services/billing/approve-run.ts`) calls
    `udrStatusRepository.markApproved` inside the existing approve txn, right
    after the immutable `total_amount` stamp. **Cancel**
    (`services/billing/cancel-run.ts`) calls `udrStatusRepository.release`
    (whole-run scope) alongside the existing `resetForCancel` write — distinct
    from Reject's `REJECTED`.
  - **UI** — `components/billing/reject-dialog.tsx` (new `RejectDialog`):
    mirrors `RerunDialog`'s inline-confirmation shape AND its `accountIds`
    convention (empty ⇒ whole run, non-empty ⇒ explicit selection) rather than
    a separate scope radio control — a resolved ambiguity reading the spec's
    "reuse the RerunDialog selection pattern" literally. Mandatory reason,
    danger-role "Confirm Reject", spelled-out consequence copy. Wired next to
    "Approve & Post" on both the run-detail header and the
    `ApproveAndPostPanel` (Approve's own modal/self-approval-block behavior is
    unchanged — it already had a confirmation gate from bm10). The Errors tab
    (`errors-table.tsx`) gained a "Rejected — pending reprocess" section (new
    `RejectedPendingRow`/`listRejectedPending` read) above the HARD-error
    table, with its own "Rerun to reprocess" `RerunDialog` for a
    `billrun_operate` viewer or a plain hint for `billrun_view`-only.
  - **Audit** — new `BILL_RUN_REJECTED` event type (`Change` category, mirrors
    `BILL_RUN_RERUN`); deliberately NOT added to `TRIGGER_EVENT_TYPES` — reject
    is an approver action and does not bar the rejecter from a later approval.
  - No migration: `rating.udr_rated`'s `status` CHECK already admits
    `REJECTED` (rm01), and `error_code`/`error_detail` are unconstrained text
    columns — the marker is just a string value, no schema change.

- **bm18 — Rendering Foundation + Draft PRO-FORMA Preview (Phase 2 · Phase
  H).** See `context/billing-management/specs/bm18-rendering-draft-preview.md`.
  The platform's first in-app document rendering — app-side, ephemeral,
  stores nothing (bm19 adds storage):
  - **`Dockerfile` base image: `node:22-alpine` → `node:22-bookworm-slim`**
    across all three stages (`deps`/`builder`/`runner`), a resolved ambiguity
    beyond the spec's literal "`npx playwright install --with-deps chromium`"
    instruction — Playwright's Chromium needs glibc + `apt`, neither of which
    Alpine's musl/`apk` provide; `deps`/`builder` moved too so the one
    `node_modules` tree stays libc-consistent with `runner`. Full rationale +
    the image-size increase in `infra/docs/rendering-image-size.md` (new).
    `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` pins a fixed install path,
    `chown`ed to the non-root `nextjs` user after install. `docker-compose.
    dev.yml` deliberately left on Alpine (documented gap, Outstanding) —
    draft preview needs a bare `npm run dev` with `npx playwright install
    chromium` run once, or the built image.
  - **`services/billing/render-invoice-template.ts`** (new) — the throwaway
    HTML/CSS invoice template (D18: not `bill_template_version`), pure/DB-free
    so `buildDraftInvoiceHtml` is unit-tested without a database or browser.
    Invoice-number field is always **"— pending posting —"**; a diagonal
    **"DRAFT · PRO-FORMA · NOT A VALID INVOICE"** watermark
    (`position: fixed`, repeats on every printed page in Chromium's print
    engine) sits at `z-index: 0` **behind** an opaque `.sheet` card
    (`z-index: 1`, solid white) — the figures the reviewer opened the modal to
    check are structurally never rendered through a translucent watermark
    (ui-context §6c, new, Phase-2 review fold D-T5), rather than tuning an
    opacity/contrast ratio. Money via `formatCurrency`, dates via
    `formatCalendarDate`.
  - **`services/billing/render-invoice.ts`** (new) — `renderDraftInvoice({
    runId, banId })`: one repeatable-read read-only transaction reads the
    account's trial `customer_bill` (new `customerBillRepository
    .findForAccount`) + its tax items (new `customerBillTaxItemRepository
    .listForBill`) + the claimed `rating.udr_rated` lines (new
    `db/repositories/billing/rated-lines.repository.ts` — a plain `SELECT`
    scoped to `BILL_DRAFT`/`BILL_APPROVED`, structurally distinct from
    `udr-status.repository.ts`'s sole sanctioned `UPDATE`, verified against
    the existing `billing-rating-write-boundary` guardrail); not-found (no
    bill, or no run) throws `DraftInvoiceNotFoundError`. Launches Chromium
    per render (D19), always closes it in `finally` — bounded by a new
    process-level semaphore (`lib/concurrency.ts`'s `createSemaphore`,
    `MAX_CONCURRENT_RENDERS = 2`, Phase-2 review fold T9): excess requests
    queue rather than launch, verified by test.
  - **`app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route.ts`**
    (new) — a **session-guarded** PDF `GET` Route Handler, a deliberate,
    reviewed exception to code-standards §3.5's "`app/api/*` = M2M only"
    (same `getSession`/`resolveEffectivePermissions` shape as the existing
    `app/api/accounts/gl-journal-export` precedent, not
    `requirePermission`/`redirect` since a route can't redirect a fetch/
    iframe request): `billrun_view:READ` (403 otherwise) → parse `runId`/
    `banId` (new `validation/billing/ban-id.schema.ts` mirrors
    `run-id.schema.ts`) → a **per-session rate limit** (new
    `lib/rate-limit.ts`, in-memory sliding window, Phase-2 review fold T9) →
    `renderDraftInvoice` → streams `application/pdf` inline
    (`DRAFT-<ban>.pdf`), or 404/500 on failure. Added to code-standards §8's
    permission-map table.
  - **`components/billing/invoice-preview-modal.tsx`** (new)
    `InvoicePreviewModal` — fetches the draft route (not a bare `<iframe
    src>`) so the client drives its own loading/queued/error states (Phase-2
    review fold D-T2): an immediate PDF-shaped skeleton captioned "Rendering
    draft invoice…", switching to "Queued — rendering shortly" past a normal
    render's window, or an inline **Retry** with a plain-language reason on
    failure/timeout — never a frozen/empty frame. Built on the shared
    `Dialog` (Radix), which already provides the D-T5 a11y contract (focus
    trap, Esc-to-close, focus return) for free; adds the accessible `<iframe
    title>`. Low-emphasis **ghost** trigger ("Preview PRO-FORMA →", never the
    featured petrol or a danger role, ui-context §7), wired into
    `CustomerBillTable` (which gained a `billRunId` prop, threaded from
    `RunDetailTabs`'s existing `runId`) on the Customers & Bills tab.
  - **ui-context §6c** (new) documents the watermark-legibility mechanism and
    the shared preview-modal a11y contract (for `StoredInvoiceModal` too,
    bm19).
  - **Resolved ambiguity**: the `react-hooks/set-state-in-effect` lint rule
    flags the deliberate "reset to loading, then fetch" pattern the moment
    the modal opens — a single, commented, targeted
    `eslint-disable-next-line` at that one call site (not a blanket
    suppression) is the resolution; D-T2's "immediate skeleton" requirement is
    exactly the case this rule's underlying heuristic doesn't fit.
  - No migration, no new permission, no new env var (spec §Config/env).

- **bm19 — Posting on Real Charges + Final Render & Store (Phase 2 · Phase
  H).** See
  `context/billing-management/specs/bm19-posting-real-charges-final-render.md`.
  Posting now anchors to the real claimed `udr_rated` charge lines and, per
  account right after its `INV` commits, renders + stores the immutable
  final invoice PDF:
  - **`db/schema/billing/bill-run-invoices.ts` + migration `0036` +
    `db/repositories/billing/bill-run-invoices.repository.ts`** (new) — hand-
    authored partitioned `billing.bill_run_invoices` (`BRI`+8 seq, composite
    PK on `(bill_run_invoice_id, period_partition)`, UNIQUE `(run, ban,
    period)`, composite FK to `customer_bill`), registered as the fifth
    parent in `billing-partman-setup.sql` (monthly/7-year detach-not-drop,
    same shape as the other four). An **unconditional** `BEFORE UPDATE OR
    DELETE` trigger (`bill_run_invoices_immutability_guard`) rejects any
    mutation of an existing row — simpler than `customer_bill`'s guard
    (0033) since this table has no "unfinalized" state to distinguish, every
    row is born final. `billrun_runtime` gets no grant at all (bm14's
    billrun-db-roles.sql Step 11 already declares "no `ALTER DEFAULT
    PRIVILEGES` for it" — a new table is inaccessible to it by construction,
    with a new DB-gated assertion added to
    `tests/db/billrun-db-roles.integration.test.ts`, test #17b).
  - **Real checksum (Inv #3).** `customerBillRepository.computeChargeChecksum`
    is REPLACED (same name, new signature `(tx, billRunId, billingAccountId,
    postedAttempt)`): now `md5(COALESCE(string_agg(udr_id || ':' ||
    udr_rated_price, ',' ORDER BY udr_id), ''))` over `rating.udr_rated`
    scoped to `(billrun_ref_id, billrun_ban_id, billrun_attempt)` — computed
    entirely in SQL (code-standards §2.4), replacing the phase-1 stub formula
    that hashed `customer_bill`'s own subtotal/tax-items/total. `post-run.ts`
    passes `run.billRunId`/`billingAccountId`/`bill.attemptCount` (the
    account's current attempt, matching the processor's own claim scope)
    instead of `customerBillId`/`periodPartition`. Still no billing-side
    charge copy — the checksum reads `rating.udr_rated` directly.
  - **Render + store, separate from the posting transaction (D10).**
    `services/billing/render-invoice-template.ts` gains `buildFinalInvoiceHtml`
    (shares the internal template builder with `buildDraftInvoiceHtml` via a
    private `renderInvoiceHtml`, `isDraft` flag) — no watermark, no "pending
    posting" placeholder, the real `INV…` number. `services/billing/
    render-invoice.ts` gains `renderFinalInvoice({ runId, banId, invoiceNo })`
    — a plain (non-transactional) read (once posted, `customer_bill` is
    immutable, no concurrent-commit window to straddle, unlike the draft
    path's repeatable-read snapshot) — and shares the SAME T9 concurrency
    semaphore as draft rendering (Phase-2 review fold T9 "same render
    concurrency guard applies to final render"), via an extracted
    `renderPdfFromHtml` helper. `post-run.ts`'s `postAccount` captures the
    posted `(customerBillId, periodPartition, documentId)` inside its
    transaction, then — AFTER the transaction commits — calls a new
    `renderAndStoreInvoice` helper (render → `blobStore.putInvoice` → `bill-
    RunInvoicesRepository.insert`) wrapped in its own try/catch that
    swallows every failure: a render/store failure is recorded ONLY by the
    absence of a `bill_run_invoices` row (no new status column) and never
    rolls back the INV, blocks `INVOICED`, or aborts the posting loop.
  - **`services/billing/blob-store.ts`** (new) — `putInvoice(period,
    invoiceNo, bytes)`/`getInvoice(blobRef)` over `@azure/storage-blob`,
    path `invoices/<YYYY-MM>/<INV…>.pdf`, `checksum` = md5 of the PDF bytes
    (the SECOND checksum — Design "two checksums, two purposes": the charge
    checksum anchors the charge lines, this one anchors the stored artifact);
    the upload is write-once (`if-none-match`, see Post-Review Hardening).
    Connection resolves from `lib/config.ts`'s new `billRunBlobConfig`
    (`BILLRUN_BLOB_CONNECTION_STRING` dev/Azurite XOR `BILLRUN_BLOB_ACCOUNT_URL`
    prod); the connection-string (dev) path auto-creates the container
    (`createContainerIfNotExists`) since Azurite provisions nothing on its
    own, while the Managed-Identity (prod) path relies on the container
    already existing (a deploy-time prerequisite, unchanged from spec) so no
    extra "create container" RBAC is needed in prod.
    - **Resolved ambiguity**: the spec's Dependencies section names only
      `@azure/storage-blob` as new, but "connection via Managed Identity in
      prod" (Design) is a literal second auth mechanism, not just where a
      secret value is sourced from (unlike `BETTER_AUTH_SECRET`'s "Key Vault
      via Managed Identity" phrasing elsewhere, which is single-value/two-
      environments) — `@azure/identity`'s `DefaultAzureCredential` was added
      alongside `@azure/storage-blob` to implement it for real, rather than
      leaving prod on a connection string.
  - **`docker-compose.dev.yml`** gains an `azurite` service
    (`mcr.microsoft.com/azure-storage/azurite:3.35.0`, blob port 10000,
    named volume) + `BILLRUN_BLOB_CONNECTION_STRING` override on `app`
    pointing at the in-network `azurite:10000` host (mirrors the existing
    `DATABASE_URL` in-network-override pattern); `.env.example`'s host-facing
    default targets `127.0.0.1:10000` for a bare `npm run dev`. Both use
    Microsoft's published well-known Azurite dev account/key (never a real
    credential).
  - **Retry-render path (§Implementation §4) — standalone, not
    `postRun`-gated.** `postRun` reaches `INVOICED`/`COMPLETED` on posting
    completion regardless of render outcome (Design), so by the time an
    operator would notice a render gap the run itself may already be
    `COMPLETED` — past the point `postRun`/`postAccount` accept new
    invocations (`NOT_POSTABLE`). `retryRenderInvoice(billRunId,
    billingAccountId)` (new export, `post-run.ts`) is therefore deliberately
    independent of the run's status: checks the account is posted
    (`refInvDocumentId` set, via `customerBillRepository.findForAccount`,
    extended with that column) and not already stored
    (`billRunInvoicesRepository.findByRunAndAccount`), then re-renders +
    stores. `actions/billing/retry-render-invoice.action.ts` +
    `validation/billing/retry-render-invoice.schema.ts` wire it under the
    same `billrun_approve:EDIT` money gate as Post/Retry-failed.
  - **UI.** `components/billing/invoice-preview-modal.tsx` gains
    `StoredInvoiceModal` (no watermark, real `INV…` number, `blob_ref`/
    checksum shown via the download response's `X-Invoice-Number`/
    `X-Blob-Ref`/`X-Checksum` headers — avoids a second round-trip — plus a
    Download link; shares the D-T5 a11y contract via the same `Dialog`).
    `CustomerBillTable` is a three-way gate (bm19 CodeRabbit review): no
    `invoiceId` → the draft `InvoicePreviewModal`; `invoiceId` +
    `hasStoredInvoice` → `StoredInvoiceModal`; `invoiceId` but not yet stored
    (render-pending) → a note pointing to Posting progress, never a
    `StoredInvoiceModal` that would 404. `customerBillRepository.listForRun` +
    `CustomerBillRow`/`listAccountBills` are extended with `refInvDocumentId`/
    `invoiceId` and `hasStoredInvoice` (same `bill_run_invoices` left-join idiom
    as `listPostingProgressForRun`). `PostingProgressView` shows
    `StoredInvoiceModal` for an
    `invoiced` row with `hasStoredInvoice` (new field, derived via a second
    left-join to `bill_run_invoices` in
    `billRunAccountRepository.listPostingProgressForRun`, never a stored
    column) or a new `RenderPendingRow` ("Retry render" button, reachable
    even after the run is `COMPLETED`, unlike the main Post/Retry-failed
    button) otherwise. Download served by a new session-guarded Route
    Handler, `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/`
    (same `billrun_view:READ` / non-`app/api` carve-out as bm18's
    draft-invoice route) — delegates to a new `services/billing/read/
    get-stored-invoice.ts` (`getStoredInvoice`) rather than touching
    `db`/`blobStore` inline, since the eslint `boundaries/dependencies` rule
    forbids `app/**` → `db/**` (only `app/**` → `services/**` is allowed;
    bm18's draft route already follows this shape via `renderDraftInvoice`).
  - **Phase-2 review fold T5 [P1] — structural one-INV-per-bill latch
    (closes known-issue #2).** `billing.document` gains two nullable columns,
    `ref_customer_bill_id`/`period_partition` (migration `0037`, stamped only
    on the one `INV` a posted bill's document carries — `post-run.ts`'s
    `postAccount`), a composite FK to `customer_bill`'s composite PK, and a
    **partial UNIQUE index** on `ref_customer_bill_id` (`WHERE ... IS NOT
    NULL`) — structurally, at most one `document` row can ever reference a
    given bill, so a duplicate posted INV is a DB-refused UNIQUE VIOLATION
    regardless of the app-layer's own lock discipline.
    `customerBillRepository.stampPosted`'s existing `IS NULL` guard (and
    `lockBillForPosting`'s row lock) are now a friendly, resumable
    early-return rather than the sole backstop (unchanged code — only the
    doc comment demotes their role). The E2E ship-gate journey proves the
    latch directly via a synthetic duplicate INSERT.
  - **`tests/db/billing-e2e-happy-path.integration.test.ts`** (the ship-gate
    journey) extended: a comment documents that its checksum degrades to
    `md5('')` in this fixture (no `rating.udr_rated` rows exist for the
    synthetic BILLED account — the `toBeTruthy()` assertion is unaffected);
    a new block proves the T5 structural latch (a synthetic duplicate INV
    INSERT against the same bill is refused); another proves the account is
    left render-pending (no `bill_run_invoices` row — this environment has
    neither a blob store nor Playwright's Chromium installed, so the
    post-commit hook's swallowed failure is exercised for real) and
    separately proves the `bill_run_invoices` immutability trigger via a
    synthetic INSERT + rejected UPDATE/DELETE (independent of the
    blob/Chromium gap). DB-gated, statically verified only (see Outstanding).
  - No new permission, no new audit event type.

- **bm20 — Distribution Flow + `bill_run_distribution` + Distribution Tab
  (Phase 2 · Phase H).** See
  `context/billing-management/specs/bm20-distribution-flow.md`. The bill run
  distributor's app side — transport-only (D-push): it hands the flow
  references to bm19's already-stored artifacts and records the outcomes it
  signals back; it computes/renders nothing. Delivered together with the
  spec's own 2026-08-28 Phase-2 review folds (T1/T2/T11/D-T1/D-T3), which
  were already part of the read spec rather than a separate pass.
  - **`db/schema/billing/bill-run-distribution.ts` + migration
    `0038_bill_run_distribution.sql`** (new, hand-authored partitioned table,
    `bill_run_invoices` pattern) — `BRD`+8 seq, composite PK on
    `(bill_run_distribution_id, period_partition)`, **UNIQUE `(ref_bill_run_id,
    target, artifact_ref, distribution_attempt, period_partition)`** (T1 — a
    rerun's outcome is a fresh row, never a dropped replay), CHECKs on
    `artifact_type`/`outcome`. `bill_run` gains one plain column,
    `distribution_attempt` (mirrors `bill_run_account.attempt_count` —
    T1's app-side "current round" counter). `billrun_runtime` gets no grant
    at all (bm14's "no `ALTER DEFAULT PRIVILEGES`" posture, same as
    `bill_run_invoices`, bm19). `db-repositories/billing/
    bill-run-distribution.repository.ts` — `insertOutcome` (insert-first,
    the M2M handler catches the unique-violation for replay), `listForAttempt`
    (one row per `(target, artifact_ref)` within the CURRENT round — the
    UNIQUE constraint already scopes this, no `DISTINCT ON` needed),
    `listForRun` (the full cross-round delivery log, `DistributionTab`'s
    read), `listFailedForAttempt` (the redelivery/abandon set).
  - **`services/billing/engine-client.ts`/`engine-registry.ts` generalized
    for a SECOND flow on the same `billrun` engine.** `startExecution`/
    `engineRegistry.trigger` now take an explicit `flowId` (exported
    constants `PROCESSING_FLOW_ID`/`DISTRIBUTION_FLOW_ID`) instead of the
    hardcoded `bill_run_processing` constant; `trigger-run.ts`/`rerun-run.ts`
    pass `PROCESSING_FLOW_ID` explicitly (behavior unchanged). `TriggerPayload`
    splits into `ProcessingTriggerPayload`/`DistributionTriggerPayload` (a
    union) — the distribution payload is `{bill_run_id, artifacts, targets,
    attempt}`; `attempt` is a **resolved addition** beyond the spec's literal
    §2 input list (`bill_run_id`/`artifacts`/`targets` only) — T1's
    stale-round guard needs the flow to echo back which
    `distribution_attempt` it's reporting for, so the flow template
    (authored fresh in this unit) declares it as a fourth input, mirroring
    `ProcessingTriggerPayload.attempt`.
  - **`services/billing/distribute-run.ts`** (new) —
    `triggerDistribution(billRunId, actorUserId)`: one `db.transaction`
    (bm03/bm08's "engine call inside the txn, throw to roll back" shape),
    idempotent (`NOT_INVOICED`/`ALREADY_STARTED` guards) — gathers every
    STORED `bill_run_invoices` row + generates a fresh per-run invoice-register
    CSV (`buildInvoiceRegisterCsv`, `lib/csv.ts`'s `buildCsv`) as the one
    `report_csv` artifact (constant ref `REPORT_ARTIFACT_REF = "REPORT"`, D21
    — no `bill_run_output` row), triggers `DISTRIBUTION_FLOW_ID` with a
    `{name: 'loopback', is_mandatory: true, force_fail: <config>}` target,
    stamps the execution ref + `distribution_attempt = 1`, writes
    `BILL_RUN_DISTRIBUTION_STARTED` (`actorUserId: null` for the automatic
    call from `post-run.ts`; the real actor id when T2's "Start distribution"
    operator action re-invokes the SAME function to recover a lost/failed
    auto-trigger). `rerunDistribution(billRunId, actorId)` — T1: redelivers
    ONLY the current round's FAILED artifacts (`listFailedForAttempt`),
    resolving each artifact's blob ref from `bill_run_invoices` (immutable) or
    regenerating the report CSV fresh (transient, D21), under a bumped
    `distribution_attempt`; audited `BILL_RUN_DISTRIBUTION_RERUN`.
    `recordDistributionOutcome` — the M2M handler's write: rejects unless
    `DISTRIBUTING`; a signal whose `attempt` no longer matches the run's
    current `distribution_attempt` is an accepted no-op (T1's stale-round
    guard, the same shape `handle-stage-signal.ts` applies via
    `bill_run_account.attempt_count`); the actual insert is idempotent on the
    UNIQUE constraint (a duplicate → replay). No run recompute here and no
    `AUDIT_LOG` write — the appended row is the audit surface (code-standards
    §1.10), same as `bill_run_account_stage`. `recomputeDistributionStatus(tx,
    run)` — derives `COMPLETED` (every expected mandatory artifact
    DELIVERED — expected = stored-invoice count + 1 for the report, so
    "all delivered" can never be satisfied vacuously by a partial signalled
    set) / `DISTRIBUTION_FAILED` (any mandatory FAILED) / unresolved (no
    write, no heartbeat bump — mirrors `reconcile-run.ts`'s PROCESSING-mismatch
    rule exactly); shared by the `.../status` route's `DISTRIBUTION_FINISHED`
    push AND `reconcile-run.ts`'s new DISTRIBUTING branch, so the two paths
    can never disagree. `forceCompleteDistribution(billRunId, actorId,
    reason)` (T11) — `DISTRIBUTION_FAILED → COMPLETED`, records the abandoned
    artifact refs in the audit event (`BILL_RUN_DISTRIBUTION_ABANDONED`),
    never touches a posted INV.
  - **The third M2M handler** — `app/api/billrun/[runId]/distribution/
    outcome/route.ts` → `recordDistributionOutcome`, body `{target,
    artifact_ref, artifact_type, is_mandatory, outcome, attempt}`
    (`validation/billing/distribution-outcome.schema.ts`, `strictObject`).
    The bm13 route-inventory test (`tests/app/api/
    billrun-route-inventory.test.ts`) now locks the surface to **three**
    `POST` handlers. `.../status`'s `statusPushBodySchema` widens to
    `status: 'PROCESSING_FAILED' | 'DISTRIBUTION_FAILED' |
    'DISTRIBUTION_FINISHED'` — the first two are literal forced pushes (the
    flow's `on_error` handler for the latter), the third triggers
    `recomputeDistributionStatus` (the flow's `finally` handler, per the
    template's stub comments); `handle-status-push.ts` branches on
    `run.status` (PROCESSING vs. DISTRIBUTING) to decide which literal is
    legal, 409 otherwise.
  - **`post-run.ts`'s completion path (D8/D9).** `billRunRepository.
    completePosting` is renamed in semantics (same function name): it now
    stamps `POSTING → INVOICED` only (`invoiced_at`, no `completed_at`) — the
    prior direct `→ COMPLETED` write is gone. `postRun` calls
    `triggerDistribution(billRunId, null)` as a SEPARATE call once that
    transaction commits, wrapped in try/catch that swallows every failure
    (logged) — a lost/failed auto-trigger leaves the run `INVOICED` with no
    execution reference, recoverable via T2's "Start distribution" rather
    than blocking or retrying the posting loop itself.
  - **T2 — recover a stuck/lost distribution trigger.** `services/billing/
    stall.ts`'s `isStalled` now also derives STALLED for a `DISTRIBUTING` run
    (was PROCESSING-only). `reconcile-run.ts`'s "Check status" resolves
    `distribution*` vs. `processing*` execution-ref columns by the run's
    current status (a small `executionRefFor` helper) and gains a
    DISTRIBUTING branch: `FAILED`/`KILLED` → `markDistributionFailed`;
    `SUCCESS` → `recomputeDistributionStatus` (shared with the M2M path
    above). `actions/billing/start-distribution.action.ts`
    (`billrun_operate:EDIT`) re-invokes `triggerDistribution` with the real
    actor id for an `INVOICED` run with no execution yet.
    `components/billing/start-distribution-control.tsx` — a plain
    explicit-click primary control (no confirm modal — a benign, resumable
    recovery action, not money-moving), same discipline as Post/Retry-failed.
    **`cancel-run.ts` is a resolved decision to stay `PROCESSING`-only** —
    NOT extended to DISTRIBUTING: a `DISTRIBUTING` run has already posted
    every INV, so "reset accounts to PENDING" (cancel's semantics) doesn't
    apply; `StallBanner` gains a `canCancel` prop (`components/billing/
    stall-banner.tsx`) the detail page sets to `status === 'PROCESSING'` so a
    stalled DISTRIBUTING run's banner offers Check status only.
  - **T11 — force-complete/abandon.** `actions/billing/
    force-complete-distribution.action.ts` (`billrun_approve:EDIT`, the
    money-gate permission, mirroring Approve/Post/Reject) + `validation/
    billing/force-complete-distribution.schema.ts` (mandatory `reason`).
    `components/billing/force-complete-distribution-dialog.tsx` — a quiet,
    low-emphasis text-button trigger ("Force-complete / abandon", never a
    peer button to Rerun, D-T1) opening a spelled-out danger-role confirm
    (lists the abandoned artifact refs, states the GL-closes/abandoned
    consequence) — mirrors `RejectDialog`'s shape.
  - **UI — `DistributionTab`** (`components/billing/distribution-tab.tsx`,
    new) — D-T3's four states, all sharing one `DistributionView` read model
    (`services/billing/read/get-distribution.ts`): targets list (loopback
    mandatory; portal/AR-feed/statutory/email rendered greyed
    "not configured"); INVOICED-pending → money-posted banner +
    `StartDistributionControl`; DISTRIBUTING → live in-flight banner;
    COMPLETED → all-green success summary, no actions; DISTRIBUTION_FAILED →
    `RerunDistributionControl` (primary, D-T1's happy path) +
    `ForceCompleteDistributionDialog` (quiet secondary). The full
    cross-round delivery log (`DistributionOutcomeBadge`, new) renders below
    every state — zero rows is a positive empty state, not a blank panel.
    Added to `run-detail-tabs.tsx`/`run-detail.schema.ts`'s `RUN_DETAIL_TABS`
    and the `[runId]/page.tsx` fetch-per-active-tab idiom (same shape as
    every other tab).
  - **`BILLRUN_DISTRIBUTION_FORCE_FAIL`** (env flag, D20) — `lib/config.ts`,
    threaded only into `distribute-run.ts`'s target payload
    (`targets[].force_fail`); no UI control (no target-catalog table to hang
    one off, mirrors Inv. #11's "no `udr_mode`-style column" posture) — a
    resolved ambiguity: the spec's "a switch to force a failure" is realized
    as a deploy-time/test-environment toggle, not an operator-facing control,
    since forcing a failure is a verification concern against the deployed
    placeholder flow, not a production affordance.
  - Three new audit events — `BILL_RUN_DISTRIBUTION_STARTED`/`_RERUN`/
    `_ABANDONED`, all `"Change"` — join `AUDIT_EVENT_TYPES`/
    `AUDIT_EVENT_CATEGORY_MAP`. No new permission (Start/Rerun distribution
    share `billrun_operate`; force-complete shares `billrun_approve`).

- **bm21 — Phase-2 Ship Gate (Phase 2 · Phase I).** See
  `context/billing-management/specs/bm21-phase2-ship-gate.md`. Bm13-discipline
  audit of the assembled phase-2 guardrail suite (bm14–bm20) plus the
  cross-cutting closures no single unit owned:
  - **Guardrail audit (§1) — mostly already shipped.** Two-writer boundary
    (bm14), `udr_rated` lifecycle incl. `REJECTED → BILL_DRAFT` re-claim
    (bm16/bm17), M2M record-only + the 3-handler route-inventory lock
    (bm16/bm20), rendered-invoice integrity (bm18/bm19), distribution
    (bm20), two-execution + engine registry (bm16/bm20), and placeholder
    isolation's "every run visibly badged" half (bm15, per-page tests e.g.
    `tests/app/bill-runs-page.test.tsx`) were all already present and CI-
    wired — confirmed by direct audit, not rebuilt. `billmgmt-code-
    standards.md` §9 rewritten to assemble the full phase-1 + phase-2 list
    (18 items) in one place, replacing the phase-1-only wording that never
    got updated across bm14–bm20.
  - **Closed gap — placeholder-mode's `_SAMPLE_*` marker had no test.** New
    DB-free `tests/guardrails/billing-sample-seed-marker.test.ts` asserts
    `db/seeds/sample/udr-rated-sample.ts`'s `buildSampleUdrRatedRow` (the
    D28 stand-in factory `db:seed-sample` uses for every unclaimed
    `rating.udr_rated` charge) marks `udrSourceFile`/`udrRefBatchId`/
    `ratingEngineVersion` with the `_SAMPLE_` prefix, for both `RATED` and
    `BILL_NOTUSED` rows — a pure-function assertion, no DB needed. Actually
    executed in this environment (unlike the DB-gated suites below) — 4/4
    green.
  - **[CRITICAL] Closed gap — the D10 safety net (Phase-2 review fold T8)
    was unproven AND, on inspection, not actually enforced.** No test
    proved "posted INV but no `bill_run_invoices` row → distribution
    mandatory-fails"; auditing the code confirmed the gap was real, not
    just untested — `computeExpectedMandatoryArtifactCount` derived its
    "expected" count from STORED invoices only, so a render-pending account
    was invisible to distribution's own math and could let the run reach
    `COMPLETED` silently around it (the OLD E2E assertion literally proved
    this "worked as designed" — now corrected). Fixed structurally, not via
    a fabricated outcome row: `services/billing/distribute-run.ts` gains
    `hasUnrenderedPostedAccounts` (diffs `customerBillRepository
    .listPostedAccountIds` against a new `billRunInvoicesRepository
    .listBillingAccountIdsForRun`), checked in `recomputeDistributionStatus`
    right after the existing mandatory-FAILED check — `DISTRIBUTION_FAILED`,
    never a silent `COMPLETED`, for as long as ANY posted account has
    nothing stored to deliver. `rerunDistribution` is broadened to redeliver
    not just the prior round's genuinely FAILED artifacts but also any
    stored invoice that has NEVER been part of any round's outcome log (a
    late `retryRenderInvoice`, rendered after the top-level trigger already
    ran) — derived from ONE read of the full delivery log
    (`billRunDistributionRepository.listForRun`) rather than a second,
    independently-drifting `listFailedForAttempt` query, so a retry-render +
    Rerun can still reach `COMPLETED`. 6 new/updated unit tests in
    `tests/services/billing/distribute-run.service.test.ts` (2 new
    `recomputeDistributionStatus` cases, 1 new `rerunDistribution` case, 3
    existing `rerunDistribution` cases fixed for the new single-source-of-
    truth read) — all green (25/25 in that file), plus the full non-DB-gated
    `vitest run` suite reconfirmed no other regression.
  - **Phase-2 E2E extended (§2) — reject leg + T8 leg, both new.**
    `tests/db/billing-e2e-happy-path.integration.test.ts` (the bm13/bm20-era
    journey) now also drives: **(a) reject → reprocess** — replaces the
    prior arbitrary "rerun a subset" demonstration with a real
    `rejectRun` (model (b), bm17) on the BILLED account, asserts the run
    stays `PROCESSED`, the account's status is untouched, its unposted
    trial bill is deleted, the `REJECTED_PENDING_REPROCESS` marker is
    stamped (`listRejectedPendingForRun`), approval is blocked
    (`CHECKS_FAILED` / `no_rejected_pending`), then reruns the rejected
    account from Validation (re-claim → full six-stage re-drive, write-
    then-signal again) back to `PROCESSED` with the marker cleared, before
    proceeding to Approve/Post as before; **(b) the D10 safety net
    end-to-end (T8)** — after posting, asserts distribution now
    mandatory-fails (`DISTRIBUTION_FAILED`, not the old silent `COMPLETED`)
    because the billed account is render-pending in this environment (no
    Chromium/blob store, same gap as every prior unit), simulates a
    retry-render's OUTCOME via a direct synthetic `bill_run_invoices` insert
    (same technique as `simulateProcessorAggregation`/`Taxation` — this
    row also doubles as the immutability-guard proof, replacing a second,
    disconnected synthetic insert), calls the real `rerunDistribution`
    (asserts it picks the new invoice up as never-attempted), delivers it,
    and recomputes to `COMPLETED`. Still DB-gated and **unexecuted in this
    environment** (same convention as every other DB-gated test in this
    module — see Outstanding).
  - **T7 — two real bugs found and fixed while assembling the gate, per
    `billmgmt-known-issues.md` §4a/§4b** (both confirmed root-caused by
    direct code reading, not guessed): **#4a** —
    `tests/db/materialize-runs.integration.test.ts`'s race-loop built a
    literal `2026-02-29` (non-leap year) as a plain template-string date,
    independent of `currentDuePeriod`'s own `Date.UTC`-based arithmetic
    (which already clamps correctly) — the bug was in the TEST FIXTURE, not
    production date logic; fixed by using day 28 (valid in every month,
    matching `periodEnd`'s existing convention) instead of 29. **#4b** —
    `tests/db/trigger-run.integration.test.ts`'s "double-trigger guard"
    case reused test 1's exact `(cycleId, periodStart="2026-06-01")` pair
    with no per-test reset (one shared `beforeAll`/`afterAll` for the whole
    file), colliding on `bill_run_cycle_period_unique` before the guard
    under test was ever reached; fixed by giving that case its own distinct
    period (July, not June) and updating both `triggerRun` calls' `today`
    argument to stay due against the new `scheduledRunDate`.
  - **T3 — live-Kestra smoke gate formalized as an explicit phase-2 exit
    criterion**, not fabricated as already-met. `flows/billrun/README.md`'s
    three `_TBD_` lines (repo/owner/deploy step) are left honestly `_TBD_`
    (no real values exist to fill in) but are now framed as an explicit,
    numbered 3-item exit checklist rather than a buried paragraph. New
    `scripts/billrun-live-kestra-smoke.ts` (`npm run
    billrun:live-kestra-smoke`) — a real, runnable script (materialize →
    trigger → poll `reconcileRun` until `PROCESSED`, against the
    `db:seed-sample` `_SAMPLE_*` scenario) that refuses to run against the
    STUB engine client (`isBillRunEngineConfigured` false ⇒ throws loudly)
    so it can never falsely "pass" unconfigured. Wired as a new, off-by-
    default `billrun_live_kestra_smoke` stage in `infra/azure-
    pipelines.yml` (`runBillrunLiveKestraSmoke` parameter, mirrors rm13's
    `runRatingFanoutGate`/`scanRatingEngineDast` precedent), reading
    `DATABASE_URL`/`BILLRUN_ENGINE_URL`/`BILLRUN_ENGINE_AUTH` from Key
    Vault (`pg-connection-string-app`, existing, plus two **not yet
    created** secrets `billrun-engine-url`/`billrun-engine-auth`, flagged
    in the pipeline header comment the same way `kestra-basic-auth-
    password` is). **Never executed against a real engine in this
    environment** (none exists yet, by design — see Outstanding); YAML
    syntax-validated (`js-yaml` parse) and the script typechecks/lints
    clean.
  - **Security gates (§3) — already fully covering the new phase-2
    surfaces, confirmed by audit, no config change needed.** Semgrep scans
    the whole repo tree (not a route allow-list) and OWASP ZAP's scope is
    whole-host-by-regex (`infra/zap/zap-context.xml`), so the bm18/bm19
    session-guarded PDF routes and bm20's third M2M handler were already
    in scope by construction. The "authz-sweep inventory" the spec asks to
    update turned out to already exist as `billmgmt-code-standards.md` §8's
    route table (already current with every phase-2 row) — §8 now says so
    explicitly, closing the ambiguity rather than standing up a duplicate
    artifact.
  - **Docs (§4).** `billmgmt-code-standards.md` §9 rewritten (phase-1 +
    phase-2 guardrail list, 18 items); §8 gains the "this table IS the
    authz-sweep inventory" note. This tracker entry.
  - **No new npm packages, no new page/permission/table** — the unit's
    stated boundary held; every change is a test, a doc, a CI-config
    addition, or a small, targeted service-layer fix to a genuine
    correctness gap surfaced while auditing (T7/T8), matching the bm13
    ship-gate precedent of fixing what auditing finds rather than only
    reporting it.
  - **`tsc`/lint green** across every touched file (repeatedly reconfirmed
    through this unit's edits); the full non-DB-gated `vitest run` suite
    was run and showed no new regressions.

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
- **bm14/bm16/bm17 (cross-commit review, 2026-09-08):**
  - **[CRITICAL] `billrun_status_guard` now permits the `REJECTED → BILL_DRAFT`
    re-claim** (`db/bootstrap/billrun-db-roles.sql` Step 7b). bm14 hardened the
    trigger to `RATED → BILL_DRAFT` only, but bm17's reject → rerun loop and
    bm16's Collection stub both require the processor to re-claim a rejected
    account (`status IN ('RATED','REJECTED') → BILL_DRAFT`, spec T6). The two
    commits were mutually contradictory — the whole reject → rerun → approve
    journey would have failed HARD at the DB against a real engine. Both checks
    now treat `RATED` and `REJECTED` as the claimable source set (status flip
    and claim-column rewrites); the frozen-state guard for `BILL_DRAFT`/
    `BILL_APPROVED` and the "worker never sets `BILL_APPROVED`/`REJECTED`" rules
    are unchanged. Integration tests 14/14b updated + a `REJECTED → BILL_DRAFT`
    success case added. **Requires re-running `db:bootstrap-billrun-roles` in
    every environment** (CREATE OR REPLACE FUNCTION).
  - **`BILLRUN_ENGINE_AUTH` now rejects an empty string at boot** (`lib/config.ts`).
    A present-but-empty `BILLRUN_ENGINE_AUTH=""` alongside a real URL passed the
    both-or-neither superRefine (presence check) yet resolved to
    `configured = false` in `engine-registry.ts` (`!!auth`) — silently selecting
    the STUB client on a deployment that looked fully configured. `.min(1)`
    makes it fail loud, consistent with the truthiness resolution.
  - Deferred (documented, not fixed): cancel's `release()` leaves a prior
    reject's `REJECTED` rows un-released (BILL_DRAFT-only) — now self-healing via
    the corrected re-claim on the next Collection, and `REJECTED → RATED` on
    cancel carries a live-row-uniqueness collision risk if a re-rating created a
    competing live row. Double-reject on a still-`PROCESSED` run writes a
    misleading `priorTotals: "0.00"` audit row (no data change). `release(runId, [])`
    conflates an explicit empty scope with whole-run release. `ref_tax_rate_version`
    is no longer stamped by any app writer (Fork B retired `stampTaxRateVersion`;
    `billRunTaxConfig`/`BILLRUN_TAX_*` are now app-side dead config kept for
    provenance). Reject stamps its marker via a per-account N+1 loop.
- **bm18/bm19 (CodeRabbit review, 2026-09-08):**
  - **Invoice modals no longer race their own fetch.** `InvoicePreviewModal`
    (bm18) and `StoredInvoiceModal` (bm19) track the in-flight render's
    `AbortController`, abort it on close/unmount/retry, and drop a stale
    completion so a superseded/closed generation never overwrites state or
    leaks an object URL; `StoredInvoiceModal` also gained a fetch timeout so a
    hung download can't freeze the frame (D-T2).
  - **`blobStore.putInvoice` is write-once.** Uploads with `if-none-match: "*"`;
    on Azure's 412 (a post-commit render racing a manual `retryRenderInvoice` —
    Chromium stamps a fresh timestamp per render, so their bytes differ) it
    adopts the WINNER's bytes' checksum, so the persisted
    `bill_run_invoices.checksum` always matches what a later download reads.
  - **`getStoredInvoice` verifies integrity.** Re-hashes the downloaded PDF and
    fails closed (route → 500) on a mismatch with the stored checksum — the
    "second checksum" now actually guards the artifact.
  - **`lib/config` rejects BOTH blob backends being set**
    (`BILLRUN_BLOB_CONNECTION_STRING` + `BILLRUN_BLOB_ACCOUNT_URL`) via
    superRefine — a both-set misconfig previously resolved silently to the
    connection string. Neither-set is still allowed (fail-on-first-use).
  - **`billing.document` gains two CHECKs** (schema + `0037`):
    `(ref_customer_bill_id IS NULL) = (period_partition IS NULL)` and
    `ref_customer_bill_id IS NULL OR doc_type = 'INV'` — closes the Postgres
    MATCH SIMPLE composite-FK bypass (a half-NULL pair would otherwise skip
    `document_customer_bill_fk` entirely).
  - **Customers & Bills tab gates on `hasStoredInvoice`** (see the corrected
    bm19 UI narrative above) — a posted-but-render-pending invoice shows a
    render-pending note pointing to Posting progress, not a 404-ing modal.
  - **`db/migrations/README.md`** (new) + a `drizzle.config.ts` caveat record
    that migrations are hand-authored — `drizzle-kit generate`'s snapshot
    baseline is stale past `0026`.
- **bm20 (CodeRabbit review, 2026-09-09):**
  - **`recomputeDistributionStatus` now merges outcomes ACROSS every
    distribution attempt**, keeping only each `(target, artifact_ref)`'s
    LATEST recorded outcome, instead of reading only the current round's
    rows. `rerunDistribution` only ever re-triggers the PRIOR round's FAILED
    artifacts (never the ones already `DELIVERED`), so a round-scoped read
    could never satisfy the full mandatory count on its own — a rerun whose
    redelivered artifacts all succeed could never reach `COMPLETED`. A
    round-2 `DELIVERED` now correctly supersedes a round-1 `FAILED` for the
    same artifact rather than being counted alongside it.
  - **`recordDistributionOutcome` validates outcome identity before
    inserting.** A pushed `(target, artifact_ref, artifact_type,
    is_mandatory)` tuple is now checked against what this run actually
    launched (`loopback`/`is_mandatory=true`, plus either the fixed report
    ref or a real `bill_run_invoices` row) — closes a hole where a malformed
    or malicious M2M push could fabricate an artifact `recomputeDistribution
    Status` would count toward "all mandatory delivered", or smuggle
    `is_mandatory: false` past the FAILED-blocks-completion check.
  - **`rerunDistribution` bails out (returns `NO_FAILED_ARTIFACTS`) before
    triggering the engine** if every previously-failed artifact's blob
    reference fails to resolve, logging each one — previously it would
    launch the engine (and advance the run to `DISTRIBUTING`) with an EMPTY
    artifact list.
  - **`handleStatusPush` now requires + validates `attempt` on both
    `DISTRIBUTION_*` pushes** (`statusPushBodySchema` — required whenever
    `status !== 'PROCESSING_FAILED'`), rejecting/no-op'ing a straggler push
    from a superseded distribution execution — mirrors
    `recordDistributionOutcome`'s stale-round guard (T1). The
    `bill_run_distribution.template.yml` contract in the bm20 spec is
    updated to show the flow echoing `attempt` back on the outcome push AND
    both terminal `.../status` pushes.
  - **`getDistribution` returns `null` before reading the delivery log** for
    a run earlier than `INVOICED` (or one that never reaches it, e.g.
    `CANCELLED`) — previously it read/returned an (empty) delivery log for
    any existing run regardless of status.
  - **`DistributionTab`'s COMPLETED message now distinguishes force-completed
    from fully-delivered.** T11's force-complete/abandon path leaves the last
    round's failed artifacts recorded as permanent `FAILED` rows; the tab now
    detects any such row in the latest attempt (`failedArtifactRefsFromRows`)
    and shows an abandonment summary instead of the "every mandatory artifact
    was delivered" success copy.
  - **`realEngineClient.startExecution`'s abort timer now stays armed through
    `response.json()`**, not just the initial `fetch()` (same shape as
    `getExecutionStatus`) — a response whose headers arrive but whose body
    stalls no longer hangs the call past `REQUEST_TIMEOUT_MS`.
  - **`tests/db/billing-e2e-happy-path.integration.test.ts` fixed** for bm20's
    lifecycle — see the Outstanding entry above for the full before/after.
- **bm21 (CodeRabbit review, 2026-09-09):**
  - **`rerunDistribution`'s audit event now records EVERY redelivered
    artifact.** `toRedeliver` (and the engine payload) is the union of the
    prior round's genuine `FAILED` artifacts AND the never-attempted mandatory
    invoices (T8), but the `BILL_RUN_DISTRIBUTION_RERUN` audit's
    `beforeData.failedArtifacts` recorded only the `failed` subset —
    under-reporting what was actually re-triggered. It now spreads
    `neverAttemptedInvoices` alongside `failed`.
  - **`billrun-live-kestra-smoke.ts` selects only a DUE scheduled run.** The
    run query now adds `lte(scheduledRunDate, today)` so it can never trigger a
    future-dated `SCHEDULED` run against today's business date.
  - **`billrun-live-kestra-smoke.ts` gained a pre-trigger `_SAMPLE_`-only
    safety gate.** Because the script triggers a real, irreversible bill run
    against whatever `DATABASE_URL` targets, it now aborts before `triggerRun`
    unless (1) `BILLRUN_PLACEHOLDER_MODE` is set, (2) every account
    `scopeAccounts` would scope belongs to the seeded `_SAMPLE_-BILLRUN-0001`
    customer, and (3) every candidate (`RATED`) `udr_rated` charge for those
    accounts carries the `_SAMPLE_` provenance markers (udrSourceFile/
    udrRefBatchId/ratingEngineVersion). Guards against a misconfigured
    `DATABASE_URL` processing real billing data.
  - **Skipped:** the CodeRabbit suggestion to add a named nightly
    `schedules:` block + wire the `billrun_live_kestra_smoke` stage condition
    to `Build.CronSchedule.DisplayName`. Auto-firing the gate nightly
    contradicts the documented invariant (`flows/billrun/README.md` steps 1–2,
    the parameter's own rationale): there is no deployed `billrun` engine and
    the required Key Vault secrets (`billrun-engine-url`/`billrun-engine-auth`)
    do not yet exist, so a nightly run would fail every night at the Key Vault
    fetch / engine-configured guard. Kept manual-only until step 2 is met.
- **bm20/bm21 (max-effort multi-agent review, 2026-09-09):** correctness +
  efficiency fixes across the distribution flow, all unit-covered (green).
  - **`recordDistributionOutcome` now bumps `last_progress_at`** on every valid
    current-round outcome (after the stale-attempt guard, so a straggler never
    resets the clock). It previously inserted the row without a heartbeat, so a
    long, actively-delivering `DISTRIBUTING` run was falsely flagged `STALLED`
    mid-delivery — contradicting stall.ts's stated invariant ("bumped by every
    stage/outcome signal") and the PROCESSING precedent (`recomputeStatus`).
  - **`forceCompleteDistribution` now records posted-but-unrendered accounts as
    abandoned** (count + audit `abandonedUnrenderedAccounts`). A run pushed to
    `DISTRIBUTION_FAILED` purely by the T8/D10 `unrenderedPosted` safety net has
    ZERO `FAILED` rows, so the old `listFailedForAttempt`-only derivation
    completed it with `abandonedCount: 0` and an empty audit while a posted
    invoice was silently abandoned un-rendered.
  - **`rerunDistribution` now re-attempts a never-recorded `report_csv`.** The
    mandatory report is in every round's payload but is neither a
    `bill_run_invoices` row nor (if its outcome was lost) a `FAILED` row, so a
    run whose report outcome never landed could never reach COMPLETED via rerun
    (expected = invoices + 1) — it wedged. Re-attempted whenever no outcome for
    it was ever recorded.
  - **`recomputeDistributionStatus` + `forceCompleteDistribution` share one
    `postedVsStoredInvoices` read** (posted vs stored accounts). Replaces the
    separate `hasUnrenderedPostedAccounts` + `computeExpectedMandatoryArtifact
    Count` (a third `countForRun` scan of the same partition, now removed) — the
    gap-check and the expected count are derived from the SAME read, so they can
    never disagree.
  - **`reconcile-run.ts`'s `executionRefFor` keys on `distributionExecutionId`**
    (not `status === "DISTRIBUTING"`), so a run past DISTRIBUTING
    (`DISTRIBUTION_FAILED`/`COMPLETED`) reconciles against its distribution
    execution rather than auditing its long-finished processing one.
  - **`posting-progress-view.tsx` completion message is now an ALLOWLIST**
    (`INVOICED`/`DISTRIBUTING`/`COMPLETED`/`DISTRIBUTION_FAILED`), not the
    `!== APPROVED && !== POSTING` denylist. The approve route falls through to
    this view for any non-`PROCESSED` run, so the denylist showed a false green
    "posting complete" over runs still `SCHEDULED`/`PROCESSING` or ones that
    failed/were cancelled before posting. New test locks all states.
  - **Deleted dead `bill-run-distribution.repository.listForAttempt`** (no
    callers) and the now-unused `bill-run-invoices.repository.countForRun`.
  - **Evaluated-and-deferred (rationale):** the M2M identity check accepting any
    stored invoice regardless of the round's payload — **spec-conformant**
    (bm20-spec §Impl §4 defines "launched" as exactly stored-invoice/report-ref
    + loopback/mandatory; per-attempt-payload validation is beyond scope, and
    the `attempt`-match + `DISTRIBUTING` gate is the intended stale guard); the
    engine trigger inside the DB transaction — **intentional** (bm20-spec §3 /
    bm03/bm08 "roll back on engine failure" pattern); the force-complete dialog
    deriving the current round from `max(attempt-in-log)` vs the server's
    `distribution_attempt` (D1) and `getDistribution`'s `hasExecution = rows>0`
    (I4) — display-only/latent (the server is authoritative and correct; the
    fix would widen a shared read model + 4 test mocks for a cosmetic edge),
    tracked as a follow-up; the O(N²) `listForRun` in the identity check (H3)
    and the report-CSV build duplication (G8) — efficiency/cosmetic, bounded.

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
- **bm20** — `attempt` was added as a fourth distribution trigger-payload
  field (and a fourth outcome-body field) beyond the spec's literal §2/§4
  lists — needed for T1's stale-round guard, mirroring
  `ProcessingTriggerPayload.attempt`; `bill_run.distribution_attempt` is the
  app-side source of truth a signal's `attempt` is checked against (not
  re-derived from the outcome rows themselves). The "expected mandatory
  artifact count" `recomputeDistributionStatus` compares against is derived
  from `bill_run_invoices` count + 1 (the report) — never assumed from the
  recorded outcome set alone, so "all delivered" can't be satisfied
  vacuously by a partial signal set. `cancel-run.ts` stays `PROCESSING`-only
  (not extended to DISTRIBUTING — nothing to reset once INVs are posted).
  `BILLRUN_DISTRIBUTION_FORCE_FAIL` is an env flag, not an operator control
  (no target-catalog table to hang a UI switch off). The per-run report's
  artifact ref is the literal constant `"REPORT"` (stable across attempts,
  never a generated id) since D21 gives it no stored row to derive one from.

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
- **Fixed incidentally at bm18**: `tests/app/bill-run-detail-page.test.tsx`
  (bm04) was never updated for bm17's `RejectDialog`/`listRejectedPending`
  additions to the page — both are real, unmocked modules whose import graph
  reaches `db/client.ts`, which this test's `@/lib/config` mock doesn't fully
  satisfy, so the whole suite failed to import. Surfaced only when bm18's
  verification run exercised this file; both are now mocked the same way as
  the pre-existing `RerunDialog`/`listErrors` stubs.
- All hand-authored partitioned-table migrations (`0027` bill_run_account,
  `0028` bill_run_account_stage, `0029` customer_bill, `0030`
  customer_bill_tax_item, `0033` finalization trigger) follow the `0001_
  audit.sql` precedent (Drizzle can't express `PARTITION BY`) — generated/
  reviewed but not yet applied anywhere; run `db:migrate` then
  `db:setup-partman-billing` in that order wherever the database lives.
- **`drizzle-kit generate` is retired for this module.** Its snapshot baseline
  in `db/migrations/meta` stops at `0026`; every migration since (`0027`+, and
  `0018`–`0020`) is hand-authored SQL with a hand-appended `_journal.json`
  entry, and the apply path (`db:migrate` → `db/migrate.ts` → Drizzle's
  migrator) reads the journal + `.sql` files, never the snapshots. Documented
  in `db/migrations/README.md` + a `drizzle.config.ts` caveat so nobody runs
  `db:generate` and gets a broken giant diff. `db:introspect` is unaffected.
- The four partitioned billing tables share one `partman.create_parent`
  registration each (monthly, 4-premake, 7-year detach-not-drop — distinct
  from `audit_log`'s drop-on-expiry) and the existing shared
  `run_maintenance_proc()` daily cron covers all of them; no second cron job
  was ever added.
- **bm20's three new `AUDIT_EVENT_TYPES` entries rippled into two places
  `tsc` does not catch** (the known pattern from every prior audit-event
  addition): `tests/components/audit-log-filters.test.tsx`'s hardcoded
  option-count assertion (70 → 73) and `tests/lib/config.test.ts`'s
  exact-object `parses a valid env` assertion needed the new
  `BILLRUN_DISTRIBUTION_FORCE_FAIL` key added (its `ENV_KEYS` array too).
  Both fixed in this unit; confirmed via a full non-integration `vitest run`
  that the only OTHER failures are the four pre-existing, unrelated
  hardcoded-date-drift files noted above.

## Open Questions

- None.

## Next Up

- **bm01–bm21 are all delivered — Phase 2 is feature-complete.** The
  remaining action items are environmental (see Outstanding, above), same
  category as every unit before bm21: apply migrations `0033`/`0035`/
  `0036`/`0037`/`0038`, run `db:bootstrap-billrun-roles` (after
  `db:bootstrap-roles` and `db:bootstrap-rating-roles`), run
  `db:setup-partman-billing` (registering six parents incl.
  `bill_run_invoices`/`bill_run_distribution`), run the full DB-gated suite
  (incl. bm21's extended `billing-e2e-happy-path.integration.test.ts` —
  now exercises Reject and the D10 safety net end-to-end) against a real
  Postgres, and run `db:seed-sample` there to verify bm15's checklist AND
  the new `billing-sample-seed-marker.test.ts` guardrail's real-DB
  counterpart (it currently only asserts the seed factory's pure output
  shape).
- **The live-Kestra smoke gate (bm16/bm20, formalized by bm21 T3) is
  unmet** — no deployed `billrun` engine or real `bill_run_processing`/
  `bill_run_distribution` flow exists yet; the separate workflow-management
  repo/owner/deploy step are still `_TBD_` in `flows/billrun/README.md`.
  Run `npm run billrun:live-kestra-smoke` (or queue the
  `billrun_live_kestra_smoke` pipeline stage) once a real engine exists —
  this is the literal, numbered exit criterion now, not a vague future item.
- **bm18's container-image Chromium proof is unbuilt** — `docker build .`
  against the new `node:22-bookworm-slim` Dockerfile plus an actual
  `renderDraftInvoice` PDF from that image were never exercised in this
  environment; do this before treating draft-invoice preview as ship-ready
  (see Outstanding, above).
- **bm19's blob store / render-and-store step is unbuilt end-to-end** —
  `docker-compose.dev.yml`'s new `azurite` service has never been started,
  and no real (or emulated) blob upload/download has been exercised outside
  mocked unit tests; do this, plus apply `0036` and post a run for real,
  before treating final-invoice storage as ship-ready (see Outstanding,
  above).
- **bm20's `bill_run_distribution` flow has no deployed engine either** —
  folded into the live-Kestra exit criterion above, not tracked separately.
- **bm21's own D10 safety-net fix (`distribute-run.ts`'s
  `hasUnrenderedPostedAccounts` + `rerunDistribution`'s broadened
  redelivery) is unit-tested (25/25 green, mocked repositories) and
  DB-gated-E2E-written but, like everything else in this list, unproven
  against a real Postgres** — run the extended E2E for real before treating
  the D10 gap as genuinely closed in production.
- No further unit is specced in this session; Phase 2 (bm14–bm21) is
  feature-complete per the current spec set.
