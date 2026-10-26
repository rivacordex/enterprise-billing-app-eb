# bm85 — Invoice Template Types ship gate

**Unit:** bm85 (Invoice Template Types · Part 6, unit 12 of 12) · **Status:** Delivered 2026-10-26 (manual pass pending; see the progress tracker) · **Boundary:** cross-cutting: tests, docs and the tracker. **Nothing new is built** (the bm13/bm21/bm35/bm39/bm46/bm63/bm73 discipline) · **Joint with Customer Management cm24** (`context/customer-management/specs/cm24-template-types-ship-gate.md`), in the same change · **Depends on:** bm74–bm84, cm23
**Authorizes:** the update overview's success criteria 1–11 · Inv #59–#68 and the amendments to #44–#47, #49 and #54 · guardrail items 68–79 · workflow rules (Types update) close-out

## Goal

Prove the Invoice Template Types update works end to end:
- on a fresh environment, with a real editor export
- every success criterion (1–11) is backed by named evidence
- every invariant in Inv #59–#68 is audited, and every guardrail is green

Then fold the update into `billmgmt-project-overview.md` and delete the update overview, in the same change as cm24's Customer Management fold.

## Design

**The journey** runs on one fresh environment: an empty database, an empty `invoice-templates` container, `db:setup` (Standard v1 only), and the `ci` sample BANs. Its steps:

| Step | Action | What is checked |
|---|---|---|
| 1 | MANAGER creates "Wholesale", uploads an editor export of `INVTPL-WHOLESALE` v1, previews and activates it | `WHOLESALE` / `INVTPL-WHOLESALE`; the layout DRAFT and settings DRAFT, then the ACTIVE pair; the type shows **Usable** v1; one audit row per step (criterion 1) |
| 2 | RevOps (`customers` + `accounts_transactions` EDIT) binds BAN A to Wholesale on Manage Customer | One CAS update and one `BILLING_ACCOUNT_TEMPLATE_CHANGED`; the label reads "Wholesale · v1"; Bound BANs = 1 (criteria 1, 10; CM criteria 2, 7) |
| 3 | Trigger the run | BAN A is stamped Wholesale + settings v1, and the NULL BANs are stamped Standard; BAN A's draft renders through `INVTPL-WHOLESALE` (criterion 1; CM criterion 10) |
| 4 | MANAGER retires Wholesale to Standard (typed name) | BAN A becomes `NULL`, with one audit row carrying `reason: 'TEMPLATE_TYPE_RETIRED'`; zero BANs remain; Wholesale's version rows are unchanged (criterion 8; CM criterion 8) |
| 5 | Rerun BAN A | The confirm lists "Invoice template type changed since run start: Wholesale → Standard"; the rerun re-stamps Standard; the new draft renders on Standard |
| 6 | Approve (a second `billrun_approve` user), then post | BAN A's bill carries Standard's family and version stamps; Wholesale's detail page still shows its history and exports |
| 7 | Upload an editor export of `INVTPL-STD-A4` v2 to Standard, then activate | Standard DRAFT v2, then ACTIVE v2; a new run renders every NULL BAN on v2; no `billing_account` row changes; Standard v1's rows are byte-identical (criterion 2) |
| 8 | Export Wholesale's last pair, then restore it into a second fresh database's empty "Wholesale" | Byte-identical layout blobs; `settings.json` matches; DRAFT v1 with the same settings; preview HTML equal for the same input (criterion 7) |
| 9 | Overwrite and stale preview: two browser sessions on one type | The overwrite warning names the version, date and author; the overwrite keeps the row; the session holding the pre-upload token fails Activate; double-submit gives one DRAFT and one `DRAFT_CHANGED_SINCE_WARNING` (criteria 3, 5) |

Steps 1–8 are automated in `tests/e2e/invoice-template-journey.integration.test.ts` on the `ci` fixtures. The editor exports are fixture zips built from `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/` and from Standard v1's files, re-coded, re-versioned and re-checksummed. Step 9 and one pass of steps 1–3 are run **manually** in the browser, with a zip exported by the real editor (`invoice-editor`, after its E7 contract refresh), against the local Postgres + Azurite stack.

**Success criteria → evidence:**

| # | Criterion | Evidence |
|---|---|---|
| 1 | New type to live invoice | journey steps 1–3 and 6; `upload-layout-package`, `activate-template-pair`, `run-template-capture` (Wholesale case) integration suites (bm78, bm79, bm82) |
| 2 | New version of an existing type | journey step 7; `invoice-template-v1-pin.test.ts` still green |
| 3 | Overwrite with warning | `overwrite-layout-draft.integration.test.ts` (bm80); journey step 9 (manual) |
| 4 | Bad packages rejected, nothing written | `upload-layout-gate.test.ts` (one fixture per code) and the no-write cases in `upload-layout-package.integration.test.ts` (guardrail 69); `invoice-layout-compliance.test.ts` and `compliance-visible.e2e.test.ts` (guardrails 72, 73) |
| 5 | Drafts never reach a bill | `load-layout-draft.test.ts` and the capture DRAFT case (guardrail 70); the stale-preview cases in `activate-template-pair` and `overwrite-layout-draft` (guardrail 71) |
| 6 | Rendering network-blocked | `upload-gate-chromium.e2e.test.ts`, the bm75 render e2e, and `activate-template-chromium.e2e.test.ts` (guardrail 74); the Standard v1 golden unchanged |
| 7 | Export and restore round trip | `export-restore-template.integration.test.ts` (guardrail 78); journey step 8 |
| 8 | Binding and retire race-safe | `retire-template-type.integration.test.ts` race cases (guardrail 76); cm23's bind-gate lock test |
| 9 | Migrations on a populated DB | `invoice-template-types-catalog.integration.test.ts` (guardrail 75); `billing-account-template-type-migration.integration.test.ts` (cm23) |
| 10 | Access holds | `invoice-settings-authz-matrix.test.ts` with every new action and route; CM's authz rows (cm23) |
| 11 | The editor and the app agree | in `invoice-editor`: `contract-drift.test.ts` green against the snapshot of this commit's `compliance.ts`; a manual export uploaded cleanly (journey, manual pass) |

