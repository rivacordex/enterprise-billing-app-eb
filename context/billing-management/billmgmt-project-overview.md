# Billing Management Module — Project Overview

## Overview

The Billing Management Module is the section of the Enterprise Billing App (Telco)
where the **Revenue Operations (RevOps)** team executes and controls monthly bill
runs. It manages the operational instance of a billing cycle (`bill_run`), the
per-account state inside that run (`bill_run_account`, `bill_run_account_stage`),
the draft bill assembled for each billing account (`customer_bill`,
`customer_bill_line`, `customer_bill_tax_item`), the final stored invoice PDF
(`bill_run_invoices`), and the distribution outcomes (`bill_run_distribution`).
The module provides a "Billing" navigation section whose Bill Runs pages let RevOps
see which run is current for each cycle, trigger it, watch it progress stage by
stage, review every customer's draft bill (and a PRO-FORMA preview) on screen,
reject or rerun accounts while the run is unapproved, and — under a four-eyes gate —
approve it, which posts one `INV` document per billed account through the existing
Accounts document engine into pgledger, renders and stores each final invoice, and
distributes the invoices + run report over SFTP.

**The bill run performs no usage rating.** Usage is rated continuously by an
external engine and lands as already-rated Usage Detail Records in
`rating.udr_rated`; the bill run **collects (claims)** the records due for the
period and bills them. Recurring charges are **derived by the bill run** from
`inventory.product_inventory` (not rated). The run is orchestrated by a **workflow
engine** — deployed as **Kestra** (OSS), though the schema and app stay
vendor-neutral ("workflow" naming) — which runs the real compute pipeline as the
least-privilege `billrun_runtime` role and writes the bill data itself, signalling
the app on each stage (write-then-signal). The placeholder/stub-data mode of
earlier phases has been retired; the pipeline runs against real Postgres, real
Kestra, a real blob store and a real SFTP endpoint.

> **Current state (2026-09-16).** The compute, posting, rendering and distribution
> planes are all built and real (Phases 1–3, bm01–bm35), and **Phase 4 is
> delivered (bm36–bm39):** the processor signal-back is real (bm36 —
> `bill_run_processing.yml` POSTs a per-stage `DONE` after each stage, a per-account
> HARD `FAILED`, and a run-level terminal `PROCESSING_FAILED` for a whole-execution
> failure via `errors: on_error` on `FAILED` / `afterExecution: on_killed` on a
> KILL, all real `http.Request` mirroring the distributor, bm34); the full local
> `SCHEDULED → COMPLETED` lifecycle is asserted end-to-end on the `ci` seed by the
> live-Kestra smoke (bm37); the production deploy path is deployable + wired, still
> gated (bm38); and bm39 audited the assembled phase and signed it off. A triggered
> run now drives itself `SCHEDULED → COMPLETED` on its own with no out-of-band calls;
> a contained per-account HARD failure leaves the run `PROCESSED` with the failed
> account skippable/rerunnable. **The one remaining item is the cloud cutover** —
> flipping the deploy flags and running the smoke against a real engine + SFTP — a
> gated ops step, not a module-build gap (see the Phase 4 section below).
> Taxation is a ratified `0.00` interim. **The Target Capacity Pricing update
> (bm40–bm46) is delivered** — a commitment floor + motivation discount for
> RAN_USAGE capacity offerings, computed as inline SQL in the existing
> `bill_run_processing` flow, plus a per-polygon invoice usage appendix (see the
> Target Capacity Pricing update section below). **Outstanding for that update:**
> the live-Kestra capacity journey (TC54) and its DB-gated suites have not been
> run against a live Postgres/Kestra stack in this checkout's environment
> (`billmgmt-progress-tracker.md`), and **O-TC7** (partial-period capacity
> billing) remains an open business decision.

## Lifecycle

```
SCHEDULED → PROCESSING → PROCESSED → APPROVED → POSTING → INVOICED → DISTRIBUTING → COMPLETED
```

plus two rerunnable failure states `PROCESSING_FAILED` and `DISTRIBUTION_FAILED`,
and `CANCELLED`. `INVOICED` means financially complete (postings done, invoice
numbers consumed); `COMPLETED` means operationally complete. **Next-cycle
operability keys off `INVOICED`**, so a stalled distribution target can never block
next month's billing. Run status is always recomputed under a `bill_run` row lock
from `bill_run_account`, never by incrementing a counter.

## Core user flow

1. **Materialise.** RevOps opens Billing → Bill Runs. On load the page lazily
   inserts the current period's `bill_run` (`SCHEDULED`) for each active cycle
   (`ON CONFLICT (cycle, period_start) DO NOTHING`, concurrency-safe). No scheduler,
   cron, or background worker in the app. In-arrears window: a `cycle_day`-1 monthly
   cycle's July run appears on 1 August; `scheduled_run_date = period_end + 1`.
2. **Trigger.** A `billrun_operate` user selects the operable run and clicks Run.
   The service snapshots every eligible account into `bill_run_account` (freezing
   the population), sets the run `PROCESSING`, and triggers **Kestra execution #1
   (processing)** with `{bill_run_id, period_start, period_end, ban_ids, attempt,
gl_event_at}`. A second click while an execution is live is rejected.
3. **Process (execution #1, as `billrun_runtime`).** Per account, fanned out:
   - **Validation** asserts currency (`= billing_account.currency`) and window
     coverage against the correlated set (below). Zero-claimable is a zero-charge
     `DONE`, not an error.
   - **Collection** resolves each `RAN_USAGE` row `udr_subscriber_ref_id →
inventory.product_inventory → billing_account_id` (set-based, once per run),
     then claims the in-scope rows `RATED → BILL_DRAFT`, stamping the six claim
     columns. An unresolvable subscriber is left `RATED`/unclaimed and surfaced,
     never dropped or failed.
   - **Aggregation** writes one `customer_bill` (`category='trial'`) plus its
     `customer_bill_line` rows at grain `(product_offering_id, udr_type)` — USAGE
     rolled from claimed `udr_rated`, RECURRING derived from `product_inventory`
     and priced as-of with the resolved price **snapshotted** onto the line.
     `subtotal = SUM(net_amount)`.
   - **Taxation** (interim `0.00`) and **Verification** (incl. bill↔charge
     reconciliation) run; execution #1 terminates at `PROCESSED` (it does not wait
     for approval).
