# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-10-04 (earlier pass 2026-09-16) — narrative, per-run fix logs, and
environment-quirk detail trimmed to durable facts + decisions. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit detail:
`context/billing-management/specs/bm*.md`; defect detail: `billmgmt-known-issues.md`._

## Current state (2026-09-18)

- **Phases 1–4 (bm01–bm39) delivered.** Phase 1 (bm01–bm13) control plane; Phase 2
  (bm14–bm21) two-writer boundary, rendering, posting-on-real-charges, distribution;
  Phase 3 (bm22–bm35) real compute plane; Phase 4 (bm36–bm39) processor signal-back,
  self-driving lifecycle, production wiring + ship gate.
- **First full `SCHEDULED → COMPLETED` proven on real infra (2026-09-17)** —
  `BRN00000001` (`_SAMPLE_` `ci` seed) on real Postgres + Kestra 1.3.35 + Azurite:
  4 INV documents posted, all 5 artifacts delivered to the `loopback` sink.
- **Taxation stays a no-op** (`tax_total = 0.00`), ratified as interim.
- **Cloud cutover is a gated ops step, not code** — bm38 landed the bicep/pipeline/doc
  wiring (deploy flags off by default); the real flag-flip + live smoke against a real
  engine/SFTP remains outstanding. Order of ops: `infra/docs/db-role-verification.md`
  "Production cutover".
- **wfm01** (commit `0b31f50`): `rating-engine/` → `workflow-management/`; flow paths
  are function-first (`flows/bill-run-processor/…`, `flows/bill-run-distributor/…`).
- **bm40 (2026-10-05)** — Target Capacity Pricing update, Unit 0: extracted-SQL
  harness (TC43) + DB-test safety (TC58); the flow-rename item was already
  satisfied before this unit started. See "Delivered units" below.

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

### Phase 3 — real compute plane (bm22–bm35)

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

### Phase 4 — signal-back, self-driving lifecycle, prod wiring (bm36–bm39)

- **bm36** — Processor signal-back: real `http.Request` per-stage `DONE` + per-account
  HARD `FAILED` + run-level terminal `/status` POSTs in `bill_run_processing.yml`,
  replacing the `Log` stubs (mirrors bm34). `BILLRUN_PROCESSING_FORCE_FAIL` test
  toggle (read only by `trigger-run.ts`, no UI). No schema, no migration.
- **bm37** — Local E2E assertion + reconcile alignment: `billrun-live-kestra-smoke.ts`
  drives + asserts the full `SCHEDULED → COMPLETED` journey on the `ci` seed
  (re-spawns as three sequenced force-fail legs). **Decision (a):** a per-account HARD
  failure leaves the RUN `PROCESSED` (failed account `SKIPPED` at approval, rerunnable).
  No flow/receiver/schema change.
- **bm38** — Production deployable + wired (infra/doc only). `hostsBillrunNamespace`
  bicep param gates the `billrun_runtime` split-shape DB credential (bare-password
  secret + `*_DB_*` coords) onto the billrun engine; cutover runbook + taxation-`0.00`
  interim recorded; `local-dev` flow promoted as THE deployed flow. No app code/schema.
- **bm39** — Phase-4 ship gate: audit + sign-off, every Phase-4 behaviour confirmed
  green. Closed one gap — added DB-free `tests/guardrails/billrun-processing-signal-back.test.ts`
  so a callback reverted to a `Log` stub fails CI. No app/flow/schema change.

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

## Outstanding / Next (post-Phase 4)

- **Cloud cutover (gated ops step)** — provision out-of-band Key Vault secrets
  (`billrun-runtime-db-password`, `billrun-engine-url`/`-auth`, SFTP), flip
  `deployWorkflowEngine` → deploy engine → `deployRatingFlows` →
  `runBillrunLiveKestraSmoke` → `enableSftpDistribution` when a real SFTP exists.
