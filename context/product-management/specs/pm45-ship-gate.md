# pm45 — Ship gate: guardrails, authz matrix, docs

**Unit:** pm45 (Part 3, final). **Boundary:** `tests/**` and the documentation set. The only production code this unit may touch is a defect it finds — and each such fix is called out separately in the PR, never folded in silently.
**Specs from:** `prodmgmt-code-standards.md` §9 (guardrails 23–30 and the five re-scoped) · `prodmgmt-ai-workflow-rules.md` §8 · plan V1–V10, §9 · `prodmgmt-update-overview.md` success criteria 1–14.
**Depends on:** pm35–pm44, all committed and green.

---

## Goal

Prove the update's fourteen success criteria with committed tests, land the documentation amendments the invariant changes require, and empty both Appendix A tables so no doc still describes a rule the code has stopped following.

---

## Design

### D1. The gate asserts, it does not re-implement

Most of what this unit needs already exists: pm36–pm44 each landed their own tests. pm45 adds the guardrails that span units — the ones no single unit could assert because they are about the module as a whole — and the authz matrix rows. Where an earlier unit's test already proves a criterion, reference it by file and test name rather than writing a second copy (the pm34 precedent: guardrails 15 and 22 name their permanent home instead of duplicating).

### D2. Guardrails that belong here, and where the others live

| Guardrail                                                    | Home                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| 23 — transition set complete, no `setLifecycleStatus` helper | **here** (spans pm42–pm44)                                          |
| 24 — DRAFT-only child writes, repository + trigger           | pm36 I3, pm38 I7 — referenced                                       |
| 25 — family uniqueness, index-enforced                       | pm36 I3/I4 — referenced                                             |
| 26 — hard delete with cascade and audit                      | pm44 I6 — referenced                                                |
| 27 — price completeness, Zod + DB, seeds included            | pm35 I4, pm38 I7 — referenced                                       |
| 28 — retirement gate                                         | pm43 I9 — referenced                                                |
| 29 — query budget                                            | **here**, extended to the full page lifecycle                       |
| 30 — status-literal sweep                                    | **here** (repo-wide, including `workflow-management/**` reporting)  |
| 2, 8, 11, 13, 16 (re-scoped)                                 | rewritten in the unit that changed the behaviour; **verified here** |

### D3. The status-literal sweep is a committed test, not a one-off grep

G2's audit was a pre-flight activity; guardrail 30 is its permanent form — a test that walks the repo's source, collects every `'RETIRED'` and `'OBSOLETE'` literal outside `db/schema/product.ts` and `types/product.ts`, and compares the set against an allow-list committed beside the test with a one-line reason each. A new comparison added later fails CI until it is justified. Findings in `workflow-management/**` are reported by the test as a warning list, never asserted — that directory is read-only from this repo.

### D4. The query-budget test covers the whole lifecycle, not just first load

Extend pm39/pm40's assertions to: no selection (2), selection, version switch, selection of an `OBSOLETE` version (+1 for the live count, pm43 I7), and **after a mutation**. Use the **exact** integers pm40 D5 pins from its caching decision — never a "3 or 4" range, which lets a real +1 regression pass. Note the post-mutation case is **not** cheaper than a fresh selection: `revalidatePath` invalidates the whole route, so a mutation re-renders the page and re-issues the full selection budget. Assert that it equals the selection budget (it must not grow _beyond_ it, and must not be asserted as a partial "panels only" refresh, which the architecture cannot do). Assert statement counts per table so an N+1 fails even when the total coincidentally matches.

### D5. Documentation is part of the gate

The §9 amendment list from the plan lands here if it has not already landed with its unit. Two appendices must be **empty** at the end: `prodmgmt-code-standards.md` Appendix A (four rows) and `prodmgmt-ai-workflow-rules.md` Appendix A (four rows). Each row is removed only when the code it describes is actually gone — verify by grep, not by memory. An appendix row that cannot be cleared means a unit is incomplete, and the gate fails.

---

## Implementation

### I1. Guardrail 23 — transition set (`tests/guardrails/product-lifecycle-transitions.test.ts`, new)