4. **Review.** RevOps opens the drill-down: Workflow (stage timeline + pre-approval
   checks), Customers & Bills (`customer_bill_line` rows as the invoice's face, the
   `udr_rated` records as per-subscription drill-down, PRO-FORMA preview), Uncharged
   (accounts that produced **no** charge line), Errors, Distribution, and Audit tabs.
5. **Reject / Rerun (optional).** Reject (a `billrun_approve` action) or rerun (a
   `billrun_operate` action, mandatory reason, audit-before-retrigger) **releases**
   the claimed rows back to `RATED` with all four claim columns cleared, and
   re-derives the trial bill as a whole-account replace. While rows are still
   claimed, a rating reload is refused whole with `LOAD_BLOCKED_INFLIGHT`.
6. **Approve → Post.** A **different** `billrun_approve` user (≠ the final trigger
   actor) approves after the pre-approval checks pass; claimed rows flip
   `BILL_DRAFT → BILL_APPROVED`; the run moves `APPROVED → POSTING`. Per account, in
   its own transaction: compute `charge_checksum` over the account's
   `customer_bill_line` rows, create and auto-post one `INV` through the Accounts
   engine (consuming the invoice number), then render the final PDF and store it in
   `bill_run_invoices`. Failed accounts are `SKIPPED`; already-invoiced accounts are
   skipped on retry (resumable). When all are terminal the run reaches `INVOICED`
   and the next cycle unblocks.
