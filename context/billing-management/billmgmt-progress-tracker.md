# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-10-29 (earlier passes 2026-10-25, 2026-10-12, 2026-10-07, 2026-10-04, 2026-09-16)
— the Invoice Template Types per-unit narrative (bm74–bm85, incl. review-fix logs, test runs, the
criteria → evidence table and the Inv #59–#68 code ↔ test audit) and bm86–bm87 trimmed to durable
facts + decisions. Full history: `git log -- context/billing-management/billmgmt-progress-tracker.md`
(pre-compaction text at `8ac1d545`; Phase 3 narrative at `5b5f746`); per-unit detail:
`context/billing-management/specs/bm*.md`; defect detail: `billmgmt-known-issues.md`._

## Current state (2026-10-29)

- **bm88 COMPLETED (2026-10-29):** the bm62 invoice CSV is retired completely (see Standalone
  units below). The PDF path is unchanged. The intended invoice CSV is the reporting extract
  (`_newmodule-reporting-plan.md` Part D). Context docs' "bm88 (planned)" notes are flipped to built.
- **Invoice Template Types update (bm74–bm85, with CM cm23–cm24) COMPLETED — ship gate bm85
  (2026-10-26).** Full set green (integration 148/148 files, 1416/0). Folded into
  `billmgmt-project-overview.md`. Summary under Delivered units below.
- **bm86** (logo min side 96 px) and **bm87** (Workflow tab dot stepper) built 2026-10-26 /
  2026-10-28.
- **Earlier updates COMPLETED:** Invoice Template Phase 3 (bm64–bm73, 2026-10-19), Invoice Template
  update (bm47–bm63, 2026-10-11), Target Capacity Pricing (bm40–bm46 + bm42a), Phases 1–4
  (bm01–bm39; first real `SCHEDULED → COMPLETED` 2026-09-17).
- **Taxation stays a no-op** (`tax_total = 0.00`), ratified as interim.
- **Cloud cutover is a gated ops step, not code** (bm38 wiring, deploy flags off by default);
  order of ops: `infra/docs/db-role-verification.md` "Production cutover".
- **wfm01** (`0b31f50`): `rating-engine/` → `workflow-management/`; flow paths are
  function-first (`flows/bill-run-processor/…`, `flows/bill-run-distributor/…`).

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

### Target Capacity Pricing update — DELIVERED (bm40–bm46, + bm42a)

Spec per unit: `specs/bm40…bm46-*.md`; full per-unit narrative in this file's git history.

- **bm40** — extracted-SQL harness (`tests/db/helpers/extract-flow-sql.ts`) + fail-closed
  destructive-DB preflight (`DESTRUCTIVE_DB_OK=1` + disposable sentinel).
- **bm41** — migration `0044`: `customer_bill_line.rated_amount`/`additional_info`, runtime
  SELECT grants on the catalog/ratecard tables.
- **bm42** — commitment-floor + N-band motivation-discount aggregation, six HARD `CAPACITY_*`
  guards, calc trace, `_SAMPLE_` `capacity` seed (anchors 800/1000/2000/0 EA).
- **bm43** — capacity verification replays `rated_amount`, Model-2 cross-check;
  `CAPACITY_RATE_MATCHING` (default ON) gates G2 + Model-2.
- **bm44** — `charge_checksum` appends `rated_amount` (8th element, un-coalesced).
- **bm45** — per-polygon usage appendix snapshotted into `additional_info.appendix`;
  `CAPACITY_APPENDIX_OVER_LIMIT` past 10,000 rows.
- **bm46** — ship gate (guardrails 36–42, Inv #29–#38). Only TC54 remains open (see Outstanding).
- **bm42a (2026-10-10)** — flow-only: window function moved out of `jsonb_agg` (aggregation
  could not run at all), trace money as canonical-scale **text**, plain-USAGE gross/net tamper
  check; guard `tests/guardrails/billrun-flow-sql-window-in-aggregate.test.ts`. Closes
  known-issues §21c2–c4.

### Invoice Template update — COMPLETED (bm47–bm63, 2026-10-08 → 2026-10-11)

Spec per unit: `specs/bm47…bm63-*.md`; build plan `bm00-build-plan.md` Part 4. Full narrative,
deviations, review-fix logs and test runs are in this file's git history.

| Unit | What | Commits |
| --- | --- | --- |
| bm47 | Handlebars binder on `customer_bill_line` + reconciliation, layout `INVTPL-STD-A4` v1 | `dc19685`, `481ab2b`, `625753e` |
| bm48 | Rating writes `state`/`district` onto `udr_rated` (migration `0045`) | `b4d28e4`, `a563ace`, `4dd905e` |
| bm49 | Usage annex state → district from `udr_rated` (`INVOICE_USAGE_OVER_LIMIT`) | `f9fb724` |
| bm50 | Template catalog schema, seed, `invoice_settings` permission, grants (migration `0046`) | `ab736a3`, `e41c488` |
| bm51 | Generalized write-once blob store | `0c68a06`, `6ab17aa`, `a7e48ac` |
| bm52 | Prod `invoice-templates`/`invoice-assets` containers (bicep) | `7cfbe4d`, `82defcc` |
| bm53 | Resolution, checksum-verified load, seed upload | `3caddc5`, `82defcc`, `286a159` |
| bm54 | Posting-time version stamps on `customer_bill` | `805377a`, `87ca6a9` |
| bm55 | Invoice Settings shell, template read page, generator, live preview (migrations `0047`/`0048`) | `c692666`, `87ca6a9`, `286a159` |
| bm56 | Company profile read page | `98dc3ac`, `477fd0d` |
| bm57 | Template save draft | `0f17cc2`, `477fd0d` |
| bm58 | Template activate | `735bbce`, `efaff82` |
| bm59 | Profile save draft | `765e662`, `8d5d252` |
| bm60 | Logo upload + SVG sanitization | `da4cf9b`, `8d5d252`, `567ede9`, `0bd4a9c` |
| bm61 | Profile activate (G14: no four-eyes) | `68c0b81`, `8d5d252`, `567ede9`, `0bd4a9c` |
| bm62 | Invoice CSV output | `75fd10d` |
| bm63 | Ship gate: journey + admin e2e, layout lint, golden render, guardrail 56 upgrade path | `3ec1bae`, `dd2c5d7`, `f733095`, `614743a` |

**Durable decisions from this update:**

- **Owner decisions at the gate (2026-10-11):** G5 no `ONE_TIME` in v1; G8 IBM Plex embedded
  (v1 keeps placeholder `@font-face`, v2 ships the real fonts); G9 customer SST/PO/contract
  fragments hidden; G14 **no four-eyes** on profile activation (supersedes option C); G16 the
  app's Managed Identity for blob (flipped at cutover).
- **No legacy render path** (Inv #40); a tampered template/asset **parks** the account
  (`TEMPLATE_CHECKSUM_MISMATCH` / `ASSET_CHECKSUM_MISMATCH`), never falls back.
- **Seeded layouts are immutable** (Inv #44); the generator follows layout v1 as authored;
  generated/stored parity is `<body>`-only until layout v2 adds the annex CSS (known-issues §20).
- **While a draft exists it is the only editable version** (templates and profile); a no-change
  save writes nothing and no audit row.
- **Activate UI:** the page-level Activate is the one Deep Petrol button; the dialog's confirm
  is indigo primary, disabled until a change note is entered (the server still enforces
  `CHANGE_NOTE_REQUIRED`).
- **Logo:** an unsafe SVG is rejected, never stripped, by a linear hand-written scanner
  (namespaced elements included); max side `LOGO_MAX_SIDE_PX = 2000`.
- **CSV customer identity is read live** (accepted, known-issues §23j).
- **Layout v1 is final** after the SonarCloud accessibility fix (PR #156): `0046` was edited in
  place, so **environments that already ran `0046` must be reset** (known-issues §23k/§23l).
- Cross-domain: `auth/resolver.ts` `findActiveUserById` refuses a user owing a password change
  (closes the gap on the billing and GL-export Route Handlers).

### Invoice Template Phase 3 — COMPLETED (bm64–bm73, 2026-10-15 → 2026-10-19)

Bill Run uses the BAN's template. Spec per unit: `specs/bm64…bm73-*.md`; build plan `bm00` Part 5;
criteria 1–15 + evidence in `billmgmt-project-overview.md`. Full narrative, deviations, review-fix
logs, test runs and the Inv #51–#58 code ↔ test audit are in this file's git history (`5b5f746`).

| Unit | What | Commits |
| --- | --- | --- |
| bm64 | Standard template family `bill_template_family` (`BTF00000001`, `0046` edited in place, D26) | `0e65a57` |
| bm65 | Template stamps captured on `bill_run_account` at trigger and rerun (migration `0051`) | `9e399b7` |
| bm66 | Draft PRO-FORMA renders from the captured stamps (`RenderMode`, draft route 422) | `4139f02` |
| bm67 | Posting copies the run stamps + family onto `customer_bill` (migration `0052`), NULL-stamp skip | `976d2ca` |
| bm64–67 review | D58a blocking check, known-issues §24 a–i | `e83fb33` |
| bm68 | Capacity flow stops writing `additional_info.appendix`; two ratecard grants revoked | `762b6ab`, `80eebf8` |
| bm69 | Invoice dates `DD/MM/YYYY`, Mbps quantities | `206e08e` |
| bm70 | Page 1 capacity summary per service type; IBM Plex embedded | `9e8593a`, `e366579`, `5bc3867` |
| bm71 | Detail pages per service type × State-District; usage annex retired | `302e94f`, `b342a09`, `bbdc204` |
| bm72 | Total Amount page; `notes` → editable `footnote`; v1 pinned | `084944b`, `d223df0` |
| bm73 | Ship gate, manual run on owner data, three review rounds | `96fc861`, `449c63e`, `495d89c`, `5b5f746`, `b20256f` |

**Durable facts and decisions from this update:**

- **Capture once, render from the stamps (Inv #51–#54).** `captureTemplateStamps` stamps every
  non-EXCLUDED `bill_run_account` (five plain-key columns, no FK) at trigger and again at rerun
  (before the rerun audit); it resolves once per family via `resolveCurrentVersionsForFamily`.
  Drafts render in `run` mode from the stamps only; posting copies them plus
  `ref_bill_template_family_id`. `preview-family` mode is built only by `preview.ts`
  (guardrail 57). `listBanFamilies` is the one sanctioned billing read of the BAN's template
  reference (cm22 exemption, function body only).
- **NULL version (D55/D58/D58a).** A family with no ACTIVE/default version is stamped NULL (never
  EXCLUDED). The blocking pre-approval check `template_versions_captured` stops approval; the
  posting skip (`SKIPPED` / `TEMPLATE_VERSION_NOT_FOUND`, no INV, `BILL_RUN_ACCOUNT_SKIPPED`
  audit) stays as the backstop. Recovery = activate a version + rerun (journey 8e).
- **Layout v1 is final and pinned (Inv #57).** `tests/guardrails/invoice-template-v1-pin.test.ts`
  pins both `checksums.json` digests and the `0046` / `tests/helpers/seeded-invoice-template.ts`
  literals. Every environment needs one last reset: empty DB + empty `invoice-templates`
  container, then re-seed (bm64 runbook).
- **Invoice layout.** Page 1 = capacity summary per service type (`readCapacitySummary`, binder
  guards incl. `SUMMARY_BLOCKS_DO_NOT_ADD_UP`); detail pages per service type × State-District
  (`listCapacityDetailForInvoice`, `GROUPING SETS` Sub Totals, `INVOICE_POLYGON_DATA_MISSING`);
  last page = Total Amount + footnote. `totals.totalAmount` now means Σ Utilised; `amountDue`
  stays the bill total. Rates print at 2 dp (`udr_usage_rate::numeric(18,2)`). `polygon_id` is
  matched only at the key start or right after `|` (so `cell_polygon_id=` never matches); an
  empty value counts as missing. The CSV is unchanged but runs the detail guards. Structure is
  `{ sections: { payment }, columns: {}, footnote: string[] }`; the editor is RHF + `useFieldArray`.
- **Capacity flow (bm68).** No appendix is written; lines carry `pricing`/`calc`/`summary` only.
  Proven live on the bm73 manual run in place of the `ci` smoke script.
- **Business time zone (bm73).** The app sends `getAppTimezone()` (`APP_TIMEZONE`) as the flow
  input `business_timezone`; every `AT TIME ZONE` in `bill_run_processing.yml` and the Rated
  Lines / exception window use it. Trigger and rerun refuse with `BUSINESS_TIMEZONE_MISMATCH`
  unless it equals rating's deploy-time `period_of()` zone (`services/billing/rating-timezone.ts`,
  guardrail pins it to `0034`).
- **Period scope (bm73 review).** Every ACTIVE-subscription selection keeps to subscriptions
  overlapping the period. Validation and Collection take only the period's rows; other months
  stay `RATED` (`WINDOW_COVERAGE` retired). bm03's partial-period start rule now also needs
  `start_date <= period_end`.
- **Approval releases failed accounts' rows (known-issues §27 fixed).** Approve releases the
  `SKIPPED` accounts' claimed rows to `RATED` before `markApproved` (`releaseSkipped`, Inv #19).
  Under the run lock it runs only the blocking checks (`informational: false`).
- **Earlier-period usage (known-issues §28 option 1).** Unclaimed `RATED` usage dated before the
  period shows on the Exceptions tab as `PRIOR_PERIOD` ("Earlier period", grouped by the cycle's
  billing period) and as the informational check `prior_period_usage`. Revenue Ops owns it (and
  `EXCLUDED` accounts' unclaimed usage) and raises adjustments; a dashboard comes later.
- **`billrun_runtime` column grant.** `db/bootstrap/billrun-db-roles.sql` Step 5a's
  `GRANT INSERT (...)` on `customer_bill_line` now lists `rated_amount` + `additional_info`
  (bm41 latent gap); guardrail `billrun-flow-column-grants` pins it to the flow's INSERT.
- **Manual run baseline (2026-10-18).** `BRN00000001` on 4 BANs × 900 polygons (3,600 rated
  rows): clean-path system time ~1 min (processing ~10 s, posting ~12 s, distribution ~39 s),
  run total 172,635,900.00, 34-page PDFs (~197 KB). Owner's open visual check: the 34-page layout
  on INV00000001.pdf.
- **Final test baseline (2026-10-19):** unit 4640 (2 repo-scan timeouts under parallel load,
  pass alone); integration with the rating runtime 1388/0 (6 opt-in skips then run green);
  journey 19/19; Chromium e2e 3/3; admin e2e 5/5.

### Invoice Template Types — COMPLETED (bm74–bm85, 2026-10-25 → 2026-10-26)

Editor upload, type catalog, BAN binding. Spec per unit: `specs/bm74…bm85-*.md`; build plan `bm00`
Part 6 (the `74–85` numbering-record row); criteria 1–11 + evidence in
`billmgmt-project-overview.md`. CM side (cm23–cm24): `custmgmt-completed-tracker.md` Phase 3.

| Unit | What | Commits |
| --- | --- | --- |
| bm74 | Type-scoped template catalog (migration `0053`, two Drizzle mirrors) | `d1fbb92` |
| bm75 | Network-blocked, script-free Chromium rendering (`withHardenedPage`) | `a2a74d3` |
| bm76 | Layout rules module `compliance.ts` (static + visible tiers), `INVTPL-BASIC-A4` reference package | `d7bbca4` |
| bm74–76 review | xhigh review + two Sonar S5852 passes | `1abf17c`, `2aaec90` |
| bm77 | Type list, create type, per-type detail page (`[typeId]`), `app_runtime` grant | `e251953`, `fd1eb4e` |
| bm78 | Upload a layout package as a new draft (`fflate` gate, `installLayoutPackage`) | `6366487`, `1f1c895` |
| bm79 | Activate an uploaded draft pair, discard a draft, per-type generated blob path | `5367309` |
| bm77–79 review | Zip-bomb + deadlock fixes, draft preview, Sonar duplication helpers | `92cb0dc`, `ed84ccb` |
| bm80 | Overwrite an open layout draft by upload, with the warning (`DRAFT_LAYOUT_REPLACED`) | `508263a` |
| bm81 | Export a version pair and restore it by upload | `bf5e7c6` |
| bm80–81 review | max review of bm81 (15 findings, owner decisions #1/#2/#4/#5/#6/#14) | `8517e72` |
| bm82 | Bill run captures the BAN's type; Bound BANs column. One merge with cm23 (`567f4f8`) | `b5e4674`, `a3a716f` |
| bm83 | Retire a type with a bulk switch; retired read-only detail page | `eb41cbd` |
| bm84 | Rerun warns when a BAN's type changed since run start | `3e7d864` |
| bm83–84 review | Retire-dialog reset, single-read "retired", `countBoundBans`, pure `rerun-eligibility.ts` | `2e24298` |
| bm85 | Ship gate (journey steps 1–8, suites, invariant audit, doc fold). Joint with cm24 | `790c05e`, `907dca8` |

**Durable facts and decisions from this update:**

- **Catalog (`0053`, Inv #65).** `bill_template_family` is the template *type* (`layout_code` NOT
  NULL, `retired_datetime` one-way). One ACTIVE and one DRAFT per type and kind; composite FKs keep
  a settings version and its layout in the same type; type identity is frozen by the guard
  trigger. cm23's `0054` binds the BAN through `billing_account.ref_bill_template_family_id`
  (NULL = Standard) and drops the old version column.
- **Layouts enter only by upload, through the whole gate (Inv #59/#60).** `installLayoutPackage`
  is the single writer (`overwriteLayoutDraft` is called only by it; guardrail 68). The zip is read
  in two passes: central directory first, with nothing inflated, then a streamed inflate in 1 KiB
  steps under a running 2 MiB cap. Stages 1–3 block; stages 4–7 collect problems. Stage 7 reads both
  probe renders. Blobs are write-once under `layouts/<code>/v<n>-<digest12>/`; generated blobs go under
  `generated/INVOICE/<type code>/v<n>-<digest12>/`.
- **Rendering is hardened (Inv #64/#47).** `withHardenedPage` runs with JavaScript off and offline,
  and lets only `data:`/`about:` through. Blocked fetches are logged
  (`INVOICE_RENDER_BLOCKED_FETCH`) and never throw. The preview iframe is `sandbox=""`. Guardrail 74
  allows a single Chromium factory.
- **Compliance rules live in one file (Inv #63).** `compliance.ts` holds the lint, the editor's
  hardening, the static tier (`COMPLIANCE_PROBE`) and the visible tier (legibility, opacity ≥ 0.1,
  font ≥ 6px, each section exactly once). Both run at upload and again at activation. Known
  weakness: an empty-block-split URL (`url(http{{#if company}}{{/if}}://…)`) passes the lint, but
  stage 7's blocked render still refuses it.
- **Drafts never reach a bill (Inv #61/#62).** `loadLayoutDraft` is the only DRAFT loader; it is
  verified on every load and never cached. Activation promotes the *pair*: it re-runs compliance,
  then re-checks the token and the layout checksum under the lock. **Lock order:** type row, then
  the kind advisory lock, for every DRAFT writer (this fixed a 40P01 deadlock in save-draft).
  Discarded drafts (RETIRED, never activated) are EDIT-only. The draft preview (`draft: true`) is
  honoured only for EDIT on a draft's working copy.
- **Overwrite and restore (bm80/bm81, Inv #68).** An upload over an open DRAFT carries
  `expectedDraftVersionId`/`expectedDraftToken`, and a restore also carries `expectedSettingsToken`.
  A stale editor gets `DRAFT_LAYOUT_REPLACED` (plain overwrite) or `DRAFT_CONFLICT` (restore,
  written with `clock_timestamp()`). The export reads verified bytes in one REPEATABLE READ snapshot.
  The export route refuses `HEAD` (405) and cross-site requests (403), a recorded module exception
  to platform §5.9. `settings.json` is bound to the package's index digest and has its own 64 KiB
  budget. A NULL uploader reads "an unknown user" (owner).
- **Retire (bm83, Inv #66/#67).** One transaction locks ascending ids, switches every bound BAN to
  the target in a single set-based update (audit rows in chunks of 500), re-counts to zero, then
  retires the type. Retire is one-way. Save, preview, upload and activation refuse a retired type
  with `TEMPLATE_TYPE_RETIRED`, and its detail page is read-only (Export kept).
- **Capture reads the BAN's type (bm82, Inv #54 amend.).** `listBanFamilies` =
  `COALESCE(ba.ref_bill_template_family_id, default family)`. Billing's one `billing_account`
  writer is the retire switch in `template-types.ts` (CM guardrail 11 exemption).
- **Rerun warning (bm84).** `RerunDialog` shows a Warning callout listing BANs whose type changed
  since run start (`listRerunTemplateChanges`, `selectRerunEligible` in the pure
  `rerun-eligibility.ts`). It warns only; Confirm stays enabled.
- **Shared test helpers:** `tests/db/helpers/template-type-db-harness.ts`,
  `tests/db/helpers/template-type-fixtures.ts`, `tests/helpers/layout-package.ts`,
  `tests/helpers/in-memory-blob-store.ts`, `tests/helpers/list-source-files.ts`.
- **Final test baseline (2026-10-26):** typecheck + lint clean; unit 5050 passed, 1 failed
  (pre-existing `ratecard-demo-seed-boundary`); integration 148/148 files, 1416/0; journey file
  28/28 (bm63, bm73, Types); Chromium e2e 27/0; admin browser e2e 5/0; `invoice-editor` 147/0
  (contract unchanged since its snapshot).

### Standalone units after the Types update (bm86–bm88)

- **bm86** (2026-10-26, `b051641`) — company-profile logo: shorter side ≥ `LOGO_MIN_SIDE_PX = 96`
  (was 300; 3 × the header's 32 px logo height). No migration; stored logos unaffected.
- **bm87** (2026-10-28, `8ac1d54`) — Workflow tab `RunFlowProgressBar` redrawn as a dot stepper
  (markup only; props, export and server-component nature unchanged; plan
  `_change-billrun-flow-stepper-plan.md` §3.3).
- **bm88** (2026-10-29) — bm62 invoice CSV retired (owner decision, option B; spec
  `specs/bm88-retire-invoice-csv-output.md`). Migration `0055` (irreversible): drops
  `customer_bill`/`bill_run_account.ref_csv_template_version_id` + the CSV index and CSV-only
  `bill_template_version` indexes/CHECKs, deletes the `kind = 'csv'` rows under a one-time guard
  disable, and adds `btv_kind_check` (`layout | generated`) + `btv_has_family`. Removed: the
  Download CSV button, the `…/stored-invoice/[banId]/csv` route (now 404), `invoice-csv.ts`,
  `loadCsvMap`, the CSV stamp in capture/posting/resolution, seed files `system/csv/` and
  `BTV00000003` from the seed uploader (seed now uploads two versions; run it after `db:migrate`).
  Orphan `system/csv/v1/` blobs left in place (optional ops delete). Guardrail 55 retired;
  new `tests/guardrails/no-invoice-csv.test.ts`, `tests/db/retire-invoice-csv.integration.test.ts`,
  `tests/db/pdf-unchanged-after-csv-retire.integration.test.ts` (identical `final` / draft /
  `preview-family` HTML and stored PDF digest across `0055`). Known-issues §23j closed.
  Tests: unit 5017 passed / 8 failed under parallel load (all 10 s repo-scan timeouts; pass when
  re-run alone); integration 16 bm88-relevant files, 160/0 (full integration suite not run);
  tsc, ESLint, Prettier clean.
  SonarQube duplication fix: the two `0055` suites' shared setup (pre-0055 journal copy, 0054
  database + fixtures, CSV stamps, real-folder migrate, teardown) moved to
  `tests/db/helpers/csv-retire-fixtures.ts`; assertions unchanged.

### Review corrections (2026-10-29)

- **bm87:** keep the scroll region's focus outline visible in forced-colors mode
  (`focus:outline-hidden`), alongside the existing focus ring.
- **bm88:** complete the removal of the remaining stored-invoice CSV route, generator and
  their three feature suites; the retirement guardrail now also checks that the route and
  generator are absent. The stored-invoice PDF controls and unrelated bill-run routes are unchanged.
- Restore the update overview's delivered status, draft/discarded export EDIT gate,
  `settings.json` checksum exclusion/rejection and never-retired default-version rule.
- Validation: 405 unit/guardrail tests, 36 rm07 cases and 13 bm88 integration cases passed
  (454 distinct tests); lint, formatting and compiled focus CSS passed. Typecheck retains
  23 pre-existing legacy usage-annex errors; SAST retains one unchanged `.npmrc` finding.

## Outstanding / Next

- **Release gate before any production template activation (known-issues §20).** Seed
  **layout v2** as its own unit (new `v2/` directory, migration, checksums, Inv #44) with the
  usage-annex CSS and the real IBM Plex fonts (G8). Owner accepted the interim 2026-10-10.
- **Cloud cutover (gated ops step):** provision Key Vault secrets (`billrun-runtime-db-password`,
  `billrun-engine-url`/`-auth`, SFTP), flip `deployWorkflowEngine` → deploy engine →
  `deployRatingFlows` → `runBillrunLiveKestraSmoke` → `enableSftpDistribution` when a real SFTP
  exists. **Plus the G16 flip:** `appBlobAuth` → the app's Managed Identity (container-scoped
  `Storage Blob Data Contributor` on `invoices`, `invoice-templates`, `invoice-assets`), and
  drop the app's connection-string secret. No code change.
- **Before any prod deploy:** rotate `billrun-engine-auth` username to
  `workflow-ops@billing.ops` (coupled triple: engine, pipeline `--user`, KV secret) or every
  app→engine call 401s.
- **Redeploy `bill_run_processing`** with `deploy_workflow_flows` (bm42a + pm46a + bm68/bm73
  flow changes, incl. the `business_timezone` input).
- **Azure dev, before its first real bill run:** re-run the billrun role bootstrap (or apply
  `GRANT INSERT (rated_amount, additional_info) ON billing.customer_bill_line TO billrun_runtime`),
  and reset + re-seed for the pinned layout v1 (empty DB + empty `invoice-templates`).
- **Phase 3 open items:** draft preview times out on large invoices (known-issues §26);
  earlier-period rows reappear on every later run with no "handled" marker, unresolvable
  earlier-period rows are not counted, billing that usage (options 2/3) undecided
  (known-issues §28); partial index on unclaimed `RATED` rows deferred to rating
  (known-issues §29). (The deferred template family UI was delivered by the Types update, bm77.)
- **Types update carried items (not blocking):** the owner's manual passes are not recorded here —
  bm85 §3 (upload a real `INVTPL-WHOLESALE` editor export, steps 1–3 and 9 in two browser sessions;
  criterion 11's real-editor half) and bm87's browser check of the stepper. The bm58 activation
  suite is order-dependent in a full batch (known-issues §31d; passes alone). Known-issues §31's
  other display/logging items stay open. Three Types follow-ups stay open in the planning repo's
  `TODOS.md`.
- **Build a capacity-aware live-Kestra smoke harness (TC54).** `scripts/billrun-live-kestra-smoke.ts`
  is `ci`-seed-only; it needs a seed-profile parameter or a sibling script targeting `capacity`
  (four anchors, six `CAPACITY_*` guards, `CAPACITY_RATE_MATCHING` ON/OFF). Blocked on a live
  Postgres/Kestra stack.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles`.
- **DB verification:** run DB-gated suites + `db:seed-sample` only against a disposable/CI
  Postgres — never the shared dev DB (see test-safety gotchas).
- **Deferred from the bm77–bm79 review (owner, 2026-10-25; known-issues §30, improvements):** (a) one shared server-action guard
  (`requirePermission` + `isRedirectError` → FORBIDDEN/SERVER_ERROR), repeated in ~84 action files across
  every domain — its own cross-domain unit; (b) move the older template DB suites (bm58 activation,
  preview, capture, upload-logo) and `load.test.ts`'s blob mock onto
  `tests/db/helpers/template-type-db-harness.ts` / `tests/helpers/in-memory-blob-store.ts`.
- **Recorded cleanups (not scheduled):** share `buildInvoiceHtml`'s orchestration and the route
  auth preamble; the `lib/csv.ts` wire-format overlap. Owner-review items live in
  `billmgmt-design-review.md`.

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
  - **Dot stepper redraw (bm87, 2026-10-28).** `RunFlowProgressBar` is drawn as one rail
    of nine dots (glyph + label + sr-only state, rail filled through the last `done`
    step, `aria-current="step"` on `currentStage`, scrolls instead of wrapping). Markup
    only — no data, derivation, contract or caller change.

## Known residuals

- **Zero-charge account (Mitigated — skip shipped in `aa6f20a`; durable fix still OPEN;
  known-issues §11/§12).** _(Updated 2026-10-12, verified against dev1 `614743a`: the
  owner-decided skip is in code — `services/billing/post-run.ts` (~l.320–340) sets a
  zero-subtotal, zero-total bill's account to `SKIPPED` with `ZERO_TOTAL_NOT_INVOICED`, and
  `pre-approval-checks.ts` (~l.161) carries the informational `zero_total_bills` check. The
  durable fix — a conditional `ins_header` in `bill_run_processing.yml` (~l.1170, still
  unconditional) — remains OPEN.)_ The processor writes a
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
  results, untriaged — not a known regression. _(Updated 2026-10-12: no longer
  reproducing — the bm42a run (integration 1165/0) and the bm63 run (integration 1219
  passed / 0 failed, 75 skipped) were green. The original root cause was never triaged.)_

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
- **Scrub the env for integration runs (bm70).** `--env-file=.env` with only `DATABASE_URL`
  overridden inherits `BILLRUN_ENGINE_URL` and `BOOTSTRAP_DATABASE_URL`, so suites dispatch to
  the **dev** Kestra and run bootstrap scripts on the dev DB. Use a scrubbed env file (drop
  `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`, `BILLRUN_ENGINE_*`, `BILLRUN_BLOB_CONNECTION_STRING`)
  and a throwaway Postgres named `enterprise_billing` (pg_cron is bound to that name) + Azurite on
  10001; set `APP_TIMEZONE=Asia/Kuala_Lumpur` so trigger/rerun pass the zone guard.
- **`vitest run` picks up `.claude/worktrees/**`** and runs their integration files against
  `.env`'s dev DB — pass `--exclude ".claude/**"` until the config excludes it.
- **Dev DB leftovers:** rm13's live no-fan-out fixture (`_SAMPLE_-RM13` family, 25,000 records under "-25K" names) is
  left in the dev DB; the local Kestra rating flow carries an owner pin edit — deploy the bill-run
  flow via the API, not `flow-deploy`, to keep it.
- Context docs renamed from a `billling-` triple-l typo. 4 pre-existing
  hardcoded-date-drift subscription tests fail on a clean baseline (unrelated).

## Open questions

- **Receiver hardening deferred (out of bm36 scope).** The run-level `PROCESSING_FAILED`
  `/status` push has no attempt/stale-execution guard (unlike `DISTRIBUTION_*`), and
  `handle-status-push.ts`'s 409 messages are inverted. Fold into a receiver-touching unit.
  _(Updated 2026-10-12, reviewed against dev1 `614743a`: the missing attempt guard on the
  `PROCESSING_FAILED` push is still OPEN. The "inverted messages" claim did not reproduce —
  a distribution push to a `PROCESSING` run returns "Bill run is not DISTRIBUTING." and a
  `PROCESSING_FAILED` push to a `DISTRIBUTING` run returns "Bill run is not PROCESSING.",
  each naming the state the pushed status requires.)_
- **OPEN (bm46) — TC54's harness doesn't exist.** Extend `billrun-live-kestra-smoke.ts` with a
  seed-profile parameter, or add a sibling script — owner decision pending a live stack.
- **OPEN (bm46) — O-TC7, partial-period capacity billing.** Unresolved **business** decision
  (known-issues §17); capacity accounts stay `EXCLUDED` for a partial period. Never build a
  pro-ration method without this decision.
- **Resolved, for reference:** bm37 per-account HARD failure leaves the run `PROCESSED`
  (option (a), 2026-09-16); bm47's "block final renders until bm54" is moot (bm54 delivered);
  the bm55 review items (indexes `0047`/`0048`, LF pins, `archive.tar`) are done.