- Source-level: no file under `services/product/`, `actions/product/` or `db/repositories/` exports a function taking a lifecycle status as a parameter (regex over signatures), and no `setLifecycleStatus`-style identifier exists anywhere.
- Behavioural: a table-driven test over all 25 ordered pairs of the five statuses plus delete — each pair either maps to a named service that succeeds, or has no code path and is proven unreachable by the absence of a caller.
- `actions/product/` exports exactly **fourteen** files — the eight pre-existing catalog actions plus the six this update adds: `update-price`, `delete-price` (pm38), `submit-for-testing`, `return-to-draft` (pm42), `obsolete-offering` (pm43), `delete-offering` (pm44). Assert the explicit file **set** from the code-standards §7 tree, not a bare count, so a missing or extra file fails by name. (An earlier draft said "thirteen"; that predated pm44's `delete-offering`. Extends the existing `PRODUCT_ACTION_FILES` assertion.)

### I2. Guardrail 29 — query budget (`tests/app/manage-products-query-budget.integration.test.ts`, extended)

Per D4, including the post-mutation case. Assert statement counts per table, so a future N+1 against `product_offering_price` fails even if the total happens to match.

### I3. Guardrail 30 — status-literal sweep (`tests/guardrails/status-literal-sweep.test.ts`, new)

Per D3, with the allow-list committed as `tests/guardrails/status-literal-allowlist.ts`, each entry `{ file, literal, reason }`.

**Guardrail 30 does not prove OBSOLETE bills.** It proves the _absence_ of an `'OBSOLETE'`/`'RETIRED'` literal that would treat the version as unbillable. The bill run never reads `lifecycle_status` at all (it resolves by the pinned `product_offering_id`), so success-criterion "nothing treats OBSOLETE as unbillable" is _vacuously_ true there and guardrail 30 gives false confidence on it. The real proof that an OBSOLETE-pinned subscription still bills is **pm43's billing-regression integration test** — reference it here, do not lean on the sweep for it.

### I4. Authz matrix (`tests/auth/guard.integration.test.ts`, extended)

Rows for all five new actions × the three levels. Explicitly: an `EDIT`-only principal reaches submit-for-testing, return-to-draft, activate, and every content write, and is refused stop-selling, retire and discard. A no-grant principal reaches nothing. Deep links (`?family=`, `?version=`) grant nothing.

### I5. Success-criteria evidence table

A short section appended to `prodmgmt-update-overview.md`: each of the fourteen criteria mapped to the test file and the case that proves it — the exact test name where a single `it` owns the criterion, otherwise the file plus the specific proving scenario (some criteria are proven by several cases across a file). This is the artefact a reviewer reads instead of re-deriving coverage, and it makes an unproven criterion visible rather than assumed.

### I6. Documentation amendments landed and verified

1. `architecture.md` §7 Inv. #18 — amended wording, with the design-review note (G1's approval recorded).
2. `prodmgmt-architecture.md` Inv. #1, #6, #13, #14, #17 amended; #23–29 present; §3.2's period mapping matching pm35's CHECK; §5's event table matching the code (six added, one removed).
3. `prodmgmt-code-standards.md` §7 tree — every `(new)` marker removed, every `(del)` line gone; §4.8 component list matching reality; Appendix A empty.
4. `prodmgmt-ai-workflow-rules.md` — Appendix A empty; §2's unit table marked delivered.
5. `prodmgmt-ui-context.md` §1 and §7 matching the shipped badges, actions and dialogs.
6. `pm00-build-plan.md` — Part 3 marked delivered, with the per-unit visible results as built.
7. `db/migrations/README.md` / `prodmgmt-ai-workflow-rules.md` §6.2 — the one-round `0006` exception recorded as **closed**: forward-only is the rule again from here.

### I7. Hand-off register

A short section in the plan document listing what this update deliberately left for other phases, each with its trigger: H1 unit spelling (`'MBPS'` → `Mbps` in rm07's profile and the sample seed), H2 rate-based unit basis, H3 `PER_UNIT` rating, O2 `EA`'s fate, O3 `MB`/`GB` normalisation, plus every `workflow-management/**` finding from guardrail 30's warning list.

---

## Dependencies

**Packages to install: none.** The sweep uses the same `fs`/`path` walk the existing guardrail tests use; the query counter is the harness hook pm39 introduced.

---

## Verification checklist

- [ ] All thirty guardrails pass, including the five re-scoped ones asserting the amended rules.
- [ ] The full suite is green on a database built from empty (`db:setup` → `db:seed-demo` → `db:seed-sample` → tests), and `tests/db/migration.integration.test.ts` (drop-all-schemas → `migrate()` from empty → idempotent second run) passes — the actual proof of D11's edit-in-place `0006`, named in pm35 and pm36.
- [ ] Orders, Subscriptions, Customer, Accounts, Billing and Rating suites pass unchanged; no Administration URL or authz result moved.
- [ ] The authz matrix covers all five new actions in both directions of the EDIT/DELETE split.
- [ ] Query budget holds for all five lifecycle cases, including after a mutation.
- [ ] Guardrail 30's allow-list is complete, each entry justified; `workflow-management/**` findings are reported and carried to the hand-off register.
- [ ] Every one of the fourteen success criteria maps to a named, passing test in I5's table.
- [ ] Both Appendix A tables are empty, and grep confirms the code they described is gone.
- [ ] The `0006` in-place exception is recorded as closed; forward-only is restored.
- [ ] `tsc --noEmit`, ESLint, Prettier, SAST and the DAST baseline clean.
- [ ] Any production fix made during this unit is listed separately in the PR with its cause.

**Definition of done:** the update is provably complete — every criterion has a test, every amended invariant has its approval recorded, and no document in the module still describes the old rules.
