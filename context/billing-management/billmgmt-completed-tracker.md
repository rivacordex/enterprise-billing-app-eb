# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-09-16 — per-unit narrative, post-review-fix logs, and test-file
enumerations trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit
detail: `context/billing-management/specs/bm*.md`._

## Current state (2026-09-16)

- **bm39 — Phase-4 ship gate: DELIVERED (2026-09-16).** Audited the assembled
  Phase-4 boundary against its guardrails (audit, don't rebuild — bm21/bm35
  discipline), confirmed no new schema, and synced the owning docs. **All guardrails
  green:** the processing flow (`bill-run-processor/local-dev/bill_run_processing.yml`)
  carries real `http.Request` callbacks — the five per-stage `DONE` POSTs + the
  per-account HARD `FAILED` handler + the run-level `on_error`/`afterExecution:on_killed`
  terminal `/status` POSTs — with **no** remaining signal `Log` stub (`start` and the
  `taxation` no-op stage are the only Logs, neither a signal). **The audit surfaced a
  gap and bm39 closed it (bm13/bm21 "fix what the audit finds"):** the signal-back had
  no CI regression guard — a callback reverted to a `Log` stub would pass every test —
  so bm39 added the static, DB-free `tests/guardrails/billrun-processing-signal-back.test.ts`
  (asserts the five DONE POSTs + per-account HARD `FAILED` + two terminal `/status`
  POSTs, and exactly 8 `http.Request` / 2 non-signal `Log` tasks), making
  code-standards §9 item 34 a true CI-wired guardrail alongside item 35's flag test.
  `BILLRUN_PROCESSING_FORCE_FAIL` defaults `false` and its accessor is read only by
  `trigger-run.ts` (guardrail test); the M2M **receivers are unchanged**
  (`handle-stage-signal.ts`/`handle-status-push.ts`/`reconcile-run.ts` last touched
  at/before bm22/bm20, not by bm36–bm38); **no new schema/migration** (`_journal.json`
  ends at idx 39 = `0039_customer_bill_line`, bm23 — no `0040+`); bm38's bicep secret
  wiring is reviewable with the deploy flags gated off by default. `tsc`, `eslint`, and
  the DB-free vitest suite pass. Docs synced: `billmgmt-code-standards.md` §9 gains the
  two Phase-4 guardrails (items 34–35); `billmgmt-known-issues.md` §9 stays resolved
  (bm36), §10 the ratified taxation-`0.00` interim; `billmgmt-project-overview.md`'s
  signal-back "remaining" callout is dropped and success-criterion 9 folded into the
  delivered narrative. **The full-journey live-Kestra proof (bm37's
  `billrun:live-kestra-smoke` to `COMPLETED`) is the gated live-stack step** — it runs
  against the provisioned real Postgres/Kestra/blob/SFTP stack (not up in this session;
  the DB-gated E2E must target a disposable/CI Postgres, never the shared dev DB), and
  is CI-doubled by `tests/db/billing-e2e-happy-path.integration.test.ts`. **Note:** the
  spec's doc-sync item for `billmgmt-gap-assessment.md` is moot — no such file exists in
  the repo (the diagnostic was never committed under that name); its intent is subsumed
  by this closeout. See `specs/bm39-phase4-ship-gate.md`.

- **Phases 1–3 (bm01–bm35) are implemented in the codebase.** Phase 1 (bm01–bm13)
  built the control plane; Phase 2 (bm14–bm21) the two-writer boundary, rendering,
  posting-on-real-charges, distribution, and the ship gate; Phase 3 (bm22–bm35) the
  real compute plane (`customer_bill_line`, correlation-based collection, two-source
  aggregation, verification, checksum re-anchor, reject-as-release, SFTP
  distribution, the `RAN_USAGE` seed, placeholder-mode retirement).
- **wfm01 executed** (commit `0b31f50`): `rating-engine/` → `workflow-management/`;
  flow paths are function-first (`flows/bill-run-processor/…`,
  `flows/bill-run-distributor/…`). Historical entries may say `flows/billrun/…`.
- **Local dev stack provisioned & verified (2026-09-11):** 39 migrations applied, 9
  `partman` parents registered, every seed run, Azurite serving, the `billrun`
  namespace up with both flows deployed idempotently. DB-gated suites must **NOT**
  be pointed at this stack's `DATABASE_URL` (they `DROP SCHEMA … CASCADE` and would
  wipe the seed data) — run them against a disposable/CI database.
- **Processor signal-back is now real (bm36, Phase 4).**
  `bill-run-processor/local-dev/bill_run_processing.yml` POSTs a per-stage `DONE`
  after each stage, a per-account HARD `FAILED` from the account stage group's
  `errors` handler, and a run-level terminal `PROCESSING_FAILED` from the flow's
  `errors`/`finally` — all real `io.kestra.plugin.core.http.Request` callbacks
  (Bearer token, retry PT5S×2), replacing the `Log` stubs, at parity with the
  distributor (bm34). So a triggered run now drives itself to `PROCESSED` and a
  HARD-failing account settles via the signal (not the stall gate). Taxation
  stays a no-op (`tax_total = 0.00`), ratified as interim.
- **The live-Kestra `SCHEDULED → COMPLETED` assertion is real (bm37, Phase 4).**
  `scripts/billrun-live-kestra-smoke.ts` now drives the WHOLE operator journey
  against the real deployed flows and closes the bm16/bm20 live-Kestra gate.
- **Production deploy path is deployable + wired (bm38, Phase 4 · Phase O,
  2026-09-16).** The `billrun_runtime` DB credential — the
  `billrun-runtime-db-password` bare-password secret (→ `SECRET_BILLRUN_RUNTIME_PASSWORD`)
  plus the `BILLRUN_DB_HOST`/`BILLRUN_DB_PORT`/`BILLRUN_DB_NAME`/`BILLRUN_DB_USER`
  coordinates, the split shape the deployed flow actually reads — and the
  engine/SFTP Key Vault secrets and their consumer mapping are wired into the
  shared `workflow-engine` bicep,
  the deploy flags are readied (still off by default), the `local-dev` flow is
  promoted as the production flow (the "separate repo, TBD owner" fiction is
  gone), and the cutover runbook + taxation-`0.00` interim are recorded. **The
  actual cloud cutover — flipping the flags and running the live smoke against a
  real engine + SFTP — remains a later gated ops step.** See
  `specs/bm38-production-deploy-wiring.md`.

