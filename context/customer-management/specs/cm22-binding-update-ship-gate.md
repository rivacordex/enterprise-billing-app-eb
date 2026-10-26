# CM22 — Invoice Template Binding Update: Ship Gate

- **Unit:** 22 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** TESTS (+ docs close-out).
- **Dependencies:** `cm17`–`cm21`.
- **Authorizing sections:** binding plan §9 (tripwire), §11, §14 T6–T7; the binding update overview (folded into `custmgmt-project-overview.md`) *Success criteria*; `custmgmt-architecture.md` Inv. #11, #18; `custmgmt-ai-workflow-rules.md` §9.7, §9.8.
- **Decisions recorded 2026-10-10:** the end-to-end proof is a **DB-gated service-level journey test** (module precedent `tests/e2e/customer-core-flow.integration.test.ts`); browser e2e is deferred to `_newmodule-playwright-e2e-testing-plan.md` (no `@playwright/test` exists in the repo; the `playwright` package is only used for PDF rendering).
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10.

> **Framing.** cm17–cm21 each land their own tests. This unit turns the update's two negative-space rules into permanent CI facts (customer screens never import a mutation path; posting never reads the new column), proves the chained flow end to end at the service level, re-proves that posting stamps are unchanged, and closes the docs. It adds no product code.

---

## 1. Goal

Make the Invoice Template Binding update shippable: two static boundary guardrails, one DB-gated journey test (onboard → accounts summary → template label → reset), a green re-run of the posting stamp suites, and the documentation set moved to Delivered.

## 2. Design

**Structural decisions**

- **Static guardrails, `node:fs` only** (same shape as `tests/guardrails/customer-module-boundaries.test.ts`): no DB, no jsdom; they scan production source, never `tests/`.
- **Journey test calls services, not actions.** Server Actions need a real session (`requirePermission`), which a vitest suite does not build; the action guards are already covered by cm18/cm21 action tests. Dynamic imports after migrate, as in `customer-core-flow.integration.test.ts`.
- **Posting invariance is proven by re-running existing suites**, not new posting tests: the stamp and resolution suites must pass unchanged with the new column present.
- **No new unit numbers, no product code.** If a guardrail fails, fix the offending unit's code in a follow-up commit referencing that unit; do not weaken the guardrail.

## 3. Implementation

### 3.1 Guardrails — `tests/guardrails/customer-accounts-binding-boundaries.test.ts` (new)

Reuse the `read` / `collectFiles` helpers pattern from `customer-module-boundaries.test.ts`.

