# Billing Module — Known Issues & Deferred Items

Living record of known-but-not-yet-fixed issues in the Bill Run module, captured
from the bm09–bm11 multi-agent code review (see also
`billmgmt-progress-tracker.md`). Each entry has a technical description, an
**ELI5** plain-language summary, and a recommendation. Most entries are not blockers
for the current release; they are logged so they are not silently forgotten. The
end-to-end blocker in §9 (processor signal-back) has been **RESOLVED by bm36** —
the signal-back is now real. Phase 4 is delivered: bm37 added the local
`SCHEDULED → COMPLETED` live-Kestra lifecycle assertion, bm38 made the production
deploy path deployable + wired (still gated), and **bm39 audited the assembled
phase against its guardrails and signed it off** (§9 resolved, §10 ratified, no new
schema). The cloud cutover itself remains a gated ops step (see
`billmgmt-project-overview.md` and `billmgmt-progress-tracker.md`).

**§11–§14 and §4c were added on 2026-09-17**, from the first
end-to-end local execution of the full `SCHEDULED → COMPLETED` lifecycle
(processing, approval, posting and distribution all driven against real
Postgres, real Kestra and Azurite). Defects that run surfaced and FIXED are
recorded in `billmgmt-progress-tracker.md` and `README.md`; the entries here
are the ones still OPEN, plus the two interim mitigations whose root cause
(§11) is unaddressed.

**§15–§17 were added by bm46 (2026-10-07), the Target Capacity Ship Gate.**
§15 and §16 record the Target Capacity Pricing update's (bm40–bm45) ratified
residuals — accepted trade-offs, not fixed here — per that unit's own
closeout checklist. §17 is different in kind: it is an **unresolved business
decision** (O-TC7, partial-period capacity pro-ration), not a ratified
trade-off — no default has been chosen and none should be assumed.

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
gain. The redundant _second_ full status scan that used to accompany it **has**
been removed (completion is now decided inside the locked transaction).

**ELI5.** The posting function hands back a little report card of what happened
to each account, but the screen ignores it and just re-reads the database
instead. The report card is only used by tests. It's harmless — just slightly
redundant.

**Recommendation.** Leave as-is, or (if trimming) keep the shape but have the UI
consume `results` directly instead of re-fetching. Low priority.

---

## 2. 🟢 RESOLVED (bm19) — No DB-level "one INV per bill" latch (review #9)

**Update (2026-10-12, verified against dev1 `614743a`):** resolved as
recommended below. Migration `db/migrations/0037_document_customer_bill_latch.sql`
adds `document.ref_customer_bill_id` + `period_partition` (schema
`db/schema/billing/documents.ts`), a composite FK to
`customer_bill (customer_bill_id, period_partition)`, paired/INV-only CHECKs and
the partial unique index `document_ref_customer_bill_id_unique`
(`WHERE ref_customer_bill_id IS NOT NULL`), so a second INV for one bill is
structurally refused. The app-layer `IS NULL` guard in `stampPosted`
(`customer-bill.repository.ts` ~l.414) is demoted to a friendly early-return
(bm19 Phase-2 review fold T5). The text below is the original finding.

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
constraint on `customer_bill` is `UNIQUE (run, ban, period)` — one _bill_ row —
which says nothing about `ref_inv_document_id` being set at most once, and the
actual INV lives in the separate `billing.document` table with no FK back to the
bill. So if a _future_ code path ever posts outside this exact lock discipline
(a new caller, a lock downgrade, a replica read), two INV documents against one
bill become possible with no backstop — a double-billed customer + duplicate GL
posting.

**Why deferred.** A _meaningful_ DB backstop needs a `document → customer_bill`
linkage (or a dedicated posted-latch table) — a schema redesign beyond the
review's scope. A partial unique index on `customer_bill (run, ban) WHERE
ref_inv_document_id IS NOT NULL` does **not** actually prevent the failure (the
duplicate lives in `document`, and there's already one bill row per key). The
current app-layer guards are correct and were hardened in this review; the risk
is strictly "if someone later bypasses them".

**ELI5.** We stop the same invoice from being created twice by having the code
"lock the door" while it works. That works today. But the _database itself_
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
  **Update (2026-10-12, verified against dev1 `614743a`):** the copies have
  grown — `describeError` is now declared in **10 billing components**
  (the four above plus `cancel-run-dialog`, `reject-dialog`, `stall-banner`,
  `force-complete-distribution-dialog`, `rerun-distribution-control`,
  `start-distribution-control`) and **2 accounts components**
  (`close-period-button`, `wizard-defaults-form`). Still open.
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

## 4. 🟢 Pre-existing integration-test failures surfaced during testing (4a/4b RESOLVED by bm21; 4c no longer reproducing as of 2026-10-12)

Discovered while running the full integration suite against a throwaway
Postgres. These **fail identically on the base commit** (`2efa01b`) and are
**not** caused by the bm09–bm11 review fixes — but they are real and worth a
follow-up. All are outside the bm09–bm11 scope (they live in bm02/bm03).

### 4a. 🟢 RESOLVED (bm21 T7 #4a) — Materialize / trigger generate an invalid `2026-02-29` date

**Update (2026-10-12, verified against dev1 `614743a`):** the diagnosis below
was wrong. It was a **test-fixture bug, not a production one**: the fixture
built plain calendar-date strings per loop iteration (day 29 in February).
`currentDuePeriod` already clamps correctly via `Date.UTC`. The fixture now
uses `period_end` day 27 / `scheduled_run_date` day 28 in every month (see the
comment in `tests/db/materialize-runs.integration.test.ts` ~l.69-84). No
production date-clamping change was needed.

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

### 4b. 🟢 RESOLVED (bm21 T7 #4b) — `trigger-run` double-trigger test hits a duplicate-key

**Update (2026-10-12, verified against dev1 `614743a`):** fixed in the test as
diagnosed. The double-trigger case now uses its own period `2026-07-01`
(`tests/db/trigger-run.integration.test.ts` ~l.197-207), so it no longer
collides with the previous case's `2026-06-01` row.

**Where:** `tests/db/trigger-run.integration.test.ts` — "rejects a second
trigger while the run is already PROCESSING".

**Technical.** The test's `newScheduledRun` inserts a `bill_run` for
`(BCY00000001, 2026-06-01)` that already exists → `23505` unique violation on
`bill_run_cycle_period_unique`, i.e. a test-isolation/ordering issue (a prior
step in the file created the row and it isn't reset between cases).

**ELI5.** A test tries to create the same bill run twice and trips over the
"no duplicates" rule — a test-setup cleanup gap, not a product bug.

### 4c. ⚪ NO LONGER REPRODUCING — Both full-journey E2E suites fail at post → distribute (never triaged)

**Where:** `tests/db/billing-e2e-happy-path.integration.test.ts:776`,
`tests/db/billrun-phase3-journey.integration.test.ts:764` (was `:747`).

**Update (2026-10-12, verified against dev1 `614743a`):** no longer
reproducing. The bm42a/pm46a full integration run (1165 passed / 0 failed) and
the bm63 run (1219 passed / 0 failed, 75 skipped) were both green, including
both suites' `expect(…status).toBe("DISTRIBUTING")` assertions. No targeted fix
commit exists and the root cause was never triaged, so if it recurs, start from
the analysis below.

**Technical.** Surfaced on 2026-09-17 by the **first full DB-gated run** against a
disposable Postgres (89 files passed, 2 skipped, 2 failed; 813 tests passed).
Both fail the same assertion — `expected 'INVOICED' to be 'DISTRIBUTING'`:
posting settles the run at `INVOICED`, but the post-commit `triggerDistribution`
does not advance it. `distribute-run.ts` rolls its transaction back and returns
`ENGINE_UNREACHABLE` when `engineRegistry.trigger` throws, which is consistent
with the observed state but was **not** confirmed as the cause. The suites are
also sensitive to ambient environment beyond `DATABASE_URL`: re-running
`billrun-phase3-journey` with a dev `.env` also exported fails **earlier**
instead (line 568), so the two runs are not directly comparable.

**ELI5.** The two tests that walk a bill run from start to finish both stop at
the same step — after invoicing, the run never moves on to delivery. Nobody has
worked out why yet.

**Not a regression.** The progress tracker had listed this full DB-gated run as a
gated verification step that had never been executed, so these are
first-execution results, not something that broke.

**Recommendation.** File a bm02/bm03 ticket: (1) clamp scheduled-run/period-end
dates to the month's real last day (fixes 4a), and (2) fix the trigger test's
per-case isolation (fixes 4b). Both are date/fixture issues, unrelated to the
approve/post work.

**Update (2026-10-12, verified against dev1 `614743a`):** both done in bm21
T7, and (1) turned out to be unnecessary in production code: `currentDuePeriod`
already clamps, and only the 4a test fixture was wrong (see 4a). 4b was fixed
by per-case period isolation.

**4c is separate and untriaged** - it is a post→distribute lifecycle question,
not a date/fixture issue, and needs its own investigation before a ticket can
name a fix. (As of 2026-10-12 it no longer reproduces; see 4c.)

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
  `countNegativePostable` (formerly `countNonPositivePostable`; updated
  2026-10-12) / `countZeroTotalPostable` (added with the sign-based rule, §11) /
  `sumPostableTotalForRun` join the two
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
currencies/statuses), add the partition predicate to the four approval reads,
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

**ELI5.** We decide who's _not allowed_ to approve by reading the run's history
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
  _between_ page-load and submit, `ApproveAndPostPanel` shows the
  `FOUR_EYES_VIOLATION` error text but doesn't refresh the checklist (only
  `CHECKS_FAILED` calls `setChecks`), so `four_eyes` still renders green with the
  button enabled. Cosmetic — the service still refuses. Refresh the checklist on
  `FOUR_EYES_VIOLATION` to fix.

---

## 9. 🟢 RESOLVED (bm36) — Processor signal-back is real

**Where:** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml`
(per-stage completion + terminal `errors`/`afterExecution`); the non-deployable
`bill_run_processing.template.yml` documents the same contract.