## Delivered units

### Phase 1 — control plane (bm01–bm13)

- **bm01** — Billing section & RBAC scaffold: `billrun_view/operate/approve`
  (migration `0024`), Billing Viewer role, nav section, `/billing/bill-runs`.
- **bm02** — Bill Runs list + lazy materialization: `billing.bill_run` (`0025`,
  period CHECKs `0026`), `currentDuePeriod`, `materializeDueRuns` (ON CONFLICT DO
  NOTHING), two-tab list, formula-safe CSV.
- **bm03** — Trigger + Scoping + outbound engine: partitioned `bill_run_account`
  (`0027`), `scopeAccounts`, `EngineClient`, `triggerRun` (engine call inside the
  txn → full rollback if unreachable).
- **bm04** — M2M stage ingest + timeline: partitioned `bill_run_account_stage`
  (`0028`, idempotency latch UNIQUE `(run, ban, stage, attempt, period_partition)`),
  `BILLRUN_APP_TOKEN`, two route handlers, `handleStageSignal` (insert-first),
  Workflow tab.
- **bm05** — Draft bill (claim + aggregation): partitioned `customer_bill` (`0029`),
  Customers & Bills tab.
- **bm06** — Taxation: partitioned `customer_bill_tax_item` (`0030`), totals
  recomputed in SQL numeric.
- **bm07** — Verification / Uncharged / Errors / Audit tabs (no new table).
- **bm08** — Rerun (full & partial): audit-before-retrigger, attempt-keyed stage
  invalidation, finalization guard absolute.
- **bm09** — Accounts-side INV & posting enablement (additive): `document_inv_seq`,
  `'INV'` type (`0031`/`0032`), `STANDARD_INVOICE` reason code, `INV_LEG_TEMPLATES`,
  period-close guard.
- **bm10** — Approve (four-eyes gate): five pre-approval checks, `approveRun`.
- **bm11** — Post to ledger: per-account txn `postAccount`, `charge_checksum` in SQL,
  resumable/idempotent, `INVOICED`.
- **bm12** — Stall detection & recovery: `isStalled` (derived, never stored),
  `reconcileRun` (Check status), `cancelRun`.
- **bm13** — E2E journey & ship gate: finalization trigger (`0033`), DB-gated
  happy-path test, route-inventory lock.

### Phase 2 — boundary, rendering, posting, distribution (bm14–bm21)

- **bm14** — `billrun_runtime` role & two-writer grant boundary
  (`db/bootstrap/billrun-db-roles.sql`, not a Drizzle migration), `billrun_status_guard`
  trigger, scoped `billrun_delete_trial_bill`.
- **bm15** — `_SAMPLE_` scenario seed (`db:seed-sample`, prod-guarded) + rename
  `STUB_DATA_MODE → BILLRUN_PLACEHOLDER_MODE`.
- **bm16** — Engine registry, two-execution columns (`0035`), processing-flow
  placeholder, **M2M record-only** (Fork B retired all app-side compute;
  write-then-signal, D6).
