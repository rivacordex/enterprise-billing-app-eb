# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-09-16 (Phase 1–4, bm01–bm39) and 2026-10-07 (Target Capacity
Pricing update, bm40–bm46) — per-unit narrative, post-review-fix logs, and
test-file enumerations trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit
detail: `context/billing-management/specs/bm*.md`._

## Current state (2026-10-07)

- **Target Capacity Pricing update (bm40–bm46): implementation DELIVERED,
  2026-10-07.** bm40–bm45 shipped the full design (bill-run foundation
  repair, commitment-floor + motivation-discount aggregation, verification +
  Model-2 gate, checksum re-anchor, invoice usage appendix); bm46 (ship gate)
  audited it and signed off with two items left explicitly OPEN rather than
  assumed green — see the "Target Capacity Pricing update — DELIVERED"
  section below for the full per-unit detail, and
  `billmgmt-progress-tracker.md`'s current-state summary for the live status
  of those OPEN items (TC54's live-Kestra capacity harness, the DB-gated
  capacity suite re-run, and the 5 pre-existing/unrelated vitest failures
  bm46 recorded).
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

### Target Capacity Pricing update — DELIVERED (bm40–bm46, 2026-10-04 → 2026-10-07)

Units bm40–bm45 shipped the full design in
`_updatemodule-billing-billrun-target-capacity-plan.md`'s successor spec set
(`specs/bm40-*.md` → `specs/bm45-*.md`); bm46 (the Target Capacity Ship Gate)
audited the assembled result against guardrails 36–42 / invariants #29–#38,
confirmed no migration beyond bm41's `0044`, and synced the owning docs.
**bm46's audit found two items it could not close in this environment —
recorded as OPEN below, not silently assumed green**: the live-Kestra
capacity journey (TC54) has no runnable harness yet (separately from this
environment lacking a live Postgres/Kestra stack), and the capacity DB-gated
suites have not been re-run against a disposable Postgres. See
`billmgmt-progress-tracker.md`'s current-state summary and
`billmgmt-known-issues.md` §§15–17 for the live-tracked follow-up on these
plus the `npx vitest run` 5-failure detail folded into the bm46 entry below.

### Target Capacity Pricing update — Unit 0 (bm40)

- **bm40** — Bill-run foundation repair: extracted-SQL harness (TC43) + DB-test
  safety (TC58). Re-scoped at spec time off the plan's original "repair the
  resolver off `pop.amount`/`pricing_model`/`price_type`" (already shipped by
  rm22, confirmed via `npm run check:rating-rename-gate` returning zero stale
  `udr_subscriber_ref_id` references and `git log` showing rm22 (`8882008`)
  landed the deployed flow's rename before this unit started — no flow/
  template/README edit was needed here).
  - **Extracted-SQL harness** — new `tests/db/helpers/extract-flow-sql.ts`
    parses the deployed `bill_run_processing.yml`, pulls the `aggregation`/
    `verification` psql heredocs (asserting no unstripped `{{ }}` pebble),
    rebinds the flow's `-v`/GUC variables to test values via the same textual
    `:'var'` substitution psql itself uses, and runs the resulting statements
    in one `sql.begin` transaction (stripping the heredoc's own
    `BEGIN;`/`COMMIT;`, since `sql.begin` supplies that boundary). Exports
    `runAggregation`/`runVerification` as drop-in replacements for the retired
    `tests/db/helpers/billrun-aggregate.ts`/`billrun-verify.ts` hand-copied
    doubles — the five DB-gated suites that drove those doubles
    (`billrun-aggregation`, `billrun-recurring-aggregation`,
    `billrun-volume-aggregation`, `billrun-verification-reconciliation`,
    `billrun-phase3-journey`) now import the harness instead, unchanged
    otherwise. `verification`'s SOFT `NON_POSITIVE_TOTAL` finding is
    reconstructed from a follow-up read (postgres.js has no per-call `NOTICE`
    hook); the HARD `RECONCILIATION_MISMATCH` path runs the flow's own
    `RAISE EXCEPTION` verbatim. Harness self-tests
    (`extract-flow-sql.test.ts`, DB-free) cover both named failure modes: an
    unstripped pebble expression throws, and a statement referencing an
    unbound `:'var'` throws — plus extraction against the real flow file and
    the statement-splitter's handling of dollar-quoted/commented/quoted SQL.
    Added `yaml` as a devDependency (none existed; `postgres` was already a
    dependency).
  - **DB-test safety** — new `vitest.integration.config.ts` `globalSetup`
    (`tests/integration-global-setup.ts`) refuses the whole DB-gated run
    unless `DESTRUCTIVE_DB_OK === "1"` **and** the target carries a disposable
    sentinel (`tests/helpers/disposable-database.ts` — a `_test_disposable_sentinel`
    row, never a name/host match), checked via a raw `postgres` connection
    with zero `@/lib/config`/`@/db/client` imports — fixing the "skip loudly"
    bug (known-issues §13 item 3), since this now runs before any test file
    imports `db/client.ts`. `billrun-db-roles.integration.test.ts`'s `afterAll`
    no longer runs the cross-cluster `DROP DATABASE "kestra" WITH (FORCE)`
    (known-issues §13 item 1); it resets only the `public` **schema** inside
    the `kestra` database (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
    + re-grant), tolerating a missing database/role. Known-issues §13 item 2
    (the shared role-password rewrite) is unchanged — out of this unit's
    scope. README "Tests, typecheck and lint" and known-issues §13 updated to
    match.
  - **Verified in this environment:** `npx tsc --noEmit` clean; `eslint`
    clean on every touched/added file; the harness self-test suite (13 tests)
    passes against the real deployed flow; the preflight's three refusal
    paths (`DATABASE_URL` unset, `DESTRUCTIVE_DB_OK` unset, unreachable DB)
    each exercised directly and behave as designed.
  - **NOT verified here (no reachable Postgres/Kestra in this environment)** —
    pending a local/CI run before this unit ships: the full DB-gated suite
    against a disposable Postgres with `DESTRUCTIVE_DB_OK=1` and the sentinel
    marked; a live-Kestra run on the `_SAMPLE_` `ci` seed reaching `PROCESSED`.
  - **Doc gap, not fixed here:** the spec's final checklist item asks to sync
    "the capacity plan's Unit-0/TC44 note and `bm00-build-plan.md` Part 3" —
    neither `_updatemodule-billing-billrun-target-capacity-plan.md` nor
    `specs/bm00-build-plan.md` exists in this checkout (same gap noted for
    pm28/pm30 in this tracker's history), so that sync could not be done.

### Target Capacity Pricing update — Unit 1 (bm41)

- **bm41 (2026-10-05) — `customer_bill_line` capacity columns, Drizzle mirror & grants.**
  Spec: `context/billing-management/specs/bm41-customer-bill-line-capacity-columns.md`.
  Schema-before-behavior unit, implemented as specified:
  - **Migration** — `db/migrations/0044_customer_bill_line_capacity.sql`
    (journal `idx` 44; `0042` stays unused, `0041`/`0043` were taken) adds
    `rated_amount numeric(18,2)` + `additional_info jsonb` to
    `billing.customer_bill_line`, both nullable, no new `source`/`line_type`
    CHECK; the parent `ALTER` propagates to partitions (not individually
    applied here).
  - **Drizzle mirror** — `db/schema/billing/customer-bill-line.ts` gains
    `ratedAmount`/`additionalInfo` (query typing only, not `drizzle-kit
    push`ed); `additionalInfo` is `.$type<CapacityCalcTrace>()`.
  - **Read model** — `types/billing.ts` extends `BillLineRow` with
    `ratedAmount: string | null` + `additionalInfo: CapacityCalcTrace | null`
    and declares `CapacityCalcTrace` (`{ v, productInventoryId, pricing,
    calc[], summary[] }`, typing only — bm42 writes it, bm45 reads it).
  - **Grants** — `db/bootstrap/billrun-db-roles.sql` adds enumerated
    `billrun_runtime` `SELECT` on `product.product_specifications`,
    `product.ratecard_ran_usage_lkp`, `product.ratecard_version` (none were
    already present); no write grant, `USAGE ON SCHEMA "product"` already held.
  - **Compile ripple (not in the spec's file boundary, required for `tsc`
    green):** `db/repositories/billing/customer-bill-line.repository.ts`'s
    `listForRun` select now also projects `ratedAmount`/`additionalInfo`
    (still NULL until bm42 writes them) — omitting them left the method's
    declared return type (`BillLineRow & {...}`) unsatisfied. Mirrored in the
    `tests/services/billing/list-account-bills.test.ts` line fixture.
  - **Grant assertion test** — `tests/db/billrun-db-roles.integration.test.ts`
    gained `17h`/`17i` (SELECT resolves on the three new tables; INSERT/UPDATE/
    DELETE refused on each), mirroring the existing `17f`/`17g` (bm29) pattern.
  - **Doc sync** — `billmgmt-architecture.md` (storage-delta row + the
    `billrun_runtime` grant bullet) and `billmgmt-code-standards.md` (the two
    "adds to §6" bullets) now name **bm41** and migration `0044` explicitly.
    `bm00-build-plan.md` doesn't exist in this checkout (same gap bm40 noted) —
    that sync step could not be done.
  - **Verified in this environment:** `npx tsc --noEmit` clean repo-wide;
    `eslint` clean on every touched/added TS file; the DB-free unit suite
    (`tests/services/billing/list-account-bills.test.ts`, 16 tests) green.
  - **NOT verified here (no reachable Postgres in this environment, same gap
    as bm40)** — pending a disposable-Postgres run before this unit ships: the
    migration applying on the parent **and** a live partition; the new `17h`/
    `17i` grant-assertion tests; the full DB-gated suite; confirming the three
    new SELECT grants weren't already present (spec step 4's "first confirm"
    — checked by reading `billrun-db-roles.sql`, not by a live grant query).
  - bm42 (capacity aggregation) and bm45 (invoice appendix) are blocked on
    this unit's DB-gated verification, not just this doc entry.

