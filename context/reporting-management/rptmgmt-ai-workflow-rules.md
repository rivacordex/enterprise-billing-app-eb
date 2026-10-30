# Reporting Management Module — AI Workflow Rules (Module Supplement)

These rules **supplement `context/ai-workflow-rules.md`** and state **only what Reporting Management changes or adds**. Obey the general rules unless a numbered rule below overrides one explicitly.

**Precedence.** `rptmgmt-architecture.md` Invariants → `rptmgmt-project-overview.md` → `rptmgmt-architecture.md` → `rptmgmt-code-standards.md` → this document → `context/ai-workflow-rules.md`. Never weaken a rule from a higher-precedence document.

**Read this first.** This module has **no pages, no Server Actions, no components, no permissions and no tables**. General §7 (front-end pages carry permissions) and the route × level matrix do not apply; §8 below replaces the checklist. Report logic lives in `workflow-management/` (flows and the worker's `runtime/reporting/`), never in the Next.js app.

---

## 1. Operating approach

1. **Name the authorizing decision before you write anything:** a decision ID in `_newmodule-reporting-plan.md`, an Invariant in `rptmgmt-architecture.md`, or a rule in `rptmgmt-code-standards.md`. No decision, no mandate: stop and ask (§5).
2. **Never write report logic into the app.** If a change selects, signs, sums or formats data for a report file, it belongs in `runtime/reporting/`.
3. **Never edit a flow in the Kestra UI.** Every change is a commit, deployed from the repository.
4. **Assume the reader parses strictly.** Mediation, the CSP and Oracle read by position or exact header. A cosmetic change to a file is a breaking change.
5. **Assume a past date will be re-run.** Every unit must reproduce the same file for the same input.

## 2. Units — one at a time

1. **The unit list is `specs/rpt00-build-plan.md`, and it is the only copy.** Don't restate it elsewhere.
2. **Specs are written one at a time, in unit order.** No parallel drafting.
3. **One unit per pass.** Don't start the next until the current passes §8.
4. **Slice in this order within a unit:** grants → column definition → runtime (extract → builder → main) → flow → tests → docs.
5. **Don't build a later unit's behaviour early.** Schedules, folder delivery for Parts A/C/D/E, PGP and the app trigger wait for their open items.

## 3. Scoping — no speculative changes

1. **Don't add a database write, table, column or view** to make a report easier. Raise it as a change to the owning module (Billing, Accounts, Product, Customer, Rating).
2. **Don't add a column, reorder columns, rename a header or change a format** without an owner decision recorded in the plan and agreement from the file's reader.
3. **Don't widen the grant list beyond what the unit's report reads.**
4. **Don't decide an open item in code.** Use the plan's current handling and leave the item open (e.g. OI-5 blank payment mode, G-OI2 GL code on every row, P1 fixture capacity).
5. **Don't add an app registry entry, page, route or permission.** The registry entry arrives with the billing spec for I-OI3 (RF5).
6. **Don't reuse billing's retired bm62 CSV code** for the invoice CSV (IC24).

## 4. When to split into smaller steps

Split when a unit both adds grants on a new schema and builds a report, or when a shared `common/` module changes in a way that affects a report already built. Re-run every built report's tests after a `common/` change.

## 5. Missing or ambiguous requirements

Ask the owner one question at a time. Record "not sure" as an open item in the plan's Open items table with its current handling, and list open items before building.

## 6. Files you must not modify without explicit instruction

1. **The column definitions** in `flows/reporting/contracts/` once a reader consumes the file.
2. **`common/receivables.py`'s sign table** (SR18, GL8) and **`common/polygon_lines.py`** (IC22). Both are shared by several reports.
3. **The reporting role file** in `db/bootstrap/`. Widening a grant is a spec change.
4. **Any other module's table, role file, repository or service**, including `services/billing/engine-registry.ts` and `rated-lines.repository.ts`.
5. **The pinned Kestra base image and the worker Dockerfile**, beyond adding a library the unit's spec names.
6. **Kestra secrets** (`GLFEED_ZIP_PASSWORD`, the DB credential): never printed, logged or committed.

## 7. Keeping docs in sync

| Change | Owning document |
|---|---|
| Report scope, feature, success criterion | `rptmgmt-project-overview.md` |
| Boundary, storage, access model, Invariant | `rptmgmt-architecture.md` |
| Convention, file format, outcome code, grant, guardrail test | `rptmgmt-code-standards.md` |
| Unit definition | `specs/rpt00-build-plan.md` |
| Workflow rule | this document |
| Design decision and its reasoning; open items | `_newmodule-reporting-plan.md` |
| Platform placement (engine, topology, role on the platform) | `context/workflow-management/wfm-architecture.md` §10 |

Keep references, not copies. A unit isn't done until its owning documents match the code.

## 8. Verification checklist — before the next unit

1. **Spec match:** exactly what the spec authorizes; nothing from §3.
2. **Build green:** flows parse and deploy to a local Kestra; Python lint and tests pass; the `db/bootstrap` role file applies cleanly.
3. **Tests against a live seeded database,** not mocks: the unit's test cases from the plan and the guardrails in `rptmgmt-code-standards.md` §9 that are in scope.
4. **Every built report still passes** its tests if `common/` changed.
5. **Reproducible:** two runs for the same input give identical files.
6. **Nothing published on failure:** a forced output-check failure leaves no outputs and nothing in `outbound_dir`.
7. **Docs in sync** (§7); no secret added; no forbidden edit (§6); diff limited to planned files.
