# Billing Module — Known Issues & Deferred Items

Living record of known-but-not-yet-fixed issues in the Bill Run module, captured
from the bm09–bm11 multi-agent code review (see also
`billmgmt-progress-tracker.md`). Each entry has a technical description, an
**ELI5** plain-language summary, and a recommendation. Nothing here is a blocker
for the current release; they are logged so they are not silently forgotten.

> **Status legend:** 🟡 deferred (conscious decision) · 🔴 real bug, out of
> current scope · ⚪ cosmetic / low priority.

---

## 1. ⚪ `postRun` returns an unused `results` array (review #14)

**Where:** `services/billing/post-run.ts` — `PostRunResult.value.results`.

**Technical.** `postRun` returns a `results: { billingAccountId, result }[]`
array describing each account's per-post outcome (`invoiced` / `skipped` /
`parked` + `code`/`detail`). No production caller consumes it: the action
(`actions/billing/post-run.action.ts`) only checks `result.ok`, and
`PostingProgressView` re-derives everything from `getPostingProgress` after
`router.refresh()`. It is effectively a dead payload on the hot path.

**Why it's still here (intentional).** The unit suite
(`tests/services/billing/post-run.service.test.ts`) asserts on `results` to
verify per-account behaviour (invoiced vs. parked vs. skipped) without a DB.
Removing `results` would reduce that test observability for zero functional
gain. The redundant *second* full status scan that used to accompany it **has**
been removed (completion is now decided inside the locked transaction).

**ELI5.** The posting function hands back a little report card of what happened
to each account, but the screen ignores it and just re-reads the database
instead. The report card is only used by tests. It's harmless — just slightly
redundant.

**Recommendation.** Leave as-is, or (if trimming) keep the shape but have the UI
consume `results` directly instead of re-fetching. Low priority.

---

## 2. 🔴 No DB-level "one INV per bill" latch (review #9)

**Where:** `db/schema/billing/customer-bill.ts` (`ref_inv_document_id`) +
`services/billing/post-run.ts` / `customer-bill.repository.ts`.

**Technical.** "At most one posted INV per (run, account)" is enforced entirely
in the application layer:
1. `lockBillForPosting` takes `FOR UPDATE OF customer_bill` so two concurrent
   posts of the same account serialize on the bill row; the loser reads the
   now-set `ref_inv_document_id` and returns `skipped`.
2. `stampPosted` is `WHERE ref_inv_document_id IS NULL`-guarded and returns
   whether it wrote a row; `postAccount` throws (rolling back the INV) if it
   didn't.

There is **no schema-level constraint** guaranteeing this. The only DB
constraint on `customer_bill` is `UNIQUE (run, ban, period)` — one *bill* row —
which says nothing about `ref_inv_document_id` being set at most once, and the
actual INV lives in the separate `billing.document` table with no FK back to the
bill. So if a *future* code path ever posts outside this exact lock discipline
(a new caller, a lock downgrade, a replica read), two INV documents against one
bill become possible with no backstop — a double-billed customer + duplicate GL
posting.

