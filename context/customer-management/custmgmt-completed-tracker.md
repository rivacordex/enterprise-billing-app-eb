# Customer Management — Progress Tracker

Update this file after every meaningful implementation change.

## Status

All 16 units implemented and committed. Module is ship-gate-verified (cm16) at the DB/test level; SAST/DAST and live-browser sign-off are CI/manual steps outside this tooling.

| Unit | Name                                                                     | Commit    |
| ---- | ------------------------------------------------------------------------- | --------- |
| cm01 | DB foundation (`customer` schema, migration, seed, permission registry)   | `4426342` |
| cm02 | Validation schemas + read repositories + read services                    | `3347d04` |
| cm03 | Nav ("Customer" `NAV_SECTIONS` entry + locked-item `AdminNav` state)       | `47c0f68` |
| cm04 | View search page                                                           | `d37c875` |
| cm05 | View detail page                                                           | `b1d0d8a` |
| cm06 | Manage search page                                                         | `53f9a62` |
| cm07 | Create customer                                                            | `9665074` |
| cm08 | Edit page + update organization                                           | `ff2dbc4` |
| cm09 | Transition organization status                                            | `9aae48c` |
| cm10 | Transition customer status                                                | `00a865a` |
| cm11 | Add contact                                                                | `0d80df8` |
| cm12 | Update contact                                                            | `12240ce` (with cm11) |
| cm13 | Delete contact                                                            | `a8e22ff` |
| cm14 | Set preferred contact                                                     | `2e505cb` |
| cm15 | Set preferred contact method                                              | `b349cf7` |
| cm16 | Authz guardrail sweep (ship gate)                                         | `8d80e6c` |

**Docs completed:** `custmgmt-project-overview.md`, `custmgmt-architecture.md`, `custmgmt-code-standards.md`, `custmgmt-ai-workflow-rules.md`, `custmgmt-ui-context.md`, `specs/cm00-build-plan.md`, all 16 unit specs (`cm01`–`cm16`).

## Recurring patterns (apply across units — not repeated per-unit below)

- **Audit event type ripple:** adding a new `AUDIT_EVENT_TYPES` entry (needed by nearly every mutation unit: cm07–cm13, cm15) always requires updating `types/audit-log.ts`'s `AUDIT_EVENT_CATEGORY_MAP` (`tsc`-caught) and bumping the event/option counts + optgroup assertions in `tests/components/audit-log-filters.test.tsx` (**not** `tsc`-caught). See `[[audit-event-type-addition-ripple]]`.
- **Route manifest ripple:** every new `app/**/page.tsx` (cm04, cm05, cm06, cm08) must be added to `tests/app/route-manifest.test.ts`'s frozen `ROUTE_MANIFEST` or the guardrail trips by design.
- **Dev-DB integration protocol:** integration runs always go against the local Docker dev container's `DATABASE_URL` and require user confirmation first (per `[[local-docker-dev-stack]]`); the stack is re-provisioned via `down -v && up -d --build` afterward (`down` without `-v` hits a known non-idempotent `setup-partman` failure).
- **Mutation shape:** every mutation unit (cm07–cm15) follows the same action → service → repository pattern established in cm07: guard → `safeParse` → one service call → `revalidatePath`; services run `compareAndBumpLock` (cm08) first inside a transaction, short-circuiting to `CONFLICT` before any write/audit.
- **`db` import convention:** services import the `db` singleton internally (not passed as a parameter) — cm02's original `db`-as-parameter shape was a bug, corrected in cm04; every later spec assumes single-argument service calls.

## Per-unit notes

**cm01** — `db/schema/customer.ts` (`customer` schema: `organization`/`party_role`/`contact_medium`, 3 sequences, all constraints), migration `0009_customer.sql`, seed (`customers` permission, `CUSTOMER_SEARCH_RESULT_LIMIT`), `types/customer.ts` domain unions. Composite deferrable FK hand-authored in migration SQL (drizzle-kit can't express `DEFERRABLE`). Retroactively fixed (post-cm08): seed was missing an `ADMIN` grant for `customers` (Product Management's seed pattern grants ADMIN; customer's didn't) — added `ADMIN → customers:EDIT`, updated cm01-spec and architecture doc §4 accordingly.

**cm02** — Validation schemas (`transitions`/`specification`/`organization`/`party-role`/`contact-medium`), three finder-only repositories, `searchCustomers`/`getCustomerDetail` services, read-model types. Search/detail keyed by `party_role_id` (an org can have >1 party_role historically). `db`-as-parameter service signature later corrected in cm04.

**cm03** — "Customer" `NAV_SECTIONS` entry + new `AdminNav` locked/greyed-item capability (fails closed when `permissionMap` omitted). Required extending `getCurrentUserIdentity` to expose `userId` and threading a `permissionMap` through `AdminSidebar` into `AdminNav`, beyond the spec's stated file list.

