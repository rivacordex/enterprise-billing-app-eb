# Billing Management (Bill Run) — Module Code Standards

> Module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Bill Run specifics; everything else (general rules, TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is **not** restated here. If a rule seems missing, it lives in the general file. Where this doc conflicts with the architecture **Module Invariants** (`billmgmt-architecture.md` §6), the Invariants win and the conflict is a bug to fix here.

**Companion docs (authoritative):** `billmgmt-project-overview.md` (product spec, flows, success criteria) · `billmgmt-architecture.md` (technical design, 15 numbered **Module Invariants** §6) · `_newmodule-billing-billrun-plan.md` (full functional design & data model).

**Status:** Planning. Component/route/permission names below are the **binding** convention for the build.

---

## 1. General Rules (module-specific)

1. **The bill run never rates — enforced in code shape.** No service, repository, or SQL in this module computes a charge amount. `services/billing/**` reads amounts from `rating.udr_rated` and sums them; there is no charge-derivation function and no code path writes an `amount` into a charge record (Inv. #1).
2. **Two mutation entry surfaces, kept separate.** Operator mutations flow `actions/billing/**` → `services/billing/*` → repositories, gated by `billrun_operate`/`billrun_approve`. Machine mutations flow `app/api/billrun/**` → the **same** `services/billing/*` functions, gated by the service token. A Server Action never carries a stage signal; a Route Handler never carries an operator action. Both reuse one service layer — never a forked copy.
3. **The only write this module makes outside `billing.*` is the claim marker.** Exactly one repository function `UPDATE`s `rating.udr_rated`, and it writes only `ref_bill_run_id` + `attempt` (Inv. #2). No other code touches the `rating` schema for write; there are no cross-schema foreign keys in either direction — joins are plain-text `(run, ban, attempt)`.
4. **`ref_inv_document_id` is the finalization latch.** No service `UPDATE`s or `DELETE`s a `customer_bill` row whose `ref_inv_document_id` is set, and no rerun/invalidation path touches it. The delete guard is a DB constraint; the service re-checks it too. A code path that could mutate a posted bill is a review-blocking defect (Inv. #4, general Inv. #18).
5. **Posting is per-account, one transaction each, resumable.** The posting service iterates accounts and opens a fresh transaction per account; there is no "post the whole run in one transaction" function, ever. Every posting transaction first checks the account is not already `INVOICED` (skip) (Inv. #6).
6. **Four-eyes is a service-layer check, never UI-only.** The approve/post service rejects when the approver equals the final-attempt trigger actor (`approved_by === triggered_by` of the latest attempt) with a typed `FOUR_EYES_VIOLATION` result. The UI disabling the button is show/hide only (general §1.2).
7. **Run status is recomputed under a row lock, never incremented.** Every place run status changes issues `SELECT … FOR UPDATE` on the `bill_run` row and derives the new status from `bill_run_account`; no code does `failed_count = failed_count + 1` as the source of truth. Cached counters, if written, are asserted equal to the derived value by a test (Inv. #12).
8. **`STALLED` is never persisted.** No `UPDATE … SET status = 'STALLED'` exists. Staleness is computed on read from `status = 'PROCESSING'` and `last_progress_at` versus the cycle threshold (Inv. #10).
9. **No app scheduler, cron, or background worker.** Runs materialize on page load (§3.2); partition maintenance is `pg_cron`; orchestration is the external workflow engine. A `setInterval`, queue worker, or Container Apps Job in this module is out of bounds (Inv. #10).
10. **Operator mutations are audited atomically; stage signals are their own append-only record.** `materialize`, `trigger`, `rerun`, `approve`, per-account `post`, and `cancel` each write exactly one `core.AUDIT_LOG` row in the same transaction as the change (general §1.7). Per-account **stage** progress is the append-only `bill_run_account_stage` row itself (the drill-down/audit surface); the ingest handler writes that row, not a per-signal `AUDIT_LOG` entry. The rerun audit row is written **before** re-trigger and carries prior totals + reason.

---

## 2. TypeScript Conventions (module-specific)

1. **Domain unions** (general §2.6), each defined once as an `as const` string-literal union in the module types — never a TS `enum`, never re-declared:
   - `RunStatus`: `'SCHEDULED' | 'PROCESSING' | 'PROCESSED' | 'APPROVED' | 'POSTING' | 'INVOICED' | 'DISTRIBUTING' | 'COMPLETED' | 'PROCESSING_FAILED' | 'DISTRIBUTION_FAILED' | 'CANCELLED'`
   - `AccountStatus`: `'PENDING' | 'PROCESSING' | 'PROCESSED' | 'INVOICED' | 'DISTRIBUTING' | 'COMPLETED' | 'PROCESSING_FAILED' | 'DISTRIBUTION_FAILED' | 'SKIPPED' | 'EXCLUDED'` — `EXCLUDED` is a bm03 addition (not in the original plan's 9-member union): a scoping-time partial-period exclusion, written only by the trigger's snapshot, never by any downstream stage.
   - `Stage`: `'scoping' | 'validation' | 'collection' | 'aggregation' | 'taxation' | 'verification' | 'posting' | 'rendering' | 'distribution'`
   - `StageStatus`: `'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED'`
   - `ErrorClass`: `'HARD' | 'SOFT' | 'INFRA'`
   - `BillCategory`: `'trial' | 'normal' | 'last'`
   - `BillState`: `'new' | 'validated' | 'sent'`
   - `RunType`: `'onCycle' | 'offCycle'`
2. **`STALLED` is not a member of `RunStatus`.** It is a derived UI flag (`type StallState = 'live' | 'stalled'`), computed in one helper; do not add it to the DB enum or the status union (Inv. #10).
3. **Money is `string` end-to-end** (general §2.15). `subtotal`, `tax_total`, `total_amount`, `tax_amount`, and every `rating.udr_rated.amount` are `numeric` → `string`. **Monetary aggregation happens in SQL** (`sum(amount)` in a repository query) — never by `Number()`/`parseFloat`/`reduce(+)` in JS. If a total must be composed in TypeScript, use the platform decimal helper, never float arithmetic (general §6.16).
4. **The charge checksum concatenates raw stored strings, never reformatted numbers.** `charge_checksum` is `md5(string_agg(udr_rated_id || ':' || amount …))` computed in SQL over `(run, ban, posted_attempt)` ordered by `udr_rated_id`; do not re-derive it in TypeScript or reformat `amount` before hashing, or the tamper-evidence breaks (Inv. #3).
5. **Dates: `gl_event_at`, `period_start`, `period_end`, `period_partition`, `scheduled_run_date`, `payment_due_date` are `date`** (calendar dates, not `timestamptz`); timeline columns (`*_at`) are `timestamptz`, UTC (general §2.13). `gl_event_at` is resolved once at trigger to `scheduled_run_date` and never recomputed (Inv. #13).
6. **Entity IDs are plain `string`s validated by Zod format schemas** (general §6.18): `BRN`+8 digits (`/^BRN\d{8}$/`) and likewise `BRA` (bill_run_account), `BRS` (bill_run_account_stage), `CBL` (customer_bill), `CBT` (customer_bill_tax_item), `BTV` (bill_template_version). The `[runId]` route param is parsed against the `BRN` schema before any repository call.
7. **Read models live in `types/` as composed shapes** (general §2.7): `RunListRow` (header + derived counts + derived stall state), `RunDetail`, `AccountRow`, `StageTimelineRow`, `CustomerBillView` (bill + charge lines read from `rating`), `UnchargedRow`, `ErrorRow`. Services return these; pages never re-join or re-derive counts.
8. **Derived fields are never stored types.** `ban_count`/`rated_count`/`failed_count` are an optional cache; the read models expose the **derived** counts, and the cache is never the source a UI reads (Inv. #12).
9. **Ingest and action inputs are Zod-first** (general §2.8): the stage-signal body, the status-push body, and every operator-action payload have a `validation/billing/*.schema.ts` schema; types come from `z.infer`, never hand-written.

---

## 3. Next.js Rules (module-specific)

1. **Pages are thin RSC orchestrators** under `app/(app)/billing/bill-runs/**`: guard → parse params → call `services/billing` → compose components. No DB access, no run-status recomputation, no money math in a page (general §3.3).
2. **Materialization runs in the list page's server path, idempotently.** `billing/bill-runs/page.tsx` calls the materialize service (`ON CONFLICT (ref_bill_cycle_id, period_start) DO NOTHING`) before rendering the list. It is **not** a Route Handler, an action, or a job. Concurrent loads produce exactly one row (Inv. #10, overview success criterion 1).
3. **Run list/detail view state lives in `searchParams`**, parsed never trusted: `tab` (current/historical; workflow/customers/uncharged/errors/audit), `cycle`, `status`, `page`. Invalid values fall back to schema defaults, never error. No client store mirrors the URL.
4. **Operator mutations go through Server Actions** (`actions/billing/**`, `'use server'`), each in the general §3.4 order and re-checking `billrun_operate` (trigger/rerun/cancel) or `billrun_approve` (approve/post) server-side. A mutation success path is `revalidatePath` on the affected run pages, not client cache surgery.
5. **The two M2M endpoints are Route Handlers, not actions** (§5). This module **is** the platform's first legitimate `app/api/*` business surface — the general "no module Route Handlers" default does not apply, but every rule in §5 does.
6. **Authenticated bill-run pages are dynamic and uncached** (general §3.8): `export const dynamic = 'force-dynamic'`; run status/totals are read live and never `revalidate`-cached (Inv. #12, general Inv. #20).
7. **`'use client'` only at interaction leaves** — the tab switcher, the trigger/rerun/cancel/approve dialogs, the posting-progress poller. Read-only tabs (Workflow timeline, Customers & Bills, Uncharged, Errors, Audit) stay server components.
8. **The posting-progress view polls the server action/read path, never the workflow engine.** The browser never talks to the workflow engine directly; ground truth is the app DB, reached through the service layer.
9. **`services/billing/**` and `db/**` import no `next/*`** (general §3.14) — the same services back both the UI actions and the M2M handlers.
10. **Page metadata + segments:** each route ships `metadata.title` ("Bill Runs", "Bill Run — {id}", "Approve & Post"), `loading.tsx`, and `error.tsx` (general §3.11).

---

## 4. Styling (module-specific)

1. **Shared indicator components** (general §4.8) — one visual treatment per domain value, created with exactly these names in `components/billing/`:
   - `RunStatusBadge` — the 11 `RunStatus` values (semantic tokens only; `INVOICED`/`COMPLETED` success, `*_FAILED` destructive, `CANCELLED` muted, in-flight neutral).
   - `AccountStatusBadge` — the 10 `AccountStatus` values, incl. `SKIPPED` (muted), `PROCESSING_FAILED` (destructive), and `EXCLUDED` (muted — a scoping-time exclusion, not a failure). Not built in bm03 — `bill_run_account` has no UI reader yet (bm04+/the Uncharged tab, bm07); ships with the first unit that renders a per-account row.
   - `StageStatusBadge` — `PENDING/RUNNING/DONE/FAILED/SKIPPED`.
   - `ErrorClassBadge` — `HARD` (destructive) / `SOFT` (warning) / `INFRA` (neutral).
   - `BillCategoryBadge` — `trial` (muted/outline) / `normal` / `last`.
2. **`PlaceholderBanner` is unmissable and always-on while `BILLRUN_PLACEHOLDER_MODE` is set** (Inv. #15, renamed bm15-spec §Implementation §4): a persistent full-width banner on every bill-run tab plus a `PlaceholderBadge` list-row chip, using warning tokens. Copy: "Placeholder pipeline — the workflow engine runs the bill run, but the billing steps are placeholders and `udr_rated` is seeded `_SAMPLE_` test data. Approval, posting, invoice numbers, rendered PDFs and distribution are wired end-to-end and REAL." Never conditionally hidden by a per-run field (there is no `udr_mode` column); it reads the environment/config placeholder-mode flag threaded server-side as a prop.
3. **The `StallBanner` is a derived-state banner, not a status pill.** Shown when a run is `PROCESSING` past its stall threshold; offers **Check status** (primary) and **Cancel run** (secondary, danger, inside a spelled-out confirm dialog). Never rendered from a stored `STALLED` value.
4. **Money renders through one `lib/` formatter** — `formatCurrency(amount, currency, locale)` — for every bill total, tax line, and run total. No inline `toFixed`, no hardcoded currency symbol, no client-side sum (totals arrive pre-computed from the service).
5. **Dates render through the platform `formatDatetime(date, locale, timezone, …)`** with timezone threaded as a prop (general §2.13); `<time dateTime>` stays ISO-8601 UTC. GL/period/invoice **dates** (`gl_event_at`, `period_*`, `payment_due_date`) render as calendar dates in the business zone.
6. **The Approve & Post screen uses the danger role for the confirm action only**, inside its confirmation dialog, and always renders the pre-approval checklist (period open, GL mappings resolvable, no zero/negative totals, approver ≠ trigger actor, all accounts terminal) each as an explicit pass/fail row with a remediation line. The self-approval block is visible with its reason.
7. **Uncharged vs Errors are two visually distinct tabs** (never merged): Uncharged uses neutral/info treatment ("revenue queue"), Errors uses destructive treatment ("blocking — fix, then rerun"). A per-row deep link to Accounts → Transactions on Uncharged rows.
8. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for the run list, account list, uncharged, and errors tables; never fork a parallel table. Zero-exceptions is a positive empty state, not a blank tab.

---

## 5. API Routes (module-specific)

This module owns the platform's first M2M Route Handlers. They are thin, uniform, and **session-less**.

1. **Exactly two handlers exist, both under `app/api/billrun/`:**
   - `POST /api/billrun/[runId]/stage/[stage]/complete` — body `{ ban_id, attempt, status, error_class?, error_code?, error_detail? }`.
   - `POST /api/billrun/[runId]/status` — run-level terminal / execution-failure push.
   No `GET`, no other verbs, no other paths. Adding a third handler needs an architecture decision.
2. **No session semantics — bearer service token only** (Inv. #9). The handler never calls `getSession`/`requirePermission`. It authenticates a single bearer token via a **constant-time compare** against the Key Vault value, authorized by the token's fixed scope (not RBAC levels). The token is never logged, never string-manipulated, never returned.
3. **Auth order, every request:** constant-time bearer check (fail → **401**) → Zod-parse the body and `[runId]`/`[stage]` params (fail → **422**) → reject unless the run is `PROCESSING` (a stage signal after `APPROVED` → **409**) → delegate to the service. No business logic in the handler.
4. **Idempotency is the DB constraint, never handler logic** (Inv. #5). The stage handler's service inserts the `bill_run_account_stage` row **first** inside its transaction; a duplicate `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)` hits the UNIQUE constraint and returns **200** as a no-op replay. The handler does not pre-check for existence.
5. **The signal carries no charge payload.** The handler/service never accepts amounts or charge lines over the wire; on collection/aggregation it reads `rating.udr_rated` itself. Reject any body with charge fields.
6. **Status codes** (general §5.5, module usage): `200` accepted / replay no-op · `401` bad token · `409` run not `PROCESSING` · `422` malformed body/params · `500` unexpected. Envelopes and `AppError`→HTTP mapping per general §5.6–5.7.
7. **HTTPS-only, private-network reachable** (architecture §4). This path is added to the authz-sweep inventory. The outbound credential (app → engine) is separate, one-directional, and never handled here.
8. **The run trigger holds a generic execution lock** keyed on `status = 'PROCESSING'`, independent of `workflow_execution_id`: a second trigger while `PROCESSING` is rejected (not a Route Handler concern, but the guard the ingest relies on).

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `billing` schema** (general §6.3): `bill_run`, `bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`, `bill_template_version`. No identity/RBAC/session/config/audit tables. Cross-schema references to `core.APPUSER` (`triggered_by`, `approved_by`, `created_by`) by FK; **no FK into or out of `rating.*`** (Inv. #2).
2. **ID prefixes** (format per general §6.18, 8-digit sequence): `BRN`, `BRA`, `BRS`, `CBL`, `CBT`, `BTV` — one sequence per table, assembled in the DB layer.
3. **There is no billing-side charge table** (Inv. #3). Do not create one. Charge lines live only in `rating.udr_rated`; `customer_bill` stores `posted_attempt` + `charge_checksum` as the anchor, and review/reprint read lines back by `(run, ban, posted_attempt)`.
4. **The four record tables are partitioned on `period_partition`** (`bill_run_account`, `bill_run_account_stage`, `customer_bill`, `customer_bill_tax_item`); `bill_run` and `bill_template_version` are not. `period_partition` is **fixed per run** (the 1st of the run's period month), written at snapshot/insert — never row-insert time — so cross-month reruns keep all rows in one partition (Inv. #11).
5. **Composite PK/UNIQUE keys include `period_partition`** (Postgres requires the partition key in every unique/PK): `bill_run_account` UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`; `bill_run_account_stage` UNIQUE `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)`; `customer_bill` UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`. The stage UNIQUE is the idempotency latch — do not drop or weaken it.
6. **Partitioning is registered, not hand-rolled** — a `partition_management` row (`pg_partman` monthly, 84-partition/7-year retention, detach-and-archive) per partitioned table; no bespoke partition DDL in a migration beyond registration. Retention detach/drop is DDL and deliberately bypasses the row delete guard (retention ≠ correction).
7. **Money columns are `numeric(18,2)` → `string`** (general §6.16); `subtotal`/`tax_total`/`total_amount` on `customer_bill` are immutable stamps; due/remaining are **never stored** (derived from pgledger). `total_amount` on `bill_run` is stamped at `APPROVED` and never changed thereafter.
8. **`ref_inv_document_id NOT NULL` is DB-guarded against DELETE** (Inv. #4): a `customer_bill` with it set cannot be deleted (trigger/constraint) and is skipped on posting retry. Rerun's trial re-derivation is a conditional `DELETE … WHERE ref_inv_document_id IS NULL` + INSERT — never an unconditional delete.
9. **The claim marker is the single rating-schema write** (Inv. #2): the app DB role holds `SELECT` on `rating.*` and `UPDATE` on only the claim-marker column of `rating.udr_rated`. The claim service stamps `ref_bill_run_id` + `attempt` where `ref_bill_run_id IS NULL`; release (on rerun) is refused for rows already on a posted invoice. No other rating write exists.
10. **The INV posting transaction never internally commits** (general posting integrity): the posting service calls `postDocument(tx, …)` inside the per-account transaction so INV create + ledger legs + `customer_bill` stamp roll back together. Invoice numbers come from the non-transactional `document_inv_seq` — a rolled-back create may leave a rare gap, which is tolerated (Inv. #7).
11. **No `udr_mode`, `gl_date_basis`, or `fx_rate_set_id` column exists** — provenance/badge is the environment stub flag (§4.2), the GL date is the single `gl_event_at` date (§2.5), and v1 is single-currency. Do not reintroduce these columns without a spec change.
12. **JSONB is not used for financially significant data** (general §6.17): `customer_bill_tax_item` is a first-class table, not JSONB. Any future JSONB column follows the schema-guard rule; there is no documented well-formed-only JSONB exemption in this module.
13. **`bill_template_version` is immutable once `active`** — a change inserts a new row with a later `effective_from`; stamped on the bill at aggregation so a reprint renders through the template actually issued. No run-level template-override column.

---

## 7. File Organization (module-specific)

Placement per general §7; the module's concrete tree:

```
app/(app)/billing/bill-runs/
  page.tsx                     # BillRunsPage — guard(billrun_view READ), materialize, list
  loading.tsx  error.tsx
  [runId]/
    page.tsx                   # BillRunDetailPage — guard(billrun_view READ), tabs
    loading.tsx  error.tsx
    approve/
      page.tsx                 # ApproveAndPostPage — guard(billrun_approve)
      loading.tsx  error.tsx
app/api/billrun/
  [runId]/stage/[stage]/complete/route.ts   # POST — stage signal (service token)
  [runId]/status/route.ts                   # POST — run-level push (service token)
actions/billing/
  materialize-runs.action.ts
  trigger-run.action.ts
  rerun-run.action.ts
  check-status.action.ts
  cancel-run.action.ts
  approve-run.action.ts
  post-run.action.ts
components/billing/
  bill-run-list.tsx            # BillRunList (Current & Upcoming + Historical tabs)
  run-action-card.tsx          # RunActionCard
  run-status-badge.tsx         # RunStatusBadge
  account-status-badge.tsx     # AccountStatusBadge
  stage-status-badge.tsx       # StageStatusBadge
  error-class-badge.tsx        # ErrorClassBadge
  bill-category-badge.tsx      # BillCategoryBadge
  stage-timeline.tsx           # StageTimeline
  customer-bill-table.tsx      # CustomerBillTable
  uncharged-table.tsx          # UnchargedTable
  errors-table.tsx             # ErrorsTable
  audit-table.tsx              # AuditTable
  posting-progress-view.tsx    # PostingProgressView
  approve-and-post-panel.tsx   # ApproveAndPostPanel + PreApprovalChecks
  placeholder-banner.tsx       # PlaceholderBanner + PlaceholderBadge (renamed bm15)
  stall-banner.tsx             # StallBanner
  trigger-run-dialog.tsx  rerun-dialog.tsx  cancel-run-dialog.tsx
services/billing/
  materialize-runs.ts          # lazy run creation from bill_cycle (ON CONFLICT DO NOTHING)
  trigger-run.ts               # snapshot accounts, PROCESSING, resolve gl_event_at, call engine
  handle-stage-signal.ts       # ingest: insert stage row first, advance account, recompute (FOR UPDATE)
  handle-status-push.ts
  rerun-run.ts                 # audit-first, invalidate later stages, re-derive trial bill
  stall.ts                     # pure isStalled(run, now, thresholdMinutes) — never persisted
  reconcile-run.ts             # "Check status" — engine reconcile, bumps last_progress_at
  cancel-run.ts                # kill (best-effort) + reset accounts PENDING + CANCELLED + audit
  approve-run.ts               # four-eyes + pre-approval checks
  post-run.ts                  # per-account INV posting (per-txn, resumable)
  claim-udr.ts                 # the single rating UPDATE
  read/                        # list-runs.ts, get-run-detail.ts, list-uncharged.ts, …
db/schema/billing/
  bill-run.ts  bill-run-account.ts  bill-run-account-stage.ts
  customer-bill.ts  customer-bill-tax-item.ts  bill-template-version.ts
db/repositories/billing/
  bill-run.ts  bill-run-account.ts  bill-run-account-stage.ts
  customer-bill.ts  rating-claim.ts   # rating-claim.ts holds the ONLY rating.udr_rated UPDATE
db/migrations/…                # billing tables + partition_management rows + billrun_* PERMISSIONS + Billing Viewer role + INV additions
flows/billrun/
  bill_run_processing.template.yml  # bm16 — template skeleton, NOT deployed (see file note 5 below)
  README.md
validation/billing/
  stage-signal.schema.ts  status-push.schema.ts
  trigger-run.schema.ts  rerun-run.schema.ts  approve-run.schema.ts
  check-status.schema.ts  cancel-run.schema.ts
  run-list.schema.ts      run-id.schema.ts
tests/…                        # mirrors source; route × level matrix for the three pages + the two M2M handlers
```

1. **The single rating write is isolated in `db/repositories/billing/rating-claim.ts`** — the only file in the module that issues an `UPDATE rating.udr_rated`. No other repository writes the `rating` schema (Inv. #2), which makes the boundary greppable and testable.
2. **`services/billing/**` is framework-agnostic** (no `next/*`), and the ingest handlers and Server Actions call the **same** service functions (§1.2) — never a duplicated code path.
3. **The workflow-engine HTTP client (`services/billing/engine-client.ts`) is wrapped by `services/billing/engine-registry.ts`** (bm16), which resolves a logical engine name ("billrun") to a connection + a stable identity string sourced from Key Vault/config, and is the ONLY caller of the client's real/stub implementations. `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` call the registry, never the client directly, and no page/component/Route Handler calls either.
4. **Do not fork the nav** — the Billing section is a `NAV_SECTIONS` entry, not a new nav component.
5. **`flows/billrun/**` is a bm16 deliberate deviation from rating's "all flow YAML lives in a separate repo" convention** — this app repo carries template skeletons only (key sections + commented `# STUB:`-marked activities, no business logic), documenting the stage contract `handle-stage-signal.ts` records against. Not deployed from here; the real flow ships from a separate workflow-management repo built to this contract (`flows/billrun/README.md`). `flows/rating/` stays a reserved, untouched sibling — rating keeps ALL its flow YAML external, none in this repo.

---

## 8. Permission Names & Per-Page Permission Map

**Permission names** (general §8): this module ships **three** permission names — `billrun_view`, `billrun_operate`, `billrun_approve` — a **deliberate deviation** from general §8.3's one-name-per-page model, required by **segregation of duties**: operate and approve must be grantable to different people (four-eyes), so they cannot be levels of one permission. Each is code-seeded via migration and referenced by a typed constant in `auth/` (`PERMISSIONS.BILLRUN_VIEW` / `_OPERATE` / `_APPROVE`). `billrun_operate` and `billrun_approve` each **imply** `billrun_view`. A **Billing Viewer** role (Finance, Internal Audit) carries `billrun_view` alone. All three, plus the M2M path, are in the authz-sweep inventory.

Authoritative; mirrors `billmgmt-architecture.md` §4. New pages/actions are appended before they ship (general §9).

| Surface | Route | Top-level component(s) | Folder | Permission : level |
|---|---|---|---|---|
| Bill Runs list (Current & Upcoming / Historical) + lazy materialize | `/billing/bill-runs` | `BillRunsPage` → `BillRunList`, `RunActionCard`, `RunStatusBadge` | `app/(app)/billing/bill-runs/` | `billrun_view` : **READ** |
| Run detail — Workflow / Customers & Bills / Uncharged / Errors / Audit + posting-progress | `/billing/bill-runs/[runId]` | `BillRunDetailPage` → `StageTimeline`, `CustomerBillTable`, `UnchargedTable`, `ErrorsTable`, `AuditTable`, `PostingProgressView` | `app/(app)/billing/bill-runs/[runId]/` | `billrun_view` : **READ** |
| Trigger / Rerun / Check status / Cancel a run | `/billing/bill-runs/[runId]` (dialogs + `StallBanner`) | `TriggerRunDialog`, `RerunDialog`, `StallBanner`, `CancelRunDialog` | `actions/billing/{trigger,rerun,check-status,cancel-run}.action.ts` | `billrun_operate` : **EDIT** |
| Approve & Post (four-eyes money gate) | `/billing/bill-runs/[runId]/approve` | `ApproveAndPostPage` → `ApproveAndPostPanel`, `PreApprovalChecks` | `app/(app)/billing/bill-runs/[runId]/approve/`, `actions/billing/{approve,post}-run.action.ts` | `billrun_approve` : **EDIT** |
| M2M — stage completion signal | `POST /api/billrun/[runId]/stage/[stage]/complete` | `route.ts` → `handleStageSignal` | `app/api/billrun/[runId]/stage/[stage]/complete/` | **Service token** (no RBAC) |
| M2M — run-level status push | `POST /api/billrun/[runId]/status` | `route.ts` → `handleStatusPush` | `app/api/billrun/[runId]/status/` | **Service token** (no RBAC) |

**Notes**

- Component names are the binding convention (general §9) — create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- `billrun_operate` and `billrun_approve` gate **mutations**; a `billrun_view`-only principal reaches every read surface and no action (verified by the route × level matrix against server actions and handlers, not just navigation).
- The two M2M handlers are **not** in the RBAC matrix — they authenticate a service token and are covered by their own auth tests (401 on bad token; 409 unless `PROCESSING`; 200 replay).
- Deep links (`/billing/bill-runs/[runId]?tab=…`) pass through the `billrun_view` guard; the searchParam grants nothing.
- **bm02 (delivered):** the `/billing/bill-runs` list page lazily materializes each active monthly cycle's single most-recent due run on its RSC render (a write, not an action/route/job — Inv. #10) before the read. Materialization writes exactly one `BILL_RUN_MATERIALIZED` `core.AUDIT_LOG` row **per row actually inserted**, as a **system write with `actorUserId = null`** (it is triggered by a page view but is not an operator mutation); a no-op load writes none. The Historical CSV export is a `billrun_view`-guarded **Server Action** (`actions/billing/export-runs.action.ts`), never a Route Handler, and — being read-only — is **not** audited. The `STUB_DATA_MODE` env flag drives `StubDataBanner`/`StubBadge` (Inv. #15); it is threaded server-side as a prop, never read in a client component.
- **bm03 (delivered):** the Run action lives on the **list page's `RunActionCard`** (`components/billing/trigger-run-dialog.tsx`, the `TriggerRunDialog` interaction leaf) — **not** the `/billing/bill-runs/[runId]` detail route in the table row above, which bm03 does not build (the detail page, and moving Trigger/Rerun/Cancel there, land with a later unit). `actions/billing/trigger-run.action.ts` requires `billrun_operate:EDIT` and delegates to `services/billing/trigger-run.ts`, which snapshots the cycle's active accounts into `bill_run_account` (marking any account with a partial-period subscription `EXCLUDED`), flips `SCHEDULED → PROCESSING`, resolves `gl_event_at = scheduled_run_date`, and writes one `BILL_RUN_TRIGGERED` audit row — all in one transaction, including the **mockable engine client** call (`services/billing/engine-client.ts`, real fetch client or a `stub-exec-{runId}` stub selected by `isBillRunEngineConfigured`): an engine failure throws, rolling the whole trigger back so the run stays `SCHEDULED` with no orphan snapshot. The confirm-dialog copy omits the plan's `{N} eligible accounts` placeholder (scoping only happens server-side at click time, so no pre-click count exists without a new preview endpoint out of this unit's scope) — the actual `banCount`/`excludedCount` are shown in the post-trigger success message instead.
- **bm04 (delivered):** the `/billing/bill-runs/[runId]` detail row above is now built — `BillRunDetailPage` guards `billrun_view:READ`, parses `runId` against the `BRN` schema (invalid or unknown → `notFound()`), and composes `RunDetailTabs` (`?tab=` view state) around `StageTimeline` (Workflow tab only; Customers & Bills/Uncharged/Errors/Audit are inert placeholders filled by bm05-07). The two M2M rows are now real: `requireServiceToken` (`lib/service-token.ts`, constant-time bearer compare against the new `BILLRUN_APP_TOKEN` config var, fail-closed when unset) gates both handlers before any Zod parse; `handleStageSignal` (`services/billing/handle-stage-signal.ts`) inserts the new partitioned `bill_run_account_stage` row first inside one transaction — a caught unique-violation on the idempotency latch returns `replayed: true` with no further writes — then applies the stage's effect (the Validation stage's outcome is **computed by the app** via `validateAccount`, overriding whatever the caller's body said; `collection`/`aggregation`/`taxation`/`verification` are pass-through record-and-advance), advances the account (`PENDING→PROCESSING` on first signal; a `HARD` failure → `PROCESSING_FAILED`; `INFRA` → no terminal change), and recomputes `bill_run.status` under the `FOR UPDATE` lock already held by `findByIdForUpdate` (no second lock needed) via the pure `computeRunStatus` — `PROCESSED` once every account is `PROCESSED`/`PROCESSING_FAILED`/`EXCLUDED`. `handleStatusPush` is the narrower "execution failed" push (resolved decision: the only status a caller can push in v1 is `PROCESSING_FAILED` — `PROCESSED` is always derived by the stage recompute, never pushed; see `billmgmt-progress-tracker.md` Session Notes). Both handlers 409 unless the run is `PROCESSING`. `AccountStatusBadge` ships with this unit (code-standards §4.1 — "the first unit that renders a per-account row").
- **bm05 (delivered):** the new partitioned `billing.customer_bill` table lands (composite PK, `UNIQUE (run, ban, period_partition)`, `BillCategory`/`BillState` CHECKs, reserved nullable `ref_bill_format_id`/`ref_bill_template_version_id` with no FK, and the nullable `ref_inv_document_id`/`posted_attempt`/`charge_checksum` finalization columns — none populated in v1). `handleStageSignal` gains two more stage-specific effects alongside bm04's Validation override: **Collection** (`services/billing/collect-claim.ts`) is a v1 no-op that always records the stage `DONE` regardless of the caller's signalled status — the same app-computed-override shape as Validation, because there is no `rating` table to claim from in v1 (a `// deferred: rating claim + grant land with the rating engine` marker documents where the real claim goes). **Aggregation** (`services/billing/aggregate-bill.ts`) stays record-and-advance pass-through for the stage row itself, but a `DONE` aggregation signal triggers a side effect inside the same transaction: a rerun-safe conditional `DELETE ... WHERE ref_inv_document_id IS NULL` + INSERT of one trial `customer_bill` (`category: 'trial'`, `state: 'new'`, `payment_due_date` = the run's `scheduled_run_date` + the resolved `coalesce(account override, cycle default)` payment-term days, reusing `resolveTerm`). `subtotal` is a **deterministic synthetic stub** — a pure, stable function of `billing_account_id` alone (`deriveStubSubtotal`, no randomness, computed via the platform decimal helper `services/accounts/money.ts` in integer sen, never JS float); `tax_total` stays `"0.00"` and `total_amount` equals `subtotal` in v1 (Taxation is bm06's stage, not computed here). The Customers & Bills tab (`services/billing/read/list-account-bills.ts`, `CustomerBillTable`, `BillCategoryBadge`) fills the bm04 placeholder — a per-row native `<details>` disclosure (no client component needed) expands to a single synthetic "Stub charges (fixture)" line equal to the subtotal, with a note that itemized lines arrive with the rating engine. `EXCLUDED` accounts never appear here structurally — they never reach Aggregation (bm04's `advanceAccountStatus` keeps them terminal), so no row for them is ever written.
- **bm06 (delivered):** the new partitioned `billing.customer_bill_tax_item` table lands (composite PK `(customer_bill_tax_item_id, period_partition)`, composite FK to `customer_bill` on `(ref_customer_bill_id, period_partition)`, `tax_rate numeric(5,2)`/`tax_amount numeric(18,2)`, no JSONB — financially significant, §6.12). v1 taxation is a **single configured GST rate** — there is **no tax-rate catalog table** (deferred with the rating engine): `billRunTaxConfig` (`lib/config.ts` — `BILLRUN_TAX_RATE`/`BILLRUN_TAX_VERSION`/`BILLRUN_TAX_CATEGORY`, GST defaults `8.00`/`GST-2026`/`GST`) parameterises the SQL. `handleStageSignal` gains a fourth stage-specific effect (the same side-effect shape as bm05's Aggregation, not an outcome override): a `DONE` `taxation` signal for a `PROCESSING` account triggers `taxBill` (`services/billing/taxation.ts`) inside the same transaction — resolve the account's **unposted** trial bill (`ref_inv_document_id IS NULL` latch; no bill yet ⇒ reject so the ingest txn rolls back and the engine retries after Aggregation), stamp `bill_run.ref_tax_rate_version` once (idempotent, uniform per run), then rerun-safely replace the bill's tax items (`DELETE` + `INSERT`) with `tax_amount = round(subtotal * rate / 100, 2)` computed **in SQL `numeric`** (never JS float, §2.3), and recompute `tax_total` (the SQL `SUM` of the items) + `total_amount = subtotal + tax_total`, also in SQL. A posted bill is never re-taxed (every write is latch-guarded). The Customers & Bills expander (`CustomerBillTable`) gains a **Tax** section (each item as `{category} @ {rate}% → {amount}`) and a tax-inclusive total; `CustomerBillRow` gains `taxItems[]` and `list-account-bills.ts` joins them. The dedicated `customer-bill-tax-item.repository.ts` holds the tax-item writes/reads; the totals recompute + unposted-bill resolve live on `customer-bill.repository.ts`; the version stamp on `bill-run.repository.ts`.
- **bm07 (delivered):** **no new table.** The **Verification** stage (stage 6) stops being bm04's record-and-advance pass-through and joins Validation/Collection as an app-computed override: `handleStageSignal` calls `verifyAccount` (`services/billing/verify.ts`) for a `verification` signal, whose recorded outcome — not the caller's body — lands on the stage row. v1 is deliberately minimal (no rating, no prior-period baseline ⇒ variance/plausibility deferred): it **always records `DONE`** (never fails/blocks the run) plus, only when a single cheap backstop fails (the account's unposted bill `total_amount <= 0`, computed in SQL `numeric`), a **`SOFT` finding on that same stage row** (`error_class = 'SOFT'`, `error_code = 'NON_POSITIVE_TOTAL'`) — findings are `SOFT` stage rows, **not a new findings table**. The three remaining run-detail tabs fill the bm04 placeholders, each read only for its own active `?tab=` (same fetch-per-tab idiom as bm05's Customers & Bills): **Uncharged** (`UnchargedTable`, `services/billing/read/list-uncharged.ts` → `billRunAccountRepository.listExcludedForRun`) lists the run's `EXCLUDED` accounts (info/neutral "revenue queue", §4.7) with reason (`error_code`, `PARTIAL_PERIOD`), the uncharged window (the run period), and an **indicative value of "—"** (no rating source in v1); it is CSV-exportable (`actions/billing/export-uncharged.action.ts` + `ExportUnchargedButton`, the bm02 Server-Action + `Blob` precedent, `billrun_view:READ`, unaudited) and **deep-links each row to `/accounts/transactions?fa=…&ban=…`** ("Manual DBN/ADJ"). **Errors** (`ErrorsTable`, `list-errors.ts` → `billRunAccountRepository.listErrorsForRun`) lists the run's `PROCESSING_FAILED` accounts joined to their latest-attempt `HARD` `bill_run_account_stage` row (destructive "blocking" treatment, §4.7, `ErrorClassBadge` + stage/code/detail + an inert "Rerun these accounts" affordance — the rerun action lands in bm08). **Audit** (`AuditTable`, `list-run-audit.ts` → `auditLogRepository.findByTargetId`) reuses the platform `AuditLogTable`/`AuditLogRow` unchanged (§4.8 — never fork a table), filtered to `target_id = runId`, newest first. Zero-exceptions on Uncharged/Errors is a positive empty state, not a blank tab.
- **bm08 (delivered):** **no new table.** The **Trigger / Rerun / Cancel** row's `RerunDialog` + `actions/billing/rerun-run.action.ts` are now real (still `billrun_operate:EDIT`). `rerunRun` (`services/billing/rerun-run.ts`) is one `db.transaction`, **pre-approval only** (rejects unless the run is `PROCESSED`/`PROCESSING_FAILED`, a typed `NOT_RERUNNABLE`): (1) **AUDIT FIRST** — one `BILL_RUN_RERUN` `core.AUDIT_LOG` row (`beforeData.priorTotals` = the SQL-summed current bill total of the rerun accounts; `afterData` = `{ accounts, fromStage, attempt, reason }`) written **before** the engine is re-triggered (§1.10); (2) every selected account's `attempt_count` is set to one uniform new attempt (max + 1) (`billRunAccountRepository.setAttemptForRerun`), dropping them back to `PROCESSING` and clearing their prior diagnostics; (3) **later stages invalidated implicitly** — `bill_run_account_stage` is keyed by `attempt`, so the bumped attempt makes every new-attempt signal from the chosen stage onward land on a fresh row, prior-attempt rows staying as history (no stage-row DELETE); (4) **trial bills re-derived** from the chosen stage onward — `aggregateBill`/`taxBill` (bm05/bm06) under the rerun-safe `ref_inv_document_id IS NULL` guard (a rerun from `verification` re-derives nothing; from `taxation` re-taxes only; from `aggregation`/`collection`/`validation` rewrites then re-taxes); (5) **claim release/re-claim is a documented v1 no-op** (no `rating` table); (6) the engine (stub) is re-triggered scoped to the rerun accounts + new attempt, then the run loops back to `PROCESSING` (`markRerunProcessing` — refreshed counters + new execution ref, clears the prior `processed_at`, never touches `gl_event_at`/`triggered_by`). The **finalization guard is absolute** — `EXCLUDED` and posted (`ref_inv_document_id` set, `customerBillRepository.listPostedAccountIds`) accounts are dropped from the eligible set, so nothing finalized is ever invalidated or re-derived (Inv. #4). `accountIds` MAY be empty (the run-level "Rerun" control ⇒ all eligible; the Errors tab passes the failed accounts); an empty resolved set is a typed `NO_ACCOUNTS_SELECTED`; the mandatory `reason` (empty ⇒ `VALIDATION_ERROR`) and the in-txn engine failure (`ENGINE_UNREACHABLE`, whole rerun rolled back) round out the result union. The `RerunDialog` (Errors tab + a `billrun_operate`-gated run-level header control) previews the scope + `Validation`→`Verification` stage selector + reason and `router.refresh()`es on success; the bm07 inert affordance is replaced.

- **bm09 (delivered, cross-module):** Accounts-side `INV` document type +
  posting enablement, additive only. `types/accounts.ts` `DOC_TYPES` gains
  `INV`; `db/repositories/accounts/document.repository.ts`
  `DOC_SEQUENCE_NAME.INV = "billing.document_inv_seq"`; migrations `0031`/
  `0032` add the sequence and drop+add both `doc_type` CHECKs (`document`,
  `reason_code`) to admit `'INV'` (the `0014` NOT-VALID/VALIDATE idiom). The
  seeded `STANDARD_INVOICE` reason code (`postingNature: 'revenue'`,
  `autoPostLimit: '999999999999.99'`) keeps `postDocument`'s
  `totalAmount > auto_post_limit` gate from tripping for any invoice at or
  below that seeded limit, so in practice an `INV` document **auto-posts from
  `draft`** (a total exceeding the limit would still fall to `submitDocument`/
  `postDocument`'s approval path like any other reason code) — the run-level
  four-eyes (bm10) is the sole
  second signature, and each INV's `created_by` is the approver.
  `services/accounts/leg-templates.ts` gains `INV_LEG_TEMPLATES` (`charge` =
  A/R debit + revenue credit, `release` reused as the tax-line key = A/R
  debit + tax-payable credit — the same shape as `DBN`, reusing the existing
  seeded GL mappings, no new mapping rows). The **period-close guard**
  (`billRunRepository.findActiveForPeriod`, called from
  `services/accounts/period-close.ts`'s `closePeriod` before the accounting
  period is touched) refuses to close a `(period, currency)` while any
  `billing.bill_run` — joined to its `customer_bill`s for currency — has
  `gl_event_at` in that period and `status NOT IN ('COMPLETED','CANCELLED')`,
  returning a typed `BILL_RUN_IN_PROGRESS` with `activeRunIds`, surfaced by
  `ClosePeriodButton` as "N bill run(s) still posting into {period}." Existing
  Accounts documents/postings/period-close are byte-identical (guardrail
  test) — the two CHECKs only *gained* `'INV'`, no existing row changed.

- **bm10 (delivered):** **no new table.** The `/billing/bill-runs/[runId]/approve`
  row is now real (`billrun_approve:EDIT`): `ApproveAndPostPage` →
  `ApproveAndPostPanel` + `PreApprovalChecks`. `services/billing/pre-approval-checks.ts`
  (`runPreApprovalChecks`, five pure-ish reads: accounting period open, GL
  mappings resolvable via bm09's `gl_resolution_view` — `ledgerRepository
  .resolveGlCodeByName` resolves `sys.revenue.{ccy}`/`sys.tax_payable.{ccy}`
  for every currency among the run's postable bills —, no zero/negative
  postable subtotals/totals, four-eyes — approver ≠ **every** operator who
  triggered OR reran the run (the `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN` audit
  actors ∪ `bill_run.triggered_by`), so an Ops user who reran cannot approve
  their own work; approval must come from a separate approver (e.g. a manager)
  —, and all accounts terminal) backs both the page's live
  preview and the approve transaction's own re-check, so the two can never
  disagree. `services/billing/approve-run.ts` (`approveRun`) — one
  `db.transaction`: `findByIdForUpdate` → guard `PROCESSED` (else
  `NOT_APPROVABLE`) → the five checks (a failing four-eyes check returns its
  own `FOUR_EYES_VIOLATION`; any other failure(s) bucket under
  `CHECKS_FAILED`) → stamp `approved_by`/`approved_at`/the immutable
  `total_amount` (`customerBillRepository.sumPostableTotalForRun`, the SQL
  sum over bills whose account is `PROCESSED`) → mark every
  `PROCESSING_FAILED`/`EXCLUDED` account `SKIPPED`
  (`billRunAccountRepository.markSkippedForRun`) → flip `PROCESSED → APPROVED`
  → `insertAuditEvent(BILL_RUN_APPROVED)`. The DB `bill_run_approver_distinct_check`
  CHECK (bm02) remains the backstop; the service is the primary enforcement.
  Posting (`APPROVED → POSTING → INVOICED`) is bm11 — this unit stops at
  `APPROVED`. The run detail page's header gains a `billrun_approve`-gated
  "Approve & Post" link to the new route, shown only while the run is
  `PROCESSED` (show/hide only; the page + action re-check server-side).

- **bm11 (delivered):** **no new table** — every column posting stamps
  (`bill_run.posting_started_at`/`invoiced_at`/`completed_at`,
  `customer_bill.ref_inv_document_id`/`posted_attempt`/`charge_checksum`) was
  already reserved by bm02/bm05, so this unit is additive-only writes, no
  migration. `services/billing/post-run.ts` — `postAccount(run, banId,
  actorId)` runs entirely inside one `db.transaction` (Inv. #6): skip if the
  bill already carries `ref_inv_document_id` (resume) → read the trial bill +
  the account's `attempt_count` → build one `INV` (`documentRepository.insert`,
  `STANDARD_INVOICE`, `createdBy` = the run's stamped `approvedBy`) with a
  `charge` line (`subtotal`) and, when `tax_total > 0`, a `release` tax line
  (bm09's INV leg template) → `postDocument` (auto-posts under the unlimited
  limit) → on success, stamp the bill (`customerBillRepository.stampPosted`,
  `charge_checksum` from the new SQL `md5` formula in
  `computeChargeChecksum`) and mark the account `INVOICED`; on any
  `postDocument` failure the transaction throws so nothing commits (Inv. #7's
  tolerated invoice-number gap), and a SEPARATE, non-transactional write parks
  the account (`status` stays `PROCESSED`, `errorCode`/`errorDetail` set) so
  `PERIOD_CLOSED` — and any other posting failure — is a tolerated, resumable
  per-account error, never a run-level abort. `postRun(billRunId, actorId)`
  flips `APPROVED → POSTING` once (idempotent resume), posts every
  `PROCESSED` account in its own transaction via `postAccount`, then — once no
  account remains `PROCESSED` — completes the run straight to `COMPLETED`
  (`billRunRepository.completePosting`, stamping `invoiced_at`/`completed_at`
  together; `DISTRIBUTING` is never entered, ai-workflow-rules §3.4) and
  writes `BILL_RUN_POSTED` (`AUDIT_EVENT_TYPES`/`AUDIT_EVENT_CATEGORY_MAP`,
  `"Additive"` — it marks new INV documents existing, not merely a status
  flip). `actions/billing/post-run.action.ts` requires `billrun_approve:EDIT`
  (the same money gate as approve) and is re-invocable (Retry-failed is
  literally the same action). **No new route** — `/billing/bill-runs/[runId]/
  approve` now branches server-side on the live `getApprovePreview` status:
  `PROCESSED` renders the unchanged bm10 `ApproveAndPostPanel`; anything past
  it renders the new `PostingProgressView` (`services/billing/read/
  get-posting-progress.ts`'s `getPostingProgress`, a per-account DERIVED
  display status — `pending`/`invoiced`/`PERIOD_CLOSED`/`failed`, never a
  stored column) with an explicit Post/Retry-failed button (never auto-fired
  on page load — posting is financially consequential, same explicit-confirm
  discipline as every other operator mutation in this module). The run detail
  page's header gains a second `billrun_approve`-gated link ("Post" when
  `APPROVED`, "Resume posting" when `POSTING`) to the same `/approve` route,
  alongside bm10's unchanged "Approve & Post" link.

- **bm12 (delivered):** **no new table.** `STALLED` is a derived display flag
  (`services/billing/stall.ts`'s pure `isStalled(run, now, thresholdMinutes)`
  — `status = 'PROCESSING'` and `now() - last_progress_at` past the new
  `BILLRUN_STALL_THRESHOLD_MINUTES` config (default `30`, `lib/config.ts`) —
  never written to `bill_run` (Inv. #10). The run detail page computes it live
  and renders `StallBanner` only for a `billrun_operate:EDIT` principal (same
  show/hide convention as Rerun/Approve/Post). **Check status**
  (`services/billing/reconcile-run.ts`'s `reconcileRun`, one row-locked
  `db.transaction`) polls the mockable engine client's two new methods
  (`getExecutionStatus`/`killExecution`, `services/billing/engine-client.ts` —
  the stub returns a synthetic `{ state: 'RUNNING' }`/no-op kill; the real
  paths are flagged "verify against the deployed engine version" per the
  spec's open item): `RUNNING` bumps `last_progress_at` only; `FAILED`/`KILLED`
  pushes the run to `PROCESSING_FAILED`
  (`billRunRepository.markProcessingFailed`); `SUCCESS` re-derives the run
  status from the account grain via the same pure `computeRunStatus` every
  stage signal uses — flips to `PROCESSED` if every account is now terminal,
  else bumps the heartbeat and surfaces a `mismatch: true` (never forces a
  status the account grain doesn't support). Every branch writes one
  `BILL_RUN_RECONCILED` audit row. **Cancel run**
  (`services/billing/cancel-run.ts`'s `cancelRun`, one `db.transaction`) is
  guarded to `status = 'PROCESSING'` only (`STALLED` is the same underlying
  status, just derived): best-effort `killExecution` (a failed kill is logged
  but still lets cancel proceed) →
  `billRunAccountRepository.resetForCancel` (every non-`EXCLUDED` scoped
  account → `PENDING`, diagnostics cleared) →
  `billRunRepository.cancel` (`CANCELLED`, execution ref columns nulled) →
  one `BILL_RUN_CANCELLED` audit row. **Cancellation consumes no invoice
  numbers** (pre-approval only, nothing posted) and the run is
  **re-triggerable**: `services/billing/trigger-run.ts`'s guard now accepts
  `SCHEDULED` (unchanged) or `CANCELLED` — re-triggering from `CANCELLED`
  re-scopes fresh via `scopeAccounts` and re-snapshots under a **new attempt
  sequence** (`billRunAccountRepository.maxAttemptForRun` + 1, after
  `deleteForRun` clears the killed execution's prior snapshot), so the
  re-triggered engine's stage signals can never collide with
  `bill_run_account_stage` history the killed execution left behind
  (architecture Inv. #5 — the idempotency latch is keyed by attempt); the
  normal `SCHEDULED` first-trigger path is untouched (attempt stays the
  literal `1`, no extra queries). Two new audit events —
  `BILL_RUN_CANCELLED`/`BILL_RUN_RECONCILED`, both `"Change"` — join
  `AUDIT_EVENT_TYPES`/`AUDIT_EVENT_CATEGORY_MAP`. `actions/billing/
  {check-status,cancel-run}.action.ts` both require `billrun_operate:EDIT`
  and revalidate the run page (cancel also revalidates the list page, since a
  cancelled run's list-page affordance changes).

---

## 9. Module Guardrail Tests (CI gate, general §10.4)

The general test-suite gate includes this module's guardrails; each ships with the unit that introduces the behavior:

1. **Authz matrix** — the three pages × role/level, incl. the `operate` ≠ `approve` split (an `operate`-only principal cannot approve/post; four-eyes: approver == final trigger actor → reject).
2. **M2M auth** — missing/invalid bearer → 401; valid stage signal advances `bill_run_account_stage` in one txn; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**; signal after `APPROVED` → 409; charge fields in body → rejected; **the stage signal writes NO per-signal `core.AUDIT_LOG` row** — the appended `bill_run_account_stage` row is the sole stage audit surface (§1.10). Land this assertion with the M2M-handler unit that introduces the signal path.
3. **Claim correctness** — a UDR already claimed by another run is never re-claimed; rerun releases then re-claims; release refused for rows on a posted invoice; the claim is the only `rating.*` write (asserted structurally against `db/repositories/billing/`).
4. **Finalization latch** — a `customer_bill` with `ref_inv_document_id` set cannot be deleted or invalidated; posting retry skips already-`INVOICED` accounts; a crash between INV-number consumption and the stamp commit does not double-post.
5. **No billing charge copy** — no table in `db/schema/billing/` stores charge amounts; `charge_checksum` detects a change to a posted invoice's `rating` lines.
6. **Partition/idempotency** — `period_partition` is fixed per run across a cross-month rerun; the stage UNIQUE includes `period_partition`; run status is recomputed under `FOR UPDATE`, and any cached counter equals the derived value.
7. **Status/materialize** — every legal `RunStatus`/`AccountStatus` transition accepted, illegal rejected; `STALLED` is never persisted; concurrent list loads create exactly one `bill_run` row; the next cycle is operable once the prior run reaches `INVOICED` (not `COMPLETED`).
8. **Stub isolation** — while the stub flag is set every run is visibly badged and the environment is isolated from any real-Accounts ledger.