- **bm17** — `udr_rated` approve/reject/release lifecycle + Reject action:
  `udr-status.repository.ts` (the app's only `rating` write), reject = model (b)
  (run stays `PROCESSED`).
- **bm18** — Rendering foundation + draft PRO-FORMA preview: `bookworm-slim` image,
  `render-invoice.ts` (bounded semaphore), session-guarded PDF route,
  `InvoicePreviewModal`.
- **bm19** — Posting on real charges + final render & store: `bill_run_invoices`
  (`0036`, immutable), real `md5` charge checksum over `udr_rated`, `blob-store.ts`,
  structural one-INV-per-bill latch (`0037`), `StoredInvoiceModal`.
- **bm20** — Distribution flow + `bill_run_distribution` (`0038`) + Distribution tab:
  transport-only, third M2M handler (`distribution/outcome`), multi-round outcomes,
  `recomputeDistributionStatus`.
- **bm21** — Phase-2 ship gate: guardrail audit (18-item code-standards §9 list),
  **[CRITICAL] D10 safety-net fix** (render-pending accounts now block a silent
  `COMPLETED`), E2E extended (reject + T8), runnable `billrun:live-kestra-smoke`
  script (refuses the stub engine).

### Phase 3 — real compute plane (bm22–bm35, specs in `specs/`)

- **bm22** — Environmental gate: apply `0033`/`0035`–`0038`, partitions, DB-gated
  suites, render image, blob store, live-Kestra smoke, SFTP, worker plugins.
- **bm23** — `billing.customer_bill_line` schema: partitioned, `ON DELETE CASCADE`
  FK (`0039`), repository.
- **bm24** — Claim release on reject/cancel/rerun (`markRejected` = release to
  `RATED`, four claim columns cleared).
- **bm25** — Rating in-flight guard: `LOAD_BLOCKED_INFLIGHT` (MINOR),
  `billrun_status_guard` narrowed to `RATED → BILL_DRAFT`.
- **bm26** — Sample seed → `RAN_USAGE` (NULL `billrun_ban_id`, matching `rl.py`);
  `ci`/`volume` profiles, six scenarios; `SUBSCRIPTION_RECURRING` retired.
- **bm27** — Real Collection: subscriber→account correlation
  (`udr_subscriber_ref_id → product_inventory → billing_account_id`, once per run) +
  claim; Validation folded in; unresolvable subscriber surfaced, not dropped.
- **bm28** — Real Aggregation (USAGE): roll claimed `udr_rated` into
  `customer_bill_line` at grain `(product_offering_id, udr_type)`.
- **bm29** — Real Aggregation (RECURRING) + as-of price resolver, quantity ×
  period, price **snapshotted** onto the line (read-not-re-resolved on rerun).
- **bm30** — Verification + bill↔charge reconciliation (`USAGE` gross = SUM of rolled
  `udr_rated`).
- **bm31** — `charge_checksum` re-anchored on `customer_bill_line` (business content,
  all three money columns).
- **bm32** — Uncharged redefined as "no `customer_bill_line`"; `BILL_NOTUSED` given
  its own per-record exception surface.
- **bm33** — Retire `BILLRUN_PLACEHOLDER_MODE` (flag + banner/badge removed; `_SAMPLE_`
  marker, unclaimed-on-seed rule, prod guard, and `_FORCE_FAIL` kept).
- **bm34** — Real distribution: Azure Blob download → SFTP upload → per-artifact
  outcome POST, multi-target, real `http.Request` terminal callbacks.
- **bm35** — Phase 3 ship gate (audit + full E2E on the `ci` seed).

### Phase 4 — signal-back, self-driving lifecycle, prod wiring (specs in `specs/`)

- **bm36** — Processor signal-back (per-stage + terminal): real per-stage `DONE`
  POSTs, a per-account HARD `FAILED` (account stage group `errors` handler, wrapped
  in an `allowFailure` Sequential so siblings keep processing; its `errors`
  handler POSTs FAILED to a FIXED `verification` stage — collision-free and always
  a valid `Stage` enum, so the signal never 422s/wedges), and run-level terminal
  `PROCESSING_FAILED` for a whole-execution failure only (`errors: on_error` on
  `FAILED`; `afterExecution: on_killed` on a KILL — in `afterExecution`, not
  `finally`, since only `afterExecution` sees the settled terminal state — never on
  `WARNING`, a contained per-account failure derives `PROCESSED` per the tested
  run-status contract) in
  `bill_run_processing.yml` — real `http.Request`, mirroring bm34, replacing the
  `Log` stubs. `BILLRUN_PROCESSING_FORCE_FAIL` (deploy-time/
  test toggle, read only by `trigger-run.ts`, no UI) threads onto the
  `ProcessingTriggerPayload.force_fail` input and drives the first scoped account
  HARD at aggregation for the bm37 gate. Template contract + `billmgmt-architecture`
  (changelog #15, processing↔distribution terminal-asymmetry note, **no new
  invariant**) + `billmgmt-code-standards` synced. No new schema, no migration.
- **bm37** — Local end-to-end assertion + reconcile alignment: rewrote
  `scripts/billrun-live-kestra-smoke.ts` (superseding the bm21 "trigger → claim →
  PROCESSED" gate) to drive and assert the FULL `SCHEDULED → COMPLETED` operator
  journey against the real deployed flows on the `_SAMPLE_` `ci` seed —
  processing force-fail settlement (forced account `PROCESSING_FAILED`, run
  recomputes to `PROCESSED` per **decision (a)**) + rerun recovery, reject →
  blocked approval (`no_rejected_pending`) → reprocess, four-eyes approve (a
  second seeded actor), post → `INVOICED`, distribution force-fail →
  `rerunDistribution` → `COMPLETED`. Because the two force-fail toggles
  (`BILLRUN_PROCESSING_FORCE_FAIL`/`BILLRUN_DISTRIBUTION_FORCE_FAIL`) resolve to
  process-global `const`s (fixed at config import), the script **re-spawns itself
  as three sequenced leg processes** (`proc-fail` → `drive` → `redist`), each
  with its own force-fail env, handing the run id off via a temp file; the whole
  journey runs on the SINGLE due `ci` period (not two calendar-distinct runs),
  with the failure injections sequenced so no run is ever simultaneously
  reject-blocked and processing-failed. Adds the reconcile-alignment healthy-run
  asserts (`mismatch: false` and `isStalled` false on every poll while signals
  flow); the complementary wedge-guarantee (SUCCESS-but-non-terminal grain →
  `mismatch: true`, no forced status, no heartbeat bump) is the pre-existing
  targeted unit in `reconcile-run.service.test.ts` (bm37 cross-ref added). The
  `_SAMPLE_`-only safety gate now re-runs at the head of every mutating leg. **No
  flow/compute/receiver change** (`reconcile-run.ts` unchanged — asserted, not
  touched); no new schema, no migration.
  - **Review hardening (2026-09-16):** the safety gate's charge check was inert
    (it keyed on `billrun_ban_id`/`status='RATED'`, which never matches the
    unclaimed-NULL seed shape) — re-derived to correlate candidate charges via the
    real `udr_subscriber_ref_id → product_inventory → billing_account_id` path
    (mirrors `rated-lines.repository.ts`), so the second boundary now has teeth.
    Post → distribution now fails fast if the run is left at `INVOICED`/`POSTING`
    (swallowed auto-trigger / parked account) instead of polling into a 10-min
    timeout; "no due SCHEDULED run" now distinguishes never-seeded from a
    non-resumable prior run left mid-lifecycle (points at re-seed); the reject leg
    steers away from the just-recovered forced account; handoff-file read + the
    `--env-file` execArgv filter hardened. No behavioural change to the proven
    lifecycle.
- **bm38** — Production deployable + wired (Phase O). Infra + doc only (no app
  code, no schema, no migration). (1) `workflow-engine-container-app.bicep`
  gained a `hostsBillrunNamespace` param that gates the `billrun_runtime` DB
  credential onto the billrun-hosting engine only, wired **exactly like the
  rating one** (review fix — the deployed `bill_run_processing.yml` reads split
  coords + a bare password via `PGPASSWORD`, NOT a full URL): a
  `billrun-runtime-db-password` Key Vault secret exposed as
  `SECRET_BILLRUN_RUNTIME_PASSWORD` + the non-secret `BILLRUN_DB_HOST`
  (= `postgresServerFqdn`)`/PORT/NAME`(=`enterprise_billing`)`/USER` env vars.
  `main.bicep` passes the param `true` at the collapsed + split-billrun call
  sites, `false` at the split-rating instance. (The initial bm38 pass wired a
  `billrun-runtime-db-url` full-URL secret + `BILLRUN_RUNTIME_DATABASE_URL` env
  per the stale bm14 spec text; a code review caught that NO code/flow consumes
  that var — the flow would hard-abort on the unset `SECRET_BILLRUN_RUNTIME_PASSWORD`
  — so it was re-wired to the split shape and the orphaned
  `BILLRUN_RUNTIME_DATABASE_URL` was dropped from `.env.example`.) (2)
  `db-role-verification.md` §1/§2 now fold `billrun_runtime` into the
  rating/kestra split-shape group (bare-password secret + `*_DB_*` coords) and
  name its consumer (the `workflow-engine` container), superseding the "not yet
  wired" note, and a new **Production
  cutover** runbook records the order of operations (provision role/password →
  store KV secrets → deploy engine → deploy flows → run smoke → flip SFTP), the
  `billrun-engine-auth` username = `workflow-ops@billing.ops` coupled-triple
  rotation, the re-run-`db:bootstrap-billrun-roles`-after-grant-pulls note, and
  the ratified taxation-`0.00` interim. (3) `azure-pipelines.yml` resolved the
  `billrun-engine-url`/`-auth` NOT-YET-CREATED flags to a NAMED
  out-of-band cutover prerequisite and dropped the "separate workflow-management
  repo / TBD owner" framing; the deploy flags (`deployWorkflowEngine`,
  `deployRatingFlows`, `runBillrunLiveKestraSmoke`) stay off by default and
  `deploy_workflow_flows` still maps `bill-run-processor/local-dev` +
  `bill-run-distributor/local-dev` → `billrun`. (4) `bill_run_processing.template.yml`
  + both `bill-run-*/README.md` now name the repo's `local-dev` flow as THE
  deployed flow (no separate repo); `billmgmt-architecture.md` §5 states the
  collapsed-topology shared engine hosts the `billrun` namespace with no
  separate processor/distributor container. `az bicep build` clean on
  `main.bicep` + the module. **Not done here:** the real cloud cutover (flag
  flips + live smoke against a real engine/SFTP) — a gated ops step.
  - **Residual (out of bm38's enumerated boundary):** the deployable
    `bill-run-processor/local-dev/bill_run_processing.yml` and
    `bill-run-distributor/local-dev/bill_run_distribution.yml` headers still
    carry a "separate workflow-management repo" line; the bm38 spec scoped the
    fiction-correction to the template + READMEs only, so these were left —
    fold into a later flow-touching unit.
- **bm39** — Phase-4 ship gate (Phase O). Audit + sign-off; no rebuild, but the
  audit surfaced one genuine gap and closed it in-boundary (bm13/bm21 "fix what the
  audit finds"; the unit's boundary is cross-cutting tests + docs/tracker). Confirmed
  every Phase-4 behaviour present + green per boundary: bm36's real `http.Request`
  signal-back (five per-stage `DONE` POSTs + per-account HARD `FAILED` + run-level
  `on_error`/`on_killed` terminal `/status`, no signal `Log` stub);
  `BILLRUN_PROCESSING_FORCE_FAIL` default `false` + single reader (`trigger-run.ts`);
  receivers unchanged; distribution real (bm34); bm38's bicep secret wiring reviewable
  with deploy flags gated off. **No new schema/migration** (migrations set unchanged
  since bm23's `0039_customer_bill_line`; `_journal.json` ends at idx 39).
  **Gap closed:** the signal-back had no CI regression guard (a callback reverted to a
  `Log` stub would pass every existing test), so bm39 added the static, DB-free
  `tests/guardrails/billrun-processing-signal-back.test.ts` (4 asserts, green),
  promoting code-standards §9 item 34 from a described audit-grep to a real CI-wired
  guardrail beside item 35's flag test. `tsc`/`eslint`/DB-free vitest green (incl. the
  new test). Doc closeout: `billmgmt-code-standards.md` §9 items 34–35 added;
  `billmgmt-known-issues.md` §9 resolved (bm36) / §10 ratified interim;
  `billmgmt-project-overview.md` signal-back callout dropped + SC9 folded delivered
  (with the live-smoke gated-step caveat). **The live-Kestra full-journey proof is the
  gated live-stack step** (bm37's `billrun:live-kestra-smoke` against the provisioned
  real stack — not up in this session), CI-doubled by
  `tests/db/billing-e2e-happy-path.integration.test.ts`. One new test file; no
  app/flow/schema change.
  `billmgmt-gap-assessment.md` (a spec-referenced doc-sync target) does not exist in
  the repo — its intent is subsumed by this closeout. See `specs/bm39-phase4-ship-gate.md`.

## Outstanding / Next (post-Phase 4)

- **Cloud cutover (gated ops step, NOT wiring)** — the bicep/pipeline/doc wiring
  landed in bm38. What remains is the operator action: provision the out-of-band
  Key Vault secrets (`billrun-runtime-db-password`, `billrun-engine-url`/`-auth`, and
  SFTP if used), flip `deployWorkflowEngine` → deploy the collapsed engine →
  `deployRatingFlows` → `runBillrunLiveKestraSmoke` against the real engine, then
  `enableSftpDistribution` only when a real SFTP endpoint exists. Full order of
  operations: `infra/docs/db-role-verification.md` "Production cutover".
- **Before any prod deploy:** rotate `billrun-engine-auth` so its username half
  matches `workflow-ops@billing.ops` (coupled triple — engine, pipeline `--user`,
  and this out-of-band Key Vault secret), or every app→engine call 401s.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles` (the
  `billrun_status_guard` now permits `REJECTED → BILL_DRAFT` re-claim).
- **DB verification:** run the full DB-gated suite (incl. the extended
  `billing-e2e-happy-path`) and `db:seed-sample` against a disposable/CI Postgres —
  never the shared local dev DB.

## Key decisions (durable)

- **Three snake_case permissions** (`billrun_view/operate/approve`) for segregation
  of duties; permission rows in a migration, grants in a seed; `billrun_*` optional.
- **Write-then-signal (D6):** the flow (as `billrun_runtime`) writes the bill data and
  signals; the app receiver is **record-only** (`TERMINAL_STAGE = 'verification' →
  PROCESSED`). Idempotency is solely the DB unique constraint on
  `bill_run_account_stage`; a stale-attempt signal is an accepted no-op.
- **Two-writer boundary:** the app's only `rating` write is the six claim columns via
  `udr-status.repository.ts`; `billrun_runtime` holds no table-level `DELETE` on
  `customer_bill_line` (the scoped `SECURITY DEFINER` is the only deletion path);
  `billrun_status_guard`/`rating_status_guard` enforce transitions at the DB.
- **RECURRING exactly-once = whole-account line replace**; the price snapshot is read,
  never re-resolved, on rerun (Inv #20).
- **Next-cycle operability keys off `INVOICED`, not `COMPLETED`.**
- **Hand-authored partitioned migrations;** `drizzle-kit generate` is retired past
  `0026` (apply path reads the journal + `.sql`). Run `db:migrate` then
  `db:setup-partman-billing`.

## Known residuals

- **DELIVERED (2026-09-18, owner decision) — Workflow tab: derived app-side
  stages, distribution removed from the grid, run-level flow bar added.** Four of
  the nine grid columns (`scoping`, `posting`, `rendering`, `distribution`) had
  never been written by anything — only the processor's five M2M callbacks write
  `bill_run_account_stage` — so a `COMPLETED` run still rendered "posting:
  pending", reading as a broken pipeline. Fixed by DERIVING them in
  `get-stage-timeline.ts` rather than fabricating stage rows (Inv #12 — derived
  on read, never stored):
  - **scoping** — the `bill_run_account` row itself (`scopeAccounts` only
    snapshots ACTIVE accounts, so a row IS "scoped in and active"). Keyed on
    `error_code = 'PARTIAL_PERIOD'` as well as `status = 'EXCLUDED'`, because
    `approveRun` re-badges EXCLUDED → SKIPPED and the status alone stops
    identifying a scoping-time exclusion after approval (`[CRITICAL]` test).
  - **posting** — the account reaching `INVOICED`; `SKIPPED` shows SKIPPED; a
    parked `PROCESSED` + `POSTING_FAILED` shows FAILED. Needed
    `listStatusesForRun` to carry `errorCode` (additive; existing callers
    unaffected).
  - **rendering** — a `bill_run_invoices` row for the account, via the existing
    `listBillingAccountIdsForRun`. An `INVOICED` account without one is
    genuinely render-pending, so PENDING there is true.
  - **distribution** — REMOVED from the per-account grid (`TIMELINE_STAGES`).
    `bill_run_distribution` keys on `artifact_ref`, and its `REPORT` artifact
    belongs to no account, so a per-account cell could only be fabricated.
    `STAGES` is unchanged and still mirrors the `bill_run_account_stage.stage`
    CHECK exactly; the M2M ingest still accepts every value.
  A real stage row always WINS over the derivation, so wiring any of the three to
  a genuine signal later needs no change here. **New `RunFlowProgressBar`** shows
  the nine steps at run level and, when the run reaches distribution, links the
  operator to the Distribution tab (where the per-artifact log actually lives).
  The RUN status acts as a FLOOR on the bar so a `COMPLETED` run can never render
  an earlier step as `current`. Verified live on `BRN00000001`. 316 files /
  3160 tests green.
- **FIXED (2026-09-18, owner decision) — the Workflow tab's mid-flight summary
  line no longer contradicts the flow bar.** `StageTimelineSummary` counts only
  `processed`/`processingFailed`/`excluded`, so once posting moved accounts off
  `PROCESSED` a finished run read "0 processed, 0 processing failed of 6"
  directly beneath a fully green flow bar. `summary.isMidFlight` (derived from
  the RUN status, not from the counts — an in-flight run with genuinely nothing
  processed still shows "0 of N") now gates it, and past the processing phase the
  line falls back to a plain "N accounts in this run." **The gate is WIDER than
  "terminal"**: `INVOICED` and `DISTRIBUTING` are live states, but posting has
  already emptied the counts there, so the line was equally misleading —
  `APPROVED`/`POSTING` are deliberately excluded, since approval only re-badges
  failed/excluded accounts and the counts still hold until posting runs. Covered
  by table-driven tests over every run status.
- **FIXED (2026-09-18) — Workflow-tab flow-bar review findings (post-review of
  the derived-stages + flow-bar change set).** Six correctness/consistency fixes,
  each verified against the canonical reference before changing:
  - **Posting cell mislabelled a parked non-`POSTING_FAILED` failure as PENDING.**
    `deriveAppSideStage`'s posting branch only mapped the literal `POSTING_FAILED`
    to FAILED, so an account parked on any other first-class code (chiefly
    `PERIOD_CLOSED`) at `status = PROCESSED` read as a misleading PENDING — the
    exact defect the derivation exists to remove, and a contradiction with the
    Posting tab. Now: a `PROCESSED` account with ANY non-null `error_code` is
    FAILED, mirroring `get-posting-progress.ts` (safe because
    `handle-stage-signal` clears the code on a clean terminal signal, so a healthy
    `PROCESSED` account never carries one).
  - **Flow bar showed a red stage on a green COMPLETED run.** `anyFailed` scanned
    ALL rows, so a `PROCESSING_FAILED` account re-badged `SKIPPED` at approval kept
    painting its (still-present) FAILED stage cell onto the run-level bar. New
    `RESOLVED_OUT` set ({EXCLUDED, SKIPPED}) excludes resolved-out accounts from
    `anyFailed`; a live `PROCESSING_FAILED` failure still surfaces (it is
    deliberately NOT in the set). The per-account grid still shows the historical
    failure.
  - **Force-completed distribution read as a clean `done`.** A `COMPLETED` run
    reached via T11 force-complete carries abandoned FAILED artifacts; the bar's
    distribution step showed `done` (green ✓) over them, contradicting the
    Distribution tab. `getStageTimeline` now reads
    `billRunDistributionRepository.hasAbandonedArtifactsForRun` (a boolean mirror
    of the tab's "FAILED at max attempt" rule, fetched only for a COMPLETED run)
    and `deriveDistributionState` returns `failed` when abandoned.
  - **CANCELLED run's bar looked in-progress.** A cancelled run resets accounts to
    PENDING with no run-status floor, so the bar rendered scoping `done` /
    validation `current`. The Workflow tab now suppresses the bar for a CANCELLED
    run and shows a plain note (`runStatus` threaded into `RunDetailTabs`); the
    per-account grid still reflects the reset.
  - **Calm distribution hint sat over a failed delivery.** The "This run is at the
    distribution step" hint keyed on `currentStage`, which also anchors a FAILED
    step. It now gates on the distribution step's own `current` state.
  - **Duplicated stage-label map.** `run-flow-progress.tsx` and `stage-timeline.tsx`
    each maintained a stage→label map; unified into one exported `STAGE_LABELS`
    (`types/billing.ts`) consumed by both.
  **Deliberately NOT changed (verified non-issues):** the max-attempt-*per-stage*
  read in `listLatestForRun` is required for partial-rerun display (not a bug); a
  stale prior-attempt `bill_run_invoices` render row is unreachable (one immutable
  row per run/account, and cancel is gated to `PROCESSING`); the tax-only /
  net-zero sign-rule gap stays the documented latent item (known-issues §12 —
  unreachable while taxation derives tax from subtotal). `tsc`, `eslint`,
  `prettier`, and the billing vitest suites pass.

- **VERIFIED (2026-09-17) — first full `SCHEDULED → COMPLETED` lifecycle on real
  infrastructure.** `BRN00000001` (the `_SAMPLE_` `ci` seed) traversed
  `PROCESSING → PROCESSED → APPROVED → POSTING → INVOICED → DISTRIBUTING →
  COMPLETED` against real Postgres + real Kestra 1.3.35 + Azurite, with 4 INV
  documents posted, all 5 artifacts (4 invoice PDFs + the run report CSV)
  `DELIVERED` to the `loopback` sink at byte-exact sizes under the architecture
  §3 subtree layout (`/distribution/invoices/2026-08/`,
  `/distribution/reports/2026-08/`). This is the bm22/bm35 exit criterion that
  the tracker had listed as pending execution.
- **FIXED (2026-09-17) — `bill_run_distribution` had three independent defects,
  none previously exercised** (distribution had never actually run locally, so
  the whole flow was unverified):
  1. **`parents[1]` does not exist at that depth.** The flow read the TARGET as
     `parents[1].taskrun.value`; probed directly against the pinned engine,
     `taskrun.value` IS the artifact and `parents[0]` IS the target. Every run
     died on `upload_local`'s `runIf` with
     `PebbleException: Could not perform not equals comparison`, so nothing was
     ever delivered and no outcome was ever POSTed. Same family as the processor
     bug. The file's comment asserting the opposite is replaced with the
     measured behaviour.
  2. **Task outputs inside a nested ForEach are keyed by BOTH loop values.**
     `{{ outputs.download.blob.uri }}` is unresolvable there; the shape is
     `outputs.<task>[<outer value>][<inner value>]`, so the correct reference is
     `outputs.download[parents[0].taskrun.value][taskrun.value].blob.uri`.
     Fixed at all three sites (both uploads + the outcome POST's
     DELIVERED/FAILED decision, which silently evaluated to FAILED for every
     artifact before).
  3. **`kestra-internal` container was never created.** Azurite does not
     auto-create containers and neither does Kestra — it PUTs and takes the 404.
     `azure.storage.blob.Download` fetched each invoice PDF successfully
     (Azurite logged `206`) and then failed writing the result into Kestra's OWN
     internal storage, surfacing as a bare `BlobStorageException: Status code
     404` that looked like a missing invoice. Added `npm run dev:azurite-init`
     (`scripts/azurite-init.ts`, idempotent `createIfNotExists`).
- **FIXED (2026-09-17) — the Distribution tab crashed whenever it had rows.**
  `components/billing/distribution-tab.tsx` (a SERVER component) imported
  `failedArtifactRefsFromRows` from the `"use client"`
  `force-complete-distribution-dialog.tsx`; Next refuses that at runtime
  ("Attempted to call ... from the server but ... is on the client") and the
  whole run-detail page fell to its error boundary. Invisible until now because
  the tab only reaches those call sites once `bill_run_distribution` has rows.
  The helper is a pure function over plain rows, so it moved into the server
  component that uses it.
- **FIXED (2026-09-17) — Azurite was not persisting to its volume.** The compose
  service mounted `azurite_data:/data` but ran without `-l /data`, so Azurite
  wrote its store to `/opt/azurite` inside the container: every rendered invoice
  PDF and all of Kestra's internal storage lived in the container layer and
  would be lost on any recreate. Now `-l /data`. **Note for anyone repeating
  this:** migrating an existing store must copy `__azurite_db_blob__.json`,
  `__azurite_db_blob_extent__.json` AND `__blobstorage__/` together — copying
  the blob DB without the extent DB leaves the metadata pointing at extents the
  new instance cannot resolve and every GET returns `500`.

- **OPEN (2026-09-17, tracked as known-issues §11) — the processor writes a `subtotal-0.00` header for a
  zero-charge account.** `bill_run_processing`'s `ins_header` CTE is a
  data-modifying CTE, so it runs exactly once regardless of whether `all_lines`
  is empty; the flow's own comment calls this "the deferred limitation". Since
  bm32 redefined Uncharged (Inv #22), such an account is scoped, `PROCESSED`
  and Uncharged — so the empty header is the only artefact of it. Everything
  else already expects the header NOT to exist: Verification guards with
  `IF v_total IS NOT NULL` and treats a non-positive total as a **SOFT,
  advisory, non-blocking** NOTICE, and `listUnchargedForRun`'s `HAVING` keeps
  accounts with "NO bill/line". **Durable fix:** make `ins_header` conditional
  on `all_lines` being non-empty, so a zero-charge account produces no bill at
  all. Until then the empty header reaches posting and would consume an invoice
  number for a 0.00 INV unless `document_line_amount_check` (`amount > 0`)
  rejects it first and parks the account.
  **Interim (owner decision, 2026-09-17):** the approval gate was loosened
  rather than the flow fixed — see the next entry. The engineering
  recommendation was the flow fix; the owner chose the gate change to unblock
  approval, with the invoice-number consequence stated and accepted.
- **DECISION (2026-09-17, owner; known-issues §11 mitigation 2, latent risk §12) — posting suppresses the zero-value invoice.**
  The predicted consequence of the gate loosening below landed immediately: the
  line-less 0.00 bill reached posting, `document_line_amount_check`
  (`amount > 0`) rejected the revenue line (posting inserts it at
  `amount = subtotal`), and the account parked at `POSTING_FAILED` with an
  opaque "An unexpected error occurred while posting this invoice."
  `postAccount` now skips a bill whose **`subtotal` AND `total_amount` are both
  exactly zero**, marking the account `SKIPPED` /
  `ZERO_TOTAL_NOT_INVOICED` so `completePosting` can still finish the run.
  Consistent with Inv #7 — a suppressed bill consumes no invoice number.
  **Deliberately narrow, with `[CRITICAL]` tests on both edges:** a
  **negative** total is a credit position with real economic substance and is
  NEVER skipped (it must keep failing loudly until a credit-note path exists —
  out of scope); and `subtotal = 0` with a non-zero `total_amount` (a tax-only
  bill) is NEVER skipped either, since that would drop a real tax liability.
  Zero comparison goes through `money.compare` (exact, integer sen) — the
  `Number(<amount>)` grep gate in `tests/accounts/grep-gates.test.ts` caught the
  first attempt and was respected, not amended. Verified live: `BRN00000001`
  `POSTING → INVOICED → DISTRIBUTING`, 4 INV documents for 5 processed
  accounts, `BAN…04` `SKIPPED`. **Open accounting caveat:** once discounting
  ships, a bill can net to zero because a charge was fully discounted. That is
  NOT a revenue-recognition exposure — net IS the transaction price, posting
  books the GL revenue line at `amount = subtotal` (net), and the gross/discount
  split survives on `customer_bill_line` either way — but the predicates cannot
  tell it apart from a no-charge account, so it would wedge the whole run at
  approval and then issue no invoice to a customer who had real activity
  (known-issues §12). The
  skip must be re-evaluated then — today `discount_amount` is always `0.00`, so
  a zero net can only mean a zero charge.
- **DECISION (2026-09-17, owner; known-issues §11 mitigation 1, latent risk §12) — `positive_totals` narrowed; `zero_total_bills`
  added as informational.** `countNonPositivePostable` now excludes bills with
  no `customer_bill_line`, so a line-less zero bill no longer blocks approval; a
  bill WITH lines that totals `<= 0` still does. A new informational check
  (`zero_total_bills`, bm32's `informational` contract — always passes, never
  gates) reports how many postable bills total zero, so they stay visible to the
  approver. Touched: `customer-bill.repository.ts` (narrowed query +
  `countZeroTotalPostable`), `pre-approval-checks.ts`, `types/billing.ts`,
  `components/billing/pre-approval-checks.tsx`, both pre-approval test files,
  and `specs/bm10-approve.md` (whose stale "excluded at Scoping" premise is
  corrected in the same change set, per workflow rules §7.5/§7.8). Verified
  against the live `ci` seed: `BRN00000001` blocking count 0, informational
  count 1, four-eyes still correctly refusing the trigger actor.

- See `billmgmt-known-issues.md` for the full list. **Accepted residual (ENG
  CLEARED, 2026-09-14):** posted `customer_bill_line` rows have no DB-level
  immutability trigger and `charge_checksum` is not re-verified after posting, so
  post-posting line tampering has no active detection until a re-verification path is
  added.
- **FIXED (2026-09-17) — `bill_run_processing` failed its first stage on the pinned
  engine.** Every execution ended `per_account → account_pipeline → validation`
  `FAILED` with `IllegalVariableEvaluationException: Unable to find 'value'`. The
  flow read `{{ taskrun.value }}` from tasks nested inside the bm36
  `account_pipeline` `Sequential` within the `per_account` `ForEach`; the file's
  comment asserted the ForEach value "is inherited by descendants" — it is not.
  **Probed directly against 1.3.35** (throwaway `scratch.parents_probe` flow
  mirroring the nesting, since deployed-YAML behaviour is not something to guess
  at): from inside the wrap `taskrun.value` is unresolvable,
  `parents[0].taskrun.value` IS the account id in both the stage tasks and the
  `errors` handler, and `parents[1]` does not exist at that depth. All 15
  references now use `{{ parents[0].taskrun.value }}` — the convention
  `bill_run_distribution.yml` already documents — and the misleading comment is
  replaced with the measured behaviour. No task logic, SQL, callback contract or
  stage taxonomy changed.
- **FIXED (2026-09-17) — local status callbacks were unreachable on the host-based
  stack.** The processor/distributor callbacks POST to `http://app:3000/api/billrun/…`
  (the Compose service name), but the README's host-based path runs the app on the
  host with no `app` container, so every signal died with
  `java.net.UnknownHostException: app`. Fixed in **local-dev infrastructure, not the
  flow**: `workflow-management/dev/docker-compose.dev.yml` now sets
  `extra_hosts: ["app:host-gateway"]` on `workflow-engine`. **No flow URI changed**,
  so the deployed contract (architecture §5 — the same YAML ships) is byte-identical
  and bm38's deploy wiring is untouched. Documented trade-off in that file: /etc/hosts
  precedes Compose DNS, so running the containerized `app` service together with this
  file would send callbacks to the host instead. The prior "callbacks are still
  stubbed (logged, not sent)" README wording was stale — bm36 replaced the `Log`
  stubs with real POSTs.
- **VERIFIED (2026-09-17) — the phase-4 processing leg now runs end to end locally.**
  With both fixes plus two environment corrections (`BILLRUN_APP_TOKEN` must equal
  the base64-decoded `SECRET_BILLRUN_APP_TOKEN`, not a random value; a stale
  Turbopack `.next` cache 404s the deeper `app/api/billrun/**` routes), a
  `_SAMPLE_` `ci`-seed run went **`PROCESSING → PROCESSED`**: execution `SUCCESS`,
  5 accounts × 5 stages × 5 `signal_*_done` all green, `customer_bill` rows written
  by `billrun_runtime` (224.00 / 634.50 / 199.00 / 0.00 / 199.00), `BAN00000005`
  correctly `EXCLUDED` (Inv #26) and `BAN00000004` billed at zero. This is the
  bm36 signal-back contract (architecture "What changed" row 15) demonstrated
  against real Postgres + real Kestra for the first time. Distribution remains
  un-exercised locally (needs the SFTP endpoint + key material).

## Environment quirks

- Pre-existing, unrelated to this module: 4 hardcoded-date-drift test files
  (`tests/actions/{create-order,resume,suspend,terminate}-subscription*`) fail on a
  clean baseline (dates now >3 days past). Confirmed this module never touches them.
- Context docs live under `context/billing-management/` (renamed from a `billling-`
  triple-l typo).
- **FIXED (2026-09-17) — Windows CRLF broke 9 tests in 3 files.** The repo had no
  `.gitattributes`, so Git for Windows' default `core.autocrlf=true` checked `.sql`
  files out CRLF. The guardrail helper strips SQL comments with
  `line.replace(/--.*$/, "")` after `split("\n")`, but `\r` is a JS regex line
  terminator — `.` never matches it and `$` (no `m`) never matches before it, so
  the strip silently no-opped and `billrun-db-roles.sql`'s read-only-boundary prose
  tripped the `not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i)` assertions.
  Affected `billing-customer-bill-line-replace-boundary` (5),
  `billrun-inventory-write-boundary` (2) and `pgledger/transform` (2, byte-for-byte
  compare). Fixed by adding `.gitattributes` with `*.sql text eol=lf` (plus
  `* text=auto` and binary pins) and re-normalizing the working tree — **no
  assertion weakened**, which matters because two of the nine are `[CRITICAL]`
  write-boundary guardrails that were silently passing-by-accident/failing-by-
  accident on Windows. Full unit suite now **315/315 files, 3137/3137 tests**.
- **`npm run test`'s DB-gated half is destructive by default (2026-09-17).** With a
  dev `.env` exported it points the 91 `*.integration.test.ts` suites at the shared
  dev DB and `DROP SCHEMA … CASCADE`s it. The convention (bm22 §21 — disposable DB
  only) was recorded in the specs but not in `README.md`; the README now carries it
  with a worked disposable-DB invocation. Separately, the configs' promised
  "skip loudly when `DATABASE_URL` is unset" never fires — `db/client.ts` imports
  `lib/config.ts` at module load and throws before `describe.skipIf` is evaluated,
  so every DB-gated file errors instead of skipping.
- **[CRITICAL] The DB-gated suite kills a co-located workflow engine (2026-09-17; known-issues §13).**
  A disposable `DATABASE_URL` is necessary but NOT sufficient:
  `tests/db/billrun-db-roles.integration.test.ts`'s `afterAll` runs
  `DROP DATABASE IF EXISTS "kestra" WITH (FORCE)` — outside `DATABASE_URL`, against
  the whole cluster. `FORCE` terminates every live connection first, so the running
  engine lost all Hikari connections at once (`SQLSTATE(08006)`), each queue poller
  logged `Fatal error while polling … Initiating shutdown`, and the container exited
  0 with the `kestra` DB left dropped and **every deployed flow gone**. Observed
  13:15:40 UTC during the first full DB-gated run. Recovery:
  `db:bootstrap-kestra-roles` → `ALTER ROLE kestra_engine` → `up -d --no-deps
  workflow-engine` → `flow-deploy`. The suite therefore needs either a separate
  Postgres *instance* or the engine stopped for its duration — the bm22 §21
  "disposable database" wording understates this. README now documents both.
- **First full DB-gated run executed (2026-09-17; failures tracked as known-issues §4c)** against a disposable DB in the
  dev cluster: **89 files passed, 2 skipped, 2 failed** (813 passed / 68 skipped /
  2 failed tests). Both failures are the full-journey E2E suites
  (`tests/db/billing-e2e-happy-path`, `tests/db/billrun-phase3-journey`) at the same
  post→distribute assertion — `expected 'INVOICED' to be 'DISTRIBUTING'`: posting
  settles the run at `INVOICED` but the post-commit `triggerDistribution` does not
  advance it (`distribute-run.ts` rolls back and returns `ENGINE_UNREACHABLE` when
  `engineRegistry.trigger` throws). Both are also sensitive to ambient env beyond
  `DATABASE_URL` — with a dev `.env` also exported, `billrun-phase3-journey` fails
  earlier instead (line 568). **UNTRIAGED** — this is the gated verification step
  the tracker listed as not yet executed, so these are first-execution results, not
  a known regression.

## Open questions

- **bm37 — reconcile the failure-path terminal wording (RESOLVED 2026-09-16,
  option (a)).** The bm36 spec's checklist and bm37 §2 both wrote that a
  per-account HARD failure makes "the run recompute to `PROCESSING_FAILED`", but
  the established, tested contract derives **`PROCESSED`** for a mixed
  `PROCESSED`/`PROCESSING_FAILED` terminal set (`compute-run-status`), with the
  failed account `SKIPPED` at approval and the run rerunnable — and on the
  multi-account `ci` seed `BILLRUN_PROCESSING_FORCE_FAIL` only fails the FIRST
  scoped account (contained WARNING → engine `SUCCESS`), so the run cannot reach
  run-level `PROCESSING_FAILED` without a whole-execution `FAILED`/`KILL`.
  **Decision: option (a)** — keep the tested contract. bm37's Run-B leg asserts
  the forced account settles to `PROCESSING_FAILED` via the terminal signal and
  the RUN stays `PROCESSED`; the rerun (force-fail off) recovers it, then the run
  carries through approve → post → `COMPLETED`. No `computeRunStatus`/receiver/
  flow change.
- **Receiver hardening deferred (out of bm36 scope — "no receiver change").** The
  run-level `PROCESSING_FAILED` `/status` push has no `attempt`/execution-stale
  guard (unlike the `DISTRIBUTION_*` pushes), so a superseded execution's late
  `on_error`/`on_killed` could force-fail an in-flight rerun; and
  `handle-status-push.ts`'s 409 messages are inverted relative to the run's actual
  state. Both live in `handle-status-push.ts`/`status-push.schema.ts`; fold into a
  receiver-touching unit (bm37 or later).
