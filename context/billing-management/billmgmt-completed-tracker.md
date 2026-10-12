# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-09-16 (Phase 1–4, bm01–bm39), 2026-10-07 (Target Capacity
Pricing update, bm40–bm46) and 2026-10-12 (Invoice Template update, bm47–bm63,
plus the bm42a follow-up) — per-unit narrative, post-review-fix logs, and
test-file enumerations trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit
detail: `context/billing-management/specs/bm*.md`._

## Current state (2026-10-12)

- **Invoice Template update (bm47–bm63): COMPLETED — signed off at the bm63
  ship gate, 2026-10-11.** Handlebars binder on `customer_bill_line` with
  reconciliation (bm47), rating geo on `udr_rated` (bm48, `0045`), usage annex
  by state → district (bm49), template catalog + permission + grants (bm50,
  `0046`), write-once blob store + prod containers (bm51–bm52), checksum-verified
  resolution/load (bm53), posting stamps (bm54), Invoice Settings editor,
  company profile, save/activate, logo upload (bm55–bm61), invoice CSV (bm62).
  bm63 proved overview success criteria 1–12 on a fresh database (journey 8/8)
  and in the browser (admin e2e 5/5); unit 4378/0, integration 1219/0. Every
  G-item decided (G5, G8, G9, G14, G16). Carried past the gate: layout v2
  (annex CSS + real IBM Plex fonts, known-issues §20) before any production
  template activation, and the `appBlobAuth` Managed Identity flip at cloud
  cutover; residuals in known-issues §23. Full per-unit detail in the
  "Invoice Template update — DELIVERED" section below.
- **bm42a (Target Capacity follow-up, 2026-10-10): DELIVERED** — flow-only fix
  of the aggregation window-in-aggregate defect, string-money trace, plain-USAGE
  tamper check (known-issues §21c2–c4). Detail archived after the Invoice
  Template section below.
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
  - **`tsc`/lint/DB-free suite (§ verification checklist item 7) — `tsc` +
    lint CLEAN; vitest NOT GREEN (5 failures, argued pre-existing, not
    independently confirmed; no exception accepted).**
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

### Invoice Template update — DELIVERED (bm47–bm63, 2026-10-08 → 2026-10-11)

Signed off at the bm63 ship gate (2026-10-11): overview success criteria 1–12 proven on a
fresh database (journey) and in the browser (admin e2e); every G-item decided. The per-unit
narrative below is archived verbatim from the progress tracker (compacted 2026-10-12).

### Invoice Template update — bm47 DELIVERED (`dc19685`; gates decided and follow-ups closed or carried at the bm63 ship gate, 2026-10-11)

