# Customer Management — AI Workflow Rules (Module Supplement)

This document supplements `../ai-workflow-rules.md` (binding for all modules — read it first); everything there applies unchanged to the **Customer Management Module**, and the deltas specific to this module are: **no `DELETE` permission level is seeded** — the general doc's `DELETE ⊃ EDIT ⊃ READ` hierarchy (§7.7) collapses to **READ/EDIT only** here, so every destructive action (a status-transition "delete," a contact hard-delete) is gated at **EDIT**, never DELETE; **a single customer-scoped optimistic-lock column** (`party_role.last_modified_datetime`) covers organization + role + contact mutations together, not one lock per table or per action; and **`contact_medium` is the module's one sanctioned physical-delete path**, a documented, narrow exception to the platform's soft-delete-by-status default used everywhere else in this module. Everything else — units, splitting, ambiguity handling, protected files, doc sync, verification — follows the general doc unchanged except where restated below.

**Companion docs (authoritative — do not restate or contradict):**

- `custmgmt-project-overview.md` — product spec: user flows, two pages (View/Manage Customer), 3-table data model, lifecycle maps, in/out of scope, success criteria.
- `custmgmt-architecture.md` — technical design deltas: `customer` schema, permission matrix (§4), 18 numbered **Module Invariants** (§6; #11–#18 belong to the Invoice Template Binding update), update deltas (§7).
- `custmgmt-code-standards.md` — module coding conventions, file tree (§7), permission map (§8), guardrail tests (§9).
- `custmgmt-update-overview.md` + `_updatemodule-customer-accounts-invoice-template-binding-plan.md` — the planned **Invoice Template Binding update**: scope, user flows, decisions **D1–D16**, test matrix (plan §11). Its units are cm17–cm22 in `specs/cm00-build-plan.md` Phase 2; workflow rules for it are in §9 below.

**Precedence** per the general doc: module architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules. For the Invoice Template Binding update: Invariants #11–#18 → binding plan decisions D1–D16 → `custmgmt-update-overview.md` → architecture §7 → code-standards → §9 of this supplement.

---

## Application Building Context

Read the following files in order before implementing or making any architectural decision:

1. `context/customer-management/custmgmt-project-overview.md` — product definition, goals, features, and scope
2. `context/customer-management/custmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/customer-management/custmgmt-ui-context.md` — theme, colors, typography, and component conventions
4. `context/customer-management/custmgmt-code-standards.md` — implementation rules and conventions
5. `context/customer-management/custmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach (this document)
6. `context/customer-management/custmgmt-progress-tracker.md` — current phase, completed work, open questions, and next steps
7. For Invoice Template Binding work only: `context/customer-management/custmgmt-update-overview.md`, then `_updatemodule-customer-accounts-invoice-template-binding-plan.md` (decisions D1–D16, §9 tripwire, §11 test matrix)

Update `context/customer-management/custmgmt-progress-tracker.md` after each meaningful implementation change.

If implementation changes the architecture, scope, or standards documented in the context files, update the relevant file before continuing.

---

## 1. Operating Approach — Module Specifics

1. **Build full CRUD in v1** — unlike Product Management's read-only v1, `actions/customer/**` ships from day one: create, update, status-transition, contact add/update/delete, and set-preferred (contact and method) are all in scope now (overview _In Scope_, architecture §1).
2. **Cite the authorizing section before coding**, per the general doc §1.1 — an overview flow/feature, an architecture §2 folder row or Module Invariant, or a code-standards rule. No section, no mandate.
3. **Every mutation is one transaction: validate → mutate → audit → bump the optimistic lock** (architecture Inv. #6, code-standards §1.5). A mutation unit that lands only part of this chain is not done. **Lock scope:** customer-record mutations (organization, role/status, contacts, set-preferred) compare and bump `party_role.last_modified_datetime`; a Billing Account (BAN) change made from a customer screen, such as the template reset, compares and bumps the BAN's own `billing_account.last_modified` and never the customer's lock (architecture Inv. #17, decided 2026-10-10).
4. **Transition maps are the single source of truth.** `ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS` in `validation/customer/transitions.ts` are the only place next-states are declared; no page, component, or action hand-authors a status option list (code-standards §1.4, §2.2).

---

## 2. Units — One at a Time

> **Phase 1 — delivered (cm01–cm16).** The unit list below is the record of the original "simple customer" build and is kept for history. Do not rebuild these units. The active unit list for the Invoice Template Binding update is **§9.2**. Item 4 (Nav) is also **superseded** by the platform navigation rule: pages register in `NAV_REGISTRY` (`lib/nav-registry.ts`) with a `NAV_ICONS` glyph, and a page the viewer cannot access is **hidden**, not greyed (`context/architecture.md` §2, general doc §7.6).

Deliver these as separate units, in this dependency order (general doc §2). Do not start a unit until the previous one passes verification (§8 below) and is committed.

1. **DB foundation** — `customer` schema, 3 tables (`organization`, `party_role`, `contact_medium`), ID sequences (`ORG`/`PTRL`/`CTMD`), the partial unique index (one non-closed `party_role` per organization), the nullable-unique `registration_number`, the composite deferrable FK for the preferred-contact pointer, the `customers` PERMISSIONS row (READ/EDIT only), and the `CUSTOMER_SEARCH_RESULT_LIMIT` `SYSTEM_CONFIG` seed — one migration unit.
2. **Validation schemas** — `validation/customer/`: organization/party-role/contact-medium field schemas, `transitions.ts` maps, `specification.schema.ts` (JSON well-formedness only, no shape).
3. **Repositories + `services/customer`** — `search-customers`, `get-customer-detail`, `create-customer`, `update-organization`, `transition-organization-status`, `transition-customer-status`, `contact-mutations` (add/update/delete + preferred-pointer maintenance) — each its own reviewed step.
4. **Nav** — add the "Customer" section to `NAV_SECTIONS` in `components/admin-nav.tsx`; Manage Customer renders greyed/locked for USER.
5. **Pages, one at a time** — View search → View detail (Organization / Customer Role / Contact Details sections) → Manage search → Manage edit (org form, role/status, contact manager) → Manage new. Never more than one page or section per pass.
6. **Server Actions, one at a time** — `create-customer`, `update-organization`, `transition-organization-status`, `transition-customer-status`, `add-contact`, `update-contact`, `delete-contact`, `set-preferred-contact`, `set-preferred-contact-method`.
7. **Authz-matrix entries and module guardrail tests** (code-standards §9) — closes out the unit sequence.

Each Server Action in step 6 is its own **mutation unit** (general doc §3.3) with its own audit event and tests:

- create customer (organization + role)
- update organization
- transition organization status
- transition customer status
- add contact
- update contact
- delete contact (the module's one physical delete)
- set preferred contact
- set preferred contact method

---

## 3. Scoping — No Speculative Changes

1. **Do not add a `DELETE` permission level.** The module seeds `customers : READ/EDIT` only (architecture §4, code-standards §8). "Delete" is always a status transition or a contact hard-delete, both gated at EDIT — adding a DELETE level is a platform-level change requiring explicit instruction (general doc §2.8).
2. **Do not add shape or key validation to `party_role_specification`.** Well-formed-JSON-only is the design decision (Inv. #7); no `PartyRoleSpecification` interface, no Zod object schema, no enum on `CUST_TYPE`/`CUST_KEY`/`PARTY_TYPE`. Narrowing this needs a design review, not a unit.
3. **Do not add an FK, form field, or linkage logic to `party_role.account`.** It stays display-only (Inv. #9). The Account module now exists: reach a customer's Financial Account and BANs through the Accounts module's party-role key (`financial_account.ref_party_role_id`, Inv. #13), never through `party_role.account`.
4. **Do not build multi-value contact fields.** A second phone/email/address is a second `contact_medium` row, never an array or child table (overview _Out of Scope_).
5. **Do not build merge tooling, TMF/external APIs, or individual (person) customers.** All explicitly out of scope this release (overview _Out of Scope_).
6. **Do not fold a contact mutation into the org/role Server Action.** Each contact action (add/update/delete/set-preferred) is independent, independently permission- and lock-checked (code-standards §3.6).
7. **Respect layer boundaries while slicing.** Pages are thin orchestrators; `services/customer` has no `next/*` imports; SQL lives only in `db/**`.

---

## 4. When to Split

Apply the general doc §3 triggers, plus these module-specific splits:

1. **Split the migration from behavior** — schema, constraints, and seed rows (`customers` permission row, `SYSTEM_CONFIG` limit) land and are verified before repositories consume them.
2. **Split each Server Action** — organization update, each status transition, each contact mutation, each set-preferred call are separate units; never bundle two into one diff.
3. **Split each page/section** — search, detail (the tab shell first, then each tab's content), edit form, add-new page are separate units; don't deliver a whole page in one pass.
4. **Split every guardrail** (code-standards §9) into its own focused step with tests: authz matrix, transition-map edges, DB constraints, preferred-contact/method invariants, optimistic-lock conflict, audit trail, search correctness.
5. **When in doubt, split.**

---

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first, cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, lifecycle, or locking scope. Module-specific:

1. **Known deferred/accepted-risk decisions — do not resolve differently yourself:** `CUST_KEY` uniqueness/immutability is operator discipline, not a code path; the MERGED-status record-migration workflow is not built. If a unit seems to need one of these, stop and ask.
2. **Never invent a shape for `party_role_specification`.** It is validated for well-formed JSON only (Inv. #7); if a caller seems to need a named key, ask before adding any structure.
3. **Never guess a transition-map edge.** If a state pair isn't listed in `ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS`, treat it as forbidden; adding an edge is a lifecycle-affecting change — ask, don't default.
4. **Record every resolution** in the owning companion doc so the next agent doesn't re-ask (general doc §4.6).

---

## 6. Protected Files — Module References

Module-specific detail and additions to the general doc §5 list — don't touch without explicit instruction:

1. **`components/ui/`** — managed vendor layer; compose new components in `components/customers/` per the code-standards §7 file tree.
2. **`validation/customer/transitions.ts`** — the one place transition maps live; no page, component, or action re-declares a next-state list (code-standards §1.4, §7.2).
3. **Applied migrations** — forward-only; the partial unique index, nullable-unique `registration_number`, and composite deferrable FK ship in the module's own migration, never by editing an applied one.
4. **Permission registry mechanism** — the `customers` row (READ/EDIT only) comes only from the committed migration; don't seed a DELETE level or any other row without explicit instruction.
5. **`validation/customer/specification.schema.ts`** — the JSON-well-formedness-only exemption (Inv. #7, code-standards §1.8); narrowing or removing it needs a design review, not a unit.
6. **The `contact_medium` delete path** — the delete repository function must never be reachable without the preferred-contact-not-pointed-at check passing first (Inv. #4); don't add a bypass or a "force delete."
7. **`tsconfig.json` strict flags, ESLint/Prettier, CI (`infra/**`)** — never weaken a gate to pass a build.
8. **Lockfiles and dependencies** — any change is its own requested unit.
9. **Companion-doc decisions** — including the Module Invariants and the JSONB exemption statement (code-standards §1.8) — propose and get approval before changing.
10. **Secrets** — never commit or read a real secret from repo, image, or DB.

If a unit genuinely requires touching one of these, stop, explain why, and get explicit confirmation.

---

## 7. Keeping Docs in Sync With Implementation

Per the general doc §6, plus:

1. **Permission map** — any page or action change ships with matching rows in `custmgmt-architecture.md` §4 and `custmgmt-code-standards.md` §8 in the same change set.
2. **Registry + map + guard together** — the `customers` PERMISSIONS migration row, the map rows, the typed constant, and the page guard land as one traceable set.
3. **Transition-map changes reflected in two docs at once** — any edit to `ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS` updates both the architecture Module Invariants (§6) and the overview's lifecycle description in the same change.
4. **The JSONB exemption statement is a fact owned jointly** — code-standards §1.8 and architecture Inv. #7 must always agree; a change to one without the other is drift.
5. **Owning doc per fact:** product behavior → overview; schema/Invariant → architecture; convention/component names → code-standards; workflow → this doc. Reference, don't copy.
6. **Component names are binding** — create exactly the components named in code-standards §4 and the §7 file tree, or the page↔route↔component↔permission chain breaks.

---

## 8. Verification Checklist — Before the Next Unit

Run the full general doc §8 checklist, with these module readings and additions. Don't start the next unit until every item passes.

1. **Guardrail tests pass** — all from code-standards §9: authz matrix, full core flow, transition-map edges (incl. every valid transition submitted without `status_reason` rejected), DB constraint tests (partial unique index, `registration_number`, composite FK), preferred-contact/method invariants, optimistic-lock conflict, audit trail, search correctness.
2. **Authorization** — `requirePermission('customers', 'READ'|'EDIT')` at the top of every page; confirm no DELETE check exists anywhere (none is seeded); a USER is rejected server-side on every `actions/customer/*` call even if the nav is bypassed. On View Customer, the Accounts tab content renders only with `accounts_view : READ` and fetches nothing without it. Any action a customer screen calls under `actions/accounts/*` (onboarding, the template reset) re-checks **both** `customers : EDIT` and `accounts_transactions : EDIT` server-side.
3. **Optimistic lock** — every customer-record mutation (organization, role/status, contacts, set-preferred) reads-compares-bumps `party_role.last_modified_datetime` in its own transaction; a BAN change made from a customer screen (the template reset) reads-compares-bumps `billing_account.last_modified` and leaves `party_role.last_modified_datetime` untouched (Inv. #17). A stale save returns the typed `CONFLICT` result and a reload-prompt UI, never a silent overwrite.
4. **Audit** — mutation + `AUDIT_LOG` insert in one transaction, actor/timestamp/entity/before-after; status changes additionally persist `status_reason` on the row itself, not only in audit history.
5. **Data layer** — SQL only in `db/**`; `contact_medium` delete blocked while it's the pointed-at preferred contact; `party_role_specification` validated for well-formed JSON only, never a shape schema.
6. **Migrations correct** — new, ordered, committed; the `customers` PERMISSIONS row and `SYSTEM_CONFIG` seed ship with the schema in one migration; no edits to an applied migration.
7. **No forbidden edits** — nothing from §6 above touched without instruction; no DELETE permission level added; no `TODO`, commented-out code, or `console.*` on the branch.
8. **Diff is minimal and reviewable** — only planned files changed; no drive-by edits.

If any item fails, the unit isn't done. Fix it before moving on; never defer a failure to a later unit.

---

## 9. Invoice Template Binding update — workflow rules (2026-10-10)

These rules apply only to the Invoice Template Binding update (`custmgmt-update-overview.md`, binding plan D1–D16). They add to §1–§8 above and to `../ai-workflow-rules.md`; nothing above is relaxed. The update is **plumbing only**: the customer record shows, confirms at onboarding, and resets a per-BAN template reference that posting ignores, and View Customer becomes tabbed with a read-only Accounts tab.

### 9.1 Operating approach

1. **Cite a decision or invariant for every change.** Before each unit, name the binding-plan decision (D1–D16) or `custmgmt-architecture.md` Invariant (#11–#18) that authorizes it. No citation, no change.
2. **Treat Billing and Accounts docs as read-only references.** Read `billmgmt-architecture.md` (Inv. #41–#44) and `acctmgmt-architecture.md` for the facts you depend on. Do not edit them in this update; raise any needed change.
3. **Build to the plan's test matrix.** Each unit ships the rows of plan §11 that cover it. Do not mark a unit done with a matrix row missing.
4. **Run every DB-gated test on a throwaway Postgres marked disposable.** Never point a test run at the shared dev stack: the DB-gated suites rewrite cluster-level role passwords (`billmgmt-known-issues.md` §13).

### 9.2 Units — deliver in this order, one at a time

The unit list of record is `specs/cm00-build-plan.md` Phase 2 (cm17–cm22). Build each unit exactly as that plan describes it; this table is the index.

| Unit | Name                                                                    | Boundary | Authorized by                                   | Depends on          |
| ---- | ----------------------------------------------------------------------- | -------- | ----------------------------------------------- | ------------------- |
| cm17 | Billing Account template reference column (migration + Drizzle mirror) | DB       | D9, D10                                         | delivered ac02, bm50 |
| cm18 | Onboarding wizard "Invoice template" field + `assertBindableTemplate`    | APP      | D2, D11, D13, D15, Inv. #18                     | cm17                |
| cm19 | View Customer tab shell (Profile · Contacts · Accounts placeholder) + rewritten page test | APP | D5, Inv. #14                        | delivered cm05      |
| cm20 | View Customer Accounts tab + `getCustomerAccountsSummary` + template-label resolver | APP | D6, D7, D8, D11, D14, D16, Inv. #12, #13, #15 | cm19, cm17          |
| cm21 | Manage Customer Billing account panel + `set-billing-account-template` service and action | APP | D3, D12, D15, Inv. #16, #17       | cm18, cm20, cm17    |
| cm22 | Ship gate: boundary guardrails, service-level journey test, posting-unchanged re-run, docs close-out | TESTS | Inv. #11, #18, plan §11                 | cm17–cm21           |

Do not start a unit until the previous one passes §9.8 and is committed. cm19 may be built before or alongside cm17/cm18 because it depends only on delivered cm05; nothing else may be reordered.

### 9.3 Scoping — do not build these

1. **Do not offer, accept or store a non-`NULL` template value.** v1 is `NULL`-only (D13). Do not add a template picker with more than *Follow active template*, and do not relax `assertBindableTemplate`.
2. **Do not build a template catalog, a template-line identifier, or a CSV/layout binding.** All are Phase 3 (`TODOS.md`).
3. **Do not touch posting or rendering.** Do not edit `services/billing/**` (including `post-run.ts` and `invoice-template/resolve-template.ts`), `db/repositories/billing/customer-bill*`, or `workflow-management/**`. Do not make anything at posting read the new column (D4).
4. **Do not add a permission.** Compose `customers`, `accounts_view` and `accounts_transactions` as specified (Inv. #12, #16).
5. **Do not add posting, reversal, payment or other transaction actions to the Accounts tab.** Link to the Accounts module instead (D6).
6. **Do not locate accounts through `party_role.account`.** Resolve them by party-role key on the account side (Inv. #13); `party_role.account` stays display-only (Inv. #9).
7. **Do not bump `party_role.last_modified_datetime` on a template reset.** Lock the BAN row (Inv. #17).
8. **Do not convert View Customer to a client component** and do not add a tabs library. Use `searchParams` on the server component (Inv. #14).
9. **Do not change `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection`, the not-found card, `metadata.title`, or the `isStatusInconsistent` rule.** Move them into tabs as they are.
10. **Do not build additional-BAN creation, BAN filters or multi-BAN management.** List every BAN the summary service returns; nothing more (O2 closed).
11. **Do not fix the failing baseline tests inside a feature unit** (`billmgmt-known-issues.md` §21). Report them; fix each as its own requested change.

### 9.4 When to split

Apply §4 and the general doc §3, plus:

1. **Keep each cm unit whole.** A unit merges pieces with no standalone visible result (the validator in cm18; the summary service and label resolver in cm20; the reset service and action in cm21). Do not ship those pieces as separate units. Inside a unit, build and commit in the general doc order (validation → db → service → action → UI → tests), keeping every commit green.
2. **Land the migration (cm17) alone,** verified before any service reads the column.
3. **Ship the tab shell (cm19) without the Accounts tab content,** with a placeholder that renders nothing for `tab=accounts`. Ship the content in cm20.
4. **Rewrite `tests/app/customers-view-detail-page.test.tsx` in cm19.** The old "renders all three section titles" assertion fails once Contacts moves tabs; never leave it red between units.
5. **Split a unit further only when it breaks a §3 trigger of the general doc** (for example, the diff cannot be explained in a few sentences). Stop and propose the split; do not invent new unit numbers.

### 9.5 Missing or ambiguous requirements — stop and ask

1. **Stop and ask on the open items; do not choose a default:** O1 (control copy and placement), O3 (`system_config` key and default for the page size), O4 (final audit event-type name).
2. **Never invent a template-line identifier or a meaning for a non-`NULL` value.** Any question about how a bound template reaches an invoice is Phase 3; stop and raise it.
3. **Treat any need to edit an Accounts-owned or Billing-owned file not listed in §9.2 as a scope question.** Stop and ask.
4. **Never resolve a conflict between this module's docs and `billmgmt-*` / `acctmgmt-*` docs yourself.** Flag it with both citations.

### 9.6 Protected files for this update

In addition to §6, do not modify without explicit instruction:

1. `services/billing/**`, `db/repositories/billing/customer-bill*`, `db/schema/billing/bill-template-version.ts`, `workflow-management/**`.
2. Applied migrations, including `0046`–`0048`. Add cm17 as a new forward migration.
3. `services/customer/get-customer-detail.ts` and `validation/customer/transitions.ts`.
4. `components/accounts/edit-access.ts` and `services/accounts/list-transaction-documents.ts` — reuse them unchanged.
5. `auth/guard.ts` and `auth/permission-constants.ts` — no new permission constant.
6. `components/ui/` — compose the tab strip and panel in `components/customers/`.
7. `billmgmt-*.md` and `acctmgmt-*.md` context docs, and `TODOS.md` (the Phase 3 entry stays as written).

### 9.7 Keep documentation in sync

Update, in the same change set as the code that changes them:

1. **`custmgmt-architecture.md` §7 and Invariants #11–#18** — any change to a boundary, a guard, a storage fact or a rule.
2. **`cm05` (View Customer spec) and `custmgmt-project-overview.md` *Features*** — together, when the tab shell and Accounts tab land (`cm05` requires both docs to move together).
3. **`custmgmt-code-standards.md` §8 permission map and §7 file tree** — when the action, panel, tab components or the `accounts_view` sub-gate land.
4. **`custmgmt-update-overview.md`** — move its **Status** from Planned to Delivered only after cm22 passes.
5. **`custmgmt-progress-tracker.md`** — after every unit.
6. **Accounts-side docs (`ac04` onboarding spec, `acctmgmt-architecture.md` `billing_account` row)** — draft the change and get approval before editing (§9.6 item 7).

### 9.8 Verification checklist — before the next unit

Run §8 and the general doc §8, then confirm each of these for the unit:

1. **`NULL`-only holds.** A non-`NULL` id to onboarding or the reset action returns `TEMPLATE_NOT_BINDABLE` and writes nothing.
2. **Posting is unchanged.** No file under `services/billing/**` references `ref_bill_template_version_id` on `billing_account`; the existing bm18/bm19/bm54 stamp tests pass.
3. **Permissions compose correctly.** Page guards unchanged (`customers : READ` view, `customers : EDIT` manage); the Accounts tab fetches nothing without `accounts_view : READ`; the reset action rejects a user missing either `customers : EDIT` or `accounts_transactions : EDIT`, even with the UI bypassed.
4. **The reset service is correct.** `BAN_NOT_FOUND`, `BAN_CLOSED` and `CONFLICT` are returned in their cases; an unchanged value writes no row and no audit event; `party_role.last_modified_datetime` is untouched.
5. **Onboarding is still atomic.** The V7 rollback test passes with the new field.
6. **The tabs behave.** Default `profile`; `?tab=contacts|accounts` deep-links; an invalid value falls back to `profile`; the banner shows above the strip on every tab; the rewritten page test passes.
7. **The Accounts tab reads, never writes.** Four states render; balances come from one query; Profile and Contacts issue no account query; the import-boundary guardrail passes.
8. **The label is honest.** `NULL` renders "Follows active template (currently: <name> vN), as of now" from a live lookup.
9. **Tests ran on a disposable database** and the plan §11 rows for the unit are present and green.
10. **Docs moved with the code** per §9.7; no Billing or Accounts doc edited without approval.
