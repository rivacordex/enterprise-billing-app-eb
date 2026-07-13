# CM16 — Authz-Matrix Entries + Full Guardrail Sweep

- **Unit:** 16 of 16 (`cm00-build-plan.md`) — the module's **ship gate**.
- **Dependencies:** `cm01`–`cm15` all verified and merged (`cm00-build-plan.md` dependency graph: "all of cm01–cm15 ──► cm16"). Concretely cm16 assumes: the `customer` schema + `customers` PERMISSIONS row + `CUSTOMER_SEARCH_RESULT_LIMIT` seed (cm01); `validation/customer/**` + the transition maps + read services (cm02); the Customer nav section with greyed/locked rendering (cm03); the two search pages and the detail page (cm04–cm06); all nine `actions/customer/*.ts` mutation actions and their services (cm07–cm15); `compareAndBumpLock` and both lock-composition patterns (cm08/cm10); every preferred-contact/preferred-method invariant (cm11–cm15). cm16 must not start until cm15 is merged and green.
- **Authorizing sections:** build-plan *Unit cm16*; `custmgmt-project-overview.md` *Success Criteria*; `custmgmt-architecture.md` §4 (permission matrix), Module Invariants #1–#10; `custmgmt-code-standards.md` §8 (per-page permission map), **§9 (the eight module guardrail tests — the checklist this unit closes)**; `custmgmt-ai-workflow-rules.md` §8 (module verification pass); general `code-standards.md` §1.11 (a page needs a map row + permission migration + guard), §7.9 (a guarded route isn't done until its route × level matrix tests exist), **§10 (CI gates, incl. SAST + OWASP ZAP DAST)**; platform `architecture.md` §5/§6 (authorization, per-page permission map), Inv. #3/#4 (server-side authz, deny by default); general `ai-workflow-rules.md` §8 (verification-before-ship checklist).
- **Note on codebase verification:** no live-repo mount this session; the same route-typo correction already retrofitted into `cm00`/`cm02`/`cm03` (`/customer/…` → `/customers/…`) is assumed carried through here — cm16 uses the plural, folder-derived paths throughout.

---

## 1. Goal

Close the module by (a) adding all five Customer Management routes' **route × level entries** to the platform authz-matrix integration test, including the direct-Server-Action-call denial for a USER on every `actions/customer/*` mutation; (b) landing a small **guardrail-sweep** test making the module's negative-space invariants (single lock column, no unseeded permission level, contact-mutation logic confined to one file) permanent CI facts; and (c) running the full workflow §8 verification pass. Visible result: **CI green with all eight code-standards §9 guardrails passing** — authz matrix, full core flow, transition-map edges, DB constraints, preferred invariants, optimistic-lock conflict, audit trail, search correctness — the module's ship gate.

## 2. Design

### 2.1 Boundary — Tests only

