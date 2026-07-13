# Customer Management — AI Workflow Rules (Module Supplement)

This document supplements `../ai-workflow-rules.md` (binding for all modules — read it first); everything there applies unchanged to the **Customer Management Module**, and the deltas specific to this module are: **no `DELETE` permission level is seeded** — the general doc's `DELETE ⊃ EDIT ⊃ READ` hierarchy (§7.7) collapses to **READ/EDIT only** here, so every destructive action (a status-transition "delete," a contact hard-delete) is gated at **EDIT**, never DELETE; **a single customer-scoped optimistic-lock column** (`party_role.last_modified_datetime`) covers organization + role + contact mutations together, not one lock per table or per action; and **`contact_medium` is the module's one sanctioned physical-delete path**, a documented, narrow exception to the platform's soft-delete-by-status default used everywhere else in this module. Everything else — units, splitting, ambiguity handling, protected files, doc sync, verification — follows the general doc unchanged except where restated below.

**Companion docs (authoritative — do not restate or contradict):**

- `custmgmt-project-overview.md` — product spec: user flows, two pages (View/Manage Customer), 3-table data model, lifecycle maps, in/out of scope, success criteria.
- `custmgmt-architecture.md` — technical design deltas: `customer` schema, permission matrix (§4), 10 numbered **Module Invariants** (§6).
- `custmgmt-code-standards.md` — module coding conventions, file tree (§7), permission map (§8), guardrail tests (§9).

**Precedence** per the general doc: module architecture **Invariants** → overview → architecture → code-standards → this supplement → general workflow rules.

---

## Application Building Context

Read the following files in order before implementing or making any architectural decision:

1. `context/customer-management/custmgmt-project-overview.md` — product definition, goals, features, and scope
2. `context/customer-management/custmgmt-architecture.md` — system structure, boundaries, storage model, and invariants
3. `context/customer-management/custmgmt-ui-context.md` — theme, colors, typography, and component conventions
4. `context/customer-management/custmgmt-code-standards.md` — implementation rules and conventions
5. `context/customer-management/custmgmt-ai-workflow-rules.md` — development workflow, scoping rules, and delivery approach (this document)
6. `context/customer-management/custmgmt-progress-tracker.md` — current phase, completed work, open questions, and next steps

Update `context/customer-management/custmgmt-progress-tracker.md` after each meaningful implementation change.

If implementation changes the architecture, scope, or standards documented in the context files, update the relevant file before continuing.

---

## 1. Operating Approach — Module Specifics

1. **Build full CRUD in v1** — unlike Product Management's read-only v1, `actions/customer/**` ships from day one: create, update, status-transition, contact add/update/delete, and set-preferred (contact and method) are all in scope now (overview *In Scope*, architecture §1).
2. **Cite the authorizing section before coding**, per the general doc §1.1 — an overview flow/feature, an architecture §2 folder row or Module Invariant, or a code-standards rule. No section, no mandate.
3. **Every mutation is one transaction: validate → mutate → audit → bump the optimistic lock** (architecture Inv. #6, code-standards §1.5). A mutation unit that lands only part of this chain is not done.
4. **Transition maps are the single source of truth.** `ORGANIZATION_TRANSITIONS` / `CUSTOMER_TRANSITIONS` in `validation/customer/transitions.ts` are the only place next-states are declared; no page, component, or action hand-authors a status option list (code-standards §1.4, §2.2).

---

## 2. Units — One at a Time

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
3. **Do not add an FK, form field, or linkage logic to `party_role.account`.** It stays display-only until an Account module exists (Inv. #9).
4. **Do not build multi-value contact fields.** A second phone/email/address is a second `contact_medium` row, never an array or child table (overview *Out of Scope*).
5. **Do not build merge tooling, TMF/external APIs, or individual (person) customers.** All explicitly out of scope this release (overview *Out of Scope*).
6. **Do not fold a contact mutation into the org/role Server Action.** Each contact action (add/update/delete/set-preferred) is independent, independently permission- and lock-checked (code-standards §3.6).
7. **Respect layer boundaries while slicing.** Pages are thin orchestrators; `services/customer` has no `next/*` imports; SQL lives only in `db/**`.

---

## 4. When to Split

Apply the general doc §3 triggers, plus these module-specific splits:

1. **Split the migration from behavior** — schema, constraints, and seed rows (`customers` permission row, `SYSTEM_CONFIG` limit) land and are verified before repositories consume them.
2. **Split each Server Action** — organization update, each status transition, each contact mutation, each set-preferred call are separate units; never bundle two into one diff.
3. **Split each page/section** — search, detail (three sections), edit form, add-new page are separate units; don't deliver a whole page in one pass.
4. **Split every guardrail** (code-standards §9) into its own focused step with tests: authz matrix, transition-map edges, DB constraints, preferred-contact/method invariants, optimistic-lock conflict, audit trail, search correctness.
5. **When in doubt, split.**

---

## 5. Missing or Ambiguous Requirements

Follow the general doc §4: resolve from the docs first, cite the section; otherwise stop and ask one precise question with options. Never guess on security, data shape, permissions, lifecycle, or locking scope. Module-specific:

1. **Known deferred/accepted-risk decisions — do not resolve differently yourself:** `CUST_KEY` uniqueness/immutability is operator discipline, not a code path; `party_role.account` linkage is deferred to a future Account module; the MERGED-status record-migration workflow is not built. If a unit seems to need one of these, stop and ask.
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
2. **Authorization** — `requirePermission('customers', 'READ'|'EDIT')` at the top of every page; confirm no DELETE check exists anywhere (none is seeded); a USER is rejected server-side on every `actions/customer/*` call even if the nav is bypassed.
3. **Optimistic lock** — every mutation in a customer's scope (organization, role/status, contacts, set-preferred) reads-compares-bumps `party_role.last_modified_datetime` in its own transaction; a stale save returns the typed `CONFLICT` result and a reload-prompt UI, never a silent overwrite.
4. **Audit** — mutation + `AUDIT_LOG` insert in one transaction, actor/timestamp/entity/before-after; status changes additionally persist `status_reason` on the row itself, not only in audit history.
5. **Data layer** — SQL only in `db/**`; `contact_medium` delete blocked while it's the pointed-at preferred contact; `party_role_specification` validated for well-formed JSON only, never a shape schema.
6. **Migrations correct** — new, ordered, committed; the `customers` PERMISSIONS row and `SYSTEM_CONFIG` seed ship with the schema in one migration; no edits to an applied migration.
7. **No forbidden edits** — nothing from §6 above touched without instruction; no DELETE permission level added; no `TODO`, commented-out code, or `console.*` on the branch.
8. **Diff is minimal and reviewable** — only planned files changed; no drive-by edits.

If any item fails, the unit isn't done. Fix it before moving on; never defer a failure to a later unit.