**Was.** The processing flow did all its real SQL (correlation/claim, aggregation,
verification) but never signalled the app: it contained **zero**
`io.kestra.plugin.core.http.Request` tasks — the per-stage
`/api/billrun/{runId}/stage/{stage}/complete` POSTs and the terminal
`/api/billrun/{runId}/status` POST were `io.kestra.plugin.core.log.Log` stubs, so a
triggered run's accounts never auto-reached `PROCESSED`
(`TERMINAL_STAGE = 'verification'` in `services/billing/handle-stage-signal.ts`),
the run wedged in `PROCESSING`, and Approve → Post → Distribute → `COMPLETED` was
unreachable without an out-of-band signal replay.

**Now (bm36).** The flow POSTs a per-stage `DONE` after each stage, a per-account
HARD `FAILED` from the account stage group's `errors` handler (to a fixed
`verification` stage so it always lands), and a run-level terminal
`PROCESSING_FAILED` for a whole-execution failure only — `errors: on_error` on a
`FAILED` execution, `afterExecution: on_killed` on a KILL. All real
`http.Request`, mirroring the distributor (bm34). A triggered run now reaches
`PROCESSED` on its own; a contained per-account HARD failure leaves the run
`PROCESSED` with the failed account skippable/rerunnable (the tested run-status
contract), and only a whole-execution `FAILED`/`KILL` settles the run
`PROCESSING_FAILED`.

**Delivered (Phase 4, closed).** bm37 asserts the full `SCHEDULED → COMPLETED`
lifecycle on the `ci` seed (incl. reject → reprocess and the forced-failure path)
via the live-Kestra smoke; bm38 wired the production deploy path (deployable +
gated); bm39 audited the assembled phase (guardrails green, receivers unchanged, no
new schema) and signed it off. The live cloud cutover — flipping the deploy flags
and running the smoke against a real engine + SFTP — remains a gated ops step. Scope
in `billmgmt-project-overview.md`.

---

## 10. 🟡 Taxation stage is a no-op — every bill is zero-tax

**Where:** `bill_run_processing.yml` `taxation` stage (a `Log` placeholder).

**Technical.** The `taxation` stage computes nothing: `customer_bill.tax_total` is
always `"0.00"` and `total_amount = subtotal`. The `customer_bill_tax_item` table
and the single-rate `BILLRUN_TAX_RATE` config exist (bm06) but no tax line is
written by the real flow.

**ELI5.** The processor doesn't calculate tax yet — every invoice shows zero tax.

**Recommendation.** Ratified as the intended interim (Phase 4 decision) — invoices
show `total = subtotal`. Implement a real (flat-rate SST, then jurisdictional)
taxation stage in a later unit if RevOps needs a tax line on the reviewed invoice.

---

## 11. 🔴 The processor writes a zero-total bill for a zero-charge account

**Where:** `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml`

- the `aggregation` stage's `ins_header` CTE.