**Why deferred.** A *meaningful* DB backstop needs a `document → customer_bill`
linkage (or a dedicated posted-latch table) — a schema redesign beyond the
review's scope. A partial unique index on `customer_bill (run, ban) WHERE
ref_inv_document_id IS NOT NULL` does **not** actually prevent the failure (the
duplicate lives in `document`, and there's already one bill row per key). The
current app-layer guards are correct and were hardened in this review; the risk
is strictly "if someone later bypasses them".

**ELI5.** We stop the same invoice from being created twice by having the code
"lock the door" while it works. That works today. But the *database itself*
doesn't enforce the rule — so a future developer who forgets to lock the door
could accidentally bill a customer twice. We'd need a small database redesign to
make that mistake impossible.

**Recommendation.** When a rating/finalization schema change is next on the
table, add a `document.ref_customer_bill_id` FK + a partial unique index (or a
posted-latch table) so duplicate INV creation is structurally impossible; demote
the app-layer checks to a friendly early-return.

---

## 3. ⚪ Duplicated error-vocabulary / badge patterns (review #15)

**Where:** several billing + accounts UI and service files.

**Technical.** The same small mappings are hand-written in multiple places:
- **`describePostFailure`** (postDocument codes → prose) in
  `services/billing/post-run.ts` duplicates the same code→message mapping in
  ~12 accounts panels (allocate-payment, capture-deposit/payment, raise-debit/
  credit-note, write-off, rounding-adjustment, reversal-dialog, …).
- **`describeError`** for the shared action-envelope codes
  (`FORBIDDEN` / `VALIDATION_ERROR` / fallback) is re-declared in
  `approve-and-post-panel.tsx`, `posting-progress-view.tsx`,
  `trigger-run-dialog.tsx`, and `rerun-dialog.tsx`.
- **`periodKeyFor`** (a `YYYY-MM` accounting-period key) exists in both
  `services/billing/pre-approval-checks.ts` and
  `services/accounts/post-document.ts` (plus two `to_char(..,'YYYY-MM')` SQL
  sites).
- **Status-badge cva** — `posting-progress-view.tsx` inlines a
  badge-variants block instead of a `PostingStatusBadge` component alongside the
  five existing per-status badges.

**Why deferred.** The highest-value target (`describePostFailure` across ~12
panels) lives **outside** the bm09–bm11 diff; refactoring it touches many
unrelated Accounts files for low functional gain and non-trivial churn/risk.

**ELI5.** A few error messages and little UI badges are copy-pasted in several
files instead of being written once and shared. Nothing is broken, but if
someone changes wording in one place they have to remember all the copies, and
they can drift apart over time.

**Recommendation.** Opportunistically extract, when a file is next touched for
another reason: (a) a shared `describePostDocumentError(code)` helper, (b) a
shared `describeBillingActionEnvelopeError(code)` helper for
`FORBIDDEN`/`VALIDATION_ERROR`, (c) one `periodKeyFor` helper in `lib/`, and (d)
a `PostingStatusBadge` component.

---

## 4. 🔴 Pre-existing integration-test failures surfaced during testing

Discovered while running the full integration suite against a throwaway
Postgres. These **fail identically on the base commit** (`2efa01b`) and are
**not** caused by the bm09–bm11 review fixes — but they are real and worth a
follow-up. All are outside the bm09–bm11 scope (they live in bm02/bm03).

### 4a. Materialize / trigger generate an invalid `2026-02-29` date

**Where:** `tests/db/materialize-runs.integration.test.ts`,
`tests/db/billing-schema.integration.test.ts` (bill-run insert path).

**Technical.** With the business clock at 2026-08-23, the run-date computation
produces `2026-02-29` — but **2026 is not a leap year**, so Postgres rejects the
`date` value (`22008 date/time field value out of range`). This points at a
month-end/day-clamping bug in the bill-run period/scheduled-date derivation
(a `cycle_day` near month-end not being clamped to the month's real last day).

**ELI5.** The code tried to schedule something for "February 29th, 2026", but
that day doesn't exist (2026 isn't a leap year), so the database refused it. The
date math needs to clamp to the last real day of the month.

### 4b. `trigger-run` double-trigger test hits a duplicate-key

**Where:** `tests/db/trigger-run.integration.test.ts` — "rejects a second
trigger while the run is already PROCESSING".

**Technical.** The test's `newScheduledRun` inserts a `bill_run` for
`(BCY00000001, 2026-06-01)` that already exists → `23505` unique violation on
`bill_run_cycle_period_unique`, i.e. a test-isolation/ordering issue (a prior
step in the file created the row and it isn't reset between cases).

**ELI5.** A test tries to create the same bill run twice and trips over the
"no duplicates" rule — a test-setup cleanup gap, not a product bug.

**Recommendation.** File a bm02/bm03 ticket: (1) clamp scheduled-run/period-end
dates to the month's real last day (fixes 4a), and (2) fix the trigger test's
per-case isolation (fixes 4b). Both are date/fixture issues, unrelated to the
approve/post work.

---

## 5. ⚪ Approve-page & period-close query efficiency (deferred perf pass)

Flagged by the bm09-11 review's efficiency finders. All are **per-render / per-
close** waste (not a hot per-account loop) with **no correctness impact**, so
they are deferred to a dedicated performance pass rather than reshaping the
heavily-tested approval-check module now.

**Technical.**
- **Redundant reads on the Approve preview.** `getApprovePreview` (force-dynamic
  RSC) calls `listPostableCurrencies` once, and `runPreApprovalChecks` re-runs
  it inside both `checkPeriodOpen` and `checkGlMappingsResolvable` — **3× the
  same `customer_bill ⋈ billing_account ⋈ bill_run_account` DISTINCT join per
  render**. `listStatusesForRun` is likewise read twice (preview counts +
  `checkAccountsTerminal`). Fix: compute currencies + statuses once and thread
  them into `runPreApprovalChecks` (optional precomputed params).
- **Wide audit fetch to pluck one actor.** `getApprovePreview` uses
  `auditLogRepository.findByTargetId` (all rows, full `beforeData`/`afterData`
  blobs) only to `.find()` the newest trigger/rerun actor. Fix: a targeted
  `findLatestActorForEvents(db, runId, TRIGGER_EVENT_TYPES)` returning just the
  name + timestamp.
- **No partition pruning on approval reads.** `listPostableCurrencies` /
  `countNonPositivePostable` / `sumPostableTotalForRun` join the two
  `PARTITION BY RANGE(period_partition)` tables WITHOUT the `period_partition`
  predicate `lockBillForPosting` now has, so they scan every monthly partition.
  Fix: add the `firstOfMonth(run.periodStart)` predicate (a signature change to
  those methods + callers).
- **Non-sargable period-close guard.** `findActiveForPeriod` filters
  `to_char(gl_event_at, 'YYYY-MM') = period` (seq-scans all of `bill_run`; no
  index on `gl_event_at`). Fix: a sargable range predicate + a `gl_event_at`
  index (migration).

**ELI5.** Opening the Approve page runs a handful of the same database lookups
several times, and closing a period scans the whole run history. Nothing is
wrong — it's just slower than it needs to be, and it gets slower as more months
of data pile up. Worth batching later; not urgent.

**Recommendation.** One perf pass: dedup the approval reads (thread
currencies/statuses), add the partition predicate to the three approval reads,
add the `gl_event_at` index + sargable close guard, and a targeted latest-actor
read.

---

## 6. 🟡 Four-eyes leans on the audit log for rerun-actor coverage (latent)

`checkFourEyes` bars every actor in the `BILL_RUN_TRIGGERED`/`BILL_RUN_RERUN`
audit trail (∪ `bill_run.triggered_by`) from approving — the intended, stronger
segregation-of-duties rule ("Ops triggers/reruns, a Manager approves"). Two
latent edge cases, **neither reachable in v1**:

- **Lockout:** if a run were triggered with a **null** actor (a system/cron
  path) leaving `triggered_by` null AND no audit rows, the barred set is empty
  and the check fails closed → no one can approve. (v1 always triggers via a
  user action that stamps `actorId`, so this can't happen; the old
  `triggered_by`-only check had the same null-fail-closed behaviour.)
- **Bypass:** if a rerun's `BILL_RUN_RERUN` audit row had a **null** actor
  (dropped by the set), that rerunner wouldn't be barred. (v1 rerun always
  stamps a user; audit rows for a run being approved are days old, far inside
  the 7-year retention, so pruning is not a factor.)

**ELI5.** We decide who's *not allowed* to approve by reading the run's history
log. Today every trigger/rerun is stamped with a real person, so it works. If a
robot ever triggered a run without a name, the rule could either lock everyone
out or miss the robot — but no robot does that today.

**Recommendation.** If a system/automation trigger path is ever added, make the
barred-actor set authoritative in `bill_run` state (a dedicated `triggered_by` /
`reran_by` actors column or a small `bill_run_actors` table written at
trigger/rerun) rather than re-deriving it from the prunable audit log.

---

## 7. 🟡 Multi-currency total shown in the Approve preview (latent)

Single-currency-per-cycle is a v1 invariant, and `approveRun` already **blocks**
a multi-currency run with `MULTI_CURRENCY`. But `getApprovePreview` still
displays `currency = currencies[0]` with `totalAmount =
sumPostableTotalForRun` (a blind cross-currency SUM), so a (hypothetical)
multi-currency run would show a meaningless single-currency figure until the
operator clicks and hits the block.

**ELI5.** If a run ever mixed dollars and euros (it can't today), the review
screen would show one wrong combined number; you'd only find out it's blocked
when you press Approve. Harmless now because runs are single-currency.

**Recommendation.** When the preview computes currencies, surface `>1` up front
(a `single_currency` pre-approval check or a preview flag) instead of only at
the write path.

---

## 8. ⚪ Minor items (bm09-11 review, low severity)

- **`INV_LEG_TEMPLATES` non-null aliases.** `charge: DBN_LEG_TEMPLATES.charge!`
  uses the file's established `!` idiom (cf. `refund: PAY_LEG_TEMPLATES.refund!`);
  if a DBN key were ever removed the INV template would silently be `undefined`
  and fail at first post rather than at compile. Left as-is for idiom
  consistency; a shared `requireLegTemplate()` load-time assert would close it.
- **Stale four-eyes checklist on submit.** If a viewer becomes a barred actor
  *between* page-load and submit, `ApproveAndPostPanel` shows the
  `FOUR_EYES_VIOLATION` error text but doesn't refresh the checklist (only
  `CHECKS_FAILED` calls `setChecks`), so `four_eyes` still renders green with the
  button enabled. Cosmetic — the service still refuses. Refresh the checklist on
  `FOUR_EYES_VIOLATION` to fix.
