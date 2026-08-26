# Rating Management Module — AI Workflow Rules (Module Supplement)

These rules **supplement `context/ai-workflow-rules.md`** (the binding workflow rules every module inherits — spec-driven work, one unit at a time, no speculative changes, how to clarify, how to verify, how to keep docs in sync) and state **only what the Rating Management module changes or adds**. Obey the general rules unless a numbered rule below overrides one explicitly.

**Precedence.** `ratemgmt-architecture.md` Invariants → `ratemgmt-project-overview.md` → `ratemgmt-architecture.md` → `ratemgmt-code-standards.md` → this document → `context/ai-workflow-rules.md`. Never weaken a rule from a higher-precedence document.

**Read this first.** This module has **no pages, no Server Actions, no components, and no permissions**. General §7 ("Front-End Pages Must Carry Permissions") **does not apply and has no module equivalent** — do not invent one. The general verification checklist's route × level matrix likewise does not apply; §8 below replaces it. Rating logic lives in **Kestra flow definitions in a separate repository**, not in the application.

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

1. **Do not implement rate types beyond `FLAT`.** The enum is defined to the full set (`PER_UNIT`, `TIERED_GRADUATED`, `TIERED_VOLUME`, `BLOCK`, `PERCENTAGE`, `ZERO_RATED`) so the schema is not locked in. Implementing their calculation is out of scope for v1 and is a spec change, not a unit.
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

1. **The live-row uniqueness constraint** `UNIQUE (partition_period, start_datetime, udr_key, is_live)`. Do not drop it, make it deferrable, add `udr_batch_run_num` to it, or replace it with an application check — including temporarily, including to make a test pass.
2. **The `is_live` generated column expression.** It is generated from `status` precisely so it cannot drift. Do not convert it to a maintained column.
3. **`db/bootstrap/rating-db-roles.sql`.** Grants are the rating/billing boundary. Widening one is a spec change.
4. **The `partition_period` CHECK and its single `rating.period_of()` helper, including the explicit `AT TIME ZONE 'UTC'` literal.** Removing or changing the literal makes the constraint session-dependent and silently wrong, and re-buckets stored periods.
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
