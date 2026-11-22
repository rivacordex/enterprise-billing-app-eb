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
 

## Product Module Update Context — Part 6: Normalize Spec Characteristics & Price Components (pm69–pm75, incl. pm74b)

Current phase: **Part 6 of the Product Management module**. It replaces the two `product` jsonb columns (`product_specifications.product_spec_characteristics` and `product_offering_price.price_component`) with six relational tables plus the `product.offering_price_v` read view, in migration `0056`. The `PricingComponent` envelope stays the API/UI contract and is reassembled in the repository. This is a **storage-only** change: no page, Server Action, route, permission, nav entry or audit event type changes. The price form checks quantity text before converting it to a number. Parts 1–5 (pm01–pm68) are complete. **pm69 and pm70 are built; start with pm71**, the price repository. The G-N5 window remains open through pm73. The unit list, gates (G-N1–G-N7), doc conflicts (C11–C21), dependency graph and hand-offs are in `context/product-management/specs/pm00-build-plan.md` **Part 6**. Each unit's spec is `context/product-management/specs/pm69-…` through `pm75-…`.

Read the following files in order before implementing or making any architectural decision related to the Product Module:

1. `context/product-management/prodmgmt-update-overview.md` — Part 6 definition, goals, and scope
2. `context/product-management/prodmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/product-management/prodmgmt-code-standards.md` — implementation rules, conventions, and guardrails
4. `context/product-management/prodmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach
5. `context/product-management/specs/pm00-build-plan.md` (Part 6) — units, gates, conflicts, and sequencing
6. `context/product-management/prodmgmt-progress-tracker.md` — current status, recurring patterns, and permanent lessons
7. The spec for the unit being built (`context/product-management/specs/pm71-…` onward)

Also consult `context/product-management/prodmgmt-issues-tracker.md` (known defects) and `context/product-management/prodmgmt-completed-tracker.md` (delivered units pm01–pm68) when relevant. Part 6 has no UI change, so `prodmgmt-ui-context.md` is needed only if a unit unexpectedly touches the UI.

Cross-module units: **pm74** rewrites the bill-run flow and `rp.py` (Rating) to read `product.offering_price_v` (gate G-N4). **pm74b** rewrites the reporting worker's `gl_feed/gl_codes.py` and `extract.py` and owns the `reporting_runtime` grant decision (gate G-N7, owned by Reporting Management). Before either unit, also read `context/workflow-management/wfm-architecture.md` and the owning module's architecture doc (e.g. `context/reporting-management/rptmgmt-architecture.md`).

Update `context/product-management/prodmgmt-progress-tracker.md` after each meaningful implementation change. Write a unit's entry there in full while it is in flight, and move it to `prodmgmt-completed-tracker.md` when the unit completes.

Read also the general context documents to support the changes as referenced by the context files above:
1. `context/architecture.md` — system structure, boundaries, storage model, and invariants
2. `context/code-standards.md` — implementation rules and conventions
3. `context/ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach

## Reporting Module (paused)

rpt01–rpt05 and rpt07–rpt09 are built. rpt06 is blocked on the P1 (and P2) decision and has no spec. Status is in `context/reporting-management/specs/rpt00-build-plan.md` and `context/reporting-management/rptmgmt-progress-tracker.md`. For any reporting change, read the four `context/reporting-management/rptmgmt-*.md` docs first: project overview, architecture, code standards, and AI workflow rules.

 
