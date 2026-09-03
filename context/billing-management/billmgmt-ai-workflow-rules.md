# Billing Management (Bill Run) — AI Workflow Rules (Module Supplement)

This document supplements `context/ai-workflow-rules.md` (binding for all modules — read it first and obey it in full); it changes nothing there and adds only the Bill Run deltas. **Delta for this module:** you are building a **greenfield, not-yet-implemented** module against a **stub rating engine** — so (a) build every unit in dependency order from the schema up, never against a live rating engine you must not create; (b) treat the module's 15 **Module Invariants** (`billmgmt-architecture.md` §6) as permanent, cross-unit rules that never expire; (c) honour a **second mutation surface** — the machine-to-machine ingest — with its own non-session auth rules; and (d) coordinate the Accounts-side additive changes as an explicitly authorized cross-module unit. Where this doc appears to weaken the general rules or the Invariants, stop and treat it as a bug.

**Companion docs (authoritative — do not restate or contradict):**

- `billmgmt-project-overview.md` — product spec: goals, core user flow, features, in/out of scope, 14 success criteria.
- `billmgmt-architecture.md` — technical design: stack additions, folder ownership, storage model, auth/ownership, background model, **15 Module Invariants (§6)**, permission model (§4).
- `billmgmt-code-standards.md` — module conventions: domain unions (§2), M2M route rules (§5), data/storage rules (§6), file tree (§7), **permission map (§8)**, guardrail tests (§9).
- `_newmodule-billing-billrun-plan.md` — the full functional design and data model, and `_newmodule-billrun-rating-workflow-plan.md` — the workflow/rating seam. Cite these for design questions.

**Precedence** (general doc): architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## 1. Operating Approach — Module Specifics