**cm04** — `/customers/view` page: READ guard, `q`-only search, `CustomerSearchPanel`/`CustomerResultsTable`, `OrganizationStatusBadge`/`CustomerStatusBadge`. Fixed cm02's `db`-as-parameter service bug here (first real consumer tripped the `boundaries/dependencies` ESLint rule).

**cm05** — `/customers/view/[id]` detail page: 3 fixed-order read-only sections + `InconsistencyBanner` (authoritative `isStatusInconsistent` rule: Rule 1 = ACTIVE customer + non-ACTIVE org; Rule 2 = DISSOLVED/MERGED org + non-CLOSED customer). New CSS tokens are semantic aliases onto existing colors (no literal-hex duplication). Inline `style` prop from spec's code block replaced with Tailwind arbitrary-value classes (repo bans inline `style`).

**cm06** — `/customers/manage` search page: EDIT guard, reuses cm04's search panel/table unchanged, "Add new customer" CTA → cm07 (interim 404 until cm07 shipped).

**cm07** — First mutation unit: `create-customer` action/service/repository, two-step similar-name confirm (`SIMILAR_NAMES_FOUND` before any write), one transaction writing organization → audit → party_role → audit, `isUniqueViolation` on `registration_number` (`lib/db-errors.ts`). Integration testing caught a real bug: Drizzle wraps driver errors in `DrizzleQueryError`, exposing the real `PostgresError` on `.cause` — `isUniqueViolation` now checks both `err` and `err.cause`.

**cm08** — First optimistic-lock implementation: `compareAndBumpLock` (atomic compare-and-swap on `party_role.last_modified_datetime`, Module Inv. #6), reused by every later mutation. `organizationRepository.update` (field-only, no `status`). Edit page container built here; `cm09`/`cm10`/`cm11` extend the same page via seam comments.

**cm09** — First status-transition mutation + `StatusTransitionControl` (the module's one status-dropdown component, reused unchanged by cm10). Transition validity checked in-memory against `ORGANIZATION_TRANSITIONS` before the transaction opens; `compareAndBumpLock` still runs first inside it.

**cm10** — Reuses `StatusTransitionControl` unchanged for the customer entity (`entityKind="customer"`, `CUSTOMER_TRANSITIONS`). Added `compareAndUpdateStatus`/`compareAndUpdateSpecification` — same-row refinement of `compareAndBumpLock` since these write directly to `party_role`. `CustomerRoleForm` added as the edit page's second section; status and specification save independently with their own local lock state.

**cm11** — First contact mutation + first real exercise of cm01's composite deferrable FK. `contactMediumRepository` graduates out of finder-only (last of the module's three repos to do so). `addContact` implements Module Inv. #4 (auto-preferred-contact on first add) and Inv. #5 (`resolvePreferredMethod`, fixed PHONE→EMAIL→ADDRESS priority) as independent checks. `ContactManagerPanel` added as the edit page's third/final section. Live Playwright verification confirmed both invariants render correctly end-to-end as `admin@example.com`.

**cm12** — `resolveUpdatedPreferredMethod`: three-way case set (nothing preferred yet → auto-assign; still-populated → untouched; cleared while another remains → `PREFERRED_METHOD_STILL_POPULATED`; cleared to zero → allowed). `ContactFieldsFieldset` factored out, shared by add/edit forms. Live Playwright verification confirmed the clear/reject and clear-to-zero paths.

**cm13** — The module's one physical delete. `deleteContact`: `CONTACT_NOT_FOUND` / `CANNOT_DELETE_PREFERRED_CONTACT` (Inv. #4's one enforcement point) checked before the transaction; audit row records full pre-delete data with `afterData: null`. New structural guardrail (`tests/structure/contact-medium-delete-callers.test.ts`) asserts `deleteById` is only called from `contact-mutations.ts`. `DeleteContactDialog` uses `AlertDialog` (non-backdrop-dismissible) as the module's one irreversible-action confirm.

**cm14** — Explicit `setPreferredContact` reassignment (the escape hatch for cm13's delete-blocked case). Reuses cm11's repository function unchanged; reassigning to the already-preferred contact is not special-cased (still bumps lock, audits identical before/after). No audit-type ripple — `PREFERRED_CONTACT_CHANGED` already existed from cm11.

**cm15** — Last of the module's mutation actions: explicit `setPreferredContactMethod` among currently-populated methods on one contact (narrower sibling to cm12's `resolveUpdatedPreferredMethod`). Fixed a spec typo (`contact.addressLine1` → `contact.gaAddressLine1`, the actual DB column name). Method-row "Make preferred" buttons needed a distinguishing `aria-label` to avoid an accessible-name collision with cm14's contact-level button of the same visible label.