**Technical.** `ins_header` is a data-modifying CTE, so it runs **exactly once
per account regardless of whether `all_lines` is empty**; the flow's own comment
calls this "the deferred limitation". An account with no subscription and no
rated usage therefore gets a `customer_bill` header with `subtotal` and
`total_amount` of `0.00` and zero `customer_bill_line` rows. Since **bm32**
redefined Uncharged (Inv #22), such an account is scoped, `PROCESSED`, and
surfaced on the Uncharged tab — so the empty header is the only artefact of it,
and everything else already expects it NOT to exist: Verification guards with
`IF v_total IS NOT NULL` and treats a non-positive total as a **SOFT, advisory,
non-blocking** NOTICE, and `listUnchargedForRun`'s `HAVING` keeps accounts with
"NO bill/line".

**Blast radius (all observed live on the `ci` seed's `BAN...04`).** The stray
header broke the lifecycle twice in succession:

1. **At approval** — `positive_totals` counted it, making _any_ run containing a
   no-charges account permanently unapprovable.
2. **At posting** — posting inserts the revenue line at `amount = subtotal`, so
   `document_line_amount_check` (`amount > 0`) rejected it and parked the account
   at `POSTING_FAILED` with an opaque "An unexpected error occurred while posting
   this invoice."

**ELI5.** For a customer with nothing to bill, the system still creates a blank
zero-value invoice. Nothing wants that blank invoice, and it jammed first the
approval step and then the posting step.

**Two interim mitigations are in place (owner decisions, 2026-09-17).** Both
treat the symptom; neither removes the cause:

- `countNonPositivePostable` now ignores **line-less** zero bills, and the new
  informational `zero_total_bills` check reports them
  (`specs/bm10-approve.md` checks 3 and 6).
- `postAccount` skips a bill whose `subtotal` **and** `total_amount` are both
  exactly zero, marking the account `SKIPPED` / `ZERO_TOTAL_NOT_INVOICED`
  (`specs/bm11-post-to-ledger.md` step 1b).

**Recommendation.** Make `ins_header` conditional on `all_lines` being non-empty,
so a zero-charge account produces no bill at all. That was the engineering
recommendation before each mitigation; the owner chose the mitigations to unblock
the demo. Keep the posting skip afterwards as a second line of defence, and
revisit the approval narrowing (§12) at the same time.

**Update (2026-10-12, verified against dev1 `614743a`):** the first interim
mitigation has changed shape. `countNonPositivePostable` no longer exists; the
approval check is now **sign-based** (commit `aa6f20a`):
`countNegativePostable` counts strictly `< 0` bills and blocks via
`checkNegativeTotals` in `services/billing/pre-approval-checks.ts` (check name
still `positive_totals`); `countZeroTotalPostable` feeds the informational
`zero_total_bills` check and counts every zero bill, line-less or not. The
posting skip is unchanged (`ZERO_TOTAL_NOT_INVOICED`,
`services/billing/post-run.ts` ~l.320-341). The durable fix — a conditional
`ins_header` (`bill_run_processing.yml` ~l.1170) — is **still OPEN**.

---

## 12. 🟡 The zero-total predicates will misfire on a fully-discounted bill (PARTIALLY RESOLVED)

**Where:** `services/billing/post-run.ts` (`postAccount`'s zero-total skip) and
`db/repositories/billing/customer-bill.repository.ts`
(`countNegativePostable` / `countZeroTotalPostable`; formerly
`countNonPositivePostable`).

**Update (2026-10-12, verified against dev1 `614743a`): item 1 RESOLVED.** The
`EXISTS(lines)` predicate is gone; approval now blocks only on a strictly
negative bill, and a zero bill (with or without lines) is informational only
(`customer-bill.repository.ts` ~l.210-216, whose comment cites this section).
A fully-discounted account no longer wedges the run. **Items 2 and 3 remain
open** (the posting skip is still `subtotal == 0 AND total_amount == 0` with no
line check, so a fully-discounted account gets no INV and is indistinguishable
from an idle one), as does the RevOps decision below.

**Not a revenue-recognition issue — corrected 2026-09-17.** An earlier draft of
this entry claimed the skip would "suppress real revenue". That was wrong, and
the correction matters because it changes what the fix is for. A bill charged
100 and discounted 100 has a transaction price of **zero**; net IS the revenue.
Posting inserts the GL revenue line at `amount = bill.subtotal`, i.e. **net**, so
whether such a bill posts or not the P&L impact is identically `0.00`. Nor is the
gross-to-net record lost: `customer_bill_line` persists `gross_amount`,
`discount_amount`, `discount_amount_raw` and `net_amount` independently of
posting, so discount analytics survive a skip. **There is no accounting exposure
here.**

**Technical — what the real exposure is.** Both predicates key on a bill
totalling exactly zero, which today can only mean "no charge". Once discounting
lands it can also mean "fully discounted", and the two are then
indistinguishable:

1. **A fully-discounted account wedges the whole run at approval.**
   `countNonPositivePostable` is `(subtotal <= 0 OR total_amount <= 0) AND
EXISTS(lines)`. A discounted-to-zero bill HAS lines, so it is counted,
   `positive_totals` fails, and **no account in that run can be approved** until
   someone intervenes. This is the same operational jam as §11, re-armed for a
   legitimate account — and it is the more likely of the two to be hit.
2. **If unblocked, the customer gets no invoice.** `postAccount`'s skip is
   `subtotal == 0 AND total_amount == 0` with no line check, so the account
   settles `SKIPPED` / `ZERO_TOTAL_NOT_INVOICED` and no INV document is produced
   — for an account that had genuine billable activity. The customer never
   receives a document showing the charge and the discount that cancelled it,
   which is a contractual/transparency question for RevOps, not a ledger one.
3. **Operators cannot tell the two apart.** A 100%-discounted account and an
   account with nothing to bill both land as `SKIPPED` with the same reason code
   and both appear on the Uncharged tab.

**ELI5.** "This invoice totals zero" currently always means "there was nothing to
bill". After discounts exist it can also mean "we charged 100 and took 100 off".
The money is the same either way — zero — so nothing is misstated. The problem is
that the system treats the second case as if the customer were idle: it first
refuses to approve the entire run because of it, and if you force past that, it
quietly issues no invoice, so the customer never sees the discount they were
given.

**Interaction with §11 — important.** Fixing §11 does **not** fix this. A
discounted-to-zero bill has lines, so §11's fix (only create a header when there
ARE lines) correctly still creates it, and both predicates still misread it. What
§11's fix DOES do is remove the only legitimate reason those predicates exist:
with no line-less bills in the system, the `EXISTS(lines)` narrowing is redundant
and the posting skip's **only remaining reachable case is the harmful one**. So
the mitigations should be removed or re-keyed as part of the §11 fix, not left
behind.

**Recommendation.** When §11 is fixed, in the same change: drop the
`EXISTS(lines)` clause from `countNonPositivePostable`, and either remove
`postAccount`'s zero-total skip or re-key it to "the bill has no charge lines".
Add a test asserting a zero-net bill WITH lines still posts. Separately, RevOps
should decide whether a fully-discounted account should receive a zero-value
invoice — that is a product decision, not a defect, and it is the only part of
this entry that needs a business answer.

---

## 13. 🟡 The DB-gated test suite destroys a co-located dev stack (items 1 + 3 RESOLVED by bm40)

**Where:** `tests/db/billrun-db-roles.integration.test.ts`
(`beforeAll`/`afterAll`), `vitest.integration.config.ts`, `npm run test`.

**Technical.** Three separate hazards, all confirmed live on 2026-09-17:

1. **RESOLVED (bm40/TC58).** `afterAll` used to run
   `DROP DATABASE IF EXISTS "kestra" WITH (FORCE)` — outside `DATABASE_URL`,
   against the whole cluster. `FORCE` terminated every live connection first, so a
   running engine lost all Hikari connections at once (`SQLSTATE(08006)`), each
   queue poller logged `Fatal error while polling ... Initiating shutdown`, and
   the container exited 0 with **every deployed flow gone**. The teardown now
   resets only the `public` **schema** inside the `kestra` database
   (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`), never the database
   object, and never `FORCE` — a stray live connection now causes an error (or a
   lock wait), never a forced disconnect.
2. **OPEN. It rewrites cluster-level role passwords.** `ALTER ROLE app_runtime /
rating_runtime / billrun_runtime WITH PASSWORD 'bm14-test-only-pw'`. Roles are
   cluster-scoped, so the dev app then fails `28P01` and every flow DB task fails
   authentication. Restoring the password is not enough on its own — the app's
   connection pool holds the old credential until it is restarted. Out of bm40's
   scope (TC58 targeted the cross-cluster `DROP DATABASE`/`FORCE` and the
   skip-loudly bug only); the README recovery sequence still applies.
3. **RESOLVED (bm40/TC58).** The promised "skip loudly" never fired: each suite
   carried `describe.skipIf(!DATABASE_URL)`, but `db/client.ts` imports
   `lib/config.ts` at module load and throws `Invalid environment
   configuration.` first, so every DB-gated file **errored** instead of
   skipping. A new fail-closed preflight (`tests/integration-global-setup.ts`,
   wired as the DB-gated project's `globalSetup`) now runs BEFORE any test file
   — and so before that import — refusing loudly with a clear message when
   `DATABASE_URL` is unset, when `DESTRUCTIVE_DB_OK` isn't `"1"`, or when the
   target lacks the disposable sentinel (`tests/helpers/disposable-database.ts`
   — deliberately not a name/host match, which is spoofable).

Consequently `npm run test` with a dev `.env` exported, `DESTRUCTIVE_DB_OK` unset
and no sentinel marked now refuses outright rather than destroying the local
stack; item 2's password rewrite remains a residual risk once the preflight is
satisfied.

**ELI5.** Running the full test suite against your development database used to
wipe that database AND delete the workflow engine's own data — now it refuses to
run at all unless you've explicitly opted in and marked the target database safe
to destroy. It still changes the shared login passwords, so the app and the
engine need a restart afterwards.

**Recommendation (residual).** Point `DATABASE_URL` at a **separate Postgres
instance**, not merely a different database in the same cluster; or stop the
engine for the run and rebuild afterwards (README "Tests, typecheck and lint"
documents both, with the recovery sequence). A durable fix for item 2 — scoping
the role-password rewrite so it never touches the shared cluster-level
credential — remains open.

---

## 14. 🟡 No credit-note path — a negative-total bill fails loudly at posting

**Where:** `services/billing/post-run.ts`; plan §13 (out of scope).

**Update (2026-10-12, verified against dev1 `614743a`):** a negative bill no
longer reaches posting. It is now **blocked at approval** by `positive_totals`
(`checkNegativeTotals`, `services/billing/pre-approval-checks.ts` ~l.130-139)
with the remediation "A bill is never a negative amount — review Customers &
Bills.", so the opaque posting error below is no longer the operator's
experience. The credit-note gap itself is **still open**: there is still no way
to issue a credit for a negative position.

**Technical.** A negative `total_amount` is a credit position — money owed **to**
the customer — and has real economic substance. The zero-invoice skip (§11) is
therefore deliberately scoped to _exactly_ zero, never `<= 0`, with a
`[CRITICAL]` test on that edge: suppressing a negative would understate the
liability and silently deny the customer a credit. Nothing else handles it
either, so such a bill reaches posting and is rejected by
`document_line_amount_check` (`amount > 0`), parking the account with the same
opaque "unexpected error" message.

**ELI5.** If we ever owe a customer money instead of charging them, the system
can't issue that credit — it just fails with an unhelpful error.

**Recommendation.** Leave the skip narrow (never widen it to `<= 0`). When a
credit-note capability is scoped, give a negative total a **clear parked reason**
instead of the generic failure, so the operator sees what happened. Until then
this is correct-but-unfriendly behaviour, not a data-integrity risk.

---

## 15. 🟡 Invoice usage appendix (bm45) — two documented assumptions, not fixed here

**Where:** `bill_run_processing.yml`'s `aggregation` step (the appendix
snapshot, D1/D2/D4).

**D2 rating coupling (accepted, documented).** The appendix joins a claimed
`rating.udr_rated` row to its ratecard cell by **reconstructing** the
canonical key from the ratecard's own `mno_public_key`/
`commercial_unit_public_key`/`polygon_id` columns (sorted `k=v|…`,
`lower(btrim(...))`) and matching it against `ur.udr_key` — because
`udr_rated` carries no polygon column of its own, this is exactly the
canonical-cell shape rating's own matcher builds (`prp.py`). This **couples**
the bill run to three RAN_USAGE rating facts that are config-only/forbidden-
edit on the rating side: the feed role-column **names**
(`commercial_unit`/`mno_public_id`/`polygon_id`), the canonical **format**
(sorted `k=v|…`), and the **normalisation** (`strip().casefold()` tracked by
`btrim`+`lower()` — an ASCII-only assumption; a Unicode-only divergence is a
known edge, not expected for polygon ids). A durable decoupling — rating
itself stamping the matched `ratecard_ran_usage_lkp_id` onto `udr_rated` —
is recorded as a future cross-plan hardening, not built in this unit.

> **Superseded 2026-10-14.** rating now stores `udr_key` raw; the invoice reads the polygon from the `polygon_id=` segment of `udr_key` and State, District and the start date from `udr_resource` (billing plan D8, D31). The flow's appendix is no longer read (bm49) and is removed in billing slice 2.

**D4 ratecard-version residual (accepted, documented).** The appendix
resolves the **ACTIVE** version of the `productCardLookUp`-named card at
aggregation time — the same resolution rating uses — because `udr_rated`
carries no ratecard-version stamp, so true per-record pinning is not
possible without a rating change. If the card is **re-versioned between
rating and this bill run**, the appendix could read a newer version's
state/district than rating actually used when it rated the usage. Mitigated
only by sequencing (the capacity run follows rating closely) and by the
snapshot being taken once at aggregation and never re-read against a later
version (an already-aggregated bill's appendix is immutable even if the card
is re-versioned afterward — proven by
`tests/db/billrun-capacity-appendix.integration.test.ts`'s rerun-stability
case). The durable fix is the same D2 rating-side stamp above.

**ELI5.** The invoice's per-polygon breakdown gets its state/district labels
by rebuilding a lookup key from the rate card and matching it to the usage
record — a technique borrowed from how rating itself matches records, so a
future change to rating's key format or column names would need a matching
change here. Separately, if someone updates the rate card for a polygon
right after this month's usage was rated but before the bill was produced,
the invoice could show the rate card's newer state/district instead of the
one rating actually used — a narrow timing window, not expected to matter in
practice, and once an invoice's appendix is written it never silently
changes afterward even if the card changes later.

**Recommendation.** Both residuals are accepted for this phase (capacity
plan O-TC6). If rating ever stamps `ratecard_ran_usage_lkp_id` directly onto
`udr_rated`, revisit both: the appendix join becomes a plain FK lookup
(no key reconstruction, no coupling) and per-record version pinning becomes
exact.

**Update — bm48 (2026-10-08): D4 CLOSED for rows rated after bm48.** Rating
now freezes the matched ratecard cell's `state`/`district` onto
`rating.udr_rated` at INSERT (migration `0045`; captured in PRP from the
ACTIVE card it rated against). A card re-versioned after rating can no longer
change those labels (`tests/rating/rm23-udr-geo-frozen.integration.test.ts`).
Two things stay open until bm49: (1) the invoice still reads the bm45
aggregation-time snapshot — bm49 switches the usage section to the frozen
`udr_rated` columns, which is what removes the D4 window from the invoice;
(2) rows rated **before** bm48 carry `NULL` geo (no backfill) and render
under an "Unassigned region" group. The **D2 key-reconstruction coupling**
also stays for as long as the flow keeps writing the bm45 snapshot (it does
— Part 2 makes no `bill-run-*` flow change). It was stamping geo, not the lkp
row id, that rating adopted, so the FK-lookup option above was not taken.

**Update — bm49 (verified 2026-10-12 against dev1 `614743a`): D4 CLOSED for the
invoice.** The invoice usage annex now reads the frozen `udr_rated.state`/
`district` via `db/repositories/billing/rated-lines.repository.ts`
(`listBilledUsageForInvoice`; no ratecard query), with `NULL` geo grouped under
"Unassigned region". Residuals: rows rated **before** bm48 still carry `NULL`
geo (no backfill); the **D2 coupling** remains only for the flow's bm45
`_bm45_volume` snapshot, which the invoice no longer reads for geo.

---

## 16. 🟡 Model-2 can diverge from Model 1 on fractional multi-row usage (TC40/TC55, accepted)

**Where:** `bill_run_processing.yml`'s `verification` step (the Model-2
cross-derivation, bm43); `aggregation`'s per-band rounding (bm42).

**Technical.** The two models round at different points in the calculation.
Model 1 (the billed figure) is `rated_amount + topUp`, where `rated_amount =
SUM(udr_rated.udr_rated_price)` — each `udr_rated` row's price was already
rounded (2 dp, HALF_UP) **per PER_UNIT record** by rating, before the bill
run ever sums them; the top-up/band components are likewise rounded once
each as they're computed, and `gross`/`net` are *derived* from those
already-rounded parts, never re-rounded (Inv #34). Model 2 (verification's
independent cross-derivation, bm43 D3) instead sums the **raw** quantities
across all of an account's `udr_rated` rows first and rounds the aggregate
`max(Q, target) × baseRate` **once**, at the end. Because Model 1 accumulates
one rounding step per record and Model 2 takes exactly one rounding step
overall, their totals can disagree whenever usage is spread across multiple
fractional-quantity records — this is about how many individual records were
rounded, not about whether the **summed** `Q` happens to be a whole number;
with enough fractional-quantity rows the accumulated per-record rounding can
put Model 1 more than one cent away from Model 2 even though the aggregate
`Q` is an integer. This is TC40's accepted per-component rounding rule,
re-surfaced in verification as TC55's comparison caveat.

**Why deferred.** Fractional usage is not expected for this product's unit
types this phase (TC45's PER_UNIT rating works in whole units for the
capacity offerings shipped); the drift is theoretical for the anchors and
scenarios this phase ships. The durable fix — reconciling Model 1 and Model 2
at raw (unrounded) scale instead of at the rounded display scale — is
deferred, not a widened tolerance on the rounded comparison (which would
mask real rate mismatches instead of fixing the rounding-path mismatch).
`CAPACITY_RATE_MATCHING` (default ON) is the operational relief if a
fractional account ever trips the comparison: it raises
`CAPACITY_RATE_MISMATCH`, a HARD, account-level failure that settles the
account at `PROCESSING_FAILED` — the account never reaches the four-eyes
approval step on that run until it's resolved and rerun, while every sibling
account keeps processing. Set OFF, the same disagreement instead logs a WARN
and bills Model 1's number, never silently.

**ELI5.** Two different ways of calculating the same bill should give exactly
the same answer, and they usually do. One way rounds each individual usage
record as it's added up; the other adds all the raw usage first and rounds
only once at the end. If usage is split across several fractional records,
those two approaches can land more than a cent apart — even if the total
usage itself is a round number — because it's the per-record rounding, not
the total, that causes the drift. Not expected to happen with this product's
usage units; if it ever does, there's a switch (the rate-matching gate) that
either stops the affected account from billing until someone looks, or just
logs a warning and bills anyway, depending on how it's configured.

**Recommendation.** Accepted as-is (capacity plan TC40/TC55). If a fractional-
usage capacity offering is ever introduced, reconcile Model 1/Model 2 at raw
scale before rounding, rather than widening a tolerance on the rounded
comparison.

---

## 17. 🟡 O-TC7 — partial-period capacity billing is an open business decision

**Where:** scoping (account exclusion), ahead of `bill_run_processing.yml`;
not a code defect.

**Technical.** A partial-period account (mid-period start, cease or
suspension) is `EXCLUDED` at scoping before the flow runs (Inv #26,
unchanged by the Target Capacity Pricing update) — it bills neither recurring
nor usage for that period, capacity included, and resumes at the next full
cycle. For a capacity offering this means the commitment floor is simply
**not charged** for a partial period, which is a revenue question (should a
pro-rated floor apply, and how) that engineering has deliberately not
answered: whether and how to pro-rate a partial-period capacity commitment is
unresolved (capacity plan O-TC7), and no pro-ration method has been built or
chosen.

**Why deferred.** This is explicitly scoped as a **business** decision, not
an engineering deferral (`billmgmt-update-overview.md` _Out of scope_;
`billmgmt-ai-workflow-rules.md` Target Capacity §"Missing or ambiguous" item
1: "never build a pro-ration method without it"). No default was guessed.

**ELI5.** If a customer with a committed-usage plan only has the service for
part of a month, right now they simply aren't billed for that month at all
for that plan — not a fraction of the commitment, not the full commitment,
nothing. Whether that's the right outcome, or whether they should pay a
pro-rated share of their commitment, is a business policy question nobody
has answered yet, so engineering hasn't built anything for it.

**Recommendation.** Stays open until the business rules on partial-period
capacity billing. When it is resolved, it is a new build unit (a pro-ration
method is explicitly out of scope for this phase) — not a fix folded into an
existing unit.

## 18. 🟡 Bills posted before bm54 render with the default template and no company profile (bm53, by design)

**Where:** `services/billing/invoice-template/resolve-template.ts` (D1).

**Technical.** A final render, a retry-render or a posted-bill preview reads
only the bill's stamps (`ref_bill_template_version_id`,
`ref_invoice_profile_version`, `ref_csv_template_version_id`), never the
current ACTIVE versions (Inv #42). bm54 adds the stamping. Every bill posted
before bm54 therefore has `NULL` stamps and resolves to the immutable default
(generated BTV00000002, CSV BTV00000003) with **no profile**. Its PDF has no
issuer, logo or bank block (G15 A). This holds even after an admin activates
a profile, because a later activation must never change a posted invoice. The
result is deterministic: nothing can be activated before bm58, so the default
is exactly what was ACTIVE when those bills posted.

**Related residual (accepted, Inv #45).** The compiled-template memo in
`load.ts` is per replica. If a stored template is tampered with **after** a
replica has verified and cached it, that replica keeps rendering the verified
bytes. A cold replica (restart, new revision) re-verifies and parks the
account with `TEMPLATE_CHECKSUM_MISMATCH`. The memo never holds unverified
bytes.

**ELI5.** Invoices posted before template versioning existed have no record
of which template they used. They always reprint with the original built-in
template and without the company letterhead, even if a letterhead is set up
later. Reprinting an old invoice never changes what it looks like.

**Recommendation.** Nothing to fix; this is the intended behaviour. It only
needs revisiting if the business wants the letterhead on reprints of
pre-bm54 invoices. That would be a deliberate re-stamp decision, and the
finalization guard (`0033`) forbids it today.

**bm54 update (2026-10-09).** Bills posted from bm54 on carry all four stamps.
Bills posted before bm54 are **not back-stamped**: `0033` refuses the
`UPDATE`, so they keep `NULL` stamps for good and keep rendering as described
above.

## 19. 🟢 RESOLVED (bm67) — An activation during a run can give that run's accounts different template versions (bm54, by design)

> **Closed 2026-10-16 by Invoice Template Phase 3 (bm65–bm67).** Each BAN's
> template family and versions are captured onto its `bill_run_account` row at
> run start (bm65); the draft renders those stamps (bm66) and posting copies
> them onto the bill (bm67) — `resolveVersionsForPosting` is deleted. A version
> activated mid-run never reaches that run; only a rerun re-captures, and only
> for the rerun BANs (Inv #51–#53). Proven by guardrail 46 (capture → activate
> → post) and guardrail 57. The text below is the original record.

**Where:** `services/billing/invoice-template/resolve-template.ts`
(`resolveVersionsForPosting`), `services/billing/post-run.ts` (`postAccount`).

**Technical.** Each account posts in its own transaction (Inv #6), and each
transaction resolves the current generated, profile and CSV versions without
locking the catalog rows (bm54 D1). If an admin activates a new version while
a run is posting, accounts posted before the activation are stamped with the
old version and the rest with the new one. Each bill records exactly the
versions it was posted under, and that record is what pinning promises
(Inv #41/#42). A run-wide freeze would need a new `bill_run` column, which is
out of scope.

**ELI5.** If someone changes the invoice design while a batch of invoices is
going out, some invoices in that batch use the old design and some use the
new one. Each invoice remembers which design it used, so a reprint always
matches the original.

**Recommendation.** Accept for now. Activation pages arrive with bm58/bm61. If
one design per run becomes a requirement, add a run-level version snapshot
taken at `APPROVED → POSTING` and resolve from it in `postAccount`. That needs
a migration and a separate unit.

## 20. 🟠 Layout v1's `shell.hbs` has no usage-annex CSS, so anything generated from it renders the annex unstyled (found bm55, RESOLVED bm70 2026-10-16)

**Resolved (bm70, 2026-10-16):** the fresh-DB round rewrote layout v1 in place
(D41). The rewritten `shell.hbs` carries the bm49 annex CSS, and the seeded
generated v1 is now produced by the generator from that layout
(`scripts/invoice-templates/regenerate-generated.ts`), so the two render a
byte-identical whole document; `generate-parity.test.ts`'s former `it.fails`
case is now a plain passing test. The text below is the original finding.

**Where:** `db/seeds/invoice-templates/INVTPL-STD-A4/v1/shell.hbs` (layout
BTV00000001, seeded immutably by bm50) and the hand-written generated v1
`db/seeds/invoice-templates/generated/INVOICE/v1/invoice.hbs` (BTV00000002).

**Technical.** bm49 added the usage-annex CSS (`.annex`, `table.usage …`,
about 25 lines) to the **hand-written generated** v1 only. The layout's
`shell.hbs` was frozen without it, and its CSS comments also differ. The bm55
generator builds its `<head>` from the layout shell. So
`generate(layout v1, all-on)` differs from the stored v1 **only inside
`<style>`**: the `<body>` renders byte-identical
(`tests/services/billing/invoice-template/generate-parity.test.ts`; its
whole-document case is an `it.fails` that records this gap). In practice:

- **bm55 live preview** of the sample bill, or of an unposted bill, renders
  the usage annex without its table styling. Posted-bill previews and every
  real invoice render from the stored v1 and are unaffected.
- **bm58 activation** would store a generated v2 whose annex is unstyled on
  real PDFs.

**Related.** The seeded generated v1 `structure.json` lists only the three
optional sections, while the DB row and the generator's canonical
`structure.json` list all nine. Nothing reads the v1 file (`loadGenerated`
uses the row), and the download serves it exactly as stored.

**ELI5.** The master design file is missing the styling for the usage
table. The invoice in use today has that styling, because it was written by
hand. Any new invoice design built from the master file would show the usage
table plain.

**Recommendation.** Before bm58 ships, seed **layout v2** (a new `v2/`
directory and a new version row, Inv #44). Its `shell.hbs` should carry the
annex CSS exactly as the hand-written v1 has it, and its `structure.json`
convention should be settled with it. Then flip the parity test's `it.fails`
to a normal `it` against v2. Do not edit v1, which is immutable.

**Decision (2026-10-10, bm58 review).** bm58 activation is now built and generates from layout
v1, so the gap is live in code but not yet in production. Owner decision: **accept for now and
track as a release gate**, with no bm58 code change and no activation guard. Seed layout v2 (as
its own unit: a new `v2/` directory, migration, checksums, Inv #44) before any production
activation; until then do not activate a template in production.

## 21. 🔴 Failing tests found by the full runs after bm56 (2026-10-10; all fixed: 21c2 to 21c4 by bm42a, 21e by product unit pm46a)

The full unit suite and the full integration project (against the throwaway
`ebill-test` Postgres on port 5434) were run after bm56: **unit 12 failures,
integration 48 failures in 13 files**. They were then triaged, and the original
guesses in this entry were corrected. The honest result is that the failures are
**two different kinds of problem**: tests or fixtures that had drifted from correct
code (fixed), and **real defects in delivered code that the tests were right to
flag** (open). The DB-backed suites had never been run in this environment, so the
defects shipped unnoticed.

### Fixed (tests or fixtures that had drifted; the code was right)

| #   | Was                                                                                                  | Fix                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21a | 12 unit + 3 integration tests expected 15 permissions; `invoice_settings` (bm50) makes 16            | Added the missing entry and updated the counts in five test files.                                                                                          |
| 21b | `migration.integration` found the destructive-DB preflight's marker table in `public`                | The test ignores `_test_disposable_sentinel`.                                                                                                               |
| 21d | `billrun-db-roles` 17g updated `product_offering_price.amount`, which PC14 removed                   | It updates `name`, a column that exists, so Postgres reaches the privilege check the test is about.                                                         |
| 21f | `rm08` expected the `subscriber_ref_column` flow variable, which rm21 §6 retired on purpose          | The static check now asserts the variable is gone and the literal `--subscriber-ref-column product_inventory_id` is passed. (A rating-domain test.)         |
| 21c1 | The `extract-flow-sql` harness read `:'var'` **inside SQL comments** as a variable named `var` (38 tests failed before reaching the database) | `bindPsqlVars` now skips `--` comments, single-quoted strings and dollar-quoted bodies, as real psql does. Six new self-tests.                        |
| 21c5 | Appendix helper built a capacity commitment of **0**, which the product schema now rejects (`> 0`), in the rerun-stability and 10,001-row over-limit tests | Both use `MIN_COMMITMENT = 1`. The tests were kept: removing them would drop the CRITICAL TC57 guard test and the D4 rerun-stability test. Usage is far above 1, so the floor is never engaged. |
| 21c6 | A recurring-suite fixture defined a two-band motivation, which the flow refuses by design (`capacity_max_bands = 1`, TC52) | The fixture uses one band. Every assertion in that test (zero-usage floor, no discount) still holds.                                                  |
| 21c7 | The appendix test looked up the card-missing polygon as `POLY-UNMAPPED`, but the flow recovers its id from the canonical `udr_key`, which rating lower-cases | The test looks it up as `poly-unmapped` (the original case is unrecoverable; mapped polygons carry the ratecard casing). Found when bm42a let the test reach that assertion. |

> **Superseded 2026-10-14.** rating now stores `udr_key` raw; the invoice reads the polygon from the `polygon_id=` segment of `udr_key` and State, District and the start date from `udr_resource` (billing plan D8, D31). The flow's appendix is no longer read (bm49) and is removed in billing slice 2.

### Real defects in delivered code (21c2 to 21c4 FIXED by bm42a; 21e FIXED by pm46a)

| #    | Defect                                                                                                                                                                                                                       | Evidence and effect                                                                                                                                                                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 21c2 | **FIXED (bm42a D1).** **CRITICAL.** `bill_run_processing.yml` line 1007 (the `capacity_band_json` CTE, bm42) calls `row_number() OVER (…)` **inside `jsonb_agg(…)`**. Postgres forbids a window function inside an aggregate (`aggregate function calls cannot contain window function calls`). | The aggregation statement can never execute, so as written **bill-run aggregation fails for every account**, not only capacity accounts. 31 tests fail on it. The second `jsonb_agg` (line 1052) is fine. Proposed fix: compute the band number in the `capacity_band_charges` CTE and have `jsonb_agg` read it; the output is identical. With that applied **temporarily and reverted**, the eight affected suites went from 34 failures to 3 (37 of 40 pass). |
| 21c3 | **FIXED (bm42a D2, as text).** The flow writes the appendix rows' `volume` and `amount`, and the capacity `calc` total's `gross`/`discount`/`net`, as **JSON numbers**. The declared type (`InvoiceUsageAppendixRow`) and the tests say **strings**, and the module's rule is money as `string` end to end. | JSON numbers lose the trailing scale when parsed (`40000.00` becomes `40000`). 2 of the 3 remaining failures. This is a flow-side contract mismatch, not a stale test, so the tests were **not** loosened. Fix is in the flow (emit `::text`), with 21c2.                                                                                                                                                  |
| 21c4 | **FIXED (bm42a D3).** bm43 changed the plain (non-capacity) USAGE replay from `gross_amount` to `rated_amount`, and its spec calls that "behaviour-preserving". It is not: a plain line whose `gross_amount`/`net_amount` were altered while `rated_amount` stayed intact is **no longer caught** by verification. | bm30's CRITICAL test ("a mis-aggregated USAGE line is caught HARD") now fails because verification returns `DONE`. A regression in tamper detection. Fix is a flow change: for non-capacity lines also require `gross_amount = rated_amount` (the invariant the bm43 spec states).                                                                                                                      |
| 21e  | **FIXED by product unit pm46a (2026-10-10; `context/product-management/specs/pm46a-flat-fee-lane-key.md`, PM-ISS-003).** The lane key now includes `price_component ->> 'priceType'` (migration `0049`, unique index `product_offering_price_lane_start_unique`), the repository window and the bill-run resolver use it, and `RECURRING_PRICE_UNSUPPORTED` is retired. The 4 tests pass unchanged. Original finding: `ordering-read` (4 tests): a recurring and a one-time `flat_fee` share the lane `(component_type, unit_of_measure)`, so the later-starting one-time Activation Fee ends the recurring row and the order detail shows **no recurring line**. | **Not PC14, and not a test problem.** This is the gap pm46 flagged itself ("Known gap, flagged for follow-up… needs its own gate-C-authorized follow-up unit"). The correct lane key adds `price_component ->> 'priceType'`. It touches the product constraint, the repository's `lead()` window and the billing resolver, so it is cross-domain and gated. The same partition is used by the billing recurring resolver. |

**Also seen, not failures:** `route-manifest`, `customer-module-boundaries` and
`ratecard-parse-csv` time out under full-suite load and pass alone. Thirteen tests are
skipped because they need `python3`, which this host lacks.

**ELI5.** Most of the red tests were stale test code and are now fixed. But once the
test helper stopped tripping over a comment, the tests reached the real SQL and found
that a delivered flow statement is invalid (it can never run), that some amounts are
written in the wrong form, and that one safety check was weakened. Those are bugs in
the product, not in the tests.

**Result (bm42a, 2026-10-10).** The three flow defects were fixed together in one flow-only unit
(`bm42a`, spec `specs/bm42a-flow-aggregation-verification-fixes.md`): the band number is computed
before the JSON aggregation (21c2), money and decimal quantities in the calc trace are JSON text
at canonical scale (21c3), and ordinary USAGE lines are again checked for `gross = rated_amount`
and `net = gross - discount` (21c4). Full integration project: **48 failures down to 4**, all in
`ordering-read` (21e); full unit suite: **0 failures** (4077 passed). 21e was then fixed by the
product unit pm46a (gated by Khek 2026-10-10), which also changed the bill-run recurring resolver and
retired `RECURRING_PRICE_UNSUPPORTED`. **Result (pm46a): full integration project 1165 passed / 0
failed; full unit suite 4077 passed / 0 failed.** Every §21 item is closed.

## 22. 🟠 Open items from the code review of efaff82..HEAD (2026-10-10; OPEN, to be fixed later)

`/code-review xhigh` of `efaff82..HEAD` plus the uncommitted batch raised 15
findings. Fixed in that batch: the plain-USAGE discount/net tamper gap, the
NULL-dropping mismatch message, the case-sensitive blob-guard key, the blob
guard for every integration suite (globalSetup), the stale flow README /
template / `rp.py` / product rule-6 docs, the shared activation probe and its
variants, the draft-conflict message constant and the harness's quadratic
scan. Still open:

| #    | Item | Effect | Owner / next step |
| ---- | ---- | ------ | ----------------- |
| 22a  | **`_bm45_volume` does not scope by offering** (`bill_run_processing.yml`, aggregation step 0h). It picks claimed rows by `unit` and `udr_type` only; `capacity_volume` (step 1) also joins `product_inventory` and requires `pi.product_offering_id = c.offering_id`, and the 0h comment claims "same scoping". Confirmed by reading the SQL; not yet reproduced on a database. | An account with a capacity offering and another offering with the same unit and udr_type gets the other offering's usage in the capacity appendix (volume and amount), so the appendix no longer sums to the capacity line's `rated_amount` and the rows count toward `CAPACITY_APPENDIX_OVER_LIMIT`; two such capacity offerings list each other's polygons. Predates this range (bm45). | A billing flow-fix unit with its own spec (bm42a pattern), with a DB test that reproduces it first. |
| 22b  | **One-time flat fees are never billed and never reported.** | See `billmgmt-design-review.md` **DR-05** (decided: option a, report without failing). | DR-05's unit. |
| 22c  | **A stored draft that fails the schema cannot be recovered from the UI** (`activate-template.ts` returns `VALIDATION_ERROR` → "The request was not valid. Reload and try again."; Save draft fails the strict schema too). | Only after a schema change or a hand edit of a stored draft; the user has no way out but a DB fix. | A bm58 follow-up: decide the recovery (discard-draft action, or a dedicated "stored draft is invalid" message with a reset). UX decision needed. |
| 22d  | **Activate DRAFT_CONFLICT shows the message twice**: a toast with Reload and the dialog's inline alert. (The save path's duplicated literal was fixed: both now use `ACTIVATE_MESSAGES.DRAFT_CONFLICT`.) | Cosmetic; two identical messages at once. | Fold into 22c's follow-up (UX decision: give the dialog its own Reload and drop the toast, or the reverse). |
| 22e  | **Three copies of the SQL scanner** in the test harness: `splitSqlStatements` and `bindPsqlVars` (`tests/db/helpers/extract-flow-sql.ts`) and the guardrail's `blankCommentsAndStrings` (no dollar-quote handling). | Teaching one about block comments, `E''` strings or quoted identifiers and missing another makes splitting, binding and the guardrail disagree. Test-only; no runtime effect. | A test-harness refactor: one tokenizer with an on-plain-text callback. Low priority. |
| 22f  | **Integration role-grant suites depend on file order** (observed 2026-10-10 during bm60). `product-family-guards` and `product-ratecard-schema` run `CREATE ROLE app_runtime NOLOGIN` when the role is missing; `bootstrap-db-roles.sql` creates it `WITH LOGIN` only if missing and never upgrades an existing role. Roles are cluster-wide and survive the per-file schema drops, so on a fresh test cluster whichever file runs first decides. When a product suite wins, 12 tests in `billrun-db-roles` and `rating/grants` fail with `role "app_runtime" is not permitted to log in`, and keep failing until the cluster is recreated. | Spurious red full integration runs. Test-only; no runtime effect (real environments run the bootstrap). Both suites pass on a fresh cluster (78/78). | Small test fix: create the role `WITH LOGIN` in the two product suites, or have the grant suites `ALTER ROLE app_runtime LOGIN` before connecting. Not fixed in bm60 (outside its boundary). |

The product-side altitude item (one SQL function for the price lane key) is
tracked as `prodmgmt-issues-tracker.md` PM-ISS-004 (RESOLVED 2026-10-10 by product guardrail 41).

## 22g. 🟡 `ratecard` role grants are never seeded (observed bm50, not fixed)

_(Numbered 22g on 2026-10-12; it was previously an unnumbered section between §22
and §23.)_

The `ratecard` permission row is created by migration `0043_ratecard_permission.sql`
(whose header says "role grants are applied by the seed"), but **no seed grants
it** — `db/seeds/billing.ts` grants only the `billrun_*` and (from bm50)
`invoice_settings` permissions, and no other seed references `ratecard`. So on a
fresh database the `ratecard` permission exists with zero role grants, and a
user can reach the Rate Card page only if an admin assigns it by hand.

**Observed while implementing bm50** (which used `0043` as the permission-row
precedent and, unlike `ratecard`, actually wired its `invoice_settings` grants
into `db/seeds/billing.ts`). **Not fixed here** — the bm50 spec explicitly says
to raise this as a separate known-issue, not to fold a `ratecard` grant fix into
the invoice-template unit.

**Recommendation.** A small follow-up on the rate-card side: add `ratecard`
(ADMIN/MANAGER EDIT, USER READ, per its own `0043` header intent) to the
appropriate seed's `grant()` calls, idempotently, the same way bm50 did for
`invoice_settings`.

## 23. 🟡 Invoice Template update — residuals carried past the ship gate (bm63, 2026-10-11)

The bm63 ship gate signed off bm47–bm62 (overview success criteria 1–12 shown by
`tests/e2e/invoice-template-journey.integration.test.ts` and
`tests/e2e/invoice-settings-admin.e2e.integration.test.ts`). These residuals
stay, each accepted or owned elsewhere:

| #   | Residual | Effect | Owner / next step |
| --- | -------- | ------ | ----------------- |
| 23a | **Bills posted before bm54 are unstamped** (§18). | They render with the immutable default and no company profile. | By design (Inv #42). |
| 23b | **A mid-run activation splits a run's versions** (§19). | Each bill records what it was posted under. | ~~By design.~~ **Resolved (bm67):** the run's captured stamps freeze its versions. |
| 23c | **`ratecard` role grants are never seeded** (section above). | The Rate Card page needs a hand-assigned grant. | Rate-card follow-up. |
| 23d | **Orphan template/logo blobs are tolerated.** A failed activation or upload transaction leaves its write-once, content-addressed blob behind (code-standards Part 2 General rule 10, data rule 7). | Storage only: an identical retry reuses it; nothing references it. | By design; no retention job in v1 (G10). |
| 23e | **RESOLVED (bm70, 2026-10-16).** **Layout v1 ships placeholder `@font-face` sources** (G8 decided: IBM Plex embedded). The rewritten v1 embeds IBM Plex Sans 400/600 and Mono 400 as base64 woff2 (the official `@ibm/plex-sans` 1.1.0 / `@ibm/plex-mono` 2.5.0 Latin-1 files, kept under `fonts/`). | Rendered invoices fall back to a system font; no font is ever fetched. | The layout v2 unit (with §20's annex CSS). |
| 23f | **"Page X of Y" on every page is proven structurally.** The journey asserts ≥ 3 PDF pages, `displayHeaderFooter` and the footer's `pageNumber`/`totalPages` spans (Chromium fills them per page); it does not extract text from each PDF page (no PDF parser dependency). | None known. | Accepted at bm63. |
| 23g | **The server's empty-change-note message is not reachable from the UI.** The activate dialog keeps Confirm disabled for an empty or whitespace note (React ignores clicks on a disabled button), so `CHANGE_NOTE_REQUIRED` is proven at the action layer. | None: the client and server rules agree. | Accepted at bm63. |
| 23h | **bm47 test follow-ups not built:** the PDF-text-layer half of guardrail 50 (escaping is proven in the HTML and in the browser preview), a dedicated handlebars build-boundary lint rule (the `components`→`services` deny already blocks it), `tests/db/invoice-render-input.integration.test.ts` (its reads run inside the journey and the usage-annex suite), and the `billrun-capacity-appendix` premise update. | Coverage gaps only. | A test-only follow-up. |
| 23i | ~~**The e2e server inherited `.env` for keys the test did not set.**~~ **Fixed 2026-10-11 (review):** the server is spawned with `__NEXT_PROCESSED_ENV=true`, so Next skips every `.env*` file and sees the test environment only; the suite is also opt-in (`npm run test:e2e:invoice-settings`, which builds first). | — | Closed. |
| 23j | **The invoice CSV reads the customer's identity live.** Charge lines and amounts are frozen at posting, but `customer_name`/`customer_tin` come from the current `customer.organization` row on every download (as the PDF render does), so a CSV downloaded after a customer rename differs from the stored PDF. | A re-downloaded CSV can show the new name/TIN. | **Accepted by the owner (2026-10-11)**; revisit with a buyer-identity snapshot at posting if needed. |
| 23k | ~~**Layout v1's HTML missed three accessibility basics**~~ (SonarCloud, PR #156: no `lang`, no `<title>`, no `<th>` on the Summary of charges and Tax summary tables). **Fixed 2026-10-11 in v1 itself (owner decision, option A, while still at PR stage):** `lang="en"`, a `<title>` ("Tax invoice INV…" / "Pro-forma invoice"), and visually hidden `<thead>` headers (`.vh`), so the printed design is unchanged. Layout v1 and generated v1 were re-indexed (`checksums.json`) and **migration `0046` was edited in place** (the two checksum literals). **Every database and blob store that ran `0046` before this change must be reset** (see 23l). From this commit v1 is final and immutable (Inv #44). | — | Closed. |
| 23l | **Environments seeded before the v1 accessibility fix hold the old v1 bytes and checksums.** `0046` was edited in place (23k), so a database that already applied it keeps the old `checksum` on `BTV00000001`/`BTV00000002`, and its blob store keeps the old write-once v1 files. Renders with the default then fail `TEMPLATE_CHECKSUM_MISMATCH`; re-seeding fails `BLOB_ALREADY_EXISTS`. | Local dev and the Azure dev environment, until reset. | Reset each: drop and recreate the database (or its volume), delete the `invoice-templates/layouts/INVTPL-STD-A4/v1/` and `invoice-templates/generated/INVOICE/v1/` blobs, then `npm run db:setup`. Throwaway test stacks are unaffected (fresh each run). |
| 23m | **RESOLVED for the amount due (bm70, 2026-10-16):** the rewritten v1 styles `.grand-total` at 14pt/18pt 600 with tabular-nums; the `footer.hbs` inline Arial remains (the footer is unchanged in bm70). **The amount due prints at body size** (found 2026-10-12, verified against dev1 `614743a`). `db/seeds/invoice-templates/INVTPL-STD-A4/v1/partials/amountDue.hbs` renders `<div class="grand-total">`, but v1 `shell.hbs` (~l.104) only styles `tr.grand-total td` (600 weight, 14pt/18pt), so the figure renders at the 9pt body size with no `tabular-nums`. Also: v1's `footer.hbs` uses inline `font-family: Arial` at 7.5px, independent of the shell fonts (the placeholder `@font-face` gap is 23e). | The most important number on the invoice is not emphasised. Cosmetic; amounts are correct. | The layout v2 unit (with §20 and 23e): v1 is immutable and its checksums are pinned in `0046`, so the fix is a v2 shell/partial change (e.g. `.grand-total` selector without the `tr … td` qualifier, plus `tabular-nums`). |
| 23n | **Guardrails 43 and 49 have no dedicated tests** (found 2026-10-12, verified against dev1 `614743a`). No test is tagged guardrail 43 (binder reconciliation: it is shown only on the `ci` seed by journey step 2, and no test asserts `renderErrorCode`) or 49 (manifest parity: only partial coverage in `tests/db/invoice-template-catalog.integration.test.ts` ~l.123 and `tests/services/billing/invoice-template/generate.test.ts`). So bm63's "Guardrails **43–56** all present and green, each in the file its unit created" is not fully true. | Coverage gap; a regression in reconciliation error reporting or manifest parity could pass CI. | Fold into 23h's test-only follow-up. |
| 23o | **The draft invoice preview never returns 422** (found 2026-10-12, verified against dev1 `614743a`). `app/(app)/billing/bill-runs/[runId]/draft-invoice/[banId]/route.ts` (~l.90-97) maps `DraftInvoiceNotFoundError` to 404 and everything else to 500. bm47 D10 / bm49 D3 specify **422** for `INVOICE_RECONCILIATION_FAILED` and `INVOICE_USAGE_OVER_LIMIT`. | The operator sees the generic "Could not render the draft invoice." instead of the reason, so a reconciliation or over-limit failure cannot be told apart from an outage. | A small billing fix: map the typed `InvoiceRenderError` codes to 422 with a specific message in the route and `invoice-preview-modal.tsx`. |
| 23p | **The USAGE `ChargeSourceBadge` uses the Info colour family** (found 2026-10-12, verified against dev1 `614743a`). `components/billing/charge-source-badge.tsx` (~l.21-22) styles USAGE with `--color-info-50/700`, but `billmgmt-ui-context.md` §6 reserves info for status and specifies Cyan for the USAGE category. | Low-severity UI conformance gap: a category badge reads as a status. | OPEN. Switch USAGE to the Cyan tokens. |
| 23q | **`InfoBadge` in the Uncharged table has no icon** (found 2026-10-12, verified against dev1 `614743a`). `components/billing/uncharged-table.tsx` (`InfoBadge`, ~l.47-53; labels such as "Not used"/"Orphan") renders colour + label only, breaking the ui-context rule that colour always pairs with an icon and a label. | Low-severity UI conformance and accessibility gap. | OPEN. Add an icon to `InfoBadge`. |
| 23r | **"Use the current app logo" import (bm60 D8) rejects the shipped logo files** (found 2026-10-12, verified against dev1 `614743a`). `importAppLogo` (`services/billing/invoice-profile/upload-logo.ts` ~l.233-236) reads `getBrandingLogo()?.src`, falling back to `/brand/invoice-logo-default.svg`. Both that file and `public/brand/logo.svg` (the default `app_logo_path`) declare `width="918.000000pt" height="612.000000pt"` and start with `<!DOCTYPE svg …>`. `svgDimensions` (`image-dimensions.ts` ~l.192-210) refuses any unit other than unitless/`px`, so check 3 fails with `dimensions` ("SVG width/height must be unitless or px"); the `<!doctype` ban in `sanitize-logo.ts` (~l.52) would refuse it next anyway. `tests/actions/billing/invoice-settings/upload-logo.action.test.ts` mocks the service, so no test exercises the real files. | With default branding the import button always fails; an operator must upload a logo file by hand. | OPEN. Either ship a sanitizer-clean default SVG (unitless/px `width`/`height`, no DOCTYPE) or normalise `pt` and strip the DOCTYPE on the import path only; add a test that imports the real shipped file. |

## 24. 🟢 RESOLVED — Invoice Template Phase 3 code-review items (bm65–bm67 reviews, 2026-10-16)

Both code reviews (xhigh on bm65, max on bm65–bm67) are closed. Owner decisions:
a blocking approval gate (D58a), `0051` edited in place, both UI fixes, and —
after first deferring it — the skip audit row. Each item below was first
recorded as deferred and is now fixed:

- **24a. 🟢 A posting skip writes an AUDIT_LOG row.** New event
  `BILL_RUN_ACCOUNT_SKIPPED` (classified "Change"), written in the posting
  transaction by `skipAccount` for both the zero-total and the D58 template skip
  (`afterData`: banId, status, code, customerBillId, and the family for D58).
- **24b. 🟢 Capture is pruned to the run's partition.**
  `captureTemplateStamps(tx, billRunId, banIds, periodPartition)`; the UPDATE
  filters `period_partition`. (`readStamps` is a one-row read in a short
  read-only transaction and is left unpruned.)
- **24c. 🟢 Generated-version reads are family-scoped.** `findActive`,
  `findDefault`, `findDraft`, `retireActive` and `listForKind` take an optional
  `familyId`; save-draft, the Invoice Settings page and activation's draft read
  use the Standard family, and activation retires only within the draft's own
  family. `lockKind`/version numbering stay per kind (`btv_version_uq`). The
  Customer Management label reader is unchanged (D46).
- **24d. 🟢 A retired or missing family is not usable.**
  `resolveGeneratedForFamily` returns `null` for it, so capture stamps a NULL
  version (blocked at approval, D58a) and `preview-family` throws.
- **24e. 🟢 Capture is never silent.** Every BAN gets a row: a missing default
  family, or a BAN reference to a non-generated version, yields a NULL family
  and version (General rule 3: capture never fails the trigger), which the
  approval gate then stops.
- **24f. 🟢 `template_captured_at = statement_timestamp()`** — when the capture
  UPDATE ran, after the catalog read, not the transaction start.
- **24g. 🟢 The draft route's 422 goes through `toInvoiceRenderResponse`**
  (`lib/http.ts`, next to `toHttpResponse`). The route's other bodies
  (401/403/404/429/500) are bm18's and unchanged.
- **24h. 🟢 The draft preview modal's error text is Danger `-fg`**
  (`--color-danger-700`), per UI context §10d.
- **24i. 🟢 Cleanups:** capture reads CSV/profile once per run
  (`resolveSharedCurrentVersions`); the duplicate `*InFamily` finders are gone
  (the family filter is on `findActive`/`findDefault`). The resolver's live
  exports are `resolveCurrentVersionsForFamily` (preview),
  `resolveGeneratedForFamily` and `resolveSharedCurrentVersions` (capture);
  guardrail 57 covers all three.

Kept as specified: the audit `templateStamps` stays one entry per BAN (D35; the
review found it negligible at today's run sizes).