7. **Distribute → Complete (execution #2).** The app triggers **Kestra execution #2**
   with one `invoice_pdf` artifact per stored invoice plus a `report_csv` and the
   environment's target list. The flow downloads each artifact from blob storage and
   SFTPs it to its remote path, POSTing a `DELIVERED`/`FAILED` outcome per artifact.
   Every mandatory artifact delivered to every mandatory target → `COMPLETED`; any
   mandatory failure → `DISTRIBUTION_FAILED`, rerunnable (only the failed artifacts).
8. A `billrun_view` user can follow all of the above read-only, with no mutating
   action visible.

## Architecture & boundaries

- **Workflow engine.** Two Kestra executions per run — `bill_run_processing` and
  `bill_run_distribution` — deployed to the `billrun` namespace on a shared
  `workflow-engine` Container App (collapsed topology; the rating flows share it).
  The app triggers/reconciles/cancels via an out-of-band `billrun-engine-auth`
  credential; the flows call back over M2M (bearer `BILLRUN_APP_TOKEN`).
- **Two-writer charge boundary (Postgres grants).** `billrun_runtime` writes the
  bill data (`customer_bill` trial columns, `customer_bill_line`,
  `customer_bill_tax_item`) and holds `SELECT`+`UPDATE` on only the six
  `rating.udr_rated` claim columns; it holds **no** table-level `DELETE` on
  `customer_bill_line` (the scoped `SECURITY DEFINER billrun_delete_trial_bill` is
  the only deletion path) and no write on run-state tables, `billing.document`,
  pgledger or `bill_run_invoices`. The **app** holds `SELECT`-only on
  `customer_bill_line`; its only `rating` write is the six claim columns via
  `db/repositories/billing/udr-status.repository.ts`. Role-aware triggers
  (`billrun_status_guard`, `rating_status_guard`) enforce the allowed transitions
  at the database. No cross-schema foreign keys in either direction.
- **Charge model.** `customer_bill_line` is the bill's durable stored charge record
  (the invoice's face), partitioned like `customer_bill`, `ON DELETE CASCADE` to its
  header. `charge_checksum` is re-anchored on `customer_bill_line`, hashing business
  content (all three money columns) so it covers every charge source and reproduces
  from an archived invoice; it is computed once at posting (no post-posting
  re-verification — a tracked residual).
- **Idempotency & signals.** Enforced solely by the DB unique constraint
  `(run, ban, stage, attempt, period_partition)` on `bill_run_account_stage` — a
  replayed signal is a 200 no-op; a signal after `APPROVED` is 409. The M2M
  completion call carries no charge payload; the app records what it is told and
  computes nothing (record-only; `TERMINAL_STAGE='verification'` flips the account to
  `PROCESSED`).
- **Retention & immutability.** Per-run record tables are partitioned on
  `period_partition` (monthly, 7-year detach-and-archive via `pg_partman`/`pg_cron`).
  Once `APPROVED`, the run's charge records are immutable for the invoice's statutory
  life (Inv. #14); a finalized `customer_bill` (carrying `ref_inv_document_id`) is
  DB-guarded against mutation/delete; `bill_run_invoices` rows are born immutable.

## In scope

- The "Billing" section: Bill Runs list (Current & Upcoming / Historical) and the run
  detail page (Workflow, Customers & Bills, Uncharged, Errors, Distribution, Audit),
  the approve/post views, and the PRO-FORMA / stored-invoice preview modals.
- `billing` schema tables: `bill_run`, `bill_run_account`, `bill_run_account_stage`,
  `customer_bill`, `customer_bill_line`, `customer_bill_tax_item`,
  `bill_run_invoices`, `bill_run_distribution`, `bill_template_version` — partitioned
  where per-run.
- The real `bill_run_processing` flow (validation, correlation-based collection,
  two-source aggregation, taxation, verification) and the real `bill_run_distribution`
  flow (blob download → SFTP upload → outcome POST, multi-target).
- Recurring charge derivation from `inventory.product_inventory` with as-of pricing +
  snapshot; the `billrun_runtime`/`app_runtime` grants and the two status-guard
  triggers.
- Additive Accounts-owned objects: `document_inv_seq`, `'INV'` document type, the
  unlimited-`autoPostLimit` INV reason code, GL mapping rows, and the period-close
  guard.
- Route handlers under `app/api/billrun/` (stage-complete, status,
  distribution/outcome — service-token authed) and server actions (trigger, rerun,
  cancel, reject, approve, post). Materialization is the write on the list page's
  server render, not an action.
- RBAC: `billrun_view` / `billrun_operate` / `billrun_approve` (operate & approve
  imply view), the Billing Viewer role, and four-eyes in the service layer.
- The `RAN_USAGE` sample seed (`ci` + `volume` profiles, six scenarios) and the
  vitest suites plus the end-to-end journey.

## Out of scope / interim decisions

- **Real taxation** — ratified `0.00` interim; `total = subtotal`. Single-rate
  `BILLRUN_TAX_RATE` config exists; no jurisdiction/category catalog.
- **OCC (one-time / multi-cycle) charges and discounts** — `source`/`line_type`
  reserved; no occurrence ledger, no discount compute. Manual DBN/ADJ/CRN via
  Accounts → Transactions.
- **Proration** — a partial-period account (mid-period start/cease/suspend) is
  `EXCLUDED` before the flow runs and bills from the next full cycle; excluded
  accounts/subscriptions appear on Uncharged.
- **Off-cycle / on-demand runs, multi-frequency cycles, scheduled (cron) creation,
  per-invoice approval, TMF REST surface** — modelled or deferred, not built.
- **Distribution targets beyond SFTP + loopback**, a stored `bill_run_output`
  report, and **Kestra Enterprise / scoped per-flow tokens** — deferred.
- **Production cutover** — the deploy path is being made deployable + wired in
  Phase 4; the live cloud run is a gated ops step, not part of the module build.

## Phase 4 — signal-back, self-driving lifecycle & production wiring (delivered, bm36–bm39)

_Folded from the former Phase-4 update overview (2026-09-16). Users: RevOps (in-app) and BSS Ops (Kestra engine + deploy layer). Phase 4 introduced **no new database schema or migrations** — its surface was flow YAML + bicep + Key Vault secrets + a smoke test._

Phases 1–3 built the whole machinery, but a triggered run could not finish on its own: the processing flow's signal-back was stubbed (`bill_run_processing.yml` carried `io.kestra.plugin.core.log.Log` placeholders, zero `http.Request` tasks), so accounts never auto-reached `PROCESSED` and the run wedged in `PROCESSING`. Phase 4 wired that signal-back (success **and** terminal failure), proved the full `SCHEDULED → COMPLETED` lifecycle locally on the `ci` seed, and made the production deploy path deployable-and-wired — the cloud cutover left as a gated ops step.

- **Processor signal-back (bm36 — the unblocker).** After each stage's SQL the flow POSTs a per-stage `DONE` to `/api/billrun/{runId}/stage/{stage}/complete` (`Authorization: Bearer {{ secret('BILLRUN_APP_TOKEN') }}`, body `{ban_id, attempt, status: DONE|FAILED, error_class?, error_code?, error_detail?}`, no charge payload — the receiver stays record-only). Real `errors: on_error` (terminal `FAILED`) and `afterExecution`/`on_finally` (terminal `/status` only for a `KILLED` whole-execution failure) POSTs replace the `Log` stubs, with `attempt`-guarded idempotency, retry/`allowFailure`, and `host.docker.internal` reachability — mirroring bm34's distributor callbacks verbatim.
- **Failure model.** A contained **per-account** HARD failure is a `WARNING` execution: the account settles to `PROCESSING_FAILED` via its own `FAILED` stage POST while the run derives `PROCESSED` (a mixed terminal set), with the failed account `SKIPPED` at approval and the run rerunnable. A **whole-execution** failure (`FAILED` via `on_error`, or a KILL via `afterExecution: on_killed`) settles the run itself to `PROCESSING_FAILED` — no run-level terminal push for a partial run.
- **End-to-end assertion + reconcile alignment (bm37).** `scripts/billrun-live-kestra-smoke.ts` drives and asserts the full `SCHEDULED → COMPLETED` journey on the `ci` seed — including reject → re-rate → reprocess, a forced processing failure that settles, and distribution with a forced mandatory failure → `DISTRIBUTION_FAILED` → rerun — and confirms the stall/reconcile gate no longer fires on a healthy run while still catching a wedged one (closing the bm16/bm20 live-Kestra gate locally).
- **Production wiring (bm38 — deployable, gated).** Key Vault secrets + consumer mapping into the shared `workflow-engine` Container App bicep: the `billrun_runtime` DB credential as the `billrun-runtime-db-password` bare-password secret + the `BILLRUN_DB_*` split coords the flow actually reads (**not** the superseded `BILLRUN_RUNTIME_DATABASE_URL` URL), plus `billrun-engine-auth`/`-url` and the SFTP key/known-hosts, and the `billrun_runtime` password provisioning step. No new container — the collapsed-topology shared engine already hosts the `billrun` namespace and the `local-dev` flow is promoted as the production flow. Deploy flags (`deployWorkflowEngine`, `deployRatingFlows`, the billrun flow deploy, `runBillrunLiveKestraSmoke`) are readied but gated; the `template.yml` "separate repo, TBD owner" fiction is corrected; the taxation-`0.00` interim and the cutover runbook are recorded.
- **Phase-4 exit (bm39).** The assembled phase was audited and signed off — signal-back incl. `FAILED` settlement, the reject/reprocess and distribution paths, and the prod-wiring artifacts all present and green; the full local journey run as the phase proof; no new schema/migration; `billmgmt-progress-tracker.md` updated and `billmgmt-known-issues.md` §9 closed. **The remaining item is the cloud cutover** — flip the gated flags and run the smoke against a real engine + SFTP — a gated ops step, not a module-build gap.

## Target Capacity Pricing update — commitment floor, motivation discount & usage appendix (delivered, bm40–bm46)

_Folded from `billmgmt-update-overview.md` (2026-10-04) per the bm46 ship gate. Users: Revenue Operations (RevOps, in-app) and BSS Ops (Kestra engine). Full design detail (anchors, guards, verification identities, the N-band SQL, the appendix sourcing) stays in `billmgmt-update-overview.md` and `billmgmt-architecture.md` Inv #29–#38 — this section folds the delivered narrative into the module's current state, per the bm13/bm21/bm35/bm39 ship-gate convention._

Phases 1–4 billed usage and recurring charges at a flat per-unit rate. This update adds **target-capacity pricing** for RAN_USAGE offerings — a **commitment floor** (an account using less than its committed quantity is billed as if it used the target) and a **motivation discount** (usage above the target is billed at a lower per-unit rate, recorded as a discount) — computed as inline SQL in the existing `bill_run_processing` flow, plus a **per-polygon invoice usage appendix** grouped by state and district. A prerequisite repair (Unit 0) first fixed the recurring resolver, which a product change (PC14) had broken for every account by reshaping `product_offering_price` into one-row-per-component.

- **Unit 0 — foundation repair (bm40).** The recurring resolver repaired onto the PC14 component schema; the hand-copied flow-double test replaced by a harness that extracts and runs the real `bill_run_processing.yml` SQL; a fail-closed destructive-DB preflight added (and the cross-cluster `DROP DATABASE … WITH (FORCE)` removed).
- **Schema (bm41).** `customer_bill_line` gains `rated_amount numeric(18,2)` (NULL for RECURRING; = `gross_amount` on non-capacity USAGE) and `additional_info jsonb` (capacity lines only) — migration `0044`, the update's only migration — plus the three `billrun_runtime` read grants the capacity logic needs (`product_specifications`, `ratecard_ran_usage_lkp`, `ratecard_version`).
- **Capacity aggregation (bm42).** The commitment floor + N-band motivation discount as inline SQL CTEs in `aggregation`, keyed off the subscription's pinned offering version; six HARD guards (`CAPACITY_MULTIPLE_SUBSCRIPTIONS`, `_BASE_RATE_NOT_FOUND`, `_UDR_TYPE_MISMATCH`, `_RATE_MISMATCH`, `_MULTI_STEP_UNSUPPORTED`, `_CURRENCY_MISMATCH`) each fail only their own account while siblings bill; the `additional_info` calc trace; the `capacity_max_bands` single-band production guard.
- **Verification + the rate-matching gate (bm43).** USAGE lines replay against `rated_amount` (not `gross_amount`, which the top-up inflates); capacity lines replay their internal identities; an independent Model-2 cross-derivation (`max(Q, target) × baseRate`) checks Model 1 (the billed figure) without ever billing from it; `CAPACITY_RATE_MATCHING` (default ON) HARD-fails a mismatch, OFF logs a WARN and bills Model 1 anyway, recording the flag state.
- **Checksum + read model (bm44).** `charge_checksum` appends `rated_amount` as its last tuple element (never hashing `additional_info`); the bill-line read model surfaces `rated_amount`/`additional_info`; the Customers & Bills discount column un-suppresses for a capacity line's real discount.
- **Invoice usage appendix (bm45).** The posted invoice (final only, never the draft PRO-FORMA) renders every polygon's usage for the month below the capacity charge, grouped by state then district, with state/district joined from the `productCardLookUp` ratecard; bounded to ≤10,000 rows/account; a card-missing polygon is surfaced, not dropped. **Superseded by bm47 (Invoice Template update) — see below:** the binder has one input for both render modes, so this section (now the layout's `usageAnnex`) renders on the draft PRO-FORMA preview too; "final only" was a property of the legacy hardcoded template, not a durable rule.
- **Ship gate (bm46).** Audited the assembled update against guardrails 36–42 and invariants #29–#38; confirmed no migration beyond `0044`; synced this overview, `billmgmt-architecture.md`, `billmgmt-code-standards.md`, `billmgmt-known-issues.md` (the bm45 D2/D4 residuals, the TC40/TC55 rounding-drift residual, and O-TC7) and `billmgmt-progress-tracker.md`. **The live-Kestra capacity journey (TC54) and the DB-gated capacity suites remain outstanding** — not run against a live Postgres/Kestra stack in this checkout's environment; see `billmgmt-progress-tracker.md`. **O-TC7 (partial-period capacity billing) is an open business decision** — partial-period capacity accounts stay `EXCLUDED` until business settles whether/how to pro-rate.

## Invoice Template update — company profile, structure-configurable template, binder & CSV (delivered, bm47–bm63)

_Folded from `billmgmt-update-overview.md` Part 2 (2026-10-11) per the bm63 ship gate. Users: Revenue Operations billing admins (in-app, the `invoice_settings` permission) and developers (layout authoring in the repo). Source plan: `_updatemodule-billing-invoice-template-merged-plan.md` (its §15 v1 review, R1–R11, is authoritative). Invariants: `billmgmt-architecture.md` Inv #39–#50. Per-unit detail: `specs/bm47`–`bm63`; history and commits: `billmgmt-progress-tracker.md`._

**Delivered (bm47–bm63).** The invoice is bound to `customer_bill_line` and reconciled before it renders (bm47); rating persists `state`/`district` onto `udr_rated` (bm48) and the usage annex lists every billed row state → district (bm49); the template catalog, the default layout and the default generated/CSV versions are seeded (bm50); the blob store is generalized and the two app containers are declared in bicep (bm51–bm52); renders resolve pinned → ACTIVE → default from checksum-verified blobs (bm53) and posting stamps the four versions (bm54); the Invoice template editor (bm55, bm57, bm58) and the Company profile screen (bm56, bm59–bm61) ship; the CSV export lands (bm62); and the ship gate (bm63) proves criteria 1–12 on a fresh database (the journey) and in the browser (the admin e2e). **Decided at the gate (2026-10-11):** G5 no `ONE_TIME` in v1; G8 IBM Plex embedded (layout v1 carries placeholder font sources, layout v2 ships the real fonts); G9 customer SST/PO/contract fragments hidden, no columns; G16 the app's Managed Identity for blob (a cutover ops step). G14 (no four-eyes on profile activation) was decided the same day. **Residuals:** `billmgmt-known-issues.md` §18–§20 and §23.

### Overview

The Billing Management module runs the monthly bill run for Revenue Operations: it claims rated usage, derives recurring charges, assembles `customer_bill` + `customer_bill_line`, posts one `INV` document per account under a four-eyes gate, renders and stores the invoice PDF in `bill_run_invoices`, and distributes it over SFTP. Before this update the invoice was a hardcoded TypeScript template (`render-invoice-template.ts`) whose renderer read `rating.udr_rated`, so it omitted recurring, one-time and discount charges. The update replaced it with three things: (1) one global, versioned **company profile** (issuer name, SSM no., TIN, SST no., address, bank details, colours, and a required logo) edited under Administration › Invoice Settings; (2) one developer-authored **Handlebars layout** (`INVTPL-STD-A4`) shared by every MNO, where billing admins can only show/hide optional sections and charge-detail columns, each activation generating an immutable `invoice.hbs` + `footer.hbs` version stored write-once in the blob store; and (3) a **binder** that builds the render input from `customer_bill_line`, `customer_bill_tax_item`, `billing.document` and `customer.organization`/`contact_medium`, including a detailed usage section grouped state → district. The template and profile versions used are stamped on the bill at posting, so an issued invoice never changes. Scope is the tax invoice only; outputs are PDF, HTML and CSV.

### Goals

1. **Bind the invoice to the real charge record first (R1, R10).** Re-point the renderer from `rating.udr_rated` to `customer_bill_line` (every `ChargeSource`: RECURRING, USAGE, OCC; no `ONE_TIME` in v1 — C2/G5 decided 2026-10-11, sourcing is a future spec; with discount, offering and net), aggregated on the fly with no new charge-copy table, and prove `Σ net_amount = customer_bill.subtotal` on every rendered invoice before any editor UI is built.
2. **Always have a template (R11).** Seed a developer-authored default layout `INVTPL-STD-A4` and a default generated structure version, flagged `is_default`, always ACTIVE and undeletable. Resolution order is pinned version → current ACTIVE → default, so "no template configured" cannot occur.
3. **Give RevOps one versioned company profile (D5).** Store it as `core.system_config` group `invoice.profile` with DRAFT → ACTIVE → RETIRED versions; activation requires a logo and a change note.
4. **Let billing admins control structure, not layout (D3, D4, R7).** Admins tick optional sections and charge-detail columns on or off; developers own section order, positions, page size, margins, fonts, labels and CSS.
5. **Freeze what was issued (D8).** At posting, record on the bill the generated template version, the company profile version and the CSV template version. Reprint downloads the stored PDF; reproducibility is checked with the existing `customer_bill.charge_checksum`, not a re-render.
6. **Fail loudly, never silently (R8).** A render or validation failure parks that account in the run's exception surface. The legacy `udr_rated` template is never used as a fallback.
7. **Show detailed usage by region (R9).** List every billed `udr_rated` row in a usage section subsectioned state → district, reading geo that rating persisted onto `udr_rated`.
8. **Keep admin input and stored files tamper-proof.** Handlebars auto-escaping with `knownHelpersOnly`, checksums verified at render for templates and logo, sanitized SVG uploads, append-only versions, audit-logged saves and activations.

### Core user flow

1. **Seed (developer, once).** The migration creates `billing.bill_format` (one row, `INVOICE`), layout `INVTPL-STD-A4` v1 (`manifest.json`, `shell.hbs`, `footer.hbs`, `partials/*.hbs`, `sample-data.json`) and the default generated version (`is_default = true`, ACTIVE). On first setup the current `/brand/logo.svg` can be imported as the initial logo artifact.
2. **Maintain the company profile (billing admin, `invoice_settings` EDIT).** Open Administration › Invoice Settings › **Company profile**:
   - edit company details, payment details, brand/accent colours and default payment terms;
   - upload the logo (PNG/JPEG/SVG, ≤ 500 KB, ≥ 300 px; MIME checked against magic bytes; an SVG with scripts, event handlers, `<foreignObject>` or external references is rejected, never repaired; ≤ 2,000 px on either side), stored as a `bill_asset_version`;
   - preview, then **Activate** with a change note. Activation is blocked without a logo. The new version becomes ACTIVE, the previous one RETIRED.
3. **Choose what the invoice shows (billing admin).** Open Administration › Invoice Settings › **Invoice template**:
   - tick optional sections (Payment information, Usage annex, Notes & terms) and optional columns (Service period, Discount, Product offering ID, UDR type & count); mandatory sections are locked on;
   - check the live preview, rendered through the real pipeline (`isDraft: true`) against the layout's sample bill or a recent posted bill (a posted bill is previewed with **its own pinned versions**, not the current ACTIVE);
   - **Save draft** (never used for invoices) or **Activate** with a change note. Activation validates mandatory sections, generates `invoice.hbs` + `footer.hbs`, test-renders against the sample bill, writes the files with checksums to the content-addressed `invoice-templates/generated/INVOICE/v{n}-{digest12}/`, sets the new version ACTIVE and the previous one RETIRED.
4. **Rate usage (rating module, cross-module change).** RAN-usage rating, which already reads the `ratecard_ran_usage_lkp` row for `rate_per_unit`, also writes that row's `state` and `district` onto the `udr_rated` row. Forward-only; no backfill.
5. **Process and review the bill run (unchanged).** The draft (pro-forma) preview resolves the current ACTIVE generated version + ACTIVE profile, shows the `position:fixed` draft watermark, and persists nothing.
6. **Approve → Post.** A second `billrun_approve` user approves. `services/billing/post-run.ts` posts the `INV`, computes `charge_checksum` as today, and stamps `customer_bill.ref_bill_format_id = INVOICE`, `ref_bill_template_version_id` (the generated version, which pins its layout version), `ref_invoice_profile_version` and the CSV template version.
7. **Render the final invoice.** `resolveTemplate` takes the stamped versions → the blob is loaded and its checksum verified → `Handlebars.compile` (cached per version id) → `bind()` merges profile, logo data URI, bill lines, tax items, customer identity, INV number and usage rows → Playwright/Chromium renders the PDF with a "Page X of Y" footer → the PDF is stored once in `bill_run_invoices`. A failure parks the account and shows it in the run's exception surface; other accounts continue.
8. **Distribute (unchanged).** Kestra execution #2 SFTPs the stored PDF.
9. **Reprint and audit.** Reprint downloads the stored PDF. The **Version history** tab on both screens lists every version with status, author, created/activated/retired dates, change note, "used by N invoices", a read-only preview and a `.hbs` download.

### Features

#### Company profile

- Fields: legal name, SSM reg. no., TIN, SST no., address lines, postcode, city, state (MyInvois code 01–16), country, phone, email, website; bank name, account name, account no., SWIFT, JomPAY biller code, remittance email; brand and accent colours (`#RRGGBB`); default payment terms (days, used when the billing account has no override).
- Validation per the placeholder catalog (TIN, SST, postcode, SWIFT, email, colour format); blank optional fields are hidden on the invoice.
- Logo required to activate; the profile version pins a specific logo asset version.
- The application logo (`system_config` `app`/`app_logo_path`, `getBrandingLogo()`) is unchanged and separate from the invoice logo.

#### Invoice template editor

- Mandatory, locked sections: Header (issuer, logo, title), Invoice identification, Bill-to, Amount due, Summary of charges, Tax summary, Charge details, Page footer.
- Optional sections an admin can hide: Payment information, Usage annex, Notes & terms. (Account summary is dropped from v1, R2.)
- Fixed charge-detail columns: #, Description, Quantity, Unit price, Gross, Net amount. Hideable: Service period, Discount, Product offering ID, UDR type & count. (No per-line tax column, R6.)
- Positions never move: hiding a section closes the gap; a half-width section whose partner is hidden widens to full width.
- Live preview with "show placeholders" and outline toggles; read-only **Generated .hbs** tab; **Version history** tab.

#### Template engine

- Handlebars 4.7 added as a direct dependency.
- Data placeholders: `{{company.*}}`, `{{payment.*}}`, `{{invoice.*}}`, `{{customer.*}}`, `{{totals.*}}`, `{{#each lineGroups}}`.
- Helpers: `money`, `date`, `period`, `qty`, `price`, `int`, `amt`, `unitCode`, `asset`, wrapping the existing `formatCurrency` / `formatCalendarDate`.
- Generation-time directives in the developer layout: `[[if sections.<key>]]`, `[[if columns.<key>]]`, `[[num …]]` (derived `colspan`), `[[body]]`. Generated files contain only `{{ }}` placeholders, so the stored file is exactly what was rendered.

#### Render binder and pipeline

- `render-invoice-template.ts` becomes the binder: `resolveTemplate` → `load` (checksum, compile, cache) → `bind` → `renderPdfFromHtml`.
- Render input from `customer_bill_line`, `customer_bill_tax_item` (bill-level tax summary), `billing.document` (INV anchor), `customer.organization` + `contact_medium` (tax identity and address).
- "Amount due" = this invoice's current charges only, and the template states it.
- PDF: A4 page setup from the layout, Chromium `displayHeaderFooter` used only for "Page X of Y", `position:fixed` draft watermark kept (R5); existing semaphore, concurrency cap and close-timeout unchanged.
- Logo fetched, checksum-verified and inlined as a data URI; no external URLs.

#### Detailed usage section

- Every billed `udr_rated` row for the account, grouped state → district, with per-district and per-state subtotals.
- Geo read directly off the claimed `udr_rated` rows; no render-time ratecard lookup and no ratecard version pinning.
- Expected volume a few hundred rows (~6–10 pages) per account, bounded to 10,000 rows; over the bound the account parks with `INVOICE_USAGE_OVER_LIMIT` (G2).

#### Storage, versioning and data model

- `billing.bill_template_version`: immutable, append-only; `kind` = `layout` | `generated` | `csv` (no `xml` in v1); one non-default ACTIVE per (`ref_bill_format_id`, `kind`) beside the always-ACTIVE default (X3); `structure` jsonb (sections, columns), `page_setup` jsonb, `blob_ref`, `checksum`, author/activation/retirement stamps, `change_note`.
- `billing.bill_asset` / `bill_asset_version`: logo artifact (`kind = logo`), retire-only.
- New bill columns: `ref_invoice_profile_version` and `ref_csv_template_version_id` (G12); the reserved `ref_bill_format_id` and `ref_bill_template_version_id` are populated. All four are stamped by `stampPosted` in the posting `UPDATE` (bm54); bills posted earlier keep `NULL` and render with the default.
- Blob store generalized to `putObject/getObject(container, path, bytes, contentType, {writeOnce})`; `putInvoice` refactored onto it (R4).

#### Output formats

- PDF (legal copy, stored write-once) and HTML (preview, email body) from the generated `.hbs`; admin structure options apply.
- CSV from the bill's stamped, checksum-verified column map (`GET …/stored-invoice/[banId]/csv`, `billrun_view` READ, bm62): one row per line item, formula-safe cells, and the `net_amount` column sums exactly to the bill.

#### Security, access and audit

- Auto-escaping on; triple-stash forbidden; `knownHelpersOnly`; no eval-style helpers.
- CI layout lint: no raw `<img src>` or external URLs; images only via `{{company.logoUrl}}` / `{{asset}}`.
- New permission `invoice_settings` (READ / EDIT) guards both screens; every save and activation writes `AUDIT_LOG`.
- Checksum mismatch on a template or logo fails the render.

### In scope

- Binder over `customer_bill_line` + `customer_bill_tax_item` + `billing.document` + `organization`/`contact_medium`, with the `Σ net_amount = subtotal` reconciliation (built and verified first).
- Seeded default layout `INVTPL-STD-A4` + default generated version (`is_default`), and the pinned → ACTIVE → default resolution.
- Company profile screen, validation, logo upload as a versioned artifact, activation with change note, version history.
- Invoice template editor: section and column show/hide, live preview, save draft, activate, Generated .hbs tab, version history.
- Handlebars engine, helpers, generation-time directives, generator.
- Tables `bill_format`, `bill_template_version`, `bill_asset`, `bill_asset_version`; the new bill version columns; stamping in `post-run.ts`.
- Generalized blob store and `putInvoice` refactor.
- Detailed usage section by state → district, plus the rating-side change that writes `state`/`district` onto `udr_rated`.
- PDF, HTML and CSV outputs; "Page X of Y" footer.
- Park-on-failure handling in the run exception surface.
- `invoice_settings` permission, audit logging, SVG sanitizer, layout lint.
- Unit, golden-render, multi-page, pinning, tamper, fresh-database journey and browser e2e tests.

### Out of scope

- Credit notes, debit notes, and a separate pro-forma document type (pro-forma = draft render) (D1).
- Per-MNO or per-customer templates and MNO assignment (D2).
- Admin control of section order or position, labels, wording, colours within the template, image slots, page setup or fonts (D3, D4).
- An admin code editor and a drag-and-drop designer.
- Multi-brand / multi-entity issuing.
- Account summary / balance brought forward (R2) — revisit with the payments/credit-note ledger.
- MyInvois UBL XML, the MyInvois submission/validation module, all `einvoice.*` fields, the classification code and state-code mapping (R3); no `kind = xml`, `system/xml` paths or sample XML.
- Per-line tax and SST tax-invoice compliance (R6); real taxation (the ratified `0.00` interim stays).
- Shared asset library (signatures, stamps, letterheads, banners) and generated DuitNow QR codes.
- Bilingual BM/EN invoices.
- Re-rendering for reprint, and any fallback to the legacy `udr_rated` template.
- Backfilling `state`/`district` onto `udr_rated` rows rated before the rating change.

### Success criteria

1. On the `ci` seed, every posted invoice's charge details include all of its `customer_bill_line` rows (RECURRING, USAGE, OCC; no ONE_TIME in v1, G5) and discounts, and `Σ net_amount` on the invoice equals `customer_bill.subtotal`. _Evidence: journey step 2 (`tests/e2e/invoice-template-journey.integration.test.ts`); `bind.test.ts` reconciliation._
2. On a fresh database, `bill_format` has exactly one row (`INVOICE`), and `INVTPL-STD-A4` v1 plus the default generated version are ACTIVE with `is_default = true`; the default cannot be deleted or retired, and a bill run posted with no admin activity renders with it. _Evidence: journey step 1; `tests/guardrails/invoice-default-resolution.integration.test.ts` (45); `tests/db/invoice-template-catalog.integration.test.ts`._
3. The company profile cannot be activated without a logo or without a change note; invalid TIN, SST, postcode, SWIFT, email or colour values are rejected; a logo over 500 KB, under 300 px, with a MIME/magic-byte mismatch, or an SVG containing `<script>` is rejected. _Evidence: admin e2e profile scenario (`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`); `tests/db/activate-profile.integration.test.ts` (51); `upload-logo.test.ts` (52)._
4. In the template editor, mandatory sections cannot be unticked; hiding Discount removes the column and its total from the preview; activating creates version n+1 as ACTIVE and n as RETIRED, listed in Version history with author, dates and change note; the generated `.hbs` contains no markup for hidden sections or columns and no `[[ ]]` directives. _Evidence: admin e2e template scenario; `generate.test.ts` (48); `tests/db/activate-template.integration.test.ts` (53)._
5. After an invoice is posted under generated v2 and profile v1, activating v3 and profile v2 leaves that bill's recorded versions and stored PDF unchanged, while a new draft preview uses v3 and profile v2. _Evidence: journey step 4; `tests/guardrails/invoice-version-pinning.integration.test.ts` (46)._
6. Changing one byte of a stored template or logo blob makes its render fail the checksum check: that account is parked and appears in the run's exception surface, other accounts post, and no invoice is rendered with the legacy template. _Evidence: journey step 5; `tests/guardrails/invoice-checksum-tamper.integration.test.ts` (47); `invoice-no-legacy-render.test.ts` (44)._
7. A fixture forcing 3+ pages shows "Page X of Y" on every page, repeats the table header, keeps each line group on one page, and the draft watermark is not clipped by the footer margin. _Evidence: journey step 7 (10,000 rows render ≥ 3 pages with the footer, `thead` and line-group rules and the fixed watermark; 10,001 park)._
8. The detailed usage section lists every billed `udr_rated` row under its state and district with correct per-district and per-state subtotals, reading geo from `udr_rated` with no ratecard query at render. _Evidence: journey step 2 ("Unassigned region"); `tests/db/invoice-usage-annex.integration.test.ts`._
9. The CSV has one row per line item and its line amounts sum exactly to the bill. _Evidence: journey step 6; `tests/db/invoice-csv.integration.test.ts` (55)._
10. Reprint returns the stored PDF bytes unchanged, and recomputing `charge_checksum` from the bill's lines matches the stored value. _Evidence: journey step 4 (reprint route bytes, `charge_checksum` recompute); guardrail 46._
11. A user without `invoice_settings` READ cannot open either screen; a READ-only user cannot save or activate; every save and activation writes an `AUDIT_LOG` entry; a customer name containing `<script>` renders escaped. _Evidence: admin e2e (no-access, read-only, escaping with no dialog); journey step 8 (audit rows); `invoice-settings-authz-matrix.test.ts` + `invoice-settings-grants.integration.test.ts` (56)._
12. Golden-render snapshots of each layout version pass in CI; existing bm18/bm19 tests are updated to the new binder and pass; `npm run typecheck`, `npm run lint`, the vitest suite and the browser e2e (the installed `playwright` library, `npm run test:e2e:invoice-settings`) pass; `billmgmt-architecture.md`, `billmgmt-code-standards.md` and `billmgmt-progress-tracker.md` are synced. _Evidence: `tests/services/billing/invoice-golden.test.ts`; `render-invoice-template.test.ts`/`build-invoice-html.test.ts`; `tests/guardrails/invoice-layout-lint.test.ts`; full suites green at bm63._

### Decisions (formerly the open items)

- **X1/C1/G1 = R9** (bm48): rating writes `state`/`district` onto `udr_rated`; Inv #36 amended; G13 reuses PRP's canonical cell match.
- **X2/G2** (bm49): every billed row, 10,000 rows/account; over the bound the account parks with `INVOICE_USAGE_OVER_LIMIT`.
- **X3/C3/G3** (bm50): the one-ACTIVE index excludes the default; resolution is pinned → non-default ACTIVE → default.
- **X4/G4**: carried by the bm47–bm49 binder.
- **O2/C4/G6** (bm50): SHA-256 for template/asset blobs, algorithm recorded per row; invoice PDFs keep md5.
- **O3/G7**: notes & terms and the footer sentence are fixed layout text.
- **O4/G8** (2026-10-11): IBM Plex Sans and Mono embedded; layout v1 has placeholder sources, layout v2 ships the real woff2 data.
- **O5/G9** (2026-10-11): customer SST no., PO and contract references hidden while blank; no columns in v1.
- **C2/G5** (2026-10-11): no `ONE_TIME` charge source in v1.
- **O10/G10** (bm50): nothing deletes a version.
- **G11** (bm50): `invoice_settings` grants ADMIN/MANAGER EDIT, USER READ.
- **G12** (bm50): the CSV version lives on `customer_bill.ref_csv_template_version_id`.
- **G14** (2026-10-11): no four-eyes on profile activation; the bank-change warning and the `bankDetailsChanged` audit flag are the mitigations.
- **G15 = A**: before the first profile activation, invoices render without the issuer and payment blocks and the profile stamp is `NULL`.
- **G16** (2026-10-11): the app's user-assigned Managed Identity with container-scoped `Storage Blob Data Contributor`; the `appBlobAuth` flip is a cloud-cutover ops step.

## Success criteria (module-level)

1. Opening Bill Runs on/after the 1st materialises the prior month's run for every
   active monthly cycle exactly once, concurrency-safe, with no scheduler.
2. A triggered run claims `udr_rated` rows (NULL `billrun_ban_id`), resolves each to
   an account via `product_inventory`, writes real `customer_bill` +
   `customer_bill_line`, and reaches `PROCESSED`; `SUM(net_amount) = subtotal`; an
   account with 3+500 subscriptions of two offerings produces exactly 2 lines.
3. A recurring-only account bills a non-empty, reproducible-checksum bill; an account
   with no charge lines is Uncharged; every `USAGE` line's `gross_amount` equals the
   SUM of the `udr_rated` rows that rolled into it.
4. Reject/rerun release claimed rows to `RATED` (four columns cleared) before
   re-trigger, so no claim survives an abandoned attempt; a rating reload colliding
   with a claimed row is refused (`LOAD_BLOCKED_INFLIGHT` / `LOAD_BLOCKED_BILLED`).
5. A different `billrun_approve` user posts one `INV` per billed account (correct
   `A/R ← revenue` + tax legs, `event_at = gl_event_at`), renders + stores the final
   PDF; a mid-batch `PERIOD_CLOSED` leaves other invoices posted and the run
   resumable; the run reaches `INVOICED` and the next cycle unblocks.
6. Distribution SFTPs each artifact to its own remote path, completes only when every
   mandatory artifact reaches every mandatory target, and reruns only failed
   artifacts on `DISTRIBUTION_FAILED`.
7. A stalled run shows `STALLED` on read; Check status reconciles it, Cancel releases
   it (accounts reset, no numbers consumed). `billrun_view` reaches every read
   surface and no mutation. M2M routes reject a missing/invalid bearer with 401 and
   never log the token.
8. The two-writer grant boundary holds per column/table; `typecheck`, `lint`, and the
   vitest suite pass; the docs conventions and progress tracker are kept current.
9. A freshly triggered run drives itself `SCHEDULED → COMPLETED` with no out-of-band
   calls — real processor signal-back (per-stage `DONE` + terminal `FAILED`
   settlement) makes accounts auto-reach `PROCESSED`, the Workflow timeline fills, and
   Approve appears with no stall banner; post → store → SFTP distribute → `COMPLETED`
   all follow. **Delivered (Phase 4, bm36–bm39):** the signal-back, self-driving
   lifecycle and prod-wiring are built and CI-guarded (the DB-free flow guardrail
   `tests/guardrails/billrun-processing-signal-back.test.ts` and the DB-gated E2E
   double `tests/db/billing-e2e-happy-path.integration.test.ts`, which run on every
   CI). The full live-Kestra `billrun:live-kestra-smoke` run on the `ci` seed is a
   **gated live-stack step** against the provisioned real Postgres/Kestra/blob/SFTP
   stack, and the cloud cutover is a further separate gated ops step.
