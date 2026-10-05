# Billing Management (Bill Run) — AI Workflow Rules (Module Supplement)

Read `context/ai-workflow-rules.md` first and obey it in full — it is binding for every module; this document changes nothing there and adds only the Bill Run deltas. **Delta for this module, phase 3:** you are no longer building greenfield against a stub. The control plane is built and shipped; you are replacing a **no-op compute plane** with real logic that computes money — so (a) most of that logic belongs in the **workflow flow**, not in `services/`, and putting it in the app is a review-blocking defect; (b) the module's **38 Module Invariants** (`billmgmt-architecture.md` §6, of which **#15 is a retired tombstone**) are permanent cross-unit rules; (c) three rules that earlier versions of these docs stated as absolutes have **reversed** — treat any code or comment quoting them as wrong; (d) this phase amends another module's `[CRITICAL]` invariant, so rating's own workflow rules bind you too; and (e) nothing phase-3 ships until **Unit 22 (`bm22`)** proves the foundation against real infrastructure. Where this doc appears to weaken the general rules or the Invariants, stop and treat it as a bug.

**Companion docs (authoritative — do not restate or contradict):**

- `billmgmt-project-overview.md` — the product spec: overview, lifecycle, core user flow, architecture & boundaries, in/out of scope, success criteria, and the folded **Phase 4** section (the former `billmgmt-update-overview.md`, folded in 2026-10-04).
- `billmgmt-architecture.md` — technical design: stack additions, folder ownership, storage model, auth/ownership, background model, **38 Module Invariants (§6)** (#29–#38 added by the Target Capacity Pricing update), permission model (§4).
- `billmgmt-code-standards.md` — module conventions: domain unions (§2), M2M route rules (§5), data/storage rules (§6), file tree (§7), **permission map (§8)**, guardrail tests (§9, items 1–42; 36–42 added by the Target Capacity Pricing update).
- `_updatemodule-billing-billrun-phase3-plan.md` — the phase-3 design and decisions **D1–D33**. Cite this for design questions.
- `_assessment-gstack-review-report-billrun-phase3.md` — the eng review, its 11 findings, and the one accepted residual risk.
- `context/rating-management/ratemgmt-ai-workflow-rules.md` — **binding on you** for the rating-side changes in this phase (§3.6).

**Precedence** (general doc): architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## 0. Three Reversals — Check Before Citing Any Older Rule

Earlier revisions of these docs forbade exactly what phase 3 builds. **Do not obey the old text, and correct it where you find it quoted:**

| Old rule                                                       | Status       | Build to this instead                                                                                                                        |
| -------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| "There is **no billing-side charge table**, ever" (old Inv #3) | **REVERSED** | `billing.customer_bill_line` **is** the bill's charge record; `charge_checksum` is anchored on it (Inv #3, D5/D7)                            |
| "No service, repository, or SQL computes a charge amount"      | **SPLIT**    | No **usage-rating** in `billing`; recurring charge derivation **is** sanctioned billing compute and belongs to the **flow** (Inv #1/#17, D6) |
| "`BILLRUN_PLACEHOLDER_MODE` badges every run" (old Inv #15)    | **RETIRED**  | Delete the flag and its components; Inv #15 is a tombstone and is never reused (D31)                                                         |

If you find a code comment, spec, or test quoting a reversed rule, fix it in the same unit. Do not leave it standing "because it's only a comment."

---

## 1. Operating Approach — Module Specifics

1. **Name the authorizing section before you write anything.** Cite an overview feature, an architecture §-row or Invariant, a code-standards rule, or a plan decision (`D1`–`D31`). No section, no mandate — stop and ask (general §4).
2. **Put compute in the flow, not in the app.** All bill-data computation — validation, the claim, correlation, aggregation into `customer_bill_line`, recurring price resolution, taxation, verification — runs in `workflow-management/flows/bill-run-processor/` as `billrun_runtime`. **Never** add a charge-derivation function, a trial-bill writer, or an aggregation query under `services/billing/**`. `tests/guardrails/billing-trial-bill-compute-boundary.test.ts` enforces this; do not weaken it (Inv #17).
3. **The app writes run-state and posting. That is all.** The app's only `customer_bill` write is the posting stamp; its only `rating` writes are the six claim columns in `udr-status.repository.ts`; it never claims (Inv #2).
4. **Land Unit 22 (`bm22`) before any phase-3 logic.** Apply migrations `0033`/`0035`–`0038`, run `db:setup-partman-billing`, run the DB-gated suites, build the Chromium render image, bring up the blob store, run the live-Kestra smoke, stand up SFTP and verify the three Kestra plugins in the worker image. Exit criterion: a **phase-2-shaped** run reaches `COMPLETED` against real Postgres, real Kestra, a real blob store and a real SFTP endpoint. Do not start `customer_bill_line` on an unproven foundation (D17/D29).
5. **Land the schema before the behavior.** `customer_bill_line`'s migration, its `partman.create_parent` registration, and the grant changes (`app_runtime` `SELECT`; `billrun_runtime` `INSERT`/`SELECT` and **no** `DELETE`) ship and verify alone, before any repository, flow task or read surface depends on them.
6. **Treat these as permanent cross-unit rules. A unit that violates one is a review-blocking defect on sight:**
   - Six claim columns only; no `INSERT`, no `DELETE`, no other column in `rating` (Inv #2).
   - `customer_bill.subtotal` equals `SUM(customer_bill_line.net_amount)`, always (Inv #3).
   - `charge_checksum` hashes line **content** — `gross_amount`, `discount_amount` **and** `net_amount` — ordered by the grouping key, never by surrogate id (Inv #3, D7a/D20).
   - A `customer_bill` with `ref_inv_document_id` set is never updated, deleted or invalidated; its lines are equally untouchable, protected app-layer only (Inv #4, D27).
   - Re-derivation is a **whole-account replace** through `billrun_delete_trial_bill`; never a per-line upsert, never a bare `DELETE` (Inv #16, D22).
   - Reject, cancel **and rerun** release the claim to `RATED` — **before** the re-trigger, never after (Inv #19, D21).
   - The price snapshot is authoritative on rerun; never re-resolve the `lead()` window (Inv #20, D19).
   - Posting is per-account, one transaction each (Inv #6); the final-attempt trigger actor never approves (Inv #8).
   - `STALLED` is never persisted; `period_partition` is fixed per run; run status is recomputed under `FOR UPDATE` (Inv #10–12).
   - No `udr_mode`, `gl_date_basis`, or `fx_rate_set_id` column is ever (re)introduced (code-standards §6.13).
7. **Build the M2M ingest exactly per code-standards §5.** Bearer constant-time auth, no `getSession`, reject unless the run is in the expected state, DB-constraint idempotency. Do not model it on the human-auth pattern. Phase 3 adds no fourth handler — a fourth needs its own architecture decision.

---

## 2. Units — One at a Time

Deliver one vertical unit per pass, verified and committed before the next (general §2). **`context/billing-management/specs/bm00-build-plan.md` is the authority on unit numbering, unit boundaries and build order — read it before starting any unit and follow it exactly.** Phase 3 is **Units 22–35 (`bm22`–`bm35`)**, continuing the delivered `bm01`–`bm21` sequence; do not renumber, do not restart at 1, and do not invent a unit that is not in that file. Split further whenever §4 triggers; never merge two of its units into one pass.

| #   | Spec   | Unit                                                  | Boundary                                 |
| --- | ------ | ----------------------------------------------------- | ---------------------------------------- |
| 22  | `bm22` | Environmental gate                                    | infrastructure — **no application code** |
| 23  | `bm23` | `customer_bill_line` schema, partitions & grants      | migration + grants only                  |
| 24  | `bm24` | Claim release on reject, cancel **and rerun**         | app (`services/` + repository)           |
| 25  | `bm25` | Rating in-flight guard + `LOAD_BLOCKED_INFLIGHT`      | **cross-module — rating** (§3.6)         |
| 26  | `bm26` | Sample seed → `RAN_USAGE`, unclaimed                  | seed                                     |
| 27  | `bm27` | Real Collection: correlation & claim                  | flow                                     |
| 28  | `bm28` | Real Aggregation (`USAGE`) + `BillLineTable`          | flow + one read surface                  |
| 29  | `bm29` | Real Aggregation (`RECURRING`) + price resolver       | flow                                     |
| 30  | `bm30` | Verification + bill↔charge reconciliation             | flow                                     |
| 31  | `bm31` | `charge_checksum` re-anchored on `customer_bill_line` | app (repository)                         |
| 32  | `bm32` | Uncharged redefinition + per-record exception surface | app + read surface                       |
| 33  | `bm33` | Retire `BILLRUN_PLACEHOLDER_MODE`                     | app                                      |
| 34  | `bm34` | Real distribution: SFTP transport + multi-target      | flow + app                               |
| 35  | `bm35` | Phase-3 ship gate                                     | verification only                        |

Four orderings in that table are load-bearing and **must not** be reordered for convenience: **26 before 27** (Collection has nothing correlatable until unclaimed NULL-`billrun_ban_id` rows exist); **24 before 27** (claim before release semantics strands `BILL_DRAFT` rows and under-bills); **29 before 31** (the `md5('')` regression test needs a recurring-only bill to exist); **30 before 33** (the placeholder banner copy is only false once the flow is real). `bm00-build-plan.md` §_Merges and splits_ records why each merge was made — do not re-litigate it mid-build; if you believe a unit should be split, apply §4 and say so before you start.

---

## 3. Scoping — No Speculative Changes

1. **Do not** build OCC. `source='OCC'` is a reserved enum value with no producer; the occurrence ledger is origination-domain and unbuilt (`_futurebuild_occ-charge-sourcing.md` §6). **Never** store an OCC occurrence in `customer_bill_line` — it is per-run and rerun-destructible, so billed-exactly-once evidence cannot live there (Inv #16, D30).
2. **Do not** compute, apply or configure a discount. The columns and `line_type` exist so a later capability needs no migration against a posted table; emit `charge` lines with `discount_amount = 0.00` only.
3. **Do not** build the configurable line-grain surface. Ship the fixed `(product_offering_id, udr_type)` default, computed in exactly one place. The configuration store, its owner and its UI are deferred (D5b).
4. **Do not** build a tax-rate catalog, a real invoice template, proration, off-cycle runs, multi-frequency cycles, additional distribution targets, a target catalog table, a `bill_run_output` table, or the credit-note remedy for `LOAD_BLOCKED_BILLED`. All are out of scope (overview _Out of scope_, plan §13).
5. **Do not** give the rating engine a second, non-file ingestion mode to produce recurring charges. Phase 3 derives recurring in the bill run; changing rating's ingestion model is a rating-module design exercise, not a build-time call.
6. **Rating-side changes are cross-module and are already authorized — build them to rating's rules, not yours.** The Inv #6 amendment is authorized (Khek, module owner, 2026-09-13) and the `LOAD_BLOCKED_INFLIGHT` severity is set to `MINOR`. You must still obey `ratemgmt-ai-workflow-rules.md`: **§1.4** — express the guarantee as a trigger, not application code (the widened `_GUARD_SQL` alone is a breach); **§3.3** — a new event code ships as three parts in one change set (catalog seed row, `RATING_EVENT_CODES` constant, emitting flow); **§3.5** — a constraint change updates the architecture Invariants in the same change set; **§5.5** — record the resolution in the owning document. Do not add any other rating change to this set.
7. **Do not** modify `postDocument`, pgledger, or the document engine. Bill Run **calls** the engine inside its own transaction (code-standards §6.12).
8. **Do not** add app schedulers, cron, queue workers, or Container Apps Jobs (Inv #10). Materialization is lazy; orchestration is the engine; partition maintenance is `pg_cron`; distribution retry is one in-execution attempt, then operator-triggered.
9. **Respect layer boundaries.** Pages are thin orchestrators; `services/billing/**` has no `next/*`; SQL lives only in `db/**`; the ingest handlers and Server Actions call the **same** service functions. `workflow-management/**` is outside the dependency chain entirely — the app never imports it and it never imports the app.
10. **Do not** widen a grant as a build-time convenience. `billrun_runtime` and `app_runtime` grants inside `billing` are enumerated per table; a new read is a reviewed one-line change, never `ON ALL TABLES` and never `ALTER DEFAULT PRIVILEGES` (Inv #23).

---

## 4. When to Split Into Smaller Steps

Apply the general doc §3 triggers, plus these mandatory module splits:

1. **Split Unit 22 (`bm22`) from everything.** No application code ships in it.
2. **Split the `customer_bill_line` migration + grants from its first consumer.** Land and verify alone.
3. **Split Aggregation by source.** `USAGE` rollup and `RECURRING` derivation are separate units — they have different exactly-once mechanisms and different failure modes. Never deliver both in one pass.
4. **Split each pipeline stage** (Validation / Collection / Aggregation / Taxation / Verification) into its own unit with its own stage output and failure taxonomy.
5. **Split each read surface** (Customers & Bills with the line table, Uncharged, Errors, Distribution) into separate units.
6. **Split each operator mutation** (trigger, rerun, reject, cancel, approve, post, start/rerun distribution) into its own unit with its own action, guard, audit event and route × level tests.
7. **Split read from write.** Build a surface's `billrun_view` read path before any `operate`/`approve` mutation on it.
8. **Do NOT split the rating change set** (§3.6) — rating's §3.3/§3.5 require those parts to land together.
9. **Land each guardrail test with the unit that introduces the behavior**, never deferred to the ship gate (code-standards §9).
10. **When in doubt, split.**

Sequence every unit: validation → db → service/flow → action/handler → UI → tests.

---

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first and cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, audit, lifecycle, or money. Module-specific — **stop and ask, never default**:

1. **The unresolvable-subscriber policy is DECIDED (D32) — build it, do not re-litigate.** Leave the row at `RATED`, unclaimed; surface it with `BILL_NOTUSED`; continue the run; informational on the pre-approval checklist, never blocking. Do not filter it out of the claim query and do not fail an account on it (Inv #25).
2. **The recurring-price miss policy is DECIDED (D33) — build it, do not re-litigate.** A missing as-of `recurring` price or a `tiered` price fails the account `HARD` with `RECURRING_PRICE_NOT_FOUND` / `RECURRING_PRICE_UNSUPPORTED`; no bill for that account. Never substitute zero and never skip the subscription silently (Inv #28).
3. **Claim and release rules.** A claimed row is never re-claimed by another run; reject/cancel/rerun release. Any edge you cannot resolve from the plan is a stop-and-ask (Inv #2, #19).
4. **Four-eyes and pre-approval checks.** Never relax `approver ≠ final trigger actor` or drop a pre-approval check to make a flow pass (Inv #8).
5. **`gl_event_at` semantics.** It resolves to `scheduled_run_date` and posts to the run-month GL period. Do not invent another basis (Inv #13).
6. **Partition key.** `period_partition` is the run's period month, fixed at trigger. Never key on insert time (Inv #11).
7. **Permission names, levels, and audit event types.** The three `billrun_*` names are fixed. Phase 3 adds no page and no permission; a new one is a stop-and-ask plus a doc update.
8. **Anything on rating's own never-guess list** (`ratemgmt-ai-workflow-rules.md` §5.1) — an event code's severity, a grant or REVOKE, retention, the live-row uniqueness constraint, `udr_key`, rounding mode. Those are rating's to decide even when your unit needs them.
9. **Never invent a charge amount.** `USAGE` amounts come from `rating.udr_rated`; `RECURRING` amounts come from the resolver against the catalog. If an amount is not sourced, ask — do not compute one.
10. **Record every resolution** in the owning companion doc (general §4.6) so the next agent does not re-ask.

---

## 6. Protected Files — Do Not Modify Without Explicit Instruction

The general doc §5 list applies in full. Module-specific detail and additions — stop, explain, and get explicit confirmation before touching any of these:

1. **`components/ui/`** — managed shadcn/Radix vendor layer. Compose new billing components in `components/billing/`; never edit a primitive.
2. **Applied migrations** — forward-only. `0033`/`0035`–`0038` are generated and unapplied; **apply them, never edit them.** An edited applied migration is silently skipped, not re-applied.
3. **`db/repositories/billing/udr-status.repository.ts`** — the app's only sanctioned `rating.udr_rated` writer. Do not add `rating` writes elsewhere or duplicate this file.
4. **`db/repositories/billing/rated-lines.repository.ts` must stay read-only.** It imports from `@/db/schema/rating`; adding any `.insert(`/`.update(`/`.delete(` there trips `billing-rating-write-boundary.test.ts`. Put the checksum in `customer-bill-line.repository.ts`, which touches no `rating` object.
5. **`db/bootstrap/billrun-db-roles.sql` and `rating-db-roles.sql`** — the role, grant and status-guard definitions live here, **not in migrations**. Do not move them into a migration and do not widen a grant here as a convenience.
6. **`billing.billrun_delete_trial_bill` and `customer_bill_finalization_guard`** — the scoped `SECURITY DEFINER` and the header finalization trigger. Do not bypass either, and do not grant `billrun_runtime` a direct `DELETE` that would route around the function's `ref_inv_document_id IS NULL` scoping.
7. **`rating.billrun_status_guard`** — already narrowed to `RATED → BILL_DRAFT`. Do not re-widen it.
8. **The Accounts document engine, `postDocument`, pgledger, `billing.document`, and the INV reason code** — reuse only.
9. **Better-Auth managed tables and the `auth/` field mapping** — this module only references `core.APPUSER` by FK.
10. **`tsconfig` strict flags, ESLint/Prettier, CI (`infra/**`)** — including the security-scan and route × level gates; never weaken one to pass a build.
11. **Lockfiles/dependencies** — `pg_partman`/`pg_cron` are infra-provisioned DB extensions, not an npm change.
12. **Deployed flow YAML must never be edited in the Kestra UI.** Kestra OSS records no per-user action history, so a UI edit is an untracked change to how money is computed. Every flow change is a repo commit, and `processing_flow_revision`/`distribution_flow_revision` are stamped on `bill_run` so a run stays reconstructable.
13. **The companion docs' decisions** — the Invariants, the permission model, `gl_event_at`, the claim boundary, D1–D33. Keep docs in sync (§7) but propose-and-approve before changing a documented decision.

---

## 7. Keeping Docs in Sync With Implementation

Per the general doc §6, plus:

1. **Fix a reversed rule wherever you find it quoted.** The three reversals in §0 are cited across code comments, specs and tests. When a unit touches a file citing an old rule, correct the citation in the same diff.
2. **Never reuse a retired invariant number.** Inv #15 is a tombstone. If an invariant retires, leave the number with an explanation so existing citations resolve to something true, and give the replacement rule a new number.
3. **Permission map moves as one set.** A change to any bill-run page, its components, or a `billrun_*` permission ships with the matching rows in `billmgmt-architecture.md` §4 and `billmgmt-code-standards.md` §8 **and** the migration + typed constant in the same change set. No mapping, no merge. Phase 3 adds none — do not add one silently.
4. **Component names are binding.** Create the exact names in code-standards §7/§8 (`BillLineTable`, `ChargeSourceBadge`, `BillRunDetailPage`, `StageTimeline`, …) or the page ↔ route ↔ component ↔ permission chain breaks.
5. **A change to an Invariant, the claim boundary, `gl_event_at`, the checksum anchor or the permission model is a doc-first change** — update the architecture doc and get approval before the code, never the reverse.
6. **A cross-module change updates the other module's docs in the same change set**, to that module's rules (§3.6).
7. **Owning doc per fact:** run/flow behavior → overview; schema/Invariant/boundary → architecture; convention/component names → code-standards; workflow → this supplement; design reasoning → the phase-3 plan. Reference, don't copy.
8. **Do not let docs drift.** If you cannot update the owning doc in the same change, do not ship the unit. If code and docs already disagree, stop and flag it — do not silently "fix" one to match.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general doc §8 checklist. Additionally, confirm — **run the checks, do not assume** — the module guardrails from code-standards §9:

1. **Correlation** — a seeded row with `billrun_ban_id` NULL claims to the right account through `product_inventory`; an unresolvable subscriber follows the stated policy; nothing writes `product_inventory.billing_account_id`.
2. **Line grain and totals** — 3 + 500 subscriptions across two offerings produce exactly **2** lines; `SUM(net_amount) = subtotal` on every bill; `line_no` reproduces identically from unchanged inputs.
3. **Checksum** — a recurring-only bill produces a non-`md5('')` checksum; it is computable from line content without surrogate ids; changing `gross_amount`, `discount_amount` **or** `net_amount` on a posted line changes it.
4. **Recurring exactly-once** — running Aggregation twice for one account leaves exactly one recurring line per subscription; no `ON CONFLICT DO UPDATE` and no bare `DELETE` against `customer_bill_line` exists in the tree; `billrun_runtime` is refused a direct `DELETE`.
5. **[CRITICAL] No claim survives an abandoned attempt** — after a rerun following a partial processing failure, no row remains at `BILL_DRAFT` from the prior attempt and the re-run bill carries every charge the first attempt claimed.
6. **Rating in-flight guard** — a reload colliding with `BILL_DRAFT` is refused with `LOAD_BLOCKED_INFLIGHT` (MINOR) naming the blocking `bill_run_id`; a `BILL_APPROVED` collision still raises `LOAD_BLOCKED_BILLED` (MAJOR); **with the pre-check bypassed**, a direct `rating_runtime` UPDATE out of `BILL_DRAFT`/`BILL_APPROVED` is refused by the trigger.
7. **Price snapshot authority** — a rerun after a backdated `product_offering_price` insert reproduces the original amounts.
8. **Grants** — `app_runtime` has `SELECT` and no DML on `customer_bill_line`; `billrun_runtime` has `INSERT`/`SELECT` and no `DELETE`; the four new cross-schema reads are present and enumerated.
9. **Distribution** — per-artifact `DELIVERED`; a forced mandatory failure yields `DISTRIBUTION_FAILED` and reruns only failed artifacts; an upload failing twice still POSTs `FAILED`; duplicate outcome → 200 replay; stale attempt → swallowed; both targets launchable; completion requires **all** mandatory targets.
10. **Uncharged semantics** — a recurring-only account with zero usage is **billed**, not Uncharged; an account with no lines **is**; an `EXCLUDED` account is on neither.
11. **Partition registration** — `customer_bill_line` has its `partition_management` row and a future-month row does not land in the default partition.
12. **Finalization** — a `customer_bill` with `ref_inv_document_id` cannot be deleted or invalidated; posting retry skips finalized accounts. **Know the residual:** posted lines have no DB trigger and the checksum is not re-verified after posting — do not claim tamper detection you have not built.
13. **M2M auth** — bad/missing bearer → 401; replay → 200 no-op; a signal in the wrong run state → 409; a body carrying charge fields → rejected; exactly three `POST` handlers exist.
14. **Authz matrix** — the three pages × role/level, the `operate` ≠ `approve` split, four-eyes. A `billrun_view`-only principal reaches every read surface and no mutation.
15. **Audit** — every operator mutation writes exactly one `core.AUDIT_LOG` row inside its transaction; the rerun row is written **before** re-trigger with prior totals + reason.
16. **Seed integrity** — every seeded row is `_SAMPLE_`-marked and starts unclaimed; `db:seed-sample` is prod-guarded and absent from `db:setup`. (This survives the `BILLRUN_PLACEHOLDER_MODE` retirement — do not delete it with the banner.)
17. **Docs in sync** — every reversed-rule citation the unit touched is corrected; the owning doc is updated in the same change set.
18. **No forbidden edits** — nothing from §6 touched without confirmation; no `TODO`, commented-out code, or `console.*`; diff minimal and reviewable.

If any item fails, the unit is not done. Fix it before moving on; never defer a failure to a later unit.

---

## Target Capacity Pricing update — module rules (2026-10-04)

Read `context/ai-workflow-rules.md` first and §0–§8 above; this section adds **only** the Target Capacity Pricing deltas on top of them (sources: `_updatemodule-billing-billrun-target-capacity-plan.md`, `billmgmt-update-overview.md`, `billmgmt-architecture.md` Inv #29–#38). Phases 1–4 (bm01–bm39) are delivered; this is the next phase. Where this section is silent on a facet, the §0–§8 rule binds unchanged. **Precondition:** the finalized `_change-rating-configuration-plan.md` (PER_UNIT rating, the `udr_subscriber_ref_id → udr_subscription_ref_id` rename, the real resolver) is treated as shipped by this phase's `bm*`-spec delivery.

### Approach (adds to §1)

1. **Put all capacity compute in the flow.** Capacity pricing is inline SQL CTEs in `bill_run_processing.yml` (`aggregation` + `verification`), as `billrun_runtime`. **Never** add a capacity pricing function under `services/billing/**`, a `billing.capacity_charge()` DB function, or a Python pricing task — each is a review-blocking defect (Inv #29; §1.2 holds).
2. **Bill Model 1; use Model 2 only to check.** The billed figure is `gross = Σ udr_rated_price + topUp`. The `max(Q, target) × baseRate` recompute exists only in verification as a cross-derivation. No code path bills from Model 2 (Inv #29).
3. **Land Unit 0 first, as its own PR, before any capacity logic.** Repair the recurring resolver onto the PC14 component schema, build the shared as-of reader, and replace the hand-copied flow-double with the extracted-SQL harness. It is a live P0 — the deployed flow fails every account post-PC14 — so do not start capacity on an unrepaired base (TC44; analogous to the §1.4 "land bm22 first" rule).
4. **Land the two-column migration + grants before any consumer.** `rated_amount` + `additional_info` on `customer_bill_line`, and the three new `billrun_runtime` SELECT grants (`product_specifications`, `ratecard_ran_usage_lkp`, `ratecard_version`), ship and verify alone (§1.5).
5. **Treat Inv #29–#38 as permanent cross-unit rules.** Round each component once, derive `gross`/`net` (Inv #34); append `rated_amount` to the checksum, never hash `additional_info` (Inv #35); detect capacity by component, never a column (Inv #32); resolve off the pinned offering version (Inv #31); `CAPACITY_RATE_MATCHING` loud-by-default, OFF never silent (Inv #30); one capacity subscription per `(customer, product)` (Inv #37).

### Scoping — do not build (adds to §3)

1. **Do not build proration or partial-period billing.** It is blocked on a **business** pro-ration policy (O-TC7) — stop and ask the business; never default a method. Partial-period accounts stay `EXCLUDED`.
2. **Do not support multiple billing accounts per customer for one capacity product.** One capacity subscription per `(customer, product)` is DECIDED (O-TC5, Inv #37); the per-account `CAPACITY_MULTIPLE_SUBSCRIPTIONS` guard is a backstop, not an invitation.
3. **Do not build** negotiated overrides on capacity offerings (G2 fails them out), rate-card item pricing (P1), multi-step motivation in production (ship the N-band SQL but keep `capacity_max_bands = 1`), district summarisation or an appendix beyond 10,000 rows/account, any app-UI display of the capacity calc trace, real taxation (`0.00` interim stands), or the prerequisite product/inventory/ordering changes (a separate phase).
4. **Do not disable `CAPACITY_RATE_MATCHING` in code.** It is an ops flag, default ON; code never ships it OFF and never skips the mismatch check.
5. **Do not invent capacity unit numbers.** A `bm*`-style build plan follows sign-off of the capacity plan; until it exists in `specs/`, do not start a capacity build unit (capacity plan §12).

### When to split (adds to §4)

1. **Split Unit 0 from all capacity logic** — ship and deploy it first.
2. **Split the migration + grants from the first consumer.**
3. **Split the invoice usage appendix into its own sub-unit, sequenced after the pricing core is green** — a wobble in the render/appendix must not hold up money-correctness (O-TC6).
4. **Keep the §4.4 per-stage split** — capacity aggregation and the verification cross-check are separate stage work with separate failure taxonomies.
5. **Do not split "enable multi-step motivation" into this phase** — it ships guarded (`capacity_max_bands = 1`); enabling it is a later config change.

### Missing or ambiguous (adds to §5 — stop and ask, never default)

1. **Partial-period billing (O-TC7) is a business decision** — never build a pro-ration method without it.
2. **The rate-match model is DECIDED — build it, do not re-litigate:** Model 1 billed, Model 2 checks, gate default ON, OFF logs + records + bills Model 1 (Inv #29/#30).
3. **The single-subscription grain is DECIDED (O-TC5):** per `(customer, product)`.
4. **Build-plan opens — resolve them in the `bm` build plan, cite it, do not guess:** rerun snapshot vs re-resolve (O-TC1), the capacity line's `quantity` (O-TC2), the appendix sourcing + ratecard version (O-TC6).
5. **The rating-config plan is a hard precondition.** Build and sign off capacity against **real PER_UNIT rating** and the renamed `udr_subscription_ref_id` — never a FLAT stand-in. If PER_UNIT has not shipped, stop (TC45/TC53).

### Protected files (adds to §6)

1. **No DB function and no Python for pricing** — inline SQL only; a `billing.capacity_charge()` function or a Python task is a new pattern and review-blocking.
2. **Do not reorder the checksum tuple** — append `rated_amount` last, never mid-tuple; never hash `additional_info` (Inv #35).
3. **`product.ratecard_ran_usage_lkp` / `product.ratecard_version` are product-module-owned — read only.** Never write them from `billing`.
4. **Do not remove or weaken the destructive-DB preflight** once added, and do not reintroduce a cross-cluster `DROP DATABASE … WITH (FORCE)`.
5. **The capacity flow SQL lives in `bill_run_processing.yml`** — never edit it in the Kestra UI (§6.12 holds); every change is a repo commit.

### Keeping docs in sync (adds to §7)

1. **The new grants update the architecture Invariants in the same change set** (§3.5-style; Inv #23).
2. **Cite Inv #29–#38 and guardrails 36–42 by number; never reuse a number.**
3. **The capacity plan's TC decisions (TC1–TC58) are the design authority and the O-TC list is the open set** — update them in the same change when a decision moves; owning-doc-per-fact still applies (§7.7).

### Verification checklist (adds to §8 — run the checks, do not assume)

1. **Anchors** on the `ci` seed: 800 → 100,000; 1000 → 100,000; 2000 → 150,000; 0 → 100,000; `subtotal = SUM(net_amount)`.
2. **Guards** — each of the six `CAPACITY_*` codes fails only its account; a NULL/`ZERO_RATED` rate trips `CAPACITY_RATE_MISMATCH`.
3. **Rate-match gate** — Model 2 reconciles on a consistent run; `CAPACITY_RATE_MATCHING=OFF` logs a WARN, bills Model 1, and records the flag state (never silent).
4. **Verification** — a tampered `rated_amount`/`gross`/`discount`/`calc.total` is caught by **both** detectors; every capacity line holds `discount_amount ≥ 0` and `net_amount ≥ 0`.
5. **Checksum** — altering `rated_amount` on a posted line changes the recomputed `charge_checksum`.
6. **Appendix** — renders per-polygon by state/district from the `productCardLookUp` ratecard, to 10,000 rows/account; a card-missing polygon surfaces (not dropped).
7. **Testing** — DB suites run the **extracted** flow SQL (no hand-copied double); a **live-Kestra** capacity run drives `SCHEDULED → COMPLETED`; the destructive-DB preflight refuses a non-disposable target.
8. **Boundaries** — no new `services/billing/**` compute file, no DB function, no Python; capacity SQL is in `bill_run_processing.yml` only.
9. **Precondition** — PER_UNIT rating + the `udr_subscription_ref_id` rename are shipped before capacity E2E sign-off.

If any item fails, the unit is not done.
