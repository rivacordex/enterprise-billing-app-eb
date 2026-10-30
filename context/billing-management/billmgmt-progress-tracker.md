# Progress Tracker

Update this file after every meaningful implementation change.

_Compacted 2026-10-30 (earlier passes 2026-10-29, 10-25, 10-12, 10-07, 10-04, 09-16): per-unit
narratives, commit tables, superseded test baselines and review-fix logs dropped; durable facts and
decisions kept. Full history: `git log -- context/billing-management/billmgmt-progress-tracker.md`
(pre-compaction text at `d03489d9`, `8ac1d545`, `5b5f746`); per-unit detail:
`context/billing-management/specs/bm*.md`; defect detail: `billmgmt-known-issues.md`._

## Current state (2026-10-30)

- **All units bm01–bm88 COMPLETED.** Latest: bm88 retired the invoice CSV (2026-10-29); the
  intended invoice CSV is the reporting extract (`_newmodule-reporting-plan.md` Part D).
- **Taxation stays a no-op** (`tax_total = 0.00`), ratified as interim.
- **Cloud cutover is a gated ops step, not code** (bm38 wiring, deploy flags off by default);
  order of ops: `infra/docs/db-role-verification.md` "Production cutover".
- **wfm01:** `rating-engine/` → `workflow-management/`; flow paths are function-first
  (`flows/bill-run-processor/…`, `flows/bill-run-distributor/…`).

## Delivered units

| Update | Units | Completed | Scope |
| --- | --- | --- | --- |
| Phase 1 — control plane | bm01–bm13 | 2026-09 | RBAC, bill-run list + lazy materialization, trigger/scoping, M2M stage ingest, draft bill, rerun, INV posting, four-eyes approve, stall recovery, E2E ship gate |
| Phase 2 — boundary, rendering, distribution | bm14–bm21 | 2026-09 | `billrun_runtime` role + two-writer boundary, `_SAMPLE_` seed, engine registry, `udr_rated` lifecycle, PDF render + store, distribution flow |
| Phase 3 — real compute plane | bm22–bm35 | 2026-09 | `customer_bill_line`, real Collection/Aggregation/Verification, claim release, real SFTP distribution |
| Phase 4 — signal-back, prod wiring | bm36–bm39 | 2026-09-17 | Processor `http.Request` callbacks, live E2E smoke, bicep wiring; first real `SCHEDULED → COMPLETED` |
| Target Capacity Pricing | bm40–bm46, bm42a | 2026-10-10 | Commitment floor + motivation-discount bands, `CAPACITY_*` guards, checksum adds `rated_amount` |
| Invoice Template | bm47–bm63 | 2026-10-11 | Handlebars binder, template catalog, write-once blob store, Invoice Settings, logo, profile |
| Invoice Template Phase 3 | bm64–bm73 | 2026-10-19 | BAN's template family, stamps captured at trigger/rerun, new invoice layout |
| Invoice Template Types (+ cm23–cm24) | bm74–bm85 | 2026-10-26 | Type catalog, layout upload gate, hardened rendering, export/restore, retire, BAN binding |
| Standalone | bm86–bm88 | 2026-10-29 | Logo min side 96 px; Workflow-tab dot stepper; invoice CSV retired |

Criteria + evidence for the template updates: `billmgmt-project-overview.md`. CM side:
`custmgmt-completed-tracker.md` Phase 3.

## Key decisions (durable)

### Core bill run

- **Three snake_case permissions** (`billrun_view/operate/approve`) for segregation of duties;
  permission rows in a migration, grants in a seed.
- **Write-then-signal (D6):** the flow (as `billrun_runtime`) writes bill data and signals; the
  app receiver is **record-only** (`TERMINAL_STAGE = 'verification' → PROCESSED`). Idempotency is
  solely the UNIQUE `(run, ban, stage, attempt, period_partition)` on `bill_run_account_stage`; a
  stale-attempt signal is an accepted no-op.
