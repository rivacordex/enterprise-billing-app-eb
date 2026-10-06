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
