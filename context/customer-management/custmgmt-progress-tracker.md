# Customer Management — Progress Tracker

Update this file after every meaningful implementation change.

## Status

| Unit | Name                                                                  | Status                     |
| ---- | ---------------------------------------------------------------------- | --------------------------- |
| cm01 | DB foundation (`customer` schema, migration, seed, permission registry) | Done (committed `4426342`) |
| cm02 | Validation schemas + read repositories + read services                 | Done (committed `3347d04`) |
| cm03 | Nav ("Customer" `NAV_SECTIONS` entry + locked-item `AdminNav` state)    | Done (committed `47c0f68`) |
| cm04 | View search page                                                        | Done (committed `d37c875`) |
| cm05 | View detail page                                                        | Done (uncommitted)         |
| cm06 | Manage search page                                                      | Spec written, not started  |
| cm07 | Create customer                                                         | Spec written, not started  |
| cm08 | Edit page + update organization                                         | Spec written, not started  |
| cm09 | Transition organization status                                         | Spec written, not started  |
| cm10 | Transition customer status                                             | Spec written, not started  |
| cm11 | Add contact                                                             | Spec written, not started  |
| cm12 | Update contact                                                          | Spec written, not started  |
| cm13 | Delete contact                                                         | Spec written, not started  |
| cm14 | Set preferred contact                                                   | Spec written, not started  |
| cm15 | Set preferred contact method                                            | Spec written, not started  |
| cm16 | Authz guardrail sweep (ship gate)                                       | Spec written, not started  |

**Docs completed:** `custmgmt-project-overview.md`, `custmgmt-architecture.md`, `custmgmt-code-standards.md`, `custmgmt-ai-workflow-rules.md`, `custmgmt-ui-context.md`, and `specs/cm00-build-plan.md` (16 dependency-ordered build units, DB foundation through ship-gate guardrail sweep) — all 16 unit specs (`cm01`–`cm16`) are written; implementation proceeds in dependency order.

---

**cm01 implemented per `specs/cm01.md`** — DB foundation: `db/schema/customer.ts` (the `customer` schema, 3 tables — `organization`, `party_role`, `contact_medium` — 3 sequences, all CHECK/UNIQUE/FK constraints), migration `db/migrations/0009_customer.sql`, `db/seeds/customer.ts` (the `customers` permission row + `CUSTOMER_SEARCH_RESULT_LIMIT` seed), `types/customer.ts` (domain unions), and permission registry wiring. The `core.system_config` column set matched the spec's cross-referenced shape exactly (`db/schema/system-config.ts` confirmed against it) — no correction needed.

