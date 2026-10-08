# Rating Management Module — AI Workflow Rules (Module Supplement)

These rules **supplement `context/ai-workflow-rules.md`** (the binding workflow rules every module inherits — spec-driven work, one unit at a time, no speculative changes, how to clarify, how to verify, how to keep docs in sync) and state **only what the Rating Management module changes or adds**. Obey the general rules unless a numbered rule below overrides one explicitly.

**Precedence.** `ratemgmt-architecture.md` Invariants → `ratemgmt-project-overview.md` → `ratemgmt-architecture.md` → `ratemgmt-code-standards.md` → this document → `context/ai-workflow-rules.md`. Never weaken a rule from a higher-precedence document.

**Read this first.** This module has **no pages, no Server Actions, no components, and no permissions**. General §7 ("Front-End Pages Must Carry Permissions") **does not apply and has no module equivalent** — do not invent one. The general verification checklist's route × level matrix likewise does not apply; §8 below replaces it. Rating logic lives in **Kestra flow definitions in a separate repository**, not in the application.

---

## 0. PER_UNIT RAN-Usage Update — workflow rule deltas

Supplements `context/ai-workflow-rules.md` and the module rules below; applies to the PER_UNIT RAN-usage update (`_change-rating-configuration-plan.md`, `ratemgmt-update-overview.md`, `ratemgmt-architecture.md`). Scope: Workstreams A+B+D. Obey these as rules, not guidelines.

**Overall approach — spec-driven, incremental.**
1. **Take the unit list from the build order in `_change-rating-configuration-plan.md` (steps 0–8). Do not restate it here** (§2.3 forbids copies).
2. **Do step 0 first.** Update the scope docs (this file, `ratemgmt-project-overview.md`, `ratemgmt-code-standards.md`, FLAT→PER_UNIT) and add forward banners to the rm specs **before** you write any PER_UNIT code. Skip this and the FLAT-only tests and docs read the new code as a regression.
3. **Build one step per pass.** Do not start the next until the current passes §8 + the update checks below and is committed.