1. **Customer screens import no mutation path (Inv. #11).** Scan `app/(app)/customers/**` and `components/customers/**`. No import specifier may match: `@/actions/accounts/` **except** `@/actions/accounts/onboard-customer-accounts` and `@/actions/accounts/set-billing-account-template`; `@/services/accounts/post-document`; `@/components/accounts/reversal-dialog`; `@/components/accounts/documents-table`; any `@/services/billing/`. The two allowed actions are the update's sanctioned customer-screen writes.
2. **New Accounts read services import no mutation path.** Scan `services/accounts/get-customer-accounts-summary.ts`, `services/accounts/list-customer-billing-accounts.ts`, `services/accounts/resolve-ban-template-label.ts`: no `@/actions/`, no `post-document`, no `pgledgerCreateTransfers` reference, no `resolveTemplate` / `resolveVersionsForPosting` reference.
3. **Posting never reads the column (Inv. #18).** No file under `services/billing/**`, `db/repositories/billing/**` or `workflow-management/**` contains `refBillTemplateVersionId` **together with** `billingAccount` / `billing_account` in the same file, and none contains the SQL text `billing_account.ref_bill_template_version_id`. (`customer_bill.ref_bill_template_version_id` stays allowed; the check keys on the table pairing.)
4. **One validator.** `assertBindableTemplate` is defined only in `services/accounts/assert-bindable-template.ts` and referenced only by `onboard-customer-accounts.ts` and `set-billing-account-template.ts`.
5. **Writes to the column go through two services only.** Outside `db/schema/**` and `db/migrations/**`, `refBillTemplateVersionId:` appears in a `billingAccountRepository` insert/update only from `onboard-customer-accounts.ts` and the `setTemplateRef` repository method.

### 3.2 Journey — `tests/e2e/customer-accounts-journey.integration.test.ts` (new, DB-gated)

Setup as `customer-core-flow.integration.test.ts` (`assertTestDatabaseUrl`, fresh migrate, appuser + bill cycle + `customer` config fixtures, dynamic service imports). Steps:

1. `createCustomer` → a customer at `REGISTERED` / `INITIALIZED`.
2. `getCustomerAccountsSummary(partyRoleId, 1)` → `{ kind: "notOnboarded" }`.
3. `onboardCustomerAccounts({ …, billTemplateVersionId: null })` → BAN row has `ref_bill_template_version_id IS NULL`; customer `VALIDATED`; `ACCOUNTS_ONBOARDED.after_data` carries the key.
4. `getCustomerAccountsSummary` → `onboarded`, one FA, one BAN, BAN `templateLabel` = "Follows active template (currently: INVTPL-STD-A4 v1), as of now", documents `total = 0`.
5. `listCustomerBillingAccounts(partyRoleId)` → the same BAN with `refBillTemplateVersionId: null` (the panel's disabled state).
6. `setBillingAccountTemplate({ …, billTemplateVersionId: null, lastModified })` → `{ ok: true, changed: false }`; no `BILLING_ACCOUNT_TEMPLATE_CHANGED` row.
7. Raw SQL sets the BAN to `BTV00000002` (simulating Phase 3 data); summary label now reads "Template reference not supported yet"; `setBillingAccountTemplate(… null, fresh lastModified)` → `changed: true`, one audit row, column back to `NULL`; `party_role.last_modified_datetime` equal to its value after step 3.
8. `setBillingAccountTemplate({ billTemplateVersionId: "BTV00000002" })` → `TEMPLATE_NOT_BINDABLE`, no write.

Runs only on a throwaway Postgres marked disposable.

### 3.3 Posting invariance — re-run (no new file)

Run and require green, unchanged: `tests/db/customer-bill-stamps.integration.test.ts`, `tests/guardrails/invoice-default-resolution.integration.test.ts`, `tests/guardrails/invoice-version-pinning.integration.test.ts`, `tests/guardrails/invoice-render-source-boundary.test.ts`, and the bm18/bm19 render suites. Record any failure that also fails on the pre-cm17 commit as a `billmgmt-known-issues.md` §21 baseline item, not a cm22 regression (`custmgmt-ai-workflow-rules.md` §9.3 item 11).

### 3.4 Docs close-out (same change set)

Per `custmgmt-ai-workflow-rules.md` §9.7:

- The update overview (since folded into `custmgmt-project-overview.md`): **Status** → Delivered (date); success criterion 11 already reads "service-level journey test".
- `custmgmt-project-overview.md` *Features*, *Core user flows*: tabs, Accounts tab, onboarding field, Billing account panel; and `cm05` spec updated together (`cm05` docs-in-sync rule).
- `custmgmt-code-standards.md`: §4/§7 component and file names from cm19–cm21; §8 permission map (Accounts-tab sub-gate, new action with dual permission); §9 adds the two guardrails above.
- `custmgmt-architecture.md`: §7 marked delivered; Inv. #11–#18 wording matches the code (including the cm20 balance-source correction).
- Binding plan §12: O1, O3, O4 closed with the 2026-10-10 decisions.
- `custmgmt-progress-tracker.md`: cm17–cm22 recorded.
- Accounts-side docs (`ac04` spec, `acctmgmt-architecture.md` `billing_account` row, the authz sweep) and the `acctmgmt` audit/UI notes: drafted and edited **only after approval**.
- `TODOS.md` Phase 3 entry unchanged.

### 3.5 Explicitly NOT in this unit

- Browser end-to-end tests (deferred to `_newmodule-playwright-e2e-testing-plan.md`).
- Fixing the §21 baseline failures.
- Any product-code change beyond a guardrail-driven fix routed back to its unit.

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] `customer-accounts-binding-boundaries.test.ts` green: no mutation import on customer screens or the new read services; posting never reads the BAN column; one validator; two writers.
- [ ] `customer-accounts-journey.integration.test.ts` green on a disposable Postgres, all eight steps.
- [ ] Posting stamp, default-resolution, version-pinning and render-source suites green and unchanged.
- [ ] Every row of the binding plan §11 matrix exists and passes.
- [ ] `npm run typecheck`, `npm run lint`, Prettier, `npm run test` (unit + integration projects) green, apart from documented §21 baseline items.
- [ ] Docs in §3.4 updated in the same change set; no Accounts-side doc edited without approval.
- [ ] The update overview's (since folded into `custmgmt-project-overview.md`) status is Delivered only after every item above passes.