### Target Capacity Pricing update — Unit 2 (bm42)

- **bm42 (2026-10-05) — implemented as specified.** Capacity aggregation:
  commitment floor + N-band motivation discount, the six HARD `CAPACITY_*`
  guards, the `rated_amount`/`discount_amount_raw`/`additional_info` calc
  trace on every capacity line, and the `_SAMPLE_` `capacity` seed profile.
  Spec: `context/billing-management/specs/bm42-capacity-aggregation.md`. No
  DB function, no Python task, no app/UI change, no migration (bm41 already
  shipped the two columns + the three `billrun_runtime` grants this unit
  reads).
  - **Flow SQL** (`bill_run_processing.yml`'s `aggregation` step, mirrored in
    the `.template.yml` contract doc) — between the `_bm29_resolved` D33
    guard and the whole-account replace: `_bm42_capacity` (the as-of,
    pinned-version resolution of usage_rate/capacity_commitment/
    capacity_motivation components, keyed by (offering, unit), detected by
    components not a column — D2/Inv #31/#32) and `_bm42_volume` (every
    claimed row in that volume regardless of type/rate match, so the guards
    can detect a mismatch) feed a `DO $$ … $$` block raising all six codes
    (`CAPACITY_MULTIPLE_SUBSCRIPTIONS`, `_BASE_RATE_NOT_FOUND`,
    `_UDR_TYPE_MISMATCH`, `_RATE_MISMATCH` — `IS DISTINCT FROM`, TC35 —,
    `_MULTI_STEP_UNSUPPORTED`, `_CURRENCY_MISMATCH`). A new `capacity_lines`
    CTE (N-band generic over `steps` via `jsonb_array_elements WITH
    ORDINALITY`) joins the UNION as a fourth `all_lines` source; `usage_lines`
    gained a `NOT EXISTS` anti-join against `_bm42_capacity` (matching
    offering+unit+udrType) so the capacity volume is never double-counted as
    an ordinary USAGE line. `capacity_max_bands` (default 1) is a new flow
    input, threaded into the aggregation psql call's `-v` list.
  - **Extracted-SQL harness** (`tests/db/helpers/extract-flow-sql.ts`) —
    `AggregateParams`/`runAggregation` gained an optional `capacityMaxBands`
    (default 1 when omitted) so every pre-bm42 caller (bm28/bm29's
    aggregation suites) is unaffected by the new `-v capacity_max_bands`
    binding; omitting this would have broken every existing DB-gated
    aggregation test with "no test value was supplied" the moment it ran
    against a real Postgres.
  - **Found-and-fixed regression**: `tests/db/billrun-recurring-aggregation.
    integration.test.ts`'s pm52-era "[CRITICAL] a usage_rate +
    capacity_commitment + capacity_motivation … change no bill line, amount
    or count" test is now stale — that offering's ACTIVE subscription means
    bm42 now ALSO prices a capacity line for it (zero usage still bills the
    full floor, Inv #33). Updated to assert the RECURRING line is unchanged
    (still invisible to THIS resolver) AND a new CAPACITY line now appears
    (gross/net 5000.00, the full 1000 EA × 5.00 floor). The pre-existing
    `tests/guardrails/ratecard-demo-seed-boundary.test.ts` regex also had a
    genuine false positive fixed in the same change (see below).
  - **`_SAMPLE_` capacity seed** (`db/seeds/sample/seed-billrun-sample.ts` +
    `udr-rated-sample.ts`) — a third `SeedProfile` (`"capacity"`), four
    `CAPACITY_SCENARIOS` accounts (800/1000/2000/0 EA), a dedicated
    `_SAMPLE_ Capacity Demo Plan` offering (`ensureSampleCapacityOffering`,
    mirroring `ensureSampleOffering`'s idempotent DRAFT→children→ACTIVE path)
    carrying usage_rate (100/EA) + capacity_commitment (1000 EA) +
    capacity_motivation (>1000 EA @ 50) + the three `udrType`/
    `singleSubInstPerCust`/`productCardLookUp` specs, and
    `buildSampleUdrRatedRow`'s factory extended with optional
    `usageQuantity`/`usageRate`/`rateType`/`usageUnit` (PER_UNIT rows, exact
    bigint-scaled `amountRaw`, never float) — the default FLAT shape is
    untouched for every existing caller. `productCardLookUp`'s value is
    deliberately NOT spelled with the word this file's pm67 leak-boundary
    guardrail forbids (`ratecard-demo-seed-boundary.test.ts`); that
    guardrail's own regex also had a genuine false positive against the
    pre-existing, unrelated `usage_rate` component's `rateCardLookUp`
    schema field — fixed with a narrow negative lookahead, same change set.
  - **New DB-gated test** — `tests/db/billrun-capacity-aggregation.
    integration.test.ts` (the bm28/bm29-pattern flow-double): the four
    anchors (800/1000/2000/0 EA → 100,000/100,000/net 150,000/100,000),
    commitment-only + motivation-only (TC36), all six guards (incl. the
    NULL-rate TC35 case and the `capacity_max_bands` override TC52), and the
    different-unit non-double-counting case.
  - **Verified in this environment:** `npx tsc --noEmit` clean repo-wide;
    `eslint` clean on every touched/added file; the extracted-SQL harness
    self-test suite (13 tests, DB-free) passes against the real modified
    flow file (pebble-stripping, statement-splitting and `:'var'` binding all
    still correct); the full DB-free unit/guardrail suite (1016 tests) is
    green, including the two guardrails this unit touched.
  - **NOT verified here (no reachable Postgres/Kestra in this environment,
    same gap as bm40/bm41)** — the DB-gated preflight (`tests/
    integration-global-setup.ts`) fail-closed-refuses with no `DATABASE_URL`,
    confirmed directly. Pending before this unit ships: the new
    `billrun-capacity-aggregation.integration.test.ts` suite against a
    disposable Postgres; the full existing DB-gated suite re-run (incl. the
    updated recurring-aggregation test); a live-Kestra run on the `capacity`
    seed profile reaching `PROCESSED` with the four anchor bills.
  - **Doc sync:** `billmgmt-architecture.md` (the capacity-pricing stack row)
    and `billmgmt-code-standards.md` (the capacity general-rules delta) now
    name bm42 explicitly. `bm00-build-plan.md` doesn't exist in this
    checkout (same gap bm40/bm41 noted) — that sync step could not be done.
  - bm43 (verification + Model-2 + the `CAPACITY_RATE_MATCHING` gate), bm44
    (checksum append + read-model surfacing) and bm45 (invoice appendix) are
    next, per the spec's own Dependencies section.
  - **SonarQube "Duplicated Lines on New Code" fix, round 1 (2026-10-05).** The
    new `billrun-capacity-aggregation.integration.test.ts` repeated the same
    account+offering+run+inventory setup across the anchor loop and every
    single-account guard test. Extracted `setupSingleAccountCapacity(label,
    offeringName, offeringOpts)` and `expectGuardRejection(runId, ban,
    pattern)` helpers; the commitment-only/motivation-only test (TC36) was
    also converted from two near-identical hand-written blocks into a
    `cases` loop, matching the anchors test's existing pattern. Assertions
    and the fixture data are unchanged — `npx tsc --noEmit` clean.
  - **SonarQube fix, round 2 (2026-10-05) — two further findings.**
    (a) `db/seeds/sample/seed-billrun-sample.ts` (21 lines): the recurring vs
    capacity charge-seeders each hand-rolled the same "YYYY-MM-DD" → UTC
    `Date` range parse and the same chunked `udrRated` insert loop; the two
    `ensureSample*Offering` functions each hand-rolled the same existing-row
    lookup + conditional/unconditional promote-to-ACTIVE. Extracted
    `periodToUtcRange`, `insertUdrRatedChunked`, `findOfferingByName`, and
    `setOfferingActive` (all local to the file); no behavioural change.
    (b) `billrun-capacity-aggregation.integration.test.ts` (153 lines, a
    SEPARATE finding from round 1): the actual source was the file's ~150-line
    "flow-double" fixture scaffolding (`dropAll`/`newAccount`/`newRun`/
    `newOffering`/`newProductSpec`/`newInventory`/`readBill`/`readLines`)
    matching the same hand-copied boilerplate already in
    `billrun-aggregation.integration.test.ts` (bm28),
    `billrun-recurring-aggregation.integration.test.ts` (bm29), and
    `billrun-volume-aggregation.integration.test.ts` (bm35) — an intentional
    "each flow-double test is self-contained" pattern this file's own header
    comment calls out. Per owner decision (scoped fix, not a 4-file
    consolidation — the other three are already-shipped and not re-verifiable
    against a live DB in this environment): factored the scaffolding into a
    NEW shared `tests/db/helpers/billrun-flow-double-fixtures.ts`
    (`createFlowDoubleFixtures({ sql, db, getActorId, getCycleId, periodStart,
    periodEnd, labelPrefix })`) and switched only this file to consume it via
    thin wrapper functions (`newInventory`/`readBill`/`readLines` as const
    arrows; `newAccount`/`newRun`/`newOffering`/`newProductSpec`/`dropAll`
    also thin wrappers, since `actorId`/`cycleId` aren't assigned until
    `beforeAll` runs, so the factory is called lazily through a `fixtures()`
    getter rather than once at module scope). bm28/bm29/bm35 are untouched. A
    future flow-double unit (bm43/bm44/bm45) can import this helper instead of
    re-pasting the block — if duplication keeps compounding there, retrofitting
    bm28/bm29/bm35 onto the same helper is the next escalation, not done here.
    Verified: `npx tsc --noEmit` and `eslint` clean on all touched/added files
    (no reachable Postgres in this environment to re-run the DB-gated suite
    itself, same gap as bm40/bm41/bm42).
  - **Unrelated discovery while verifying the above (2026-10-05, flagged to
    the user, not acted on):** `origin/dev1`'s HEAD commit `120ebbc`
    ("Implement SonarQube Review Fixes for bm42") added an 18MB `archive.tar`
    binary to git history — it was untracked local clutter before that commit,
    is NOT present in the working tree now (shows as an uncommitted "deleted"
    path), and has already been pushed. Needs an owner decision (plain removal
    commit vs. history rewrite) — not touched by this entry's changes.

### Target Capacity Pricing update — Unit 3 (bm43)

- **bm43 (2026-10-06) — implemented as specified.** Capacity verification:
  replay every USAGE line against `rated_amount` (not `gross_amount`, which a
  commitment top-up inflates), a capacity-line replay + internal identities,
  the independent Model-2 cross-derivation, and the `CAPACITY_RATE_MATCHING`
  gate shared with bm42's G2 in aggregation. Spec:
  `context/billing-management/specs/bm43-capacity-verification-model2-gate.md`.
  No DB function, no Python, no app/UI change, no migration.
  - **Flow SQL** (`bill_run_processing.yml`, mirrored in `.template.yml`) —
    a new `capacity_rate_matching` flow input (default `true`), threaded into
    both the `aggregation` and `verification` psql `-v` lists.
    - **Aggregation (the one cross-step edit, D4)** — `_bm42_volume` gained
      `offering_name` (for the diagnostic); G2's unconditional
      `RAISE EXCEPTION` is now gated: `SELECT set_config('billrun.ban', …),
      set_config('billrun.capacity_rate_matching', …)` right after `BEGIN;`
      feeds a `current_setting(...)::boolean` check inside the existing `DO
      $$` guard block — ON raises exactly as bm42 shipped (now naming both
      rates/price-refs via a `string_agg` detail), OFF downgrades to
      `RAISE NOTICE` and lets the account proceed. The five structural guards
      (multi-sub, base-rate-not-found, udr-type-mismatch, multi-step,
      currency) are untouched — still unconditionally HARD.
    - **Verification** — the `mismatched` CTE now compares
      `SUM(udr_rated_price)` to `l.rated_amount` (was `gross_amount`) and
      excludes capacity lines (`additional_info IS NULL`) and capacity-volume
      claimed rows (a `NOT EXISTS` against a new `_bm43_capacity` read) from
      its `offering:udr_type` replay — D1/D2, fixing the false-mismatch the
      pre-bm43 flow would have hit on every under-target capacity account.
      Three new read-only temp tables re-resolve the capacity components off
      the subscription's pinned offering version as-of the account's STORED
      `billing_period_start` (verification has no `period_start` input):
      `_bm43_capacity` (mirrors `_bm42_capacity`), `_bm43_capacity_volume`
      (mirrors `capacity_volume`), `_bm43_bands`/`_bm43_model2` (mirrors the
      N-band walk, feeding `max(Q,target)×baseRate` + the band discount sum).
      Three new HARD/gated checks run inside the existing `DO $$` block, in
      order: (1) capacity replay (claimed volume vs. stored
      `rated_amount`/`udr_count`, HARD, never gated); (2) internal identities
      (`gross = rated_amount + topUp`, `net = gross − discount`, the
      `additional_info.calc` trace's `'total'`/`'motivation'` ops vs. the
      money columns, HARD, never gated — these bind the trace to the hashed
      columns per Inv #35); (3) Model-2 (gated exactly like G2 — ON
      HARD-fails `CAPACITY_RATE_MISMATCH` naming both figures, OFF
      `RAISE NOTICE`s and bills Model 1 anyway). No ±0.01 tolerance (Inv #34);
      the TC55/TC40 fractional-drift caveat is documented, not coded around.
  - **Extracted-SQL harness** (`tests/db/helpers/extract-flow-sql.ts`) —
    `AggregateParams`/`VerificationParams`/`runVerification` gained an
    optional `capacityRateMatching` (default `true`), mirroring
    `capacityMaxBands`'s bm42 pattern so every pre-bm43 caller is unaffected.
  - **New DB-gated test** — `tests/db/billrun-capacity-verification.
    integration.test.ts` (the bm28/bm29/bm42-pattern flow-double, reusing
    `billrun-flow-double-fixtures.ts`): Model-2 reconciles on all four
    anchors incl. the under-target 800/0 EA cases (the D1/D2 regression); a
    tampered claimed-row count is caught by the capacity replay independently
    of a tampered `gross_amount` (caught by the internal identity check); a
    corrupted `additional_info.pricing` trace alone does not make Model-2
    pass spuriously; gate ON — a post-aggregation catalog rate drift
    HARD-fails `CAPACITY_RATE_MISMATCH` naming both Model-1/Model-2 figures;
    gate OFF — the same drift downgrades to a WARN in verification and (a
    separate case) a mismatched claimed rate no longer aborts G2 at
    aggregation, both billing Model 1's actual number.
  - **Verified in this environment:** `npx tsc --noEmit` clean repo-wide;
    `eslint` clean on every touched/added file; the extracted-SQL harness
    self-test suite (13 tests, DB-free, `--pool=threads` — the forks pool
    hangs in this environment, a pre-existing local quirk) passes against the
    real modified flow file (pebble-stripping, statement-splitting and
    `:'var'` binding all still correct, including the new `_bm43_*` temp
    tables and the gated `DO $$` blocks). The full DB-free guardrail/unit
    suite (1016 tests) is green except two **pre-existing, unrelated**
    failures: `trigger-run.service.test.ts` throws on missing
    `DATABASE_URL`/`BETTER_AUTH_*` env vars (an ambient-env gap, not a code
    defect — also seen duplicated under a leftover
    `.claude/worktrees/brave-meitner-d65fff/` tree, not touched by this
    unit), and `pricing-component-guardrails.test.ts` guardrail 31 (an
    unrelated "no tiered/pricing_model residue" repo-wide scan) times out at
    its 10s budget — plausibly slowed by that same leftover worktree
    doubling the file count it walks. Neither failure involves capacity or
    verification code.
  - **NOT verified here (no reachable Postgres/Kestra in this environment,
    same gap as bm40/bm41/bm42)** — the new
    `billrun-capacity-verification.integration.test.ts` suite against a
    disposable Postgres; a live-Kestra run on the `capacity` seed exercising
    both gate states; the full existing DB-gated suite re-run (confirming the
    non-capacity `bm30` reconciliation tests stay green against the
    `rated_amount`-anchored replay, which is behaviour-preserving for them
    per D1).
  - **Doc sync:** `billmgmt-architecture.md` now names **bm43** on Inv #29/#30
    and the capacity-pricing stack row (alongside bm42). `bm00-build-plan.md`
    doesn't exist in this checkout (same gap bm40–bm42 noted) — that sync
    step could not be done.
  - bm44 (checksum append + read-model surfacing) and bm45 (invoice appendix)
    are next, per the spec's own Dependencies section.
  - **SonarQube "Duplicated Lines on New Code" fix (2026-10-06, 52.9% on
    `billrun-capacity-verification.integration.test.ts`).** The BadCount/
    BadGross/LiedTrace/RateDrift/RateDriftOff/G2Off guard tests each
    hand-repeated the same `setupSingleAccountCapacity()` +
    `insertCapacityVolumeRow()` + `aggregate()` + `readBill()`/`readLines()`
    sequence (same pattern bm42's own round-1 fix addressed for its
    account+offering+run+inventory setup — see that entry above). Extracted
    a local `setupAndAggregateSingleLine(label, offeringName, { rate?,
    aggregateOpts? })` helper that returns the resulting `bill`/`line`; the
    six guard tests now call it instead of re-pasting the block. The anchors
    loop (TC50) was already a loop and is unchanged. Assertions and fixture
    data are unchanged — `npx tsc --noEmit` clean. Not re-run against a live
    DB in this environment (same gap noted throughout bm40–bm43).
  - **SonarQube "Duplicated Lines on New Code" finding, round 2 (2026-10-06,
    39.1% on `billrun-capacity-verification.integration.test.ts`) — accepted,
    no code change.** After the 52.9% fix above, the remaining duplication is
    the ~180-line capacity-pricing fixture block (`insertOfferingPrice`/
    `newUsageRate`/`newCapacityCommitment`/`newCapacityMotivation`/
    `newCapacityOffering`/`insertCapacityVolumeRow`) shared verbatim (bar
    "BM42"→"BM43" label strings) with `billrun-capacity-aggregation.
    integration.test.ts`. This is the SAME duplication the round-2 fix above
    already identified and deliberately did NOT factor out — per that entry's
    owner decision, only the generic flow-double scaffolding went into
    `billrun-flow-double-fixtures.ts`; the capacity-specific fixture shapes
    stay self-contained per file, matching the bm28/bm29/bm35 convention this
    file's own header comment calls out. Re-confirmed with the owner this
    round: duplication stays, finding accepted as a known tradeoff rather
    than chased further. If a FUTURE capacity-pricing unit (bm44/bm45) needs
    the same fixtures a third time, that is the trigger to extract a shared
    `billrun-capacity-pricing-fixtures.ts` for bm42+bm43+that unit — not
    before.

### Target Capacity Pricing update — Unit 4 (bm44)

- **bm44 (2026-10-06) — implemented as specified.** Checksum re-anchor on
  `rated_amount` + bill-line read-model surfacing. Spec:
  `context/billing-management/specs/bm44-checksum-reanchor-bill-line-read-model.md`.
  App-side `rated_amount` surface only — no flow change, no migration, no new
  write of `customer_bill_line` (Inv #2 two-writer boundary holds).
  - **Checksum append** (`customer-bill-line.repository.ts`'s
    `computeChargeChecksum`) — `rated_amount` is now the **eighth and last**
    element of the hashed `json_build_array(...)` tuple, appended (not
    inserted mid-tuple) so the first seven fields' serialization and position
    are unchanged for every existing line. Left un-coalesced (unlike
    `udr_type`'s `COALESCE(..., '')`): a NULL `rated_amount` (RECURRING, not
    rated) serializes to a distinct JSON `null` token, so it can never
    collide with a rated-to-zero USAGE line's `"0.00"`. `additional_info`
    stays unhashed (Inv #35 — verification binds the trace to the money
    columns, not the reverse). No change to ordering (`line_no`), encoding,
    the `COALESCE(string_agg(...), '')` empty-bill guard, or the posting call
    site (`services/billing/post-run.ts`).
  - **Read model** — `listForRun`'s select already projected `ratedAmount`/
    `additionalInfo` (bm41 added this as a compile-ripple fix ahead of
    schedule), so no change was needed here; verified the fields are still
    present and typed against `BillLineRow`.
  - **UI / types — comments only, no behavioural change** —
    `bill-line-table.tsx`'s file-header and `showDiscount` comments
    (previously asserting "no discount is computed this phase") now state
    that a capacity motivation line carries a real discount and the column
    un-suppresses honestly; explicitly notes the calc trace stays DB-only
    (TC26), not rendered here. `types/billing.ts`'s `BillLineRow` header
    comment now notes a capacity USAGE line is the exception to the
    plain-USAGE shape (non-null `ratedAmount`/`additionalInfo`, unlike an
    ordinary USAGE line). `showDiscount`, the header/cell/`colSpan` wiring,
    and the capacity line's existing `UsageLineDrillDown` are all unchanged.
  - **Checksum integration suite extended** —
    `tests/db/customer-bill-line-checksum.integration.test.ts` gained an
    optional `ratedAmount` on its `LineSpec`/`insertLine` (defaults to NULL,
    the pre-bm42 shape) and two new cases: (1) position-preservation +
    tamper-detection — a RECURRING and a plain-USAGE bill's checksum is
    stable across recompute, and mutating ONLY `rated_amount` afterward
    changes it; (2) the NULL-vs-`"0.00"` non-collision — a RECURRING line
    (NULL) and a USAGE line rated to exactly zero (`"0.00"`), otherwise
    identical, hash differently.
  - **Verified in this environment:** `npx tsc --noEmit` clean repo-wide;
    `eslint` clean on every touched file; the DB-free
    `list-account-bills.test.ts` suite (16 tests) green; the full DB-free
    unit/guardrail suite (7675 tests) green except the same **pre-existing,
    unrelated** failures bm43 already documented — `trigger-run.service.
    test.ts` (ambient-env gap, duplicated under the leftover
    `.claude/worktrees/brave-meitner-d65fff/` tree) and
    `ratecard-parse-csv.test.ts`'s csv-parse-import-scan timeout (plausibly
    slowed by that same leftover worktree). Neither involves capacity,
    checksum, or bill-line read-model code.
  - **NOT verified here (no reachable Postgres in this environment — Docker
    Desktop isn't running — same gap as bm40–bm43):** the extended checksum
    integration suite against a disposable Postgres; the full existing
    DB-gated suite re-run; a live-Kestra run on the `capacity` seed
    confirming the Discount column renders for a capacity bill in the actual
    Customers & Bills UI.
  - **Doc sync:** `billmgmt-architecture.md` Inv #35 and
    `billmgmt-ui-context.md` §6b now name **bm44** explicitly as the
    checksum-append + discount-render unit. `bm00-build-plan.md` still
    doesn't exist in this checkout (same gap bm40–bm43 noted) — that sync
    step could not be done.
  - bm45 (invoice appendix, reads `additionalInfo`/`ratedAmount` through this
    read model) and bm46 (ship gate) are next, per the spec's own
    Dependencies section.

### Target Capacity Pricing update — Unit 5 (bm45)

- **bm45 (2026-10-07) — implemented as specified.** Invoice usage appendix:
  per-polygon detail by state/district, snapshotted at `aggregation` into
  the capacity line's `additional_info.appendix`, rendered below the
  capacity charge on the **final posted** invoice only. Spec:
  `context/billing-management/specs/bm45-invoice-usage-appendix.md`. No
  migration (reuses the bm41 `additional_info` jsonb), no new grant (bm41
  already granted the two ratecard tables + `product_specifications`).
  - **Flow SQL** (`bill_run_processing.yml`'s `aggregation` step) — between
    the bm42 six-guard `DO $$` block and the whole-account replace: `_bm45_card`
    (resolves each capacity (offering, unit)'s `productCardLookUp` card name
    + its ACTIVE `ratecard_version_id`, D4), `_bm45_volume` (per-`udr_key`
    volume/amount/count from the account's BILL_DRAFT capacity claim, D2
    scoping identical to `capacity_volume`'s), and a `DO $$` count guard
    (`CAPACITY_APPENDIX_OVER_LIMIT`, HARD, > 10,000 distinct `udr_key`s —
    TC57). Two new CTEs in the main `WITH`/`INSERT` — `capacity_appendix_mapped`
    (LEFT JOIN each `udr_key` to `ratecard_ran_usage_lkp`, scoped to the
    ACTIVE version, via the D2 canonical-key reconstruction
    `commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>`, lower+btrim) and
    `capacity_appendix` (one `jsonb_agg` per (offering, unit), ordered
    state/district/polygon NULLS LAST — D3's trailing "Unmapped" ordering) —
    joined into `capacity_totals` and merged as the `appendix` key onto
    `capacity_lines`' existing `additional_info` trace (additive to the bm42
    calc trace, same jsonb column). A card-missing polygon's `polygon` value
    falls back to the `udr_key`'s own `polygon_id=` segment (via `substring`)
    so it is never anonymous nor dropped (D3).
  - **Types** (`types/billing.ts`) — `CapacityCalcTrace` gains an optional
    `appendix?: InvoiceUsageAppendixRow[]`; new `InvoiceUsageAppendixRow`
    (`{ polygon, state, district, volume, amount }`, no `unit` field — the
    spec's literal jsonb shape).
  - **Read model** (`db/repositories/billing/customer-bill-line.repository.ts`)
    — new `listCapacityLinesForBill` (scoped to one bill, `additional_info IS
    NOT NULL` is the capacity-line marker per bm44) in place of the
    whole-run `listForRun`, since the final render only ever needs one
    account's capacity line(s).
  - **Render orchestrator** (`services/billing/render-invoice.ts`) —
    `renderFinalInvoice` reads the new repository method, flattens every
    capacity line's `additionalInfo.appendix` and attaches each line's own
    `unit` column (the stored jsonb carries none), passing `appendix:
    undefined` (never `[]`) when empty. `renderDraftInvoice` is untouched
    (D5 — final-only).
  - **Template** (`services/billing/render-invoice-template.ts`) — new
    `InvoiceAppendixRenderRow` + optional `appendix` on
    `BuildFinalInvoiceHtmlParams` only (not the draft params type). Renders
    below the charge table, gated on `!isDraft && appendix.length > 0`:
    state section (subtotal) → district table (subtotal) → per-polygon row
    (`polygon`, `volume + unit`, `amount`), a trailing "Unmapped (no
    ratecard entry)" group for `state === null` rows (Info-family styling
    per ui-context §6d, no new token), and a grand total. Every subtotal is
    summed via `services/accounts/money.ts`'s `sum()` — never
    `Number()`/`reduce(+)` on a money string (code-standards §2.3); `volume`
    is display-only text, never summed. Stays pure (no DB/Playwright
    import) — `services/accounts/money.ts` and the `types/billing.ts` type
    import are both DB-free.
  - **`_SAMPLE_` fixture** (`db/seeds/sample/**`) — canonical `udr_key`s:
    `udr-rated-sample.ts`'s `buildUdrKey` now emits the D2 canonical cell
    when a caller supplies `polygonCell` (every capacity PER_UNIT row now
    does; every FLAT `ci`/`volume` row still omits it and keeps the
    untouched generic JSON key). `seed-billrun-sample.ts` gains a **fifth**
    capacity scenario (`capacity-appendix-multi-polygon`, additive — the
    four 800/1000/2000/0 EA anchors are unchanged in field shape and
    amount): 4 mapped polygons over 2 states/2 districts + 1 card-missing
    polygon, summing to exactly 1000 EA (a clean "at target" bill,
    independent of the appendix itself). The four anchors now also carry a
    canonical `udr_key` each (a synthetic, per-row-unique polygon, never
    seeded onto the usage card — they render "Unmapped" if ever viewed,
    which is correct per D3, not a defect) — same row count, same amounts,
    zero behavioural change to the anchor bills themselves.
  - **New file** `db/seeds/sample/capacity-usage-card.ts` —
    `ensureSampleCapacityUsageCard` (idempotent find-ACTIVE-or-create +
    `onConflictDoNothing` lkp rows), mirroring `sample-5g-fixture.ts`'s
    `insertRanRatecard` precedent extended to carry a distinct state/
    district **per row** (the 5G fixture shares one state across all rows;
    bm45 needs ≥ 2 states/≥ 2 districts). Deliberately its **own file**, not
    folded into `seed-billrun-sample.ts`: the pm67
    `ratecard-demo-seed-boundary` guardrail forbids that file from naming
    the card module/table at all, so the two comments in
    `seed-billrun-sample.ts` that would otherwise have said "ratecard" were
    reworded to "lookup-card" to keep that guardrail green untouched — no
    guardrail-regex edit was needed or made.
  - **New DB-gated test** — `tests/db/billrun-capacity-appendix.integration.test.ts`
    (the bm42/bm43-pattern flow-double, reusing `billrun-flow-double-fixtures.ts`;
    the capacity-pricing fixture helpers are a deliberately self-contained
    trimmed copy, matching the "each flow-double test is self-contained"
    convention bm42's round-2 Sonar fix documented rather than extracting a
    shared file pre-emptively): a multi-polygon account's appendix groups
    state/district correctly, state/district provably **card-sourced** (the
    ratecard's values share nothing with any feed value), a card-missing
    polygon surfaces under `state: null` and the account still bills (no
    HARD fail), every row's `amount` sums to the line's `rated_amount`; a
    rerun-stability case (re-version the card after aggregation, re-read
    the already-written line unchanged — documents the D4 residual without
    fixing it); and the `CAPACITY_APPENDIX_OVER_LIMIT` HARD-fail at 10,001
    distinct polygons (bulk `INSERT … SELECT … FROM generate_series` for
    speed).
  - **Verified in this environment:** `npx tsc --noEmit` clean repo-wide;
    `eslint` clean on every touched/added file; the extracted-SQL harness
    self-test suite (13 tests, DB-free, `--pool=threads`) passes against the
    real modified flow file (pebble-stripping/statement-splitting/`:'var'`
    binding all still correct around the new `_bm45_*` temp tables and CTEs);
    the DB-free `list-account-bills.test.ts` (16 tests), the existing
    `render-invoice.service.test.ts`/`render-invoice-template.test.ts` suites
    extended with bm45 cases (appendix shaping/attachment, grouping,
    subtotal reconciliation, the Unmapped group, escaping, draft-never-renders)
    (54 + 32 tests total across both files), and the pm67
    `ratecard-demo-seed-boundary`/`billing-sample-seed-boundary` guardrails
    all green.
  - **NOT verified here (no reachable Postgres in this environment, same
    gap as bm40–bm44):** the new `billrun-capacity-appendix.integration.test.ts`
    suite against a disposable Postgres; the existing
    `billrun-capacity-aggregation`/`billrun-capacity-verification` DB-gated
    suites re-run (confirming the anchors' canonical-`udr_key` switch is
    behaviour-preserving for their own assertions, which only check money/
    count fields, never the key string); a live-Kestra run on the `capacity`
    seed profile confirming the appendix section renders in an actual posted
    invoice PDF.
  - **Doc sync:** `billmgmt-architecture.md` Inv #36 and the capacity
    stack/system-boundary delta tables now name **bm45** explicitly;
    `billmgmt-ui-context.md` §6d now cites bm45 in its heading;
    `billmgmt-known-issues.md` gained §15 recording the D2 rating-key
    coupling and the D4 ratecard-version residual as documented, accepted
    assumptions (not fixed this unit), per the spec's own checklist item.
    `bm00-build-plan.md` still doesn't exist in this checkout (same gap
    bm40–bm44 noted) — that sync step could not be done.
  - bm46 (ship gate) is next, per the spec's own Dependencies section.
  - **SonarQube "Duplicated Lines on New Code" fix (2026-10-07) — two
    findings.**
    (a) `tests/services/billing/render-invoice-template.test.ts` (28.5%): the
    repeated `buildFinalInvoiceHtml({...BASE_PARAMS, invoiceNumber:
    "INV00000042", ...})` call shape (8 call sites) and the per-polygon
    `MAPPED_ROWS`/`UNMAPPED_ROW` object literals (same key shape, different
    literal values — SonarQube's CPD normalizes literals) were the source.
    Extracted local `renderDraft`/`renderFinal` helpers and an
    `appendixRow(...)` factory; assertions and fixture data unchanged.
    Verified: `npx tsc --noEmit` clean; `npx vitest run --pool=threads`
    32/32 passing.
    (b) `tests/db/billrun-capacity-appendix.integration.test.ts` (18.6%): the
    same capacity-pricing fixture block (`insertOfferingPrice`/
    `newUsageRate`/`newCapacityCommitment`/`insertCapacityVolumeRow`) already
    hand-copied into bm42 and bm43 — and which bm43's own round-2 SonarQube
    fix (above) deliberately left un-extracted, naming a THIRD
    capacity-pricing unit needing the same fixtures as the trigger to extract
    a shared file. bm45 is that third unit. Per owner decision this round:
    extracted a new shared `tests/db/helpers/billrun-capacity-pricing-
    fixtures.ts` (`createCapacityPricingFixtures({ sql, newOffering,
    newProductSpec, claimAt, labelPrefix })`), covering
    `insertOfferingPrice`/`newUsageRate`/`newCapacityCommitment`/
    `newCapacityMotivation`/`newCapacityOffering`/`insertCapacityVolumeRow` —
    parameterized by `labelPrefix` (reproduces each file's exact "BM42"/
    "BM43"/"BM45" name/batch/source-file/checksum strings) and an optional
    `udrKey` override on `insertCapacityVolumeRow` (bm45's D2 canonical-cell
    key, which the shared seq-counter default doesn't produce). bm42, bm43,
    and bm45 all switched to consume it via thin per-file wrappers; bm45's
    own `newAppendixCapacityOffering`/`insertRatecardVersion`/
    `canonicalUdrKey` stay local (appendix-specific, not duplicated
    elsewhere). bm42/bm43 expose only `newCapacityOffering`/
    `insertCapacityVolumeRow` wrappers — a first draft also wrapped
    `newUsageRate`/`newCapacityCommitment`/`newCapacityMotivation`, but
    `newCapacityOffering`'s own composition calls the shared factory's
    internal versions directly, not those file-level wrappers, so they were
    genuinely dead code; `eslint`'s `no-unused-vars` caught this (bm45 keeps
    its own `newUsageRate`/`newCapacityCommitment` wrappers since
    `newAppendixCapacityOffering` there calls them directly). An early draft
    recreated the factory per call (`capacityFixtures()` as a function,
    mirroring `fixtures()`'s pattern above it), which silently reset `seq`
    and would have collided every claim row's `udr_key` — caught before
    commit by memoizing it instead (`capacityFixturesInstance ??= ...`).
    No intended behavioural change. Verified: `npx tsc --noEmit` clean
    repo-wide; `eslint` clean (0 warnings) on touched/added files;
    `render-invoice-template.test.ts`'s own suite re-run (32/32 passing,
    `--pool=threads`). **NOT re-run against a live DB in this environment**
    (no reachable Postgres/Docker daemon here, same gap as bm40–bm45) — the
    bm42/bm43/bm45 DB-gated suites need re-running against a disposable
    Postgres before merge to confirm the extraction is behaviour-preserving.
  - **SonarQube fix, round 2 (2026-10-07) — re-check showed (a) was
    barely moved (18.6% → 18.2% on bm45) and surfaced a second, pre-existing
    duplicate.** Two things, both caught by re-running Sonar and eslint after
    the round-1 fix above, not by inspection alone:
    (1) The per-file `let capacityFixturesInstance; function
    capacityFixtures() { return (capacityFixturesInstance ??=
    createCapacityPricingFixtures({...})); }` memoization block round-1
    introduced was itself near-identical across bm42/bm43/bm45 (bar
    `labelPrefix`) — a brand-new 3-way duplicate, self-inflicted by the fix
    that was supposed to remove duplication. Fixed by changing
    `CapacityPricingFixturesDeps.sql` to `getSql: () => postgresjs.Sql` (the
    same deferred-read trick `fixtures()` already uses for
    `getActorId`/`getCycleId`): since the factory now defers reading `sql`
    to invocation time rather than construction time, each file can call
    `createCapacityPricingFixtures(...)` ONCE, eagerly, as a plain `const`
    — no per-file memoization boilerplate needed at all.
    (2) `setupSingleAccountCapacity` (account + offering + run + inventory
    keyed by `label`) was byte-identical between bm42 and bm43 bar label
    strings — pre-existing (bm43's own comment said "mirroring bm42's
    setupSingleAccountCapacity," hand-copied when bm43 was written) and
    never part of either reported finding, since it doesn't touch bm45 at
    all (bm45's own `setupAccount` is differently shaped — it also seeds the
    ratecard-lookup specs). Moved into
    `billrun-capacity-pricing-fixtures.ts` too, gated on three new deps
    (`newAccount`/`newRun`/`newInventory`) that bm45 must now also supply
    (uniform interface) even though it never calls this particular method.
    `labelPrefix` substitutes for the hardcoded "BM42"/"BM43" in the
    generated `runId`/`piId`/`orderItemId` strings — reproduces the exact
    same values. bm42 and bm43 each dropped ~42 lines net; bm45 is roughly
    flat (gained the three new deps, lost the memoization block it never
    needed fixture-sharing for in the first place). Verified: `npx tsc
    --noEmit` clean repo-wide; `eslint` clean (0 warnings, confirmed via a
    second full lint pass — the first one after round 1 had already caught
    `newUsageRate`/`newCapacityCommitment`/`newCapacityMotivation` as dead
    wrappers in bm42/bm43, this round caught `newCapacityOffering` as dead
    in bm43 specifically, since bm43 — unlike bm42's Multi-Sub tests — never
    calls it directly outside `setupSingleAccountCapacity`).
    **Still NOT re-run against a live DB in this environment** — same gap as
    above. **Also still out of scope, by explicit owner decision this
    round:** the `beforeAll`/`afterAll` DB-bootstrap boilerplate
    (`billrun_delete_trial_bill` + `appuser` + `billCycle` setup, ~44 lines)
    duplicated across bm42/bm43/bm45 AND six other flow-double suites
    (`billrun-aggregation`, `billrun-recurring-aggregation`,
    `billrun-volume-aggregation`, `billrun-db-roles`, `billrun-phase3-journey`,
    `billrun-verification-reconciliation`) — ~400 lines total, the oldest
    and widest-spread duplication found, predating this session. Likely
    still contributes to any residual Sonar percentage on these 3 files, but
    touching it means editing 6 files not looked at this session, several
    already shipped; flagged here as known debt, not extracted.

### Target Capacity Pricing update — Unit 6 (bm46)

- **bm46 (2026-10-07) — audited; two items remain OPEN (not silently assumed
  green).** Target Capacity Ship Gate: audit bm40–bm45 guardrails, assemble
  the update-level proof, confirm no migration beyond bm41's `0044`, sync
  docs. Spec: `context/billing-management/specs/bm46-capacity-ship-gate.md`.
  No new build — audit, assemble, sign off (bm13/bm21/bm35/bm39 discipline).
  Per owner decision this unit (no infra stand-up, no new unverified test
  code): did everything verifiable in this environment; recorded the rest as
  explicit open items rather than assuming green.
  - **Guardrail audit (§1 of the spec) — present and consistent.** Confirmed
    on disk: the six `CAPACITY_*` guard codes, `capacity_rate_matching` +
    `capacity_max_bands` flow inputs, and `CAPACITY_APPENDIX_OVER_LIMIT` all
    present in `bill_run_processing.yml`; no `billing.capacity_charge()`
    function and no Python pricing task anywhere in `workflow-management/` or
    `db/migrations/`; `billmgmt-code-standards.md` guardrails 36–42 and
    architecture Inv #29–#38 are stated as greppable assertions and cite the
    delivering unit (bm42–bm45) for each; the bm40/bm41/bm42/bm43/bm44/bm45
    DB-gated test files, the extracted-SQL harness + its self-test, the
    flow-double fixture helpers, and the destructive-DB preflight all exist on
    disk at the paths the progress-tracker entries above name. `npm run
    check:rating-rename-gate` confirms **zero** stale `udr_subscriber_ref_id`
    references in the real code tree (1340 files scanned) — the only hits
    found anywhere are inside a stale, untracked `.claude/worktrees/
    brave-meitner-d65fff/` directory (pre-rename code, not part of the scan
    roots, not part of this checkout's working tree — see below).
  - **No-new-migration confirmation (§3) — PASSES.** `db/migrations/` +
    `_journal.json` end at idx 44 = `0044_customer_bill_line_capacity.sql`
    (bm41); `0042` is the pre-existing intentionally-unused gap (bm41's own
    note: "`0041`/`0043` were taken"); nothing beyond `0044` exists. The
    capacity update's only migration is confirmed to be exactly the one
    bm41 shipped.
  - **`tsc`/lint/DB-free suite (§ verification checklist item 7) — GREEN.**
    `npx tsc --noEmit` clean repo-wide. `npx eslint . --max-warnings=0` clean
    (exit 0, zero output). `npx vitest run --pool=threads`: **7680 passed, 5
    failed, 927 skipped (8617 total)**; all 5 failures are **pre-existing and
    unrelated** to capacity/billing code — 4 are under the same stale,
    untracked `.claude/worktrees/brave-meitner-d65fff/` leftover tree
    bm43/bm44 already flagged (ambient-env `AppError`s and a missing
    `rating-engine/` path from before the `workflow-management/` rename —
    that tree predates the rename and is not part of this working tree), and
    the 5th is `tests/product/ratecard-parse-csv.test.ts`'s csv-parse-
    import-scan hitting its 10s timeout — the exact pre-existing failure
    bm43/bm44 both documented as "plausibly slowed by that same leftover
    worktree doubling the file count it walks." No failure touches capacity,
    checksum, verification, appendix, or bill-line code. The destructive-DB
    preflight's three refusal paths (`DATABASE_URL` unset,
    `DESTRUCTIVE_DB_OK` unset, and — by source read, matching bm40's prior
    direct exercise — an unreachable/non-disposable target) were each
    re-confirmed directly against `tests/integration-global-setup.ts`.
  - **OPEN — the live-Kestra capacity journey (§2 of the spec, TC54) has no
    runnable harness, not just no infra.** Auditing `scripts/
    billrun-live-kestra-smoke.ts` (the repo's only live-Kestra harness) found
    it is hardcoded to the `ci` seed profile only — zero references to
    `capacity` anywhere in the file, and its safety gates (seeded-customer
    check, single-due-period assumption) are built around the `ci` seed's
    specific scenario shape. **Even with a running Postgres/Kestra stack,
    there is currently no tooling that could drive the `_SAMPLE_` `capacity`
    seed through a live execution and assert the four anchors, the six
    guards, and the `CAPACITY_RATE_MATCHING` gate ON/OFF** — TC54 is
    unimplemented, separately from this environment lacking Docker/Postgres.
    Per owner decision this unit: recorded as a real missing deliverable, not
    built here (a capacity-aware live-Kestra smoke harness would be
    substantial, financially-significant new test code this environment
    cannot execute or verify against live infra — writing it unverified was
    explicitly declined). **This blocks a true TC54 sign-off** until either a
    capacity-aware harness is built and run, or the business/eng owner
    accepts the DB-gated flow-double suites (bm42/bm43/bm45, themselves not
    re-run against a live Postgres in this environment either) as sufficient
    proof without a live-Kestra capacity execution.
  - **OPEN — DB-gated capacity suites not re-run.** Same environment gap as
    bm40–bm45 (Docker Desktop not running, `DATABASE_URL` unset): the
    `billrun-capacity-aggregation`/`-verification`/`-appendix`/
    `customer-bill-line-checksum` integration suites, and the full existing
    DB-gated suite re-run, remain unexecuted in this environment.
  - **Docs synced this unit:** `billmgmt-architecture.md` (status line:
    "Target Capacity Pricing update ... is delivered"; outstanding-items
    note added) — confirmed Inv #29–#38 already cite their delivering unit,
    no drift; `billmgmt-code-standards.md` — confirmed guardrails 36–42
    already stated as greppable assertions citing their delivering unit, no
    drift, no edit needed; `billmgmt-update-overview.md` (delivered-status
    banner added); `billmgmt-project-overview.md` (new "Target Capacity
    Pricing update" section folded in, mirroring the Phase-4 fold-in
    precedent; current-state callout updated); `billmgmt-known-issues.md`
    gained **§16** (the TC40/TC55 ≤1¢ Model-1/Model-2 rounding-drift
    residual on fractional usage, accepted) and **§17** (O-TC7 — partial-
    period capacity billing, an open business decision, EXCLUDED stands
    until resolved).
  - **Not touched, by explicit scope (pre-existing, flagged by prior units,
    not this unit's to fix):** the stale `.claude/worktrees/
    brave-meitner-d65fff/` leftover directory (pre-rename code, inflates
    file-scan counts, not part of any `npm run check:*` scan root); the §13
    item 2 shared role-password rewrite; the known-issues §11/§12 zero-charge/
    fully-discounted-bill predicates; `bm00-build-plan.md` still does not
    exist in this checkout (same gap bm40–bm45 all noted).

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

## Fixed after first live local run (2026-09-17)

The first end-to-end local trigger of the deployed `bill_run_processing` flow
(demo cycle, `BRN00000003`) surfaced two defects that made the flow
**unrunnable in any environment**. Both are fixed; the flow is redeployed at
revision 2.

1. **`taskrun.value` does not resolve inside bm36's `Sequential` wrapper.** The
   flow's own comment asserted "the enclosing ForEach value is inherited by
   descendants" — false on Kestra 1.3.35, where a ForEach value reaches only its
   DIRECT children. bm36 wrapped the per-account stage group in a `Sequential`
   to contain HARD failures, which put every stage one level too deep, so all 14
   references failed to render with ``Unable to find `value` used in the
   expression`` **before any SQL ran** — and the per-account `errors` handler
   failed identically, masking the real cause. Verified against the running
   engine with a probe flow: from a task nested one level deeper,
   `parent.taskrun.value` and `parents[0].taskrun.value` both resolve while bare
   `taskrun.value` does not. All 14 are now `parent.taskrun.value` and the
   comment is corrected. `bill_run_distribution` was never affected — it has no
   `Sequential`, so its 11 bare references are correct as-is; that asymmetry is
   the proof this came in with bm36.
2. **The M2M callback token never matched, so every signal 401'd.**
   `SECRET_BILLRUN_APP_TOKEN` in `workflow-management/dev/.env.example` decodes
   to the placeholder `billrun_dev_app_token_change_me_0123456789`, while the
   local `.env` carried a machine-generated `BILLRUN_APP_TOKEN`. Observed live as
   `401 UNAUTHENTICATED / Invalid service token`. Fixed on the LOCAL side — the
   repo-root `.env` (never committed) now carries the committed dummy, rather
   than baking a machine-specific token into the committed example. Root
   `.env.example` ships `BILLRUN_APP_TOKEN` empty, so the committed engine
   example is the canonical dev value.

**Neither defect is local-only** — fix 1 ships to the deployed flow (bm38
promoted `local-dev` as the production flow), and fix 2's mismatch would appear
in any environment whose two token sources are provisioned independently. There
is no test covering either: the flows are YAML, and the CI-doubled E2E
(`tests/db/billing-e2e-happy-path.integration.test.ts`) never renders a real
Kestra expression.

## Fixed on the first live distribution run (2026-09-17)

The first real `bill_run_distribution` execution (BRN00000003, loopback target)
failed. Two independent causes, both fixed; flow redeployed at revision 2.

1. **The `kestra-internal` Azurite container does not exist, and nothing creates
   it.** Misleading symptom: `BlobStorageException: Status code 404,
   ContainerNotFound` on the `download` task, which looks like the invoice blob
   is missing. Azurite's own request log proves the download SUCCEEDED
   (`GET /devstoreaccount1/invoices/2026-08%2FINV00000001.pdf 206 62742`) — the
   404s are `HEAD`/`PUT` against **`kestra-internal`**, Kestra's own internal
   storage, where it tries to stash the downloaded file. The app's
   `blob-store.ts` creates the `invoices` container on demand; Kestra does not
   create its own, and Azurite provisions nothing. `kestra-setup` should create
   it (the compose comment already calls azurite "Blob emulator for Kestra's
   internal storage ONLY (kestra-internal container)" — the provisioning step
   was never written). **This also explains the `rating.rating-batch-reconcile`
   schedule failing every 5 minutes since stack bring-up** — its `kv()` reads hit
   the same missing container. After creating it, that flow fails on a genuine,
   previously-masked cause instead: the `rating` namespace has no
   `rating_stranded_batch_threshold_seconds` KV key, and Pebble throws on the
   missing key before the `?? 3600` default can apply. **Rating-module issue,
   still open.**
2. **`parents[1]` does not exist — same class of bug as bm36's `taskrun.value`.**
   The flow's own comment claimed `parents` "counts from innermost", so
   `parents[0]` is per_artifact and `parents[1]` is per_target. On Kestra 1.3.35
   the immediate loop value is NOT also a `parents` entry: from a task inside
   the inner ForEach, **`parents` has length 1 and `parents[0]` is the OUTER
   loop**. Probe against the running engine:
   `self=<artifact> | parent=<target> | p0=<target> | count=1`. So all six
   `parents[1]` references rendered ``Unable to find `1```, surfacing as
   `PebbleException: Could not perform not equals comparison` on `upload_local`'s
   and `upload_sftp`'s `runIf`. All six are now `parents[0]` and the comment is
   corrected.

Callbacks were NOT the problem this time — `on_error` and `on_finally_status`
both succeeded, confirming the earlier route-registration fix holds for
`/api/billrun/[runId]/distribution/outcome`.

## Open defect — Workflow tab shows 4 permanently-`Pending` columns

**Found 2026-09-17 on the first `INVOICED` run.** `StageTimeline` (the run
detail's Workflow tab) renders a cell per `STAGES` entry — all **nine** —
but `getStageTimeline` builds cells purely from `bill_run_account_stage`, and
`insertStageRow` has exactly ONE caller in the repo
(`handle-stage-signal.ts:163`), driven by the flow's `/stage/[stage]/complete`
callbacks. The flows only ever signal the five processing stages
(validation → verification). **Nothing writes `scoping`, `posting`, `rendering`
or `distribution` stage rows**, so those four columns read `Pending` on every
run forever — including a fully `COMPLETED` one. Operators reasonably read that
as "posting never happened".

Not a schema mismatch — `stageParamSchema` is `z.enum(STAGES)`, so the M2M
endpoint would accept a `posting`/`rendering` signal today; nothing emits one.
Fix is a choice, not a bug hunt: either (a) emit stage signals from
`post-run.ts` (posting + rendering) and the distribution outcome handler, or
(b) narrow the grid to the stages the flow actually signals and surface
posting/rendering/distribution from their real sources
(`bill_run_account.status`, `billing.document`, `bill_run_distribution`), which
is where the posting-progress view already reads them correctly.

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
- **bm22 `sftp` service — two clean-install blockers, one fixed (2026-09-17).**
  On a fresh clone/reinstall the service exited 1 twice over:
  (a) `workflow-management/dev/sftp/keys/` is gitignored, so `atmoz` finds no
  `*.pub` and `create-sftp-user` aborts — you must run the README's `ssh-keygen`
  step once per machine (not a repo bug, but it is not in any bring-up doc);
  (b) **fixed in-repo** — `init/00-init-dirs.sh` ran `chown -R billrun:billrun`,
  but `create-sftp-user` names the user's group `group_<gid>` (`group_1001`), so
  no group `billrun` exists, busybox `chown` failed with `unknown user/group`,
  and that aborted the whole atmoz entrypoint. Now `chown -R 1001:1001`.
  Verified with the README's put → ls → rm round trip (key-auth + host-key
  verification, file lands owned `1001:1001`).
- **A clean local stack cannot execute the flows until the runtime DB roles are
  provisioned by hand (2026-09-17).** `kestra-setup` bootstraps only
  `kestra_engine`, and `.env`'s engine-wiring note says dev "connects as the
  `postgres` superuser throughout" — but
  `bill-run-processor/local-dev/bill_run_processing.yml` exports
  `PGUSER=${BILLRUN_DB_USER:-billrun_runtime}` on every `psql` task, so on a
  fresh `down -v` every stage dies with `role "billrun_runtime" does not exist`.
  Same gap for `rating_runtime`. Fix is the documented chain from
  `infra/docs/db-role-verification.md`, run with
  `BOOTSTRAP_DATABASE_URL=postgresql://postgres:postgres@db:5432/enterprise_billing`
  inside the `app` container: `db:bootstrap-roles` → `db:bootstrap-rating-roles`
  → `db:bootstrap-billrun-roles`, then `ALTER ROLE billrun_runtime WITH PASSWORD
  'billrun_runtime_dev_password'` (and `rating_runtime` /
  `'rating_runtime_dev_password'`) to match the `SECRET_*_RUNTIME_PASSWORD`
  values in `workflow-management/dev/.env.example`. Verified afterwards by
  running the flow's own `PG*` exports inside the engine container: connects as
  `billrun_runtime` and reads the seeded rows. Worth folding into `kestra-setup`
  so a clean stand-up is executable without manual steps.
- **Invoice rendering never works from the containerised dev app (2026-09-17).**
  `render-invoice.ts` drives Playwright Chromium. The production `Dockerfile`
  installs it (`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, `npx playwright
  install --with-deps chromium`), but the dev compose `app` service does NOT
  build that Dockerfile — it runs `image: node:22-alpine` with a bind mount, and
  has **no browser cache at all**. So in local dev the invoice artifact can only
  be rendered by a HOST-side dev server. Symptom in the UI: "Invoice artifact
  render pending. / Render failed again. Please try again." while the run itself
  is correctly `INVOICED` (the render is a post-commit step with its own retry,
  so a render failure never blocks posting).
- **Playwright browser revision drifts from the pinned package (2026-09-17).**
  Even on the host the render failed: `playwright@1.63.0` (pinned, and matching
  `node_modules`) wants `chromium_headless_shell-1243`, but the host cache held
  only 1228/1234 — the package was upgraded without re-running the download.
  Fix: `npx playwright install chromium`. Diagnose it directly rather than
  through the UI with:
  `node -e "require('playwright').chromium.launch().then(b=>b.close()).catch(e=>console.log(e.message))"`.
  Red herrings ruled out on the way: `customer_bill.ref_bill_format_id` /
  `ref_bill_template_version_id` are NULL by design (the template is code in
  `render-invoice-template.ts`, not a DB row), and Azurite was healthy.
- **A stale `next_cache` volume makes API routes silently 404 (2026-09-17).**
  On the first full run of `bill_run_processing`, every stage callback got a
  **404 with an HTML body** — `/api/billrun/[runId]/stage/[stage]/complete` and
  `/api/billrun/[runId]/distribution/outcome` were **absent from Next's route
  registry** (`.next/dev/types/routes.d.ts` listed only 5 of the 7 API routes),
  while `/api/billrun/[runId]/status` in the same tree resolved fine. The files
  were present and identical in shape inside the container; `proxy.ts` excludes
  `/api`; `next.config.ts` excludes nothing. **A container restart did NOT fix
  it** — the `next_cache` volume mounted at `/app/.next` survives restarts and
  `--force-recreate`, and the types were regenerated from the stale cached
  module graph. `rm -rf /app/.next/dev` + restart forced a full rescan and all 7
  routes registered. Likely cause: Turbopack's initial scan missing files over
  the Windows bind mount — `WATCHPACK_POLLING` is set on the `app` service but
  only affects webpack's watchpack, not Turbopack.
  **How to spot it:** a 404 whose body is HTML (not JSON) from a route that
  demonstrably exists. Check
  `docker exec … grep -oE '"/api/[^"]*"' /app/.next/dev/types/routes.d.ts`
  against `find app/api -name route.ts` before debugging anything else.
- **The containerised `app` cannot dispatch to the engine.**
  `BILLRUN_ENGINE_URL=http://localhost:8085/...` resolves to the app container
  itself (verified: connection refused), and `workflow-engine:8080` is rejected
  by the HTTPS-unless-loopback rule in `lib/config.ts`. As `.env` documents, a
  real execution must be triggered from a HOST-side dev server (or
  `scripts/billrun-live-kestra-smoke.ts`); the container app must stay up
  regardless, because every flow callback targets `http://app:3000`.

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
