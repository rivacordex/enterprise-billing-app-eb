# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-09-16 — per-unit narrative, post-review-fix logs, and test-file
enumerations trimmed to key facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit
detail: `context/billing-management/specs/bm*.md`._

## Current state (2026-09-16)

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
  2026-09-16).** The `billrun_runtime` DB URL + engine/SFTP Key Vault secrets
  and their consumer mapping are wired into the shared `workflow-engine` bicep,
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

## Outstanding / Next (Phase 4)

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

- See `billmgmt-known-issues.md` for the full list. **Accepted residual (ENG
  CLEARED, 2026-09-14):** posted `customer_bill_line` rows have no DB-level
  immutability trigger and `charge_checksum` is not re-verified after posting, so
  post-posting line tampering has no active detection until a re-verification path is
  added.

## Environment quirks

- Pre-existing, unrelated to this module: 4 hardcoded-date-drift test files
  (`tests/actions/{create-order,resume,suspend,terminate}-subscription*`) fail on a
  clean baseline (dates now >3 days past). Confirmed this module never touches them.
- Context docs live under `context/billing-management/` (renamed from a `billling-`
  triple-l typo).

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
