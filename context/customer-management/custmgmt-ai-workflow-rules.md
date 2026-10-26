# Customer Management — AI Workflow Rules (Module Supplement)

This document supplements `../ai-workflow-rules.md` (binding for all modules — read it first); everything there applies unchanged to the **Customer Management Module**, and the deltas specific to this module are: **no `DELETE` permission level is seeded** — the general doc's `DELETE ⊃ EDIT ⊃ READ` hierarchy (§7.7) collapses to **READ/EDIT only** here, so every destructive action (a status-transition "delete," a contact hard-delete) is gated at **EDIT**, never DELETE; **a single customer-scoped optimistic-lock column** (`party_role.last_modified_datetime`) covers organization + role + contact mutations together, not one lock per table or per action; and **`contact_medium` is the module's one sanctioned physical-delete path**, a documented, narrow exception to the platform's soft-delete-by-status default used everywhere else in this module. Everything else — units, splitting, ambiguity handling, protected files, doc sync, verification — follows the general doc unchanged except where restated below.

**Companion docs (authoritative — do not restate or contradict):**

- `custmgmt-project-overview.md` — product spec: user flows, two pages (View/Manage Customer), 3-table data model, lifecycle maps, in/out of scope, success criteria.
- `custmgmt-architecture.md` — technical design deltas: `customer` schema, permission matrix (§4), 22 numbered **Module Invariants** (§6; #11–#18 belong to the delivered Invoice Template Binding update, #19–#22 to the delivered Invoice Template Types update, which replaced #18), update deltas (§7 and §8, both delivered).
- `custmgmt-code-standards.md` — module coding conventions, file tree (§7), permission map (§8), guardrail tests (§9), and the Invoice Template Types deltas (§10, guardrails 11–13).
- The **Invoice Template Types update, Customer Management part** (cm23–cm24; bind a BAN to a template type) is **delivered (ship gate 2026-10-26, joint with Billing bm85)** and folded into `custmgmt-project-overview.md`. Its owning design (types, upload, activation, retire, export, capture) is Billing's. §10 below is its record. **No Customer Management update is in flight.**
- The **Invoice Template Binding update** (cm17–cm22) is **delivered and signed off (2026-10-25)** and folded into `custmgmt-project-overview.md`. §9 below is its record; the rules §10 supersedes are listed at the top of §9.
- `context/billing-management/billmgmt-ai-workflow-rules.md` — **binding on you** for every Billing-owned file this update touches.

**Precedence** per the general doc: module architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules. For the delivered Invoice Template Types code: Invariants #19–#22 (and Billing's #59–#68 for shared pieces) → `custmgmt-project-overview.md` for Customer Management screens and Billing's docs for everything Billing owns → architecture §8 → code-standards §10 → §10 of this supplement. **If the Customer Management and Billing docs disagree, stop and ask; never pick one yourself.** Planning documents (`_updatemodule-*.md`) are background only and never override these docs.

---

## Application Building Context

Read the following files in order before implementing or making any architectural decision:

1. `context/customer-management/custmgmt-project-overview.md` — product definition, goals, features, and scope
2. `context/customer-management/custmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/customer-management/custmgmt-ui-context.md` — theme, colors, typography, and component conventions
4. `context/customer-management/custmgmt-code-standards.md` — implementation rules and conventions
5. `context/customer-management/custmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach (this document)
6. `context/customer-management/custmgmt-progress-tracker.md` — current phase, completed work, open questions, and next steps
7. For work touching the delivered Invoice Template Types binding: `custmgmt-project-overview.md` › Invoice Template Types — Customer Management part, then `context/billing-management/billmgmt-project-overview.md` › Invoice Template Types (the owning design), then §10 of this document (the record)

Update `context/customer-management/custmgmt-progress-tracker.md` after each meaningful implementation change.

If implementation changes the architecture, scope, or standards documented in the context files, update the relevant file before continuing.

---

## 1. Operating Approach — Module Specifics

1. **Build full CRUD in v1** — unlike Product Management's read-only v1, `actions/customer/**` ships from day one: create, update, status-transition, contact add/update/delete, and set-preferred (contact and method) are all in scope now (overview _In Scope_, architecture §1).
2. **Cite the authorizing section before coding**, per the general doc §1.1 — an overview flow/feature, an architecture §2 folder row or Module Invariant, or a code-standards rule. No section, no mandate.
3. **Every mutation is one transaction: validate → mutate → audit → bump the optimistic lock** (architecture Inv. #6, code-standards §1.5). A mutation unit that lands only part of this chain is not done. **Lock scope:** customer-record mutations (organization, role/status, contacts, set-preferred) compare and bump `party_role.last_modified_datetime`; a Billing Account (BAN) change made from a customer screen, such as binding its template type, compares and bumps the BAN's own `billing_account.last_modified` and never the customer's lock (architecture Inv. #17, decided 2026-10-10).
4. **Transition maps are the single source of truth.** `ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS` in `validation/customer/transitions.ts` are the only place next-states are declared; no page, component, or action hand-authors a status option list (code-standards §1.4, §2.2).

---

## 2. Units — One at a Time

> **Phase 1 — delivered (cm01–cm16).** The unit list below is the record of the original "simple customer" build and is kept for history. Do not rebuild these units. §9 records the delivered Invoice Template Binding update and **§10** the delivered Invoice Template Types update. Item 4 (Nav) is also **superseded** by the platform navigation rule: pages register in `NAV_REGISTRY` (`lib/nav-registry.ts`) with a `NAV_ICONS` glyph, and a page the viewer cannot access is **hidden**, not greyed (`context/architecture.md` §2, general doc §7.6).

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

> **Delivered and signed off (2026-10-25). This section is the record.** Do not rebuild cm17–cm22. **Superseded by §10 (Invoice Template Types) — do not follow these items any more:** §9.3 items 1 and 2 (NULL-only, no catalog), §9.5 item 2 (non-`NULL` meaning is "Phase 3"), §9.6 items 1 and 7 (Billing files and docs off limits), and §9.8 items 1, 2 and 8 (NULL-only holds, Billing never references the column, the "Follows active template" label). Everything else in §9 stays true for the delivered code.

These rules applied to the Invoice Template Binding update (binding plan D1–D16; folded into `custmgmt-project-overview.md`). They add to §1–§8 above and to `../ai-workflow-rules.md`; nothing above is relaxed. The update is **plumbing only**: the customer record shows, confirms at onboarding, and resets a per-BAN template reference that posting ignores, and View Customer becomes tabbed with a read-only Accounts tab.

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

1. **Stop and ask on the open items; do not choose a default:** O1 (control copy and placement), O3 (`system_config` key and default for the page size), O4 (final audit event-type name). All three are now closed: O1 by cm18 (read-only "Follow active template" field with help text) and the cm21 reset control, O3 by cm20 (`CUSTOMER_ACCOUNTS_DOCUMENTS_PAGE_SIZE` = 20), O4 by cm21 (`BILLING_ACCOUNT_TEMPLATE_CHANGED`).
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
4. **`custmgmt-update-overview.md`** (since folded into `custmgmt-project-overview.md` and deleted) — move its **Status** from Planned to Delivered only after cm22 passes.
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

---

## 10. Invoice Template Types update — workflow rules (2026-10-25)

> **Delivered (cm23–cm24; ship gate 2026-10-26, joint with Billing bm85). This section is the record.** Do not rebuild cm23–cm24. **Carried forward — still binding for any later change to the delivered code:** §10.3 items 1–8 (Billing owns the type catalog; no onboarding choice, bulk-bind, version pin, new permission or audit event type), §10.5 item 1 (stop and ask), §10.6 items 3–4 (applied migrations including `0050` and `0054`; `components/ui/` and the auth files), and §10.8 items 1–3 and 5–8 (Standard is `NULL`, the gate locks, the boundary holds, locks and audit, live labels, permissions, onboarding atomic). **Spent with the ship gate:** §10.1 item 2 and §10.2 (the unit list), §10.4 (the cm23/bm82 merge), §10.6 items 1–2 and 5 (the update's file authorizations), §10.7 item 6 (the fold) and §10.8 item 4 (the migration check).

These rules apply to the Customer Management part of the cross-module **Invoice Template Types** update: bind a BAN to a template type. They add to §1–§8 and to `../ai-workflow-rules.md`. They **supersede** the §9 items listed at the top of §9. Billing owns the update; its rules are in `billmgmt-ai-workflow-rules.md`, and both supplements bind you.

### 10.1 Operating approach

1. **Cite an invariant or an overview section for every change:** Inv. #19–#22 (or #16–#17 as amended), a section of `custmgmt-project-overview.md` › Invoice Template Types — Customer Management part, or a code-standards §10 rule. For a shared piece, cite Billing's invariant (#59–#68). Never cite a planning document as the authority.
2. **Do not write code before its spec exists.** Write the cm23 and cm24 specs (`cm00` Phase 3), each naming its Billing counterpart ("Counterpart: bm82" / "bm85") both ways.
3. **Work cross-domain only through the named seams:**
   - Billing's **repositories** (`bill-template-family`, `bill-template-version`) for reads and `lockTemplateType`
   - the shared column migration, together with Billing's capture change

   Never import a Billing service or action, and never edit a Billing file outside §10.6 item 2.
4. **Assume a populated database.** The column migration runs on environments with real BANs and bills. Never edit `0050`, and never empty a table to make a test pass.
5. **Run DB-gated tests on a disposable Postgres** (§9.1 item 4 still applies).

### 10.2 Units — deliver in this order, one at a time

The unit list of record is `specs/cm00-build-plan.md` Phase 3 (written 2026-10-25). Build each unit exactly as it is described there; this table is the index. Do not renumber, merge, split or reorder them without owner approval.

| Unit | Visible result | Depends on |
|---|---|---|
| cm23 | Bind a BAN to a template type: `0054`, the type-aware bind gate, the panel select + Save, type labels, onboarding wording. **One merge with Billing bm82** (capture reads the type) | Billing bm74, bm77, bm78, bm79 |
| cm24 | Ship gate pointer, joint with Billing bm85 | cm23; Billing bm83, bm84 |

### 10.3 Scoping — do not build these

1. **Do not create, upload, activate, retire, export or preview template types** from a customer screen. That is Billing's Invoice Settings.
2. **Do not offer a type choice in onboarding.** The wizard writes `null`.
3. **Do not add a bulk-bind,** a "bind all BANs of this customer", or binding from Accounts-module screens.
4. **Do not pin a version.** A BAN references a type only.
5. **Do not add a permission,** an audit event type, a column on `customer` tables, or an index on the new column.
6. **Do not read or show layout files,** versions beyond the label's "vN", or a preview on customer screens.
7. **Do not touch bill-run stamps** (`bill_run_account`, `customer_bill`) or anything under `services/billing/**`.
8. **Do not change** the customer lock, the transition maps, `OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection` or the tab shell.

### 10.4 When to split

Apply §4 and the general doc §3, plus:

1. **cm23 and Billing's bm82 form one merge.** Inside cm23, commit in order (migration → gate → reads → panel), keeping every commit green, and land the merge only when bm82's capture read is in it.
2. **Inside cm23, build read before write:** the labels and type list first, then the select and Save.
3. **Keep the bind-gate lock test in cm23,** using Billing's lock helper. The full parallel run against retire lands with Billing's bm83.

### 10.5 Missing or ambiguous requirements — stop and ask

1. **Stop and ask** if a unit seems to need:
   - a Billing service or action import
   - a write to `billing_account` outside the three writers of Inv. #19
   - a new result code
   - a copy change beyond `billing-account-messages.ts`
   - a type list that includes retired or not-yet-usable types
2. **Never resolve a disagreement between `custmgmt-project-overview.md` (the folded Customer Management part) and `billmgmt-project-overview.md` › Invoice Template Types yourself.** Flag both citations.
3. **Record every resolution** in the owning doc in the same change: the screen → `custmgmt-project-overview.md`; a rule → `custmgmt-architecture.md`; a convention → `custmgmt-code-standards.md`.

### 10.6 Protected files for this update

In addition to §6, do not modify without explicit instruction:

1. **Authorized Customer Management and Accounts-side files only:**
   - `services/accounts/assert-bindable-template.ts`, `set-billing-account-template.ts`, `onboard-customer-accounts.ts`, `list-customer-billing-accounts.ts`, `get-customer-accounts-summary.ts`, `resolve-ban-template-label.ts`
   - the new `list-bindable-template-types.ts`
   - their `validation/accounts/` schemas, `actions/accounts/set-billing-account-template.ts`
   - `components/customers/` (`billing-account-panel.tsx`, `billing-account-card.tsx`, `onboard-accounts-wizard.tsx`, the new `template-type-select.tsx` and `billing-account-messages.ts`)
   - `app/(app)/customers/manage/[id]/page.tsx`
   - `db/schema/billing/accounts.ts` and the new migration
2. **Billing-owned files: authorized only as the shared merge requires,** under `billmgmt-ai-workflow-rules.md`: Billing's capture read (`listBanFamilies`), changed in the same merge as the column migration. Every other Billing file, including the type repository and `lockTemplateType`, is built by Billing's units; consume it, never edit it.
3. **Applied migrations,** including `0050_billing_account_template_ref.sql`. The column change is a new forward migration.
4. **`components/ui/`, `auth/guard.ts`, `auth/permission-constants.ts`** — no new permission constant.
5. **Docs:** the `billmgmt-*` and `acctmgmt-*` context docs. Propose changes and get approval before editing. `TODOS.md`'s "Phase 3: catalog + posting reads the BAN binding" entry is closed by the update's ship gate, not by a feature unit.

### 10.7 Keep documentation in sync

Update in the same change set as the code:

1. **`custmgmt-architecture.md`:** Inv. #19–#22 markers ("planned" → "built (cmNN)") and the §8 tables.
2. **`custmgmt-code-standards.md` §10:** the permission map rows, file tree and guardrails 11–13.
3. **`custmgmt-ui-context.md` §10:** the label, panel and onboarding tokens.
4. **`cm05` (View Customer spec) and `ac04` (onboarding spec):** wherever they quote the old label, Reset button or wizard wording.
5. **`custmgmt-progress-tracker.md`:** after every unit.
6. **At the ship gate:** fold the update overview (`custmgmt-update-overview.md`) into `custmgmt-project-overview.md` and delete it, in the same change as Billing's fold. Invariant **#18** is then marked replaced by #19–#21, and guardrail **10** by guardrail 11. _(Done by cm24, 2026-10-26.)_

### 10.8 Verification checklist — before the next unit

Run §8 and the general doc §8, then confirm for the unit:

1. **Standard is `NULL`.** Choosing "Standard (default)" writes `null`; Standard's id is rejected; no code compares against Standard's id.
2. **The bind gate locks.** `assertBindableTemplate` takes `FOR SHARE` on the type inside the caller's transaction. Retired, not-yet-usable and unknown types return `TEMPLATE_NOT_BINDABLE` and write nothing.
3. **The boundary holds** (guardrail 11). No `ref_bill_template_version_id` remains. Billing references the new column only in the capture read and the retire switch. No customer-tree import of a Billing service or action exists.
4. **The migration is safe:** it applies on a populated database and aborts on a non-`NULL` version value.
5. **Locks and audit:** the BAN's `last_modified` is bumped and `party_role.last_modified_datetime` untouched; one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per real change, none for an unchanged value.
6. **Labels are honest and live.** The four removed strings are gone; labels come from a live read; the "next bill run" caption shows.
7. **Permissions compose.** The page guards are unchanged; the action rejects a user missing either permission with the UI bypassed; the Accounts tab shows nothing without `accounts_view : READ`.
8. **Onboarding is still atomic:** the V7 rollback test passes, and the BAN starts `NULL`.
9. **Docs moved with the code** per §10.7.
