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
 

## Customer Management Update Context — Invoice Template Binding (cm17–cm22)

Current phase: Customer Management Phase 2, the Invoice Template Binding update (cm17–cm22, in progress).
The Billing Invoice Template update (bm47–bm63) is complete and signed off at the bm63 ship gate.

Read the following files in order before implementing
or making any architectural decision related to the Customer Management Module:

1. `context/customer-management/custmgmt-update-overview.md` — current update's definition, goals, features, and scope
2. `context/customer-management/custmgmt-project-overview.md` — product spec: overview, core user flow, in/out of scope, success criteria
3. `context/customer-management/custmgmt-architecture.md` — system structure, boundaries, storage model, and Module Invariants (§7 update deltas)
4. `context/customer-management/custmgmt-ui-context.md` — theme, colors, typography, and component conventions
5. `context/customer-management/custmgmt-code-standards.md` — implementation rules and conventions
6. `context/customer-management/custmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach (§9 binding-update rules)
7. `context/customer-management/custmgmt-progress-tracker.md` — current phase, completed work, open questions, and next steps
8. `context/customer-management/specs/cm00-build-plan.md` — unit list in build order; per-unit specs in `context/customer-management/specs/cm*.md`

Update `context/customer-management/custmgmt-progress-tracker.md` after each meaningful implementation change.

Read these Billing and Accounting docs as read-only references; do not edit them in this update (`custmgmt-ai-workflow-rules.md` §9):
1. `context/billing-management/billmgmt-architecture.md` — Inv. #41–#44 (template stamping at posting, resolution order, append-only versions)
2. `context/accounting-management/acctmgmt-architecture.md` — `billing_account` ownership and onboarding
3. `context/billing-management/billmgmt-known-issues.md` — §13 (DB-gated tests rewrite role passwords; use a disposable Postgres), §21 (baseline test failures are reported, never fixed inside a feature unit)

Read also the general context document to support the changes as referenced by the context files above:
1. `context/architecture.md` — system structure, boundaries, storage model, and invariants  
2. `context/code-standards.md`— implementation rules and conventions
3. `context/ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach
4. `context/ui-context.md` — theme, colors, typography, and component conventions

 
