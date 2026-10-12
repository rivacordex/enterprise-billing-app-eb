# CM18 — Onboarding Wizard: "Invoice template" Field

- **Unit:** 18 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** APP (customer screen + the Accounts-side onboarding service it calls).
- **Dependencies:** `cm17` (`billing_account.ref_bill_template_version_id`); delivered `cm10` / `ac04` onboarding wizard (`components/customers/onboard-accounts-wizard.tsx`, rendered by `components/customers/customer-role-form.tsx`).
- **Authorizing sections:** binding plan §3.1, §5, D2, D9, D11, D13, D15; `custmgmt-update-overview.md` *Core user flow 1*, *Features → Onboarding*; `custmgmt-architecture.md` §7.2, Inv. #18; `custmgmt-ui-context.md` §9.5; `custmgmt-ai-workflow-rules.md` §9.2 (cm18), §9.3 items 1–2.
- **Decisions recorded 2026-10-10:** O1 (wizard control) → **read-only field**, same pattern as Currency.
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10.

> **Framing.** Onboarding is the moment a customer's BAN is born (`INITIALIZED → VALIDATED`, one atomic transaction in `onboardCustomerAccounts`). This unit makes the template binding part of that moment: RevOps sees which invoice template the new BAN will use, and the BAN is written with `NULL` ("follow the active template"). v1 has no other choice, so the field is read-only. The shared validator `assertBindableTemplate` is introduced here because onboarding is its first caller; cm21 reuses it.

---

## 1. Goal

Show a read-only **Invoice template: Follow active template** field in the onboarding wizard, and write `ref_bill_template_version_id = NULL` on the new BAN in the existing onboarding transaction, validated by a shared `assertBindableTemplate` that rejects any non-`NULL` value with `TEMPLATE_NOT_BINDABLE`.

## 2. Design

**Structural decisions**

- **Read-only field, not a select (O1).** v1 has one possible value, so the wizard shows it the way it shows Currency (`Input readOnly`, `bg-muted/50 text-muted-foreground`), with `FieldDescription` help text: *"Invoices use the active template. Per-customer templates are not available yet."* No dropdown, no sentinel value.
- **The wizard always submits `billTemplateVersionId: null`.** No new wizard options fetch: `getWizardOptions` is unchanged, and the field reads no template catalog (the label with the template name arrives in cm20; this field states the rule, not the current name).
- **Validator lives on the Accounts side.** `services/accounts/assert-bindable-template.ts`, because it guards a `billing_account` write and cm21's reset service (also `services/accounts/`) reuses it.
- **v1 rule only.** `null` → ok; any string → `TEMPLATE_NOT_BINDABLE`. The Phase 3 rules (exists, `kind = generated`, non-DRAFT) are **not** built here (no speculative code, general doc §2.4); they arrive with the Phase 3 change that lifts the `NULL`-only rule (binding plan §9 tripwire). This supersedes the plan §11 matrix wording "Phase 3 rules as unit logic".
- **Validation runs inside the transaction, before any write.** `onboardCustomerAccounts` calls `assertBindableTemplate(tx, …)` right after the cycle check, so a rejection returns before the status change and inserts; nothing to roll back.
- **Schema allows `null` or a well-formed id.** `billTemplateVersionId: z.string().regex(/^BTV\d{8}$/).nullable().optional()`. A malformed id fails Zod (`VALIDATION_ERROR`); a well-formed non-`NULL` id reaches the validator and fails `TEMPLATE_NOT_BINDABLE`. Omitted ⇒ `null`.
- **Audit:** `ACCOUNTS_ONBOARDED.afterData` gains `refBillTemplateVersionId` (always `null` in v1). No new event type.
- **Guards unchanged:** `customers : EDIT` + `accounts_transactions : EDIT` in `onboardCustomerAccountsAction`.

## 3. Implementation

### 3.1 Validator — `services/accounts/assert-bindable-template.ts` (new)

```ts
import type { Database } from "@/db/client";

// cm18 (custmgmt Inv. #18, binding plan D13/D15) — the single gate for any
// value written to billing_account.ref_bill_template_version_id. v1 accepts
// NULL only ("follow the active template"); a non-NULL id is rejected until
// Phase 3 lifts this rule together with the posting change (plan §9 tripwire).
// Shared by onboardCustomerAccounts (cm18) and setBillingAccountTemplate (cm21).
export type AssertBindableTemplateResult =
  | { ok: true }
  | { ok: false; code: "TEMPLATE_NOT_BINDABLE" };

export async function assertBindableTemplate(
  _tx: Database,
  billTemplateVersionId: string | null,
): Promise<AssertBindableTemplateResult> {
  if (billTemplateVersionId === null) return { ok: true };
  return { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
}
```

It takes `tx` now so the Phase 3 version (which reads `bill_template_version`) keeps the same signature and both callers stay unchanged.

### 3.2 Validation — `validation/accounts/onboard-customer-accounts.schema.ts` (extend)

Add to the object, after `paymentDueDaysOverride`:

```ts
    // cm18 — invoice template for the new BAN. v1 always sends null
    // ("follow the active template"); see assertBindableTemplate.
    billTemplateVersionId: z
      .string()
      .regex(/^BTV\d{8}$/, "Invalid template version ID")
      .nullable()
      .optional(),
```

### 3.3 Service — `services/accounts/onboard-customer-accounts.ts` (extend)