- **bm47 — Invoice binder on `customer_bill_line` + reconciliation (Handlebars layout
  `INVTPL-STD-A4` v1).** Part 4 of `bm00-build-plan.md`. Scoped on explicit user
  direction to "core binder first": the gating binder pipeline is built and unit-tested;
  the full 13-test guardrail matrix, real embedded fonts and generator-byte-parity are
  tracked below as follow-ups, not silently assumed done.
  - **Delivered:** `types/billing.ts` (`InvoiceRenderInput`/`InvoiceCompany`/
    `InvoicePayment`/`InvoiceAddress`/`InvoiceLine`/`InvoiceLineGroup`/
    `InvoiceUsageSection`/`LayoutPageSetup`, `INVOICE_ERROR_CODES`, `InvoiceRenderError`;
    `DraftInvoiceNotFoundError`/`FinalInvoiceNotFoundError` moved here from
    `render-invoice.ts`, re-exported unchanged); `validation/billing/
    layout-page-setup.schema.ts`; `db/repositories/billing/invoice-render-input.ts`
    (the binder's only repository — one RR read-only txn, SQL-computed reconciliation
    sums, per-source window-summed group totals, the usage `GROUPING SETS` subtotals
    with `GROUPING()`-disambiguated grain); `services/billing/invoice-template/
    {bind,helpers,compile,load-stopgap}.ts` (D1–D6/D8); `render-invoice-template.ts`
    rewritten as the `buildInvoiceHtml` binder entry point (legacy `buildDraftInvoiceHtml`/
    `buildFinalInvoiceHtml` deleted — Inv #40, no legacy fallback); `render-invoice.ts`
    keeps only the Chromium orchestration, `renderPdfFromHtml` now takes `pageSetup`/
    `footerHtml` (D9); `post-run.ts`'s two catch blocks now log `renderErrorCode` and
    `retryRenderInvoice` returns `detail` on `RENDER_FAILED` (D10); Handlebars 4.7
    added as a direct dependency (`4.7.10`, own commit per workflow rules §4.2); the
    layout v1 files (`manifest.json`, `shell.hbs`, `footer.hbs`, 9 `partials/*.hbs`,
    `sample-data.json`, `fonts/OFL.txt`) and the D8 hand-written default generated
    output (`db/seeds/invoice-templates/generated/INVOICE/v1/{invoice.hbs,footer.hbs,
    structure.json}`) — both written here, **not seeded** until bm50; `context/
    billing-management/invoice-template/placeholder-catalog.md` created (didn't exist
    before bm47). Tests: `bind.test.ts`, `helpers.test.ts`, `build-invoice-html.test.ts`
    (new), `render-invoice-template.test.ts` + `render-invoice.service.test.ts`
    (rewritten against the binder). `npm run typecheck` clean; the touched-file vitest
    slice (164 tests) green.
  - **OPEN follow-ups (not built in this pass, do not assume done):**
    1. **Real embedded fonts.** `shell.hbs` / the generated `invoice.hbs` ship
       `@font-face` declarations with the `src` left as a placeholder comment, not the
       real IBM Plex Sans/Mono OFL woff2 binaries subset+base64'd (G8 interim). Must
       land before bm50 seeds this file (immutable once seeded, Inv #44).
    2. **Guardrails 44, 49, 50, 54 and the layout lint are not built.** No
       `tests/guardrails/invoice-no-legacy-render.test.ts`,
       `invoice-manifest-parity.test.ts`, `invoice-escaping.test.ts`,
       `invoice-layout-lint.test.ts`, or the `invoice-multipage.test.ts` (guardrail 54)
       fixture/test. Guardrail 43 (reconciliation) is covered at the unit level
       (`bind.test.ts`) but not yet as a `ci`-seed DB-gated guardrail.
    3. **`tests/db/invoice-render-input.integration.test.ts` and the
       `tests/db/billrun-capacity-appendix.integration.test.ts` update are not built.**
       The repository's SQL (window sums, `GROUPING SETS`) is unverified against a
       real Postgres in this environment.
    4. **`tests/services/billing/invoice-golden.test.ts` (golden-render structural
       snapshot) is not built.**
    5. **Build-boundary lint addition** (code-standards: "Add `handlebars` to the
       build-boundary lint so a `components/**`/`app/**/*.tsx` client import fails")
       was not added as an explicit `eslint-plugin-boundaries` rule — the existing
       `components`→`services` deny-by-default already blocks it structurally, but no
       dedicated assertion/test proves it.
    6. **Docs not yet closed:** `billmgmt-code-standards.md`'s "Part 2 section
       citations switched to Inv #39–#50" (workflow rules §7.4) and
       `billmgmt-architecture.md`'s X4 conflict-table close-out are deferred — the
       D#/R# citations in code-standards' Part 2 delta section are unchanged.
  - Depends on bm46 (met). Gates G4/G5/G8/G9 built to their recorded interim. No
    migration, no `billrun_runtime` grant change, no `workflow-management/**` change
    in this unit (confirmed: `app_runtime` already holds the needed `customer.*`/
    `billing.document` grants via the existing schema-wide/per-table grants in
    `db/bootstrap/bootstrap-db-roles.sql` — no grant file change was needed).
  - **Review fixes (2026-10-08):** a final `bind()` with no `billing.document` row now
    throws `FinalInvoiceNotFoundError`; a document/`invoiceNo` mismatch is the new
    `INVOICE_DOCUMENT_MISMATCH` code (was `TEMPLATE_COMPILE_FAILED`); `invoice.date`
    is the posting day in the app timezone (was UTC). Spec D8 now records the stopgap
    serving final renders before bm54 as an **interim exception to Inv #42**. Whether
    to block final renders until bm54 is an **OPEN** owner decision.
  See `context/billing-management/specs/bm47-invoice-binder-reconciliation.md` for the
  full design/implementation/test plan this unit builds toward.

### Invoice Template update — bm48 DELIVERED (code), DB/python suites UNRUN (2026-10-08)

- **bm48 — Rating persists `state`/`district` on `udr_rated` (cross-module, rating-only
  boundary).** Migration `0045_rating_udr_rated_geo.sql` (+ journal `idx 45`), Drizzle
  mirror; PRP stamps the matched ACTIVE ratecard cell's labels per record → RP passes
  them through → RL appends them last in `COPY_COLUMNS` (required for `RAN_USAGE`, `NULL`
  for a non-ratecard usage type). Seeds: `udr-rated-sample.ts` gains optional geo +
  `SAMPLE_RAN_GEO_LABELS` (from the Sample-5G card); the `ci`/`volume` RAN rows cycle
  those labels with **exactly one** row left `NULL` (sequence 1, for bm49's "Unassigned
  region"); capacity-appendix rows carry their cell's geo (the card-missing polygon stays
  `NULL`). Tests: `rm01` 15b, `grants` 10a, `rm07` ×3, `rm09` ×3 (`build_chunk_rows`),
  `rm13` geo assertions, new `rm23-udr-geo-frozen`. No billing code under the spec's
  boundary paths.
  - **Gates/decisions:** G13 decided 2026-10-08 (reuse PRP's canonical cell match);
    one PR with ordered commits under a recorded bm48-only waiver of rating §4.1/§4.3.
  - **Docs closed in this change set:** Inv #36 amended; X1 removed from the architecture
    conflict table, C1 from code-standards, _Overlap_ + rating follow-ups from the
    overview's open items; workflow rules §5 DECIDED item 5; known-issues §15 D4 marked
    closed for post-bm48 rows; `ratemgmt-architecture.md` Inv #26,
    `ratemgmt-project-overview.md` column note, `ratemgmt-progress-tracker.md`.
  - **Verified:** `npm run typecheck`, ESLint on every changed TS file,
    `check:rating-migration-boundary` (classifies `0045`, no `billing.*` writes), and the
    DB-free seed/boundary guardrails (141 tests) — all green.
  - **OPEN (not silently assumed green):** (1) every DB-gated / python-gated rating suite
    touched here (`rm01`, `grants`, `rm07`, `rm09`, `rm13`, `rm23`) is authored but
    **unrun** — this host has no `python3` and no disposable Postgres; (2) the rm13
    live-Kestra RAN journey with geo populated has not run; (3) `bm00-build-plan.md` Unit
    48's text ("where rating reads `rate_per_unit`" → "PRP's ratecard cell match") could
    not be corrected — that file is not in this repo; (4) deploying needs a worker-image
    rebuild (runtime is baked into the image), which re-stamps `rating_engine_version`.
  - **SonarQube duplication fix (2026-10-08):** `rm23` was flagged at 26.2% duplicated
    lines on new code (scaffolding copied from `rm13`). The shared RAN_USAGE harness (python
    probe, role-SQL runner, schema drop, feed profile, Sample-5G graph seed, PRP/RP/RL
    runners) now lives in `tests/helpers/rating-ran-harness.ts`, and both `rm13` and `rm23`
    use it. No assertion changes. tsc/ESLint/Prettier are green; both suites are still
    **unrun** (same host limits as above). `rm07`–`rm12` still carry their own older copies,
    left as they were. Second review (Sonar S4036, PATH hotspot): the harness now runs
    python3 by **absolute path** only. It uses `RATING_PYTHON3` if that is set to an
    absolute path, otherwise `/usr/bin/python3` or `/usr/local/bin/python3`. A local
    py3.12 venv/shim that is found only through `PATH` must now be named in
    `RATING_PYTHON3`, or rm13/rm23 skip.
  - **Next:** bm49 switches the binder's usage section onto these columns.

### Invoice Template update — bm49 DELIVERED (code + docs), DB/Playwright suites DEFERRED (2026-10-08)

- **bm49 — Usage annex: billed usage by state → district, with subtotals
  (Invoice Template update, Part 4).** Switched the binder's usage section off the
  bm45 `additional_info.appendix` snapshot and onto the bm48 `udr_rated.state`/
  `district` columns (R9; architecture **X2 closed** to R9's "every billed
  `udr_rated` row" design, G2). Spec:
  `context/billing-management/specs/bm49-usage-annex-state-district.md`.
  - **Delivered (production + templates):**
    - `db/repositories/billing/rated-lines.repository.ts` — new READ-only
      `listBilledUsageForInvoice({ runId, banId, attempt, timezone, limit })` (its
      R9 home, workflow rules §6.1): `count(*)` first (D3 — over `limit` returns
      `{ overLimit: true, rowCount }` and selects nothing), then the D5 rows
      (`cell` = `polygon_id` from `udr_key` else the raw key; `startDate` in the app
      TZ), then the `GROUPING SETS ((state,district),(state),())` subtotal aggregate
      with `GROUPING()` disambiguation and single-unit quantity subtotals. Built with
      the Drizzle query builder + schema-object `sql` fragments (no literal
      schema-qualified reference), so `billing-rating-write-boundary` stays green.
    - `db/repositories/billing/invoice-render-input.ts` — dropped the bm45
      `jsonb_to_recordset(additional_info->'appendix')` read; added
      `usage_rated_total = SUM(rated_amount) FILTER (WHERE source='USAGE')` to the
      line aggregates and `bill_run_account.attempt_count` to the header read; the
      usage read is **delegated** to `ratedLinesRepository` (file keeps no
      rating-schema reference). `read()` now takes `{ runId, banId, timezone,
      includeUsage }`.
    - `services/billing/invoice-template/bind.ts` — `BindContext.includeUsage` (D4);
      over-limit throw `INVOICE_USAGE_OVER_LIMIT` (D3); the new state→district
      `InvoiceUsageSection` builder (labels `state ?? 'Unassigned region'`,
      `district ?? '—'`, Unassigned last); usage reconciliation (D6 — annex grand
      total == `usage_rated_total`, else `INVOICE_RECONCILIATION_FAILED` with
      `detail: 'usage'`).
    - `services/billing/render-invoice-template.ts` — threads `timezone` +
      `includeUsage: true` (bm53 derives it from `structure`).
    - `types/billing.ts` — rewritten `InvoiceUsageRow`/`InvoiceUsageDistrictGroup`/
      `InvoiceUsageStateGroup`/`InvoiceUsageSection`; new `INVOICE_USAGE_ROW_LIMIT =
      10_000` and `INVOICE_USAGE_OVER_LIMIT` error code.
    - `db/seeds/invoice-templates/INVTPL-STD-A4/v1/partials/usageAnnex.hbs` + the
      hand-written `generated/INVOICE/v1/invoice.hbs` (inlined D7 markup + the §10c
      annex CSS) + `sample-data.json` (2 states × 2 districts + one Unassigned row).
      **`*.hbs` added to `.prettierignore`** — the hand-authored layouts/generated
      output are byte-frozen (Inv #44) and prettier's glimmer parser reflows their
      inline text, breaking rendered-text assertions and generator parity.
    - **No migration, no grant change, no `workflow-management/**` change** (the flow
      keeps writing the bm45 snapshot; nothing reads it after this unit).
  - **Layout v1 is frozen by this unit** — the last change before bm50 seeds it
    (workflow rules §6.6). Any later change is a new `v{n}` generated version
    (Inv #44). *The real embedded-font follow-up from bm47 (OFL woff2 base64) must
    still land before bm50 seeds these bytes.*
  - **Tests (DB-free, run + green here):** `bind.test.ts` (rewritten usage-section
    tests to the new shape; added over-limit D3, hidden-annex D4, and reconcile D6
    cases), `render-invoice-template.test.ts` (usage annex now the itemised
    billed-row shape), `build-invoice-html.test.ts` + `helpers.test.ts` (unchanged,
    still green), new `tests/guardrails/invoice-render-source-boundary.test.ts`
    (`invoice-render-input.ts` has no `rating.`; no render-path file reads
    `additional_info`/`ratecard_ran_usage_lkp`, Inv #47). The touched-file slice
    (63 tests) and the full guardrail suite (25 files / 186 tests) are green;
    ESLint clean on every changed file. `npm run typecheck` is **fully clean** (the
    earlier `yaml` error was pre-existing node_modules drift — `yaml@2.9.1` is
    declared + lock-pinned but was absent from `node_modules`; materialised locally,
    the lockfile left untouched).
  - **DB-gated test (authored + RUN GREEN on the disposable Postgres, 2026-10-08):**
    `tests/db/invoice-usage-annex.integration.test.ts` (new) — **4/4 passing**
    against the `docker-compose.test.yml` throwaway stack (`ebill-test`, port 5434,
    `DESTRUCTIVE_DB_OK=1` + the disposable sentinel). It proves the genuinely
    DB-specific code the unit tests can't: the `AT TIME ZONE` date cast (a
    2026-06-11T18:00Z row dates to 2026-06-12 in Asia/KL), the
    `substring(... 'polygon_id=([^|]*)')` cell extraction (raw key fallback for a
    non-polygon key), the `GROUPING SETS` district/state/grand subtotals + the
    single-unit quantity rule, the `billrun_attempt`/`status` D2 filters
    (`BILL_NOTUSED` + other-attempt rows excluded), the D3 over-limit marker
    (10,001 rows), and the full `invoiceRenderInputRepository.read → bind` path
    incl. the D6 grand-total-vs-`rated_amount` reconciliation and its tamper
    failure. It deliberately does NOT use the `extract-flow-sql` harness, so it
    needs no `yaml` and no live Kestra.
  - **Real-Chromium render (authored + RUN GREEN, 2026-10-08):**
    `tests/services/billing/invoice-render-chromium.e2e.test.ts` (new) — **2/2
    passing**. The Playwright `chromium` binary was already installed
    (`ms-playwright/chromium-1243`); the render pipeline was never missing it (the
    old `render-invoice.service.test.ts` just *mocks* Chromium). This test drives
    the actually-seeded generated template through `bind` → Handlebars → a **real
    Chromium `page.pdf()`** with the exact `render-invoice.ts` options (A4 page
    setup from the manifest, `displayHeaderFooter` + the `footer.hbs` footer), over
    an 8-state × 4-district × 4-row annex fixture (128 itemised records → multi-page
    at the §10c 8pt size). Asserts a valid PDF (`%PDF-` / `%%EOF`), that the large
    fixture out-sizes a 1-row fixture (pagination proxy; opportunistic `/Count > 1`
    when Chromium emits a plain Pages count), the draft watermark/final INV number,
    and — covering guardrail 54's structural intent — the `thead` repeat
    (`display: table-header-group`), the fixed-layer watermark, and the footer's
    `pageNumber`/`totalPages` spans. DB-free and gated behind `RUN_CHROMIUM_E2E=1`
    (skips in the normal `npm test` unit run). This is the render-level coverage the
    earlier pass had deferred for "no Chromium".
  - **Still DEFERRED (need the full app route + `ci` seed, or the capacity flow
    harness):** `tests/guardrails/invoice-usage-over-limit.test.ts` (the `ci`-seed
    draft-**422** / final-**park** guardrail — that is render-route + posting wiring;
    the bind-layer over-limit throw is covered DB-free, and the repository's
    over-limit marker is covered on real Postgres), the
    `billrun-capacity-appendix.integration.test.ts` premise-correction update, the
    `invoice-multipage.test.ts` guardrail-54 fixture rename, and the
    `invoice-golden.test.ts` regenerate (the render is now proven real end to end
    above; a committed golden snapshot is the only remaining nicety).
  - **Observed while running the disposable DB (pre-existing, NOT bm49):** the bm45
    `billrun-capacity-appendix.integration.test.ts` fails in its own
    `extract-flow-sql` harness (`statement references :'var' but no test value was
    supplied` + ZodErrors) — flow-YAML/fixture drift in the capacity flow-double,
    unrelated to and untouched by bm49 (matches the standing "capacity DB suites not
    re-run against a disposable Postgres in this environment" note).
  - **Docs closed in this change set:** architecture X2 (conflict table + header
    note + a Resolved paragraph); overview _Open items_ (X2/G2 closed by bm49);
    workflow rules §5 OPEN→DECIDED; code-standards TS rule 7 (+`INVOICE_USAGE_OVER_LIMIT`,
    `INVOICE_DOCUMENT_MISMATCH`, the `detail:'usage'` reconcile note); ui-context §6d
    ("Unassigned region", source = `udr_rated`, itemised rows); `placeholder-catalog.md`
    `usage.*` shape; this tracker.

### Invoice Template update — bm50 DELIVERED (`ab736a3`, 2026-10-08)

- **bm50 — Invoice template catalog schema, seed rows, permission row and grants
  (Invoice Template update, Part 4).** Schema + grants + seed only (lands before any
  consumer; nothing renders from these rows until bm53, no page until bm55). Spec:
  `context/billing-management/specs/bm50-template-catalog-schema-seed.md`. Creates the
  four `billing` catalog tables (`bill_format`, `bill_template_version`, `bill_asset`,
  `bill_asset_version`) with the DB-enforced version rules (two guard triggers,
  `DEFAULT_VERSION_IMMUTABLE`/`VERSION_IMMUTABLE`/`VERSION_DELETE_FORBIDDEN`), the
  partial unique indexes (one-ACTIVE-non-default / one-default / one-draft per kind),
  the two `customer_bill` stamp columns (`ref_invoice_profile_version`,
  `ref_csv_template_version_id`), the seed rows (`INVOICE`, layout `INVTPL-STD-A4` v1,
  default generated v1, CSV v1 — each with the SHA-256 of its `checksums.json`), the
  `invoice_settings` permission set (minus the nav entry — deferred to bm55), the
  `app_runtime` grants + the `billrun_runtime` revoke of the two reserved stamp
  columns, the read-only repositories, unions + ID schemas, the CSV v1 column map, and
  a `write-checksums.ts` repo script. Migration `0046` (bm48 owns `0045`).
  - **Gate decisions recorded as decided (interim) per the spec:** G3/X3/C3 (partial
    unique index excludes the default; resolution pinned → non-default ACTIVE →
    default); G6 (SHA-256 hex for template/asset blobs, algorithm stored per row); G7
    (notes/footer are fixed layout text); G10 (nothing deletes a version); G11 (ADMIN
    EDIT, MANAGER EDIT, USER READ); G12 (`customer_bill.ref_csv_template_version_id`).
  - **Delivered:** migration `0046_invoice_template_catalog.sql` (+ journal idx 46) —
    the four catalog tables, the CHECK family, the three partial unique indexes
    (`btv_one_active_uq` excluding the default, `btv_one_default_uq`, `btv_one_draft_uq`),
    the two guard triggers (`bill_template_version_guard`/`bill_asset_version_guard` +
    the `bill_catalog_forbid` shared forbid for `bill_format`/`bill_asset`), the two
    `customer_bill` stamp columns, the seed rows (`INVOICE` + BTV00000001 layout /
    00000002 generated / 00000003 csv, each with its directory's SHA-256), and the
    `invoice_settings` permission row. Drizzle mirrors `bill-format.ts`/
    `bill-template-version.ts`/`bill-asset.ts` (+ `customer-bill.ts` columns, index
    exports). Grants: `bootstrap-db-roles.sql` (`app_runtime` SELECT on `bill_format`,
    SELECT/INSERT/UPDATE on the other three, sequence USAGE, no DELETE) and
    `billrun-db-roles.sql` (dropped `ref_bill_format_id`/`ref_bill_template_version_id`
    from the `customer_bill` INSERT/UPDATE grants + idempotent REVOKE + `REVOKE ALL` on
    the four tables, Inv #41). Permission set across `permission-constants.ts`,
    `rbac.ts`, `permissions.ts`, `roles.ts` (display label) + `db/seeds/billing.ts`
    grants (ADMIN/MANAGER EDIT, USER READ). Read-only repositories
    `bill-template-version.ts` (findById/findActive/findDefault/listForKind+usedByCount/
    nextVersionNo-via-advisory-lock) and `bill-asset.ts`. Unions +
    `InvoiceTemplateStructure` in `types/billing.ts`; ID schemas in
    `validation/billing/template-version-id.schema.ts`. CSV v1 column map
    (`system/csv/v1/invoice.csv.columns.json`) + the `write-checksums.ts` script + the
    three committed `checksums.json`. The nav entry is **deferred to bm55** (D7 — no
    page yet; the one sanctioned split of "the permission map moves as one").
  - **Verified:** `npm run typecheck` + ESLint clean. DB-free tests green
    (`invoice-template-seed-checksums` — the migration digests recompute from the repo
    files; `permission-registry`; `customer-bill-schema` updated — 16 tests). Against
    the disposable Postgres (`docker-compose.test.yml`, `DESTRUCTIVE_DB_OK=1` + the
    sentinel): `invoice-template-catalog.integration` **9/9** (seed rows, the CHECK
    family, all three unique indexes, the guard triggers incl. `DEFAULT_VERSION_IMMUTABLE`
    / `VERSION_DELETE_FORBIDDEN` / `VERSION_IMMUTABLE`, the generated structure = all
    union keys true, the permission row) and `invoice-settings-grants.integration`
    **3/3** (runs the real bootstrap SQL and asserts the grant set over
    `information_schema`). The existing `billrun-db-roles.integration` is **37/38** with
    my bootstrap edits — the 1 failure is a **pre-existing** PC14 drift (the test
    `UPDATE product.product_offering_price SET amount…` hits a since-removed `amount`
    column), unrelated to bm50.
  - **Note on the grants test name:** the spec named it
    `tests/guardrails/invoice-settings-grants.test.ts`, but a schema-dropping DB test
    must carry the `.integration.test.ts` suffix to run under the destructive-DB-guarded
    integration project (the default project is DB-free and unguarded). Renamed to
    `invoice-settings-grants.integration.test.ts` — a safety-driven deviation.
  - **Still to close (docs):** X3 in the architecture conflict table / overview /
    code-standards C3; the G6/G10/G11/G12 records; architecture §3 storage + §4
    permission rows; code-standards §8 row + TS rule 7 (`VERSION_IMMUTABLE`,
    `VERSION_DELETE_FORBIDDEN`) + data rule 2 (`checksum_algorithm`/`checksums.json`);
    `billmgmt-known-issues.md` "ratecard role grants are not seeded" (observed, not
    fixed); `infra/docs/db-role-verification.md` re-run order.

### Invoice Template update — bm51 DELIVERED (code + docs), Azurite round-trip UNRUN (2026-10-09)

- **bm51 — Generalized write-once blob store + template/asset containers (Invoice
  Template update, Part 4).** Spec:
  `context/billing-management/specs/bm51-generalized-blob-store.md`. Generalized the
  single-container invoice client into `putObject`/`getObject(container, path, …)` over
  the three containers (`invoices`, `invoice-templates`, `invoice-assets`) with an
  explicit write-once mode and a per-object checksum algorithm; `putInvoice`/`getInvoice`/
  `putReport` are now thin wrappers whose bytes, paths, content types, md5 checksums and
  412 behaviour are unchanged. **No consumer of the two new containers exists yet** (grep
  gate; nothing reads them until bm53). Gate G6/O2/C4 OPEN (interim): `invoices` keeps
  md5, the new containers use SHA-256, every put returns the algorithm.
  - **Delivered:**
    - `types/billing.ts` — `BLOB_CONTAINERS`/`BlobContainer`, `CHECKSUM_ALGORITHMS`/
      `ChecksumAlgorithm`, and `BLOB_STORE_ERROR_CODES` (`BLOB_ALREADY_EXISTS`,
      `INVALID_BLOB_PATH`) with a dedicated `BlobStoreError` class.
    - `services/billing/blob-store.ts` — rewritten per D1–D4: a memoized **service**
      client (same two auth paths, same mutual-exclusion/HTTPS/clear-on-rejection) plus a
      `Map<BlobContainer, Promise<ContainerClient>>` with per-container
      `createIfNotExists` on the connection-string path only; `putObject` (writeOnce +
      `onExists: 'returnExisting' | 'throw'` + `checksumAlgorithm`, returns
      `{ blobRef, checksum, checksumAlgorithm, created }`), `getObject` (raw bytes, **no
      verification** — the caller's job), `parseBlobRef`, `digest`; D2 path-safety regex
      (`..`/leading-/trailing-`/`/space/`%`/>512 rejected) + runtime container check.
    - `scripts/azurite-init.ts` — added `invoice-templates`, `invoice-assets` to the
      local container list.
  - **Deviation from the spec wording (recorded):** D1/D2 write `AppError('BLOB_ALREADY_EXISTS', …)`
    / `AppError('INVALID_BLOB_PATH')`, but the real `AppError` (`lib/errors.ts`) is a
    closed 6-code HTTP-mapped union taking `(code, message)` and cannot carry the
    `{ blobRef }` detail; and implementation step 1 places the codes in `types/billing.ts`.
    These cannot both hold, so the codes live in `types/billing.ts` as `BLOB_STORE_ERROR_CODES`
    thrown via a dedicated `BlobStoreError` class — the exact `InvoiceRenderError`
    precedent. The test table asserts on the `code`, which is satisfied either way.
  - **Tests (DB-free, RUN GREEN here):** `tests/services/billing/blob-store.test.ts`
    (extended: `putObject` per container, `ifNoneMatch:'*'`, 412+`returnExisting` →
    existing digest/`created:false`, 412+`throw` → `BLOB_ALREADY_EXISTS`, `writeOnce:false`
    sends no condition, md5-vs-sha256 digests, path/container validation, `parseBlobRef`
    round-trip, `createIfNotExists` once per container on the connection-string path),
    `blob-store-invoice-parity.test.ts` (new — byte-equality: the `uploadData` call and
    `{ blobRef, checksum }` of `putInvoice`/`putReport`/`getInvoice` equal a recorded
    pre-bm51 fixture). The two files (**24 tests**) are green; the dependent service
    suites `post-run.service`/`get-stored-invoice`/`distribute-run.service` (**64 tests**)
    stay green untouched. `npm run typecheck` + ESLint on every changed file clean.
  - **Authored + UNRUN here (same host limits as bm49/bm50):**
    `tests/db/blob-store.azurite.integration.test.ts` (new) — real round-trip in all
    three containers, second write-once put to a template path refused, second
    `putInvoice` returns the first md5. It needs a reachable Azurite
    (`BILLRUN_BLOB_CONNECTION_STRING`) and skips loudly otherwise; the `.integration.test.ts`
    suffix keeps it out of the DB-free unit run but also couples it behind the
    destructive-DB preflight (it touches no Postgres) — a known cost of the spec's
    `tests/db/` naming. The bm34 distribution **api** suites were not re-run (untouched by
    this unit).
  - **Docs closed in this change set:** code-standards data rule 7 (full `putObject`
    signature with `onExists`/`checksumAlgorithm`, write-once/412 behaviour, path
    validation, the connection-string-path-is-also-prod correction) + TS rule 7 (the two
    `BLOB_STORE_ERROR_CODES`); architecture storage delta (`blob-store.ts` row + the
    `infra/**` boundary row corrected: prod runs the connection-string path today, so
    `createIfNotExists` runs there too until bm52 moves it to Managed Identity); this
    tracker.
  - **Next:** bm52 provisions the prod containers + MI write grant; bm53 adds the first
    consumer (template upload/load).

### Invoice Template update — bm52 DELIVERED + VERIFIED by what-if on dev (2026-10-09)

- **bm52 — Prod `invoice-templates` / `invoice-assets` containers + app blob access
  (Invoice Template update, Part 4; `infra/**` only, no application code).** Spec:
  `context/billing-management/specs/bm52-prod-blob-containers-infra.md`. Declares the
  app's three blob containers (`invoices` drift fix + `invoice-templates`,
  `invoice-assets`) in `workflow-engine-storage.bicep`, outputs their resource ids, and
  adds the parameter-gated (`appBlobAuth`, default `connectionString` = no behaviour
  change) container-scoped Managed Identity `Storage Blob Data Contributor` path for the
  app. New gate **G16 (prod app blob auth) — OPEN**. Must be deployed before any prod
  release that includes bm53.
  - **Delivered:**
    - `infra/bicep/modules/workflow-engine-storage.bicep` — D1 `appBlobContainers`
      param + looped `appContainers` (`@2023-05-01`, `publicAccess: 'None'`, gated
      `if (enableBlobArtifacts)`; no WORM policy, no lifecycle rule); D2
      `appContainerIds` output (name → id, `{}` when off — built with `resourceId()`
      because Bicep forbids lambda indexing of a resource array); D3 `appBlobAuth`
      (`@allowed connectionString|managedIdentity`, default `connectionString`) +
      `appManagedIdentityPrincipalId` and a looped `appContainerBlobDataContributor`
      (`Storage Blob Data Contributor`, **scope = each container**, name
      `guid(containerId, principalId, roleId)`). Engine's account-scoped grant untouched.
    - `infra/bicep/modules/container-app.bicep` — `appBlobAuth`/`blobAccountUrl`/
      `appManagedIdentityClientId`; the KV connection-string secret + env are emitted
      only on the connection-string path; the MI path emits `BILLRUN_BLOB_ACCOUNT_URL`
      + `AZURE_CLIENT_ID` and no connection string (`lib/config.ts` rejects both).
    - `infra/bicep/main.bicep` — new `appBlobAuth` param (G16, default
      `connectionString`); threads `enableBlobArtifacts`/`appBlobAuth`/the app MI
      principal id into the **collapsed** storage module and the **billrun** storage
      module under split-by-module (the rating account gets no app containers); derives
      `appBlobAccountUrl` = `https://<artifact account>.blob.${environment().suffixes.storage}`
      (not a hardcoded `core.windows.net` — the `no-hardcoded-env-urls` linter rule)
      and passes it + the MI client id to `container-app.bicep`.
    - Parameter files unchanged — `appBlobAuth` unset everywhere until G16 is decided.
    - Runbooks: `db-role-verification.md` bm38 cutover gains step 6 "bm52 — invoice
      template containers" (what-if → containers; MI path: confirm 3 container-scoped
      assignments, roll revision, smoke `stored-invoice`; then release bm53; Delete-right
      caveat). `environment-operations.md` §6e gains a blob-container prerequisites note.
  - **Deviation (recorded):** the spec puts the container list in
    `environment-operations.md` "§5 (prerequisites) next to `invoices`", but §5 there is
    the DB bootstrap and the file never mentioned the `invoices` container. The note went
    into §6e (the step that deploys the bicep) instead.
  - **Verified:** `az bicep build` + `az bicep lint` on `main.bicep` (Bicep 0.46.1) — no
    new errors or warnings (only the two pre-existing `easy-auth.bicep` BCP081). `dev.bicepparam`
    builds (with dummy `POSTGRES_SERVER_NAME`/`PIPELINE_SP_ID`); staging/prod param
    builds fail exactly as before on the two deploy-time params. The compiled ARM
    confirms each role assignment's `scope` is
    `resourceId('…/blobServices/containers', account, 'default', name)` and its condition is
    `enableBlobArtifacts && appBlobAuth == 'managedIdentity'`. No infra tests exist under
    `infra/`/`tests/`. No application file changed.
  - **What-if VERIFIED against dev (`dnb_billing`, 2026-10-09; read-only, nothing
    deployed).** The live stack's last `ebill-main-dev` deploy (2026-09-25) predates
    `HEAD`, so raw what-if carries unrelated drift; bm52 was isolated by running the same
    what-if (`dev.bicepparam` + the 2026-09-25 deploy-time values + `deployWorkloads=true
    deployWorkflowEngine=true`) on the committed `HEAD` bicep and on bm52, and diffing:
    - **HEAD → bm52 default:** only `+ Create` `invoice-templates` and `invoice-assets`,
      and `invoices` going from ignored (undeclared) to a no-op Modify — the only delta is
      the two server-defaulted encryption-scope fields, the same noise the untouched
      `archive` container shows; `publicAccess` already `None`. **No role assignment.**
      The engine app, migrate job and storage account after-states are byte-identical;
      the app's differs only by a trailing empty `createArray()` in the env `concat`
      (the off MI branch) — it resolves to the same env, still
      `BILLRUN_BLOB_CONNECTION_STRING` via the KV secret.
    - **bm52 default → `appBlobAuth=managedIdentity`:** exactly three role assignments
      added — `ebill-dev-app-mi`, role `ba92f5b4…` (Storage Blob Data Contributor), one
      scoped to each of `containers/invoices|invoice-templates|invoice-assets`, none on
      the account (what-if lists them as `Unsupported` only because the name's
      `guid()` uses the identity's runtime `principalId`). App env gains
      `BILLRUN_BLOB_ACCOUNT_URL=https://ebilldevratingstg3nlvkhl.blob.core.windows.net`
      + `AZURE_CLIENT_ID`, and both `BILLRUN_BLOB_CONNECTION_STRING` and its KV secret ref
      are gone.
  - **Docs closed:** G16 added to the overview open items, architecture open items and
    code-standards C5; architecture §1 artifact-storage row, §3 blob row, the `infra/**`
    boundary row and the auth delta corrected (`invoices` declared in bicep from bm52;
    the app reaches blob by connection string unless G16 flips it); code-standards data
    rule 7 tail; `bm00` Unit 52 text + its G16 row.

### Invoice Template update — bm53 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-09)

- **bm53 — Template and profile resolution, checksum-verified load, seed upload
  (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm53-template-resolution-load-seed-upload.md`.
  No migration, no grant change, no page, no action, no dependency change.
  **bm52 must be deployed before this unit is released to prod**, and the template
  seed must run after it (environment-operations.md §6e).
  - **Gate check:** G6 was already recorded as decided (closed by bm50: workflow
    rules §5, architecture X3 Resolved, overview open items), so the "build may not
    start" gate was met. G3 and G15 (option A) were decided.
  - **Delivered:**
    - `types/billing.ts`: `PostedBillStamps`, `RenderMode`, `ResolvedTemplate`,
      `InvoiceProfile`. `InvoiceCompany` was reshaped to the D3 placeholder names
      (`addressLine1/2`, `postcode`, `city`, `stateCode`/`state`,
      `countryCode`/`country`, `website`; bm47's unused `tradingName`/`address` were
      dropped, and the frozen v1 template never read them). `InvoicePayment.swift` and
      `remittanceEmail` are now required. `template.version` is a number, and
      `invoice.paymentTermsDays` is new. Four new `INVOICE_ERROR_CODES`:
      `TEMPLATE_CHECKSUM_MISMATCH`, `ASSET_CHECKSUM_MISMATCH`,
      `TEMPLATE_VERSION_NOT_FOUND`, `INVOICE_PROFILE_INVALID`.
    - `validation/billing/invoice-profile.schema.ts`: the one `.strict()` schema
      over the D3 key set, plus `toInvoiceProfileInput` (blank/`null` → absent,
      `payment_terms_days` → int). `lib/myinvois-states.ts` holds the 01–16 state
      labels and the country label (data only).
    - `db/repositories/billing/invoice-profile.ts`: `findActiveVersion`,
      `readVersion`, `listVersions`. Read-only, and it never reads `is_secret`
      rows.
    - `services/billing/invoice-profile/read-profile.ts`: `parseInvoiceProfile`,
      `readInvoiceProfile` (DB only), `inlineLogo` (blob only: SHA-256 verify →
      `data:` URI, or `ASSET_CHECKSUM_MISMATCH`), and `getInvoiceProfile`.
    - `services/billing/invoice-template/resolve-template.ts` (D1): draft resolves
      non-default ACTIVE ?? default plus the ACTIVE profile ?? `null`.
      final/preview-posted resolve each stamp, with an unstamped column falling back
      to the default and the profile staying `null`. It never reads the current
      ACTIVE for a posted bill and is never cached.
    - `services/billing/invoice-template/load.ts` (D2): `loadGenerated` verifies
      the `checksums.json` digest, then the index algorithm, then each file; then it
      compiles and probe-executes both delegates against the frozen
      `PROBE_RENDER_INPUT`, then memoizes. The memo is the one sanctioned cache and
      holds only verified, compiled templates. `loadLayout` and `loadCsvMap` verify
      but are not memoized.
    - `render-invoice-template.ts` (D5): one RR read-only txn covers stamps →
      resolve → raw read (`includeUsage` comes from the resolved
      `structure.sections.usageAnnex`) → profile rows. Template and logo blob I/O
      happens after the txn closes. `pageSetup` comes from the resolved layout's
      `page_setup`, and `{ html, footerHtml, pageSetup, resolved }` is returned.
      Also adds the `preview-posted` mode (for bm55) and
      `invoiceRenderInputRepository.readBillStamps`. **`load-stopgap.ts` is
      deleted.** The repo-`fs` manifest read went with it.
    - `db/seeds/invoice-templates.ts` + `db:seed-invoice-templates` (D6),
      appended to `db:setup` after `db:seed-billing`. All three rows are verified
      before the first put (`SEED_CHECKSUM_DRIFT`). Puts are write-once with
      `returnExisting`, and a differing stored blob raises `SEED_BLOB_CONFLICT`.
      Re-running is idempotent. `package.json` changed in scripts only.
  - **Deviations (recorded):**
    1. **Error class.** D2–D4 write `AppError(code, {…})`, but `AppError` is the
       closed HTTP-mapped union (the bm51 finding). The four codes are thrown as
       `InvoiceRenderError` (same `code` + `detail`), which is what `post-run.ts`'s
       `renderErrorCodeOf` logs and parks on.
    2. **Blob paths.** A version's `blob_ref` is its directory (trailing `/`),
       which `parseBlobRef` rejects. `load.ts` therefore parses `blob_ref + file`
       per file, so every object path is still validated.
    3. **Layout repo dir.** D6 says "repo dir = path after container". The layout's
       blob path carries `layouts/`, but its repo files live at
       `db/seeds/invoice-templates/INVTPL-STD-A4/v1/` (code-standards data rule
       10). The seed strips the `layouts/` segment. `OFL.txt` uploads as
       `text/plain; charset=utf-8` (D6 lists no `.txt` type).
    4. **Payment terms.** D5 says "billing-account override ?? profile ?? null",
       but `billing_account` has no payment-terms column, so it is
       `profile ?? null`.
    5. **Lint carve-out.** `db/**` may not import `services/**`, so
       `eslint.config.mjs` gains a `db-seed-invoice-templates` element for this one
       file (the `db-seed-sample`/`db-seed-demo` precedent).
    6. **Test names.** The two DB+blob guardrails are
       `invoice-default-resolution.integration.test.ts` and
       `invoice-checksum-tamper.integration.test.ts`. They drop schemas, so they
       must run under the destructive-DB preflight (the bm50 grants-test
       precedent). Their posted bills are written directly by
       `tests/db/helpers/invoice-render-fixtures.ts` rather than by driving a `ci`
       run, because no workflow engine is available to a test. The render path
       reads exactly those rows. The tamper guardrail parks through
       `retryRenderInvoice`. "Posting of the remaining accounts continues" is shown
       as each account parking independently. The posting loop's swallow is the
       existing `renderAndStoreInvoice` catch, which this unit did not change.
    7. **README + runbook.** `db:setup` now needs Azurite up, so README step 3
       starts Azurite before step 4. environment-operations.md §5h leaves the
       template seed out of its loop on purpose and runs it at the end of §6e,
       after bm52 creates the container.
  - **Pre-existing bm51 defect found and FIXED here:**
    `blob-store.ts`'s write-once conflict check only matched HTTP 412. A real
    Put Blob with `if-none-match: *` on an existing blob returns **409
    `BlobAlreadyExists`** (confirmed against Azurite). So `onExists:
    'returnExisting'` (including `putInvoice`'s posting-retry idempotency) and
    `'throw'` never fired against a real store. bm51's Azurite suite had never been
    run. `isBlobAlreadyExists` now accepts 412 or 409+`BlobAlreadyExists`, with
    two new unit cases. bm51's `blob-store.azurite.integration` now passes.
  - **Tests:**
    - New DB-free tests: `resolve-template.test.ts`, `load.test.ts` (verify-
      then-compile order, index/file/algorithm mismatch, memo hit, no memo on
      failure, three compile-failure kinds, memo value type, real seeded default +
      CSV v1 verified from repo bytes), `invoice-profile.schema.test.ts` (every §B
      format, lengths, required keys, `.strict()`), and
      `guardrails/invoice-no-legacy-render.test.ts` (guardrail 44: legacy
      builders, `listClaimedForAccount`, no `fs` under `invoice-template/**`,
      stopgap gone).
    - Extended: `build-invoice-html.test.ts` (txn-then-blob ordering, mode →
      RenderMode, G15 profile wiring, hidden-usage structure skips the usage read)
      and `render-invoice-template.test.ts` (G15 A no-profile / fixture-profile
      issuer + `data:` logo + bank block / escaping; the default now loads through
      the real `loadGenerated`, served repo bytes by the new
      `tests/helpers/seeded-invoice-template.ts`).
    - The touched unit slice is green. `tsc` is clean, and ESLint + Prettier are
      clean on every changed file.
    - Full `npx vitest run` with `.env` exported: in this tree, the only failures
      are **13 tests in 5 files that fail identically on a clean `HEAD`**
      (verified via stash). Four of the files are the bm50 `invoice_settings`
      permission-count ripple (`resolver`, `permission-matrix-editor`,
      `role-detail`, `roles-read.service` still expect 15 rows). The fifth,
      `ratecard-parse-csv` "one importer", trips on duplicate files under
      `.claude/worktrees/**`. The vitest run also picks up those stale worktrees'
      DB suites. These are pre-existing and not fixed here.
    - **Run green on a throwaway Postgres (`enterprise-billing-app-db` image,
      :5434, sentinel + `DESTRUCTIVE_DB_OK=1`) and a throwaway Azurite (:10010)**,
      removed afterwards: `invoice-profile.integration`,
      `invoice-template-seed-upload.integration`,
      `blob-store.azurite.integration` (16/16), guardrails 45 + 47 +
      `invoice-usage-annex.integration` (8/8), and `invoice-template-catalog` +
      `billing-e2e-happy-path` (10/10).
    - `billrun-phase3-journey.integration` fails at aggregation in the
      `extract-flow-sql` harness (`:'var' … no test value`). This is the
      **pre-existing** drift recorded under bm49, and it fails before any render
      code runs.
  - **Docs closed in this change set:**
    - code-standards: General rule 4 (stamp read + NULL-stamp default rule), TS
      rule 5 (key-name table), TS rule 7 (four codes), data rule 8 (memo value
      type).
    - Architecture Inv #42 (NULL-stamp note).
    - known-issues §18 (pre-bm54 bills render with the default and no profile;
      the memo-after-verify residual).
    - `placeholder-catalog.md` (`template.*`, `company.*`, `payment.*`,
      `invoice.paymentTermsDays`), environment-operations.md §5h/§6e, README, and
      this tracker.
  - **OPEN / not built here:** guardrails 49, 50 (as a standalone file), 54 and
    the layout lint are still bm47 follow-ups, so the checklist's "guardrails
    43–45, 47, 49, 50, 54 green" is only partly satisfiable. Guardrail 47's
    "pinned bill still renders" half lands in bm54.
  - **Next:** bm54 stamps `resolved` onto `customer_bill` at posting.

### Invoice Template update — bm54 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite + Chromium (2026-10-09)

- **bm54 — Posting-time version stamps (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm54-posting-version-stamps.md`. Boundary: the
  posting transaction only (`post-run.ts`, `stampPosted`/`findForAccount`/
  `lockBillForPosting`, `resolveVersionsForPosting`). No migration, no grant change,
  no change to `charge_checksum`, no npm dependency.
  - **Gate check:** G12 is recorded as decided and delivered (workflow rules §5,
    closed by bm50 2026-10-08: CSV version on
    `customer_bill.ref_csv_template_version_id`), so the "build may not start" gate
    is met. G15 is decided (option A).
  - **Delivered:**
    - `resolve-template.ts`: the draft branch's "current" precedence is now one
      private helper, `currentVersions` (non-default ACTIVE ?? default for
      generated + CSV, ACTIVE profile ?? `null`). The new
      `resolveVersionsForPosting(tx)` uses it and returns the four stamp values.
      It reads DB rows only: no layout lookup, no blob read, no compile.
      `PostingVersionStamps` is in `types/billing.ts`, because `db/**` may not
      import `services/**`.
    - `customer-bill.repository.ts`: `stampPosted`'s data gains the four stamps,
      written in its one existing `UPDATE … AND ref_inv_document_id IS NULL`.
      `lockBillForPosting` and `findForAccount` return the four stamp columns.
      The `customer-bill.ts` schema comments now say "stamped at posting by the
      app (bm54)".
    - `post-run.ts`: `postAccount` calls `resolveVersionsForPosting(tx)` after
      `lockBillForPosting` and the checksum, just before `stampPosted`, and
      spreads the result into `stampPosted`'s data. Skipped and zero-total bills
      resolve nothing. A catalog failure rolls the posting transaction back and
      parks the account.
  - **Deviations (recorded):**
    1. **D3 wiring.** D3 says `renderAndStoreInvoice`/`retryRenderInvoice` call
       `buildInvoiceHtml({ mode: { kind: 'final', bill: stamps } })`. Both call
       `renderFinalInvoice`, and since bm53 its `"final"` mode already reads the
       bill's stamps inside `buildInvoiceHtml`'s repeatable-read snapshot and
       resolves `{ kind: 'final', bill: stamps }`. That path never reads the
       current ACTIVE, which guardrail 46 proves end to end. Passing the stamps
       in from `post-run.ts` would mean changing `render-invoice.ts` and
       `render-invoice-template.ts`, which this unit's boundary keeps separate.
       So the renderer is unchanged and `post-run.ts` gets a comment only.
       `findForAccount` returns the stamps as specified, for bm55's consumers.
    2. **Test names.** As in bm53, the two DB+blob suites are
       `.integration.test.ts`: `tests/guardrails/invoice-version-pinning.integration.test.ts`
       (spec: `invoice-version-pinning.test.ts`) and the extended
       `invoice-checksum-tamper.integration.test.ts`. They drop schemas, so they
       must run under the destructive-DB preflight.
    3. **"Header text + template version in the footer".** The seeded v1 footer
       does not print `template.version`. The fixture generated versions are
       byte-copies of v1 with a `data-tpl="PIN-MARK-V<n>"` marker on the title
       and "Template v{{template.version}}" in the footer, each with its own
       `checksums.json` (`insertGeneratedTemplateFixture` in
       `tests/db/helpers/invoice-render-fixtures.ts`). Guardrail 46 asserts the
       marker, the profile company name and the footer version on
       `buildInvoiceHtml`'s output, then renders the PDF through
       `retryRenderInvoice`.
    4. **Parked twin.** A real posting stores the twin's PDF, so the test parks
       it afterwards: it removes the `bill_run_invoices` row (under
       `session_replication_role = replica`, the e2e precedent) and the PDF blob.
  - **Tests:**
    - `post-run.service.test.ts`: the real `resolveVersionsForPosting` runs
      over mocked catalog/profile repositories (34 tests, 6 new). Covered:
      `stampPosted` receives the four values (defaults, and non-default ACTIVE
      over default); G15 no profile → `null`; no blob call (spy on
      `getObject`/`getInvoice`/`putInvoice`); the order lock → resolve → stamp
      on the posting tx; skip/zero-total resolve nothing; a catalog failure
      parks with no stamp.
    - `resolve-template.test.ts` (20 tests, 5 new): the posting resolver's
      precedence, its agreement with a draft resolve, no by-id/layout lookup,
      and `TEMPLATE_VERSION_NOT_FOUND`.
    - New `tests/db/customer-bill-stamps.integration.test.ts` (3/3), through the
      real `postAccount`. A test-only `BEFORE UPDATE` audit trigger shows that
      exactly one UPDATE took the latch from NULL and carried all four stamps
      (no-profile → `NULL`; ACTIVE profile → its version). Three later stamp
      attempts → `23001`, stamps unchanged.
    - New guardrail 46 (4/4): post A + a twin under generated v2 + profile v1
      (with a logo), then activate v3 + profile v2 by DB fixture. A's stamps,
      stored PDF bytes (`getStoredInvoice`) and recomputed `charge_checksum`
      are unchanged, and a reprint is `ALREADY_STORED`. The parked twin
      re-renders with v2 + profile v1 and stores a `%PDF`. A new draft of B
      shows v3 + profile v2.
    - Guardrail 47 second half (3/3 in the file): C is pinned to a fixture v2
      with a tampered `invoice.hbs`. With a cold memo, C parks with
      `TEMPLATE_CHECKSUM_MISMATCH` and A (pinned to the default v1) stores its
      PDF.
    - **Mutation check:** with the stamp spread removed from `postAccount`, 4
      tests fail across the stamps suite and guardrail 46. Restored afterwards.
    - Run green on a throwaway Postgres (`enterprise-billing-app-db`, :5434,
      sentinel + `DESTRUCTIVE_DB_OK=1`) + throwaway Azurite (:10010) + local
      Playwright Chromium: the three suites above, and
      `invoice-default-resolution` (g45), `invoice-settings-grants`,
      `billing-e2e-happy-path`, `invoice-usage-annex`,
      `invoice-template-catalog`, `invoice-profile`,
      `customer-bill-line-checksum`, `invoice-template-seed-upload`. The last
      one timed out at 5 s a few times while the full unit suite was running
      in parallel. On its own it passed 3/3 on this tree and 2/2 on clean
      HEAD, so that was CPU contention, not this change.
    - `tsc` is clean, and ESLint + Prettier are clean on every changed file.
      Full `npx vitest run --pool=threads --exclude ".claude/**"`: the only
      failures are the **13 pre-existing tests in 5 files** recorded under bm53
      (the `invoice_settings` permission-count ripple ×4 files, plus the
      ratecard `.claude/worktrees` duplicate). Six more files only load with
      `.env` exported, and they pass that way (6/6, 34 tests).
      `billing-trial-bill-compute-boundary` (only `post-run.ts` calls
      `stampPosted`) and `stored-invoice-route` are unchanged and green.
  - **Docs closed in this change set:** architecture Inv #41 (built note), the
    §3 `customer_bill` storage row (G12 settled; stamped from bm54) and the
    ownership-shift delta ("the two reserved columns are now written by
    `stampPosted`"); code-standards Part 2 data rule 4 (confirmed as built);
    known-issues §18 (pre-bm54 bills are never back-stamped) and new §19 (a
    mid-run activation gives accounts different versions); this tracker.
  - **OPEN / not built here:** guardrails 49, 50 (standalone) and 54 are still
    bm47 follow-ups, so the checklist's "guardrails 43–47, 49, 50, 54 green" is
    only partly satisfiable. Every built guardrail in 43–47 is green: 44 and the
    render-source boundary in the unit run, and 45, 46 and 47 on the throwaway
    stack. There is no live `ci`-seed
    posting in this environment (no workflow engine for tests). The checklist's
    "posted on the `ci` seed" is shown instead by real `postAccount` runs on
    fixture bills.
  - **Next:** bm55 (posted-bill preview reads the stamps; "used by N invoices").

### Invoice Template update — bm55 DELIVERED (code + tests + docs), unit suite RUN GREEN (2026-10-09)

- **bm55 — Invoice Settings shell + Invoice template read page, generator and live
  preview (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm55-invoice-settings-shell-template-read-preview.md`.
  Boundary: the `administration/invoice-settings` pages, the files GET handler, the
  generator (`generate.ts`), the READ-only preview action/service, the
  `invoice-settings` components, the structure + search-params schemas, and the nav
  entry deferred from bm50. No mutation (no save/activate — bm57/bm58), no migration,
  no grant change, no npm dependency.
  - **Delivered:**
    - `validation/billing/invoice-template-structure.schema.ts`: the D2 schema
      (strict, `MANDATORY_SECTION_HIDDEN` refinement) plus the preview action's
      input schema. The Drizzle `structure` column is retyped from it.
      `MANDATORY_SECTION_KEYS` is in `types/billing.ts`.
      `invoice-settings-search-params.schema.ts` holds `?tab` / `?version`.
    - `services/billing/invoice-template/generate.ts`: `generate(layout,
      structure, { annotate })` and `layoutFilesFromVerified`. `load.ts` gains
      `loadGeneratedFiles` (verified invoice.hbs, footer.hbs and
      structure.json; not memoized).
    - `services/billing/invoice-template/preview.ts` and
      `actions/billing/invoice-settings/preview-invoice-template.action.ts`:
      guard READ → Zod → `billrun_view` for any `{ billId }` (before any read)
      → 30/60 s limiter → service. The sample source and an unposted bill
      generate in memory. A posted bill renders its stamped version through
      `buildInvoiceHtml({ mode: 'preview-posted' })`, so the structure is
      ignored. Nothing is written.
    - `services/billing/read/invoice-template-settings.ts` (page data, Generated
      .hbs bytes, file download, recent posted bills).
      `customer-bill.repository` gains `findPreviewTarget` and
      `listRecentPosted` (LIMIT 20, newest INV first).
    - Pages: the shell `layout.tsx` (guard READ + tabs), an index `page.tsx`
      that redirects to `invoice-template` until bm56, and
      `invoice-template/{page,loading,error}.tsx`. The GET handler is
      `…/versions/[versionId]/files/[file]/route.ts`.
    - Components: `InvoiceSettingsTabs`, `InvoiceStructureForm`,
      `InvoicePreviewFrame` (`sandbox=""` + `srcDoc`), `GeneratedHbsViewer`,
      `VersionHistoryTable` and `TemplateVersionStatusBadge`.
    - Nav: `NAV_REGISTRY` "Invoice Settings" (READ) after System Configuration,
      with the `FileText` icon. `invoice-template` is in the nav guard's
      `UNLISTED_BY_DESIGN`, and both pages are in the route manifest.
  - **Deviations (recorded):**
    1. **Generator follows the seeded layout v1 as authored (owner decision,
       2026-10-09).** Spec D1's sketch doesn't fit the immutable layout. The
       layout's partials self-wrap in `<section class="sec sec--{key} …">`, and
       it has no zones, no `pageTwoHeader` partial and no `row-2` markup. So
       the generator inserts partials in manifest order, indented at
       `[[body]]`. A half section widens only when its *layout pair partner* is
       hidden, so payment stays `sec--half` as stored. `colCount` counts all
       four optional columns (the spec formula gave 8; v1 renders 10), and
       `subtotalSpan = colCount − 2 − showDiscountColumn`. The formulas are in
       placeholder-catalog §C.
    2. **Parity is `<body>`-only.** The generated and stored v1 render a
       byte-identical `<body>` for `sample-data.json` (draft and issued) and a
       multi-page fixture. The `<head>` `<style>` differs because layout v1's
       shell has no bm49 usage-annex CSS. This is recorded as an `it.fails`
       case and as **known-issues §20 (OPEN — needs a layout v2 before
       bm58)**. Until then the sample and unposted-bill previews render the
       annex unstyled.
    3. **Error class.** `TEMPLATE_GENERATION_FAILED` and
       `MANDATORY_SECTION_HIDDEN` are `INVOICE_ERROR_CODES` thrown as
       `InvoiceRenderError`, not `AppError` (the bm51 rationale:
       `lib/errors.ts` is a closed HTTP union). Recorded in code-standards TS
       rule 7.
    4. **`buildInvoiceHtml`** (`render-invoice-template.ts`, outside the
       listed boundary) gains a draft-only `override` (structure + in-memory
       `load`), so the unposted-bill preview reuses the one binder pipeline
       instead of forking it. `preview-posted` now binds `isDraft: false`
       (spec D3: `isDraft: !posted`); it had no caller before bm55.
    5. **Extra files beyond the spec list:** the read service above;
       `pinnedVersionNo` on the action's ok result, which drives the "as
       issued" banner; and a `SEEDED_LAYOUT_ROW` plus the layout path mapping
       in `tests/helpers/seeded-invoice-template.ts`.
    6. **Annotate scope.** Placeholders inside `<style>`/raw-text elements are
       not wrapped (wrapping would break the CSS colours). A posted-bill
       preview is never annotated because its stored template is not
       regenerated; outline still applies.
    7. **Tabs in a layout** cannot see the path. With one tab it is always
       current; bm56 must pass `active` when it adds Company profile.
    8. The `FileText` nav icon (spec D6) is also GL Journal's.
  - **Tests (all new suites green):**
    - `generate.test.ts`, guardrail 48 (146): all 128 combinations compile
      under knownHelpersOnly/strict and execute. Each has no `[[`/`]]`/CR,
      no markup for hidden sections or columns (incl. the discount total),
      colspans that equal the formulas, and a header cell count equal to
      `colCount`. Also covered: pairing and widening on a synthetic layout,
      Zod and generator mandatory rejection, every
      `TEMPLATE_GENERATION_FAILED` case, annotate scope and escaping, LF
      determinism, canonical structure.json, and the client-bundle boundary.
    - `generate-parity.test.ts` (5 + 1 expected fail).
    - `preview-invoice-template.action.test.ts` (14). It runs through the real
      service, resolver, loaders and binder. Covered: READ allowed;
      FORBIDDEN; a `{ billId }` source without `billrun_view` is FORBIDDEN
      before any read; VALIDATION_ERROR ×4. A posted bill renders its stamped
      v1 with the structure ignored, and the current ACTIVE is never
      resolved. Also: unposted draft, NOT_FOUND, PREVIEW_FAILED with its
      code, the 30/60 s limit, and zero `putObject`/`putInvoice`/DML.
    - `tests/app/invoice-settings/files-route.test.ts` (14): 401 ×2, 403, 422
      ×4, 404 for unknown/layout/DRAFT, exact stored bytes for all three
      files plus headers, and a tampered blob → 500 with an empty body.
    - Component tests (23) and `invoice-settings-authz-matrix.test.ts`
      (guardrail 56 routes, 9). `nav-registry-guard` and `route-manifest`
      are green.
    - **Ripples fixed:** `tests/lib/nav-registry.test.ts` (the ADMIN map gains
      `invoice_settings`) and `status-literal-allowlist.ts` (the
      version-history row's `"RETIRED"`).
    - `tsc` is clean, and ESLint + Prettier are clean on every changed file.
      Full `npx vitest run --pool=threads --exclude ".claude/**"`: 3877
      passed. The failures are the **13 pre-existing tests in 5 files**
      recorded under bm53/bm54, plus two failures now fixed (the nav-registry
      ADMIN map and the status-literal allowlist). Two more were load-only
      effects that pass on their own: the `route-manifest` stale-reference
      scan hit its 10 s timeout under parallel load, and the 6 env-only files
      pass 6/6 (34 tests) with `.env` loaded.
  - **Not run here:** no browser or `next build` run of the pages (the
    client-bundle boundary is asserted by a source test, not a build). No
    DB/Azurite run: bm55 adds no SQL beyond two `SELECT`s on
    `customer_bill`, both mocked in the unit suites.
  - **Docs closed in this change set:** code-standards TS rule 7, file
    organization, the permission-map notes (index redirect target, the
    billrun_view check as built, the authz matrix home) and guardrail 48 as
    built; placeholder-catalog §C (the directive grammar, formulas and
    annotate rule); ui-context §10b (preview styles confirmed); the
    architecture boundary row (built note); known-issues §20; this tracker.
  - **Next:** seed layout v2 with the annex CSS (known-issues §20) before
    bm58; bm56 (Company profile, which reuses the shell, badge and history
    table and switches the index redirect).

### Invoice Template update — bm56 DELIVERED (code + tests + docs), unit suites RUN GREEN (2026-10-10)

- **bm56 — Company profile read page (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm56-company-profile-read-page.md`. A READ user sees the
  ACTIVE company profile (or an Info empty state), its logo, and its version history;
  `invoice.profile` is removed from the generic System Config page. No profile mutation, no
  migration, no grant change, no npm dependency. Depends on bm55, bm53.
  - **Delivered:**
    - `types/billing.ts`: `INVOICE_PROFILE_CONFIG_GROUP`, `INVOICE_PROFILE_META_KEYS` (D2),
      `ProfileHistoryRow`, `InvoiceProfileView`, `CompanyProfilePageModel`.
    - `db/repositories/billing/invoice-profile.ts`: `readVersion` now returns field rows only
      (`meta.*` split out so the strict schema never sees them); new `readVersionRaw`,
      `findVersionStatus`, `resolveUserNames`; `listVersions` also returns each version's `meta`
      and a used-by count (`count(*)` of `customer_bill.ref_invoice_profile_version`).
    - `services/billing/invoice-profile/read-profile.ts`: `getCompanyProfilePageModel` (shown
      version = `?version` ?? ACTIVE ?? DRAFT for EDIT users ?? `null`; a DRAFT is hidden from
      READ users in the form and the history; the unparsed field map is returned) and
      `getVerifiedLogo`. `services/billing/read/company-profile-settings.ts` binds `db` for the
      page and route (app code may not import `db`).
    - Pages: `company-profile/{page,loading,error}.tsx`; the logo GET handler
      `company-profile/logo/[assetVersionId]/route.ts` (401, 403, 422, 404; digest check, 500
      with no body on mismatch; stored MIME, inline, nosniff, sandbox CSP, no-store).
    - Components: `CompanyProfileForm` (`mode: 'read' | 'edit'`, only read wired; colour
      swatches are a 20x20 inline `<svg>` because inline `style` props are lint-banned) and
      `VersionHistoryTable` generalized with `kind="profile"` (no Layout column, no Default chip,
      no .hbs download, numeric `?version=`).
    - Shell: `InvoiceSettingsTabs` lists Company profile first and now requires `active`; the
      layout no longer renders the strip (it cannot see the path) — each page does. The index
      redirects to `company-profile`.
    - System Config (D4): `findAllNonSecret` excludes the group; `updateConfigValue` returns
      `GROUP_NOT_EDITABLE` (no write, no audit); the action union and edit dialog copy gain it.
  - **Deviations (recorded):** (1) the spec calls `VersionHistoryTable` "kind-agnostic", but
    bm55 built it template-specific, so it was generalized here with a `kind` prop instead of
    forking a second table. (2) The tab strip moved from the layout into the pages (bm55
    deviation 7 anticipated this). (3) `listVersions` ran two extra queries (all `meta.*` rows,
    per-version bill counts) rather than a joined aggregate. (4) "Created by" shows the
    appuser name of the most recently modified row, falling back to the id.
  - **Tests (all new suites green):** `read-profile.test.ts` (9), `logo-route.test.ts` (11),
    `company-profile-form.test.tsx` (10, incl. the profile history table),
    `system-config-exclusion.test.ts` (3, incl. the built WHERE clause), authz-matrix rows for the
    page and the logo route, nav-registry-guard (`UNLISTED_BY_DESIGN`), route manifest, and the
    updated tabs test. `tests/guardrails` + `tests/actions` (607 tests in 80 files) stay green.
    `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Not run here:** `tests/db/invoice-profile.integration.test.ts` (the repository's `meta`
    split, `listVersions` used-by count, `resolveUserNames`) needs the disposable Postgres and
    was not re-run; no browser or `next build` run of the new page.
  - **Docs closed in this change set:** code-standards data rule 5 (the `meta.*` keys), the
    file-organization tree, the permission-map notes (logo route, index redirect target,
    `GROUP_NOT_EDITABLE`); ui-context §10b (empty-state copy); this tracker.
  - **Next:** bm57 (Invoice template save draft), bm59 (profile edit mode + "Create a draft"),
    bm60 (logo upload), bm61 (activation writes `meta.*`). Known-issues §20 (layout v2) still
    precedes bm58.

### Invoice Template update — bm57 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres (2026-10-10)

- **bm57 — Invoice template: save draft (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm57-invoice-template-save-draft.md`. An
  `invoice_settings : EDIT` user saves the section/column choices as the single working
  DRAFT generated version. The server refuses READ users and any structure that hides a
  mandatory section, and every save writes one `INVOICE_TEMPLATE_DRAFT_SAVED` audit row in
  the same transaction. No activation, no blob write, no migration, no grant change, no npm
  dependency. Depends on bm55.
  - **Delivered:**
    - `types/audit.ts` + `types/audit-log.ts`: `INVOICE_TEMPLATE_DRAFT_SAVED` (Change).
      `types/billing.ts`: `TEMPLATE_DRAFT_ERROR_CODES` (`DRAFT_CONFLICT`,
      `MANDATORY_SECTION_HIDDEN`) and `TemplateDraftInfo`.
    - `db/repositories/billing/bill-template-version.ts`: `findDraft`, `insertDraft`,
      `updateDraftStructure` (returns the new token, or `null` on a conflict) and
      `findLatestDraftSaver` (newest audit actor for the draft).
    - `services/billing/invoice-template/save-template-draft.ts`: one transaction. The
      per-kind advisory lock comes first, then a re-parse, then insert or token-guarded
      update, then the audit row. A `23505` from `btv_one_draft_uq`/`btv_version_uq` maps to
      `DRAFT_CONFLICT`.
    - `actions/billing/invoice-settings/save-template-draft.action.ts`: EDIT guard first,
      then Zod (`MANDATORY_SECTION_HIDDEN` with the offending paths, otherwise
      `VALIDATION_ERROR`), the service, then `revalidatePath('/administration/invoice-settings',
      'layout')`. `validation/billing/invoice-template-structure.schema.ts` gains
      `saveTemplateDraftInputSchema`.
    - UI: `InvoiceStructureForm` has an outline **Save draft** (EDIT only, disabled while
      pristine or saving, keeps the live token between saves, Warning toast with Reload on a
      conflict, inline Danger text under a refused row). The page opens an EDIT user on the
      working DRAFT with the "Editing draft vN" banner and the draft token. The Generated
      .hbs tab shows an Info line for a DRAFT (it has no files). READ users never get the
      draft on the edit tab, and `?version=<draft>` falls back to the current version.
      `getInvoiceTemplatePageData(version, { canEdit })` returns `defaultShown` and `draft`.
  - **Deviations (recorded):**
    1. **The token is text, not a `Date`.** The spec says the draft's
       `last_modified_datetime` ISO string, but a JS `Date` truncates Postgres microseconds
       to milliseconds, so the stored value could never match. The token is produced and
       compared in SQL as `YYYY-MM-DDTHH24:MI:SS.USZ`, and the schema validates that shape.
    2. **The advisory lock is taken before the draft lookup**, so two concurrent first saves
       become one insert and one `DRAFT_CONFLICT` rather than a unique violation. The
       `23505` mapping stays as a backstop.
    3. **"Saved by {user}" comes from the audit log.** The table keeps only `created_by`, so
       the banner reads the newest `INVOICE_TEMPLATE_DRAFT_SAVED` actor.
    4. **The authz-matrix "no surface enforces EDIT" test** now covers the READ rows only; the
       save action is the first EDIT row.
    5. `DRAFT_CONFLICT` is a result code, not a thrown `InvoiceRenderError`, so it lives in
       `TEMPLATE_DRAFT_ERROR_CODES` (code-standards TS rule 7 updated first).
  - **Tests (all green):**
    - `save-template-draft.action.test.ts` (11): the EDIT guard, a READ user refused with
      nothing written, a hidden mandatory section posted directly, unknown keys and a bad
      token, success revalidating the layout, conflict and error mapping.
    - `tests/db/save-template-draft.integration.test.ts` (10, on the throwaway Postgres): the
      first save inserts DRAFT v2 with a structure and no files; a second save updates the
      same row; a stale token, a wrong belief about the draft's existence, and two concurrent
      first saves (looped 3x) give exactly one winner and one `DRAFT_CONFLICT`; one audit row
      per success with before/after; a hidden mandatory section writes nothing; the DRAFT is
      never resolved by `resolveTemplate`/`resolveVersionsForPosting`; the history lists it.
    - `invoice-structure-form.test.tsx` extended (+8), `invoice-template-settings.test.ts`
      (6, the draft/READ-user page data), authz-matrix rows plus an order/audit check,
      `audit-log-filters.test.tsx` (82 options; the new type is in the Change group), and the
      existing `audit-log` category-map test.
    - Full unit suite: 3994 tests, 12 failing, all the 15-vs-16 permission-count mismatch
      recorded in known-issues §21a. Full integration project: 1088 passed, 48 failed,
      the same 48 as before (known-issues §21), none touching bm57.
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Review fixes (2026-10-10, /code-review xhigh + CodeRabbit):**
    - **Reload after a conflict now reloads.** The form copied the draft token and structure
      into `useState` once, so `router.refresh()` left it stale and every later save
      conflicted again. The form `key` is now `{versionId}:{draft token}`, so a newer token
      (own save, or Reload) remounts it from the server data.
    - **A working draft can no longer be overwritten by accident (owner decision).** While a
      draft exists it is the only editable version; other versions open read-only with a note
      linking to the draft. Previously Save from the current version replaced the draft with
      that version's content under the draft's token.
    - **Generated .hbs tab** defaults to the current version again (a DRAFT has no files); an
      explicit `?version=<draft>` still shows the "no generated files yet" note.
    - **History:** a READ user gets no View link on a DRAFT row (it fell back silently).
    - `findLatestDraftSaver` is a LEFT join: a save by a since-deleted user reports "a deleted
      user" instead of an older saver. `lockKind` is now an explicit repository method taken
      before the draft lookup; `nextVersionNo` runs only on the insert branch. Only a 23505 on
      `btv_one_draft_uq`/`btv_version_uq` maps to `DRAFT_CONFLICT`; any other unique violation
      is a server error (real postgres.js error shape asserted on a real database).
    - bm56 follow-ups: `listVersions` filters `meta.%` in SQL; the logo checksum check is one
      `fetchVerifiedLogoBytes` helper shared by `inlineLogo` and `getVerifiedLogo`; the
      exclusion test pins the bound parameters instead of Drizzle's formatting; the code-standards
      logo-route pattern reads `^INVASV\d{8}$`. `invoice-profile.integration` was re-run green
      after the refactor.
    - **Left as is, for review:** "saved by" still comes from the audit log (a
      `last_modified_by` column would need a migration, out of bm57's scope), and the lookup
      stays in the billing repository (moving it to `audit.repository.ts` touches a platform-owned file).
  - **Not run here:** no browser or `next build` run of the page and form.
  - **Docs closed in this change set:** code-standards data rule 3 (one working draft per
    kind, the optimistic token) and TS rule 7 (`DRAFT_CONFLICT`); ui-context §10b (Save draft
    states); known-issues §21 (the failing tests found after bm56); this tracker.
  - **Next:** bm58 (activate the working draft; promotes it in place). Known-issues §20 (layout
    v2) still precedes bm58.

### Invoice Template update — bm58 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-10)

- **bm58 — Invoice template: activate (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm58-invoice-template-activate.md`. An
  `invoice_settings : EDIT` user activates the saved working draft with a required change note.
  The service generates `invoice.hbs`, `footer.hbs` and `structure.json`, test-renders them,
  writes them write-once with SHA-256 checksums to a content-addressed directory, then in one
  transaction retires the previous non-default ACTIVE, promotes the draft and audits. No
  migration, no grant change, no npm dependency. Depends on bm57, bm54. **bm52 must be deployed
  before this unit is released to prod.**
  - **Delivered:**
    - `types/audit.ts` + `types/audit-log.ts`: `INVOICE_TEMPLATE_ACTIVATED` (Change).
      `types/billing.ts`: `TEMPLATE_ACTIVATION_ERROR_CODES` (`CHANGE_NOTE_REQUIRED`,
      `ACTIVATION_BLOB_CONFLICT`). `validation/billing/activate-version.schema.ts`: the template
      input (`draftId`, `expectedDraftToken`, `changeNote` trimmed 1-500; an empty note carries
      the binding message `CHANGE_NOTE_REQUIRED`).
    - `db/repositories/billing/bill-template-version.ts`: `findDraftForUpdate`, `retireActive`
      (the non-default ACTIVE only) and `promoteDraft` (token-guarded; `null` on a guard failure).
    - `services/billing/invoice-template/activate-template.ts`: D2 steps 2-8. Steps 3-7 run
      outside any DB transaction; step 8 takes the kind lock, re-reads the draft FOR UPDATE,
      retires, promotes and audits. A guard failure inside it throws a private rollback error so
      the retirement is never committed. `directory = generated/INVOICE/v{n}-{digest12}/`.
    - `actions/billing/invoice-settings/activate-template.action.ts`: EDIT guard first, then
      Zod, service, `revalidatePath('/administration/invoice-settings', 'layout')`.
    - UI: `ActivateVersionDialog` (shared with bm61) and `structure-labels.ts` (the labels and
      `describeStructureChanges` diff, shared with the editor form). `InvoiceStructureForm` has an
      **Activate** button next to Save draft: "Activate v{n}" when a saved draft has no unsaved
      edits, "Save draft first" while there are edits, disabled with no draft. History captions:
      the non-default ACTIVE says "In use for new invoices" and the default says "Fallback" while
      one is in use.
  - **Owner decision (2026-10-10), a deviation from spec D4:** the spec put the Deep Petrol
    accent on the dialog's confirm button and kept it enabled with an empty note. ui-context §7
    says the opposite, and the owner chose ui-context §7: the page-level **Activate** trigger is
    the one Deep Petrol button, and the dialog's confirm button is the standard primary (indigo)
    button, **disabled until a change note is entered**. The server still enforces the note
    (`CHANGE_NOTE_REQUIRED`), but the UI never shows that message for an empty note. The decision is
    also recorded in the spec's D4.
  - **Other deviations (recorded):**
    1. **Dialog props.** The spec lists `title`, `summary`, `warning`, `onConfirm`; the dialog also
       takes `open`, `onOpenChange` and `confirmLabel` because the trigger lives in the form.
    2. **Error classes.** `TEMPLATE_CHECKSUM_MISMATCH`, `TEMPLATE_GENERATION_FAILED`,
       `TEMPLATE_COMPILE_FAILED` and `MANDATORY_SECTION_HIDDEN` keep their `InvoiceRenderError`
       codes and are returned as result codes. The two new codes are result codes, never thrown.
    3. **Guardrail 46 now uses real activations.** The generated v2 and v3 are made by the real
       save-draft and activate services. The versions differ in structure (v2 shows Notes, v3
       hides it), so the render shows which version ran; the marker-based assertions
       (`PIN-MARK-V2`, "Template v2" in the footer) are replaced by `sec--notes`. The company
       profile is still a DB fixture until bm61.
    4. **Status-literal allow-list.** `retireActive` writes the string `'RETIRED'`; it is added to
       `tests/guardrails/status-literal-allowlist.ts` like the bm55 history-table entry.
  - **Tests (all green):**
    - `tests/db/activate-template.integration.test.ts` (11, Postgres + Azurite): success (ACTIVE,
      content-addressed `blob_ref`, `loadGeneratedFiles` verifies the stored directory, no `[[`,
      one audit row, the next draft preview resolves it); a second activation retires v2 and
      leaves the default; **guardrail 53** (a failure injected after the blob write leaves the
      previous ACTIVE, the draft a DRAFT, the four orphan blobs, no audit row, and an identical
      retry succeeds); a stale token; an empty or blank note; a draft id that is not the working
      draft; a tampered layout blob; a layout that fails the test render; a different blob at the
      target path; and two concurrent activations (one wins, one `DRAFT_CONFLICT`).
    - `activate-template.action.test.ts` (21), `activate-version-dialog.test.tsx` (9),
      `structure-labels.test.ts` (3), the form's Activate states (+9), history captions (+2),
      authz-matrix rows plus an order/audit/write-once check, and `audit-log-filters` (83 options).
    - Guardrail 46 (`invoice-version-pinning.integration`) and the bm57 save-draft suite pass.
    - Full integration project: 1102 passed, 48 failed, the same 48 as before (known-issues §21),
      none touching bm58. Full unit suite: 12 failing, the known permission-count mismatch
      (known-issues §21a). Two other tests (`customer-module-boundaries`, `ratecard-parse-csv`)
      timed out once under full-suite load and pass when run alone.
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Review fixes (2026-10-10, /code-review xhigh on 735bbce):**
    - **Activation test-render now also runs the load-time probe.** Activation rendered only
      against the layout's `sample-data.json`, but `loadGenerated` executes the typed
      `PROBE_RENDER_INPUT` at first load. The two inputs differ (for example the sample has
      `company.tradingName`, the probe does not), so a template could pass activation, become
      ACTIVE, retire the previous version, then fail the load probe and park every render.
      `testRender` now executes the probe in the same variants, so both gates agree. A unit
      test proves a template the sample satisfies but the probe rejects is refused.
    - **Activate conflict now offers Reload.** After `DRAFT_CONFLICT` the form kept its stale token
      and every retry conflicted again. The form shows the same Warning toast with a **Reload**
      action as the save flow; the refresh remounts it on the newer token.
    - **Only the mandatory-section rule reports `MANDATORY_SECTION_HIDDEN`.** Any other failure of
      the stored structure (an unknown key, a missing column key) is `VALIDATION_ERROR`.
    - Success no longer calls a redundant `router.refresh()` (the action revalidates the layout and
      the form remounts on the new token, as the save flow relies on).
    - `parseSampleData` is one shared module (`sample-data.ts`), used by the preview and
      activation. `sha256` uses `blobStore.digest`, the `!` is gone, and the returned render
      codes come from one tuple, so the runtime guard and the result type cannot drift.
    - `getInvoiceTemplatePageData` takes a required `{ canEdit }` options object with **no default**.
      This reconciles the SonarQube finding (no object-literal default) with the review (a bare
      positional boolean on a permission gate hides its meaning at the call site).
    - Test safety: `assertTestBlobConnection` refuses to run the blob-deleting suites (activation
      and guardrail 46) against anything but the throwaway Azurite (port 10001); the dev stack's
      is 10000. Stale comments were corrected, and a stray backtick in code-standards data rule 7.
    - **Left as is, for review:** (1) known-issues §20 (layout v1 has no usage-annex CSS): **owner
      decision 2026-10-10, accept for now and track as a release gate**, no bm58 code change (see
      the entry). (2) The four blob PUTs stay sequential (a few extra round trips, with
      `checksums.json` last as the commit marker); parallelising was judged not worth the change.
      (3) The Deep Petrol button class is copied from `trigger-run-dialog.tsx`; extracting a shared
      button touches another module's component and is cosmetic, so it was only flagged.
      (4) The canonical `checksums.json` form still exists in two places (`write-checksums.ts` and
      the activation service); sharing it would mean refactoring a dev script, which is out of scope.
  - **Not run here:** no browser or `next build` run of the page and dialog; a real posting
    after a real activation is covered only through guardrail 46.
  - **Docs closed in this change set:** code-standards data rule 7 (the content-addressed
    `v{n}-{digest12}` path) and TS rule 7 (`CHANGE_NOTE_REQUIRED`, `ACTIVATION_BLOB_CONFLICT`);
    architecture storage row; ui-context §10b (Activate states); the bm58 spec's D4 note; this
    tracker.
  - **Next:** bm59 (profile edit mode and "Create a draft"). Known-issues §20 (layout v2 with the
    annex CSS) is still open and should land before real activations reach production.

### Invoice Template update — bm59 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres (2026-10-10)

- **bm59 — Company profile: save draft (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm59-company-profile-save-draft.md`. An
  `invoice_settings : EDIT` user edits the company profile and saves it as the single working
  DRAFT version of `invoice.profile` (one row per field key), validated against the
  placeholder-catalog formats in the form and on the server, audited as
  `INVOICE_PROFILE_DRAFT_SAVED` in the same transaction. No activation, no logo upload (bm60), no
  migration, no grant change, no npm dependency. Depends on bm56.
  - **Delivered:**
    - `types/audit.ts` + `types/audit-log.ts`: `INVOICE_PROFILE_DRAFT_SAVED` (Change).
      `types/billing.ts`: `ProfileDraftInfo`, `CompanyProfilePageModel.draft`,
      `INVOICE_PROFILE_FIELD_LABELS` (form labels and the rows' `description`).
    - `validation/billing/invoice-profile.schema.ts` (D2): `invoiceProfileFieldsSchema`,
      `invoiceProfileDraftSchema` (`.partial()`), `invoiceProfileSchema` (fields + logo), the
      shared `normalizeInvoiceProfileDraftInput`, `INVOICE_PROFILE_FIELD_KEYS` and
      `saveProfileDraftInputSchema` (fields + the bm57 token shape). Field-level messages
      ("TIN is 1–2 letters then 10–11 digits…") so the form and the server show the same text.
    - `db/repositories/billing/invoice-profile.ts` (D1): `lockProfileGroup` (advisory lock on
      `core.system_config:invoice.profile`), `nextProfileVersion` (`max + 1` over the whole
      group), `findDraftVersion` (version + token = `max(last_modified_datetime)` at microsecond
      precision), `insertDraftVersion` (every key, blanks `NULL`, `is_secret = false`, label as
      description) and `updateDraftFields` (one `UPDATE … FROM (VALUES …)` guarded by the token in
      the same statement). `DRAFT_TOKEN_FORMAT` is now exported from the template repository and
      shared.
    - `services/billing/invoice-profile/save-profile-draft.ts`: one transaction — lock → re-parse
      → insert at `max + 1` or update only the changed keys under the token → one audit row
      (`targetEntity: 'SYSTEM_CONFIG'`, `targetId: 'invoice.profile:v{n}'`, changed keys only in
      before/after on an update; bank details included). A `23505` on
      `system_config_group_version_key_unique` maps to `DRAFT_CONFLICT`.
    - `actions/billing/invoice-settings/save-profile-draft.action.ts`: EDIT guard → Zod (field
      errors keyed by profile field) → service → `revalidatePath(…, 'layout')`.
    - UI (D3): `CompanyProfileEditForm` (`'use client'`, RHF + `zodResolver(invoiceProfileDraftSchema)`
      after the shared normaliser; `Field`/`Input`/`Select`), rendered by `CompanyProfileForm
      mode="edit"`. State `Select` of the 16 codes, Country read-only `MY`, mono colour inputs with
      a live swatch and the < 4.5:1 Warning hint (`lib/colour-contrast.ts`), SST hint, outline
      **Save draft** (pristine-disabled), success toast, conflict toast with **Reload**, server
      field errors mapped onto fields. `ColourSwatch` is shared by read and edit modes. The page
      opens EDIT users on the DRAFT (bm57-style "Editing draft v{n}" line), else the ACTIVE values,
      else empty fields under the empty-state alert, whose **Create a draft** button now renders
      and focuses the first field. The form remounts per `{version}:{draft token}`.
  - **Deviations / interpretations (recorded):**
    1. **The ACTIVE logo is carried into a new draft.** D1 says a new draft stores "the submitted
       values", but the form never sends `logo_asset_version_id`; storing `NULL` would silently
       drop the ACTIVE logo from every new draft and force a re-upload before bm61 activation. The
       first save copies the ACTIVE version's logo id (D1 "the copy is made only on first save").
    2. **The group lock is taken before the draft lookup** (the bm57 deviation 2), so two
       concurrent first saves are one insert and one `DRAFT_CONFLICT`; `nextProfileVersion` re-takes
       it. The `23505` mapping stays as a backstop.
    3. **While a draft exists it is the only editable version** (the bm57 owner decision applied
       to the profile): a RETIRED or ACTIVE version opened with `?version=` is read-only with an
       "Edit draft v{n}" link, and an explicit retired version is never editable.
    4. **Shown version for EDIT users is now DRAFT ?? ACTIVE** (bm56 had ACTIVE ?? DRAFT), per D3.
       READ users are unchanged.
    5. **Normalisation is a function, not schema transforms**, so `invoiceProfileDraftSchema` stays
       exactly `invoiceProfileFieldsSchema.partial()` and the render-time read keeps rejecting a
       hand-edited lower-case TIN.
    6. A save with no changed keys still writes one audit row (empty `fields` maps) and keeps the
       token; the form disables Save while pristine, so only a crafted request reaches it.
  - **Tests:**
    - `tests/db/save-profile-draft.integration.test.ts` (11, throwaway Postgres): first save
      inserts all 23 keys at v2 as DRAFT with `modified_by`, labels, `NULL` blanks and the ACTIVE
      logo; the token is the rows' `max(last_modified_datetime)`; a second save updates only the
      changed keys (by `last_modified` and `modified_by`); a stale token and both wrong
      beliefs about the draft are `DRAFT_CONFLICT` with nothing written; two concurrent first saves
      (looped 3x) allocate one version; one audit row per save with changed-key before/after; an
      invalid value writes nothing; `findActiveVersion` never returns the DRAFT; the generic System
      Config page still hides the group; the real `23505` shape is recognized.
    - `invoice-profile.schema.test.ts` (+guardrail 51 format half): blanks accepted; invalid TIN,
      SST, postcode, SWIFT, emails, website, colours, state code, JomPAY, account no., terms > 120
      and over-length rejected; normalisation; `.strict()` rejects the logo and `meta.*`.
    - `save-profile-draft.action.test.ts` (10): READ → `FORBIDDEN` with nothing written; invalid
      values → `VALIDATION_ERROR` keyed by field; logo/`meta.*` refused; bad token; normalised
      payload to the service; conflict and throw mapping; revalidation.
    - `company-profile-form.test.tsx` (+17 edit mode): client-side rejection shows the **server
      schema's own message** for nine formats with nothing sent; contrast hint; live swatches; SST
      hint; save payload (raw values, token, no logo) and toast; conflict + Reload; server field
      errors; Create a draft focus.
    - `read-profile.test.ts` (DRAFT first for EDIT users, draft info), authz-matrix row + an
      order/audit check + the page's editable/key rule, `audit-log-filters` (84 options).
    - Full integration project: **1179 passed, 0 failed** (124 files, 75 skipped), 398 s. Full
      unit suite: 4144 passed, 2 failed — both 10 s timeouts in repo-wide scans
      (`route-manifest`, `pricing-component-guardrails`) while the integration run shared the
      machine; both pass alone.
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Not run here:** no browser or `next build` run of the edit form.
  - **Docs closed in this change set:** G7/O3 recorded as decided in the overview open items,
    architecture "Other open items" and code-standards TS rule 5 (the AI workflow rules already had
    it); code-standards TS rule 5 (draft vs activation schemas, the shared normaliser); ui-context
    §10b (profile Save draft, Create a draft); this tracker.
  - **Next:** bm60 (logo upload onto the draft), bm61 (profile activation, writes `meta.*`).

### Invoice Template update — bm60 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-10)

- **bm60 — Company profile: logo upload + sanitization (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm60-company-profile-logo-upload.md`. An
  `invoice_settings : EDIT` user uploads the invoice logo onto the working draft profile: checked
  server-side in order (size ≤ 500 KB → magic bytes = declared MIME → shorter side ≥ 300 px via
  pure PNG/JPEG/SVG parsers → SVG content policy, reject never repair), stored write-once at a
  content-addressed path in `invoice-assets` as a new `bill_asset_version`, the draft pointed at
  it, and one `INVOICE_LOGO_UPLOADED` audit row. No migration, no grant change, no new dependency
  (no `sharp`). Depends on bm59, bm51; bm52 deployed before the prod release.
  - **Delivered:**
    - `types/audit.ts` + `types/audit-log.ts`: `INVOICE_LOGO_UPLOADED` (Additive).
      `types/billing.ts`: `LOGO_UPLOAD_ERROR_CODES` (`LOGO_REJECTED`), `LogoRejectReason`
      (`size | mime | dimensions | svg_content`), `LOGO_MIME_TYPES`, `LOGO_MAX_BYTES = 512000`,
      `LOGO_MIN_SIDE_PX = 300`, `CompanyProfilePageModel.hasLogoAsset`.
    - `services/billing/invoice-profile/image-dimensions.ts` (D2 check 2 + D3): `detectImageType`
      (PNG/JPEG magic; SVG = strict UTF-8 whose root after BOM, `<?xml?>`, comments and a DOCTYPE is
      `<svg`), `pngDimensions` (IHDR first chunk), `jpegDimensions` (bounded marker walk to the first
      SOFn), `svgDimensions` (unitless/`px` width+height, else viewBox). Pure, bounds-checked, typed
      results, no throw.
    - `sanitize-logo.ts` (D4): `findSvgViolation` returns the earliest offending construct; nothing
      is stripped.
    - `upload-logo.ts`: `checkLogo` (the four checks in data rule 9 order), `uploadLogo` (D5/D6:
      `ensureLogoAsset` in its own short transaction → `putObject('invoice-assets',
      '{INVAST}/sha256-{digest12}/logo.{ext}', …, writeOnce + returnExisting + sha256)`, a digest
      mismatch → `ACTIVATION_BLOB_CONFLICT` → one transaction: `insertVersion` → `setDraftLogo` →
      audit), and `importAppLogo` (D8).
    - Repositories: `billAssetRepository.findLogoAsset`, `ensureLogoAsset` (advisory lock
      `billing.bill_asset:logo`), `insertVersion` (lock `billing.bill_asset_version:{INVAST}`,
      `max + 1`, ACTIVE, sha256); `invoiceProfileRepository.setDraftLogo` (profile group lock, then
      the token-guarded `updateDraftFields` on `logo_asset_version_id`).
    - `actions/billing/invoice-settings/upload-logo.action.ts`: `uploadLogoAction(FormData)` and
      `importAppLogoAction({ expectedDraftToken })`, one shared EDIT guard first, then Zod
      (`validation/billing/logo-upload.schema.ts`; a declared type outside the three is
      `LOGO_REJECTED: mime`), the service, and `revalidatePath` on success. `bodySizeLimit` unchanged.
    - UI: `LogoUploadField` (D7) in the edit form's Branding group: dropzone + keyboard "Choose
      file", client pre-check (fast feedback only), inline Danger reason, preview via the GET route,
      Warning toast + Reload on a conflict, "Use the current app logo" while no logo asset exists.
  - **Deviations / interpretations (recorded):**
    1. **SVG detection skips a leading `<!DOCTYPE …>`.** D2 lists only BOM, whitespace, `<?xml?>`
       and comments, but then a DOCTYPE'd SVG would be `mime`, and D4's `<!DOCTYPE` rule and the
       guardrail-52 case could never fire. Skipping it in detection lets `svg_content` name it.
    2. **An SVG width/height in another unit is refused even when a viewBox exists** (D3's "units
       other than px/unitless → dimensions"). So the shipped `public/brand/logo.svg` (`918pt` ×
       `612pt`, plus a DOCTYPE) is refused by the D8 import as `dimensions`; D8 anticipates such a
       rejection.
    3. **Fail fast before the blob write:** the service checks the draft token before
       `ensureLogoAsset`/`putObject`, so a missing or stale draft leaves no orphan blob; the
       transaction still re-checks under the lock. A failure there throws a private sentinel so the
       version row rolls back, then maps to `DRAFT_CONFLICT`.
    4. **The upload is disabled while the form has unsaved edits** ("Save your changes first.").
       The upload bumps the draft token and the page remounts the form on it, which would drop the
       unsaved edits.
    5. **D8 import** lives in the same action file; the path is `getBrandingLogo().src` (default
       `/brand/logo.svg`), re-checked to stay under `public/brand/`; a missing or unreadable file is
       the new result code `APP_LOGO_UNAVAILABLE`.
    6. Sizes are computed in KiB (bytes ÷ 1,024) but labelled "KB", so the 512,000-byte cap displays as "500 KB" (the spec's figure).
    7. Architecture Inv #48 said "stripped or rejected"; reworded to "rejected, never stripped" to
       match D4 and data rule 9.
    8. The no-image-library guardrail scans `services`, `actions`, `app`, `lib` and `components`
       (the spec names the first three) and checks `package.json`.
  - **Tests (all green):**
    - `upload-logo.test.ts` (**guardrail 52**, 34): `size` (> 500 KB, 0 bytes; exactly 500 KB
      passes), `dimensions` (< 300 px PNG, JPEG, SVG; mm units), `mime` (PNG declared SVG, SVG
      declared PNG, GIF, text), `svg_content` (script, onload, onclick, foreignObject, iframe, embed,
      object, external href, `xlink:href="http…"`, external `<image>`, `url(http…)`, `javascript:`,
      `data:`, `@import`, `<style>` with `url(`, DOCTYPE + ENTITY), fragment-only references accepted,
      check order (oversized SVG with a script → `size`; tiny SVG with a script → `dimensions`),
      nothing written on any rejection; the stored path, call order and audit payload; draft and blob
      conflicts.
    - `image-dimensions.test.ts` (42): happy paths, truncated buffers, bogus IHDR, no SOF, DHT,
      bad segment lengths, SVG `%`/`em`/`mm`/`pt`, missing/broken viewBox, quoted `>` in attributes.
    - `tests/db/upload-logo.integration.test.ts` (6, Postgres + Azurite): no draft →
      `DRAFT_CONFLICT`, nothing stored; a valid PNG → INVAST/INVASV rows, exact bytes at the
      content-addressed path, digest verified, served by `getVerifiedLogo`, draft pointed, one audit
      row; re-upload → version 2 over the same blob; stale token; a DB failure after the blob write
      → orphan blob, no row, no audit, draft unchanged; a rejected file stores nothing.
    - `upload-logo.action.test.ts` (10): READ → `FORBIDDEN` with nothing written; a 4.9 MB body →
      `size`; a GIF → `mime`; bad FormData; the D8 import (READ refused, the shipped brand logo
      refused, a path outside `/brand/` → `APP_LOGO_UNAVAILABLE`).
    - `logo-upload-field.test.tsx` (13), `no-image-library.test.ts` (3), authz-matrix row + an
      order/write-once check, `audit-log-filters` (85 options), `read-profile.test.ts`
      (`hasLogoAsset`).
    - Full integration project: **1185 passed, 0 failed** (125 files), 404 s, on a fresh cluster. A
      first full run had 12 failures in `billrun-db-roles` and `rating/grants` (`role "app_runtime"
      is not permitted to log in`): a pre-existing file-order hazard, now known-issues **22f**. Both
      suites pass on a fresh cluster. Full unit suite: 4248 passed, 2 failed, both 10 s timeouts
      under load (`route-manifest`, `ratecard-parse-csv`) that pass alone.
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Not run here:** no browser or `next build` run of the upload field.
  - **Docs closed in this change set:** bm00 (the remaining "checked with `sharp`" line; the
    stack-additions row was already corrected); code-standards data rule 7 (asset path
    `{INVAST}/sha256-{digest12}/logo.{ext}`), data rule 9 (pure parsers, the full SVG policy, the
    reason order) and TS rule 7 (`LOGO_REJECTED` reasons and detail); architecture platform delta
    (first upload, built) and Inv #48 wording; workflow rules §6.13 (`sharp` is not a dependency);
    ui-context §10b (logo upload); known-issues 22f; this tracker.
  - **Next:** bm61 (profile activation; requires the logo, writes `meta.*`).

### Invoice Template update — bm61 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-10)

- **bm61 — Company profile: activate (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm61-company-profile-activate.md`. An `invoice_settings : EDIT`
  user activates the working draft profile with a required change note; refused without a logo,
  without a note, with an incomplete or invalid profile, or with a logo that fails its checksum.
  The DRAFT becomes ACTIVE and the previous version RETIRED in one audited transaction
  (`INVOICE_PROFILE_ACTIVATED`). **G14 decided 2026-10-10 (owner): option C** — a second EDIT
  user only when payment fields change (`PROFILE_FOUR_EYES_VIOLATION`). No migration, no grant
  change. Depends on bm59, bm60, bm54.
  - **Delivered:**
    - `types/audit.ts` + `types/audit-log.ts`: `INVOICE_PROFILE_ACTIVATED` (Change).
      `types/billing.ts`: `PROFILE_ACTIVATION_ERROR_CODES` (`CHANGE_NOTE_REQUIRED`,
      `DRAFT_CONFLICT`, `PROFILE_LOGO_REQUIRED`, `ASSET_CHECKSUM_MISMATCH`,
      `PROFILE_FOUR_EYES_VIOLATION`), `INVOICE_PROFILE_PAYMENT_KEYS`,
      `CompanyProfilePageModel.activeFields`. `validation/billing/activate-version.schema.ts`:
      `activateProfileInputSchema` (D1).
    - `lib/invoice-profile-changes.ts`: `paymentFieldsChanged` (the one definition of a bank
      change, used by the four-eyes check and the dialog's warning) and `describeProfileChanges`
      (`label: old → new`).
    - `db/repositories/billing/invoice-profile.ts`: `findDraftTokenForUpdate` (`FOR UPDATE` of the
      draft rows), `retireActiveVersion` (every ACTIVE row of the group), `promoteDraftVersion`,
      `writeMeta` (upsert of the `meta.*` rows with the version's status) and `findLastSaver`;
      `listVersions` now ignores `meta.*` rows for "created by", so the history keeps naming the
      editor, not the activator.
    - `services/billing/invoice-profile/activate-profile.ts`: the D2 checks in order (note → draft
      and token → logo set and ACTIVE → full `invoiceProfileSchema` with field errors → logo blob
      verified through `readInvoiceProfile` + `inlineLogo`), then the G14 option C check, then one
      transaction (group lock → token re-check under `FOR UPDATE` → retire + `meta.retired_at` →
      promote + `meta.change_note/activated_by/activated_at` → one audit row with
      `bankDetailsChanged`).
    - `actions/billing/invoice-settings/activate-profile.action.ts`: EDIT guard → Zod (blank note →
      `CHANGE_NOTE_REQUIRED`) → service → `revalidatePath`.
    - UI: a Deep Petrol **Activate v{n}** on the working draft only ("Save draft first" while dirty)
      opening `ActivateVersionDialog` with the field diff, the D5 bank warning and the server's
      message; `PROFILE_LOGO_REQUIRED` also shows inline by the logo field (`LogoUploadField`
      gains `externalError`).
  - **Decisions / interpretations (recorded):**
    1. **G14 = option C** (owner, 2026-10-10), recorded in the overview, architecture, code-standards
       §8 and TS rule 7, workflow rules §5, bm00 and the spec (A/B removed).
    2. **The first activation counts as a bank change.** With no ACTIVE version every payment
       field is new (it sets the account customers pay into), so the first profile also needs a
       second EDIT user. A single-admin installation cannot activate its first profile alone.
    3. **The logo uploader counts even for a carried-over logo.** D6 compares the actor with the
       draft's logo `created_by`; a draft that inherited the ACTIVE logo (bm59) inherits its
       uploader, so a bank change by that uploader also needs a second user.
    4. **Codes follow the bm61 spec's D2, not bm00's `INVOICE_PROFILE_INVALID`.** An invalid draft
       is refused with `VALIDATION_ERROR` + field errors, a missing/non-ACTIVE logo asset with
       `PROFILE_LOGO_REQUIRED`, a bad or missing logo blob with `ASSET_CHECKSUM_MISMATCH`. bm00 is
       updated. This satisfies **DR-01 option A** (no invalid version can become ACTIVE), so DR-01
       is removed from `billmgmt-design-review.md`.
    5. **Retire every ACTIVE row of the group**, not only the newest version, so a hand-edited
       second ACTIVE version cannot survive an activation; `meta.retired_at` is written on each.
    6. A conflict shows both a Warning toast with Reload and the dialog's inline message, as bm58
       does (known-issues 22d).
  - **Tests (all green):**
    - `tests/db/activate-profile.integration.test.ts` (**guardrail 51, activation half**, 9,
      Postgres + Azurite): no logo, blank note, missing required fields (named), stale token and
      wrong version, a tampered logo blob — each refused with nothing changed (rows, statuses,
      audit count); G14 C: the first activation refused for its editor and for its logo uploader,
      accepted from another EDIT user; success writes ACTIVE, `meta.*` and one audit row with
      `bankDetailsChanged: true`; a second activation retires v1 (+ `meta.retired_at`), a non-bank
      change is activated by its own editor (`bankDetailsChanged: false`), the history still names
      the editor; a bank change refused for its editor then accepted from another user; an invalid
      draft leaves the previous ACTIVE untouched (DR-01).
    - Guardrail 46 (`invoice-version-pinning.integration`, 5): profile v1 and v2 are now **real**
      activations (save draft → decodable logo upload → activate by a second user). Profile v1 is
      RETIRED when v2 activates; A keeps profile v1, its PDF bytes and checksum; the parked twin
      renders with v1; the next draft preview shows the v2 company, the v2 bank account and the v2
      logo inlined; **the next posting (account C) stamps profile 2**.
    - `activate-profile.action.test.ts` (13), `invoice-profile-changes.test.ts` (11),
      `company-profile-form.test.tsx` (+8: Activate only on the draft, "Save draft first", the
      diff, the bank warning only on a payment change or first activation, payload + toast, the
      four-eyes message, `PROFILE_LOGO_REQUIRED` twice), `read-profile.test.ts` (`activeFields`),
      authz-matrix row + an order check (four-eyes before the transaction, retire before promote,
      one audit, no blob write), `audit-log-filters` (86 options), status-literal allow-list (+2
      `RETIRED` entries, as bm58 did).
    - Full integration project: **1195 passed, 0 failed** (126 files), 461 s. Full unit suite:
      4281 passed; the 3 failures were the status-literal sweep (fixed above) and two 10 s timeouts
      under load (`customer-module-boundaries`, `pricing-component-guardrails`) that pass alone.
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Not run here:** no browser or `next build` run of the Activate button and dialog.
  - **Docs closed in this change set:** G14 in the overview, architecture (Noted gap → decided),
    code-standards §8 (the four-eyes line and the permission table) and TS rule 7
    (`PROFILE_FOUR_EYES_VIOLATION`), workflow rules §5; bm00 (G14 row, Unit 61, codes); the spec
    (banner removed, D6 = option C); design-review DR-01 removed (closed); ui-context §10b (profile
    Activate); this tracker.
  - **Review fixes (2026-10-10, bm59–bm61):**
    1. `findLastSaver` excludes the `logo_asset_version_id` row. A logo upload by user B used to
       make B the "last saver", so the field editor A could activate their own bank change. New
       integration case: A saves, B uploads → both refused.
    2. The `MY` `country_code` default moved from the fields schema to `invoiceProfileSchema`, so a
       draft save (`.partial()`) no longer fills an omitted `country_code`.
    3. The form clears the inline `PROFILE_LOGO_REQUIRED` error when an activation starts and after
       a successful save. The state codes now sort with `localeCompare`.
    4. Docs: the code-standards §8 line that said four-eyes never applies to activation now matches
       G14 C; workflow rules §5 moves G14 to the decided list.
    5. Not changed: the SVG `on*` rule stays a whole-text match. It fails closed (a false positive
       is a rejection, never a bypass), and a tag-aware regex would add bypass and backtracking
       risk.
  - **Code-review fixes, Moderate + cleanup (2026-10-10, bm59–bm61):**
    1. Profile schema: a missing required key now says "Required" (`z.string("Required")`), not
       Zod's raw "expected string, received undefined", so activation's field errors read well.
    2. SVG policy: `url('#g')`, `url( #g)`, `href=" #a"` and `href= "#a"` are fragment
       references and are accepted (the old lookahead could backtrack onto the quote or a space);
       quoted/spaced external references are still rejected.
    3. `updateDraftFields` checks the token first, then inserts any changed key with no row in the
       stored draft (it was silently dropped, or a false `DRAFT_CONFLICT` when it was the only
       change).
    4. `hasLogoAsset` is now `billAssetRepository.hasLogoVersion` (a logo asset WITH a version): a
       failed first upload leaves an empty `bill_asset` row that no longer hides the D8 import.
    5. A logo side above int4 (`bill_asset_version.width/height`), or an infinite SVG size, is
       `LOGO_REJECTED: dimensions`, not a failed insert after the blob write.
    6. Cleanup: the save/upload/import actions log service failures (as activation does); the
       page model runs its independent reads together and reuses the ACTIVE raw read; activation
       verifies the logo with the rows already read (`parseInvoiceProfile` + `inlineLogo`); one
       `DRAFT_CONFLICT_MESSAGE` (`draft-messages.ts`), one `HEX_COLOUR_RE` (`types/billing.ts`),
       one `DraftConflict` (`draft-conflict.ts`).
    7. Open, awaiting the owner: the app-logo import fallback when `app_logo_path` is blank, and
       whether a no-op save writes an audit row; the four Serious findings (SVG regex
       backtracking, four-eyes by field saver, namespaced SVG elements, carried-over logo
       uploader). **Resolved 2026-10-11, below.**
    - Tests: related unit suites 1,902 passed; profile/logo integration 46 passed (Postgres +
      Azurite); `tsc`, ESLint and Prettier clean.
  - **Code-review fixes, Serious + owner decisions (2026-10-11, bm60/bm61):**
    1. **G14 re-decided by the owner: no four-eyes on profile activation** (supersedes option C).
       Removed `PROFILE_FOUR_EYES_VIOLATION`, the service check, `findLastSaver`, the form message
       and their tests; Serious #2 (saver vs field editor) and #4 (carried-over logo uploader) are
       moot. Kept: the bank-change warning and `bankDetailsChanged` on the audit row (one
       definition, `lib/invoice-profile-changes.ts`). Origin, for the record: the original plan
       said four-eyes "does not apply" (code-standards §8); the architecture _Noted gap_ (bm47
       docs, 2026-10-08) raised it as G14, decided C on 2026-10-10, reverted 2026-10-11. Docs:
       overview, architecture, code-standards §8 + TS rule 7, workflow rules §5, ui-context,
       bm00, bm61 D6.
    2. **SVG scanner (Serious #1):** `sanitize-logo.ts` is a hand-written linear scanner (no
       backtracking regexes). Crafted ~500 KB inputs scan in < 40 ms (the old regexes took ~100 s).
       Same construct names and earliest-construct order; a differential fuzz of 300,000 random
       documents against the old regexes showed no case the scanner accepts that they rejected.
    3. **Namespaced elements (Serious #3):** elements match by local name too, so `<s:script>`,
       `<svg:SCRIPT>`, `<x:foreignObject>`, `<s:use x:href=…>`, `<s:style>` are rejected.
    4. **#10 (owner):** `public/brand/invoice-logo-default.svg` added as a placeholder (an exact
       copy of `brand/logo.svg`); the D8 import falls back to it when no app logo is configured.
    5. **#11 (owner):** a save that changes no key of the existing draft writes nothing and no
       audit row; the result carries `changed: false` and the form shows the Info toast "No
       changes — nothing was saved." (bm59 D4 + checklist, ui-context).
    - Tests: related unit suites 1,937 passed; profile/logo integration 46 passed (Postgres +
      Azurite); `tsc`, ESLint and Prettier clean.
  - **Code-review fixes, batch 2 (2026-10-11):** SonarQube flagged super-linear regexes in
    `image-dimensions.ts` (SVG root attributes, width/height length). Replaced by a linear
    attribute scanner + `parseLength`; fuzzed identical to the old regexes (200k tags, 300k
    lengths); crafted 500 KB root tags parse in < 30 ms. bm00 status line restates G14 as "no
    four-eyes (2026-10-11, superseding option C)". Logo unit suites 197 passed.
  - **Logo size cap (2026-10-11, owner):** no logo side above `LOGO_MAX_SIDE_PX = 2000`
    (`dimensions`, detail `maxSidePx`) — a decompression-bomb guard for the Chromium invoice
    render; it replaces the int4-only bound. Upload field caption and message updated; bm60 D3,
    code-standards data rule 9, ui-context. A stricter root-tag / `400 px` check was tried and
    dropped (beyond spec, no service benefit). Billing unit suites 1,328 passed.
  - **Next:** bm62 / bm63 per the build plan (bm63's journey activates profile v1 then v2).

### Invoice Template update — bm62 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-11)

- **bm62 — Invoice CSV output (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm62-invoice-csv-output.md`. A `billrun_view : READ` user
  downloads a posted bill's invoice as CSV from its stamped, checksum-verified CSV column map:
  `services/billing/invoice-template/invoice-csv.ts` (`buildInvoiceCsv` + path resolver),
  `GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv`, and a **Download CSV** link in
  `invoice-preview-modal.tsx`. No migration, no grant change, no blob write, no audit. Gate check:
  G12 recorded as decided and delivered (bm50). Depends on bm53 (`loadCsvMap`) and bm54 (the stamp).
  - **Delivered:**
    - `services/billing/invoice-template/invoice-csv.ts`: `getPostedInvoiceCsv` (D1: one
      repeatable-read, read-only snapshot → bill must carry `ref_inv_document_id` else
      `FinalInvoiceNotFoundError` → `resolveTemplate({ kind: 'final' })` → raw read with
      `includeUsage: false` → the stamped profile parsed without inlining the logo; then
      `loadCsvMap` + `bind(isDraft: false)` outside the transaction; rows sorted by `line_no`);
      `buildInvoiceCsv` (pure, D2/D3) and `resolveCsvPath` (own-property dotted lookup; unknown,
      `null` or non-scalar → empty cell).
    - Formula safety reuses the bm02 helper **`lib/csv.ts` `csvField`** (no second escaper): a
      plain decimal (`^-?\d+(\.\d+)?$`) is emitted as-is, every other cell (headers included) goes
      through `csvField`. BOM + CRLF come from lookup tables keyed by `map.encoding` /
      `map.lineEnding`; anything else is `TEMPLATE_COMPILE_FAILED`.
    - D3: the emitted cells of the `line.netAmount` column are compared, as a sorted string
      multiset (explicit code-unit comparator), with the lines' `netAmount` strings; a mismatch is a
      CSV-code defect, a plain error the route logs as 500 (review fix 2026-10-11; it was
      `INVOICE_RECONCILIATION_FAILED`, which the route answered as the bill's 409). The pipeline also
      checks one CSV row per `customer_bill_line` (`rows.length === raw.lines.length`). A map with no
      `line.netAmount` column is `TEMPLATE_COMPILE_FAILED`.
    - `load.ts`: `csvColumnMapSchema` paths must be dotted identifiers rooted in `CSV_PATH_ROOTS`
      (the `InvoiceRenderInput` keys + `line`), so an unknown root fails at load.
    - `invoiceRenderInputRepository.readBillStamps` also returns `refInvDocumentId` (the posted
      check); the two test mocks of it updated.
    - Route (D4): session → `BILLRUN_VIEW : READ` → ID schemas (**422** on a bad shape, unlike the
      sibling routes' 404, per the spec) → rate limit (the stored-invoice route has none, so the
      draft limiter's 10 / 60 s, key `invoice-csv:${userId}`) → 200 `text/csv; charset=utf-8`,
      `attachment; filename="{INV}.csv"`, `nosniff`, `no-store`. 404 unknown/unposted, 409
      `INVOICE_RECONCILIATION_FAILED`, any other error (checksum mismatch included) logged and
      answered 500 with no body.
    - UI (D5): `StoredInvoiceModal` shows an outline **Download CSV** link next to the PDF
      Download once the stored invoice is retrieved; the draft preview has none.
  - **Interpretations (recorded):**
    1. "On the `ci` seed" is met with the bm53 posted-bill fixtures (`setupInvoiceRenderFixtures`),
       as guardrail 46 does: this environment has no workflow engine to produce a `ci` run's bills.
    2. Rows are sorted by `line_no` after the `flatMap`, so the Inv #21 order holds even if the
       source groups' line numbers interleave.
    3. **DR-02 (design review) left open.** `resolveTemplate` still resolves every kind; bm62 uses
       it as the spec's D1 says. The split resolution remains an owner decision.
  - **Tests (all green):**
    - `tests/services/billing/invoice-template/invoice-csv.test.ts` (22): header order, one row per
      line in order, raw amounts (`-12.50` not prefixed, `1234.50` not grouped), `=HYPERLINK(...)`
      prefixed, RFC 4180 quoting, BOM + CRLF bytes, null cells empty, unknown path empty, bad
      encoding/line ending, no net column, reformatted net → reconciliation, no tax column, resolver
      prototype safety, map-shape rejection (unknown roots, non-identifier segments), and the D1
      orchestration (unposted → not found before resolving, stamps → map, `includeUsage: false`,
      null profile, `line_no` order).
    - `tests/db/invoice-csv.integration.test.ts` (**guardrail 55**, 7, Postgres + Azurite): every
      posted bill → row count = line count and `SUM(net_amount::numeric)::text` from a temp table =
      `subtotal::text`; a multi-line bill (discount, `0.01`, `-12.50`, `99999.99`, a formula and a
      quoted description); a NULL stamp → default v1 map; a fixture CSV v2 stamp → v2 columns; a
      tampered map → `TEMPLATE_CHECKSUM_MISMATCH`; unposted/unknown → not found; unbalanced →
      `INVOICE_RECONCILIATION_FAILED`.
    - `tests/app/api/invoice-csv-route.test.ts` (9): 401 ×2, 403, 422, 404, 409, 500 (no body,
      logged), 429, 200 headers + BOM bytes.
    - Appended: authz matrix (the CSV route checks `BILLRUN_VIEW : READ` before any parse; route and
      service store/audit nothing), route inventory (still three `app/api/billrun` POST handlers; the
      CSV route lives under `app/(app)`), `load.test.ts` (unknown root rejected at load),
      `invoice-preview-modal.test.tsx` (+2: the link and its absence before retrieval).
    - Full integration project: **1205 passed, 0 failed** (127 files, 75 skipped), 490 s. Full unit
      suite: **4359 passed, 0 failed** (394 files).
    - `tsc` clean; ESLint and Prettier clean on every changed file.
  - **Not run here:** no browser or `next build` run of the Download CSV link.
  - **Docs closed in this change set:** code-standards permission map (CSV row confirmed,
    `billrun_view : READ`), file-org (`invoice-csv.ts` moved under `invoice-template/`, as the spec
    says) and guardrail 55 (built); overview success criterion 9 (evidenced); bm00 Unit 62; this
    tracker.
  - **Next:** bm63 (Invoice Template ship gate).

### Invoice Template update — bm63 DELIVERED: ship gate signed off, RUN GREEN on a fresh throwaway Postgres + Azurite + Chromium (2026-10-11)

- **bm63 — Invoice Template ship gate (Invoice Template update, Part 4).** Spec:
  `context/billing-management/specs/bm63-invoice-template-ship-gate.md`. Cross-cutting tests,
  docs and the tracker; nothing new is built. Audits and signs off bm47–bm62.
  - **Gate check:** every G-item is decided. **Owner decisions 2026-10-11:** G5 no `ONE_TIME` in
    v1; G8 IBM Plex embedded (layout v1 keeps its placeholder `@font-face` sources, layout v2 ships
    the real fonts); G9 customer SST/PO/contract fragments hidden, no columns; G16 the app's
    Managed Identity for blob (the `appBlobAuth` flip is a cloud-cutover ops step). G14 (no
    four-eyes) was decided earlier the same day. Recorded in the overview, architecture,
    code-standards (C2, C5, Styling 2), workflow rules §5 and bm00.
  - **Delivered units and commits (bm47–bm63):**

    | Unit | What | Commits |
    | --- | --- | --- |
    | bm47 | Binder on `customer_bill_line` + reconciliation, layout v1 | `dc19685`, `481ab2b`, `625753e` |
    | bm48 | Rating writes `state`/`district` onto `udr_rated` | `b4d28e4`, `a563ace`, `4dd905e` |
    | bm49 | Usage annex state → district from `udr_rated` | `f9fb724` |
    | bm50 | Template catalog schema, seed, permission, grants | `ab736a3`, `e41c488` |
    | bm51 | Generalized write-once blob store | `0c68a06`, `6ab17aa` (+ `a7e48ac` Prettier) |
    | bm52 | Prod blob containers (bicep) | `7cfbe4d`, `82defcc` |
    | bm53 | Resolution, verified load, seed upload | `3caddc5`, `82defcc`, `286a159` |
    | bm54 | Posting stamps | `805377a`, `87ca6a9` |
    | bm55 | Template editor read page + live preview | `c692666`, `87ca6a9`, `286a159` |
    | bm56 | Company profile read page | `98dc3ac`, `477fd0d` |
    | bm57 | Template save draft | `0f17cc2`, `477fd0d` |
    | bm58 | Template activate | `735bbce`, `efaff82` |
    | bm59 | Profile save draft | `765e662`, `8d5d252` |
    | bm60 | Logo upload + sanitization | `da4cf9b`, `8d5d252`, `567ede9`, `0bd4a9c` |
    | bm61 | Profile activate (G14: no four-eyes) | `68c0b81`, `8d5d252`, `567ede9`, `0bd4a9c` |
    | bm62 | Invoice CSV output | `75fd10d` |
    | bm63 | Ship gate | `3ec1bae` (+ the review fixes below) |

  - **D1 — journey (`tests/e2e/invoice-template-journey.integration.test.ts`, 8 steps):** a fresh
    database through the real `db:migrate`, role bootstraps and `db:setup` scripts (child
    processes with the test environment only; the shared `tests/e2e/helpers/fresh-database.ts`),
    then the `_SAMPLE_` `ci` seed processed app-side with the flow's own extracted SQL (a new
    `runCollection` runner beside `runAggregation`/`runVerification`), stage signals through the
    real M2M route, approved by a second user and posted: 4 accounts invoiced, every one rendered
    from the default with no issuer/payment block, `Σ net_amount = subtotal`, every line listed,
    "Unassigned region" present. Then template v2 + profile v1 through the **server actions**
    (real `requirePermission`, only the session faked), the next run stamped v2 / profile 1;
    template v3 + profile v2: the step-3 bill's stamps and stored PDF unchanged, reprint through
    the stored-invoice route byte-identical, `charge_checksum` recomputes, a new draft uses v3 +
    profile v2; a one-byte tamper of v3's `invoice.hbs` parks the new account
    (`TEMPLATE_CHECKSUM_MISMATCH`, on the posting-progress exception surface) while the v2-pinned
    twin re-renders, then the v2 logo tamper parks it with `ASSET_CHECKSUM_MISMATCH`; the CSV sums
    to the subtotal; 10,000 usage rows render ≥ 3 PDF pages (final and draft) with the
    page footer, `thead`/line-group rules and the fixed watermark, and 10,001 park
    (`INVOICE_USAGE_OVER_LIMIT`); exactly one audit row per save, upload and activation (2 each).
    Runs 2–4 post through the real `postAccount` on bm53/bm54 fixture bills (`reset: false`
    option added to `setupInvoiceRenderFixtures`), because the `ci` seed has one due period.
  - **D2 — admin e2e (`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`, 5 scenarios):**
    the installed `playwright` library (no `@playwright/test`) against `next start` on a free port,
    which the test starts after building the fresh database and stops in `afterAll`; headless,
    one context per persona, every non-server request aborted. Personas: no `invoice_settings`
    (nav hidden, both pages → `/no-access`); READ without `billrun_view` (read-only pages, preview
    works, sample only); READ with `billrun_view` (a posted bill offered; a customer named
    `<script>alert(1)</script>` shows as literal text in the sandboxed preview, no dialog); EDIT
    template (mandatory locked, hiding Discount removes the column from the preview, save →
    activate v2, then v3 retires v2 in history, the Generated `.hbs` has no `[[`, no notes
    section and no Discount header); EDIT profile (six invalid formats rejected inline with the
    catalog messages; > 500 KB, < 300 px, PNG-as-SVG and SVG `<script>` logos rejected;
    activation without a logo refused; with a logo it activates and shows the bank warning).
    `npm run test:e2e:invoice-settings` = `next build` + this file (a `package.json` scripts
    change only). Sign-in posts the login page's own CSRF token from inside the page, because
    the client auth base URL is inlined at build time.
  - **D3 — sweep, gaps closed in their owning areas** (the spec asks for a separate defect-fix
    commit each; at the owner's request they shipped inside the ship-gate commit `3ec1bae`):
    1. **Activate dialog unreachable on a 720 px screen (bm58/bm61, real defect).** A first
       profile activation lists every field, so the dialog outgrew the viewport and Activate sat
       below the fold with no scroll. `activate-version-dialog.tsx`: `DialogContent` now scrolls
       (`max-h-[calc(100dvh-2rem)] overflow-y-auto`). Found by the admin e2e.
    2. **Layout lint (bm47 follow-up, Styling rule 3):** `tests/guardrails/invoice-layout-lint.test.ts`
       + the bad fixture `tests/fixtures/invoice-layout-bad/bad.hbs`. Handlebars-AST checks
       (only the nine helpers + block built-ins, no partials, no triple-stash) plus the text bans;
       CSS/HTML/Handlebars comments are skipped (the seeded shell's comment names the rule).
    3. **Golden render (bm47 follow-up, criterion 12):** `tests/services/billing/invoice-golden.test.ts`
       writes/compares `tests/fixtures/invoice-golden/INVTPL-STD-A4-v1{,.footer}.html` (sample
       data through the seeded default, font data stripped, whitespace normalised); a test pins
       one golden per seeded layout version. The golden directory is in `.prettierignore`.
    4. **Guardrail 56 upgrade path (bm50 gap):** `invoice-settings-grants.integration.test.ts`
       recreates a pre-bm50 grant state (DELETE/INSERT/UPDATE for `app_runtime`, ALL for
       `billrun_runtime`, the reserved stamp columns) and re-runs the real bootstrap: revoked to
       the same least-privilege result.
    5. Guardrails 43 (on the `ci` seed) and 54 (≥ 3 pages) are shown by journey steps 2 and 7.
    6. Confirmed unchanged: route inventory (three `app/api/billrun` POST handlers), the authz
       matrix (five routes, the CSV route, six actions), ZAP (whole host) and Semgrep (whole repo)
       scopes cover the new routes per the §8 inventory, every binding name in code-standards
       Part 2 exists in code.
  - **D4 — success-criteria evidence:**

    | # | Criterion | Evidence (green) |
    | --- | --- | --- |
    | 1 | `ci` invoices list every line; `Σ net = subtotal` | journey step 2; `bind.test.ts` |
    | 2 | Fresh DB: one format, defaults ACTIVE, rendered with no admin activity | journey steps 1–2; guardrail 45; `invoice-template-catalog.integration` |
    | 3 | Profile validation, logo rules, activation needs logo + note | admin e2e (profile); `activate-profile.integration` (51); `upload-logo.test.ts` (52); action test (`CHANGE_NOTE_REQUIRED`) |
    | 4 | Editor locks, Discount hide, n+1 ACTIVE / n RETIRED, clean `.hbs` | admin e2e (template); `generate.test.ts` (48); `activate-template.integration` (53) |
    | 5 | Pinning across v3 + profile v2 | journey step 4; guardrail 46 |
    | 6 | Tamper parks, others render, no legacy | journey step 5; guardrails 47, 44 |
    | 7 | ≥ 3 pages, footer, header repeat, groups whole, watermark | journey step 7 (structural: page count + footer spans + CSS) |
    | 8 | Usage annex by state → district | journey step 2; `invoice-usage-annex.integration` |
    | 9 | CSV rows and sum | journey step 6; guardrail 55 |
    | 10 | Reprint bytes + `charge_checksum` | journey step 4; guardrail 46 |
    | 11 | No access / read-only / audit / escaping | admin e2e; journey step 8; guardrail 56 (matrix + grants) |
    | 12 | Golden, binder tests, typecheck/lint/vitest/e2e, docs synced | `invoice-golden.test.ts`, layout lint, the runs below, D6 |

  - **Interpretations (recorded):**
    1. **Fixture runs for steps 3–7.** The `ci` seed has one due period, so later runs post fixture
       bills through the real `postAccount` (the guardrail 46 precedent).
    2. **"An empty note shows the server message" is not reachable in the browser.** Confirm stays
       disabled for an empty or whitespace note and React ignores clicks on a disabled button; the
       e2e asserts the disabled state and the server's `CHANGE_NOTE_REQUIRED` is the action test's.
    3. **"Page X of Y on every page" is proven structurally** (no PDF text parser dependency).
    4. Known-issues §23 lists the residuals carried past the gate.
  - **Runs (all green):** full unit suite **4378 passed, 0 failed** (396 files); the journey 8/8
    and the admin e2e 5/5 on the throwaway stack; full integration project **1219 passed, 0 failed** (129 files, 75 skipped, 513 s, incl. the journey, the admin e2e and the grants upgrade case);
    `tsc` clean; ESLint and Prettier clean on every changed file.
  - **D6 — docs folded in this change set:** project overview (new delivered section with
    criteria 1–12 + evidence and the decisions); update overview (Part 2 replaced by a pointer,
    status row delivered); architecture (Part 2 deltas delivered, conflicts and open items closed,
    Inv #39–#50 delivered note, artifact-storage row with G16); code-standards (C1–C5 closed, Part
    2 citations to Inv #, companion line); workflow rules §5 (no Part 2 open rows); bm00 (Part 4
    delivered); placeholder catalog (final roots, CSV roots); known-issues §23; this tracker.
  - **Code-review fixes (2026-10-11, `/code-review max` of bm62–bm63 + the Sonar change):**
    1. **CSV customer identity read live — accepted by the owner** (known-issues §23j); the "frozen
       data" wording in `invoice-csv.ts` and the project overview corrected.
    2. **Forced password change on Route Handlers (cross-domain, owner-approved):**
       `auth/resolver.ts` `findActiveUserById` refuses a user owing a password change, closing the
       gap on the five billing routes and the Accounts GL-export route (usrmgmt tracker, general
       change tracker).
    3. **Download CSV reports failures:** the modal fetches the route and shows the 401/403/404/
       409/429/500 reason (`describeInvoiceCsvError`), then downloads (`lib/download.ts`).
    4. **e2e safety:** `runScript` refuses unless `BOOTSTRAP_DATABASE_URL` names the same database
       as `DATABASE_URL`; the e2e server is spawned with `__NEXT_PROCESSED_ENV=true` (no `.env*`
       inherited, known-issues §23i closed); the admin e2e is opt-in (`npm run
       test:e2e:invoice-settings`, which builds first, or `RUN_INVOICE_SETTINGS_E2E=1`).
    5. **Layout lint hardened:** any URL-bearing attribute or CSS `url()` to `http(s):`/`//`, and
       `<iframe|object|embed|base>`, fail; CSS comments are stripped only inside `<style>`; literal
       helper names are allow-listed too; 12 probe cases added.
    6. **CSV self-check:** a reformatted net cell is a plain error (logged 500, not the bill's
       409); a real one-row-per-line check (`rows.length === raw.lines.length`); the Sonar S2871
       sort now uses an explicit code-unit comparator (the earlier count-map rewrite reverted).
    7. **Journey robustness:** the `ci` run is picked by its cycle (`DEFAULT_BILL_CYCLE_NAME`); step 6
       parses the CSV with the shared RFC 4180 helper (`tests/helpers/parse-csv.ts`); step 5 restores
       both tampered blobs in `finally`.
    8. **Docs drift:** architecture header (Part 2 delivered), workflow rules companion list,
       `render-invoice-template.ts` comment, this tracker (bm63 commit, D3 commit note).
  - **SonarCloud accessibility fix to layout v1 (2026-10-11, owner decision A, PR #156):** `lang="en"`,
    a `<title>`, and visually hidden `<thead>` headers on the two summary tables, in layout v1
    (`shell.hbs`, `chargeSummary`/`taxSummary` partials) and generated v1, so generator parity holds;
    both `checksums.json` regenerated (`write-checksums.ts`), the digests updated in **migration
    `0046` (edited in place)** and `tests/helpers/seeded-invoice-template.ts`, the golden fixture
    regenerated, `generate.test.ts`'s `<html>` assertion updated. v1 is final from this commit.
    **Environments that already ran `0046` must be reset** (known-issues §23k/§23l). Unit 1208
    template tests, integration 1214, admin e2e 5/5 — all green on a fresh stack.
    Follow-up review fix: the `<title>` checks `isDraft` first, so a draft that carries a number
    (the editor's sample preview) is "Pro-forma invoice"; v1 digests re-pinned again in `0046`
    and the helper; regression test in `invoice-golden.test.ts`. Same reset as above (§23l).
    - Not changed (cleanup, recorded for later): sharing `buildInvoiceHtml`'s orchestration and
      the route auth preamble, and the `lib/csv.ts` wire-format overlap.
  - **Next:** the cloud cutover adds the `appBlobAuth` flip (G16); the layout v2 unit (annex CSS,
    known-issues §20, plus the real IBM Plex fonts, G8) before any production template activation.


### Target Capacity Pricing follow-up — bm42a DELIVERED (flow + tests + docs), RUN GREEN on throwaway Postgres (2026-10-10)

- **bm42a — Flow fixes: aggregation SQL, trace money as text, plain-USAGE tamper check.** Spec:
  `context/billing-management/specs/bm42a-flow-aggregation-verification-fixes.md`. A follow-up to
  delivered bm42/bm43 (named on the `pm56a` pattern). Flow only (`local-dev/bill_run_processing.yml`,
  `aggregation` + `verification`): no migration, no grant, no app code, `template` file untouched.
  Closes known-issues §21 21c2, 21c3 and 21c4. Owner decisions 2026-10-10: money in the trace is
  **text** (Defect 2 option A); `steps` left verbatim; DB-free static guard included;
  `CapacityCalcTrace` gets a doc comment only.
  - **Delivered:**
    - **D1 (CRITICAL).** The `capacity_band_json` CTE called `row_number() OVER (…)` inside
      `jsonb_agg(…)`, which Postgres forbids, so the whole `aggregation` statement could never run:
      bill-run aggregation failed for every account. The band number is now computed in
      `capacity_band_charges` (a `SELECT` list) and `jsonb_agg` reads `band_no`. Output identical.
    - **D2.** Every amount, rate and decimal quantity in `additional_info` (`pricing`, `calc`,
      `appendix`) is a JSON **string** at canonical scale: money `numeric(18,2)`, quantities
      `numeric(20,6)`, rates `numeric(18,6)`. `v`, `udrCount` and `band` stay integers; the
      catalog `steps` copy is verbatim; `NULL::text` is still stripped (no `shortfall` when MET, no
      `to` on the last band). Verification reads the trace with `->>` and numeric casts, so it is
      unchanged, and `charge_checksum` never hashes `additional_info` (Inv #35). No app reader exists.
    - **D3.** Ordinary (non-capacity) USAGE lines in `verification` must also satisfy
      `gross_amount = rated_amount` and `net_amount = gross_amount - discount_amount` (bm43 moved the
      replay to `rated_amount` and called it behaviour-preserving, but an altered gross/net passed).
      The finding now also shows the billed gross/net/discount.
  - **Deviation from the spec text (recorded):** the spec said "exact numeric text"; a catalog value
    such as a commitment of `1000` would then serialise as `"1000"`, so the contract uses explicit
    canonical-scale casts (`::numeric(p,s)::text`). The spec's D2 wording was updated to match.
  - **Tests (all green):**
    - The 34 failures behind the harness fix now pass: all eight billing-run suites (44 tests),
      including the phase-3 full journey.
    - New: three tamper cases (alter only gross, only net, only discount) in
      `billrun-verification-reconciliation`; a trace-contract test in `billrun-capacity-aggregation`
      (walks the whole trace over the SHORTFALL, MET and one-band cases: no JSON number except
      `v`/`udrCount`/`band`, 2dp money, 6dp quantities, steps verbatim); and the DB-free guard
      `tests/guardrails/billrun-flow-sql-window-in-aggregate.test.ts` (11 tests: a detector for a window
      function inside an aggregate call, with self-tests, run over the validation, collection,
      aggregation and verification SQL). Verified to **fail on the original flow** and pass on the fix.
    - One assumption fixed in a test: the appendix suite looked up the card-missing polygon by its
      original case; the flow recovers it from the lower-cased canonical `udr_key`.
    - **Full integration project: 48 failures down to 4** (1151 passed), all `ordering-read` (the
      product module's lane gap, known-issues §21e). **Full unit suite: 0 failures** (4077 passed).
      `tsc`, ESLint and Prettier clean on every changed file.
  - **Not run here (Inv #38):** a live-Kestra execution of the real flow on the `ci` and `capacity`
    seeds. The DB suites run the extracted SQL; only a live run proves the deployed flow completes, and
    the capacity-profile smoke harness (TC54) still does not exist. Redeploy via
    `deploy_workflow_flows`; nothing was in flight (the flow could not aggregate before).
  - **Docs closed in this change set:** known-issues §21 (21c2 to 21c4 fixed, 21c7 recorded, result
    paragraph); code-standards (string-money trace contract); the bm42a spec (canonical scales);
    `bm00-build-plan.md` lists bm42a; this tracker.
  - **Next:** known-issues §21e (the product module's flat-fee lane gap, pm46) is owned by the
    gated product unit pm46a, DELIVERED 2026-10-10 (see the Outstanding note below); the live-Kestra capacity journey (TC54) is still outstanding.

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
