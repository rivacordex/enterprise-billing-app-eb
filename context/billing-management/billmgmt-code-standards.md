# Billing Management (Bill Run) — Module Code Standards

> Module-specific delta to `../code-standards.md` (the overarching standards). This file contains **only** Bill Run specifics; everything else (general rules, TypeScript, Next.js, styling, API, data, file organization, CI gates) is inherited unchanged and is **not** restated here. If a rule seems missing, it lives in the general file. Where this doc conflicts with the architecture **Module Invariants** (`billmgmt-architecture.md` §6), the Invariants win and the conflict is a bug to fix here.

**Companion docs (authoritative):** `billmgmt-project-overview.md` and `billmgmt-update-overview.md` (product spec, flows, success criteria) · `billmgmt-architecture.md` (technical design, **26** numbered **Module Invariants** §6) · `_updatemodule-billing-billrun-phase3-plan.md` (phase-3 decisions D1–D30) · `_newmodule-billing-billrun-plan.md` (phase-1 functional design & data model).

**Status:** Phase 3 planning, ENG CLEARED (2026-09-14). Component/route/permission names below are the **binding** convention for the build.

> **Phase-3 reversal — read before citing an older rule.** Phase 3 introduces `billing.customer_bill_line` and derives recurring charges in the bill run. Three rules below **reversed**, and any code or spec quoting their previous text is now wrong:
>
> | Rule | Was | Now |
> | --- | --- | --- |
> | §6.3 | "There is no billing-side charge table. **Do not create one.**" | `customer_bill_line` **is** the bill's charge record (§6.3, Inv #3) |
> | §1.1 | "No service, repository, or SQL in this module computes a charge amount." | No **usage-rating** logic in `billing`; recurring charge derivation is sanctioned and lives in the **flow** (§1.1, Inv #1/#17) |
> | §2.4 / §9.5 | `charge_checksum` hashed `rating.udr_rated` rows | Hashes `customer_bill_line` content — all three money columns (§2.4, Inv #3) |
> | §4.2 / §9.8 / §9.16 | `BILLRUN_PLACEHOLDER_MODE` + `PlaceholderBanner` badged every run | **Retired** — the copy is false once the real flows deploy (§4.2, D31). The `_SAMPLE_` marking and `db:seed-sample` prod guard are **kept** |

---

## 1. General Rules (module-specific)

1. **The bill run never rates _usage_ — and no charge compute lives in `services/`.** *(Phase-3 revision of "never computes a charge amount".)* Two separate rules now:
   - **No usage-rating logic in `billing`.** Nothing in this module prices a usage record; `USAGE` amounts are read from `rating.udr_rated` and summed (Inv. #1).
   - **Recurring charge derivation is sanctioned, and it is the flow's.** Resolving a subscription's as-of price and writing a `RECURRING` `customer_bill_line` **is** billing compute — but it runs as `billrun_runtime` inside `bill_run_processing`, never in `services/billing/**` (Inv. #17). A charge-derivation function appearing under `services/billing/**` is a review-blocking defect, enforced by `tests/guardrails/billing-trial-bill-compute-boundary.test.ts`.
2. **Two mutation entry surfaces, kept separate.** Operator mutations flow `actions/billing/**` → `services/billing/*` → repositories, gated by `billrun_operate`/`billrun_approve`. Machine mutations flow `app/api/billrun/**` → the **same** `services/billing/*` functions, gated by the service token. A Server Action never carries a stage signal; a Route Handler never carries an operator action. Both reuse one service layer — never a forked copy.
3. **The app's only `rating` writes are the six claim columns, and the app never claims.** Exactly one repository file (`db/repositories/billing/udr-status.repository.ts`) `UPDATE`s `rating.udr_rated`, limited to `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime` — no `INSERT`, no other column (Inv. #2). The **claim** (`RATED → BILL_DRAFT`) belongs to the flow as `billrun_runtime`; the app only ever moves a row *out* of a claim. There are no cross-schema foreign keys in either direction — joins are plain-text keys.
4. **Four transitions move a row out of a claim, and three of them are releases.** Approve → `BILL_APPROVED`; **reject, cancel and rerun** → release to `RATED` with all four claim columns NULLed (Inv. #19). **The rerun release happens before the re-trigger, never after** — Collection claims `RATED` only, so a row left at `BILL_DRAFT` by an abandoned attempt is unclaimable by the next one and silently drops off the bill. A rerun path that re-triggers without releasing first is a review-blocking defect.
5. **`ref_inv_document_id` is the finalization latch — DB-guarded on the header, app-layer on the lines.** No service `UPDATE`s or `DELETE`s a `customer_bill` row whose `ref_inv_document_id` is set; that guard is `customer_bill_finalization_guard` (migration `0033`). Its `customer_bill_line` children have **no** finalization trigger of their own (a deliberate choice, D27): they are protected by rerun/reject only ever touching unfinalized bills — always through the `ref_inv_document_id IS NULL`-scoped `billrun_delete_trial_bill` — plus the `charge_checksum`. Because that checksum is computed once at posting and **not re-verified afterwards**, a code path that could reach a posted line is a review-blocking defect with no safety net behind it (Inv. #4, general Inv. #18).
6. **Posting is per-account, one transaction each, resumable.** The posting service iterates accounts and opens a fresh transaction per account; there is no "post the whole run in one transaction" function, ever. Every posting transaction first checks the account is not already `INVOICED` (skip) (Inv. #6).
7. **Four-eyes is a service-layer check, never UI-only.** The approve/post service rejects when the approver equals the final-attempt trigger actor (`approved_by === triggered_by` of the latest attempt) with a typed `FOUR_EYES_VIOLATION` result. The UI disabling the button is show/hide only (general §1.2).
8. **Run status is recomputed under a row lock, never incremented.** Every place run status changes issues `SELECT … FOR UPDATE` on the `bill_run` row and derives the new status from `bill_run_account`; no code does `failed_count = failed_count + 1` as the source of truth. Cached counters, if written, are asserted equal to the derived value by a test (Inv. #12).
9. **`STALLED` is never persisted.** No `UPDATE … SET status = 'STALLED'` exists. Staleness is computed on read from `status = 'PROCESSING'` and `last_progress_at` versus the cycle threshold (Inv. #10).
10. **No app scheduler, cron, or background worker.** Runs materialize on page load (§3.2); partition maintenance is `pg_cron`; orchestration is the external workflow engine. A `setInterval`, queue worker, or Container Apps Job in this module is out of bounds (Inv. #10).
11. **Operator mutations are audited atomically; stage signals are their own append-only record.** `materialize`, `trigger`, `rerun`, `approve`, per-account `post`, and `cancel` each write exactly one `core.AUDIT_LOG` row in the same transaction as the change (general §1.7). Per-account **stage** progress is the append-only `bill_run_account_stage` row itself (the drill-down/audit surface); the ingest handler writes that row, not a per-signal `AUDIT_LOG` entry. The rerun audit row is written **before** re-trigger and carries prior totals + reason.
12. **Re-derivation is a whole-account replace, never a per-line upsert.** Recurring lines carry no row-grain claim marker, so their exactly-once guarantee *is* the replace: delete **all** of an account's `customer_bill_line` rows through `billing.billrun_delete_trial_bill(run, ban)`, then re-insert. No code path issues `INSERT … ON CONFLICT DO UPDATE` against `customer_bill_line`, and none issues a bare `DELETE` against it — `billrun_runtime` holds no table-level `DELETE`, so the scoped `SECURITY DEFINER` is the only deletion path (Inv. #16).
13. **On rerun the price snapshot is read, never re-resolved.** As-of resolution runs only when a line has no prior snapshot. Re-resolving would re-walk the `lead()` window and silently re-price a period a human already reviewed, because a `product_offering_price` row inserted later with an earlier start shifts that window. `ordering.order_item_price_override` is insert-only and is **not** the hazard (Inv. #20).
14. **An unresolvable subscriber is a surfaced, non-blocking exception (D32).** Leave the row at `RATED`, unclaimed and untouched; surface it alongside `BILL_NOTUSED` on the per-record exception surface; continue the run; show the count on the pre-approval checklist as informational. Never filter it out of the claim query, and never fail the account on it — the failure *is* not knowing the account (Inv. #25).
14b. **An unresolvable or `tiered` recurring price fails the account HARD (D33).** No as-of `recurring` price, or a `pricing_model = 'tiered'` row (`amount IS NULL` by `product_offering_price_amount_xor_tiers_check`, unratable by the flat resolver) ⇒ `PROCESSING_FAILED` with a `HARD` stage finding and `RECURRING_PRICE_NOT_FOUND` or `RECURRING_PRICE_UNSUPPORTED` on `bill_run_account_stage.error_code`. Produce no bill for that account. Never substitute zero, never skip the subscription silently — recurring is period-keyed and a missed period is never caught up (Inv. #28).
15. **The subscriber→account correlation is computed once per account.** Validation asserts against the correlated set Collection's join produces, or its assertions fold into the claim step; the heaviest join in the pipeline is never run twice per account (Inv. #24).

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
   - `ChargeSource` (phase 3): `'USAGE' | 'RECURRING' | 'OCC'` — `OCC` is **reserved and unbuilt**; nothing emits it this phase. The reservation is prose-only today (no `CHECK` or trigger blocks it), so either a structural guard lands with OCC or the value is deferred until it exists (Inv. #16, D30).
   - `LineType` (phase 3): `'charge' | 'discount' | 'adjustment'` — only `charge` is emitted this phase; the other two exist so a bundle-level discount or an adjustment can become its own line without a migration against a posted table.
2. **`STALLED` is not a member of `RunStatus`.** It is a derived UI flag (`type StallState = 'live' | 'stalled'`), computed in one helper; do not add it to the DB enum or the status union (Inv. #10).
3. **Money is `string` end-to-end** (general §2.15). `subtotal`, `tax_total`, `total_amount`, `tax_amount`, `customer_bill_line.{gross_amount, discount_amount, net_amount}`, and `rating.udr_rated.udr_rated_price` are `numeric` → `string`. **Monetary aggregation happens in SQL** — never by `Number()`/`parseFloat`/`reduce(+)` in JS. If a total must be composed in TypeScript, use the platform decimal helper, never float arithmetic (general §6.16). Note `services/accounts/money.ts` throws above 2dp, so anything working in the 6dp `*_raw` columns must not route through it.
4. **The charge checksum is anchored on `customer_bill_line`, hashes content, and is computed in SQL.** *(Phase-3 replacement — it previously hashed `rating.udr_rated`.)* It hashes `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)` over the account's lines, ordered by the same deterministic grouping key that assigns `line_no` — **never by `customer_bill_line_id`**, which is regenerated on every re-derivation and would make the checksum unreproducible from an archived invoice. All three money columns are hashed, not `net_amount` alone, so a discount that preserves the net stays tamper-evident. Do not re-derive it in TypeScript and do not reformat any amount before hashing (Inv. #3, D7a/D20).
   - **Why the old anchor had to go:** under phase 3 a recurring-only bill claims no `udr_rated` rows at all, so `md5(COALESCE(string_agg(…), ''))` returned `md5('')` — the same constant for every such invoice.
5. **`line_no` is assigned by ordering the grouping key, never by insertion order.** Identical inputs must reproduce identical line numbers across a rerun, so a credit note can reference a line and downstream AP matching on `(invoice, line_no)` survives a re-issue (Inv. #21).
6. **Dates: `gl_event_at`, `period_start`, `period_end`, `period_partition`, `scheduled_run_date`, `payment_due_date` are `date`** (calendar dates, not `timestamptz`); timeline columns (`*_at`) are `timestamptz`, UTC (general §2.13). `gl_event_at` is resolved once at trigger to `scheduled_run_date` and never recomputed (Inv. #13).
7. **Entity IDs are plain `string`s validated by Zod format schemas** (general §6.18): `BRN`+8 digits (`/^BRN\d{8}$/`) and likewise `BRA` (bill_run_account), `BRS` (bill_run_account_stage), `CBL` (customer_bill), `CBT` (customer_bill_tax_item), `BTV` (bill_template_version), and **`BLN` (customer_bill_line, phase 3)** — a distinct three-letter prefix, deliberately *not* an extension of `CBL`, so no prefix scan confuses a line with its header. The `[runId]` route param is parsed against the `BRN` schema before any repository call.
8. **Read models live in `types/` as composed shapes** (general §2.7): `RunListRow` (header + derived counts + derived stall state), `RunDetail`, `AccountRow`, `StageTimelineRow`, `CustomerBillView`, `BillLineRow` (phase 3), `UnchargedRow`, `ErrorRow`. Services return these; pages never re-join or re-derive counts. **`CustomerBillView` now composes `customer_bill_line` rows, not `rating.udr_rated` rows** — the invoice's face is the stored line; `udr_rated` is the per-record drill-down reached by the line's grouping key, and only on demand.
9. **Derived fields are never stored types.** `ban_count`/`rated_count`/`failed_count` are an optional cache; the read models expose the **derived** counts, and the cache is never the source a UI reads (Inv. #12).
10. **Ingest and action inputs are Zod-first** (general §2.8): the stage-signal body, the status-push body, and every operator-action payload have a `validation/billing/*.schema.ts` schema; types come from `z.infer`, never hand-written.

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
   - `ChargeSourceBadge` (phase 3) — `USAGE` / `RECURRING` (neutral, informational; `OCC` unbuilt). It labels a bill line's origin so a reviewer can tell a derived recurring charge from a claimed usage rollup without opening the drill-down.
1b. **The bill-line table is the invoice's face; `udr_rated` is behind a disclosure.** `BillLineTable` renders `customer_bill_line` — one row per `(product_offering_id, udr_type)` with `gross_amount`, `discount_amount`, `net_amount` and the `ChargeSourceBadge`. The per-record `udr_rated` drill-down is a collapsed disclosure on a `USAGE` row, fetched on expand, never eagerly — a `volume`-profile account can sit behind thousands of records. A `RECURRING` row has no drill-down; its evidence is the stored price snapshot, rendered in the same disclosure slot.
1c. **`discount_amount` renders only when non-zero.** No discount is computed this phase, so every line shows `0.00`; suppressing the column until a discount exists keeps the invoice honest rather than implying a capability that is not built.
2. **`BILLRUN_PLACEHOLDER_MODE` is RETIRED (phase 3, D31).** Delete the flag, `components/billing/placeholder-banner.tsx` (`PlaceholderBanner` + `PlaceholderBadge`), and every call site threading the flag server-side as a prop. Reason: the banner's copy asserts "the billing steps are placeholders and `udr_rated` is seeded `_SAMPLE_` test data" — false the moment the real processing and distribution flows deploy, and a loud warning that is wrong is worse than no warning. Architecture Inv #15 becomes a retired tombstone; the number is never reused.
   **What does NOT retire with it** — these are seed-integrity rules, independent of any badge, and they matter more in phase 3, not less:
   - `_SAMPLE_` provenance marking on every seeded `udr_rated` row (`SAMPLE_UDR_SOURCE_FILE`, `udr_ref_batch_id`, `rating_engine_version`), asserted by `tests/guardrails/billing-sample-seed-marker.test.ts`.
   - `db:seed-sample` is prod-guarded and absent from `db:setup`, asserted by `tests/guardrails/billing-sample-seed-boundary.test.ts`.
   - Seeded rows start **unclaimed** — no bill-run reference until a real run claims one.
   **Also retire the stale comment, not just the code:** `BILLRUN_DISTRIBUTION_FORCE_FAIL`'s doc comment in `lib/config.ts` says it fires "against the deployed placeholder flow". The flag itself **stays** (it is the `DISTRIBUTION_FAILED` failure-injection switch, and D8 keeps `loopback` alive in dev/test precisely so it still works) — only the sentence changes.
   **Do not replace it with a quieter banner.** A "seeded data" badge would have to be driven by something that knows whether the data is seeded; no such per-run column exists (§6.13's no-`udr_mode` rule), and adding one to power a badge is the exact coupling that rule exists to prevent. If a non-production marker is wanted later, it is an environment-level concern, specified on its own.
3. **The `StallBanner` is a derived-state banner, not a status pill.** Shown when a run is `PROCESSING` past its stall threshold; offers **Check status** (primary) and **Cancel run** (secondary, danger, inside a spelled-out confirm dialog). Never rendered from a stored `STALLED` value.
4. **Money renders through one `lib/` formatter** — `formatCurrency(amount, currency, locale)` — for every bill total, tax line, and run total. No inline `toFixed`, no hardcoded currency symbol, no client-side sum (totals arrive pre-computed from the service).
5. **Dates render through the platform `formatDatetime(date, locale, timezone, …)`** with timezone threaded as a prop (general §2.13); `<time dateTime>` stays ISO-8601 UTC. GL/period/invoice **dates** (`gl_event_at`, `period_*`, `payment_due_date`) render as calendar dates in the business zone.
6. **The Approve & Post screen uses the danger role for the confirm action only**, inside its confirmation dialog, and always renders the pre-approval checklist (period open, GL mappings resolvable, no zero/negative totals, approver ≠ trigger actor, all accounts terminal) each as an explicit pass/fail row with a remediation line. The self-approval block is visible with its reason.
7. **Uncharged vs Errors are two visually distinct tabs** (never merged): Uncharged uses neutral/info treatment ("revenue queue"), Errors uses destructive treatment ("blocking — fix, then rerun"). A per-row deep link to Accounts → Transactions on Uncharged rows.
   **Phase-3 meaning change (Inv. #22) — the query behind this tab is replaced.** Uncharged lists accounts that produced **no `customer_bill_line`** (or whose lines net to zero). It is no longer "scoped accounts absent from `rating.udr_rated`", which would now misclassify every recurring-only account as uncharged when it has in fact been billed. Two things stay off this tab and need their own treatment: an `EXCLUDED` account (scoping-time partial-period exclusion — it never reached a stage that could produce a line, Inv. #26) and a `udr_rated.status = 'BILL_NOTUSED'` record (a per-record exception, not an account state). The copy must not imply an uncharged account has no subscriptions.
8. **Reuse the Administration table primitives** (pagination, sortable headers, empty state) for the run list, account list, uncharged, and errors tables; never fork a parallel table. Zero-exceptions is a positive empty state, not a blank tab.

---

## 5. API Routes (module-specific)

This module owns the platform's first M2M Route Handlers. They are thin, uniform, and **session-less**.

1. **Exactly three handlers exist, all under `app/api/billrun/`** (bm20 — the sanctioned third-handler architecture decision this rule anticipated):
   - `POST /api/billrun/[runId]/stage/[stage]/complete` — body `{ ban_id, attempt, status, error_class?, error_code?, error_detail? }`.
   - `POST /api/billrun/[runId]/status` — run-level terminal / execution-failure push for EITHER execution: `{ status: 'PROCESSING_FAILED' }` (processing) or `{ status: 'DISTRIBUTION_FAILED' | 'DISTRIBUTION_FINISHED' }` (distribution, bm20 — the latter triggers the app's own COMPLETED/DISTRIBUTION_FAILED recompute from the recorded `bill_run_distribution` outcomes).
   - `POST /api/billrun/[runId]/distribution/outcome` (bm20, new) — body `{ target, artifact_ref, artifact_type, is_mandatory, outcome, attempt }`, one per-artifact-per-target delivery outcome; idempotent on `(run, target, artifact_ref, distribution_attempt)`.
   No `GET`, no other verbs, no other paths. A fourth handler needs its own architecture decision.
2. **No session semantics — bearer service token only** (Inv. #9). The handler never calls `getSession`/`requirePermission`. It authenticates a single bearer token via a **constant-time compare** against the Key Vault value, authorized by the token's fixed scope (not RBAC levels). The token is never logged, never string-manipulated, never returned.
3. **Auth order, every request:** constant-time bearer check (fail → **401**) → Zod-parse the body and `[runId]`/`[stage]` params (fail → **422**) → reject unless the run is in the state the handler expects — `PROCESSING` for the stage-complete handler (a signal after `APPROVED` → **409**) and `DISTRIBUTING` for the distribution-outcome handler (bm20) — → delegate to the service. No business logic in the handler.
4. **Idempotency is the DB constraint, never handler logic** (Inv. #5). The stage handler's service inserts the `bill_run_account_stage` row **first** inside its transaction; a duplicate `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)` hits the UNIQUE constraint and returns **200** as a no-op replay. The handler does not pre-check for existence.
5. **The signal carries no charge payload.** The handler/service never accepts amounts or charge lines over the wire; the flow writes `customer_bill_line` directly as `billrun_runtime` and reads `rating.udr_rated` itself. Reject any body with charge fields. This is what keeps the M2M surface record-only even though the flow now computes money.
6. **The distribution-outcome handler validates target identity against what the run actually launched.** `isLaunchedDistributionIdentity` must check the pushed `target` against the run's **known target set** and the `artifact_ref` against the run's stored invoices or the fixed report ref — it must not hardcode one target name, and it must not accept an `is_mandatory: false` for a target the run configured as mandatory. Phase 3 makes this a set check, because `loopback` and `sftp` can both be live in one run (D8/D25).
7. **A stale-attempt outcome is a 200 replay, not a 409.** An outcome whose `attempt` differs from `bill_run.distribution_attempt` is swallowed as a no-op before the status check, so a straggler from a superseded round can never land on the current round's outcome set — including after the run has left `DISTRIBUTING` entirely.
8. **Status codes** (general §5.5, module usage): `200` accepted / replay no-op · `401` bad token · `409` run not `PROCESSING` · `422` malformed body/params · `500` unexpected. Envelopes and `AppError`→HTTP mapping per general §5.6–5.7.
9. **HTTPS-only, private-network reachable** (architecture §4). This path is added to the authz-sweep inventory. The outbound credential (app → engine) is separate, one-directional, and never handled here.
10. **The run trigger holds a generic execution lock** keyed on `status = 'PROCESSING'`, independent of `workflow_execution_id`: a second trigger while `PROCESSING` is rejected (not a Route Handler concern, but the guard the ingest relies on).

---

## 6. Data and Storage Rules (module-specific)

1. **All module tables live in the `billing` schema** (general §6.3): `bill_run`, `bill_run_account`, `bill_run_account_stage`, `customer_bill`, **`customer_bill_line`** (phase 3), `customer_bill_tax_item`, `bill_run_invoices`, `bill_run_distribution`, `bill_template_version`. No identity/RBAC/session/config/audit tables. Cross-schema references to `core.APPUSER` (`triggered_by`, `approved_by`, `created_by`) by FK; **no FK into or out of `rating.*`** (Inv. #2).
2. **ID prefixes** (format per general §6.18, 8-digit sequence): `BRN`, `BRA`, `BRS`, `CBL`, **`BLN`** (customer_bill_line), `CBT`, `BTV` — one sequence per table, assembled in the DB layer.
3. **[REVERSED IN PHASE 3] `customer_bill_line` is the bill's charge record** (Inv. #3). The former rule — *"There is no billing-side charge table. Do not create one."* — no longer holds; anything still quoting it is wrong. `customer_bill_line` stores one row per `(ref_product_offering_id, udr_type)` per bill with `source`, `line_type`, `gross_amount`, `discount_amount`, `net_amount`, the `udr_rated`-shaped discount columns, `udr_count` + the grouping key (for `USAGE`), and the resolved price snapshot (for `RECURRING`). `customer_bill.subtotal` **must equal** `SUM(customer_bill_line.net_amount)`. `rating.udr_rated` stays the per-record drill-down, reached by the line's grouping key.
   - **Why it reversed:** the invoice's line breakdown is what a human approves and what a customer receives; under the old rule it was stored nowhere and re-derived from a live operational table on every render. Two sources (usage + derived recurring) also cannot both live in `udr_rated`.
4. **Seven record tables are partitioned on `period_partition`** (`bill_run_account`, `bill_run_account_stage`, `customer_bill`, **`customer_bill_line`**, `customer_bill_tax_item`, `bill_run_invoices`, `bill_run_distribution`); `bill_run` and `bill_template_version` are not. `customer_bill_line` takes its parent's 7-year detach-and-archive — a line is part of the invoice's statutory record and must neither outlive nor predecease its header — and needs its own `partman.create_parent` registration plus a partition test; a new partitioned table that is never registered silently accumulates in the default partition. `period_partition` is **fixed per run** (the 1st of the run's period month), written at snapshot/insert — never row-insert time — so cross-month reruns keep all rows in one partition (Inv. #11).
5. **Composite PK/UNIQUE keys include `period_partition`** (Postgres requires the partition key in every unique/PK): `bill_run_account` UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`; `bill_run_account_stage` UNIQUE `(ref_bill_run_id, ref_billing_account_id, stage, attempt, period_partition)`; `customer_bill` UNIQUE `(ref_bill_run_id, ref_billing_account_id, period_partition)`; `customer_bill_line` composite PK `(customer_bill_line_id, period_partition)` with a composite FK to `customer_bill` on `(ref_customer_bill_id, period_partition)` and `ON DELETE CASCADE`, so the existing scoped `billrun_delete_trial_bill` covers rerun re-derivation without a second function. The stage UNIQUE is the idempotency latch — do not drop or weaken it. **`customer_bill_line` deliberately carries no business UNIQUE** on `(bill, offering, udr_type)`: its exactly-once guarantee is the whole-account replace (§1.12), not a row constraint.
6. **Partitioning is registered, not hand-rolled** — a `partition_management` row (`pg_partman` monthly, 84-partition/7-year retention, detach-and-archive) per partitioned table; no bespoke partition DDL in a migration beyond registration. Retention detach/drop is DDL and deliberately bypasses the row delete guard (retention ≠ correction).
7. **Money columns are `numeric(18,2)` → `string`** (general §6.16); `subtotal`/`tax_total`/`total_amount` on `customer_bill` are immutable stamps; due/remaining are **never stored** (derived from pgledger). `total_amount` on `bill_run` is stamped at `APPROVED` and never changed thereafter.
8. **`ref_inv_document_id` is DB-guarded on the header only** (Inv. #4, D27): a `customer_bill` with it set cannot be deleted (`customer_bill_finalization_guard`, migration `0033`) and is skipped on posting retry. **There is no equivalent trigger on `customer_bill_line`** — a deliberate choice — so line immutability rests on rerun/reject only ever calling the `ref_inv_document_id IS NULL`-scoped `billrun_delete_trial_bill`, plus the `charge_checksum`. Rerun's trial re-derivation is that scoped delete + INSERT, never an unconditional delete. **Accepted residual:** the checksum is computed once at posting and not re-verified, so post-posting line tampering has no active detection until a re-verification path is added.
9. **Six claim columns, and the app never claims** (Inv. #2). `app_runtime` holds `SELECT` on `rating.*` plus column-scoped `UPDATE` on exactly `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime` — no `INSERT`, no `DELETE`, no other column. The **claim** (`RATED → BILL_DRAFT`) is the flow's, as `billrun_runtime`, guarded DB-side by `rating.billrun_status_guard`. The app performs only the four out-of-claim transitions (§1.4), all in `udr-status.repository.ts`.
10. **Grants inside `billing` are per-table too, so a new table is inaccessible until granted.** `customer_bill_line` needs an explicit **`SELECT`-only** grant to `app_runtime` (the posting checksum and the final render read it) and **no table-level `DELETE`** to `billrun_runtime` (the scoped `SECURITY DEFINER` is the only deletion path). A missing `app_runtime` grant surfaces at posting, not at migration time.
11. **A `RECURRING` line stores its price snapshot, and the snapshot wins on rerun.** Price ref, resolved rate, quantity and effective date are columns on the line. Re-derivation reads them; as-of resolution runs only when no snapshot exists (§2.13, Inv. #20).
12. **The INV posting transaction never internally commits** (general posting integrity): the posting service calls `postDocument(tx, …)` inside the per-account transaction so INV create + ledger legs + `customer_bill` stamp roll back together. Invoice numbers come from the non-transactional `document_inv_seq` — a rolled-back create may leave a rare gap, which is tolerated (Inv. #7).
13. **No `udr_mode`, `gl_date_basis`, or `fx_rate_set_id` column exists** — provenance/badge is the environment stub flag (§4.2), the GL date is the single `gl_event_at` date (§2.5), and v1 is single-currency. Do not reintroduce these columns without a spec change.
14. **JSONB is not used for financially significant data** (general §6.17): `customer_bill_tax_item` is a first-class table, not JSONB. Any future JSONB column follows the schema-guard rule; there is no documented well-formed-only JSONB exemption in this module.
15. **`bill_template_version` is immutable once `active`** — a change inserts a new row with a later `effective_from`; stamped on the bill at aggregation so a reprint renders through the template actually issued. No run-level template-override column.

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
  customer-bill.ts  customer-bill-line.ts        # phase 3 — the bill's charge record
  customer-bill-tax-item.ts  bill-run-invoices.ts  bill-run-distribution.ts
  bill-template-version.ts
db/repositories/billing/
  bill-run.ts  bill-run-account.ts  bill-run-account-stage.ts
  customer-bill.ts
  customer-bill-line.ts        # phase 3 — line reads + the charge_checksum (SQL-only)
  rated-lines.ts               # phase 3 — the udr_rated DRILL-DOWN read only; no checksum
  udr-status.repository.ts     # the app's ONLY rating.udr_rated UPDATE (six columns)
db/bootstrap/
  billrun-db-roles.sql         # billrun_runtime grants + rating.billrun_status_guard
  rating-db-roles.sql          # + rating.rating_status_guard (phase 3)
db/migrations/…                # billing tables + partition_management rows + billrun_* PERMISSIONS + Billing Viewer role + INV additions
workflow-management/flows/        # wfm-architecture.md §4 — function-first; spin-off subdirectory
  bill-run-processor/
    bill_run_processing.template.yml   # the contract doc (non-deployable)
    bill_run_processing.yml            # phase 3 — the REAL flow: correlate, claim,
                                       #   two-source aggregation into customer_bill_line,
                                       #   tax, verify, real stage + terminal signals
    README.md
  bill-run-distributor/
    bill_run_distribution.template.yml # the contract doc (non-deployable)
    bill_run_distribution.yml          # phase 3 — the REAL flow: blob download by blob_ref,
                                       #   SFTP upload, per-artifact outcome POST
    README.md
validation/billing/
  stage-signal.schema.ts  status-push.schema.ts
  trigger-run.schema.ts  rerun-run.schema.ts  approve-run.schema.ts
  check-status.schema.ts  cancel-run.schema.ts
  run-list.schema.ts      run-id.schema.ts
tests/…                        # mirrors source; route × level matrix for the three pages + the two M2M handlers
```

1. **The single rating write is isolated in `db/repositories/billing/udr-status.repository.ts`** — the only file in the module that issues an `UPDATE rating.udr_rated` (the app's four out-of-claim transitions; the claim itself is the flow's). No other repository writes the `rating` schema (Inv. #2), which makes the boundary greppable and testable. *(Phase-1 planning named this `rating-claim.ts`; renamed as-built — see §6 and the file tree above.)*
2. **`services/billing/**` is framework-agnostic** (no `next/*`), and the ingest handlers and Server Actions call the **same** service functions (§1.2) — never a duplicated code path.
3. **The workflow-engine HTTP client (`services/billing/engine-client.ts`) is wrapped by `services/billing/engine-registry.ts`** (bm16), which resolves a logical engine name ("billrun") to a connection + a stable identity string sourced from Key Vault/config, and is the ONLY caller of the client's real/stub implementations. `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` call the registry, never the client directly, and no page/component/Route Handler calls either.
4. **Do not fork the nav** — the Billing section is a `NAV_SECTIONS` entry, not a new nav component.
5. **Phase 3 replaces the placeholders with real flows.** The `.template.yml` files stay as the contract documentation `handle-stage-signal.ts` records against; the deployable `.yml` files now carry real logic and run as `billrun_runtime`. **Business logic in a flow means the flow revision is part of the audit trail** — `processing_flow_revision` and `distribution_flow_revision` are stamped on `bill_run`, and a flow edited in the Kestra UI is an untracked change to how money is computed (forbidden; every change is a repo commit).
6. **The checksum lives in `customer-bill-line.ts`, not `rated-lines.ts`.** `tests/guardrails/billing-rating-write-boundary.test.ts` flags any file in `db/repositories/billing/` that matches `/rating\.udr_rated|"rating"\."udr_rated"|FROM\s+rating\./i`, **or** that imports from `@/db/schema/rating` *and* calls `.insert(`/`.update(`/`.delete(`. A checksum over `customer_bill_line` touches no `rating` object and trips nothing; `rated-lines.ts` must stay read-only so it keeps passing.
7. **Historical note — flow YAML location.** Bill-run flow YAML lives under `workflow-management/flows/bill-run-processor/` and `.../bill-run-distributor/` (function-first, `wfm-architecture.md` §4 — was `flows/billrun/`). These are template skeletons only (key sections + commented `# STUB:`-marked activities, no business logic), documenting the stage contract `handle-stage-signal.ts` records against. They are deployed as flow *shells* on stand-up (`wfm01` §7b) but carry no business logic; the real flow ships built to this contract. `workflow-management/flows/rating-engine/` is the co-located function-1 surface (rating's real flows) — not a "separate repo". The whole `workflow-management/` subdirectory is structured to spin off later.

---

## 8. Permission Names & Per-Page Permission Map

**Permission names** (general §8): this module ships **three** permission names — `billrun_view`, `billrun_operate`, `billrun_approve` — a **deliberate deviation** from general §8.3's one-name-per-page model, required by **segregation of duties**: operate and approve must be grantable to different people (four-eyes), so they cannot be levels of one permission. Each is code-seeded via migration and referenced by a typed constant in `auth/` (`PERMISSIONS.BILLRUN_VIEW` / `_OPERATE` / `_APPROVE`). `billrun_operate` and `billrun_approve` each **imply** `billrun_view`. A **Billing Viewer** role (Finance, Internal Audit) carries `billrun_view` alone. All three, plus the M2M path, are in the authz-sweep inventory.

**The route table below IS the authz-sweep inventory** (bm21-spec §Implementation §3 confirmed this rather than standing up a separate list-of-routes artifact): OWASP ZAP's whole-host scan scope (`infra/zap/zap-context.xml`) and Semgrep's whole-repo-tree scan already cover every row here by construction — there is no per-route allow-list to maintain in either scanner's config. "Add the routes to the authz-sweep inventory" therefore means: land the row in this table (this is where the bm18/bm19 session-guarded PDF routes and bm20's third M2M handler were added, below) — not a separate CI config edit.

Authoritative; mirrors `billmgmt-architecture.md` §4. New pages/actions are appended before they ship (general §9).

| Surface | Route | Top-level component(s) | Folder | Permission : level |
|---|---|---|---|---|
| Bill Runs list (Current & Upcoming / Historical) + lazy materialize | `/billing/bill-runs` | `BillRunsPage` → `BillRunList`, `RunActionCard`, `RunStatusBadge` | `app/(app)/billing/bill-runs/` | `billrun_view` : **READ** |
| Run detail — Workflow / Customers & Bills / Uncharged / Errors / Distribution / Audit + posting-progress | `/billing/bill-runs/[runId]` | `BillRunDetailPage` → `StageTimeline`, `CustomerBillTable`, `UnchargedTable`, `ErrorsTable`, `DistributionTab`, `AuditTable`, `PostingProgressView` | `app/(app)/billing/bill-runs/[runId]/` | `billrun_view` : **READ** |
| Trigger / Rerun / Check status / Cancel a run | `/billing/bill-runs/[runId]` (dialogs + `StallBanner`) | `TriggerRunDialog`, `RerunDialog`, `StallBanner`, `CancelRunDialog` | `actions/billing/{trigger,rerun,check-status,cancel-run}.action.ts` | `billrun_operate` : **EDIT** |
| Approve & Post (four-eyes money gate) | `/billing/bill-runs/[runId]/approve` | `ApproveAndPostPage` → `ApproveAndPostPanel`, `PreApprovalChecks` | `app/(app)/billing/bill-runs/[runId]/approve/`, `actions/billing/{approve,post}-run.action.ts` | `billrun_approve` : **EDIT** |
| Start distribution / Rerun distribution (Distribution tab, bm20) | `/billing/bill-runs/[runId]` (Distribution tab) | `StartDistributionControl`, `RerunDistributionControl` | `actions/billing/{start,rerun}-distribution.action.ts` | `billrun_operate` : **EDIT** |
| Force-complete / abandon distribution (bm20 T11) | `/billing/bill-runs/[runId]` (Distribution tab) | `ForceCompleteDistributionDialog` | `actions/billing/force-complete-distribution.action.ts` | `billrun_approve` : **EDIT** |
| M2M — stage completion signal | `POST /api/billrun/[runId]/stage/[stage]/complete` | `route.ts` → `handleStageSignal` | `app/api/billrun/[runId]/stage/[stage]/complete/` | **Service token** (no RBAC) |
| M2M — run-level status push (processing or distribution execution) | `POST /api/billrun/[runId]/status` | `route.ts` → `handleStatusPush` | `app/api/billrun/[runId]/status/` | **Service token** (no RBAC) |
| M2M — distribution per-artifact outcome (bm20, the sanctioned third handler) | `POST /api/billrun/[runId]/distribution/outcome` | `route.ts` → `recordDistributionOutcome` | `app/api/billrun/[runId]/distribution/outcome/` | **Service token** (no RBAC) |
| Draft PRO-FORMA invoice preview (session-guarded PDF) | `GET /billing/bill-runs/[runId]/draft-invoice/[banId]` | `route.ts` → `renderDraftInvoice`, `InvoicePreviewModal` | `app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/` | `billrun_view` : **READ** |
| Stored final invoice download (session-guarded PDF) | `GET /billing/bill-runs/[runId]/stored-invoice/[banId]` | `route.ts` → `blobStore.getInvoice`, `StoredInvoiceModal` | `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/` | `billrun_view` : **READ** |
| Retry final invoice render/store for a render-pending account | `/billing/bill-runs/[runId]` (posting-progress view) | `RenderPendingRow` → `actions/billing/retry-render-invoice.action.ts` | `actions/billing/retry-render-invoice.action.ts` | `billrun_approve` : **EDIT** |

**Notes**

- Component names are the binding convention (general §9) — create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- `billrun_operate` and `billrun_approve` gate **mutations**; a `billrun_view`-only principal reaches every read surface and no action (verified by the route × level matrix against server actions and handlers, not just navigation).
- The three M2M handlers are **not** in the RBAC matrix — they authenticate a service token and are covered by their own auth tests (401 on bad token; 409 unless the run is in the state the handler expects; 200 replay).
- Deep links (`/billing/bill-runs/[runId]?tab=…`) pass through the `billrun_view` guard; the searchParam grants nothing.
- **Phase 3 adds no new route, page or permission.** All three permissions, all ten rows and the three M2M handlers are unchanged. Two *existing* rows change behind their guard, and both stay `billrun_view : READ`:
  - **Customers & Bills** renders `customer_bill_line` (via `BillLineTable` + `ChargeSourceBadge`) as the invoice's face, with the `udr_rated` drill-down behind a per-row disclosure fetched on expand. Nothing about the guard changes — but the tab now reads a `billing` table instead of `rating`, so `app_runtime` needs the new `SELECT` grant (§6.10) or the tab fails at runtime with a permission error the route matrix cannot catch.
  - **Uncharged** changes meaning, not permission: "no `customer_bill_line`", not "absent from `rating.udr_rated`" (§4.7, Inv. #22).
- The route × level matrix therefore needs **no new rows** this phase; what it needs is a re-run, plus the new DB-grant assertions in §9.
- **bm02 (delivered):** the `/billing/bill-runs` list page lazily materializes each active monthly cycle's single most-recent due run on its RSC render (a write, not an action/route/job — Inv. #10) before the read. Materialization writes exactly one `BILL_RUN_MATERIALIZED` `core.AUDIT_LOG` row **per row actually inserted**, as a **system write with `actorUserId = null`** (it is triggered by a page view but is not an operator mutation); a no-op load writes none. The Historical CSV export is a `billrun_view`-guarded **Server Action** (`actions/billing/export-runs.action.ts`), never a Route Handler, and — being read-only — is **not** audited. The `STUB_DATA_MODE` env flag drives `StubDataBanner`/`StubBadge` (Inv. #15); it is threaded server-side as a prop, never read in a client component. *(Historical. Renamed `BILLRUN_PLACEHOLDER_MODE`/`PlaceholderBanner` at bm15, then **retired entirely in phase 3** — D31, §4.2. Inv #15 is now a tombstone.)*
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

- **bm20 (delivered) — Distribution flow + `bill_run_distribution` + the
  Distribution tab (Phase 2 · Phase H).** See
  `context/billing-management/specs/bm20-distribution-flow.md`. The third
  M2M handler above; new partitioned `billing.bill_run_distribution`
  (composite PK, UNIQUE `(run, target, artifact_ref, distribution_attempt,
  period_partition)` — T1's stale-round-safe idempotency key); `bill_run`
  gains `distribution_attempt` (mirrors `bill_run_account.attempt_count`).
  `services/billing/distribute-run.ts` — `triggerDistribution` (auto-called
  once from `post-run.ts` at `INVOICED`, re-derivable via the T2 "Start
  distribution" operator action for a lost/failed trigger; gathers stored
  `bill_run_invoices` + a fresh per-run register CSV as artifacts, triggers
  the `billrun` engine's SECOND flow — `engine-client.ts`/`engine-registry.ts`
  generalized to take an explicit `flowId`, `bill_run_processing` vs.
  `bill_run_distribution` — and moves `INVOICED → DISTRIBUTING`),
  `rerunDistribution` (T1 — redelivers only the current round's FAILED
  artifacts under a bumped `distribution_attempt`), `recordDistributionOutcome`
  (the M2M handler's insert-first idempotent write, no run recompute),
  `recomputeDistributionStatus` (shared by the `.../status` route's
  `DISTRIBUTION_FINISHED` push AND `reconcile-run.ts`'s DISTRIBUTING branch —
  COMPLETED once every expected mandatory artifact is DELIVERED,
  DISTRIBUTION_FAILED if one is FAILED, else left unresolved with NO heartbeat
  bump, mirroring the PROCESSING-mismatch precedent), and T11's
  `forceCompleteDistribution` (`DISTRIBUTION_FAILED → COMPLETED`, abandons the
  currently-failed artifacts, audited `BILL_RUN_DISTRIBUTION_ABANDONED`).
  `post-run.ts`'s completion transaction now stops at `INVOICED` (not
  `COMPLETED` — `completePosting` renamed semantics), and calls
  `triggerDistribution` as a separate, failure-swallowed system write
  (`actorUserId: null`) after it commits. T2 also extends `stall.ts`'s
  `isStalled` and `reconcile-run.ts`'s "Check status" to a `DISTRIBUTING`
  execution (picking `distribution*` vs. `processing*` execution-ref columns
  by run status); `cancel-run.ts` is a **resolved decision to stay
  `PROCESSING`-only** (a `DISTRIBUTING` run has already posted every INV, so
  "reset accounts to PENDING" doesn't apply) — `StallBanner` gains a
  `canCancel` prop the detail page sets to `status === 'PROCESSING'`.
  `DistributionTab` (D-T3's four states: INVOICED-pending →
  `StartDistributionControl`; DISTRIBUTING → live delivery log; COMPLETED →
  all-green summary; DISTRIBUTION_FAILED → `RerunDistributionControl`
  primary + `ForceCompleteDistributionDialog` a quiet secondary behind a
  spelled-out danger confirm, D-T1's control hierarchy) joins the run-detail
  tabs. Three new audit events — `BILL_RUN_DISTRIBUTION_STARTED`/`_RERUN`/
  `_ABANDONED`, all `"Change"`. `BILLRUN_DISTRIBUTION_FORCE_FAIL` (env flag,
  D20) threads a forceable-failure switch into the loopback target for
  exercising the `DISTRIBUTION_FAILED` path against the deployed placeholder
  flow. No new permission.

---

## 9. Module Guardrail Tests (CI gate, general §10.4)

The general test-suite gate includes this module's guardrails; each ships with the unit that introduces the behavior. **bm21 (the phase-2 ship gate) assembles and verifies this full list against a live database** — it audits that each item below is present and CI-wired rather than rebuilding what already shipped (bm13 discipline), adding only the cross-cutting assertions and the one full-journey E2E that no single unit owns.

### Phase 1 (bm01–bm13)

1. **Authz matrix** — the three pages × role/level, incl. the `operate` ≠ `approve` split (an `operate`-only principal cannot approve/post; four-eyes: approver == final trigger actor → reject).
2. **M2M auth** — missing/invalid bearer → 401; valid stage signal advances `bill_run_account_stage` in one txn; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**; signal after `APPROVED` → 409; charge fields in body → rejected; **the stage signal writes NO per-signal `core.AUDIT_LOG` row** — the appended `bill_run_account_stage` row is the sole stage audit surface (§1.10). Land this assertion with the M2M-handler unit that introduces the signal path.
3. **Claim correctness** — a UDR already claimed by another run is never re-claimed; rerun releases then re-claims; release refused for rows on a posted invoice; the claim is the only `rating.*` write (asserted structurally against `db/repositories/billing/`).
4. **Finalization latch** — a `customer_bill` with `ref_inv_document_id` set cannot be deleted or invalidated; posting retry skips already-`INVOICED` accounts; a crash between INV-number consumption and the stamp commit does not double-post.
5. **No billing charge copy** — no table in `db/schema/billing/` stores charge amounts; `charge_checksum` detects a change to a posted invoice's `rating` lines.
6. **Partition/idempotency** — `period_partition` is fixed per run across a cross-month rerun; the stage UNIQUE includes `period_partition`; run status is recomputed under `FOR UPDATE`, and any cached counter equals the derived value.
7. **Status/materialize** — every legal `RunStatus`/`AccountStatus` transition accepted, illegal rejected; `STALLED` is never persisted; concurrent list loads create exactly one `bill_run` row; the next cycle is operable once the prior run reaches `INVOICED` (not `COMPLETED`).
8. **~~Placeholder isolation~~ → Non-production ledger isolation (phase-3 rescope, D31).** The badge half is **deleted** with `BILLRUN_PLACEHOLDER_MODE`; assert only what survives — a non-production bill-run environment is isolated from any ledger holding real Accounts data. The `_SAMPLE_` seed assertions move wholly to item 16.

### Phase 2 (bm14–bm20, assembled by bm21)

9. **[CRITICAL] Two-writer boundary (bm14)** — `tests/db/billrun-db-roles.integration.test.ts`. `billrun_runtime` writes only `customer_bill` (trial columns)/`customer_bill_tax_item`/the six `udr_rated` claim columns; refused per column/table on the posting-stamp columns, `bill_run*`, `billing.document`, pgledger, `bill_run_invoices`, `bill_run_distribution`, and the `kestra` DB — asserted over `pg_attribute`; the Step 0 deploy-ordering guard and re-run idempotency are proven too.
10. **[CRITICAL] `udr_rated` lifecycle (bm16/bm17)** — `RATED → BILL_DRAFT` (processor claim, incl. `REJECTED → BILL_DRAFT` re-claim) → `BILL_APPROVED` (approve)/`→ REJECTED` (reject)/`→ RATED` (cancel release); reprocess re-claims; reject refused once `BILL_APPROVED`/posted; the app's only `rating.*` write is `udr-status.repository.ts` (`tests/guardrails/billing-rating-write-boundary.test.ts`); no billing-side `INSERT`.
11. **M2M record-only (bm16/bm20)** — the handler records, computes no stage; replay 200; 409 after `APPROVED`; stale-attempt no-op; charge-field body rejected. Route-inventory (`tests/app/api/billrun-route-inventory.test.ts`) locks exactly **three** `POST` handlers (stage-complete, status, distribution/outcome).
12. **[CRITICAL] Rendered-invoice integrity (bm18/bm19)** — draft watermarked/no-number/never-stored; final per-account/post-posting/immutable/checksummed in `bill_run_invoices`; a render failure never rolls back a posted INV, never blocks `INVOICED` — but (bm21 T8) never lets distribution silently reach `COMPLETED` around the gap either; see item 14.
13. **Distribution (bm20)** — separate execution; mandatory-fail → `DISTRIBUTION_FAILED` → rerun without touching posted INVs; advisory non-blocking; next cycle operable at `INVOICED`.
14. **[CRITICAL] D10 safety net (bm19/bm20, closed by bm21 T8)** — a POSTED account with no stored `bill_run_invoices` row is a mandatory artifact that was never even deliverable; `recomputeDistributionStatus`'s `hasUnrenderedPostedAccounts` check (`services/billing/distribute-run.ts`) refuses to complete around it — `DISTRIBUTION_FAILED`, never a silent `COMPLETED` — and `rerunDistribution` picks up a late-rendered invoice as a never-attempted mandatory artifact so a retry-render + Rerun distribution still reaches `COMPLETED`. Proven end-to-end in `tests/db/billing-e2e-happy-path.integration.test.ts`.
15. **Two-execution + engine registry (bm16/bm20)** — processing terminates at `PROCESSED` without awaiting approval; distribution triggered at `INVOICED`; the app resolves `billrun` by name; each execution stamps its resolved engine identity.
16. **Seed provenance & prod guard (bm15, rescoped phase 3 by D31)** — **no badge assertion**; the flag is gone. What is asserted: every seeded `udr_rated` row is `_SAMPLE_*`-marked on `udr_source_file`/`udr_ref_batch_id`/`rating_engine_version` and starts **unclaimed** (`tests/guardrails/billing-sample-seed-marker.test.ts`); `db:seed-sample` is prod-guarded, idempotent, and absent from `db:setup` (`tests/guardrails/billing-sample-seed-boundary.test.ts`). Phase 3 extends the marker assertions to both seed profiles (`ci` and `volume`) and to `RAN_USAGE` rows.
17. **Phase-1 guardrails still green (bm21)** — the bm13 set (items 1–8 above) re-run unchanged; no regression from any phase-2 unit.
18. **Reject → reprocess (bm17, proven end-to-end by bm21)** — reject blocks approval (`no_rejected_pending`) until the rejected account is rerun; the marker lives on the rejected attempt's stage row and is implicitly cleared by the rerun's attempt bump, never an explicit clear write. Proven in `tests/db/billing-e2e-happy-path.integration.test.ts`.

### Phase 3 (real processing, charge lines, SFTP distribution)

19. **[CRITICAL] Correlation (D1)** — a seeded `udr_rated` row with `billrun_ban_id` NULL is claimed to the right account through `inventory.product_inventory`; two subscriptions of different offerings land on different lines; an unresolvable `udr_subscriber_ref_id` follows the stated policy and never vanishes silently (§1.14, Inv. #25). A guardrail also asserts **no code path writes `product_inventory.billing_account_id`**, so resolve-at-bill-run-time stays safe.
20. **[CRITICAL] Line grain + totals (D5)** — an account with 3 subscriptions of one offering and 500 of another produces exactly **2** charge lines, not 503; `SUM(customer_bill_line.net_amount) = customer_bill.subtotal` for every bill; `line_no` is reproduced identically from unchanged inputs (Inv. #21).
21. **[CRITICAL] Checksum re-anchor (D7/D20)** — a **recurring-only** bill produces a non-`md5('')` checksum (the regression that motivated the change); the checksum is computable from line content without reading surrogate ids; altering `gross_amount`, `discount_amount` **or** `net_amount` on a posted line changes it. Two different bills never share a checksum.
22. **[CRITICAL] Recurring exactly-once (D22)** — running Aggregation twice for one account leaves exactly one recurring line per subscription; the re-derivation path is the whole-account replace through `billrun_delete_trial_bill`; no `ON CONFLICT DO UPDATE` and no bare `DELETE` against `customer_bill_line` exists in the tree; `billrun_runtime` is refused a direct `DELETE` (asserted against `pg_attribute`/`information_schema`).
23. **[CRITICAL] No claim survives an abandoned attempt (D21)** — after a rerun following a partial processing failure, **no** `udr_rated` row remains at `BILL_DRAFT` from the prior attempt, and the re-run bill contains every charge the first attempt had claimed. This is the silent-under-bill regression; it fails closed if release is moved after the re-trigger.
24. **[CRITICAL] Rating may not supersede a claimed row (D3)** — a reload colliding with a `BILL_DRAFT` row is refused whole with `LOAD_BLOCKED_INFLIGHT` (MINOR), `udr_batch.status = REFUSED`, naming the blocking `bill_run_id`; a `BILL_APPROVED` collision still raises `LOAD_BLOCKED_BILLED` (MAJOR). With the application pre-check bypassed, a direct `rating_runtime` UPDATE out of `BILL_DRAFT`/`BILL_APPROVED` is refused by `rating.rating_status_guard` — the pre-check alone loses a TOCTOU race and must not be the only assertion.
25. **Price snapshot authority (D19)** — a rerun after a backdated `product_offering_price` insert reproduces the **original** amounts; the flow reads the snapshot and does not re-walk the `lead()` window.
26. **Grants, phase-3 additions (D22/D23)** — `app_runtime` has `SELECT` and **no DML** on `customer_bill_line`; `billrun_runtime` has `INSERT`/`SELECT` and **no** `DELETE`; `billrun_runtime`'s new cross-schema reads (`inventory.product_inventory`, `product.product_offering`, `product.product_offering_price`, `ordering.order_item_price_override`) are present and enumerated, with no `ON ALL TABLES` and no `ALTER DEFAULT PRIVILEGES`.
27. **Multi-target distribution (D25)** — `loopback` and `sftp` both launched in one run; completion requires **all** mandatory targets (`expected` = artifacts × mandatory targets) and latest-outcome dedup keys on `(target, artifact_ref)`; delivering every artifact to one target alone leaves the run short. An outcome naming an unlaunched target → 409; a stale-attempt outcome → 200 no-op.
28. **SFTP transport** — each invoice PDF lands at its own remote path and logs a `DELIVERED` outcome; one transient failure is retried once then delivered; an upload that fails twice still POSTs `FAILED` rather than terminating silently (the outcome POST is the deliverable, not the upload); host-key verification is on and the key comes from a Kestra Secret.
29. **Uncharged semantics (D14/Inv. #22)** — a recurring-only account with zero usage is **billed**, not Uncharged; an account with no charge lines **is**; an `EXCLUDED` account appears on neither (Inv. #26); a `BILL_NOTUSED` row appears on the per-record exception surface only.
30. **Partition registration** — `customer_bill_line` has a `partition_management` row and its monthly partitions are created by `pg_partman`; a row for a future month does not land in the default partition.
31. **`volume` profile** — Aggregation issues a bounded number of statements rather than one per record, and line count tracks product footprint rather than record count. Run deliberately, not on every commit — but on a schedule someone watches, or a per-record regression surfaces only in production.
32. **Exception policies (D32/D33)** — a `udr_rated` row with an unresolvable subscriber stays `RATED` and unclaimed, appears on the exception surface, and does **not** block approval; the next run claims it once inventory is fixed. A subscription whose recurring price is missing or `tiered` sends its account to `PROCESSING_FAILED` with the right code, produces no bill, and leaves every other account billable.
33. **Concurrency (P3, proposed)** — two-tab reject-vs-approve, and a double-trigger attempt while `DISTRIBUTING`.

**Not covered by any guardrail — recorded so it is not mistaken for tested:** posted `customer_bill_line` rows have no DB-level immutability trigger and the `charge_checksum` is not re-verified after posting, so post-posting line tampering has no active detection (§6.8, D27).