1. **Build spec-driven and bottom-up.** Before writing any unit, name the authorizing section (an overview feature, an architecture §-row/Invariant, a code-standards rule). No section, no mandate — stop and ask (general §4). Build in dependency order: schema/migration → repository → service → action/handler + guard → page/component → tests.
2. **Do not build the rating engine.** `rating.udr_rated`/`rating.udr_exception` are a **stub** you build against, not something you implement. In v1 the collection/claim stage auto-completes and the deployment runs in stub-data mode. Any unit that starts computing charge amounts is out of bounds — stop.
3. **The bill run rates nothing; it claims.** Every unit that reads charges reads already-rated amounts from `rating.udr_rated` and sums them in SQL. Never add a charge-derivation function (Inv. #1).
4. **Land the schema before the behavior.** Unit 1 is the migration (plus its accompanying seed) before any behavior: the **migration** owns the six `billing` tables, the `partition_management` registration rows, and the three `billrun_*` `PERMISSIONS` rows; the **Billing Viewer** role and its grants are created by the **seed** (`db/seeds/billing.ts`), never by the migration — all verified in isolation before any repository depends on it.
5. **Treat these as permanent, cross-unit rules that never expire** (any unit that violates one is a review-blocking defect, on sight):
   - The **only** `rating.*` write is the claim marker (`ref_bill_run_id` + `attempt`) on `rating.udr_rated`; it lives in exactly one file, `db/repositories/billing/rating-claim.ts` (Inv. #2).
   - There is **no billing-side charge table**, ever; `charge_checksum` + `posted_attempt` are the only anchor (Inv. #3).
   - A `customer_bill` with `ref_inv_document_id` set is never updated, deleted, or invalidated (Inv. #4, general Inv. #18).
   - Posting is **per-account, one transaction each**; there is no whole-run posting transaction (Inv. #6).
   - The final-attempt trigger actor can never approve/post the run — checked in the service layer (Inv. #8).
   - `STALLED` is never persisted; `period_partition` is fixed per run; run status is recomputed under `FOR UPDATE`, never an incremented counter (Inv. #10–12).
   - No `udr_mode`, `gl_date_basis`, or `fx_rate_set_id` column is ever (re)introduced (code-standards §6.11).
6. **The M2M ingest is a first-class surface with its own rules.** It is the platform's first session-less `app/api/*` business path; build it exactly per code-standards §5 (bearer constant-time auth, no `getSession`, reject unless `PROCESSING`, DB-constraint idempotency). Do not model it on the human-auth pattern.

---

## 2. Units — One at a Time

Deliver one vertical unit per pass, verified and committed before the next (general §2). The module's reference build order — split further whenever §4 triggers; each is its own unit:

1. **Schema migration + seed** (§1.4) — the migration owns tables + partition registration + the `billrun_*` permission rows; the **Billing Viewer** role and its grants ship in the accompanying `db/seeds/billing.ts` seed, not the migration. No repository/service/UI in this unit.
2. **Accounts-side additive changes** — `document_inv_seq`, `'INV'` doc-type, the unlimited-`autoPostLimit` INV reason code, GL mapping rows, the **period-close guard**. This is a **cross-module unit** — see §3.6.
3. **Lazy materialization + run list read** — `billing/bill-runs/page.tsx`, the materialize service, `RunListRow`, `billrun_view` guard.
4. **Trigger** — snapshot accounts, `PROCESSING`, resolve `gl_event_at = scheduled_run_date`, call the engine client, double-trigger guard (`billrun_operate`).
5. **M2M ingest** — the stage-complete handler (insert stage row first → advance → recompute under `FOR UPDATE`) and the status-push handler; token auth; replay/409 tests. Split the two handlers if needed.
6. **Pipeline stages** — Scoping, Validation, Collection (claim), Aggregation, Taxation, Verification — **one stage per unit**, each with its `bill_run_account_stage` output and failure taxonomy.
7. **Run detail read surfaces** — Workflow timeline, Customers & Bills (charge lines read from `rating`), Uncharged, Errors, Audit — **one tab per unit**.
8. **Rerun** — audit-first, per-account later-stage invalidation, conditional trial re-derivation (`billrun_operate`).
9. **Approve** — four-eyes + the pre-approval checklist (`billrun_approve`).
10. **Post** — per-account INV posting through `postDocument`, resumable, checksum stamp.
11. **Stall + cancel** — derived STALLED, Check-status reconcile, Cancel-run release.
12. **Stub-data mode + badge** — env flag wiring and the always-on banner.

Do not resume or invent a global unit-number sequence unless the user sets one; each unit gets a fresh plan (general §2.5).

---

## 3. Scoping — No Speculative Changes

1. **Do not** create a billing-side charge table, a `charge`/`rated_charge`/`bill_line` table, or any column that copies a charge amount into `billing.*` (Inv. #3). Read from `rating.udr_rated`.
2. **Do not** widen the `rating` write beyond the claim marker, add a second file that writes `rating.*`, or add a cross-schema foreign key in either direction (Inv. #2).
3. **Do not** add `udr_mode`, `gl_date_basis`, `fx_rate_set_id`, a stored `STALLED` status, an incremental status counter as source of truth, or a per-run template-override column. These were deliberately removed or excluded — reintroducing one needs a spec change, not a build-time call.
4. **Do not** build a whole-run posting transaction, a per-invoice approval workflow, invoice-PDF rendering, distribution dispatch, proration, one-time/usage/OCC charge sourcing, off-cycle runs, or multi-frequency materialization — all are out of scope (overview *Out of scope*, plan §2). `DISTRIBUTING` ships in the enum but is never entered in v1.
5. **Do not** add app schedulers, cron, queue workers, or Container Apps Jobs for this module (Inv. #10). Materialization is lazy; orchestration is external; partition maintenance is `pg_cron`.
6. **Accounts-side changes are cross-module and need explicit authorization.** The INV sequence/type/reason code, GL mappings, and period-close guard are Accounts-owned objects proposed through the accounts plan. Build them as their own isolated unit **only when authorized**, coordinate with the accounts plan, and prove via CI that existing Accounts behavior, documents, and postings are unchanged. Absent authorization, stop and raise it (general §2.8).
7. **Do not** modify `postDocument`, pgledger, or the document engine. Bill Run **calls** the engine inside its own transaction; changing it is an Accounts concern, not this module's (code-standards §6.10).
8. **Respect layer boundaries:** pages are thin orchestrators (no DB, no status recompute, no money math); `services/billing/**` has no `next/*`; SQL lives only in `db/**`; the ingest handlers and Server Actions call the **same** service functions — never a forked copy.

---

## 4. When to Split Into Smaller Steps

Apply the general doc §3 triggers, plus these mandatory module splits:

1. **Split the schema migration from everything that depends on it** (§2.1) — land and verify it alone.
2. **Split each pipeline stage** (Scoping / Validation / Collection / Aggregation / Taxation / Verification) into its own unit with its own stage output, failure taxonomy, and tests. Never deliver the pipeline in one pass.
3. **Split each run-detail tab** (Workflow / Customers & Bills / Uncharged / Errors / Audit) and the posting-progress view into separate units.
4. **Split each operator mutation** (trigger, rerun, cancel, approve, post) into its own unit with its own action, guard, audit event, and route × level tests.
5. **Split the two M2M handlers** (stage-complete, status-push) if either grows beyond a reviewable diff; each carries its own auth + replay + 409 tests.
6. **Split read from write.** Build a page's `billrun_view` read path before any `operate`/`approve` mutation on it.
7. **Land each guardrail test with the unit that introduces the behavior**, never deferred to a later ship-gate unit (code-standards §9).
8. **When in doubt, split.**

Sequence every unit validation → db → service → action/handler → UI → tests.

---

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first and cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, audit, lifecycle, or money. Module-specific — **stop and ask, never default**:

1. **`gl_event_at` semantics.** It resolves to the cycle's billing-run day (`scheduled_run_date`) and posts to the run-month GL period. Do not invent a different basis (service-period, posting-timestamp, calendar) — if a cycle's rule is unclear, ask (Inv. #13).
2. **Claim / release rules.** A claimed UDR is never re-claimed; rerun releases then re-claims; release is refused for rows on a posted invoice. Any edge you can't resolve from the plan is a stop-and-ask (Inv. #2).
3. **Four-eyes and pre-approval checks.** Never relax `approver ≠ final trigger actor` or drop a pre-approval check to make a flow pass; if the check set is unclear, ask (Inv. #8).
4. **Period-close guard and `PERIOD_CLOSED` handling.** Never guess how a closed target period is handled — it is a first-class per-account posting error with retry; the guard is Accounts-coordinated (§3.6).
5. **Partition key.** `period_partition` is the run's period month, fixed at trigger. Never key partitions on insert time or invent a granularity without a spec change (Inv. #11).
6. **Permission names, levels, and audit event types.** The three `billrun_*` names and the module's audit event types are fixed by the docs; a new page/mutation needing a new name or event type is a stop-and-ask plus a doc update, never an ad-hoc addition.
7. **Never invent a charge amount or a tax computation.** Amounts come from `rating.udr_rated`; tax lines come from the taxation stage against the stamped tax-rate version. If a needed amount isn't sourced, ask — do not compute one.
8. **Record every resolution** in the owning companion doc (general §4.6) so the next agent doesn't re-ask.

---

## 6. Protected Files — Do Not Modify Without Explicit Instruction

The general doc §5 list applies in full. Module-specific detail and additions — stop, explain, and get explicit confirmation before touching any of these:

1. **`components/ui/`** — managed shadcn/Radix vendor layer. Build new billing indicators/dialogs in `components/billing/` by composition; never edit a primitive.
2. **Better-Auth managed tables and the `auth/` field mapping** — this module only references `core.APPUSER` by FK (`triggered_by`, `approved_by`, `created_by`); it creates no identity/RBAC/session/config/audit tables.
3. **Applied migrations** — forward-only. New columns/constraints/partitions ship in a new migration; never edit an applied one; no manual production DDL.
4. **The permission registry mechanism** — the three `billrun_*` permission rows come only from a committed migration, and the Billing Viewer role + its grants only from the committed `db/seeds/billing.ts` seed; no application runtime code path inserts `PERMISSIONS` rows or role grants.
5. **`tsconfig` strict flags, ESLint/Prettier, CI (`infra/**`)** — including the security-scan and route × level gates; never weaken one to pass a build.
6. **Lockfiles/dependencies** — `pg_partman`/`pg_cron` are DB extensions provisioned by infra, not an npm change; any npm dependency change is its own requested unit.
7. **The Accounts document engine, `postDocument`, pgledger, `billing.document`, and the INV reason code** — reuse only; changing them is an Accounts unit, coordinated and authorized (§3.6, §3.7).
8. **The `rating.udr_rated` claim-marker grant** — never widen the app's `rating` privileges beyond `SELECT` + the single-column `UPDATE`; the grant is defined once and is not a build-time convenience to expand (Inv. #2).
9. **`db/repositories/billing/rating-claim.ts`** — the single sanctioned `rating.*` writer; do not add `rating` writes elsewhere or duplicate this file.
10. **The companion docs' decisions** — the Invariants, the permission model, `gl_event_at`, the claim boundary, the stub-mode approach. Keep docs in sync (§7) but propose-and-approve before changing a documented decision.

---

## 7. Keeping Docs in Sync With Implementation

Per the general doc §6, plus:

1. **Permission map moves as one set.** A change to any bill-run page, its components, or a `billrun_*` permission ships with the matching rows in `billmgmt-architecture.md` §4 and `billmgmt-code-standards.md` §8 **and** the migration + typed constant (`PERMISSIONS.BILLRUN_VIEW`/`_OPERATE`/`_APPROVE`) in the same change set. No mapping, no merge.
2. **Component names are binding.** Create the exact names in code-standards §7/§8 (`BillRunsPage`, `BillRunDetailPage`, `RunStatusBadge`, `StageTimeline`, `ApproveAndPostPanel`, `PlaceholderBanner`, …) or the page ↔ route ↔ component ↔ permission chain breaks.
3. **Owning doc per fact:** run/flow behavior → overview; schema/Invariant/boundary → architecture; convention/component names → code-standards; workflow → this supplement. Reference, don't copy.
4. **A change to an Invariant, `gl_event_at`, the claim boundary, or the permission model is a doc-first change** — update the architecture doc and get approval before the code, never the reverse.
5. **Record resolved ambiguities** (§5.8) in the owning doc so they are not re-litigated.
6. **Do not let docs drift.** If you cannot update the owning doc in the same change, do not ship the unit. If code and docs already disagree, stop and flag it — do not silently "fix" one to match.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general doc §8 checklist. Additionally, confirm (run the checks; do not assume) the module guardrails from code-standards §9:

1. **Authz matrix** — the three pages × role/level, incl. the `billrun_operate` ≠ `billrun_approve` split and four-eyes (approver == final trigger actor → reject). A `billrun_view`-only principal reaches every read surface and no mutation (asserted against actions/handlers, not just navigation).
2. **M2M auth** — bad/missing bearer → 401; a valid stage signal advances `bill_run_account_stage` in one transaction; **replay `(run, ban, stage, attempt, period_partition)` → 200 no-op**; a signal after `APPROVED` → 409; a body carrying charge fields → rejected.
3. **Claim correctness** — a UDR claimed by another run is never re-claimed; rerun releases then re-claims; release refused for rows on a posted invoice; the claim is the **only** `rating.*` write (asserted structurally against `db/repositories/billing/`).
4. **Finalization latch** — a `customer_bill` with `ref_inv_document_id` cannot be deleted/invalidated; posting retry skips already-`INVOICED` accounts; a crash between INV-number consumption and the stamp commit does not double-post.
5. **No charge copy** — no `db/schema/billing/` table stores a charge amount; `charge_checksum` detects tampering with a posted invoice's `rating` lines.
6. **Partition & idempotency** — `period_partition` is fixed across a cross-month rerun; every stage/bill/account UNIQUE includes `period_partition`; run status is recomputed under `FOR UPDATE`; any cached counter equals the derived value.
7. **State machine & materialization** — every legal `RunStatus`/`AccountStatus` transition accepted, illegal rejected; `STALLED` never persisted; concurrent list loads create exactly one `bill_run` row; the next cycle is operable at `INVOICED`, not `COMPLETED`.
8. **Posting integrity & GL** — INV auto-posts under the unlimited limit inside the caller's transaction; `gl_event_at` drives the run-month GL period; `PERIOD_CLOSED` is a first-class per-account error with retry; invoice-number gaps are tolerated, never back-filled.
9. **Stub isolation** — while the stub flag is set, every run is visibly badged and the environment is isolated from any ledger holding real Accounts data.
10. **Audit** — every operator mutation writes exactly one `core.AUDIT_LOG` row inside its transaction; the rerun row is written **before** re-trigger with prior totals + reason; per-stage progress is the append-only `bill_run_account_stage` row.
11. **No forbidden edits** — nothing from §6 touched without confirmation; `postDocument`/pgledger unchanged; the `rating` grant not widened; no `TODO`, commented-out code, or `console.*`; diff minimal and reviewable.

If any item fails, the unit is not done. Fix it before moving on; never defer a failure to a later unit.