**Scoping — no speculative changes.**
4. **`PER_UNIT` is in scope; nothing beyond it is.** `TIERED_*`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED` stay out (§3.1, updated). Do not build **card-driven** `usage_rate` rating — raise `CARD_DRIVEN_RATING_UNSUPPORTED`.
5. **Do not build Workstream C** (Product-management UI, `product_catalog` permission, the `singleSubInstPerCust`/MNO-key ordering guards). It is deferred to `_futurebuild-product-mgmt-ui-plan.md`. Raise the gap; do not fill it.
6. **Do not store `party_role_id` on `udr_rated`.** The rated row's subscription anchor is `udr_subscription_ref_id` (a `product_inventory_id`); `party_role_id` is resolved transiently for the factor-2 cross-check only.

**When to split.**
7. **Each build-order step is its own unit; never one PR.** The `udr_subscriber_ref_id` → `udr_subscription_ref_id` rename is **atomic within each repository, coordinated across rm15 and rm19** — never a half-rename inside either boundary. The app-repo call sites (migration + index, Drizzle, seeds, `rm01/08/09/13`, `db/repositories/billing/rated-lines.repository.ts`) land together in rm15; the wfm call sites — the runtime writers in `rp.py`/`rl.py`, including the `COPY` column list — land together in rm19. Do not land one repository's half without scheduling the other's in the same cycle (§2.2). The **X1/X2 DDL** (period_of TZ + live-row tighten) is its own unit, gated on rule 12.

**Missing or ambiguous — these are RESOLVED. Do not re-ask or re-invent (cite the plan / `ratemgmt-architecture.md`):**
8. `udr_key = mno|cu|polygon` (no datetime); identity = `(partition_period, udr_key)`; `udr_rate_type = PER_UNIT`; `period_of()` TZ = config (`Asia/Kuala_Lumpur`); live-row key = `(partition_period, udr_key, is_live)`; `singleSubInstPerCust` = one **RAN_USAGE** subscription per customer; `reject_threshold = "0"`; `ratecard_coverage_enforcement` default `HARD_STOP`.
9. **Still open — stop and ask, do not invent:** whether a **non-monthly `udr_type`** will ever be added (it changes the X2 grain — a `udr_type`-scoped partial index); the real scope of the `TESTING` lifecycle stage (deferred).

**Files you must not modify without explicit instruction (adds to §6).**
10. **Do not rewrite the delivered rm unit specs** (`rm01/06/07/08/09/10/12`) — add a forward-reference **banner** only. They are the record of what shipped.
11. **Do not reopen `validation/product/pricing-component.schema.ts`.** The ratecard reference is a product spec (`productCardLookUp`), not a component field; the `usage_rate` invariant stays untouched.
12. **Do not edit `0034_rating.sql` in place until you have verified the fresh-install regime** (no environment holds live `rating.udr_rated` data — the same gate pm57a's G-RC6 uses). Record the check. If any environment has rated data, ship X1/X2/rename as a forward migration instead — edit-in-place is off the table.
13. **The two authorized §6 exceptions** are X2 (live-row key, §6.1) and X1 (`period_of` TZ, §6.4). They are authorized by this update; do not treat §6 as blocking them, and do not change either further without a new authorization.

**Docs in sync.**
14. **Ship the whole doc set together.** A PER_UNIT unit updates `ratemgmt-architecture.md` (Inv 20–25, X1/X2), `ratemgmt-code-standards.md` (§0), `ratemgmt-update-overview.md`, and pm57a's banner in the same change set.
15. **New event codes ship with their `event_catalog` seed row (rm02) + constant + emitting flow** (§7.3): `UNKNOWN_SUBSCRIBER`, `CARD_DRIVEN_RATING_UNSUPPORTED`, the three identity-lock failures, `SERVICE_CODE_MISMATCH`, the completeness/mapping hard-stops.
16. **Reconcile bill-run.** X1 reverses the old *"bill-run selects by `start_datetime`, never `partition_period`"* rule — fix `billmgmt-architecture.md` / `_newmodule-billrun-rating-workflow-plan.md` (§7.6).

**Verification — before the next unit (adds to §8).**
17. **PER_UNIT correctness:** `udr_rate_type = PER_UNIT`; `udr_rated_price_raw = ratePerUnit × usage_volume`; `udr_rated_price = round(raw, HALF_UP)`; `udr_rate_detail` validates against `perUnitRateDetailSchema`; `udr_usage_unit` comes from the product `unit_of_measure`, not the feed.
18. **Identity locks:** each of the three hard-stops on a forced mismatch; an empty `{}` `party_role_specification` → `UNKNOWN_SUBSCRIBER`.
19. **Dedup:** rejects a same-cell / same-billing-month duplicate; keeps a same-cell / different-month pair.
20. **Regressions pass:** R1 (FLAT→PER_UNIT refresh), R2 (dedup widening), R3 (input→ratecard hard-stop).
21. **Post-rename:** grep proves **zero** remaining `udr_subscriber_ref_id` references (especially the bill-run repo).
22. **X1/X2 DDL:** fresh-install verified (rule 12); the live-row constraint rejects a second live row per `(partition_period, udr_key)`; `period_of()` behaves identically across ≥3 session timezones with the config-TZ literal.

---

## 1. Operating Approach — Module Specifics

1. **Name the authorizing section before you write anything.** Cite `ratemgmt-project-overview.md`, `ratemgmt-architecture.md` (by Invariant number), or `ratemgmt-code-standards.md` (by rule number). No section, no mandate — stop and ask (§5).
2. **Never write rating logic into the application repository.** If your change computes a rate, applies a discount, decides a supersession, or validates a usage record, it belongs in the rating repo's `flows/**`. A file under `enterprise-billing-app` that does any of these is in the wrong repository — stop and re-scope.
3. **Never edit a flow in the Kestra UI.** Every flow change is a commit in the rating repo, deployed from there. Kestra OSS records no per-user action history, so a UI edit is an untracked change to how money is calculated. If you cannot make a change through the repository, stop and raise it.
4. **Express every guarantee as a constraint or a grant where one exists.** Application checks give a readable error; they are never the guarantee. If you find yourself enforcing an Invariant only in code where a `UNIQUE`, `CHECK` or `GRANT` was available, stop and re-scope.
5. **Assume the file will be reprocessed and the worker will be killed mid-transaction.** Every unit must be correct under both. If your unit is only correct on the happy path, it is not finished.

---

## 2. Units — One at a Time

1. **A unit here is not a vertical slice through app layers** — there are no app layers. Slice in this dependency order:
   **DDL + constraints → grants → seed → flow component section → logging → guardrail tests.**
2. **A unit never spans both repositories.** Land the schema and grants in the app repo, in their own PR, before the flow that depends on them. A flow referencing a column that does not yet exist in `main` is not shippable.
3. **The unit list is `specs/rm00-build-plan.md`, and it is the only copy.** Do not restate it here or anywhere else — §7.7 of this document forbids copies, and an earlier draft of this section carried a divergent twelve-unit list that had already drifted from the build plan. Read `rm00-build-plan.md` for the units, their boundaries, their visible results and their dependencies. Read it there for the units, the phases and the repo split. Do not restate any of them here — an earlier draft did, and had drifted from the build plan within two revisions.

4. **One unit per pass.** Do not start the next until the current passes §8 and is committed.
5. **Do not build a later unit's behaviour early.** rm06's `prp`/`rp`/`rl` stubs stay stubs until rm07, rm08 and rm09 replace them section by section.

---

## 3. Scoping — No Speculative Changes

1. **Implement `PER_UNIT`; implement no other rate type.** *(PER_UNIT update — supersedes the earlier FLAT-only scope; authorized by `_change-rating-configuration-plan.md`.)* `PER_UNIT` (`ratePerUnit × usage_volume`) and `FLAT` are valid. `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED` stay **out of scope** — implementing their calculation is a spec change, not a unit. **Card-driven `usage_rate` rating is also out of scope:** if RP resolves a `usage_rate` with `plaSpecId = 'PLA_USAGE_RATE'`, raise `CARD_DRIVEN_RATING_UNSUPPORTED` — do not build the calculation.
2. **Do not add minimum-commitment, cap, or allowance handling.** These cannot be computed per record and are bill-run-time concerns. Adding a column or a rate-type value for them is a category error — raise it, do not build it.
3. **Do not add `rating.udr_exception`.** It was deliberately removed. `status = 'BILL_NOTUSED'` covers the case.
4. **Do not add a `udr_key_hash` column** or any hash-based index. `udr_key` is indexed directly, and the decision is recorded with measurements in `_newmodule-rating-engine-plan.md` §12.5.
5. **Do not add columns "for the bill run".** The bill run writes exactly six columns. A seventh requires an approved change to `ratemgmt-architecture.md` §4 and the boundary document.
6. **Do not build a UI, a page, an API route, or a `core.PERMISSIONS` row.** If Ops needs a view, the answer in v1 is a SQL query or the Kestra UI. Raise the gap; do not fill it.
7. **Do not add retry-with-backoff, alerting integrations, or a notification path.** Recovery is operator-triggered; alerting consumes `process_log` externally.
8. **Do not touch `billing.*`, `product.*`, `ordering.*`, or `inventory.*` schema.** This module reads them. A change there is another module's unit, coordinated through its plan.

---

## 4. When to Split Into Smaller Steps

Split whenever any holds. When in doubt, split.

1. **A schema change plus behaviour** — land tables, constraints and partition registration as their own reviewed step before anything writes to them.
2. **A grant change plus the code that uses it** — the grant and its assertion test ship first.
3. **More than one pipeline component** — PRP, RP and RL are always separate units. Never one PR.
4. **A guard plus the path it guards** — the `BILL_APPROVED` refusal, the batch claim, and the shrinking-reissue check are each their own step with their own test.
5. **A constraint plus its enforcement path** — add the constraint and its violation test first; add the code that respects it second. The test must prove the constraint fires when the code is deliberately wrong.
6. **Anything touching both repositories** — always two units, app repo first.
7. **A flow change plus a worker image change** — the image rebuild is its own step, because it revalidates every flow, not just yours.
8. **A step that would leave either repo red** — re-cut the boundaries.

Sequence within a unit: **DDL → grants → seed → flow section → logging → tests.** Finish each before the next.

**Recorded waiver — billing bm48 only (owner decision, 2026-10-08).** bm48 (`udr_rated.state`/`.district`, migration `0045` + PRP/RP/RL) lands as **one PR** rather than the split §4.1 and §4.3 require, to reduce PR count. The waiver keeps the rule's intent through **ordered commits** in this file's dependency order — migration + Drizzle → PRP → RP → RL → seeds + tests → docs — so each step stays separately reviewable and revertable. It is scoped to bm48 and is **not precedent**: any other unit that needs the same exception records its own, by name, here.

---

## 5. Missing or Ambiguous Requirements

1. **Never guess on any of these. Stop and ask, with the options stated:**
   - The `udr_key` field list, or its canonicalisation ordering.
   - Any change to the live-row uniqueness constraint.
   - The per-record rounding method (`HALF_UP`/`HALF_EVEN`/`TRUNCATE`) recorded in `udr_rounding_mode`. (Round-at-aggregation is the bill run's stage, not rating's.)
   - A grant, a `REVOKE`, or a column added to the six-column `app_runtime` grant.
   - An `event_code`'s default severity, or whether it is self-clearing.
   - Retention on any table or file location.
2. **Resolve from the docs first**, in precedence order, and cite the section you followed.
3. **Two known-open items must not be resolved by invention:**
   - **The `udr_key` field list** is defined at PRP build (**rm07**) from the actual feed format. The canonicalisation *rule* is fixed (sorted keys, UTC, fixed numeric formats) and the length cap is fixed at 512 characters — do not change either to accommodate a field list.
   - **Price as-of resolution mechanism** (SQL predicate vs per-batch snapshot) is undecided. Ask before implementing; do not copy the existing pull-all-and-filter-in-JS repository pattern, which does not scale to 50,000 records.
4. **Fail closed.** A conservative default is acceptable only for genuinely cosmetic choices — a log message's wording, a variable name. Anything touching money, uniqueness, grants, retention or alarm severity is never cosmetic.
5. **Record the resolution in the owning document** (§7) before the unit ships, so the next agent does not re-ask.
6. **If the spec and the codebase disagree, stop.** Do not "fix" either to match without confirming which is correct. Four decisions in this module were reversed by evidence from the codebase; assume the same could be true of the one in front of you.

---

## 6. Files You Must Not Modify Without Explicit Instruction

General §5 applies in full. In addition, do not edit, weaken, regenerate or "improve" any of these unless the request says to, by name:

1. **The live-row uniqueness constraint** `UNIQUE (partition_period, udr_key, is_live)`. *(PER_UNIT update, X2 — `start_datetime` dropped; authorized. Do not restore `start_datetime`, and do not tighten or loosen it further without a new authorization.)* Do not drop it, make it deferrable, add `udr_batch_run_num` to it, or replace it with an application check — including temporarily, including to make a test pass.
2. **The `is_live` generated column expression.** It is generated from `status` precisely so it cannot drift. Do not convert it to a maintained column.
3. **`db/bootstrap/rating-db-roles.sql`.** Grants are the rating/billing boundary. Widening one is a spec change.
4. **The `partition_period` CHECK and its single `rating.period_of()` helper, including its explicit `AT TIME ZONE` literal.** *(PER_UNIT update, X1 — the literal is now the config TZ `Asia/Kuala_Lumpur`, authorized by Khek 2026-09-30; `partition_period` is the billing month. Do not change the literal again without a new authorization.)* Removing the explicit zone makes the constraint session-dependent and silently wrong; changing the literal re-buckets stored periods (a re-partition, not an edit).
5. **`CHECK (char_length(udr_key) <= 512)`.**
6. **Applied migrations** (general §5.3) — and note that in this module a migration may carry a `pg_partman` registration; re-running it is not idempotent by default.
7. **The existing `pg_cron` maintenance schedule.** Register on it; never add a second `cron.schedule_in_database`.
8. **`event_catalog` rows already in production.** Changing an existing code's severity is a migration with a stated reason, not an edit.
9. **The pinned Kestra base image version** in the worker Dockerfile. Bumping it revalidates every flow and is its own unit.
10. **`services/accounts/money.ts`.** Do not modify it to accept more than 2 dp. The rating carve-out exists precisely so this file stays unchanged (`ratemgmt-code-standards.md` §2.2).
11. **Any `billing`, `product`, `ordering` or `inventory` table.** This module has `SELECT` only.

If a unit genuinely requires touching one of these, stop, explain why, and get explicit confirmation before proceeding.

---

## 7. Keeping Docs in Sync With Implementation

1. **Docs are part of the unit.** A unit is not done until the owning document matches the code.
2. **Route each fact to exactly one owner:**

| Change | Owning document |
| --- | --- |
| Scope, flow, feature, success criterion | `ratemgmt-project-overview.md` |
| Stack, boundary, storage, access model, Invariant | `ratemgmt-architecture.md` |
| Convention, constraint detail, grant table, guardrail test | `ratemgmt-code-standards.md` |
| Unit definition, workflow rule | this document |
| Design decision and its reasoning | `_newmodule-rating-engine-plan.md` |

3. **A new `event_code` ships with all three parts in one change set:** the seed row in `specs/rm02-event-catalog-seed.md`, which is the register (`ratemgmt-code-standards.md` §7 holds the rules, not the list); the `RATING_EVENT_CODES` constant; and the emitting flow. A code emitted without a catalog row fails the guardrail test.
4. **A new column ships with:** the Drizzle schema, the grant line if any role needs it, the column's row in `ratemgmt-project-overview.md`, and its test.
5. **A change to a constraint or a grant updates `ratemgmt-architecture.md`'s Invariants in the same change set.** These are the module's contract with the bill run.
6. **If a change contradicts `_newmodule-billrun-rating-workflow-plan.md`, fix that document too.** `ratemgmt-architecture.md` §7 already lists **eight** superseded statements, and **not all are yet corrected** in that document. Every one left uncorrected will mislead the billing module.
7. **Keep references, not copies.** Link the owning section; do not restate it. Column detail lives in the overview; do not duplicate it into the code standards.
8. **Never let docs drift.** If you cannot update the owning document in the same change, do not ship the change.

---

## 8. Verification Checklist — Before the Next Unit

Run every check. Do not assume. **General §8 items 3, 4 and 9 (route × level matrix, page guards, permission mapping) do not apply** — this module has no routes, pages or permissions. Everything else applies, plus:

**Always**

1. **Spec match** — exactly what the docs authorize, no more. No speculative addition from §3.
2. **Build green** — `tsc --noEmit`, ESLint, Prettier for the app-repo slice; flow definitions parse and deploy for the rating-repo slice.
3. **Guardrail tests** from `ratemgmt-code-standards.md` §10 that are in scope for this unit pass, against a **live database**, not mocks.
4. **Migrations** new, ordered, committed; no edits to applied migrations; no manual DDL.
5. **Docs in sync** — the owning document updated in the same change set (§7).
6. **No forbidden edits** (§6); no secret added; no `console.*`; no `TODO` in a flow definition.
7. **Diff minimal** — only planned files; no drive-by edits; the change set does not span both repositories (§2.2).

**When the unit touches the schema**

8. **The live-row constraint still rejects a second live row**, proven by a test that deliberately omits the supersede step and asserts the transaction aborts.
9. **No cross-schema foreign key** was introduced in either direction.
10. **No role gained `DELETE` on `udr_rated`**, and `app_runtime`'s update grant still covers exactly six columns, asserted per column.
11. **`partition_period` CHECK** behaves identically under at least three session timezones.

**When the unit touches a pipeline component**

12. **No per-record fan-out** — task count is bounded by chunk count, not record count.
13. **The RL transaction boundary is intact** — guard, supersede and insert are one transaction.
14. **Archive-after-commit ordering holds** — a simulated failure leaves the file in `landing/` and zero rows loaded.
15. **Every emitted `event_code` resolves in `event_catalog`**; `INDETERMINATE` count is zero.
16. **Reject volume is proportionate** — N rejected records produce one summarised log row, not N.

**When the unit touches price resolution**

17. **Every resolved input is snapshotted onto the row** — a record re-rated after the price row and override have changed reproduces the original amount.

If any item fails, the unit is not done. Fix it now; never defer a failure to a later unit.