**cm16** — Ship gate (tests-only diff). Confirmed all 5 inherited guardrails present/green, then added: extended `guard.integration.test.ts` (dedicated MANAGER/USER principals, route×level matrix, direct Server Action USER-denial for all 10 actions), `customer-core-flow.integration.test.ts` (chained E2E), `customer-module-boundaries.test.ts` (6 checks), `customer-audit-completeness.test.ts` (pins per-function `eventType` mapping). Found and fixed real doc/spec gaps rather than working around them: `custmgmt-code-standards.md` §7 was missing `update-party-role-specification` from its file-tree listing (10 actions, not 9); `custmgmt-architecture.md` still had the pre-cm03 singular route typo (`/customer/...`); cm16-spec's own worked examples (step 4/5 status values, "one eventType per mutation" rule) were factually wrong against the real transition maps and were implemented per the actual code instead.

**Final verification (cm16):** full unit suite 155 files / 1408 tests green; full integration suite 37 files / 327 tests green. SAST/DAST and live-browser spot checks are CI/manual steps, deferred consistently across every unit.

## Open Questions

- None yet.

## Architecture Decisions

- Soft delete only via status (Organization → DISSOLVED, Customer → CLOSED); no physical deletes except contact rows.
- `contact_medium` is flattened (one row per contact person, inline phone/email/address) rather than normalized child tables.
- Preferred contact and preferred contact method enforced at the database level (composite deferrable FK / constraints), not by operator discipline.
- Reuses existing platform as-is: better-auth RBAC (USER/MANAGER), `system_config`, pg_partman audit schema, conventions from User Management and Product Management.

## Per-unit specs

| Unit | Spec file       | Summary                                                                                                                                                                                                                                                              |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cm01 | `specs/cm01.md` | DB foundation: `customer` schema (3 tables, 3 sequences, all constraints), migration `0009_customer.sql`, seed (`customers` permission + `CUSTOMER_SEARCH_RESULT_LIMIT`), permission registry wiring, `types/customer.ts` domain unions, guardrail tests. |
| cm02 | `specs/cm02.md` | Validation schemas (transitions, specification, organization, party-role, contact-medium) + three finder-only repositories + `services/customer` (`searchCustomers`, `getCustomerDetail`) + read-model types. No `app/**`, `actions/customer/`, or UI. |
| cm03 | `specs/cm03.md` | "Customer" `NAV_SECTIONS` entry (View/Manage) + new `AdminNav` locked/greyed-item capability for a permission the viewer lacks. |
| cm04 | `specs/cm04.md` | `app/(app)/customers/view/page.tsx`: READ guard, `q`-only search, `CustomerSearchPanel` + `CustomerResultsTable`, `OrganizationStatusBadge`/`CustomerStatusBadge`. |
| cm05 | `specs/cm05.md` | `app/(app)/customers/view/[id]/page.tsx`: three read-only sections (organization/role/contacts), `OrganizationTypeBadge`/`PreferredIndicator`/`InconsistencyBanner`, authoritative `isStatusInconsistent` rule. |
| cm06 | `specs/cm06.md` | `app/(app)/customers/manage/page.tsx`: EDIT guard, reuses `cm04`'s search panel/table, "Add new customer" CTA → `cm07`. |
| cm07 | `specs/cm07.md` | First mutation unit: create-customer action/service/repository shape, two-step similar-name confirm, registration-number uniqueness DB check, `SpecificationEditor`. |
| cm08 | `specs/cm08.md` | Edit-page container + first optimistic-lock implementation (`compareAndBumpLock`), reused through `cm15`. |
| cm09 | `specs/cm09.md` | `StatusTransitionControl` (reused by `cm10`); `transition-organization-status` action/service. |
| cm10 | `specs/cm10.md` | Reuses `StatusTransitionControl` for the customer entity; `CustomerRoleForm`; folds in `update-party-role-specification`; `compareAndUpdateStatus`/`compareAndUpdateSpecification`. |
| cm11 | `specs/cm11.md` | First contact mutation: `contact-mutations.ts`, `ContactManagerPanel`, first-contact-auto-preferred + phone>email>address priority rules. |
| cm12 | `specs/cm12.md` | `resolveUpdatedPreferredMethod` — preferred-method preservation/clearing rules on contact update. |
| cm13 | `specs/cm13.md` | The module's one physical delete (contact), with a convention + structural-test-enforced precondition. |
| cm14 | `specs/cm14.md` | Explicit set-preferred-contact reassignment; escape hatch for `cm13`'s delete-blocked case. |
| cm15 | `specs/cm15.md` | Explicit set-preferred-contact-method reassignment among currently-populated methods. |
| cm16 | `specs/cm16.md` | Ship gate: authz-matrix route × role matrix, Server-Action USER-denial loop, chained core-flow E2E, module-boundary + audit-completeness guardrail sweeps. |
