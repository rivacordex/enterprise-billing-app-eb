<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

 
## Products Module Building Context

Read the following files in order before implementing
or making any architectural decision related to Products Module update for Ordering and Subscription:

1. `context/product-management/prodmgmt-project-overview.md` — product definition, goals, features, and scope (catalog + Ordering/Inventory, all three phases)
2. `context/product-management/prodmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/product-management/prodmgmt-ui-context.md` — theme, colors, typography, and component conventions
4. `context/product-management/prodmgmt-code-standards.md` — implementation rules and conventions
5. `context/product-management/prodmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach
6. `context/product-management/prodmgmt-completed-tracker.md` — the delivered build record (per-unit deliverables pm01–pm34, recurring patterns, permanent lessons)

Update `context/product-management/prodmgmt-completed-tracker.md` after each meaningful implementation change.

