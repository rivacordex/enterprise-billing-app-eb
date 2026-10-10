# Billing Management (Bill Run) — Module Code Standards

This document extends `context/code-standards.md` (the platform-wide standards every module inherits) and records **only** what the Billing Management module adds or does differently, including the two in-flight updates in `billmgmt-update-overview.md` (Part 1 Target Capacity Pricing; Part 2 Invoice Template). Everything else in the general file (general rules, TypeScript, Next.js, styling, API, data, file organization, CI gates) still applies and is **not** repeated here. If a rule seems missing, look in the general file. Where this doc conflicts with the architecture **Module Invariants** (`billmgmt-architecture.md` §6), the Invariants win and the conflict is a bug to fix here.

**Companion docs (authoritative):** `billmgmt-project-overview.md` (product spec, flows, success criteria — the Phase-4 update overview is folded in) · `billmgmt-update-overview.md` (the two in-flight updates) · `billmgmt-architecture.md` (technical design, **38** numbered **Module Invariants** §6; #15 retired) · `_updatemodule-billing-invoice-template-merged-plan.md` (Part 2 decisions D1–D8, v1 review R1–R11; §15 wins over §§1–14) · `_updatemodule-billing-billrun-phase3-plan.md` (phase-3 decisions D1–D30) · `_newmodule-billing-billrun-plan.md` (phase-1 functional design & data model).

**Where each update's rules live:** Part 1 → "Target Capacity Pricing update — code-standards deltas" · Part 2 → "Invoice Template update — code-standards deltas" (both at the end of this file). Part 2 replaces §6.15 below.

**Status:** Phase 3 planning, ENG CLEARED (2026-09-14). Component/route/permission names below are the **binding** convention for the build.

> **Phase-3 reversal — read before citing an older rule.** Phase 3 introduces `billing.customer_bill_line` and derives recurring charges in the bill run. Three rules below **reversed**, and any code or spec quoting their previous text is now wrong:
>
> | Rule                | Was                                                                       | Now                                                                                                                                         |
> | ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
> | §6.3                | "There is no billing-side charge table. **Do not create one.**"           | `customer_bill_line` **is** the bill's charge record (§6.3, Inv #3)                                                                         |
> | §1.1                | "No service, repository, or SQL in this module computes a charge amount." | No **usage-rating** logic in `billing`; recurring charge derivation is sanctioned and lives in the **flow** (§1.1, Inv #1/#17)              |
> | §2.4 / §9.5         | `charge_checksum` hashed `rating.udr_rated` rows                          | Hashes `customer_bill_line` content — all three money columns (§2.4, Inv #3)                                                                |
> | §4.2 / §9.8 / §9.16 | `BILLRUN_PLACEHOLDER_MODE` + `PlaceholderBanner` badged every run         | **Retired** — the copy is false once the real flows deploy (§4.2, D31). The `_SAMPLE_` marking and `db:seed-sample` prod guard are **kept** |

---

## 1. General Rules (module-specific)

1. **The bill run never rates _usage_ — and no charge compute lives in `services/`.** _(Phase-3 revision of "never computes a charge amount".)_ Two separate rules now:
   - **No usage-rating logic in `billing`.** Nothing in this module prices a usage record; `USAGE` amounts are read from `rating.udr_rated` and summed (Inv. #1).
   - **Recurring charge derivation is sanctioned, and it is the flow's.** Resolving a subscription's as-of price and writing a `RECURRING` `customer_bill_line` **is** billing compute — but it runs as `billrun_runtime` inside `bill_run_processing`, never in `services/billing/**` (Inv. #17). A charge-derivation function appearing under `services/billing/**` is a review-blocking defect, enforced by `tests/guardrails/billing-trial-bill-compute-boundary.test.ts`.
2. **Two mutation entry surfaces, kept separate.** Operator mutations flow `actions/billing/**` → `services/billing/*` → repositories, gated by `billrun_operate`/`billrun_approve`. Machine mutations flow `app/api/billrun/**` → the **same** `services/billing/*` functions, gated by the service token. A Server Action never carries a stage signal; a Route Handler never carries an operator action. Both reuse one service layer — never a forked copy.
3. **The app's only `rating` writes are the six claim columns, and the app never claims.** Exactly one repository file (`db/repositories/billing/udr-status.repository.ts`) `UPDATE`s `rating.udr_rated`, limited to `status`, `billrun_ref_id`, `billrun_ban_id`, `billrun_attempt`, `billrun_checksum`, `upsert_datetime` — no `INSERT`, no other column (Inv. #2). The **claim** (`RATED → BILL_DRAFT`) belongs to the flow as `billrun_runtime`; the app only ever moves a row _out_ of a claim. There are no cross-schema foreign keys in either direction — joins are plain-text keys.
4. **Four transitions move a row out of a claim, and three of them are releases.** Approve → `BILL_APPROVED`; **reject, cancel and rerun** → release to `RATED` with all four claim columns NULLed (Inv. #19). **The rerun release happens before the re-trigger, never after** — Collection claims `RATED` only, so a row left at `BILL_DRAFT` by an abandoned attempt is unclaimable by the next one and silently drops off the bill. A rerun path that re-triggers without releasing first is a review-blocking defect.
5. **`ref_inv_document_id` is the finalization latch — DB-guarded on the header, app-layer on the lines.** No service `UPDATE`s or `DELETE`s a `customer_bill` row whose `ref_inv_document_id` is set; that guard is `customer_bill_finalization_guard` (migration `0033`). Its `customer_bill_line` children have **no** finalization trigger of their own (a deliberate choice, D27): they are protected by rerun/reject only ever touching unfinalized bills — always through the `ref_inv_document_id IS NULL`-scoped `billrun_delete_trial_bill` — plus the `charge_checksum`. Because that checksum is computed once at posting and **not re-verified afterwards**, a code path that could reach a posted line is a review-blocking defect with no safety net behind it (Inv. #4, general Inv. #18).
6. **Posting is per-account, one transaction each, resumable.** The posting service iterates accounts and opens a fresh transaction per account; there is no "post the whole run in one transaction" function, ever. Every posting transaction first checks the account is not already `INVOICED` (skip) (Inv. #6).
7. **Four-eyes is a service-layer check, never UI-only.** The approve/post service rejects when the approver equals the final-attempt trigger actor (`approved_by === triggered_by` of the latest attempt) with a typed `FOUR_EYES_VIOLATION` result. The UI disabling the button is show/hide only (general §1.2).
8. **Run status is recomputed under a row lock, never incremented.** Every place run status changes issues `SELECT … FOR UPDATE` on the `bill_run` row and derives the new status from `bill_run_account`; no code does `failed_count = failed_count + 1` as the source of truth. Cached counters, if written, are asserted equal to the derived value by a test (Inv. #12).
9. **`STALLED` is never persisted.** No `UPDATE … SET status = 'STALLED'` exists. Staleness is computed on read from `status = 'PROCESSING'` and `last_progress_at` versus the cycle threshold (Inv. #10).
10. **No app scheduler, cron, or background worker.** Runs materialize on page load (§3.2); partition maintenance is `pg_cron`; orchestration is the external workflow engine. A `setInterval`, queue worker, or Container Apps Job in this module is out of bounds (Inv. #10).
11. **Operator mutations are audited atomically; stage signals are their own append-only record.** `materialize`, `trigger`, `rerun`, `approve`, per-account `post`, and `cancel` each write exactly one `core.AUDIT_LOG` row in the same transaction as the change (general §1.7). Per-account **stage** progress is the append-only `bill_run_account_stage` row itself (the drill-down/audit surface); the ingest handler writes that row, not a per-signal `AUDIT_LOG` entry. The rerun audit row is written **before** re-trigger and carries prior totals + reason.
12. **Re-derivation is a whole-account replace, never a per-line upsert.** Recurring lines carry no row-grain claim marker, so their exactly-once guarantee _is_ the replace: delete **all** of an account's `customer_bill_line` rows through `billing.billrun_delete_trial_bill(run, ban)`, then re-insert. No code path issues `INSERT … ON CONFLICT DO UPDATE` against `customer_bill_line`, and none issues a bare `DELETE` against it — `billrun_runtime` holds no table-level `DELETE`, so the scoped `SECURITY DEFINER` is the only deletion path (Inv. #16).
13. **On rerun the price snapshot is read, never re-resolved.** As-of resolution runs only when a line has no prior snapshot. Re-resolving would re-walk the `lead()` window and silently re-price a period a human already reviewed, because a `product_offering_price` row inserted later with an earlier start shifts that window. `ordering.order_item_price_override` is insert-only and is **not** the hazard (Inv. #20).
14. **An unresolvable subscriber is a surfaced, non-blocking exception (D32).** Leave the row at `RATED`, unclaimed and untouched; surface it alongside `BILL_NOTUSED` on the per-record exception surface; continue the run; show the count on the pre-approval checklist as informational. Never filter it out of the claim query, and never fail the account on it — the failure _is_ not knowing the account (Inv. #25).
    14b. **An unresolvable or `tiered` recurring price fails the account HARD (D33).** No as-of `recurring` price, or a `pricing_model = 'tiered'` row (`amount IS NULL` by `product_offering_price_amount_xor_tiers_check`, unratable by the flat resolver) ⇒ `PROCESSING_FAILED` with a `HARD` stage finding and `RECURRING_PRICE_NOT_FOUND` (or `RECURRING_CURRENCY_MISMATCH`) on `bill_run_account_stage.error_code`. Produce no bill for that account. Never substitute zero, never skip the subscription silently — recurring is period-keyed and a missed period is never caught up (Inv. #28). **pm46a (2026-10-10):** `RECURRING_PRICE_UNSUPPORTED` is retired. The recurring resolver reads only the recurring `flat_fee` lane (`price_component ->> 'priceType' = 'recurring'`) and partitions on the product lane key including `priceType`; a one-time fee is its own lane and never supersedes the recurring price.
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
4. **The charge checksum is anchored on `customer_bill_line`, hashes content, and is computed in SQL.** _(Phase-3 replacement — it previously hashed `rating.udr_rated`.)_ It hashes `(source, ref_product_offering_id, udr_type, line_type, gross_amount, discount_amount, net_amount)` over the account's lines, ordered by the same deterministic grouping key that assigns `line_no` — **never by `customer_bill_line_id`**, which is regenerated on every re-derivation and would make the checksum unreproducible from an archived invoice. All three money columns are hashed, not `net_amount` alone, so a discount that preserves the net stays tamper-evident. Do not re-derive it in TypeScript and do not reformat any amount before hashing (Inv. #3, D7a/D20).
   - **Why the old anchor had to go:** under phase 3 a recurring-only bill claims no `udr_rated` rows at all, so `md5(COALESCE(string_agg(…), ''))` returned `md5('')` — the same constant for every such invoice.
5. **`line_no` is assigned by ordering the grouping key, never by insertion order.** Identical inputs must reproduce identical line numbers across a rerun, so a credit note can reference a line and downstream AP matching on `(invoice, line_no)` survives a re-issue (Inv. #21).
6. **Dates: `gl_event_at`, `period_start`, `period_end`, `period_partition`, `scheduled_run_date`, `payment_due_date` are `date`** (calendar dates, not `timestamptz`); timeline columns (`*_at`) are `timestamptz`, UTC (general §2.13). `gl_event_at` is resolved once at trigger to `scheduled_run_date` and never recomputed (Inv. #13).
7. **Entity IDs are plain `string`s validated by Zod format schemas** (general §6.18): `BRN`+8 digits (`/^BRN\d{8}$/`) and likewise `BRA` (bill_run_account), `BRS` (bill_run_account_stage), `CBL` (customer_bill), `CBT` (customer_bill_tax_item), `BTV` (bill_template_version), and **`BLN` (customer_bill_line, phase 3)** — a distinct three-letter prefix, deliberately _not_ an extension of `CBL`, so no prefix scan confuses a line with its header. The `[runId]` route param is parsed against the `BRN` schema before any repository call.
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
3. **[REVERSED IN PHASE 3] `customer_bill_line` is the bill's charge record** (Inv. #3). The former rule — _"There is no billing-side charge table. Do not create one."_ — no longer holds; anything still quoting it is wrong. `customer_bill_line` stores one row per `(ref_product_offering_id, udr_type)` per bill with `source`, `line_type`, `gross_amount`, `discount_amount`, `net_amount`, the `udr_rated`-shaped discount columns, `udr_count` + the grouping key (for `USAGE`), and the resolved price snapshot (for `RECURRING`). `customer_bill.subtotal` **must equal** `SUM(customer_bill_line.net_amount)`. `rating.udr_rated` stays the per-record drill-down, reached by the line's grouping key.
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
15. **~~`bill_template_version` is immutable once `active`~~ — SUPERSEDED by the Invoice Template update (Part 2).** The old rule had an `effective_from` column, stamped the version at aggregation, and had reprint re-render the invoice. All three are now wrong. The replacement uses DRAFT → ACTIVE → RETIRED status, stamps the versions at **posting** in the same `UPDATE` as `stampPosted`, and has reprint download the stored PDF ("Invoice Template update — code-standards deltas" › Data and storage). The table is not in the codebase yet: there is no `db/schema/billing/bill-template-version.ts`, even though §6.1, §6.4 and architecture §3 list the table. Part 2's migration creates it. Unchanged: there is still no run-level template-override column.

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

1. **The single rating write is isolated in `db/repositories/billing/udr-status.repository.ts`** — the only file in the module that issues an `UPDATE rating.udr_rated`. No other repository writes the `rating` schema (Inv. #2), which makes the boundary greppable and testable.
2. **`services/billing/**` is framework-agnostic** (no `next/*`), and the ingest handlers and Server Actions call the **same** service functions (§1.2) — never a duplicated code path.
3. **The workflow-engine HTTP client (`services/billing/engine-client.ts`) is wrapped by `services/billing/engine-registry.ts`** (bm16), which resolves a logical engine name ("billrun") to a connection + a stable identity string sourced from Key Vault/config, and is the ONLY caller of the client's real/stub implementations. `trigger-run.ts`/`reconcile-run.ts`/`cancel-run.ts` call the registry, never the client directly, and no page/component/Route Handler calls either.
4. **Do not fork the nav** — the Billing section is a `NAV_SECTIONS` entry, not a new nav component.
5. **Phase 3 replaces the placeholders with real flows.** The `.template.yml` files stay as the contract documentation `handle-stage-signal.ts` records against; the deployable `.yml` files now carry real logic and run as `billrun_runtime`. **Business logic in a flow means the flow revision is part of the audit trail** — `processing_flow_revision` and `distribution_flow_revision` are stamped on `bill_run`, and a flow edited in the Kestra UI is an untracked change to how money is computed (forbidden; every change is a repo commit).
6. **The checksum lives in `customer-bill-line.ts`, not `rated-lines.ts`.** `tests/guardrails/billing-rating-write-boundary.test.ts` flags any file in `db/repositories/billing/` that matches `/rating\.udr_rated|"rating"\."udr_rated"|FROM\s+rating\./i`, **or** that imports from `@/db/schema/rating` _and_ calls `.insert(`/`.update(`/`.delete(`. A checksum over `customer_bill_line` touches no `rating` object and trips nothing; `rated-lines.ts` must stay read-only so it keeps passing.
7. **Historical note — flow YAML location.** Bill-run flow YAML lives under `workflow-management/flows/bill-run-processor/` and `.../bill-run-distributor/` (function-first, `wfm-architecture.md` §4 — was `flows/billrun/`). These are template skeletons only (key sections + commented `# STUB:`-marked activities, no business logic), documenting the stage contract `handle-stage-signal.ts` records against. They are deployed as flow _shells_ on stand-up (`wfm01` §7b) but carry no business logic; the real flow ships built to this contract. `workflow-management/flows/rating-engine/` is the co-located function-1 surface (rating's real flows) — not a "separate repo". The whole `workflow-management/` subdirectory is structured to spin off later.

---

## 8. Permission Names & Per-Page Permission Map

**Permission names** (general §8): this module ships **three** permission names — `billrun_view`, `billrun_operate`, `billrun_approve` — a **deliberate deviation** from general §8.3's one-name-per-page model, required by **segregation of duties**: operate and approve must be grantable to different people (four-eyes), so they cannot be levels of one permission. Each is code-seeded via migration and referenced by a typed constant in `auth/` (`PERMISSIONS.BILLRUN_VIEW` / `_OPERATE` / `_APPROVE`). `billrun_operate` and `billrun_approve` each **imply** `billrun_view`. A **Billing Viewer** role (Finance, Internal Audit) carries `billrun_view` alone. All three, plus the M2M path, are in the authz-sweep inventory.

**The route table below IS the authz-sweep inventory** (bm21-spec §Implementation §3 confirmed this rather than standing up a separate list-of-routes artifact): OWASP ZAP's whole-host scan scope (`infra/zap/zap-context.xml`) and Semgrep's whole-repo-tree scan already cover every row here by construction — there is no per-route allow-list to maintain in either scanner's config. "Add the routes to the authz-sweep inventory" therefore means: land the row in this table (this is where the bm18/bm19 session-guarded PDF routes and bm20's third M2M handler were added, below) — not a separate CI config edit.

Authoritative; mirrors `billmgmt-architecture.md` §4. New pages/actions are appended before they ship (general §9).

| Surface                                                                                                  | Route                                                   | Top-level component(s)                                                                                                                              | Folder                                                                                         | Permission : level           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------- |
| Bill Runs list (Current & Upcoming / Historical) + lazy materialize                                      | `/billing/bill-runs`                                    | `BillRunsPage` → `BillRunList`, `RunActionCard`, `RunStatusBadge`                                                                                   | `app/(app)/billing/bill-runs/`                                                                 | `billrun_view` : **READ**    |
| Run detail — Workflow / Customers & Bills / Uncharged / Errors / Distribution / Audit + posting-progress | `/billing/bill-runs/[runId]`                            | `BillRunDetailPage` → `StageTimeline`, `CustomerBillTable`, `UnchargedTable`, `ErrorsTable`, `DistributionTab`, `AuditTable`, `PostingProgressView` | `app/(app)/billing/bill-runs/[runId]/`                                                         | `billrun_view` : **READ**    |
| Trigger / Rerun / Check status / Cancel a run                                                            | `/billing/bill-runs/[runId]` (dialogs + `StallBanner`)  | `TriggerRunDialog`, `RerunDialog`, `StallBanner`, `CancelRunDialog`                                                                                 | `actions/billing/{trigger,rerun,check-status,cancel-run}.action.ts`                            | `billrun_operate` : **EDIT** |
| Approve & Post (four-eyes money gate)                                                                    | `/billing/bill-runs/[runId]/approve`                    | `ApproveAndPostPage` → `ApproveAndPostPanel`, `PreApprovalChecks`                                                                                   | `app/(app)/billing/bill-runs/[runId]/approve/`, `actions/billing/{approve,post}-run.action.ts` | `billrun_approve` : **EDIT** |
| Start distribution / Rerun distribution (Distribution tab, bm20)                                         | `/billing/bill-runs/[runId]` (Distribution tab)         | `StartDistributionControl`, `RerunDistributionControl`                                                                                              | `actions/billing/{start,rerun}-distribution.action.ts`                                         | `billrun_operate` : **EDIT** |
| Force-complete / abandon distribution (bm20 T11)                                                         | `/billing/bill-runs/[runId]` (Distribution tab)         | `ForceCompleteDistributionDialog`                                                                                                                   | `actions/billing/force-complete-distribution.action.ts`                                        | `billrun_approve` : **EDIT** |
| M2M — stage completion signal                                                                            | `POST /api/billrun/[runId]/stage/[stage]/complete`      | `route.ts` → `handleStageSignal`                                                                                                                    | `app/api/billrun/[runId]/stage/[stage]/complete/`                                              | **Service token** (no RBAC)  |
| M2M — run-level status push (processing or distribution execution)                                       | `POST /api/billrun/[runId]/status`                      | `route.ts` → `handleStatusPush`                                                                                                                     | `app/api/billrun/[runId]/status/`                                                              | **Service token** (no RBAC)  |
| M2M — distribution per-artifact outcome (bm20, the sanctioned third handler)                             | `POST /api/billrun/[runId]/distribution/outcome`        | `route.ts` → `recordDistributionOutcome`                                                                                                            | `app/api/billrun/[runId]/distribution/outcome/`                                                | **Service token** (no RBAC)  |
| Draft PRO-FORMA invoice preview (session-guarded PDF)                                                    | `GET /billing/bill-runs/[runId]/draft-invoice/[banId]`  | `route.ts` → `renderDraftInvoice`, `InvoicePreviewModal`                                                                                            | `app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/`                                   | `billrun_view` : **READ**    |
| Stored final invoice download (session-guarded PDF)                                                      | `GET /billing/bill-runs/[runId]/stored-invoice/[banId]` | `route.ts` → `blobStore.getInvoice`, `StoredInvoiceModal`                                                                                           | `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/`                                  | `billrun_view` : **READ**    |
| Retry final invoice render/store for a render-pending account                                            | `/billing/bill-runs/[runId]` (posting-progress view)    | `RenderPendingRow` → `actions/billing/retry-render-invoice.action.ts`                                                                               | `actions/billing/retry-render-invoice.action.ts`                                               | `billrun_approve` : **EDIT** |

**Notes**

- Component names are the binding convention (general §9) — create them exactly so the page ↔ route ↔ component ↔ permission chain stays traceable.
- `billrun_operate` and `billrun_approve` gate **mutations**; a `billrun_view`-only principal reaches every read surface and no action (verified by the route × level matrix against server actions and handlers, not just navigation).
- The three M2M handlers are **not** in the RBAC matrix — they authenticate a service token and are covered by their own auth tests (401 on bad token; 409 unless the run is in the state the handler expects; 200 replay).
- Deep links (`/billing/bill-runs/[runId]?tab=…`) pass through the `billrun_view` guard; the searchParam grants nothing.
- **Phase 3 adds no new route, page or permission.** All three permissions, all ten rows and the three M2M handlers are unchanged. Two _existing_ rows change behind their guard, and both stay `billrun_view : READ`:
  - **Customers & Bills** renders `customer_bill_line` (via `BillLineTable` + `ChargeSourceBadge`) as the invoice's face, with the `udr_rated` drill-down behind a per-row disclosure fetched on expand. Nothing about the guard changes — but the tab now reads a `billing` table instead of `rating`, so `app_runtime` needs the new `SELECT` grant (§6.10) or the tab fails at runtime with a permission error the route matrix cannot catch.
  - **Uncharged** changes meaning, not permission: "no `customer_bill_line`", not "absent from `rating.udr_rated`" (§4.7, Inv. #22).
- The route × level matrix therefore needs **no new rows** this phase; what it needs is a re-run, plus the new DB-grant assertions in §9.
- **bm02 (delivered):** the `/billing/bill-runs` list page lazily materializes each active monthly cycle's single most-recent due run on its RSC render (a write, not an action/route/job — Inv. #10) before the read. Materialization writes exactly one `BILL_RUN_MATERIALIZED` `core.AUDIT_LOG` row **per row actually inserted**, as a **system write with `actorUserId = null`** (it is triggered by a page view but is not an operator mutation); a no-op load writes none. The Historical CSV export is a `billrun_view`-guarded **Server Action** (`actions/billing/export-runs.action.ts`), never a Route Handler, and — being read-only — is **not** audited. The `STUB_DATA_MODE` env flag drives `StubDataBanner`/`StubBadge` (Inv. #15); it is threaded server-side as a prop, never read in a client component. _(Historical. Renamed `BILLRUN_PLACEHOLDER_MODE`/`PlaceholderBanner` at bm15, then **retired entirely in phase 3** — D31, §4.2. Inv #15 is now a tombstone.)_
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
  test) — the two CHECKs only _gained_ `'INV'`, no existing row changed.

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

- **bm36 — `BILLRUN_PROCESSING_FORCE_FAIL` (env flag, phase 4).** The processing
  analog of `BILLRUN_DISTRIBUTION_FORCE_FAIL`, with the **same posture**: a
  deploy-time/test toggle, **read only by `services/billing/trigger-run.ts`**
  (threaded onto the processing trigger payload's `force_fail`), **no UI control**
  (no target-catalog analogue — §6.13's no-`udr_mode`-style-column posture applies
  here too), default `false` so normal deployments never force a failure. When
  `true` the processing flow drives its **first scoped account** (`ban_ids[0]`) to
  a synthetic HARD failure at `aggregation`, exercising the terminal
  `PROCESSING_FAILED` signal path deterministically for the bm37 gate with no seed
  change. A grep guardrail asserts no UI/action reads it, mirroring the
  distribution flag. No new permission.

---

## 9. Module Guardrail Tests (CI gate, general §10.4)

The general test-suite gate includes this module's guardrails; each ships with the unit that introduces the behavior. **bm21 (the phase-2 ship gate) assembles and verifies this full list against a live database** — it audits that each item below is present and CI-wired rather than rebuilding what already shipped (bm13 discipline), adding only the cross-cutting assertions and the one full-journey E2E that no single unit owns.

### Phase 1 (bm01–bm13)

1. **Authz matrix** — the three pages × role/level, incl. the `operate` ≠ `approve` split (an `operate`-only principal cannot approve/post; four-eyes: approver == final trigger actor → reject).
2. **M2M auth** — missing/invalid bearer → 401; valid stage signal advances `bill_run_account_stage` in one txn; **replay `(run,ban,stage,attempt,period_partition)` → 200 no-op**; signal after `APPROVED` → 409; charge fields in body → rejected; **the stage signal writes NO per-signal `core.AUDIT_LOG` row** — the appended `bill_run_account_stage` row is the sole stage audit surface (§1.11). Land this assertion with the M2M-handler unit that introduces the signal path.
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

### Phase 4 (signal-back, self-driving lifecycle, prod wiring — assembled by bm39)

34. **[CRITICAL] Processor signal-back is real (bm36, audited by bm39)** — `bill-run-processor/local-dev/bill_run_processing.yml` carries real `io.kestra.plugin.core.http.Request` callbacks and **zero** `Log`-stub _signal_ tasks: the five per-stage stage-complete `DONE` POSTs (`validation`/`collection`/`aggregation`/`taxation`/`verification` → `/api/billrun/{runId}/stage/{stage}/complete`), the per-account HARD `FAILED` POST from the `account_pipeline` `errors` handler (to the fixed `verification` stage so it always lands on a valid `Stage` enum), and the run-level terminal `PROCESSING_FAILED` `/status` POSTs — `errors: on_error` on a `FAILED` execution and `afterExecution: on_killed` (`runIf execution.state == 'KILLED'`) on a KILL. Bearer `BILLRUN_APP_TOKEN`, retry `PT5S`×2, `allowFailure` on the per-stage DONEs (mirroring the distributor, bm34); the two remaining `Log` tasks (`start`, the `taxation` no-op stage) are not signals. Asserted by `tests/guardrails/billrun-processing-signal-back.test.ts` (static, DB-free) — the five DONE POSTs + the per-account HARD `FAILED` + the two terminal `/status` POSTs exist and exactly eight `http.Request` / two non-signal `Log` tasks remain (no signal `Log` stub); the sibling of the replace-boundary guardrail that reads the same flow.
35. **`BILLRUN_PROCESSING_FORCE_FAIL` single-reader posture (bm36)** — the processing analog of `BILLRUN_DISTRIBUTION_FORCE_FAIL` (item in §8): default `false` (`booleanEnvSchema("false")`), the exported accessor `billRunProcessingForceFail` read by **exactly one** live source, `services/billing/trigger-run.ts` (threaded onto the processing trigger payload's `force_fail`), **no** UI/action reader — asserted by `tests/guardrails/billrun-processing-force-fail-single-reader.test.ts` (static, DB-free), mirroring the distribution flag's guardrail.

**Phase-4 also audits (bm39 — these three are one-time assertions against artifacts/history, not standing CI tests, unlike items 34–35 above):** the M2M **receivers are unchanged** (`handle-stage-signal.ts`/`handle-status-push.ts`/`reconcile-run.ts` last touched at/before bm22/bm20/21, not by bm36–bm38); **no new schema/migration** was introduced in Phase 4 (`_journal.json`'s last entry is idx 39 = `0039_customer_bill_line`, bm23 — no `0040+`); and bm38's bicep secret wiring (`billrun-runtime-db-password` → `SECRET_BILLRUN_RUNTIME_PASSWORD` + `BILLRUN_DB_*` coords, gated by `hostsBillrunNamespace`) is reviewable with the deploy flags (`deployRatingFlows`, `runBillrunLiveKestraSmoke`, the engine deploy) gated off by default.

**Not covered by any guardrail — recorded so it is not mistaken for tested:** posted `customer_bill_line` rows have no DB-level immutability trigger and the `charge_checksum` is not re-verified after posting, so post-posting line tampering has no active detection (§6.8, D27).

---

## Target Capacity Pricing update — code-standards deltas (2026-10-04)

Per the header, this document is a delta to `../code-standards.md`; this section records **only** what the Target Capacity Pricing update adds or changes on top of §1–§9 above (`_updatemodule-billing-billrun-target-capacity-plan.md`, `billmgmt-update-overview.md`, `billmgmt-architecture.md` Inv #29–#38). Where a facet is unchanged it says so, so a future reader does not go looking. **Hard precondition:** `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscriber_ref_id → udr_subscription_ref_id` rename, the real resolver), treated as shipped by this phase's `bm*`-spec delivery.

### General rules (adds to §1)

- **Capacity pricing computes and writes in one `aggregation` transaction; Model 1 is the billed number.** `gross = Σ udr_rated_price + topUp` (anchored on the rated rows) is what the bill carries; the Model-2 recompute (`max(Q,target) × baseRate`) exists **only** in `verification` as a cross-check. No code path bills from Model 2 (Inv #29).
- **No DB function and no Python for pricing.** Capacity is inline SQL CTEs in `bill_run_processing.yml`, the delivered bm28/bm29 pattern. A `billing.capacity_charge()` DB function or a Python pricing task is a review-blocking defect — the module has no business-logic DB function by convention.
- **Round each monetary component once (2 dp, HALF_UP); derive `gross`/`net`, never re-round** (Inv #34). Money stays in SQL `numeric`/`string`; the zero checks go through `money.compare` (integer sen), never `Number(<amount>)` — the `tests/accounts/grep-gates.test.ts` grep gate must stay green. The 6dp `discount_amount_raw` must not route through `services/accounts/money.ts` (it throws above 2dp).
- **Detect a capacity offering by its components, never by a column**, and raise the six `CAPACITY_*` guards inside the account transaction (the D33 pattern) → `PROCESSING_FAILED`, siblings continue (Inv #32).
- **Resolve the base rate + components off the subscription's pinned offering version** (via `product_inventory → order_item`), never the current ACTIVE (Inv #31).
- **`CAPACITY_RATE_MATCHING` is loud by default.** Default ON → HARD-fail a mismatch with a diagnostic naming both rates and both version sources; OFF → log a WARN, bill Model 1, and record the flag state on the run. An OFF path that passes silently is a defect (Inv #30).

### TypeScript conventions (adds to §2)

- **Six new error codes** (`CAPACITY_MULTIPLE_SUBSCRIPTIONS`, `CAPACITY_BASE_RATE_NOT_FOUND`, `CAPACITY_UDR_TYPE_MISMATCH`, `CAPACITY_RATE_MISMATCH`, `CAPACITY_MULTI_STEP_UNSUPPORTED`, `CAPACITY_CURRENCY_MISMATCH`) join the billing error-code union as `as const`, defined once alongside the `RECURRING_*` codes — never a TS `enum`.
- **`rated_amount` is `numeric(18,2) → string`** on `customer_bill_line` (NULL for RECURRING; `= gross_amount` on non-capacity USAGE). Money stays `string` end-to-end (§2.3).
- **`additional_info` is a versioned, typed shape** `{ v, productInventoryId, pricing, calc[], summary[] }` (type from the schema, never hand-written); it is opaque to the checksum — never passed to the hash (§2.4, Inv #35). **Money is text in the trace (bm42a):** every amount, rate and decimal quantity inside `pricing`, `calc[]` and `appendix[]` is a JSON **string** at canonical scale (money `numeric(18,2)`, quantities `numeric(20,6)`, rates `numeric(18,6)`, via `::numeric(p,s)::text`), matching TS rule 3; only `v`, `udrCount` and `band` are JSON numbers, and the catalog `steps` copy stays verbatim. Readers in SQL use `->>` plus a numeric cast, so they work on either form. A window function never goes inside an aggregate's arguments (Postgres rejects it); `tests/guardrails/billrun-flow-sql-window-in-aggregate.test.ts` fails the fast unit run if one appears.
- **A capacity line's `grouping_key` is `<offering>:CAPACITY:<unit>`** — distinct from the `(offering, udr_type)` USAGE key; `line_no` is still assigned by ordering the grouping key (§2.5).
- **No new domain union** — `discount_type 'fixed'` and `line_type 'charge'` are existing members (§2.1); capacity reuses them.

### Next.js rules (adds to §3)

- **No new page, route, or client component this phase.** The capacity breakdown (`additional_info`) is database-only and never rendered in the app UI; the only rendered surface is the invoice PDF appendix, produced server-side in the render template — not a Next route or component.
- **The motivation discount is the first non-zero `discount_amount` on a USAGE line.** §4.1c suppresses the discount column while every line is `0.00`; confirm the existing `BillLineTable`/read model surfaces it once a capacity line carries a discount. Read-model/RSC change only — no new interaction leaf.

### Styling (adds to §4)

- **The invoice usage appendix is a render-template concern, not an app component.** Per-polygon rows, **sectioned by state then district**, right-aligned money columns (polygon, usage volume, rated amount), with per-district / per-state / line totals. **Per-polygon only (no district summarisation), bounded ≤ 10,000 rows/account**; a polygon with no matching ratecard row is shown, not dropped.
- **`discount_amount` now renders for a capacity line** (the existing §4.1c rule — it appears because the value is non-zero). No new badge; a capacity line carries the existing `ChargeSourceBadge` (`USAGE`).

### API Routes (unchanged — §5)

- **No new Route Handler and no change to the three M2M handlers.** Capacity is computed in the flow; the signal stays record-only and carries no charge payload (§5.5). The §8 route table / authz-sweep inventory needs no new row.

### Data and storage rules (adds to §6)

- **Two new columns on `customer_bill_line`:** `rated_amount numeric(18,2)` and `additional_info jsonb` (capacity lines only), in **one hand-authored migration** (next free number — `0041`/`0043` are taken); the partitioned-parent `ALTER` propagates to partitions; Drizzle mirror in `db/schema/billing/customer-bill-line.ts`. No new `source`/`line_type` CHECK — capacity lines are `USAGE`/`charge`.
- **The `charge_checksum` tuple appends `rated_amount` as the last element** — never inserted mid-tuple — so existing lines' serialization is unchanged; `additional_info` is never hashed (Inv #35, extends §2.4/§6.3).
- **New per-table `SELECT` grants for `billrun_runtime`:** `product.product_specifications` (the `udrType` characteristic), `product.ratecard_ran_usage_lkp`, `product.ratecard_version` — in `db/bootstrap/billrun-db-roles.sql`, enumerated, never `ON ALL TABLES` (§6.9/§6.10, Inv #23). The grant change updates the architecture Invariants in the same change set.
- **`product_offering_price` is read as components** (PC14: one row per `component_type` + `price_component jsonb`; `amount`/`pricing_model`/`price_type` removed); the shared as-of reader is partitioned by `(product_offering_id, component_type, unit_of_measure)`.
- **The per-polygon appendix is snapshotted at `aggregation`** (so the render does no cross-schema join); its state/district come from the `productCardLookUp` ratecard, **never from `udr_rated`**.

### File organization (adds to §7)

- **Capacity logic lives in the flow, not `services/`.** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml` (`aggregation` + `verification` steps). No new `services/billing/**` compute file (Inv #17); no DB function; no Python.
- **`db/repositories/billing/customer-bill-line.ts`** owns the checksum-tuple change and the two new columns in the read model; `rated-lines.ts` is unchanged (still the `udr_rated` drill-down read).
- **Tests:** the extracted-SQL harness **replaces** `tests/db/helpers/billrun-aggregate.ts` (and the verify double); add a live-Kestra capacity-path test and a fail-closed destructive-DB preflight in the DB-suite `globalSetup` (plus removal of the cross-cluster `DROP DATABASE … WITH (FORCE)`).
- **Seeds:** `_SAMPLE_` capacity fixtures in `db/seeds/sample` — one per §9 scenario below, including a multi-polygon / multi-state-district account.

### Permission map (adds to §8 — no new rows)

**No new page, component, route, or permission.** Capacity data surfaces within existing surfaces, each keeping its current permission; the route × level matrix needs a re-run, not new rows:

| Surface                                    | Route                                                   | Capacity delta                                                            | Permission : level                    |
| ------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------- |
| Customers & Bills (run detail)             | `/billing/bill-runs/[runId]`                            | renders the capacity `customer_bill_line` + its (first non-zero) discount | `billrun_view` : **READ** (unchanged) |
| Stored final invoice (session-guarded PDF) | `GET /billing/bill-runs/[runId]/stored-invoice/[banId]` | the PDF now carries the per-polygon usage appendix                        | `billrun_view` : **READ** (unchanged) |

The `billrun_runtime`/`app_runtime` grant additions (above) must land or Customers & Bills / the appendix fail at runtime with a permission error the route matrix cannot catch (same hazard as §8's phase-3 note).

### Guardrail tests (extends §9, items 36–42)

36. **Capacity math on the `_SAMPLE_` `ci` seed** — the four anchors (800 → 100,000; 1000 → 100,000; 2000 → 150,000; 0 → 100,000); `subtotal = SUM(net_amount)`.
37. **Each of the six `CAPACITY_*` guards fails only its account** (siblings bill); a NULL/`ZERO_RATED` rate trips `CAPACITY_RATE_MISMATCH` (proves `IS DISTINCT FROM`, not `<>`).
38. **Model-2 reconciles on a consistent run;** `CAPACITY_RATE_MATCHING=OFF` logs a WARN, bills Model 1, and records the flag state (never silent).
39. **Verification catches a tampered** `rated_amount`/`gross`/`discount`/`calc.total` via **both** detectors; every capacity line holds `discount_amount ≥ 0` and `net_amount ≥ 0`.
40. **Altering `rated_amount` on a posted line changes the recomputed `charge_checksum`** (the append-tuple).
41. **The invoice usage appendix** renders per-polygon by state/district from the `productCardLookUp` ratecard, load-tested to 10,000 rows/account; a card-missing polygon surfaces (not dropped).
42. **DB suites run the SQL extracted from `bill_run_processing.yml`** (no hand-copied double); a **live-Kestra** capacity run drives `SCHEDULED → COMPLETED`; the destructive-DB preflight **refuses a non-disposable target**.

---

## Invoice Template update — code-standards deltas (2026-10-07)

This section records **only** what the Invoice Template update (Part 2 of `billmgmt-update-overview.md`; `_updatemodule-billing-invoice-template-merged-plan.md`, with §15 R1–R11 taking precedence) adds to or changes in `context/code-standards.md` and §1–§9 above. Where something is unchanged, this section says so. `billmgmt-architecture.md` now carries the Part 2 invariants **#39–#50**, and they take precedence over this section. Map of the plan IDs still cited below: R1/R10 → Inv #39; R8 and park-on-failure → #40; stamping at posting → #41; R10/R11 resolution and default → #42; D8 reprint/C1 → #43; append-only versions → #44; checksum on load → #45; D3/D4 and locked Handlebars → #46; no fetch/ratecard at render → #47; logo validation → #48; server-side structure/activation checks and audit → #49; R2/R6 "current charges only", bill-level tax → #50. Replacing each inline D#/R# with its Inv # is still OPEN (bm47 follow-up 6, workflow rules §7.4). Names marked **binding** must be created exactly as written. A build spec that needs a different name updates this file first.

### Decide before writing Part 2 build specs

These items conflict with the delivered code or with Part 1. The rules below assume the stated resolution. If a decision goes the other way, update this section first.

**Resolved — C1 (usage section source) = R9, delivered by bm48 (2026-10-08).** Rating persists the matched ratecard cell's `state`/`district` onto `rating.udr_rated` at INSERT (migration `0045`), and Inv #36 is amended in `billmgmt-architecture.md`. Still **one** usage-section binder, never two: bm47's binder reads the bm45 `additional_info.appendix` snapshot until bm49 switches it to the `udr_rated` columns. Same issue as architecture X1 and the overview's _Overlap with Part 1_, all closed together.

| # | Conflict | Rule until decided |
|---|---|---|
| C2 | **`ONE_TIME` charge source.** The overview lists RECURRING, USAGE and ONE_TIME lines. The `customer_bill_line_source_check` CHECK (migration `0039`) and `ChargeSource` (§2.1) only allow `USAGE`, `RECURRING` and `OCC`. | The binder groups by the existing `ChargeSource` union. Do not add `ONE_TIME` to a CHECK, union, label or fixture without a spec that also defines how one-time charges are sourced (see `_futurebuild_occ-charge-sourcing.md`). |
| C3 | **Default version vs "one ACTIVE per kind".** R11 says the `is_default` version is "always ACTIVE". §6 says activating a new version retires the previous one, and only one version per kind is ACTIVE. | **Decided 2026-10-07, delivered bm50.** The one-ACTIVE partial unique index excludes the default (`btv_one_active_uq … WHERE status = 'ACTIVE' AND NOT is_default`). Resolution order is pinned → the current non-default ACTIVE → the `is_default` row. (= architecture X3.) |
| C4 | **Checksum algorithm (O2).** | New template and asset blobs use **SHA-256** (hex, stored in `checksum`). Invoice PDFs in `invoices/` keep md5 as built. Do not migrate existing PDFs. |
| C5 | **Prod app blob auth (G16, OPEN — bm52).** Key Vault connection string vs the app's user-assigned Managed Identity with container-scoped `Storage Blob Data Contributor`. | Interim: the connection string (`appBlobAuth = 'connectionString'`, the bicep default). Application code supports both paths already (`blob-store.ts`) and must not assume either: never rely on `createIfNotExists` for the three app containers (bm52 declares them in bicep), never set both `BILLRUN_BLOB_CONNECTION_STRING` and `BILLRUN_BLOB_ACCOUNT_URL`. Flipping G16 is an `infra/**` parameter change, not a code change. |

### General rules (adds to §1)

1. **Binder first (R10).** The first Part 2 unit re-points the final and draft renderers from `ratedLinesRepository.listClaimedForAccount` (`render-invoice.ts`) to `customer_bill_line`, `customer_bill_tax_item`, `billing.document` and `customer.organization`/`contact_medium`. That unit must assert `Σ net_amount = customer_bill.subtotal` before it renders. No editor page, action or component merges before this unit is green.
2. **Never fall back to the legacy template (R8).** `buildDraftInvoiceHtml`/`buildFinalInvoiceHtml` and their `rating.udr_rated` read are **deleted** when the binder lands, not left behind a flag. Template resolution is pinned → ACTIVE → default (C3), so "no template" cannot happen. Any other failure (checksum mismatch, compile error, failed reconciliation, missing required field) throws a typed `AppError`.
3. **"Park" reuses the existing render-pending surface.** A failed final render leaves the account posted with no `bill_run_invoices` row and writes the failure's error code. It then shows through the existing `RenderPendingRow` + `actions/billing/retry-render-invoice.action.ts`, and the D10 safety net (§9 item 14) blocks distribution `COMPLETED`. Do **not** add an `AccountStatus` member, a new table or a new tab for parking. A render failure still never rolls back a posted INV (§9 item 12).
4. **Final renders read stamped versions, never the current ACTIVE.** `resolveTemplate(db, mode)` (bm53, `services/billing/invoice-template/resolve-template.ts`) for a final render (and for the editor preview of a posted bill, R10) reads `ref_bill_template_version_id`, `ref_invoice_profile_version` and `ref_csv_template_version_id` from the bill. Only a draft/pro-forma render resolves the current ACTIVE versions (non-default ACTIVE ?? default; profile ACTIVE ?? `null`), and it persists nothing. **A posted bill with `NULL` stamps (every bill posted before bm54) resolves the immutable default** (BTV00000002 + CSV BTV00000003) and a `null` profile, never the current ACTIVE. That is deterministic and identical to what was ACTIVE then, because nothing is activatable before bm58. A stamped id that is missing, a DRAFT or the wrong kind, or a missing default row, throws `TEMPLATE_VERSION_NOT_FOUND` and the account parks (no fallback). Resolution is never cached.
5. **Reprint is a byte download (D8).** Reprint serves the stored PDF from `bill_run_invoices`. No code path re-renders a posted invoice to answer a reprint. Reproducibility is checked by recomputing `charge_checksum` from the lines, never by hashing rendered HTML (§15 correction to §11 C1).
6. **Admins choose structure only; developers own markup (D3/D4).** No action, schema or column accepts admin-supplied markup, CSS, labels, wording, section order, page setup or image slots. The only admin template input is the boolean `structure` map (TS rules below).
7. **Handlebars runs locked down.** Compile with `{ knownHelpersOnly: true, strict: true }` and auto-escaping on. `{{{ }}}` (triple-stash) and `SafeString` are forbidden in layouts and helpers. Register only the nine helpers `money`, `date`, `period`, `qty`, `price`, `int`, `amt`, `unitCode`, `asset`. No helper evaluates, imports or fetches anything.
8. **Every byte read from the blob store is checksum-verified before use.** This covers layout files, generated `.hbs` files and logo bytes. A mismatch throws, and the render fails (rule 3), with no retry using unverified bytes.
9. **Saves and activations are audited atomically** (general §1.7). They write five new `AUDIT_EVENT_TYPES` in the same transaction as the change: `INVOICE_PROFILE_DRAFT_SAVED` (Change), `INVOICE_PROFILE_ACTIVATED` (Change), `INVOICE_LOGO_UPLOADED` (Additive), `INVOICE_TEMPLATE_DRAFT_SAVED` (Change) and `INVOICE_TEMPLATE_ACTIVATED` (Change). An activation row's `beforeData`/`afterData` names the retired and the activated version IDs plus the `change_note`. Retirement is part of the activation, so it has no separate event. Previews and downloads are reads and are not audited.
10. **Activation is all-or-nothing.** The steps run in this order: validate → generate `invoice.hbs` + `footer.hbs` → test-render against the layout's `sample-data.json` → write the blobs (write-once) → one DB transaction (insert ACTIVE, retire previous, audit). Any failure leaves the previous ACTIVE version in place. A blob orphaned by a failed DB transaction is tolerated (write-once paths are never reused because `version_no` comes from the DB). It is never deleted inline.
11. **No new money compute.** The binder groups and labels stored line amounts. Totals come from SQL (`customer_bill.subtotal`, `tax_total`, `total_amount`) or are summed in SQL in the binder's repository read. No `reduce(+)`, `Number()` or `parseFloat` on amounts (§2.3). The CSV's "line amounts sum exactly to the bill" property is asserted, never forced by adjusting a value.

### TypeScript conventions (adds to §2)

1. **New `as const` unions, each defined once in `types/billing.ts`:**
   - `BillFormatCode`: `'INVOICE'` (D1; no credit/debit/pro-forma).
   - `TemplateKind`: `'layout' | 'generated' | 'csv'`. **No `'xml'`** (R3).
   - `TemplateVersionStatus`: `'DRAFT' | 'ACTIVE' | 'RETIRED'`. The same three values as `core.system_config.status`. Reuse the existing `types/system-config.ts` union if it exports one, and never declare a second copy.
   - `BillAssetKind`: `'logo'`.
   - `InvoiceSectionKey`: `'billTo' | 'identification' | 'amountDue' | 'chargeSummary' | 'taxSummary' | 'payment' | 'chargeDetails' | 'usageAnnex' | 'notes'`. These are the `INVTPL-STD-A4` manifest keys **minus `accountSummary`** (dropped, R2). `header`, `pageTwoHeader` and `footer` are fixed layout parts, not section keys.
   - `InvoiceOptionalSectionKey`: `'payment' | 'usageAnnex' | 'notes'`. Every other key is mandatory and locked on.
   - `InvoiceColumnKey`: `'showServicePeriod' | 'showDiscountColumn' | 'showProductId' | 'showUdrCount'` (manifest `columns` keys). The fixed columns are `#, Description, Quantity, Unit price, Gross, Net amount`, with **no `Tax` column** (R6). The seeded manifest must drop the `"Tax"` entry and the `accountSummary` section that the sample still carries.
2. **The layout manifest is the runtime source of keys, and a test pins the unions to it.** A unit test loads the seeded `INVTPL-STD-A4` `manifest.json` and asserts its optional section keys and column keys equal the unions above. When a manifest and the code disagree, the test fails. It never fails silently at render.
3. **`structure` is Zod-first** (`validation/billing/invoice-template-structure.schema.ts`): `{ sections: Record<InvoiceSectionKey, boolean>, columns: Record<InvoiceColumnKey, boolean> }`, `.strict()` (unknown keys rejected), with a refinement that every mandatory section is `true`. The jsonb column is typed `.$type<z.infer<…>>()` (general §6.17).
4. **The bind input is one typed shape, `InvoiceRenderInput`** (`types/billing.ts`): `{ company, payment, invoice, customer, totals, lineGroups, usage, isDraft, locale, timezone }`. Its keys mirror the placeholder roots in `invoice-template/placeholder-catalog.md`. Money fields are `string` (§2.3). Calendar dates are `string` (`YYYY-MM-DD`) rendered by `formatCalendarDate`. `locale` and `timezone` are resolved server-side and passed in. Helpers never read config (general §2.13).
5. **The company profile is a Zod schema, not loose `system_config` rows** (`validation/billing/invoice-profile.schema.ts`). The repository reads the `invoice.profile` group's rows for one `config_version` and parses them into `InvoiceProfile`. A parse failure is a typed error, never a partial profile. The field formats are fixed and copied from `invoice-template/placeholder-catalog.md` §B: TIN `^[A-Z]{1,2}\d{10,11}$`, SST no. `^[A-Z]\d{2}-\d{4}-\d{8}$` (optional, hidden when blank), postcode `^\d{5}$`, SWIFT `^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$`, JomPAY biller code digits only, email, colours `^#[0-9A-Fa-f]{6}$`, state code `^(0[1-9]|1[0-6])$`. If the catalog and this line ever disagree, the catalog wins and this line gets corrected. **Draft vs activation schemas (bm59):** the one module exports `invoiceProfileFieldsSchema` (the form's fields: every key below except `logo_asset_version_id`), `invoiceProfileDraftSchema = invoiceProfileFieldsSchema.partial()` (**save**: every provided value must match its format, blanks allowed so incomplete work can be saved) and `invoiceProfileSchema` (fields + logo; the render-time read and **activation**, bm61, which require the required fields). All three are `.strict()`, so the form can never post `logo_asset_version_id` (bm60) or a `meta.*` key (bm61). The form resolver and the save action share one normaliser, `normalizeInvoiceProfileDraftInput`, applied before the draft parse: trim; blank → absent (stored `NULL`, every key always present); upper-case TIN, SST no., SWIFT and colours; strip spaces from the account no.; an all-digit `payment_terms_days` → int. The render-time read keeps `toInvoiceProfileInput` (no upper-casing, so a hand-edited lower-case value still fails). **No notes/footer fields (G7, decided 2026-10-07):** notes & terms and the footer sentence are fixed layout text. **Key names (bm53, `.strict()` over this set; `config_value` text is mapped first: blank/`null` → absent, `payment_terms_days` → int):**

   | `config_key` | `InvoiceProfile` → placeholder | Rule |
   | --- | --- | --- |
   | `company_name` | `company.name` | 1–150 |
   | `registration_no` | `company.registrationNo` | 1–40 |
   | `tin` | `company.tin` | TIN |
   | `sst_reg_no` | `company.sstRegNo` | optional; SST |
   | `address_line1` / `address_line2` | `company.addressLine1` / `addressLine2` | 1–120 / optional ≤ 120 |
   | `postcode` | `company.postcode` | postcode |
   | `city` | `company.city` | 1–80 |
   | `state_code` | `company.stateCode` + `company.state` (label, `lib/myinvois-states.ts`) | state code |
   | `country_code` | `company.countryCode` + `company.country` | `^[A-Z]{2}$`, default `MY` |
   | `phone` / `email` / `website` | `company.phone` / `email` / `website` | 1–30 / email / optional `https://` URL |
   | `brand_color` / `accent_color` | `company.brandColor` / `accentColor` | colour |
   | `bank_name` / `bank_account_name` / `bank_account_no` | `payment.bankName` / `accountName` / `accountNo` | 1–80 / 1–120 / `^[0-9-]{6,30}$` |
   | `swift` | `payment.swift` | SWIFT |
   | `jompay_biller_code` | `payment.jomPayBillerCode` | optional; digits |
   | `remittance_email` | `payment.remittanceEmail` | email |
   | `payment_terms_days` | `invoice.paymentTermsDays` | integer 0–120 |
   | `logo_asset_version_id` | `company.logoUrl` (verified `data:` URI) | optional here (`INVASV\d{8}`); required for ACTIVE at activation (bm61) |
6. **New ID formats** (general §6.18; `^PREFIX\d+$` validators): `BTV` (bill_template_version, already reserved in §2.7), **`INVAST`** (bill_asset, the prefix the sample blob paths use) and **`INVASV`** (bill_asset_version). `bill_format` uses its code as its key: `bill_format_id = 'INVOICE'`, no sequence, because `customer_bill.ref_bill_format_id` is stamped with the literal `INVOICE`. `ref_invoice_profile_version` is an `integer`, the `system_config.config_version`.
7. **New typed error codes** (`as const`, next to the existing billing codes): `TEMPLATE_CHECKSUM_MISMATCH` (bm53 — a stored template file or its `checksums.json` index does not match the recorded SHA-256; `detail: { versionId, file }`), `ASSET_CHECKSUM_MISMATCH` (bm53 — logo bytes; `detail: { assetVersionId }`), `TEMPLATE_VERSION_NOT_FOUND` (bm53 — a stamped id missing/DRAFT/wrong kind, or a missing default row), `INVOICE_PROFILE_INVALID` (bm53 — a profile version fails `invoiceProfileSchema`, or names an unknown logo; `detail: { configVersion, issues }`), `TEMPLATE_COMPILE_FAILED` (also raised by bm53's load-time probe execution), `INVOICE_RECONCILIATION_FAILED` (`Σ net_amount ≠ subtotal`, and — bm49 — the usage annex total ≠ `Σ rated_amount` on the USAGE lines, carrying `detail: 'usage'`), `INVOICE_DOCUMENT_MISMATCH`, `INVOICE_USAGE_OVER_LIMIT` (bm49 — the usage annex exceeds `INVOICE_USAGE_ROW_LIMIT = 10_000`; the account parks), `PROFILE_LOGO_REQUIRED`, `PROFILE_FOUR_EYES_VIOLATION` (bm61, G14 option C — a profile activation that changes payment fields by the user who last saved the draft or uploaded its logo; an action **result code**, never thrown), `CHANGE_NOTE_REQUIRED` (bm58 — the activation change note is empty after trimming; an action **result code**, never thrown), `ACTIVATION_BLOB_CONFLICT` (bm58 — a different blob already sits at the content-addressed target path, so nothing is activated; a result code, never thrown; both are in `TEMPLATE_ACTIVATION_ERROR_CODES`), `DRAFT_CONFLICT` (bm57 — the shared working draft changed since the form loaded it; a save-draft **result code** in `TEMPLATE_DRAFT_ERROR_CODES`, returned by the action and never thrown), `MANDATORY_SECTION_HIDDEN` (bm55 — the structure schema's issue message for a hidden mandatory section, and the code `generate` throws when it re-asserts that rule; detail `{ section }`), `TEMPLATE_GENERATION_FAILED` (bm55 — the generator met an unknown directive or key, a `[[body]]` count ≠ 1, an unbalanced or nested `[[if]]`, or a `[[`/`]]` left in its output; detail `{ directive, file }`), `DEFAULT_VERSION_IMMUTABLE`, `VERSION_IMMUTABLE` and `VERSION_DELETE_FORBIDDEN` (bm50 — the version-rules trigger raises these three with SQLSTATE `23001` and a message beginning with the code, which the app maps to a typed `AppError`), `LOGO_REJECTED` (bm60 — an upload **result code** in `LOGO_UPLOAD_ERROR_CODES`, never thrown, with `reason: LogoRejectReason` = `'size' | 'mime' | 'dimensions' | 'svg_content'` and a `detail` (`byteSize`; `declared`/`detected`; `width`/`height` or a message; `construct`)). The blob store (bm51) adds `BLOB_ALREADY_EXISTS` (write-once `onExists: 'throw'`, detail `{ blobRef }`) and `INVALID_BLOB_PATH` (bad path or unknown container) as a separate `BLOB_STORE_ERROR_CODES` union in `types/billing.ts`, thrown as a dedicated `BlobStoreError` class (the `InvoiceRenderError` pattern) rather than `AppError`, because these are framework-agnostic store codes with a structured `detail`, not members of `lib/errors.ts`'s closed HTTP-mapped union. **bm55:** for the same reason, `TEMPLATE_GENERATION_FAILED` and `MANDATORY_SECTION_HIDDEN` are members of `INVOICE_ERROR_CODES` and are thrown as `InvoiceRenderError`. The bm55 spec says `AppError`, but the live preview maps every `InvoiceRenderError` to `PREVIEW_FAILED` with the code as its `detail`.

### Next.js rules (adds to §3)

1. **Two new pages under `app/(app)/administration/invoice-settings/`** (the map is below). Each page is a thin RSC with `export const dynamic = 'force-dynamic'`, a `requirePermission(PERMISSIONS.INVOICE_SETTINGS, 'READ')` guard at the top, `metadata.title` ("Invoice Settings — Company profile" / "Invoice Settings — Invoice template"), `loading.tsx` and `error.tsx`. `/administration/invoice-settings` only `redirect()`s to `/administration/invoice-settings/company-profile`.
2. **Tabs are `searchParams`, parsed and never trusted** (§3.3 pattern): `?tab=edit|history` on Company profile; `?tab=edit|generated|history` on Invoice template; `?version=<BTV…|n>` selects a version for read-only view. An invalid value falls back to `edit`.
3. **Every mutation is a Server Action under `actions/billing/invoice-settings/`.** Each re-checks `invoice_settings : EDIT` server-side, then calls a service. Success calls `revalidatePath('/administration/invoice-settings', 'layout')`.
4. **The logo upload is a Server Action taking `FormData`.** This sits within the existing `serverActions.bodySizeLimit: "5mb"` (`next.config.ts`). The 500 KB cap is enforced in the service on the actual byte length, never trusted from the client's `File.size`. Do not raise `bodySizeLimit` for this feature.
5. **The live preview is a Server Action that returns HTML, shown in a sandboxed iframe.** `previewInvoiceTemplateAction({ structure, source: 'sample' | { billId } })` renders through the real pipeline with `isDraft: true`. The client sets it as `<iframe sandbox="" srcDoc={html}>`: an empty `sandbox` means no scripts, same-origin or forms. Do not use `dangerouslySetInnerHTML` in the app DOM. The preview generates in memory and writes nothing (no blob, no row).
6. **`'use client'` leaves only:** `InvoiceStructureForm` (checkboxes + debounced preview call), `CompanyProfileForm` (React Hook Form + the shared Zod schema, general §4.12), `LogoUploadField`, `ActivateVersionDialog` (change-note required) and `InvoicePreviewFrame`. `VersionHistoryTable` and `GeneratedHbsViewer` stay server components.
7. **File and byte downloads are session-guarded GET Route Handlers inside `app/(app)/…`**, following the bm18/bm19 `draft-invoice`/`stored-invoice` precedent. They are not `app/api/*` routes, because §5's "exactly three `app/api/billrun` handlers" stays true. Each handler runs `requirePermission` first, parses its params with a Zod ID schema, and returns 404 for unknown IDs.
8. **Handlebars, the generator and Playwright never reach a client bundle.** They are imported only from `services/billing/invoice-template/**` (no `next/*`, general §3.14). A client import of `handlebars` fails the build-boundary lint.

### Styling (adds to §4)

1. **Invoice CSS lives in the layout files in the blob store, not in Tailwind.** The general §4.3 token rule (no raw hex) applies to app components only. The invoice layout uses `{{company.brandColor}}`/`{{company.accentColor}}` from the profile plus developer-fixed CSS in `shell.hbs`. App screens never import invoice CSS, and the layout never references Tailwind classes.
2. **Fonts are embedded in the layout** (pending O4): `@font-face` with a data-URI or bundled file referenced by a checksum-verified path. No Google Fonts or other external `url()`. The rendered page must reach `networkidle` with zero network requests.
3. **Images come only through `{{company.logoUrl}}` or `{{asset …}}`, and both resolve to a `data:` URI.** CI layout lint (`tests/guardrails/invoice-layout-lint.test.ts`) fails on `<img src="http`, `url(http`, `<script`, `{{{`, `<link`, `@import`, and on any helper name outside the nine registered helpers.
4. **The pagination mechanics are fixed.** "Page X of Y" uses Chromium `displayHeaderFooter` + `footerTemplate` only (R5). The draft watermark stays the existing `position: fixed` `.watermark` (R5). `<thead>` repeats, line groups use `break-inside: avoid`, and the footer margin must not clip the watermark (success criterion 7).
5. **Hidden means absent.** A section or column whose `structure` flag is `false` produces **no markup** in the generated `.hbs`. A hidden column also removes its total and adjusts `colspan` via `[[num …]]`. Do not use CSS `display:none` for structure. Blank optional profile fields are wrapped in `{{#if}}` and render nothing.
6. **"Amount due" carries the fixed text stating it is this invoice's current charges only** (R2). This is developer wording in the layout, not a profile field.
7. **Admin screens reuse existing primitives.** `VersionHistoryTable` reuses the Administration table primitives (§4.8). Status uses one new shared badge, `TemplateVersionStatusBadge` (`DRAFT` outline, `ACTIVE` success, `RETIRED` muted, plus a `Default` outline chip when `is_default`). Use it for both template and profile versions, and never fork a second treatment. Mandatory sections render as checked + disabled checkboxes with a lock icon (`lucide-react` `Lock`) and an accessible "Required" label.

### API routes (adds to §5)

1. **No new `app/api/*` handler and no change to the three M2M handlers.** The route-inventory test (§9 item 11) keeps asserting exactly three `POST` handlers.
2. **New session-guarded GET handlers** (map below) follow general §5 status codes: `200` · `401` · `403` · `404` · `422` (bad ID shape). Byte responses set `Content-Disposition: attachment` (`.hbs`, `.csv`) or `inline` (logo, PDF) and always `X-Content-Type-Options: nosniff`.
3. **The logo bytes handler also sends `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'`.** It serves the stored MIME and never sniffs, so a sanitizer miss in an SVG cannot execute when opened directly.
4. **The `.hbs` download serves exactly the stored, checksum-verified bytes** as `text/plain; charset=utf-8`. It never re-generates the file.

### Data and storage rules (adds to §6)

1. **New tables, all in `billing`, none partitioned** (catalog tables, like `bill_run`):
   - `bill_format`: one seeded row, `INVOICE`.
   - `bill_template_version`: `kind`, `version_no`, `status`, `is_default`, `layout_code` (for `layout` rows), `ref_layout_version_id` (for `generated` rows), `structure` jsonb (for `generated`), `page_setup` jsonb (for `layout`), `blob_ref`, `checksum`, `created_by/at`, `activated_by/at`, `retired_at`, `change_note`.
   - `bill_asset` / `bill_asset_version`: `mime`, `width`, `height`, `byte_size`, `blob_ref`, `checksum`.
   
   Every table gets Drizzle schema in `db/schema/billing/`, FKs to `core` users for `*_by`, and per-table grants (rule 6).
2. **Database constraints enforce the version rules** (bm50 migration `0046`):
   - UNIQUE `(ref_bill_format_id, kind, version_no)` (`btv_version_uq`).
   - A partial UNIQUE `(ref_bill_format_id, kind) WHERE status = 'ACTIVE' AND NOT is_default` (`btv_one_active_uq`, C3); plus `btv_one_default_uq … WHERE is_default` and `btv_one_draft_uq … WHERE status = 'DRAFT'`.
   - A CHECK that `status <> 'DRAFT'` implies `blob_ref`, `checksum`, **`checksum_algorithm`** and `activated_datetime` are NOT NULL (`btv_files_when_not_draft`); a DRAFT has a `structure` and no files (`btv_draft_has_no_files`), and only `kind = 'generated'` may be DRAFT (`btv_draft_only_generated`).
   - A CHECK that `status = 'ACTIVE'` or `'RETIRED'` implies `change_note` is NOT NULL and not blank; `is_default` implies ACTIVE.
   - A CHECK that `kind = 'generated'` implies `ref_layout_version_id` + `structure` NOT NULL; `kind = 'layout'` implies `layout_code` + `page_setup` NOT NULL.
   - **Checksum model (G6):** `checksum_algorithm` is `'sha256'` and recorded per row (invoice PDFs keep md5). A version directory's `checksum` is the SHA-256 of its canonical `checksums.json` index (keys sorted, 2-space, LF, trailing newline), which itself maps every file to its SHA-256; `load()` (bm53) verifies the index against the row, then every file against the index (Inv #45). The index is generated by `scripts/invoice-templates/write-checksums.ts`, never hand-edited.
3. **Versions are append-only and retire-only** (general §6.7 spirit; there is no tombstone because nothing is deleted). Allowed `UPDATE`s are DRAFT → ACTIVE (with the blob stamps), ACTIVE → RETIRED, and editing a DRAFT's `structure`. **One working draft per kind, saved by upsert (bm57):** `btv_one_draft_uq` allows a single DRAFT per `(INVOICE, 'generated')`, so Save draft inserts it on the first save (`version_no` = the next number, `ref_layout_version_id` = the layout of the version invoices currently use, no files) and afterwards updates only its `structure` and `last_modified_datetime`. Concurrent edits are guarded by an **optimistic token**: the draft's `last_modified_datetime` rendered in SQL at microsecond precision (a JS `Date` would truncate to milliseconds and never match), sent back with every save. A mismatch, a stale belief that a draft does or does not exist, or a lost first-save race is `DRAFT_CONFLICT`, never last-writer-wins. The service takes the per-kind advisory lock first, so two concurrent first saves become one insert and one conflict. While a working draft exists it is the only editable version: the Invoice template page opens other versions read-only, so a save can never replace the draft with another version's content. A draft keeps its `version_no` when bm58 activates it, and it is never deleted. A trigger refuses any other `UPDATE` and every `DELETE`, and refuses any status change on an `is_default` row (`DEFAULT_VERSION_IMMUTABLE`). `app_runtime` gets no `DELETE` on these tables.
4. **Stamp the versions in the same `UPDATE` as `stampPosted`.** `customer_bill_finalization_guard` (migration `0033`) refuses any `UPDATE` once `ref_inv_document_id` is set, so a later stamp is impossible. `customerBillRepository.stampPosted` gains `refBillFormatId`, `refBillTemplateVersionId`, `refInvoiceProfileVersion` and `refCsvTemplateVersionId`. `post-run.ts` resolves them inside the per-account posting transaction (Inv #6). The two new columns go on `customer_bill`, not on `bill_run_invoices`. **Built as specified (bm54):** `resolveVersionsForPosting(tx)` resolves the four values from DB rows only, sharing the draft render's "current" helper. `stampPosted` writes them in its single `UPDATE … WHERE … AND ref_inv_document_id IS NULL`. `lockBillForPosting` and `findForAccount` return the stamps. Proven by `tests/db/customer-bill-stamps.integration.test.ts` (one UPDATE carries all five columns; a later stamp → `23001`) and guardrail 46 (`tests/guardrails/invoice-version-pinning.integration.test.ts`).
5. **The company profile is `core.system_config` group `invoice.profile`** with the existing `config_version` + `status` columns. One version is N key rows sharing a `config_version`, and `is_secret = false` on every row (general §6.15). Bank details print on every invoice and are not secrets. The logo is stored as key `logo_asset_version_id` (an `INVASV…` ID). A version cannot become ACTIVE without it (`PROFILE_LOGO_REQUIRED`). **Reserved metadata keys (bm56 D2):** each version also carries `meta.change_note`, `meta.activated_by` (`appuser.id`), `meta.activated_at` and `meta.retired_at` (ISO-8601 UTC; written by bm61, `retired_at` on the previous version) in the same group and `config_version`, because `system_config` has no change-note or activation columns. `invoiceProfileSchema` excludes every `meta.*` key: the repository splits a version's rows into `fields` and `meta` before parsing (`readVersion` returns fields only, `readVersionRaw` both). `meta.*` is a denormalized display convenience; `AUDIT_LOG` stays the authoritative history. The Company profile page renders the **unparsed** field map (a DRAFT may be incomplete); the strict parse is for invoice rendering and activation. The app branding logo (`app`/`app_logo_path`, `getBrandingLogo()`) is untouched.
6. **Grants are per table** (Inv #23). `app_runtime` gets `SELECT, INSERT, UPDATE` on `bill_template_version`, `bill_asset` and `bill_asset_version`, `SELECT` on `bill_format`, and no `DELETE`. `billrun_runtime` gets nothing, because the flow never renders. C1 resolved to R9: rating migration `0045` (bm48) added nullable `state`/`district` columns to `rating.udr_rated`, and `rating_runtime` writes them at rating time under its existing table-level `INSERT` — no grant change, and no role may UPDATE them. No backfill.
7. **Generalize the blob store; do not fork it (R4, delivered bm51).** `services/billing/blob-store.ts` gains `putObject(container, path, bytes, contentType, { writeOnce, onExists, checksumAlgorithm })` / `getObject(container, path)` / `parseBlobRef` / `digest`, and `putInvoice`/`getInvoice`/`putReport` become thin callers whose bytes, paths, content types, md5 checksums and 412 behaviour are unchanged (a byte-equality parity test pins this). Every `putObject` result carries `checksumAlgorithm` and `created`; `invoices` keeps md5, the two new containers use SHA-256 (C4/G6). **Write-once** (`if-none-match: *`): on 412, `onExists: 'returnExisting'` downloads the existing blob and returns its digest with `created: false` (today's `putInvoice` posting-retry idempotency), `onExists: 'throw'` (the default — every template/asset consumer, Inv #44) raises a typed `BLOB_ALREADY_EXISTS`. `getObject` returns raw bytes and does **not** verify — the caller checks against the DB checksum (rule 8). Paths are validated (`INVALID_BLOB_PATH`: no `..`, no leading/trailing `/`, no space/`%`, ≤512 chars), and the container is checked against the union at runtime. There are two new containers, `invoice-templates` and `invoice-assets`, using the paths `invoice-templates/layouts/{layoutCode}/v{n}/…`, `invoice-templates/generated/INVOICE/v{n}-{digest12}/{invoice.hbs,footer.hbs,structure.json,checksums.json}` (bm58: the directory is content-addressed, `{digest12}` being the first 12 hex characters of the SHA-256 of that version's `checksums.json`. A draft reserves its `version_no` at creation, so a retry after a failed activation, or after the draft is edited, would otherwise collide with its own orphaned `v{n}/` blobs, and write-once forbids overwriting them. An identical retry finds identical blobs (`returnExisting`, equal digests); an edited draft gets a fresh path; orphans are never deleted inline), `invoice-templates/system/csv/v{n}/…` and `invoice-assets/{INVAST…}/sha256-{digest12}/logo.{ext}` (bm60 refinement of `{INVAST…}/v{n}/<file>`: the path is content-addressed — `{digest12}` is the first 12 hex characters of the logo's SHA-256 — so the version number is allocated afterwards inside the transaction with no reservation race, the same bytes re-uploaded find the same blob (`returnExisting`, equal digests), a different blob at the path is `ACTIVATION_BLOB_CONFLICT`, and an orphan from a failed transaction is never deleted inline). There is no `system/xml` path (R3). `createIfNotExists` runs per container on the connection-string path only (not the account-URL/Managed-Identity path); prod's app currently runs the connection-string path (its string comes from Key Vault), so auto-create runs there too today. From bm52 all three app containers are declared in bicep (`workflow-engine-storage.bicep`, under `enableBlobArtifacts`), so neither path depends on auto-create; the auth path is gate G16 (C5).
8. **The compiled-template cache is the one sanctioned in-memory cache.** It is a module-level `Map<bill_template_version_id, LoadedGeneratedTemplate>` (`{ invoice, footer, structure }`) in `services/billing/invoice-template/load.ts`, holding only entries whose bytes verified and whose delegates passed the load-time probe (bm53). It is safe because non-DRAFT versions are immutable. The cache holds compiled templates only. It never holds the "current ACTIVE" resolution, a profile, a logo or a bill (general §6.12).
9. **Logo upload checks run server-side, in this order:** byte length ≤ 500 KB → magic bytes ∈ {PNG, JPEG, SVG} and equal to the declared MIME → dimensions ≥ 300 px on the shorter side (bm60: pure, bounds-checked parsers in `services/billing/invoice-profile/image-dimensions.ts` — PNG `IHDR` as the first chunk, the first JPEG `SOFn`, the SVG root's unitless/`px` `width`/`height` else its `viewBox`; other SVG units are refused; **no image library**, `sharp` is only an optional transitive of `next`) → for SVG (`sanitize-logo.ts`), reject when it contains `<script`, `<foreignObject`, `<iframe`, `<embed`, `<object`, `on*=` attributes, `href`/`xlink:href`/`url(` pointing outside `#` fragments, `javascript:` or `data:`, `<!DOCTYPE`/`<!ENTITY`, `@import`, or a `<style>` with `url(`/`@import`. SVG detection skips a leading `<!DOCTYPE` so the content check can name it. **Reject; do not repair.** A stripped SVG is a different artifact than the one the admin previewed. The first failure decides the `LOGO_REJECTED` reason (`size` → `mime` → `dimensions` → `svg_content`); a rejection writes nothing and is not audited.
10. **The seed is a migration plus repo files.** The migration inserts `bill_format` `INVOICE`, `INVTPL-STD-A4` v1 (`kind = 'layout'`) and the default generated v1 (`is_default = true`, ACTIVE), plus the `invoice_settings` permission row (`ON CONFLICT DO NOTHING`, the `0043_ratecard_permission.sql` precedent). Role grants are applied by the seed. The layout's files live in the repo under `db/seeds/invoice-templates/INVTPL-STD-A4/v1/` and are uploaded write-once by `db:setup`. Use the next free migration number after `0044`.
11. **Retired versions are retained** while any `customer_bill` references them (O10, recommended). There is no retention job in v1, so nothing ever deletes a version.

### File organization (adds to §7)

```
app/(app)/administration/invoice-settings/
  page.tsx                                   # redirect → company-profile (bm56; invoice-template in bm55)
  layout.tsx                                 # guard READ + heading (each page renders InvoiceSettingsTabs with its own `active`)
  company-profile/
    page.tsx  loading.tsx  error.tsx         # CompanyProfilePage
    logo/[assetVersionId]/route.ts           # GET logo bytes
  invoice-template/
    page.tsx  loading.tsx  error.tsx         # InvoiceTemplatePage
    versions/[versionId]/files/[file]/route.ts   # GET invoice.hbs | footer.hbs | structure.json
app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts  # GET invoice CSV
actions/billing/invoice-settings/
  save-profile-draft.action.ts   activate-profile.action.ts   upload-logo.action.ts
  save-template-draft.action.ts  activate-template.action.ts  preview-invoice-template.action.ts
components/billing/invoice-settings/
  invoice-settings-tabs.tsx  company-profile-form.tsx  logo-upload-field.tsx
  invoice-structure-form.tsx  invoice-preview-frame.tsx  activate-version-dialog.tsx
  version-history-table.tsx  generated-hbs-viewer.tsx  template-version-status-badge.tsx
services/billing/invoice-template/
  resolve-template.ts   # pinned → ACTIVE → default
  load.ts               # blob get → checksum → compile (knownHelpersOnly) → cache
  bind.ts               # InvoiceRenderInput from bill lines, tax items, document, organization
  helpers.ts            # the nine registered helpers (wrap formatCurrency/formatCalendarDate)
  generate.ts           # [[if]]/[[num]]/[[body]] directive resolution → .hbs (bm55)
  preview.ts            # live preview: in-memory generate (sample / unposted) or stamped (posted) → HTML (bm55)
  activate-template.ts  save-template-draft.ts
services/billing/read/
  invoice-template-settings.ts  # page data, Generated .hbs bytes, file download, recent posted bills (bm55)
  invoice-csv.ts        # fixed column map → CSV
services/billing/invoice-profile/
  activate-profile.ts  save-profile-draft.ts  upload-logo.ts  sanitize-logo.ts
db/schema/billing/
  bill-format.ts  bill-template-version.ts  bill-asset.ts
db/repositories/billing/
  bill-template-version.ts  bill-asset.ts  invoice-profile.ts  invoice-render-input.ts
validation/billing/
  invoice-template-structure.schema.ts  invoice-profile.schema.ts
  invoice-settings-search-params.schema.ts   # ?tab=edit|generated|history, ?version=BTV… (bm55)
  activate-version.schema.ts  logo-upload.schema.ts  template-version-id.schema.ts
db/seeds/invoice-templates/INVTPL-STD-A4/v1/
  manifest.json  shell.hbs  footer.hbs  partials/*.hbs  sample-data.json
```

1. **`render-invoice-template.ts` becomes the binder's entry point, and `render-invoice.ts` keeps only the Chromium orchestration.** The semaphore, `BROWSER_CLOSE_TIMEOUT_MS` and `renderPdfFromHtml` stay unchanged except for reading `page_setup` and adding `footerTemplate`. The HTML string builders move into the layout files.
2. **`invoice-render-input.ts` is the binder's only repository.** It reads `customer_bill_line`, `customer_bill_tax_item`, `document`, `organization` and `contact_medium` in one repeatable-read, read-only transaction, the draft-render idiom already in `render-invoice.ts`. It must not reference `rating.` (§7.6 boundary test). C1 resolved to R9 (bm48), so when bm49 moves the usage section onto `udr_rated.state/district`, that usage-row read goes in `rated-lines.ts`, which stays read-only.
3. **Do not fork the nav (§7.4).** Add one `NAV_REGISTRY` entry under Administration (`href: '/administration/invoice-settings'`, `permission: 'invoice_settings'`, level READ) plus its glyph in `components/nav-icons.ts`. The CI nav guardrail then covers it.
4. **`PERMISSIONS.INVOICE_SETTINGS = 'invoice_settings'`** goes in `auth/permission-constants.ts`, with the matching `PermissionName` member in `types/rbac.ts`, in the same PR as the migration.

### Permission names & per-page permission map (adds to §8)

**Four-eyes on profile activation (G14, decided 2026-10-10: option C).** When an activation changes any payment field (`bank_name`, `bank_account_name`, `bank_account_no`, `swift`, `jompay_biller_code`, `remittance_email`) against the ACTIVE version, the service refuses with `PROFILE_FOUR_EYES_VIOLATION` if the actor last saved the draft (the `modified_by` of its newest row) or uploaded its logo (`bill_asset_version.created_by`). Enforced in the service like the money gate (Inv #8); the UI message is UX only. No new permission or level: the second signer needs `invoice_settings : EDIT`.

**One new permission, `invoice_settings`, with levels READ and EDIT only.** There is no DELETE level because versions are retire-only and the default is immutable. It is separate from `billrun_*` (it is not a bill-run action) and from `system_config` (that page edits generic config rows). Admins edit the profile through its own validated screen, and the generic System Config page must not edit the `invoice.profile` group, so exclude that group from its editable list. **Built (bm56):** `systemConfigRepository.findAllNonSecret` filters `config_group <> INVOICE_PROFILE_CONFIG_GROUP` (`types/billing.ts`), and `updateConfigValue` returns `{ ok: false, code: 'GROUP_NOT_EDITABLE' }` for such a row (no write, no audit), so a crafted action call cannot bypass the hidden row. `GROUP_NOT_EDITABLE` is in the action's result union and the edit dialog's error copy; no other System Config behaviour changed. Four-eyes does **not** apply to activation (not in the plan). Seeded role grants follow the `ratecard` precedent: ADMIN/MANAGER : EDIT, USER : READ, confirmed in the build spec.

| Surface | Route | Top-level component(s) | Folder | Permission : level |
|---|---|---|---|---|
| Invoice Settings entry (redirect only) | `/administration/invoice-settings` | `page.tsx` → `redirect()` | `app/(app)/administration/invoice-settings/` | `invoice_settings` : **READ** |
| Company profile — view, version history | `/administration/invoice-settings/company-profile` (`?tab=edit\|history`) | `CompanyProfilePage` → `InvoiceSettingsTabs`, `CompanyProfileForm` (read-only below EDIT), `VersionHistoryTable`, `TemplateVersionStatusBadge` | `app/(app)/administration/invoice-settings/company-profile/` | `invoice_settings` : **READ** |
| Company profile — save draft, upload logo, activate | same page (form + dialog) | `CompanyProfileForm`, `LogoUploadField`, `ActivateVersionDialog` | `actions/billing/invoice-settings/{save-profile-draft,upload-logo,activate-profile}.action.ts` | `invoice_settings` : **EDIT** (an activation that changes payment fields needs **a second EDIT user** — G14 option C) |
| Logo bytes (profile preview, history) | `GET /administration/invoice-settings/company-profile/logo/[assetVersionId]` | `route.ts` → `billAssetRepository` + `blobStore.getObject` | `…/company-profile/logo/[assetVersionId]/` | `invoice_settings` : **READ** |
| Invoice template — view, Generated .hbs, version history | `/administration/invoice-settings/invoice-template` (`?tab=edit\|generated\|history`) | `InvoiceTemplatePage` → `InvoiceSettingsTabs`, `InvoiceStructureForm` (read-only below EDIT), `InvoicePreviewFrame`, `GeneratedHbsViewer`, `VersionHistoryTable` | `app/(app)/administration/invoice-settings/invoice-template/` | `invoice_settings` : **READ** |
| Invoice template — live preview | same page | `InvoicePreviewFrame` → `preview-invoice-template.action.ts` | `actions/billing/invoice-settings/preview-invoice-template.action.ts` | `invoice_settings` : **READ** (read-only render, persists nothing) |
| Invoice template — save draft, activate | same page | `InvoiceStructureForm`, `ActivateVersionDialog` | `actions/billing/invoice-settings/{save-template-draft,activate-template}.action.ts` | `invoice_settings` : **EDIT** |
| `.hbs` / `structure.json` download | `GET /administration/invoice-settings/invoice-template/versions/[versionId]/files/[file]` | `route.ts` → `blobStore.getObject` (checksum-verified) | `…/invoice-template/versions/[versionId]/files/[file]/` | `invoice_settings` : **READ** |
| Invoice CSV download (posted bill) | `GET /billing/bill-runs/[runId]/stored-invoice/[banId]/csv` | `route.ts` → `buildInvoiceCsv` | `app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/` | `billrun_view` : **READ** |
| Draft PRO-FORMA preview (existing row) | `GET /billing/bill-runs/[runId]/draft-invoice/[banId]` | unchanged route; now renders through the binder with the current ACTIVE versions | unchanged | `billrun_view` : **READ** (unchanged) |
| Stored final invoice (existing row) | `GET /billing/bill-runs/[runId]/stored-invoice/[banId]` | unchanged; serves stored bytes (reprint, D8) | unchanged | `billrun_view` : **READ** (unchanged) |
| Retry render (existing row) | `/billing/bill-runs/[runId]` (posting-progress view) | `RenderPendingRow` → `retry-render-invoice.action.ts`; now also the surface for a parked render (General rule 3) | unchanged | `billrun_approve` : **EDIT** (unchanged) |

**Notes**

- The route × level matrix gains the five new routes above: no permission → `/no-access` or 403; READ → view, preview and downloads but every EDIT action refused server-side; EDIT → everything. A READ user sees the forms disabled (show/hide only). The action guard is what is tested.
- The live preview of a **posted** bill (`source: { billId }`) also requires `billrun_view : READ`. Customer billing data must not leak to a holder of `invoice_settings` alone. **Built (bm55):** the action checks it with `hasLevel` before any read, for every `{ billId }` source (posted or not), and the page lists posted bills only for a `billrun_view` holder.
- **Index redirect target (bm56):** `/administration/invoice-settings` redirects to `/administration/invoice-settings/company-profile`, the final target (Next.js rule 1; it was `invoice-template` in bm55). Company profile is the first tab. The page and the layout both guard `invoice_settings : READ`, and the nav entry is registered at the index. `company-profile` and `invoice-template` are listed in the nav guard's `UNLISTED_BY_DESIGN` ("reached via the Invoice Settings tabs"). **Logo bytes (bm56):** the GET handler is session + `invoice_settings : READ` (401, 403, then 422 for an id not matching `^INVASV\d{8}$`, then 404), serves the stored bytes only after the SHA-256 digest matches the row (mismatch: 500, no body, `ASSET_CHECKSUM_MISMATCH` logged), with `Content-Type` = the stored MIME, `Content-Disposition: inline`, `nosniff`, `Content-Security-Policy: sandbox; default-src 'none'; style-src 'unsafe-inline'` and `Cache-Control: private, max-age=0, no-store`.
- **Authz matrix (bm55):** `tests/guardrails/invoice-settings-authz-matrix.test.ts` holds the `MatrixRow[]` for guardrail 56's routes. bm56–bm62 append their rows to it.
- These rows are the authz-sweep inventory additions (§8 note). The ZAP/Semgrep scopes already cover them.

### Guardrail tests (extends §9, items 43–56)

43. **[CRITICAL] Binder reconciliation (R1/R10).** On the `ci` seed every rendered invoice's charge details include every `customer_bill_line` row for the bill, and `Σ net_amount = customer_bill.subtotal`. A fixture with a deliberately unbalanced line fails the render with `INVOICE_RECONCILIATION_FAILED`.
44. **[CRITICAL] No legacy fallback (R8).** `buildDraftInvoiceHtml`/`buildFinalInvoiceHtml` and `ratedLinesRepository.listClaimedForAccount` have no caller in the render path (grep gate). A forced render failure parks the account (render-pending + error code) and never produces a PDF.
45. **Default resolution (R11/C3).** On a fresh DB `bill_format` has exactly one row, and the default layout + generated versions are ACTIVE with `is_default = true`. Retiring or deleting either is refused by the trigger. A run posted with no admin activity renders with the default.
46. **[CRITICAL] Version pinning (D8).** Post under generated v2 + profile v1, then activate v3 + profile v2. The bill's four stamp columns and its stored PDF bytes are unchanged, and a new draft preview uses v3 + profile v2. The stamps land in the same `UPDATE` as `ref_inv_document_id` (a later stamp attempt is refused by `0033`).
47. **[CRITICAL] Checksum tamper.** Changing one byte of a stored layout, generated `.hbs` or logo blob fails that account's render with `TEMPLATE_CHECKSUM_MISMATCH`/`ASSET_CHECKSUM_MISMATCH`. Other accounts post and render.
48. **Generator.** For every combination of the 3 optional sections × 4 columns (128 cases) the generated `.hbs` compiles under `knownHelpersOnly`. It contains no `[[`, and contains no markup for any hidden key. A `structure` with a mandatory section `false` is rejected by the Zod schema. **Built (bm55):** `tests/services/billing/invoice-template/generate.test.ts` runs the 128 cases against the seeded layout v1 through the verified `loadLayout`. It also checks the `colspan` formulas, the header cell count, layout-pair widening, `TEMPLATE_GENERATION_FAILED`, annotate scope, and the client-bundle boundary (no `'use client'` module imports `handlebars` or `services/billing/invoice-template`). Semantic parity with the hand-written v1 is in `generate-parity.test.ts`: the `<body>` is byte-identical, and the `<style>` gap is known-issues §20.
49. **Manifest ↔ union parity.** The seeded manifest's optional section and column keys equal `InvoiceOptionalSectionKey`/`InvoiceColumnKey`, and the manifest has no `accountSummary` section and no `Tax` fixed column.
50. **[CRITICAL] Escaping.** A customer name, address and profile field containing `<script>alert(1)</script>` render escaped in HTML and PDF. Layout lint (Styling rule 3) fails on a seeded bad fixture.
51. **Profile validation.** Activation is refused without a logo or a change note. Invalid TIN, SST, postcode, SWIFT, email and colour values are rejected.
52. **Logo upload.** Each of these is rejected: >500 KB, <300 px, PNG bytes declared as SVG, SVG with `<script>`, `onload=`, `<foreignObject>` or an external `href`. The logo GET handler returns the CSP `sandbox` and `nosniff` headers.
53. **Activation atomicity.** A forced DB failure after the blob write leaves the previous version ACTIVE and no new ACTIVE row. A success creates version n+1 ACTIVE and n RETIRED, with one `INVOICE_TEMPLATE_ACTIVATED` audit row.
54. **Multi-page render.** A 3+ page fixture shows "Page X of Y" on every page, repeats `<thead>`, keeps each line group on one page, and the `position:fixed` watermark is not clipped (structural snapshot, not pixels).
55. **CSV.** There is one row per `customer_bill_line`, and the `net_amount` column sums exactly to `customer_bill.subtotal` (compared as strings after SQL sum, never float).
56. **Authz + grants.** The route × level matrix covers the five new routes and six actions (`invoice_settings` READ cannot save/activate/upload; no permission cannot open either page). The preview of a posted bill also requires `billrun_view`. `app_runtime` has no `DELETE` on the new tables, and `billrun_runtime` has no grant on them (asserted over `information_schema`).

Golden-render snapshots per layout version run in CI. The bm18/bm19 tests are rewritten against the binder, not kept on the legacy builders.