- Add `{ ok: false; code: "TEMPLATE_NOT_BINDABLE" }` to `OnboardCustomerAccountsResult`.
- Inside `db.transaction`, immediately after the `CYCLE_RETIRED` check and before `compareAndUpdateStatus`:

```ts
    const templateId = input.billTemplateVersionId ?? null;
    const bindable = await assertBindableTemplate(tx, templateId);
    if (!bindable.ok) return { ok: false, code: bindable.code };
```

- Add `refBillTemplateVersionId: templateId` to the `billingAccountRepository.insert` values.
- Add `refBillTemplateVersionId: templateId` to the `ACCOUNTS_ONBOARDED` `afterData`.
- Update the header comment's step list: "2b. inserts billing.billing_account (BAN…, ref_bill_template_version_id = NULL in v1)".

### 3.4 Server Action — `actions/accounts/onboard-customer-accounts.ts` (extend)

Add `| { ok: false; code: "TEMPLATE_NOT_BINDABLE" }` to `OnboardCustomerAccountsActionResult`. No guard or flow change; the service result passes through.

### 3.5 Wizard — `components/customers/onboard-accounts-wizard.tsx` (extend)

- Import `FieldDescription` from `@/components/ui/field`.
- After the Currency field, add:

```tsx
            {/* Invoice template — read-only in v1 (cm18, O1) */}
            <Field>
              <FieldLabel>Invoice template</FieldLabel>
              <Input
                value="Follow active template"
                readOnly
                className="bg-muted/50 text-muted-foreground"
              />
              <FieldDescription>
                Invoices use the active template. Per-customer templates are
                not available yet.
              </FieldDescription>
            </Field>
```

- In `handleSubmit`, add `billTemplateVersionId: null` to the action input.
- In the result `switch`, add:

```tsx
      case "TEMPLATE_NOT_BINDABLE":
        setSubmitError(
          "This invoice template cannot be assigned. Please reload and try again.",
        );
        break;
```

No other wizard state, step or styling changes.

### 3.6 Tests

| File | Cases |
|---|---|
| `tests/services/assert-bindable-template.test.ts` (new) | `null` → `{ ok: true }`; `"BTV00000002"` → `TEMPLATE_NOT_BINDABLE`; makes no DB call (pass a `tx` stub that throws on any use) |
| `tests/services/onboard-customer-accounts.service.test.ts` (extend) | BAN insert carries `refBillTemplateVersionId: null` when the field is omitted and when it is `null`; `afterData` includes `refBillTemplateVersionId: null`; a non-`NULL` id returns `TEMPLATE_NOT_BINDABLE` and **no** `compareAndUpdateStatus`, FA/BAN insert, ledger or audit call is made |
| `tests/accounts/onboard-customer-accounts-template.integration.test.ts` (new, DB-gated) | Real transaction: onboarding a seeded `INITIALIZED` customer leaves the BAN row with `ref_bill_template_version_id IS NULL`; the `ACCOUNTS_ONBOARDED` audit row's `after_data` contains the key; a non-`NULL` id leaves the customer `INITIALIZED` and creates no FA/BAN. Same fresh-migrate setup as `v07-onboarding-atomicity.integration.test.ts` |
| `tests/accounts/v07-onboarding-atomicity.integration.test.ts` | Unchanged and still green (regression) |
| `tests/validation/onboard-customer-accounts.schema.test.ts` (new or extend if present) | `null`, omitted and `"BTV00000002"` parse; `"bad"` fails with the field error |
| `tests/components/onboard-accounts-wizard.test.tsx` (new) | The Invoice template field renders read-only with value "Follow active template" and the help text; submit calls `onboardCustomerAccountsAction` with `billTemplateVersionId: null`; a `TEMPLATE_NOT_BINDABLE` result shows the message |

DB-gated tests run only on a throwaway Postgres marked disposable.

### 3.7 Explicitly NOT in this unit

- Any template catalog read, label with the template name, or option list (cm20 / Phase 3).
- The Phase 3 validator rules (exists, kind, non-DRAFT).
- The reset path on Manage Customer (cm21).
- Any change to `getWizardOptions`, `customer-role-form.tsx`, or the `INITIALIZED → VALIDATED` lock (`party_role.last_modified_datetime` handling is unchanged).

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] The wizard shows a read-only "Invoice template — Follow active template" field with the help text, styled like Currency.
- [ ] Onboarding a customer writes `ref_bill_template_version_id = NULL` on the BAN and `refBillTemplateVersionId: null` in `ACCOUNTS_ONBOARDED.afterData`.
- [ ] A well-formed non-`NULL` id returns `TEMPLATE_NOT_BINDABLE` before any write; the customer stays `INITIALIZED`; no FA/BAN/ledger/audit row exists.
- [ ] A malformed id returns `VALIDATION_ERROR`.
- [ ] `assertBindableTemplate` makes no DB call in v1 and is the only place the rule lives.
- [ ] V7 atomicity test still green; all new and extended tests green; DB-gated ones on a disposable Postgres.
- [ ] Action guard unchanged: a user missing `customers : EDIT` or `accounts_transactions : EDIT` gets `FORBIDDEN`.
- [ ] `npm run typecheck`, `npm run lint`, Prettier clean; the wizard's result `switch` handles every code.
- [ ] No change to `services/billing/**`, `workflow-management/**`, `getWizardOptions`, or the customer section components.
- [ ] Docs: `custmgmt-progress-tracker.md` updated; the `ac04` onboarding spec change is drafted and approved before editing (`custmgmt-ai-workflow-rules.md` §9.7 item 6).
