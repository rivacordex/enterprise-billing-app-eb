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
   - `AccountStatus`: `'PENDING' | 'PROCESSING' | 'PROCESSED' | 'INVOICED' | 'DISTRIBUTING' | 'COMPLETED' | 'PROCESSING_FAILED' | 'DISTRIBUTION_FAILED' | 'SKIPPED'`
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
   - `AccountStatusBadge` — the 9 `AccountStatus` values, incl. `SKIPPED` (muted) and `PROCESSING_FAILED` (destructive).
   - `StageStatusBadge` — `PENDING/RUNNING/DONE/FAILED/SKIPPED`.
   - `ErrorClassBadge` — `HARD` (destructive) / `SOFT` (warning) / `INFRA` (neutral).
   - `BillCategoryBadge` — `trial` (muted/outline) / `normal` / `last`.
2. **`StubDataBanner` is unmissable and always-on while the stub flag is set** (Inv. #15): a persistent full-width banner on every bill-run tab plus a `StubBadge` list-row chip, using warning tokens. Copy: "Stub data — figures are fixtures, not production charges." Never conditionally hidden by a per-run field (there is no `udr_mode` column); it reads the environment/config stub flag threaded server-side as a prop.
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
  stub-data-banner.tsx         # StubDataBanner + StubBadge
  stall-banner.tsx             # StallBanner
  trigger-run-dialog.tsx  rerun-dialog.tsx  cancel-run-dialog.tsx
services/billing/
  materialize-runs.ts          # lazy run creation from bill_cycle (ON CONFLICT DO NOTHING)
  trigger-run.ts               # snapshot accounts, PROCESSING, resolve gl_event_at, call engine
  handle-stage-signal.ts       # ingest: insert stage row first, advance account, recompute (FOR UPDATE)
  handle-status-push.ts
  rerun-run.ts                 # audit-first, invalidate later stages, re-derive trial bill
  cancel-run.ts
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
validation/billing/
  stage-signal.schema.ts  status-push.schema.ts
  trigger-run.schema.ts  rerun-run.schema.ts  approve-run.schema.ts
  run-list.schema.ts      run-id.schema.ts
tests/…                        # mirrors source; route × level matrix for the three pages + the two M2M handlers
```

1. **The single rating write is isolated in `db/repositories/billing/rating-claim.ts`** — the only file in the module that issues an `UPDATE rating.udr_rated`. No other repository writes the `rating` schema (Inv. #2), which makes the boundary greppable and testable.
2. **`services/billing/**` is framework-agnostic** (no `next/*`), and the ingest handlers and Server Actions call the **same** service functions (§1.2) — never a duplicated code path.
3. **The workflow-engine HTTP client lives in `lib/` (or `services/billing/engine-client.ts`), reads its Basic-Auth credential from Key Vault, and is called only by `trigger-run.ts`/`cancel-run.ts`.** No page, component, or Route Handler calls the engine directly.
4. **Do not fork the nav** — the Billing section is a `NAV_SECTIONS` entry, not a new nav component.

---

## 8. Permission Names & Per-Page Permission Map

**Permission names** (general §8): this module ships **three** permission names — `billrun_view`, `billrun_operate`, `billrun_approve` — a **deliberate deviation** from general §8.3's one-name-per-page model, required by **segregation of duties**: operate and approve must be grantable to different people (four-eyes), so they cannot be levels of one permission. Each is code-seeded via migration and referenced by a typed constant in `auth/` (`PERMISSIONS.BILLRUN_VIEW` / `_OPERATE` / `_APPROVE`). `billrun_operate` and `billrun_approve` each **imply** `billrun_view`. A **Billing Viewer** role (Finance, Internal Audit) carries `billrun_view` alone. All three, plus the M2M path, are in the authz-sweep inventory.

Authoritative; mirrors `billmgmt-architecture.md` §4. New pages/actions are appended before they ship (general §9).

| Surface | Route | Top-level component(s) | Folder | Permission : level |
|---|---|---|---|---|
| Bill Runs list (Current & Upcoming / Historical) + lazy materialize | `/billing/bill-runs` | `BillRunsPage` → `BillRunList`, `RunActionCard`, `RunStatusBadge` | `app/(app)/billing/bill-runs/` | `billrun_view` : **READ** |
| Run detail — Workflow / Customers & Bills / Uncharged / Errors / Audit + posting-progress | `/billing/bill-runs/[runId]` | `BillRunDetailPage` → `StageTimeline`, `CustomerBillTable`, `UnchargedTable`, `ErrorsTable`, `AuditTable`, `PostingProgressView` | `app/(app)/billing/bill-runs/[runId]/` | `billrun_view` : **READ** |
| Trigger / Rerun / Cancel a run | `/billing/bill-runs/[runId]` (dialogs) | `TriggerRunDialog`, `RerunDialog`, `CancelRunDialog` | `actions/billing/{trigger,rerun,cancel}-run.action.ts` | `billrun_operate` : **EDIT** |
| Approve & Post (four-eyes money gate) | `/billing/bill-runs/[runId]/approve` | `ApproveAndPostPage` → `ApproveAndPostPanel`, `PreApprovalChecks` | `app/(app)/billing/bill-runs/[runId]/approve/`, `actions/billing/{approve,post}-run.action.ts` | `billrun_approve` : **EDIT** |
| M2M — stage completion signal | `POST /api/billrun/[runId]/stage/[stage]/complete` | `route.ts` → `handleStageSignal` | `app/api/billrun/[runId]/stage/[stage]/complete/` | **Service token** (no RBAC) |
| M2M — run-level status push | `POST /api/billrun/[runId]/status` | `route.ts` → `handleStatusPush` | `app/api/billrun/[runId]/status/` | **Service token** (no RBAC) |

**Notes**

- Component names are the binding convention (general §9) — create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- `billrun_operate` and `billrun_approve` gate **mutations**; a `billrun_view`-only principal reaches every read surface and no action (verified by the route × level matrix against server actions and handlers, not just navigation).
- The two M2M handlers are **not** in the RBAC matrix — they authenticate a service token and are covered by their own auth tests (401 on bad token; 409 unless `PROCESSING`; 200 replay).
- Deep links (`/billing/bill-runs/[runId]?tab=…`) pass through the `billrun_view` guard; the searchParam grants nothing.

---

## 9. Module Guardrail Tests (CI gate, general §10.4)

The general test-suite gate includes this module's guardrails; each ships with the unit that introduces the behavior:

1. **Authz matrix** — the three pages × role/level, incl. the `operate` ≠ `approve` split (an `operate`-only principal cannot approve/post; four-eyes: approver == final trigger actor → reject).
2. **M2M auth** — missing/invalid bearer → 401; valid stage signal advances `bill_run_account_stage` in one txn; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**; signal after `APPROVED` → 409; charge fields in body → rejected.
3. **Claim correctness** — a UDR already claimed by another run is never re-claimed; rerun releases then re-claims; release refused for rows on a posted invoice; the claim is the only `rating.*` write (asserted structurally against `db/repositories/billing/`).
4. **Finalization latch** — a `customer_bill` with `ref_inv_document_id` set cannot be deleted or invalidated; posting retry skips already-`INVOICED` accounts; a crash between INV-number consumption and the stamp commit does not double-post.
5. **No billing charge copy** — no table in `db/schema/billing/` stores charge amounts; `charge_checksum` detects a change to a posted invoice's `rating` lines.
6. **Partition/idempotency** — `period_partition` is fixed per run across a cross-month rerun; the stage UNIQUE includes `period_partition`; run status is recomputed under `FOR UPDATE`, and any cached counter equals the derived value.
7. **Status/materialize** — every legal `RunStatus`/`AccountStatus` transition accepted, illegal rejected; `STALLED` is never persisted; concurrent list loads create exactly one `bill_run` row; the next cycle is operable once the prior run reaches `INVOICED` (not `COMPLETED`).
8. **Stub isolation** — while the stub flag is set every run is visibly badged and the environment is isolated from any real-Accounts ledger.
