# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-10-07 (earlier passes 2026-10-04, 2026-09-16) — narrative, per-run
fix logs, environment-quirk detail, and the Target Capacity Pricing update's
per-unit narrative (bm40–bm46) trimmed to durable facts + decisions and archived
to `billmgmt-completed-tracker.md`. Full history:
`git log -- context/billing-management/billmgmt-progress-tracker.md`; per-unit detail:
`context/billing-management/specs/bm*.md`; defect detail: `billmgmt-known-issues.md`._

## Current state (2026-10-07)

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
- **Target Capacity Pricing update: bm40–bm45 delivered the implementation;
  bm46 sign-off remains open (2026-10-07).** bm40 (Unit 0, 2026-10-05) repaired
  the bill-run foundation (extracted-SQL harness TC43 + DB-test safety TC58 —
  the flow-rename item it was originally scoped for had already shipped); bm42–bm45 shipped the capacity
  pricing/verification/checksum/appendix behaviour. bm46 (the ship gate)
  audited it: guardrails 36–42 and invariants #29–#38 confirmed present,
  migration count confirmed at exactly `0044`, `tsc` and lint clean. Vitest
  (`npx vitest run --pool=threads`) reported **7680 passed, 5 failed, 927
  skipped** — all 5 failures are argued pre-existing/unrelated to capacity
  code (see the bm46 entry below for which), but a run with failures is not
  a green suite, and update-overview.md success criterion 8 ("the vitest
  suite pass") is **not yet met** on that basis alone. bm46 also synced the
  owning docs. **OPEN, blocking full bm46 sign-off:** (1) the live-Kestra
  capacity journey (TC54) has no runnable harness — `scripts/
  billrun-live-kestra-smoke.ts` is `ci`-seed-only — separately from this
  environment lacking a live Postgres/Kestra stack to run it on; (2) the
  DB-gated capacity suites have not been re-run against a disposable
  Postgres in this environment; (3) the 5 vitest failures above have not
  been re-verified against a clean checkout. See the bm46 entry below for
  detail.

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

### Target Capacity Pricing update — delivered, two items OPEN (bm40–bm46)

Full per-unit detail (flow SQL, DB-gated test files, SonarQube duplication
fixes, per-unit verification notes) archived to
`billmgmt-completed-tracker.md`'s "Target Capacity Pricing update —
DELIVERED" section.

- **bm40** — Unit 0: extracted-SQL harness (`tests/db/helpers/extract-flow-sql.ts`,
  parses the deployed flow's psql heredocs and runs them in-transaction —
  retires the hand-copied `billrun-aggregate.ts`/`billrun-verify.ts` doubles)
  + a fail-closed destructive-DB preflight (`DESTRUCTIVE_DB_OK=1` + a
  disposable sentinel, checked before any `db/client.ts` import). The
  resolver-rename repair the unit was originally scoped for had already
  shipped (rm22).
- **bm41** — `customer_bill_line` capacity columns: migration `0044`
  (`rated_amount numeric`, `additional_info jsonb`), Drizzle mirror,
  `billrun_runtime` SELECT grants on `product_specifications`/
  `ratecard_ran_usage_lkp`/`ratecard_version`.
- **bm42** — Capacity aggregation: commitment-floor + N-band motivation-
  discount inline SQL CTEs in `aggregation`, the six HARD `CAPACITY_*`
  guards, the `rated_amount`/`additional_info` calc trace, and the
  `_SAMPLE_` `capacity` seed profile (four anchor accounts: 800/1000/2000/0 EA).
- **bm43** — Capacity verification: replays `rated_amount` (not
  `gross_amount`, which the top-up inflates), checks the internal
  `gross = rated_amount + topUp` / `net = gross − discount` identities, and
  cross-derives an independent Model-2 figure; `CAPACITY_RATE_MATCHING`
  (default ON) gates G2 (aggregation) and Model-2 (verification) together —
  ON HARD-fails `CAPACITY_RATE_MISMATCH`, OFF logs a WARN and bills Model 1.
- **bm44** — `charge_checksum` re-anchor: `rated_amount` appended as the
  8th (last) hashed tuple element, un-coalesced so NULL (RECURRING) never
  collides with a rated-to-zero `"0.00"`. Read-model/UI comment updates only
  (no behavioural change) — `listForRun` already projected the new columns
  (bm41 compile-ripple).
- **bm45** — Invoice usage appendix: per-polygon state/district breakdown
  (D2 canonical-key join against `ratecard_ran_usage_lkp`, D4 ACTIVE-version
  resolution) snapshotted at `aggregation` into
  `additional_info.appendix`, rendered on the **final posted** invoice only;
  `CAPACITY_APPENDIX_OVER_LIMIT` HARD-fails past 10,000 polygon rows; new
  `_SAMPLE_` `capacity-appendix-multi-polygon` scenario + dedicated
  `db/seeds/sample/capacity-usage-card.ts`.
- **bm46 (2026-10-07)** — Target Capacity Ship Gate: audited bm40–bm45
  against guardrails 36–42 / invariants #29–#38 (all present on disk),
  confirmed no migration beyond bm41's `0044`, `tsc`/lint clean. `npx vitest
  run` reported 7680 passed / **5 failed** / 927 skipped — argued
  pre-existing/unrelated to capacity code, but not independently re-verified
  on a clean checkout this unit. Synced the owning docs. **OPEN (not
  silently assumed green):** (1) the live-Kestra capacity journey (TC54) has
  no runnable harness — `scripts/billrun-live-kestra-smoke.ts` is `ci`-seed-
  only; (2) the DB-gated capacity suites
  (`billrun-capacity-aggregation`/`-verification`/`-appendix`,
  `customer-bill-line-checksum`) have not been re-run against a disposable
  Postgres in this environment; (3) the 5 vitest failures above are
  unconfirmed. See "Outstanding / Next" below.

## Invoice Template update — bm47 INCOMPLETE: core binder committed, gates + guardrails OPEN (2026-10-08)

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

## Invoice Template update — bm48 DELIVERED (code), DB/python suites UNRUN (2026-10-08)

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
- **Build a capacity-aware live-Kestra smoke harness (bm46 finding, new).**
  `scripts/billrun-live-kestra-smoke.ts` only knows the `ci` seed profile.
  TC54 (the capacity update's live-Kestra sign-off proof) needs either a new
  script or a parameterized extension that targets the `_SAMPLE_` `capacity`
  seed, drives `SCHEDULED → COMPLETED`, and asserts the four anchors, the six
  `CAPACITY_*` guards, and the `CAPACITY_RATE_MATCHING` gate ON/OFF. Blocked
  on a live Postgres/Kestra stack to build it against and verify it on.
- **Re-run the capacity DB-gated suites** (`billrun-capacity-aggregation`/
  `-verification`/`-appendix`, `customer-bill-line-checksum`) against a
  disposable Postgres — not yet executed in any environment this session had
  access to (bm46).

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
- **OPEN (bm46) — TC54's harness doesn't exist.** The live-Kestra capacity
  journey has no implementation to run, independent of this environment's
  missing infra. Needs a build decision: extend `billrun-live-kestra-smoke.ts`
  to accept a seed-profile parameter, or add a sibling script. Not resolved
  here — recorded as an owner decision pending a live stack to build against.
- **OPEN (bm46) — O-TC7, partial-period capacity billing.** Whether/how to
  pro-rate a partial-period capacity commitment is an unresolved **business**
  decision (`billmgmt-known-issues.md` §17); capacity accounts stay
  `EXCLUDED` for a partial period until it is answered. Not an engineering
  deferral — never build a pro-ration method without this decision.
