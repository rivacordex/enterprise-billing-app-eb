# Progress Tracker

Update this file after every meaningful implementation change.

## Current Phase

- Customer Management Module — all 16 unit specs written; **implementation started, `cm01` shipped**

## Current Goal

- Implement `cm01`→`cm16` per their specs, in dependency order

## Completed

- `custmgmt-project-overview.md` — scope, goals, core user flow, features, in/out of scope, success criteria
- `custmgmt-architecture.md`
- `custmgmt-code-standards.md`
- `custmgmt-ai-workflow-rules.md`
- `custmgmt-ui-context.md`
- `specs/cm00-build-plan.md` — 16 dependency-ordered build units (cm01–cm16), DB foundation through ship-gate guardrail sweep
- `specs/cm01-db-foundation.md` — **implemented and verified** (`db/schema/customer.ts`, `db/migrations/0009_customer.sql`, `db/seeds/customer.ts`, `types/customer.ts`, permission registry wiring, guardrail tests). The `core.system_config` column set matched the spec's cross-referenced shape exactly (`db/schema/system-config.ts` confirmed against it) — no correction needed. One deviation from the spec's literal Drizzle sketch, recorded here for `cm02`+: the composite `party_role_contact_medium_fk` (`§2.2`, `DEFERRABLE INITIALLY DEFERRED`) is **hand-authored directly in the migration SQL, not declared in `db/schema/customer.ts`** — drizzle-kit's `foreignKey()` builder can't express `DEFERRABLE`, and declaring it in schema.ts creates a genuine mutual-type-dependency between `party_role` and `contact_medium` that `tsc` can't resolve (TS7022/TS7024, circular inference). Migration table-creation order was hand-reordered to organization → party_role → contact_medium per spec §3.3 (drizzle-kit emits `contact_medium` first alphabetically; all FKs are separate `ALTER TABLE` statements so this was cosmetic, not functionally required, but kept for spec fidelity). Adding the `customers` permission triggered a large, spec-undersold ripple (see `[[permission-name-addition-ripple]]` memory) — beyond the `EffectivePermissionMap` fixture updates, **every one of the 28 pre-existing `tests/**/*.integration.test.ts` files needed a `DROP SCHEMA IF EXISTS "customer" CASCADE` added to their beforeAll/afterAll** (none of them knew about the new schema, and `customer` now holds FKs into `core`, so omitting the drop breaks the next test file's `CREATE SCHEMA "customer"` with "already exists"). Full suite verified green: `npm run typecheck`, `npm run lint`, `npm run format:check`, `vitest run` (unit), `vitest run --config vitest.integration.config.ts` (31/31 files, 281/281 tests) against the local Docker Postgres.
- `specs/cm02-validation-read-services.md` — full spec for `validation/customer/**`, the three read-only repositories, and `services/customer` (`searchCustomers`, `getCustomerDetail`). **Not yet implemented** — spec only. Records two resolved design decisions: (1) search results and the `[id]` route param are keyed by `party_role_id`, not `organization_id` (an org can have >1 party_role over its history per Module Inv. #3); (2) corrected `pm03-spec.md`'s `appuser.display_name` reference to `user_name` (the actual identity-schema column per `um02` and every later UM spec).
- `specs/cm03-nav.md` — full spec for the "Customer" `NAV_SECTIONS` entry (View Customer, Manage Customer) plus a new `AdminNav` capability: a greyed/locked visual state for a nav item the viewer lacks permission for (first time any module has needed this — Product's own nav unit explicitly added no permission check). **Not yet implemented** — spec only. Caught and fixed a singular/plural typo in `custmgmt-code-standards.md` §8 (`/customer/view` → `/customers/view`, `/customer/manage` → `/customers/manage`, matching the folder-derived route) and retrofitted the same correction into `cm00`/`cm02`. Flags one thing to verify at implementation time: whether `app/(app)/layout.tsx` already computes the full `EffectivePermissionMap` or only `{ userId, userEmail }` (§2.3.5) — if the latter, the layout needs one added call to `um06`'s existing `resolveEffectivePermissions`.

- `specs/cm04-view-search-page.md` — full spec for `app/(app)/customers/view/page.tsx`: READ guard, `q`-only search (no sort/pagination — capped + hinted per the overview), `CustomerSearchPanel` (client) + `CustomerResultsTable` (server component — no interactivity needed since row click is a real navigation, not a `?id=` selection). Builds `OrganizationStatusBadge`/`CustomerStatusBadge` now (first consumer), colors/icons taken verbatim from `custmgmt-ui-context.md` §1–§2. Introduces `validation/customer/search-params.schema.ts` JIT (not a `cm02` gap — `cm02`'s scope was entity/transition schemas, not URL params). **Not yet implemented** — spec only.

- `specs/cm05-view-detail-page.md` — full spec for `app/(app)/customers/view/[id]/page.tsx`: three fixed-order read-only sections (`OrganizationSection`, `CustomerRoleSection`, `ContactDetailsSection`), builds `OrganizationTypeBadge`/`PreferredIndicator`/`InconsistencyBanner` now (first consumers). **Authored the `isStatusInconsistent` rule** `cm02` deliberately deferred (§2.2 of this spec): flags an `ACTIVE` customer on any non-`ACTIVE` organization, and a `DISSOLVED`/`MERGED` organization with any non-`CLOSED` customer engagement — recorded as authoritative, cross-link to `custmgmt-project-overview.md` if that doc needs an explicit citation beyond its existing "e.g." example. Specification JSON is read-only `<pre>`, deliberately not the (edit-only) `SpecificationEditor`. **Not yet implemented** — spec only.

- `specs/cm06-manage-search-page.md` — full spec for `app/(app)/customers/manage/page.tsx`: EDIT guard (the guardrail `cm03`'s nav lock icon was anticipating — this is the unit that makes it real server-side), reuses `cm04`'s `CustomerSearchPanel`/`CustomerResultsTable` unchanged, adds the "Add new customer" CTA (`--action-cta-bg`, first consumer) pointing to `cm07`. Deliberately thin/short spec — almost everything is reuse. **Not yet implemented** — spec only.

- `specs/cm07-create-customer.md` — first mutation unit. Establishes the module-wide mutation shape (action→service→repository, `{ok:true;value}|{ok:false;code}` result style per `um11` precedent). Resolved the overview's "similar-name warns, doesn't block" as an explicit two-step confirm (submit → warning + "Create anyway" → resubmit with `confirmed:true`); registration-number uniqueness is a hard, non-skippable DB-constraint check. Builds `SpecificationEditor` (first consumer).
- `specs/cm08-edit-page-update-organization.md` — builds the edit-page container (extended incrementally by `cm10`/`cm11`, not fully scaffolded) and the module's **first optimistic-lock implementation**: `partyRoleRepository.compareAndBumpLock` (one atomic `UPDATE ... WHERE last_modified_datetime = $expected`), reused by every mutation unit through `cm15`. **Retroactively patched `cm01`**: `party_role.last_modified_datetime` (and, for consistency, every other timestamp column) needed explicit `timestamptz(3)` millisecond precision — the default microsecond precision could silently break the equality-based lock check across the client `Date` round trip. Flagged and fixed in the same change, not discovered later.

- `specs/cm09-transition-organization-status.md` — builds `StatusTransitionControl` (first consumer; reused unchanged by `cm10`) — rich Radix `Select` with per-option color swatches (ui-context §2), options always precomputed server-side and passed as props (never imported/computed client-side). `transition-organization-status` action/service, reusing `compareAndBumpLock`.
- `specs/cm10-transition-customer-status.md` — reuses `StatusTransitionControl` unchanged for the customer entity; builds `CustomerRoleForm`. **Scope addition, recorded not silently patched**: folded in `update-party-role-specification` since code-standards §1.8 says the spec is "editable anytime" but `cm00` never allocated a unit for it. Introduced `compareAndUpdateStatus`/`compareAndUpdateSpecification` — a same-row optimization of `cm08`'s lock-then-write pattern for mutations that target `party_role` directly.
- `specs/cm11-add-contact.md` — first contact mutation; builds `contact-mutations.ts` (the one shared file for all contact-mutation logic, code-standards §7.3) and `ContactManagerPanel`. Resolved two things the docs left open: "first contact auto-preferred" only fires when the party role has zero existing contacts (never disturbs an existing preferred contact), and "first method filled" (ambiguous in a single-submission form) is a fixed **phone > email > address** priority, recorded as authoritative. First real exercise of `cm01`'s composite deferrable FK.
- `specs/cm12-update-contact.md` — `resolveUpdatedPreferredMethod`: preserves the preferred method unless the edit clears its field while another remains populated (blocked, per Inv. #5), or clears down to zero (allowed).
- `specs/cm13-delete-contact.md` — the module's one physical delete; the precondition check (not deleting the preferred contact) is enforced only by convention + a structural grep-test that `contactMediumRepository.deleteById` is called from nowhere but `deleteContact` (code-standards §6.7's risk, made explicit).
- `specs/cm14-set-preferred-contact.md` — explicit reassignment among existing contacts, reusing `cm11`'s pointer-write function; the escape hatch for `cm13`'s delete-blocked case.
- `specs/cm15-set-preferred-contact-method.md` — the last of the module's nine mutation actions. Explicit reassignment of a contact's preferred *method* among its currently-populated methods only — deliberately no "clear" verb (a method's preference only ever goes to `null` as a side effect of `cm12`'s update-contact clearing the last populated field). Narrow `updatePreferredMethod` repository function kept separate from `cm12`'s broader `update` so neither scope bleeds into the other.
- `specs/cm16-authz-guardrail-sweep.md` — the module's ship gate (tests-only boundary, following Product Management's `pm09` precedent). Extends `guard.integration.test.ts` with the 5-route × USER/MANAGER matrix plus (new relative to `pm09`, since this module has 9 mutation actions vs. Product's 0) a direct-Server-Action USER-denial loop across all `actions/customer/*`. Adds one genuinely new core-flow E2E test (no prior unit owned the *chained* flow, only individual steps) and two new static guardrail-sweep tests (module-boundary invariants + audit-completeness — one `writeAuditEvent` call per mutation, unique `eventType`s). All eight code-standards §9 guardrails ledgered as inherited-and-verified vs. net-new-to-cm16.

## In Progress

- None — `cm01` complete; `cm02` not yet started.

## Next Up

- Implement `cm02` (validation schemas + read repositories/services) per its spec.
- Continue `cm03`→`cm16` per their specs, in dependency order. `cm01` already ships `party_role.last_modified_datetime` (and every other timestamp column) at `timestamptz(3)` millisecond precision from the start, per `cm08`'s retroactive-patch note — no follow-up migration needed for that.
- `cm16` cannot be meaningfully executed until `cm01`–`cm15` are implemented and merged — it is the ship gate, not a spec-writing dependency.

## Open Questions

- None yet.

## Architecture Decisions

- Soft delete only via status (Organization → DISSOLVED, Customer → CLOSED); no physical deletes except contact rows
- `contact_medium` is flattened (one row per contact person, inline phone/email/address) rather than normalized child tables
- Preferred contact and preferred contact method enforced at the database level (composite deferrable FK / constraints), not by operator discipline
- Reuses existing platform as-is: better-auth RBAC (USER/MANAGER), `system_config`, pg_partman audit schema, conventions from User Management and Product Management

## Session Notes

- No unit specs exist yet under `context/customer-management/specs/` — this tracker will start reflecting real progress once the build plan and first spec are written