**Deviations from the spec's stated diff scope:** the composite `party_role_contact_medium_fk` (§2.2, `DEFERRABLE INITIALLY DEFERRED`) is hand-authored directly in the migration SQL, not declared in `db/schema/customer.ts` — drizzle-kit's `foreignKey()` builder can't express `DEFERRABLE`, and declaring it in schema.ts creates a genuine mutual-type-dependency between `party_role` and `contact_medium` that `tsc` can't resolve (TS7022/TS7024, circular inference). Migration table-creation order was hand-reordered to organization → party_role → contact_medium per spec §3.3 (drizzle-kit emits `contact_medium` first alphabetically; all FKs are separate `ALTER TABLE` statements so this was cosmetic, not functionally required, but kept for spec fidelity). Adding the `customers` permission triggered a large, spec-undersold ripple (see `[[permission-name-addition-ripple]]` memory) — beyond the `EffectivePermissionMap` fixture updates, every one of the 28 pre-existing `tests/**/*.integration.test.ts` files needed a `DROP SCHEMA IF EXISTS "customer" CASCADE` added to their beforeAll/afterAll (none of them knew about the new schema, and `customer` now holds FKs into `core`, so omitting the drop breaks the next test file's `CREATE SCHEMA "customer"` with "already exists").

**Verified this session:** `npm run typecheck`, `npm run lint`, `npm run format:check`, `vitest run` (unit), `vitest run --config vitest.integration.config.ts` (31/31 files, 281/281 tests) against the local Docker Postgres.

**Committed** as `4426342` ("customer data layer: schema, migration 0009, seed, permission registry (cm01)").

---

**cm02 implemented per `specs/cm02.md`** — §3.1–§3.12 in full: `validation/customer/{transitions,specification,organization,party-role,contact-medium}.schema.ts` (new); three read-only repositories `db/repositories/{organization,party-role,contact-medium}.ts` (new, finders only); `services/customer/{search-customers,get-customer-detail}.ts` (new); `types/customer.ts` extended with the read-model interfaces (`OrganizationDetail`, `CustomerRoleDetail`, `ContactAddress`, `ContactRow`, `CustomerDetail`, `CustomerSearchResult`, `CustomerSearchResults`). Confirms the two resolved design decisions: (1) search results and the `[id]` route param are keyed by `party_role_id`, not `organization_id` (an org can have >1 party_role over its history per Module Inv. #3) — proven by an integration test where one organization's CLOSED + ACTIVE party_roles surface as two distinct rows; (2) corrected `pm03-spec.md`'s `appuser.display_name` reference to `user_name` (the actual identity-schema column per `um02` and every later UM spec) — used directly via `findUserById` from `db/repositories/appuser.repository.ts` (no `identityRepository` wrapper object exists in the codebase, contrary to the spec's phrasing — the named export is used directly).

**Deviations from the spec's stated diff scope:** none in the shipped files — diff is exactly the read models, the five new validation schema files, the three new repositories, the two new services, and the new/edited test files (§5 diff-hygiene checklist). One implementation choice worth flagging, not a deviation: `searchCustomers`/`getCustomerDetail` take `db: Database` as an explicit first parameter (verbatim per spec's code block), unlike Product Management's `services/product/*` which import the `db` singleton internally — a deliberate per-spec choice, not an inconsistency to fix.

**Verified this session:** `npm run typecheck`, `npm run lint`, `npm run format:check` all clean; `vitest run` (unit config) — 127 files / 1144 tests green; `vitest run --config vitest.integration.config.ts` against the local Docker Postgres dev container — 32 files / 293 tests, all green, including the new `tests/db/customer-repositories.integration.test.ts`.

**Committed** as `3347d04` ("customer validation schemas + read repositories + read services (cm02)").

---

**cm03 implemented per `specs/cm03.md`** — the "Customer" `NAV_SECTIONS` entry (View Customer → `/customers/view`, `Building2`; Manage Customer → `/customers/manage`, `UserCog`) inserted between `Products` and `Administration` in `components/admin-nav.tsx`, plus the new greyed/locked `AdminNav` capability: `NavItem.requiredPermission` (only "Manage Customer" sets it, `{ name: 'customers', level: 'EDIT' }`), a new optional `AdminNavProps.permissionMap`, and a `hasLevel`-backed `locked` branch rendering `<span role="link" aria-disabled="true">` (dimmed, `Lock` icon, non-navigating, "Requires MANAGER access" tooltip in expanded mode, plain-label tooltip collapsed) — fails closed when `permissionMap` is omitted. Collapsed-rail dividers now render for 3 sections (2 hairlines).

**§2.3.5 resolved:** `app/(app)/layout.tsx` only had `getCurrentUserIdentity()` → `{ userName, userEmail }` in scope, no full map and no `userId` either. Extended `getCurrentUserIdentity` (`auth/guard.ts`) to also return `userId` (it already loads the full `user` row internally), then added one `resolveEffectivePermissions(identity.userId)` call in the layout (only when identity resolves) and threaded the result through `AdminSidebar` (new optional `permissionMap` prop, `components/admin-sidebar.tsx`) into `AdminNav`. No `db/**` import added to `layout.tsx` — both calls stay behind `auth/`.

**Deviations from the spec's stated diff-hygiene file list:** the checklist named only `admin-nav.tsx`, `admin-nav.test.tsx`, and conditionally `layout.tsx`. Two more files needed a touch, both required to actually wire the map end-to-end rather than optional: `components/admin-sidebar.tsx` (the actual `<AdminNav>` caller sitting between the layout and the nav — it needed the pass-through prop) and `auth/guard.ts` (`getCurrentUserIdentity` didn't expose `userId`, only `userName`/`userEmail`, so `resolveEffectivePermissions` had nothing to call with). `tests/app/admin-layout.test.tsx` also needed its `getCurrentUserIdentity` mock fixtures updated (`userId` added) and a new `@/auth/resolver` mock (`resolveEffectivePermissions` stubbed to an all-null map) so the layout test suite doesn't hit the DB. Fixed the `custmgmt-code-standards.md` §8 Route-column typo across all five rows (search/detail/edit/add-new) plus its two prose cross-references, not just the two search-page routes cm03 itself depends on — same root typo, left consistent rather than half-fixed.

