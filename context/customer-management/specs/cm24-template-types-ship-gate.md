# CM24 — Invoice Template Types ship gate (Customer Management half)

- **Unit:** 24 (`cm00-build-plan.md` Phase 3, Invoice Template Types update). **Boundary:** TESTS and docs. **Nothing new is built.** **Joint with Billing bm85** (`context/billing-management/specs/bm85-template-types-ship-gate.md`), in the same change.
- **Dependencies:** cm23; Billing bm82, bm83 and bm84 (bind → run → retire switch → rerun all exist).
- **Authorizing sections:** `custmgmt-project-overview.md` › Invoice Template Types — Customer Management part › Success criteria 1–11 (folded from `custmgmt-update-overview.md` by this unit); `custmgmt-architecture.md` Inv. #18–#22; `custmgmt-code-standards.md` §10, guardrails 11–13; `custmgmt-ai-workflow-rules.md` §10.7–§10.8.
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-25.

> **Framing.** cm23 made the binding real, and bm82–bm84 made the bill run, retire and rerun honour it. cm24 proves the Customer Management side end to end inside bm85's journey, runs CM's half of the bind-vs-retire race, and closes the CM docs: Inv. #19–#22 are flipped to built, #18 and guardrail 10 are marked replaced, and `custmgmt-update-overview.md` is folded and deleted, in the same change as Billing's fold.

---

## 1. Goal

CM success criteria 1–11 pass with named evidence, CI is green, and the CM update overview is folded into `custmgmt-project-overview.md` and gone.

## 2. Design

**The CM half of bm85's journey:**
- **Step 2 (bind) and the label after step 4 (retire):** after the retire, the panel and the Accounts tab show BAN A on "Standard (default) · vN".
- **A retired-mid-edit save:** a panel opened before step 4 and saved after it shows the retired-type message and reloads. A panel holding BAN A's pre-retire `lastModified` gets `CONFLICT`, because the switch bumped it.

**Success criteria → evidence:**

| # | Criterion | Evidence |
|---|---|---|
| 1 | Migration | `billing-account-template-type-migration.integration.test.ts`, `billing-account-template-column.integration.test.ts` (cm23) |
| 2 | Bind writes once, audited, BAN lock only | `set-billing-account-template.integration.test.ts` (cm23); bm85 journey step 2 |
| 3 | Standard is NULL; non-bindable refused | the same suite; `assert-bindable-template.test.ts` |
| 4 | CONFLICT / BAN_CLOSED / BAN_NOT_FOUND / no-op | `set-billing-account-template.test.ts` |
| 5 | Dual gate, UI bypassed | `set-billing-account-template.action.test.ts`; the authz matrix |
| 6 | Bind racing retire | bm83's `retire-template-type.integration.test.ts` race cases (CM guardrail 12, last item) |
| 7 | Live labels; old strings gone | `resolve-ban-template-label.test.ts`, `customer-accounts-tab.test.tsx`; CM guardrail 13 string scan |
| 8 | After a retire: new type shown; retired-mid-edit message | bm85 journey step 4 plus the retired-mid-edit case above; `billing-account-panel.test.tsx` |
| 9 | Onboarding NULL, new wording, V7 | `onboard-customer-accounts-template.integration.test.ts`, `onboard-accounts-wizard.test.tsx`, `v07-onboarding-atomicity.integration.test.ts` |
| 10 | Next run captures the type | bm85 journey step 3; bm82's Wholesale capture case |
| 11 | Build health; docs move with the code | the full suite (§3.1); §3.3 |

## 3. Implementation

### 3.1 Automated suites

Run typecheck, lint and vitest (unit and integration on a disposable Postgres), and record the counts in `custmgmt-progress-tracker.md`. CM guardrails 11–13 and `customer-accounts-binding-boundaries.test.ts` must be green, with bm83's retire-switch writer added.

### 3.2 Journey additions

Into bm85's `tests/e2e/invoice-template-journey.integration.test.ts` (shared file, one change), after step 4:
- the two label reads (`listCustomerBillingAccounts` and `getCustomerAccountsSummary` for BAN A)
- the stale-`lastModified` bind → `CONFLICT`
- a bind to the retired type → `TEMPLATE_NOT_BINDABLE`

### 3.3 Docs (fold and flip, §10.7)

- **`custmgmt-architecture.md`:**
  - Inv. #19–#22: "planned" → "built (cm23)", with code and test cites
  - Inv. #18: marked **replaced by #19–#21** (the text kept as history)
  - the §8 tables marked delivered
- **`custmgmt-code-standards.md`:**
  - §10 status → delivered
  - guardrails 11–13 → "built (cm23/cm24)", with their test files
  - guardrail 10: marked **replaced by 11**
- **`custmgmt-ui-context.md`:** §10 status → delivered; §9.4–§9.5 marked replaced by §10.1–§10.2.
- **`custmgmt-ai-workflow-rules.md`:** §10 → carried-forward, as §9 was after cm22.
- **`cm05` (View Customer) and `ac04` (onboarding) specs:** every quote of the old label ("Follows active template…", "Template reference not supported yet"), the Reset button and the old wizard wording is updated to the cm23 strings (CM criterion 11).
- **`custmgmt-project-overview.md`:** add "Invoice Template Types — Customer Management part (delivered, cm23–cm24)", folded from `custmgmt-update-overview.md`.
- **`custmgmt-update-overview.md`:** **deleted**, in the same change as Billing's update overview. Links are repointed to the project overview.
- **`specs/cm00-build-plan.md`:** Phase 3 → delivered, and the units compacted to a numbering record.
- **`custmgmt-progress-tracker.md`:** the cm24 entry, with the evidence table.

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] CM success criteria 1–11 are each met, with evidence recorded in the progress tracker.
- [ ] CM guardrails 11–13 and the binding-boundaries suite are green. No `ref_bill_template_version_id` remains on `billing_account` anywhere.
- [ ] The bind-vs-retire race passes in both orders (bm83's suite).
- [ ] Inv. #19–#22 are built, #18 and guardrail 10 are marked replaced, and the cm05/ac04 wording is updated.
- [ ] `custmgmt-update-overview.md` is folded and deleted in the same change as Billing's.
- [ ] Nothing new is built: the diff is tests and docs only.