**Invariant audit.** For each of Inv #59–#68, and the amendments to #44–#47, #49 and #54, cite the code (file:line) and the test that proves it, in the progress-tracker entry. Any invariant without both is a failure, not a follow-up.

**Guardrails:**
- **This update's:** items 68–79 green.
- **Earlier guardrails that cover touched files, re-run:** at minimum:
  - the checksum items (35, 46)
  - the route-handler inventory, now with the export handler
  - items 43–47, 50 and 55–67
  - the compute and finalization boundaries
  - CM guardrails 11–13 (cm24)

## Implementation

### 1. Automated suites (no new feature code)

Run:
- `npm run typecheck`, `npm run lint` and `npm test` (unit)
- the integration project on a disposable Postgres + Azurite
- the Chromium e2e (`RUN_CHROMIUM_E2E=1`)
- the browser e2e (`npm run test:e2e:invoice-settings`)

Record the pass/fail counts. In `invoice-editor`, run its test suite after E7 (the contract refresh that bm76 flagged) and record the snapshot's source commit.

### 2. Journey test

Extend `tests/e2e/invoice-template-journey.integration.test.ts` with steps 1–8:
- through the services and actions, as the existing journey does, not the UI
- the second fresh database for step 8 uses the `disposable-database.ts` helper. Its preview comparison renders the restored DRAFT with `draft: true` (the bm79 review fix: without it, the preview shows the version in use, and a fresh type has none)
- the fixture zips are built with bm78's `tests/helpers/layout-package.ts`

### 3. Manual run

1. Export `INVTPL-WHOLESALE` v1 from the editor.
2. Run steps 1–3 and step 9 in two browser sessions (MANAGER and RevOps).
3. Record, in the progress tracker:
   - the type id and the run id
   - the zip's digest
   - the overwrite warning text as shown
   - the stale-Activate result

### 4. Docs (fold and flip)

- **`billmgmt-project-overview.md`:**
  - **Add** a section "Invoice Template Types — editor upload, type catalog, BAN binding (delivered, bm74–bm85)", folded from the update overview: overview, goals, flow, features, scope, and criteria 1–11 with evidence.
  - **Update** the "Current state" block.
- **The update overview:** **deleted**, in the same change as cm24's deletion of `custmgmt-update-overview.md`. Every link to it, in the Billing and CM docs, `TODOS.md` and the plan files' headers, is repointed to the project overview.
- **`billmgmt-architecture.md`:**
  - the Types section status → "Delivered (bm74–bm84), signed off by bm85"
  - every "planned" marker on #59–#68 and the amendments → "built (bmNN)"
  - the status table row
- **`billmgmt-code-standards.md`:**
  - the Types section status → delivered
  - guardrail items 68–79 → "built (bmNN)", each with its test file
  - the superseded-rules table kept as history
- **`billmgmt-ai-workflow-rules.md`:** the Types rules move into §0 carried-forward, and the "What changed" row is added.
- **`billmgmt-ui-context.md`:** the Types delta and §10e status → delivered.
- **`billmgmt-known-issues.md`:** anything the gate finds, and the close of any entry this update resolved.
- **`specs/bm00-build-plan.md`:** Part 6 status → delivered. The delivered units are compacted to a numbering-record table, as was done for Parts 4–5.
- **`TODOS.md`:**
  - **Closed:** the "Phase 3: catalog + posting reads the BAN binding" entry, with the delivered scope (the binding is now functional: type column, bind gate, capture read).
  - **Kept open:** the three Types eng-review follow-ups (the gate worker, manifest-driven rendering, editor distribution).

## Dependencies

- **Packages:** none.
- **Units:** bm74–bm84 and cm23, all delivered and green. cm24 is in the same change.
- **Environment:**
  - a local Postgres + Azurite stack, with Chromium for the e2e
  - `invoice-editor` at the E7 contract refresh
  - users with `invoice_settings : EDIT`, with `customers` + `accounts_transactions : EDIT`, and with `billrun_operate` / `billrun_approve` (four-eyes)

## Verification checklist

- [ ] Success criteria 1–11 are each met, with the evidence in the table recorded in the progress tracker.
- [ ] Inv #59–#68 and the amendments are audited, each with code and test.
- [ ] Guardrail items 68–79 are green, and every earlier guardrail covering touched files is green.
- [ ] The journey (steps 1–8) passes in CI. The manual pass with a real editor export (steps 1–3, 9) is recorded.
- [ ] Standard v1's rows and files are unchanged. A fresh environment seeds only Standard v1 and renders it.
- [ ] Every doc in Implementation §4 is updated in the same change set as cm24's. No "planned" marker remains for the Types update, and the update overview is gone.
- [ ] Nothing new is built in this unit: the diff is tests and docs only. Any fix the manual run forces is recorded as a finding in the tracker.

## Open questions

None.