**Verified this session:** `npm run typecheck`, `npx eslint` (touched files), `npx prettier --check` all clean; `vitest run tests/components/admin-nav.test.tsx tests/app/admin-layout.test.tsx` (20/20 new+existing assertions green); full `vitest run` — 127 files / 1151 tests green (was 127/1144 before this unit's +7 new tests). Integration suite and dev-server manual verification (§ "Behavior" checklist items) not re-run this session — no `db/**`/`services/**`/`actions/**` touched, so the integration suite is unaffected by this unit's diff.

**Committed** as `47c0f68` ("customer nav entry + locked AdminNav state (cm03)").

---

**cm04 — spec written, not yet implemented.** `specs/cm04.md`: `app/(app)/customers/view/page.tsx`: READ guard, `q`-only search, `CustomerSearchPanel` + `CustomerResultsTable`, `OrganizationStatusBadge`/`CustomerStatusBadge`.

---

**cm04 implemented per `specs/cm04.md`** — `validation/customer/search-params.schema.ts` (new, lenient `.catch("")`-defaulted `q`); `app/(app)/customers/view/page.tsx` + `loading.tsx` + `error.tsx` (new) — READ guard as line 1 of the body, `q`-only search (no sort/pagination — capped + hinted per the overview); `components/customers/customer-search-panel.tsx` (client, Apply/Enter/Clear + `useTransition`) + `customer-results-table.tsx` (server component — no interactivity needed since row click is a real navigation, not a `?id=` selection); `organization-status-badge.tsx`/`customer-status-badge.tsx` (new, first consumers), colors/icons taken verbatim from `custmgmt-ui-context.md` §1–§2. New tests: `tests/app/customers-view-page.test.tsx`, `tests/components/{customer-search-panel,customer-results-table,organization-status-badge,customer-status-badge}.test.tsx`.

**Deviation from the spec's stated diff scope — a real fix to `cm02`, not a `cm04`-local workaround:** `cm02`'s `searchCustomers`/`getCustomerDetail` took `db: Database` as an explicit first parameter (a "deliberate choice" per `cm02`'s own tracker entry above). Wiring cm04's page to call `searchCustomers(db, parsed.q)` as the spec's code block literally shows tripped the `boundaries/dependencies` ESLint rule (`app/**` has no allowed edge to `db/**` — only `root-page`, `services`, `auth`, and `db` itself do). Checked every downstream spec that calls these services (`cm05`, `cm06`, `cm08`) — all of them already assume a single-argument call (`searchCustomers(parsed.q)`, `getCustomerDetail(idResult.data)`), matching Product Management's `services/product/*` convention (import the `db` singleton internally). So the `db`-as-parameter shape was the actual bug, only surfaced once cm04 became the first real consumer. Fixed at the source: `services/customer/search-customers.ts` and `services/customer/get-customer-detail.ts` now import `db` from `@/db/client` internally and dropped the parameter; updated all existing call sites accordingly (`tests/services/search-customers.service.test.ts`, `tests/services/get-customer-detail.service.test.ts`, `tests/db/customer-repositories.integration.test.ts` — 24 call sites across three files, argument-count only, no assertion changes). `cm05`/`cm06`/`cm08` need no further adjustment — their specs already match the corrected signature.

Also added `/customers/view` to `tests/app/route-manifest.test.ts`'s frozen `ROUTE_MANIFEST` (pm01's rename-invariance guardrail enumerates every `app/**/page.tsx`-derived route; a new route trips it by design until registered).

**Verified this session:** `npm run typecheck`, `npm run lint`, `npm run format:check` all clean; `vitest run` — 132 files / 1182 tests green (was 132/1182 total after adding this unit's new test files and fixing the route-manifest guardrail); `vitest run --config vitest.integration.config.ts` against the local Docker Postgres dev container — 32 files / 293 tests green, including `tests/db/customer-repositories.integration.test.ts` exercising the corrected service signatures against the real database.

**Committed** as `d37c875` ("customer view search page (cm04)"). `cm06` (Manage Customer search page) reuses `search-params.schema.ts` and `CustomerResultsTable` unchanged.

---

**cm05 implemented per `specs/cm05.md`** — `app/(app)/customers/view/[id]/page.tsx` (new): READ guard first, `[id]` parsed against `partyRoleIdSchema` before any DB call (malformed IDs never reach `getCustomerDetail`), one `"Customer not found"` state for both the malformed-ID and unknown-ID paths, the three fixed-order sections composed underneath an `InconsistencyBanner` shown only when `isStatusInconsistent` fires. New `components/customers/{organization-section,customer-role-section,contact-details-section,organization-type-badge,preferred-indicator,inconsistency-banner}.tsx` — the last exports the authoritative `isStatusInconsistent` rule verbatim per spec §2.2 (Rule 1: `ACTIVE` customer + non-`ACTIVE` organization; Rule 2: `DISSOLVED`/`MERGED` organization + non-`CLOSED` customer), now recorded here as authoritative per workflow §4.4 — `custmgmt-project-overview.md`'s existing "e.g." example already covers Rule 1's worked case, so the overview itself was not edited. `CustomerRoleSection`'s specification renders read-only `JSON.stringify(spec, null, 2)` in a `<pre>`, not the edit-only `SpecificationEditor`. `--preferred-fg` and the three `--banner-warning-*` tokens added to `globals.css` — all four are semantic aliases onto already-existing `--color-accent-500`/`--color-warning-{500,700,50}` values (confirmed no literal-hex duplication, per spec §3.5/§3.7's "confirm before adding a duplicate"); `--color-cyan-*` also already existed, no addition needed. `/customers/view/[id]` added to `tests/app/route-manifest.test.ts`'s frozen `ROUTE_MANIFEST`.

**Deviation from the spec's literal code block:** `InconsistencyBanner`'s JSX used an inline `style` prop for the three `--banner-warning-*` tokens (spec §3.7) — this repo has a project-wide ESLint rule banning inline `style` props (`no-restricted-syntax`, ZAP rule 10055 / CSP `style-src` without `unsafe-inline`), which the spec's own preamble already flagged as a blind spot ("no live-repo mount this session"). Fixed by using Tailwind arbitrary-value classes (`border-[color:var(--banner-warning-border)]` etc.) instead — same tokens, same visual result, matching how every other badge/status component in this module already reads its CSS custom properties.

**Verified this session:** `npm run typecheck`, `npm run lint`, `npm run format:check` all clean; `vitest run` — 139 files / 1210 tests green (was 132/1182 before this unit's +7 new test files / +28 new tests). Integration suite not re-run — no `db/**`/`services/**`/`actions/**` touched, so it's unaffected by this unit's diff (all new/edited files are `app/(app)/customers/view/[id]/**`, `components/customers/**`, `app/globals.css`, and the corresponding test files).

**Not yet committed** — changes are in the working tree alongside `cm02`/`cm03`/`cm04`'s uncommitted work; commit per user confirmation. `cm06` (Manage Customer search page) is independent and may proceed in parallel; `cm08` will reuse `OrganizationTypeBadge`/`PreferredIndicator`/`InconsistencyBanner` built here.

---

**cm06 — spec written, not yet implemented.** `specs/cm06.md`: full spec for `app/(app)/customers/manage/page.tsx` — EDIT guard (the guardrail `cm03`'s nav lock icon was anticipating; this is the unit that makes it real server-side), reuses `cm04`'s `CustomerSearchPanel`/`CustomerResultsTable` unchanged, adds the "Add new customer" CTA (`--action-cta-bg`, first consumer) pointing to `cm07`. Deliberately thin/short spec — almost everything is reuse.

---

**cm07 — spec written, not yet implemented.** `specs/cm07.md`: the first mutation unit. Establishes the module-wide mutation shape (action → service → repository, `{ok:true;value}|{ok:false;code}` result style per `um11` precedent). Resolved the overview's "similar-name warns, doesn't block" as an explicit two-step confirm (submit → warning + "Create anyway" → resubmit with `confirmed:true`); registration-number uniqueness is a hard, non-skippable DB-constraint check. Builds `SpecificationEditor` (first consumer).

---

**cm08 — spec written, not yet implemented.** `specs/cm08.md`: builds the edit-page container (extended incrementally by `cm10`/`cm11`, not fully scaffolded) and the module's first optimistic-lock implementation — `partyRoleRepository.compareAndBumpLock` (one atomic `UPDATE ... WHERE last_modified_datetime = $expected`), reused by every mutation unit through `cm15`. Retroactively patches `cm01`: `party_role.last_modified_datetime` (and, for consistency, every other timestamp column) needs explicit `timestamptz(3)` millisecond precision — the default microsecond precision could silently break the equality-based lock check across the client `Date` round trip. (Note: `cm01` as actually implemented already ships this precision from the start, so no follow-up migration is needed when this unit is implemented — see cm01's row above.)

---

**cm09 — spec written, not yet implemented.** `specs/cm09.md`: builds `StatusTransitionControl` (first consumer; reused unchanged by `cm10`) — rich Radix `Select` with per-option color swatches (ui-context §2), options always precomputed server-side and passed as props (never imported/computed client-side). `transition-organization-status` action/service, reusing `compareAndBumpLock`.

---

**cm10 — spec written, not yet implemented.** `specs/cm10.md`: reuses `StatusTransitionControl` unchanged for the customer entity; builds `CustomerRoleForm`. Scope addition, recorded not silently patched: folds in `update-party-role-specification` since code-standards §1.8 says the spec is "editable anytime" but `cm00` never allocated a unit for it. Introduces `compareAndUpdateStatus`/`compareAndUpdateSpecification` — a same-row optimization of `cm08`'s lock-then-write pattern for mutations that target `party_role` directly.

---

**cm11 — spec written, not yet implemented.** `specs/cm11.md`: first contact mutation; builds `contact-mutations.ts` (the one shared file for all contact-mutation logic, code-standards §7.3) and `ContactManagerPanel`. Resolves two things the docs left open: "first contact auto-preferred" only fires when the party role has zero existing contacts (never disturbs an existing preferred contact), and "first method filled" (ambiguous in a single-submission form) is a fixed phone > email > address priority, recorded as authoritative. First real exercise of `cm01`'s composite deferrable FK.

---

**cm12 — spec written, not yet implemented.** `specs/cm12.md`: `resolveUpdatedPreferredMethod` — preserves the preferred method unless the edit clears its field while another remains populated (blocked, per Inv. #5), or clears down to zero (allowed).

---

**cm13 — spec written, not yet implemented.** `specs/cm13.md`: the module's one physical delete; the precondition check (not deleting the preferred contact) is enforced only by convention + a structural grep-test that `contactMediumRepository.deleteById` is called from nowhere but `deleteContact` (code-standards §6.7's risk, made explicit).

---

**cm14 — spec written, not yet implemented.** `specs/cm14.md`: explicit reassignment among existing contacts, reusing `cm11`'s pointer-write function; the escape hatch for `cm13`'s delete-blocked case.

---

**cm15 — spec written, not yet implemented.** `specs/cm15.md`: the last of the module's nine mutation actions. Explicit reassignment of a contact's preferred *method* among its currently-populated methods only — deliberately no "clear" verb (a method's preference only ever goes to `null` as a side effect of `cm12`'s update-contact clearing the last populated field). Narrow `updatePreferredMethod` repository function kept separate from `cm12`'s broader `update` so neither scope bleeds into the other.

---

**cm16 — spec written, not yet implemented.** `specs/cm16.md`: the module's ship gate (tests-only boundary, following Product Management's `pm09` precedent). Extends `guard.integration.test.ts` with the 5-route × USER/MANAGER matrix plus (new relative to `pm09`, since this module has 9 mutation actions vs. Product's 0) a direct-Server-Action USER-denial loop across all `actions/customer/*`. Adds one genuinely new core-flow E2E test (no prior unit owned the chained flow, only individual steps) and two new static guardrail-sweep tests (module-boundary invariants + audit-completeness — one `writeAuditEvent` call per mutation, unique `eventType`s). All eight code-standards §9 guardrails ledgered as inherited-and-verified vs. net-new-to-cm16. Cannot be meaningfully executed until `cm01`–`cm15` are implemented and merged — it is the ship gate, not a spec-writing dependency.

## Open Questions

- None yet.

## Architecture Decisions

- Soft delete only via status (Organization → DISSOLVED, Customer → CLOSED); no physical deletes except contact rows
- `contact_medium` is flattened (one row per contact person, inline phone/email/address) rather than normalized child tables
- Preferred contact and preferred contact method enforced at the database level (composite deferrable FK / constraints), not by operator discipline
- Reuses existing platform as-is: better-auth RBAC (USER/MANAGER), `system_config`, pg_partman audit schema, conventions from User Management and Product Management

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