- **Two-writer boundary:** the app's only `rating` write is the claim columns via
  `udr-status.repository.ts`; `billrun_runtime` has no table-level `DELETE` on
  `customer_bill_line` (scoped `SECURITY DEFINER` is the only deletion path);
  `billrun_status_guard` / `rating_status_guard` enforce transitions at the DB. The grant file is
  `db/bootstrap/billrun-db-roles.sql` (not a Drizzle migration); its `customer_bill_line` column
  grant includes `rated_amount` + `additional_info` (guardrail `billrun-flow-column-grants`).
- **Trigger** calls the engine inside the txn (full rollback if unreachable). Reject = release
  claimed rows to `RATED`, run stays `PROCESSED`. A per-account HARD failure leaves the run
  `PROCESSED` (account `SKIPPED` at approval, rerunnable; bm37 option (a)).
- **Approve** runs five pre-approval checks (only blocking ones under the run lock) and releases
  `SKIPPED` accounts' claimed rows to `RATED` before `markApproved` (Inv #19).
- **Posting:** per-account txn, resumable, one INV per bill (structural latch), `charge_checksum`
  computed in SQL over `customer_bill_line` business content (incl. `rated_amount`, 8th element).
- **RECURRING exactly-once = whole-account line replace**; the price snapshot is read, never
  re-resolved, on rerun (Inv #20).
- **Stall** (`isStalled`) and the Workflow tab's `scoping`/`posting`/`rendering` stages are
  **derived on read, never stored** (Inv #12; a real stage row always wins). Run-level
  `RunFlowProgressBar` is a nine-dot stepper (bm87).
- **Next-cycle operability keys off `INVOICED`, not `COMPLETED`.**
- **Uncharged** = no `customer_bill_line`; `BILL_NOTUSED` has its own exception surface;
  unresolvable subscribers are surfaced, not dropped.
- **Period scope:** every ACTIVE-subscription selection keeps to subscriptions overlapping the
  period; Validation/Collection take only the period's rows (other months stay `RATED`).
- **Earlier-period usage (known-issues §28 option 1):** unclaimed `RATED` usage before the period
  shows as `PRIOR_PERIOD` on Exceptions + informational check `prior_period_usage`; Revenue Ops
  owns it (and `EXCLUDED` accounts' usage).
- **Business time zone:** the app passes `getAppTimezone()` as flow input `business_timezone`;
  trigger/rerun refuse with `BUSINESS_TIMEZONE_MISMATCH` unless it equals rating's `period_of()`
  zone (`services/billing/rating-timezone.ts`, pinned to `0034`).
- **Hand-authored partitioned migrations;** `drizzle-kit generate` retired past `0026`. Run
  `db:migrate` then `db:setup-partman-billing`.

### Capacity pricing

- Six HARD `CAPACITY_*` guards; verification replays `rated_amount` with a Model-2 cross-check
  gated by `CAPACITY_RATE_MATCHING` (default ON). Trace money is canonical-scale **text**; window
  functions stay outside `jsonb_agg` (guardrail). No appendix written since bm68 — lines carry
  `pricing`/`calc`/`summary` only.

### Invoice templates and rendering

- **Owner decisions (2026-10-11):** G5 no `ONE_TIME`; G8 IBM Plex embedded; G9 customer
  SST/PO/contract fragments hidden; G14 **no four-eyes** on profile activation; G16 app Managed
  Identity for blob (flipped at cutover).
- **No legacy render path** (Inv #40); a tampered template/asset **parks** the account
  (`TEMPLATE_CHECKSUM_MISMATCH` / `ASSET_CHECKSUM_MISMATCH`), never falls back.
- **Capture once, render from the stamps (Inv #51–#54).** `captureTemplateStamps` stamps every
  non-EXCLUDED `bill_run_account` at trigger and rerun, reading the BAN's type via
  `listBanFamilies` (`COALESCE(ba.ref_bill_template_family_id, default family)`, the one
  sanctioned billing read). Drafts render in `run` mode from stamps; posting copies them onto
  `customer_bill`. `preview-family` mode only from `preview.ts` (guardrail 57).
- **NULL version (D55/D58/D58a):** stamped NULL, blocked by `template_versions_captured`; posting
  skip (`TEMPLATE_VERSION_NOT_FOUND`) is the backstop. Recovery = activate + rerun.
- **Layout v1 is final and pinned (Inv #44/#57)** by `tests/guardrails/invoice-template-v1-pin.test.ts`.
  `0046` was edited in place: every environment needs one reset (empty DB + empty
  `invoice-templates`, re-seed).
- **Invoice layout:** page 1 capacity summary per service type; detail pages per service type ×
  State-District with Sub Totals; last page Total Amount + footnote. `totals.totalAmount` = Σ
  Utilised, `amountDue` = bill total. Dates `DD/MM/YYYY`, rates 2 dp, Mbps quantities.
  `polygon_id` matches only at key start or after `|`.
- **Catalog (`0053`, Inv #65):** `bill_template_family` is the template *type*; one ACTIVE + one
  DRAFT per type and kind; kinds are `layout | generated` only (`btv_kind_check`, bm88). BAN binds
  via `billing_account.ref_bill_template_family_id` (NULL = Standard).
- **Layouts enter only by upload (Inv #59/#60)** through `installLayoutPackage` (single writer,
  guardrail 68): two-pass zip read under a 2 MiB streamed cap; stages 1–3 block, 4–7 collect;
  blobs write-once under `layouts/<code>/v<n>-<digest12>/`.
- **Hardened rendering (Inv #64/#47):** `withHardenedPage` — JS off, offline, only
  `data:`/`about:`; blocked fetches logged, never thrown; preview iframe `sandbox=""`; single
  Chromium factory (guardrail 74).
- **Compliance rules in one file (Inv #63):** `compliance.ts`, run at upload and activation.
  Known weakness: an empty-block-split URL passes the lint but stage 7's render refuses it.
- **Drafts never reach a bill (Inv #61/#62):** `loadLayoutDraft` is the only DRAFT loader,
  verified every load, never cached. Activation promotes the pair. **Lock order:** type row,
  then kind advisory lock, for every DRAFT writer. While a draft exists it is the only editable
  version; a no-change save writes nothing.
- **Overwrite/restore (Inv #68):** stale editors get `DRAFT_LAYOUT_REPLACED` / `DRAFT_CONFLICT`.
  Export route refuses `HEAD` (405) and cross-site (403) — recorded exception to platform §5.9.
- **Retire (Inv #66/#67):** one-way; one txn switches bound BANs set-based (audit in chunks of
  500) then retires; retired types refuse writes with `TEMPLATE_TYPE_RETIRED`. Billing's one
  `billing_account` writer is this switch. Rerun warns (does not block) when a BAN's type changed.
- **Logo:** unsafe SVG rejected (never stripped); shorter side ≥ 96 px, max side 2000 px.
- **Activate UI:** page-level Activate is the one Deep Petrol button; dialog confirm is indigo
  primary, disabled until a change note is entered.
- **Invoice CSV retired (bm88, `0055` irreversible).** No CSV route, generator, stamp or seed;
  guardrail `tests/guardrails/no-invoice-csv.test.ts`. Orphan `system/csv/v1/` blobs may be
  deleted by ops. Seed uploader now uploads two versions — run it after `db:migrate`.
- Cross-domain: `findActiveUserById` refuses a user owing a password change.

### Kestra 1.3.35 expression rules (live-run hardening, 2026-09-17)

- A `ForEach` value reaches only DIRECT children; use `parent.taskrun.value` / `parents[0]`;
  nested task outputs are keyed by both loop values (`outputs.x[outer][inner]`).

## Outstanding / Next

- **Release gate before any production template activation (known-issues §20):** seed layout v2
  as its own unit (new `v2/`, migration, checksums) with usage-annex CSS + real IBM Plex fonts.
- **Cloud cutover (ops):** provision Key Vault secrets, flip `deployWorkflowEngine` → deploy
  engine → `deployRatingFlows` → `runBillrunLiveKestraSmoke` → `enableSftpDistribution`; G16 flip
  of `appBlobAuth` to the app's Managed Identity (Blob Data Contributor on `invoices`,
  `invoice-templates`, `invoice-assets`) and drop the connection-string secret.
- **Before any prod deploy:** rotate `billrun-engine-auth` username to `workflow-ops@billing.ops`
  (engine, pipeline `--user`, KV secret together) or every app→engine call 401s.
- **Redeploy `bill_run_processing`** with `deploy_workflow_flows` (incl. `business_timezone`).
- **Azure dev, before its first real bill run:** re-run the billrun role bootstrap and reset +
  re-seed for pinned layout v1.
- **Open items:** draft preview times out on large invoices (§26); earlier-period rows have no
  "handled" marker and billing them is undecided (§28); partial index on unclaimed `RATED` rows
  deferred to rating (§29); bm58 activation suite order-dependent (§31d); other §31 items.
- **Owner manual passes not recorded:** bm85 §3 (real `INVTPL-WHOLESALE` upload, two sessions)
  and bm87's browser check. Three Types follow-ups in the planning repo's `TODOS.md`.
- **TC54:** capacity-aware live-Kestra smoke (seed-profile param or sibling script); blocked on a
  live stack.
- **Deferred (known-issues §30):** shared server-action guard across ~84 action files
  (cross-domain unit); move older template DB suites onto the shared harness / in-memory blob
  store.
- **Recorded cleanups (unscheduled):** share `buildInvoiceHtml` orchestration and the route auth
  preamble. Owner-review items: `billmgmt-design-review.md`.

## Known residuals

- **Zero-charge account (§11/§12):** posting SKIPs a bill with subtotal and total both exactly
  zero (`ZERO_TOTAL_NOT_INVOICED`, no INV number); informational `zero_total_bills`. Negative and
  tax-only bills are never skipped. Re-evaluate when discounting ships. Durable fix (conditional
  `ins_header` in `bill_run_processing.yml`) still OPEN.
- **Post-posting immutability (accepted):** no DB trigger on posted `customer_bill_line`;
  `charge_checksum` not re-verified after posting.
- **§4c E2E `INVOICED` vs `DISTRIBUTING`:** no longer reproducing; root cause never triaged.

## Open questions

- **Receiver hardening:** the run-level `PROCESSING_FAILED` `/status` push has no
  attempt/stale-execution guard. Fold into a receiver-touching unit.
- **O-TC7, partial-period capacity billing:** unresolved business decision (§17); capacity
  accounts stay `EXCLUDED` for a partial period. Never build pro-ration without it.

## Environment / test-safety gotchas

- **DB-gated suites are destructive (§13).** They `DROP SCHEMA … CASCADE` and rewrite shared role
  passwords; `globalSetup` refuses unless `DESTRUCTIVE_DB_OK=1` **and** the disposable sentinel is
  present. Run only on a disposable Postgres with the engine stopped — never the shared dev DB.
- **Scrub the env for integration runs:** drop `DATABASE_URL`, `BOOTSTRAP_DATABASE_URL`,
  `BILLRUN_ENGINE_*`, `BILLRUN_BLOB_CONNECTION_STRING`; throwaway Postgres named
  `enterprise_billing` (pg_cron) + Azurite on 10001; `APP_TIMEZONE=Asia/Kuala_Lumpur`.
- **`vitest run` picks up `.claude/worktrees/**`** — pass `--exclude ".claude/**"`.
- **Repo-scan unit tests time out (10 s) under parallel load;** they pass alone.
- **`.gitattributes` pins `*.sql eol=lf`** — CRLF once silently no-op'd two `[CRITICAL]` guardrails.
- **After pulling grant-file changes:** re-run `db:bootstrap-billrun-roles`.
- **Clean local stack:** bootstrap runtime DB roles + passwords by hand; `dev:azurite-init`
  (`kestra-internal`); Azurite `-l /data`; `extra_hosts: app:host-gateway`; `BILLRUN_APP_TOKEN` =
  base64-decoded `SECRET_BILLRUN_APP_TOKEN`.
- **Local render/runs need a host-side dev server** (container has no Playwright browser and
  can't dispatch to the engine); keep `npx playwright install chromium` current; the container
  app must stay up for `http://app:3000` callbacks.
- **Dev DB leftovers:** rm13's `_SAMPLE_-RM13` fixture (25,000 records); the local Kestra rating
  flow carries an owner pin edit — deploy the bill-run flow via the API, not `flow-deploy`.
- 4 pre-existing hardcoded-date-drift subscription tests fail on a clean baseline; the
  `ratecard-demo-seed-boundary` unit test fails pre-existing.
