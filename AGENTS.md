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
 

## Reporting Module Context

Read the following files in order before implementing or making changes related to the Reporting Management module — the read-only report flows that run as function 4 on the Kestra workflow-management platform. Current unit: rpt01, the `reporting` namespace, the `reporting_runtime` read-only role, deploy wiring and the outbound share (spec: `context/reporting-management/specs/rpt01-namespace-role-and-outbound.md`). The unit list and build order are in `context/reporting-management/specs/rpt00-build-plan.md`:

1. `context/reporting-management/rptmgmt-project-overview.md` — the module's definition, goals, the five reports and scope
2. `context/reporting-management/rptmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/reporting-management/rptmgmt-code-standards.md` — implementation rules and conventions
4. `context/reporting-management/rptmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach

This module has no pages, Server Actions, components, permissions or tables, so it has no UI context document. Report logic lives in `workflow-management/` (flows and the worker's `runtime/reporting/`), never in the Next.js app.

Update `context/reporting-management/rptmgmt-progress-tracker.md` after each meaningful implementation change.

Read also the general context documents to support the changes as referenced by the context files above:
1. `context/architecture.md` — system structure, boundaries, storage model, and invariants
2. `context/workflow-management/wfm-architecture.md` — the Kestra platform, topology and engine registry (reporting is function 4, §10)
3. `context/code-standards.md` — implementation rules and conventions
4. `context/ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach

 
