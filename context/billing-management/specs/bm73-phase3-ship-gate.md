# bm73 — Invoice Template Phase 3 ship gate

**Unit:** bm73 (Invoice Template Phase 3) · **Status:** Delivered (automated gate 2026-10-17; manual run signed off by the owner 2026-10-18, with a recorded gap) · **Boundary:** cross-cutting: tests, docs and the tracker. **Nothing new is built** (the bm13/bm21/bm35/bm39/bm46/bm63 discipline) · **Depends on:** bm64–bm72
**Authorizes:** the update overview's success criteria 1–15 · Inv #51–#58 and the 2026-10-15 amendments (#36, #40–#42, #44, #46) · guardrail items 57–67 · workflow rules §2.7, §7.8, §8

## Goal

Prove Invoice Template Phase 3 works end to end:
- on a fresh environment, with your real-world sample data (~5 BANs, the largest ~900 polygons);
- every success criterion (1–15) is backed by named evidence;
- every Phase 3 invariant is audited and every guardrail is green.

Then fold the update into `billmgmt-project-overview.md`.

## Design

**The journey** (one fresh environment, built with the bm64 runbook: empty database, empty `invoice-templates` container, `db:setup`, then the owner's sample data loaded through the normal rating path so `udr_rated` carries raw `udr_key` and `udr_resource`):

| Step | Action | What is checked |
|---|---|---|
| 1 | Trigger the run (`billrun_operate`) | Every non-EXCLUDED BAN is stamped `BTF00000001` + the ACTIVE Standard version; the trigger audit lists the stamps (criterion 1) |
| 2 | Review drafts for every BAN | Page 1 blocks, detail pages and the last page render; a ~900-polygon BAN paginates with repeated label and header and "Page X of Y" bottom-right (criteria 5, 7, 8, 10) |
| 3 | Edit footnote line 2 → save draft → preview → Activate (Admin/Manager) | New version, same `ref_layout_version_id`; default v1 stays ACTIVE (criterion 11) |
| 4 | Re-open the drafts | Still the old footnote: the run is frozen (criterion 2) |
| 5 | Rerun one BAN (`billrun_operate`, with a reason) | Only that BAN re-captures; the rerun audit lists it; its draft shows the new footnote (criterion 3) |
| 6 | Approve (a second `billrun_approve` user) → post | Bill stamps equal the run stamps plus the family; stored PDFs match; no live resolution (criteria 2, 4) |
| 7 | Distribute to the loopback → `COMPLETED` | Within the ~1 hour budget (criterion 14); the run's timings are recorded |
| 8 | Negative fixtures (seeded in a separate test run, never in the owner's data) | NULL family version → draft 422, then posting `SKIPPED` with no INV; negative Utilised → `INVOICE_NEGATIVE_UTILISED`; missing polygon data → `INVOICE_POLYGON_DATA_MISSING`; 10,001 rows → `INVOICE_USAGE_OVER_LIMIT` (criteria 6, 9) |

The journey is automated where the test stack allows: extend `tests/e2e/invoice-template-journey.integration.test.ts` with steps 1–6 and 8 on the `ci` fixtures, plus a 900-polygon fixture. It is run **manually** on your sample data against the local Kestra + Postgres + Azurite stack, for step 7 and the timing.

**Success criteria → evidence:**

| # | Criterion | Evidence |
|---|---|---|
| 1 | Template resolution | `tests/db/trigger-run.integration.test.ts`, `run-template-capture.integration.test.ts` (bm65); journey step 1 |
| 2 | Freeze | `draft-uses-run-stamps.integration.test.ts` (bm66); `invoice-version-pinning.integration.test.ts` (rewritten, bm67); journey steps 4 and 6 |
| 3 | Rerun | `run-template-capture.integration.test.ts` case 2 (bm65); journey step 5 |
| 4 | One resolver | `tests/guardrails/no-live-template-resolution.test.ts` (item 57, bm67) |
| 5 | Amounts | `invoice-capacity-summary.integration.test.ts` (item 62, bm70); `invoice-golden` last page (bm72) |
| 6 | Non-negative guard | the item 62 negative case (bm70); journey step 8 |
| 7 | Other charges | `bind.test.ts` and the page-1 golden (bm70) |
| 8 | Detail section | `invoice-capacity-detail.integration.test.ts` (item 63, bm71) |
| 9 | Bad data fails loud | item 63 cases 4–6 (bm71); journey step 8 |
| 10 | Layout | `invoice-golden` structural goldens (item 64, bm71 + bm72); the Chromium e2e on the ~900-polygon fixture |
| 11 | v1 pinned | `invoice-template-v1-pin.test.ts` and the `activate-template` integration (item 65, bm72); fresh-environment seeding in journey setup |
| 12 | Flow | `billrun-capacity-trace.integration.test.ts` and `phase3-boundaries.test.ts` (item 66, bm68) |
| 13 | Customer Management untouched | `phase3-boundaries.test.ts` (item 66) and `git diff --stat` over `services/accounts/`, `components/customers/`, `app/(app)/customers/`, `actions/accounts/`, `0050` since bm63 |
| 14 | End-to-end | the manual journey on your sample data, with timings recorded in the progress tracker |
| 15 | Build health | the full suite run in the "Implementation" section below |

**Invariant audit.** For each of Inv #51–#58 and the six amended invariants, cite the code (file:line) and the test that proves it, in the progress-tracker entry. Any invariant without both is a failure, not a follow-up.

**Earlier guardrails re-run:** items 1–56 that cover touched files. That includes, at minimum:
- the compute boundary, the rating write boundary and the finalization guard;
- the checksum (35, 46);
- the three-handler route inventory;
- 43–47, 50, 55 and 56;
- the cm22 binding-boundaries file (with bm65's single narrowing).

## Implementation

### 1. Automated suites (no new feature code)

Run `npm run typecheck`, `npm run lint`, `npm test` (unit), the integration project (`vitest.integration.config.ts`) on a disposable Postgres + Azurite, the Chromium e2e (`RUN_CHROMIUM_E2E=1`) and the browser e2e (`npm run test:e2e:invoice-settings`). Record the pass/fail counts.

### 2. Journey test

Extend `tests/e2e/invoice-template-journey.integration.test.ts` with Phase 3 steps 1–6 and 8 (the step-7 SFTP/loopback hop stays covered by the existing distribution suites). Add a 900-polygon fixture builder in `tests/db/helpers/` if bm71 didn't already add one.

### 3. Manual run on your data

Load your sample data per the bm64 runbook and run steps 1–7. Record the run id, wall-clock times per stage and the PDF page counts in the progress tracker.

### 4. Docs (fold and flip)

- `billmgmt-project-overview.md`: add a section "Invoice Template Phase 3 — bill run uses the BAN's template (delivered, bm64–bm73)", folded from the update overview: overview, goals, flow, features, scope, and criteria 1–15 with evidence. Update the "Current state" block.
- The update overview: back to pointers only (workflow rules §7.8).
- `billmgmt-architecture.md`: Phase 3 section status → "Delivered (bm64–bm72), signed off by bm73"; every "planned" marker on #51–#58 and the amendments → "built (bmNN)"; the status table row.
- `billmgmt-code-standards.md`: Phase 3 section status → delivered; every guardrail item 57–67 → "built (bmNN)" with its test file.
- `billmgmt-ai-workflow-rules.md`: re-scope as the last revision did. Phase 3 rules move into §0 carried-forward, and the "What changed" row is added.
- `billmgmt-ui-context.md`: §10b and §10d status → delivered; §6d left as history.
- `billmgmt-known-issues.md`: §19 closed (bm67); §23e (fonts) closed (bm70); §20 (generated templates unstyled) re-checked against the new v1.
- `specs/bm00-build-plan.md`: Part 5 status → delivered.
- `TODOS.md` (repo root, planning): the Phase 3 entry notes the delivered scope and that the BAN family dropdown and create/retire family screens are deferred to the phase that adds a second family (D45, D46).
- Customer Management (`context/customer-management/`): add a note to Inv #18 that run-start capture (bm65) is the one sanctioned reader of `billing_account.ref_bill_template_version_id`.

## Dependencies

- **Packages:** none.
- **Units:** bm64–bm72 all delivered and green.
- **Environment:**
  - a local Kestra + Postgres + Azurite stack with the bm68 flow deployed;
  - rating Phase H deployed;
  - your sample data available;
  - two users with `billrun_operate` / `billrun_approve` (four-eyes) and one with `invoice_settings : EDIT`.

## Verification checklist

_Signed off 2026-10-18; evidence in the bm73 entry of `billmgmt-progress-tracker.md`._

- [x] Success criteria 1–15 are each met, with the evidence in the table recorded in the progress tracker. _(Criterion 14 met with a gap the owner accepted: steps 3–5 rest on the automated journey, and step 2's draft review on the posted PDFs, because of known-issues §26.)_
- [x] Inv #51–#58 and the six amendments are audited, each with code and test. _(One gap found and closed: journey step 8e.)_
- [x] Guardrail items 57–67 are green, and every earlier guardrail covering touched files is green.
- [x] The journey on your sample data reaches `COMPLETED` within ~1 hour, with timings recorded. _(`BRN00000001`: processing ~10 s, posting ~12 s, distribution ~39 s.)_
- [x] No Customer Management production file changed since bm63, and `0050` is unchanged. _(Measured from bm64's parent; the bm63→bm64 changes are cm17–cm21.)_
- [x] The v1 pin is in place; a fresh environment seeds and renders v1.
- [x] Every doc in Implementation §4 is updated in the same change set; no "planned" marker remains for Phase 3.
- [x] Nothing new is built in this unit: the diff is tests and docs only. _(Except the fixes the manual run forced, recorded as findings in the tracker: the bm03 partial-period predicate, the business time zone in the bill-run flow, and the `billrun_runtime` column grant.)_

## Open questions

None. TC54 (the capacity-aware live harness) and O-TC7 stay open from Part 3; they are not part of this gate.