- **Before any prod deploy:** rotate `billrun-engine-auth` username to
  `workflow-ops@billing.ops` (coupled triple: engine, pipeline `--user`, KV secret) or
  every app→engine call 401s.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles`.
- **DB verification:** run the full DB-gated suite + `db:seed-sample` against a
  disposable/CI Postgres — never the shared dev DB (see test-safety gotchas).

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

## Live-run hardening (2026-09-17 → 09-18)

Taking `BRN00000001` to COMPLETED on real infra surfaced defects invisible to the
YAML-blind CI suite; all fixed, flows redeployed. Detail in `git log` /
`billmgmt-known-issues.md`.

- **Kestra 1.3.35 expression bugs (processor + distributor; ship to the deployed
  flows).** A `ForEach` value reaches only DIRECT children, so bm36's `Sequential`
  wrapper broke every nested `taskrun.value`; a nested-`ForEach` `parents[1]` does not
  exist (the immediate loop value isn't a `parents` entry); nested task outputs are
  keyed by BOTH loop values. Fixed to `parent.taskrun.value` / `parents[0]` /
  `outputs.x[outer][inner]`, misleading comments corrected.
- **Workflow tab — derived app-side stages (DELIVERED, owner decision).** Four of nine
  grid columns (`scoping`/`posting`/`rendering`/`distribution`) were never written
  (only the 5 processor callbacks write `bill_run_account_stage`), so a COMPLETED run
  read "posting: pending". Now DERIVED on read in `get-stage-timeline.ts` (Inv #12 —
  never stored; a real stage row always wins), `distribution` removed from the
  per-account grid, run-level `RunFlowProgressBar` added (run status floors the bar);
  mid-flight summary gated on run status. Post-review hardening fixed 6 edge cases.

## Known residuals

- **Zero-charge account (OPEN; known-issues §11/§12).** The processor writes a
  `subtotal-0.00` header for a line-less account. **Owner decision (2026-09-17):**
  loosen the approval gate (`positive_totals` excludes line-less bills; informational
  `zero_total_bills` added) and have posting SKIP a bill whose subtotal AND total are
  both exactly zero (`ZERO_TOTAL_NOT_INVOICED`, consumes no invoice number). Narrow by
  design — a **negative** total (credit) and a **tax-only** bill are NEVER skipped.
  Must be re-evaluated once discounting ships (a fully-discounted net-zero bill is
  indistinguishable from a no-charge one). Durable fix (deferred): make `ins_header`
  conditional on non-empty lines.
- **Post-posting immutability (accepted, ENG cleared 2026-09-14).** Posted
  `customer_bill_line` rows have no DB-level immutability trigger and `charge_checksum`
  isn't re-verified after posting — tampering is undetected until a re-verification
  path exists.
- **First full DB-gated run (2026-09-17; known-issues §4c).** 2 E2E suites fail at the
  post→distribute assertion (`INVOICED` vs `DISTRIBUTING`) because `triggerDistribution`
  rolls back with `ENGINE_UNREACHABLE` when the engine is absent. First-execution
  results, untriaged — not a known regression.

## Environment / test-safety gotchas

- **The DB-gated suite is destructive (known-issues §13; bm40/TC58 added a
  fail-closed preflight).** `*.integration.test.ts` suites `DROP SCHEMA … CASCADE`,
  and `billrun-db-roles` resets the `public` **schema** inside the separate
  `kestra` DB (never the whole database, never `WITH (FORCE)` — that used to kill
  a co-located engine's connections outright). `vitest.integration.config.ts`'s
  `globalSetup` (`tests/integration-global-setup.ts`) now refuses to run at all
  unless `DESTRUCTIVE_DB_OK=1` **and** the target carries the disposable sentinel
  (`tests/helpers/disposable-database.ts` — never a name/host match), and it runs
  before any test file, so an unset `DATABASE_URL` refuses loudly instead of
  crashing inside `@/lib/config`. Still run only against a disposable/CI Postgres
  with the engine stopped — the suite still rewrites shared role passwords
  (known-issues §13 item 2, open).
- **`.gitattributes` pins `*.sql eol=lf`** — Windows CRLF had silently no-op'd two
  `[CRITICAL]` write-boundary guardrails.
- **Clean local stack needs manual steps** — bootstrap runtime DB roles
  (`billrun_runtime`/`rating_runtime`) + passwords by hand; create the `kestra-internal`
  Azurite container (`dev:azurite-init`); Azurite needs `-l /data` to persist; set
  `extra_hosts: app:host-gateway` for callbacks; `BILLRUN_APP_TOKEN` must equal the
  base64-decoded `SECRET_BILLRUN_APP_TOKEN`.
- **Local render needs a HOST-side dev server** (dev `app` container has no Playwright
  browser); keep Chromium current with `npx playwright install chromium`. The
  containerised `app` can't dispatch to the engine (loopback/HTTPS rules) — trigger real
  runs from a host dev server or `billrun-live-kestra-smoke.ts`; the container app must
  stay up because flow callbacks target `http://app:3000`.
- Context docs renamed from a `billling-` triple-l typo. 4 pre-existing
  hardcoded-date-drift subscription tests fail on a clean baseline (unrelated).

## Open questions

- **bm37 failure-path terminal wording (RESOLVED 2026-09-16, option (a)).** A per-account
  HARD failure leaves the RUN `PROCESSED` (not run-level `PROCESSING_FAILED`); the
  failed account is `SKIPPED` at approval and the run rerunnable. No
  `computeRunStatus`/receiver/flow change.
- **Receiver hardening deferred (out of bm36 scope).** The run-level `PROCESSING_FAILED`
  `/status` push has no attempt/stale-execution guard (unlike `DISTRIBUTION_*`), and
  `handle-status-push.ts`'s 409 messages are inverted. Fold into a receiver-touching unit.
