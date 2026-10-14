<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!--
## Change Configuration
Read the following files in order before implementing
or making any architectural decision related to the change required

1. `context/_change-database-seeds-refactor-plan.md` 
2. `context/architecture.md` 

Update `context/general-change-tracker.md` after each meaningful general implementation change.
-->
 

## Rating Management Update Context — Raw `udr_key` and `udr_resource` (rm24–rm29)

Current phase: Rating Management Phase H, the raw `udr_key` and `udr_resource` cell-label update (rm24–rm29, starting with rm24).
Completed and signed off: Customer Management Phase 2, Invoice Template Binding (cm17–cm22, cm22 ship gate, 2026-10-14); Billing Invoice Template update (bm47–bm63, bm63 ship gate). Rating Phase G, PER_UNIT RAN-usage (rm14–rm23), is delivered (rm22 ship gate; rm23 delivered as billing bm48).

Scope: the RAN-usage rating runtime only — PRP (`prp.py`), RP (`rp.py`), RL (`rl.py`) of the `rating-engine-ran-usage` flow — plus sample seeds, rating tests and the document amendments in the plan §7. No schema change, no migration, no grant change, no billing code. Fresh database this round.

Read the following files in order before implementing
or making any architectural decision related to the Rating Management Module (`ratemgmt-ai-workflow-rules.md` §0.1 rule 2):

1. `context/rating-management/ratemgmt-update-overview.md` — current update's definition, goals, core flow, and scope
2. `context/rating-management/ratemgmt-project-overview.md` — product spec: overview, core flow, in/out of scope, success criteria
3. `context/rating-management/ratemgmt-architecture.md` — system structure, boundaries, storage model, and Module Invariants (Inv 27–28; amends 3, 14, 19, 26)
4. `context/rating-management/ratemgmt-code-standards.md` — implementation rules and conventions (§0.1 update deltas; §10 guardrail tests 17–20)
5. `context/rating-management/ratemgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach (§0.1 raw-key update rules — obey them as rules)
6. `context/rating-management/ratemgmt-progress-tracker.md` — current phase, completed work, open questions, and next steps
7. `context/rating-management/specs/rm00-build-plan.md` — unit list in build order (Phase H); per-unit specs in `context/rating-management/specs/rm*.md`

The source plan `_updatemodule-rating-udr-key-resource-plan.md` (decisions R1–R9) is not in this repo; cite its decision numbers as quoted in the docs above, and stop and ask when a change needs a decision they do not record (§0.1 rules 1, 15).

Update `context/rating-management/ratemgmt-progress-tracker.md` after each meaningful implementation change.

Read these docs as read-only references:
1. `context/workflow-management/wfm-architecture.md` — `workflow-management/**` layout (flows, worker, dev) where PRP/RP/RL live
2. `context/billing-management/billmgmt-architecture.md` — Inv #36 (per-polygon usage appendix) and #47 (render makes no ratecard query), the billing consumers of `udr_key` / `udr_resource`. Do not edit billing code or billing docs except the lines the plan §7 names (bm45 D2, bm48 G13/D2, billing Inv #36/#47, known-issues), and tell the billing owner which lines changed (§0.1 rule 21)
3. `context/billing-management/billmgmt-known-issues.md` — §13 (DB-gated tests rewrite role passwords; use a disposable Postgres), §21 (baseline test failures are reported, never fixed inside a feature unit)

Read also the general context document to support the changes as referenced by the context files above:
1. `context/architecture.md` — system structure, boundaries, storage model, and invariants  
2. `context/code-standards.md`— implementation rules and conventions
3. `context/ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach

 
