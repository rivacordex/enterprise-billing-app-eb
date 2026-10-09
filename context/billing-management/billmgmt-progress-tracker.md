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

## Invoice Template update — bm49 DELIVERED (code + docs), DB/Playwright suites DEFERRED (2026-10-08)

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

## Invoice Template update — bm50 IN PROGRESS (started 2026-10-08)

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

## Invoice Template update — bm51 DELIVERED (code + docs), Azurite round-trip UNRUN (2026-10-09)

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

## Invoice Template update — bm52 DELIVERED + VERIFIED by what-if on dev (2026-10-09)

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

## Invoice Template update — bm53 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite (2026-10-09)

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

## Invoice Template update — bm54 DELIVERED (code + tests + docs), RUN GREEN on throwaway Postgres + Azurite + Chromium (2026-10-09)

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

## Invoice Template update — bm55 DELIVERED (code + tests + docs), unit suite RUN GREEN (2026-10-09)

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

## Invoice Template update — bm56 DELIVERED (code + tests + docs), unit suites RUN GREEN (2026-10-10)

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

- **DONE (bm55 review) — `listRecentPosted` index.** Migration `0047_customer_bill_posted_idx`
  adds a partial btree on `customer_bill (ref_inv_document_id DESC) WHERE ref_inv_document_id IS NOT NULL`
  (mirrored in `db/schema/billing/customer-bill.ts`). Query and partition scope unchanged.

- **DONE (bm55 code-review fixes, 2026-10-09).** Dev compose `setup` now gets Azurite + the in-network blob
  connection string (db:setup seeds invoice templates); `.gitattributes` pins `db/seeds/invoice-templates/**`
  to LF (SHA-256 contract); `generate.ts` rejects a swallowed `[[body]]` and prototype-key `[[num …]]`;
  `load.ts` fetches version files in parallel and maps a blob 404 to `TEMPLATE_VERSION_NOT_FOUND`;
  migration `0048` indexes the two posting stamps and `listForKind` skips counts for layouts;
  `isChecksumAlgorithm` and the `BTV` id regex de-duplicated; version-pinning test now deletes its stored PDFs.
- **MOVED (2026-10-09):** the open owner-review items are tracked in `billmgmt-design-review.md`.
- **DONE (2026-10-09) — review decisions.** `archive.tar` removed from git and ignored; migrations 0047/0048
  carry a locking note (plain `CREATE INDEX`, run outside an active bill run on a large table — owner chose
  "keep plain, document"). Deferred design items now live in `billmgmt-design-review.md` (DR-01 profile
  validity gate → bm61, DR-02 CSV resolution, DR-03 preview `bind()`, DR-04 accepted unused exports).