cm16's boundary is **tests**, matching `cm00`'s own "Boundary: TESTS" label for this unit. It writes and edits **`tests/**` files only**. It adds no `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, or `actions/**` file. Every one of the eight guardrails was **built** by the unit that owns the behaviour it guards; cm16 either **inherits** that guardrail (already shipped, already passing) or **adds the one remaining test** the earlier units deferred to the ship gate — never new runtime behaviour. A guardrail found to be missing *enforcement* (not just a test) is a defect in the owning unit, fixed there — not papered over here (`custmgmt-ai-workflow-rules.md` §8: "the unit is not done").

### 2.2 The eight-guardrail ownership ledger

| # | Guardrail (code-standards §9) | Owning unit / file | cm16 action |
|---|---|---|---|
| 1 | **Authz matrix** — 5 routes × USER/MANAGER, incl. direct Server Action calls rejected for USER | **cm16** — `tests/auth/guard.integration.test.ts` (route × level) + `tests/actions/customer/*.test.ts` (direct-call denial, owned per-action by cm07–cm15) | **ADD** (§3.2) — integration cases; verify each action's own USER-denial unit test is present |
| 2 | **Full core flow** — search → create → contact/methods → status transitions → visible in View | cm07 (create), cm09/cm10 (transitions), cm11 (contacts) individually unit-test their own step; no unit owns the **end-to-end** chain | **ADD** (§3.3) — the one genuinely new E2E test |
| 3 | **Transition-map edges** — every invalid edge rejected; every valid edge without `status_reason` rejected | cm09 (`ORGANIZATION_TRANSITIONS`), cm10 (`CUSTOMER_TRANSITIONS`) | **INHERIT** — audit present & green; sweep re-asserts exhaustiveness (§3.4) |
| 4 | **DB constraints** — second non-closed party_role fails; duplicate `registration_number` fails; cross-customer `contact_medium` pointer fails | cm01 (`tests/db/customer-schema.integration.test.ts`) | **INHERIT** — audit present & green |
| 5 | **Preferred invariants** — no path leaves contacts-with-no-preferred-contact or populated-method-with-no-preferred-method; delete-while-preferred blocked; clear-while-populated blocked | cm11–cm15 (each owns its own case) | **INHERIT** — audit present & green |
| 6 | **Optimistic-lock conflict** — second concurrent save rejected with `CONFLICT`, reload-prompt UI, never silent overwrite | cm08 (`compareAndBumpLock` + `OptimisticLockConflictBanner`) | **INHERIT** — audit present & green |
| 7 | **Audit trail** — every create/update/status-change/contact-CRUD/set-preferred call produces an `AUDIT_LOG` row with actor/timestamp/entity/before-after; `last_modified_by` reflects the true last editor | cm07–cm15 individually assert their own `writeAuditEvent` call | **ADD** (§3.5) — a module-wide sweep confirming *every* mutation service calls `writeAuditEvent` exactly once per write path (no gaps, no double-writes) |
| 8 | **Search correctness** — partial case-insensitive match on `name`/`trading_name`; capped by `CUSTOMER_SEARCH_RESULT_LIMIT`; refine-search hint at the cap | cm04 (`CustomerSearchPanel`/search service test) | **INHERIT** — audit present & green |

cm16's net-new files: the **guard.integration matrix extension** (guardrail 1), the **core-flow E2E test** (guardrail 2), and one **module-boundary sweep test** (guardrails 1/3/7 negative-space + structural invariants). Everything else is audit-and-verify, not new code.

### 2.3 What "authz-matrix entry" means concretely

Same two surfaces as every prior module's ship gate:

1. **The route × level *test* matrix** — `tests/auth/guard.integration.test.ts`, run against a live Postgres, seeding its own permissions/grants in `beforeAll`. This is the §7.9 "route × level matrix" that makes a guarded route "done." cm16 extends it (§3.2).
2. **The route → permission *doc* map** — `custmgmt-architecture.md` §4 + `custmgmt-code-standards.md` §8. Per docs-in-sync, these rows land **with** cm01's permission and cm03/cm06's guards. cm16 **verifies** them (§3.6); it edits only if the audit finds a genuine gap.

cm16 additionally covers something the Product module's `pm09` didn't need: **direct Server Action calls bypassing the nav.** Because Customer Management has nine mutation actions (vs. Product's zero), the matrix must prove a USER calling `updateOrganizationAction`, `transitionCustomerStatusAction`, `deleteContactAction`, etc. directly — not just navigating to a guarded page — is rejected. Each action already has its own per-action USER-denial test from the unit that built it (`cm07`–`cm15`, each service function's own guard check); cm16's job is to confirm all nine exist and add the **cross-cutting integration proof** that the guard itself, exercised via every action, denies a USER (§3.2 point 4).

### 2.4 No new runtime behaviour, no new mutation surface, no forbidden paths

The sweep test (§3.4) turns this module's prose invariants — one lock column for the whole customer scope (Inv. #6), contact-mutation logic confined to `contact-mutations.ts` (code-standards §7.3), transition maps confined to `validation/customer/transitions.ts` (code-standards §7 note 2), `contactMediumRepository.deleteById` callable only from `deleteContact` (cm13's structural test) — into permanent, executable CI facts, re-asserted module-wide at the ship gate rather than trusted to have survived nine mutation units unbroken.

## 3. Implementation

### 3.1 Pre-flight guardrail audit (do first, non-optional)

Before writing anything, confirm each inherited guardrail (§2.2 rows 3–6, 8) actually exists and is green on `main`, and record the exact file/test name in `custmgmt-progress-tracker.md`. Command sketch (adjust to real filenames cm01–cm15 committed):

```
grep -rIl "ORGANIZATION_TRANSITIONS\|CUSTOMER_TRANSITIONS" tests/validation      # guardrail 3
grep -rIl "party_role.*unique\|registration_number.*unique\|contact_medium.*fk" tests/db  # guardrail 4
grep -rIl "PREFERRED_METHOD_STILL_POPULATED\|CANNOT_DELETE_PREFERRED_CONTACT" tests/services  # guardrail 5
grep -rIl "compareAndBumpLock\|CONFLICT" tests/services tests/components         # guardrail 6
grep -rIl "CUSTOMER_SEARCH_RESULT_LIMIT\|refine.*search" tests                   # guardrail 8
cat tests/structure/contact-medium-delete-callers.test.ts                        # cm13's structural test
```

If any inherited guardrail is missing or red, stop — fix it in the owning unit (`cm01`–`cm15`), re-verify, and only then proceed to cm16's net-new pieces (§3.2–§3.5). Do not invent a replacement test here.

### 3.2 Authz-matrix entry — extend `tests/auth/guard.integration.test.ts` (edit)

Four surgical edits inside the existing `describe.skipIf(!databaseUrl)` block:

1. **Seed the `customers` permission** — add to the `beforeAll` seed array: `{ permissionName: "customers", permissionInfo: "Customers" }`.
2. **Grant it to the MANAGER role** at `EDIT` (the module's ceiling — no `DELETE` level exists, code-standards §8): `{ name: "customers", type: "EDIT" }`. Grant it to the USER role at `READ` only, mirroring the real permission map.
3. **Route × level cases** — append to the `it.each([...])` satisfied-permission table: `[PERMISSIONS.CUSTOMERS, LEVELS.READ]` for both USER and MANAGER principals; `[PERMISSIONS.CUSTOMERS, LEVELS.EDIT]` for MANAGER only, asserting the USER principal's `permissionMap.customers` does **not** satisfy `EDIT`.
4. **Direct-action denial loop (new to this module, §2.3)** — a new `it.each` over all nine `actions/customer/*.ts` exports, each invoked directly (not via a page render) with a USER-level session/principal, asserting every one returns/redirects on the guard rejection rather than executing its mutation. This is the integration-level proof complementing each action's own unit-level USER-denial test (`cm07`–`cm15`).
5. **No-grants denial** — append `PERMISSIONS.CUSTOMERS` to the existing no-grants-principal → `/no-access` loop, for both `/customers/view` and `/customers/manage`.

### 3.3 Core-flow E2E test — `tests/e2e/customer-core-flow.integration.test.ts` (new)

The one genuinely new test this unit adds beyond matrix/sweep bookkeeping — no prior unit owns the **chained** flow, only its individual steps. Runs against a live Postgres, MANAGER principal:

1. Create a customer (`createCustomer`) with a similar-name confirm round-trip.
2. Add a contact (`addContact`) — assert auto-preferred-contact (first contact, cm11).
3. Add phone, then email, to that contact (`updateContact`, two calls) — assert auto-preferred-*method* resolves to phone (cm11/cm12 priority rule).
4. Transition organization status `INITIALIZED → VALIDATED → ACTIVE` (`transitionOrganizationStatus`, two calls, each with `status_reason`).
5. Transition customer status `REGISTERED → ACTIVE` (`transitionCustomerStatus`, with `status_reason`).
6. Call `getCustomerDetail` (the cm02 read service backing View Customer) — assert the final state (org ACTIVE, customer ACTIVE, contact with preferred method PHONE) is visible exactly as written, with no `isStatusInconsistent` flag raised (cm05).

Each step's `ok: true` result is asserted before proceeding to the next — a failure at any step fails the test at that step, not silently cascading.

### 3.4 Guardrail sweep — `tests/guardrails/customer-module-boundaries.test.ts` (new)

Static-source assertions, `node:fs`/`node:path` only, no DB, no jsdom — mirrors Product module's `pm09` sweep shape:

1. **Single lock column** (Inv. #6) — grep `db/schema/customer.ts` and assert `last_modified_datetime` appears only on `party_role`, never re-declared on `organization` or `contact_medium` as an independent lock column (contact/org writes go through the party_role lock, not a column of their own).
2. **Contact-mutation logic confined to one file** (code-standards §7.3) — assert every one of `addContact`/`updateContact`/`deleteContact`/`setPreferredContact`/`setPreferredContactMethod` is defined in `services/customer/contact-mutations.ts` and imported (not redefined) everywhere else it's used.
3. **Transition maps confined to one file** (code-standards §7 note 2) — grep the full source tree outside `validation/customer/transitions.ts` for any inline redeclaration of transition edges (e.g. a literal `'INITIALIZED': ['VALIDATED']`-shaped object elsewhere); assert none exists.
4. **`contactMediumRepository.deleteById` callable only from `deleteContact`** (cm13's own structural test) — re-assert module-wide at the ship gate, same grep-based approach, so a later unit's stray direct call doesn't slip past a review that assumed cm13's original test still covers it after seven more units touched the panel.
5. **All nine `actions/customer/*.ts` files exist**, matching code-standards §7's file tree exactly — `create-customer.ts`, `update-organization.ts`, `transition-organization-status.ts`, `transition-customer-status.ts`, `add-contact.ts`, `update-contact.ts`, `delete-contact.ts`, `set-preferred-contact.ts`, `set-preferred-contact-method.ts`.
6. **No `DELETE` permission level seeded for `customers`** (code-standards §8, build-plan note) — grep the permission-seed migration and assert only READ/EDIT rows exist for `customers`.

Each assertion carries a one-line comment citing its invariant.

### 3.5 Audit-trail completeness sweep — extend `tests/guardrails/customer-module-boundaries.test.ts` or a sibling `tests/guardrails/customer-audit-completeness.test.ts` (new)

Confirms guardrail 7 module-wide: every exported mutation function in `services/customer/*.ts` (create-customer, update-organization, transition-organization-status, transition-customer-status, contact-mutations' five functions) contains exactly one `writeAuditEvent` call on its success path, with an `eventType` string unique to that mutation (no two mutations share an `eventType`, so the audit log is unambiguous about which action produced which row). Static AST-or-grep check, not a live-DB test (the live-DB proof that `AUDIT_LOG` rows actually land correctly is each unit's own service test, already inherited).

### 3.6 Doc / permission-map verification (verify; edit only if a gap is found)

Confirm consistency across:

- `custmgmt-architecture.md` §4 — the five-route permission map, `customers : READ/EDIT`, no DELETE row.
- `custmgmt-code-standards.md` §8 — the per-page map table (already reproduced in this spec's header context — confirm it matches what actually shipped in cm03/cm06/cm08).
- `auth/permission-constants.ts` — `PERMISSIONS.CUSTOMERS = "customers"`; `types/rbac.ts` `PERMISSION_NAMES` contains `"customers"`.

If all present and correct: no doc edit in cm16. If a gap is found, fix it in the same change set and note it in the tracker — do not create a parallel map.

### 3.7 Full verification pass (workflow §8 — the point of the ship gate)

Run the entire checklist and record results in the tracker:

- `npm run typecheck` — clean; `customers` key present across every `EffectivePermissionMap` fixture.
- `npm run lint` / `npm run format:check` — clean.
- `npm run test` — both unit and integration configs green, incl. the extended `guard.integration.test.ts` (requires `DATABASE_URL` — the ship gate must not accept a `skipIf`-skipped matrix) and the new core-flow E2E test.
- **Regression** — every pre-existing module's routes (User Management, Product Management, Administration) render at identical URLs with identical authz results; zero pre-existing assertion changed.
- **Security scan** — SAST + OWASP ZAP DAST baseline: no high/critical finding; the five new Customer routes exercised as authenticated-only (unauthenticated → `/login`, no-grant → `/no-access`, USER on `/customers/manage/**` → `/no-access`).
- **Behavioural spot check** (dev server): the core flow from §3.3 reproduced by hand through the actual UI, incl. a deliberately induced optimistic-lock conflict (two tabs, same customer) producing the reload-prompt banner, not a silent overwrite.

### 3.8 Commit

One commit, e.g. "customer module ship gate: authz-matrix entries + guardrail sweep (cm16)." Contents: `tests/auth/guard.integration.test.ts` (edit), `tests/e2e/customer-core-flow.integration.test.ts` (new), `tests/guardrails/customer-module-boundaries.test.ts` (new), `tests/guardrails/customer-audit-completeness.test.ts` (new) — and only if §3.6's audit found a genuine gap, the corresponding doc-row fix. Explicitly not in this commit: any `app/**`, `services/**`, `db/**`, `validation/**`, `components/**`, `actions/**`, or `infra/**` change; any dependency/lockfile change.

---

## 4. Dependencies (packages to install)

**None.** Same toolchain every prior unit already uses (`vitest`, `drizzle-orm`/`postgres`, `node:fs`/`node:path`).

## 5. Verification checklist

**The eight guardrails (build-plan visible result — all must be green)**

- [ ] **Authz matrix** — all 5 routes × USER/MANAGER pass correctly; all 9 `actions/customer/*` reject a direct USER call; no-grants → `/no-access` on both search pages.
- [ ] **Full core flow** — search → create → contact/methods → both status-transition chains → visible correctly in View Customer, end to end, no errors.
- [ ] **Transition-map edges** — every invalid edge rejected; every valid edge without `status_reason` rejected, both maps.
- [ ] **DB constraints** — second non-closed party_role, duplicate `registration_number`, cross-customer contact pointer all fail at the DB.
- [ ] **Preferred invariants** — no path produces contacts-with-no-preferred-contact or populated-method-with-no-preferred-method; delete-while-preferred and clear-while-populated both blocked.
- [ ] **Optimistic-lock conflict** — second concurrent save rejected with `CONFLICT` + reload-prompt UI, never silent overwrite.
- [ ] **Audit trail** — every mutation call produces exactly one correctly-shaped `AUDIT_LOG` row; `last_modified_by` reflects the true last editor everywhere.
- [ ] **Search correctness** — partial case-insensitive match; capped at `CUSTOMER_SEARCH_RESULT_LIMIT`; refine-search hint shown at the cap.

**Guardrail-sweep tests (net-new)**

- [ ] `customer-module-boundaries.test.ts` — single lock column, contact-mutation confinement, transition-map confinement, `deleteById` caller confinement, all nine action files present, no `DELETE` permission level seeded.
- [ ] `customer-audit-completeness.test.ts` — every mutation service function has exactly one `writeAuditEvent` call with a unique `eventType`.

**Diff hygiene**
- [ ] Only `tests/**` files changed (list in §3.8). No `app/**`/`services/**`/`db/**`/`validation/**`/`components/**`/`actions/**`/`infra/**` edit. No dependency/lockfile change.
- [ ] No pre-existing test assertion changed except the intended matrix additions. No `TODO`, commented-out code, or `console.*`.

**Build gates**
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` green.
- [ ] `npm run test` green — both configs; integration suite runs with `DATABASE_URL` set, not skipped.

**Docs in sync**
- [ ] `custmgmt-architecture.md` §4 and `custmgmt-code-standards.md` §8 confirmed consistent with what shipped; no parallel map created.
- [ ] `custmgmt-progress-tracker.md` marks `cm16` complete, records the guardrail-audit results, and signs off the full 16-unit build as ship-gated.

**Pipeline**
- [ ] CI green end-to-end: typecheck, lint, format, unit + integration suites, secret scan, SAST + OWASP ZAP DAST baseline (no high/critical).

Any failing item means the module is not shipped. With `cm16` verified and merged, the Customer Management module's specs (`cm01`–`cm16`) are complete — implementation against these specs, in dependency order, is the next phase.
