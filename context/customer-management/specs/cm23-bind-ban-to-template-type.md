# CM23 — Bind a BAN to a template type

- **Unit:** 23 (`cm00-build-plan.md` Phase 3, Invoice Template Types update). **Boundary:** APP: the customer screens, the Accounts-side services and actions, and the `billing_account` migration. No Billing file is edited here (CM workflow rules §10.6.2): Billing's capture read and the Bound BANs count are bm82's. **One merge with Billing bm82** (`bm82-capture-reads-ban-type.md`).
- **Dependencies:**
  - Billing bm74: the `bill_template_family` columns and name rules.
  - Billing bm77: `billTemplateFamilyRepository.listUsable`.
  - Billing bm78: `billTemplateFamilyRepository.lockTemplateType`.
  - Billing bm79: a usable non-Standard type to bind.
  - The delivered cm17–cm21 binding path.
- **Authorizing sections:**
  - `custmgmt-update-overview.md` (bind a BAN to a type; labels; select + Save; onboarding wording)
  - `custmgmt-architecture.md` Inv. #17, #19–#22, §8
  - `custmgmt-code-standards.md` §10, guardrails 11–13
  - `custmgmt-ui-context.md` §10.1–§10.4
  - `custmgmt-ai-workflow-rules.md` §10
  - Billing `billmgmt-architecture.md` Inv #54 (amended) and #66
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-25.

> **Framing.** Today a BAN's template reference is a **version** column, `billing_account.ref_bill_template_version_id` (`0050`), that accepts only `NULL`:
> - `assertBindableTemplate` refuses everything else without reading the database.
> - The panel offers only "Reset to follow active template".
> - The labels read "Follows active template (currently: INVTPL-STD-A4 v1), as of now" or "Template reference not supported yet".
>
> This unit makes the binding real and type-based. Migration `0054` swaps the column for `ref_bill_template_family_id` (`NULL` = Standard). The gate accepts `null` or a **usable** type under Billing's `FOR SHARE` type lock. The panel gets a per-BAN type select with **Save**, and the labels show the type and version the next run will capture. Billing's capture read (bm82) ships in the same merge, because `0054` drops the column it reads today.

---

## 1. Goal

A user with `customers : EDIT` and `accounts_transactions : EDIT` picks **Wholesale** for BAN A on Manage Customer and saves. One audited, compare-and-set update follows, the label reads "Wholesale · v1", and (with bm82) the next Run drafts BAN A on Wholesale. Choosing **Standard (default)** writes `NULL`. A retired or not-yet-usable type is refused with the agreed message, and nothing is written. Onboarding still writes `NULL`, with the new wording.

## 2. Design

**Structural decisions**

- **D1: The column swap is one additive migration that refuses to lose data.** `0054_billing_account_template_type.sql`:
  1. adds `ref_bill_template_family_id text` with the FK `billing_account_ref_bill_template_family_id_fk` (NO ACTION) and a column comment
  2. `RAISE EXCEPTION 'MIGRATION_PRECONDITION: …'` if any `ref_bill_template_version_id IS NOT NULL`
  3. drops `billing_account_ref_bill_template_version_id_fk` and the old column

  There's no backfill: every existing BAN is `NULL` in v1 (cm17–cm22 allowed nothing else), and `NULL` keeps meaning Standard. `0050` is never edited (Data rule 1). No index is added (Data rule 5).
- **D2: The gate is the only judge of bindability, and it locks.** `assertBindableTemplate(tx, typeId)`:
  - `null` → ok, with no lock and no read (Inv. #19)
  - otherwise `billTemplateFamilyRepository.lockTemplateType(tx, typeId, "share")` **first**, then it requires:
    - the type exists
    - `is_default` is false (Standard is stored only as `NULL`)
    - `retired_datetime IS NULL`
    - an ACTIVE settings version exists (`billTemplateVersionRepository.findActive(tx, { kind: "generated", familyId: typeId })`; a non-Standard type has no default row)

  Any failure → `TEMPLATE_NOT_BINDABLE`. The `FOR SHARE` lock is held to the end of the caller's transaction, so a bind and a retire (`FOR UPDATE`, bm83) are serialised: the bind either commits first and is moved by the retire, or it waits and then finds the type retired (Inv. #20). It returns the type name for the audit.
- **D3: The BAN write path is unchanged apart from the value.** `setBillingAccountTemplate` keeps its order:
  1. the gate
  2. a missing BAN, or one of another party role → `BAN_NOT_FOUND`
  3. closed → `BAN_CLOSED`
  4. a stale `lastModified` → `CONFLICT`
  5. unchanged → `changed: false`, with no write and no audit
  6. the CAS write `setTemplateRef` on `billing_account.last_modified`
  7. one `BILLING_ACCOUNT_TEMPLATE_CHANGED`

  `party_role.last_modified_datetime` is never read or bumped (Inv. #17). The audit payload becomes `{ refBillTemplateFamilyId, typeName }` before and after, where `typeName` is the type's `name`, or `"Standard (default)"` for `null`. `reason` is never set here (Data rule 4).
- **D4: Labels are structured and computed per request.** `BanTemplateLabel` carries `kind`, `text`, `name` and `versionNo`:
  - `name` and `versionNo` let `TemplateLabel` render `v{N}` in mono (ui-context §10.1) without parsing `text`
  - `text` is the full string, for accessible names and tests

  Code-standards §10 TS rule 3 records this shape. The labels:

  | BAN value | `kind` | `text` |
  |---|---|---|
  | `NULL` | `STANDARD` | "Standard (default) · v{N}", where N is the Standard type's `findActive ?? findDefault` generated version |
  | usable type | `TYPE` | "{name} · v{N}", where N is its ACTIVE settings version |
  | retired, or no ACTIVE settings (reachable only by SQL bypass) | `NOT_USABLE` | "{name} · not usable" |

  The Standard type is found with `billTemplateFamilyRepository.findDefault`, which is a lookup, never an id comparison (General rule 1). A missing Standard row (impossible after `0046`) yields `STANDARD` with "Standard (default)" and `versionNo: null`.
- **D5: One read per distinct type, per request.** `resolveBanTemplateLabels(db, typeIds)` resolves the distinct values in one pass and returns a `Map`. `listCustomerBillingAccounts` and `getCustomerAccountsSummary` call it once. Nothing is cached across requests (Inv. #21, General rule 5).
- **D6: The panel is a select + Save per open BAN.**
  - **The select:** `TemplateTypeSelect` lists `listBindableTemplateTypes()`: Standard first, then usable types by name (TS rule 2).
  - **Save:** enabled only when the selection differs from the BAN's value and the viewer holds `accounts_transactions : EDIT`. One save runs at a time across rows, as the reset did.
  - **A value that isn't usable:** if the BAN's current value isn't in the list (a `NOT_USABLE` label), the select shows the placeholder "Choose a type", and the label above it carries the warning.
  - **On `TEMPLATE_NOT_BINDABLE`:** the retired-type message as a Danger inline alert, then `router.refresh()`.
- **D7: Onboarding always writes `NULL`, enforced by the schema.** The onboarding schema's template field becomes `templateTypeId: z.null().optional()`, so a non-null value fails validation before the service. The service still calls `assertBindableTemplate(tx, null)` (General rule 2), and the field is read-only in the wizard with the new wording.

## 3. Implementation

### 3.1 Migration: `db/migrations/0054_billing_account_template_type.sql` (new) + journal

```sql
-- cm23 (Inv. #19) — a BAN's invoice template becomes a TYPE reference (NULL = Standard).
-- Ships in one merge with Billing bm82, whose capture read (listBanFamilies) moves to
-- this column in the same change. 0050 is not edited. No backfill: v1 allowed only NULL.
ALTER TABLE "billing"."billing_account"
  ADD COLUMN "ref_bill_template_family_id" text;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account"
  ADD CONSTRAINT "billing_account_ref_bill_template_family_id_fk"
  FOREIGN KEY ("ref_bill_template_family_id")
  REFERENCES "billing"."bill_template_family"("bill_template_family_id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
--> statement-breakpoint
COMMENT ON COLUMN "billing"."billing_account"."ref_bill_template_family_id" IS
  'Invoice template type for this BAN. NULL = Standard (the default type); Standard is stored only as NULL. Written by setBillingAccountTemplate (via assertBindableTemplate), onboarding (always NULL) and Billing''s retire switch. Read by the bill run at capture (cm23/bm82).';
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "billing"."billing_account" WHERE "ref_bill_template_version_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'MIGRATION_PRECONDITION: billing_account.ref_bill_template_version_id is non-NULL on % row(s); v1 allowed NULL only.',
      (SELECT count(*) FROM "billing"."billing_account" WHERE "ref_bill_template_version_id" IS NOT NULL);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "billing"."billing_account" DROP CONSTRAINT "billing_account_ref_bill_template_version_id_fk";
--> statement-breakpoint
ALTER TABLE "billing"."billing_account" DROP COLUMN "ref_bill_template_version_id";
```

**`db/migrations/meta/_journal.json`:** idx 54, version "7", tag `0054_billing_account_template_type`, `when` 1791540000000 (one day after bm74's `0053`).

### 3.2 Drizzle: `db/schema/billing/accounts.ts` (changed)

- **The column:** replace the cm17 comment and `refBillTemplateVersionId` (L112–116) with `refBillTemplateFamilyId: text("ref_bill_template_family_id")`, under a cm23 comment matching the column comment.
- **The FK:** replace the FK (L136–140) with `foreignKey({ columns: [t.refBillTemplateFamilyId], foreignColumns: [billTemplateFamily.billTemplateFamilyId], name: "billing_account_ref_bill_template_family_id_fk" })`.
- **The import:** `billTemplateVersion` → `billTemplateFamily`.

### 3.3 Repositories

**`db/repositories/accounts/billing-account.repository.ts`:**
- `setTemplateRef(tx, billingAccountId, lastModified, refBillTemplateFamilyId: string | null, actorId)` sets `refBillTemplateFamilyId`. Its WHERE, its re-select and its `"updated" | "conflict" | "closed" | "not_found"` result are unchanged.
- `insert`'s row type follows the schema.

**`db/repositories/billing/bill-template-family.ts`:** consumed, never edited (CM workflow rules §10.6.2). `lockTemplateType` (bm78), `findById`, `findDefault` and `listUsable` (bm77) are read through it (Inv. #22).

### 3.4 Gate: `services/accounts/assert-bindable-template.ts` (changed)

```ts
// cm23 (Inv. #19, #20; code-standards §10 General rules 1–3) — the single gate for any
// value written to billing_account.ref_bill_template_family_id. null (Standard) needs no
// lock. A type id is locked FOR SHARE in the CALLER's transaction before it is judged, so
// the bind and a retire (FOR UPDATE) serialise; never opens its own transaction.
export type AssertBindableTemplateResult =
  | { ok: true; typeName: string | null }
  | { ok: false; code: "TEMPLATE_NOT_BINDABLE" };

export async function assertBindableTemplate(
  tx: Database,
  typeId: string | null,
): Promise<AssertBindableTemplateResult> {
  if (typeId === null) return { ok: true, typeName: null };
  const type = await billTemplateFamilyRepository.lockTemplateType(tx, typeId, "share");
  if (!type || type.isDefault || type.retiredDatetime !== null) {
    return { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
  }
  const active = await billTemplateVersionRepository.findActive(tx, { kind: "generated", familyId: typeId });
  return active ? { ok: true, typeName: type.name } : { ok: false, code: "TEMPLATE_NOT_BINDABLE" };
}
```

`type.isDefault` is a column read, not an id comparison (General rule 1).

### 3.5 Validation (changed)

- **`validation/accounts/set-billing-account-template.schema.ts`:** `billTemplateVersionId` becomes `typeId: templateFamilyIdSchema.nullable()` (Billing's `validation/billing/template-family-id.schema.ts`, a validation import, not a service). The comment says a well-formed id still parses, and bindability is the gate's.
- **`validation/accounts/onboard-customer-accounts.schema.ts`:** `billTemplateVersionId` becomes `templateTypeId: z.null().optional()` (D7).

### 3.6 Bind service: `services/accounts/set-billing-account-template.ts` (changed)

- The header comment is rewritten for the type, and the steps are unchanged.
- **Step 1:** `const bindable = await assertBindableTemplate(tx, input.typeId)`.
- **Step 5:** `before.refBillTemplateFamilyId === input.typeId`.
- **Step 6:** `setTemplateRef(…, input.typeId, actorId)`.
- **Step 7, the audit:**
  - `beforeData: { refBillTemplateFamilyId: before.refBillTemplateFamilyId, typeName: await typeNameOf(tx, before.refBillTemplateFamilyId) }`
  - `afterData: { refBillTemplateFamilyId: input.typeId, typeName: bindable.typeName ?? STANDARD_TYPE_NAME }`
  - `typeNameOf` reads `billTemplateFamilyRepository.findById` with no lock (the old type isn't being bound), and returns `STANDARD_TYPE_NAME` for `null`
  - `STANDARD_TYPE_NAME = "Standard (default)"` is exported from `types/accounts.ts`, a types module, so Billing's retire switch (bm83) can import it without reaching into `services/accounts/**`
- The thrown-error text "after template reset" becomes "after template bind". The result union is unchanged (TS rule 4).

### 3.7 Onboarding: `services/accounts/onboard-customer-accounts.ts` (changed)

- **L31 comment:** `ref_bill_template_family_id = NULL (Standard), always`.
- **L61:** `const templateTypeId = null;`. The schema admits only `null` or absent.
- **L62–63:** `assertBindableTemplate(tx, templateTypeId)` is kept in place.
- **L98:** `refBillTemplateFamilyId: templateTypeId`.
- **L155:** the `ACCOUNTS_ONBOARDED` `afterData` key becomes `refBillTemplateFamilyId: null`.

The `TEMPLATE_NOT_BINDABLE` arm of the result union stays (unreachable via the action now, and kept for the gate's contract).

### 3.8 Type list and labels (Accounts side)

**`services/accounts/list-bindable-template-types.ts` (new):**

```ts
// cm23 (TS rule 2, Inv. #22) — Standard (null) first, then usable types by name.
export async function listBindableTemplateTypes(): Promise<BindableTemplateType[]> {
  const usable = await billTemplateFamilyRepository.listUsable(db);
  return [{ typeId: null, name: STANDARD_TYPE_NAME },
          ...usable.map((t) => ({ typeId: t.billTemplateFamilyId, name: t.name }))];
}
```

**`services/accounts/resolve-ban-template-label.ts` (rewritten):**
- **Removed:** `TEMPLATE_REFERENCE_NOT_SUPPORTED`, `resolveCurrentTemplateLabel` and `banTemplateLabel`.
- **Added:** `resolveBanTemplateLabels(db, typeIds: (string | null)[]): Promise<Map<string | null, BanTemplateLabel>>`, which implements the D4 table:
  - **`null`:** `findDefault` (family), then `findActive ?? findDefault` (generated, `familyId`).
  - **Each distinct id:** `findById` (family) and `findActive({ kind: "generated", familyId })`. A type that is retired, or has no ACTIVE settings, gives `NOT_USABLE`.
- It never calls `resolveTemplate`, `resolveVersionsForPosting` or `resolveCurrentVersionsForFamily`, and imports only Billing repositories (General rule 4).

**`types/accounts.ts`:**
- **New types:**
  ```ts
  export const STANDARD_TYPE_NAME = "Standard (default)";
  export type BindableTemplateType = { typeId: string | null; name: string };
  export type BanTemplateLabel = {
    kind: "STANDARD" | "TYPE" | "NOT_USABLE"; text: string; name: string; versionNo: number | null;
  };
  ```
- **`CustomerBillingAccountRow`:** `refBillTemplateVersionId` → `refBillTemplateFamilyId: string | null`, and `templateLabel: BanTemplateLabel`.
- **`CustomerAccountsSummary`'s BAN shape:** `templateLabel: BanTemplateLabel`.

**`services/accounts/list-customer-billing-accounts.ts` and `get-customer-accounts-summary.ts`:**
- one `resolveBanTemplateLabels` call over the BANs' values
- each row carries `refBillTemplateFamilyId` (list only) and `templateLabel`
- the "Unsupported BAN invoice template reference." `logger.warn` is removed (L43–51; L165–171), because a non-null value is now normal

### 3.9 Action: `actions/accounts/set-billing-account-template.ts` (changed: schema only)

The guards are unchanged: `customers : EDIT` via `requirePermission`, then `accounts_transactions : EDIT`, then Zod, then the service. The two `revalidatePath` calls are unchanged. The input is now `{ partyRoleId, billingAccountId, typeId, lastModified }` (Next.js rule 2).

### 3.10 Components

- **`components/customers/billing-account-messages.ts` (new):**
  - **`BIND_FAILURE_MESSAGES`:** moved from the panel's `RESET_FAILURE_MESSAGES`, with the same strings except `TEMPLATE_NOT_BINDABLE` → "This invoice template type is no longer available. It may have been retired. The account's current type has been reloaded."
  - **`NEXT_RUN_CAPTION`:** "Changes apply from the next bill run start or rerun."
  - **`ONBOARDING_TEMPLATE_LABEL`:** "Invoice template type".
  - **`ONBOARDING_TEMPLATE_VALUE`:** "Standard (default)".
  - **`ONBOARDING_TEMPLATE_HELP`:** "New billing accounts use the Standard invoice template. Choose another type afterwards in Manage Customer › Billing account."
  - **`TEMPLATE_TYPE_FIELD_LABEL`:** "Invoice template type".
- **`components/customers/template-type-select.tsx` (new, client):**
  - **Props:** `{ id; options: BindableTemplateType[]; value: string | null; onChange; disabled; title? }`.
  - **The primitive:** shadcn `Select`, labelled `TEMPLATE_TYPE_FIELD_LABEL`. Standard's `null` is mapped to the sentinel item value `"__standard__"` inside the component only, since the `Select` needs string values.
  - **Placeholder:** "Choose a type" when `value` isn't among the options.
- **`components/customers/billing-account-panel.tsx` (changed):**
  - **Props:** gain `templateTypes: BindableTemplateType[]`.
  - **Each open BAN row:** `TemplateLabel`, `TemplateTypeSelect` and a secondary **Save** (hand-styled like the old Reset). `selection` is kept per row.
  - **Save** is enabled iff `canEditAccounts && selection !== ban.refBillTemplateFamilyId && !busy`. Without EDIT, the select and Save are disabled with `EDIT_DISABLED_TITLE`.
  - **The request:** `{ partyRoleId, billingAccountId, typeId: selection, lastModified: ban.lastModified }`. On ok, `router.refresh()`. On a failure, the `BIND_FAILURE_MESSAGES` inline alert, and on `TEMPLATE_NOT_BINDABLE` also `router.refresh()`.
  - **A closed BAN:** no select, with the caption "Billing account is closed".
  - **`NEXT_RUN_CAPTION`:** once, under the panel.
  - **Removed:** the Reset button and the "Already following the active template" caption (Styling rule 5).
- **`components/customers/billing-account-card.tsx`:**
  - **Props:** `templateLabel: BanTemplateLabel`.
  - **`TemplateLabel({ label })`:**
    - **Prefix:** the field label "Invoice template type" (`--text-caption`, muted).
    - **Name:** `label.name` (`--text-body-sm`).
    - **Version:** for `versionNo !== null`, " · " plus `v{N}` in mono.
    - **`NOT_USABLE`:** " · not usable", in `--color-warning-700` with an `AlertTriangle` icon (warning-500).

    The `FileText` icon stays, and `FOLLOWS_LABEL` is removed. The `aria-label` is `label.text`.
- **`components/customers/onboard-accounts-wizard.tsx`:**
  - **L315–331:** the field uses the three `ONBOARDING_TEMPLATE_*` constants. It stays a read-only `Input`, and the comment becomes "Invoice template type: always Standard at onboarding (cm23)".
  - **L171:** submits `templateTypeId: null`.
  - **L214–216:** the `TEMPLATE_NOT_BINDABLE` message is kept.

### 3.11 Page: `app/(app)/customers/manage/[id]/page.tsx` (changed)

- **The reads:** `listBindableTemplateTypes()` joins the existing `Promise.all` with `listCustomerBillingAccounts(partyRoleId)`. A failure of either renders `AccountsUnavailableCard` in the panel, as today (Next.js rule 1).
- **The panel:** receives `templateTypes`.

### 3.12 Tests

**Changed:**
- **`tests/services/assert-bindable-template.test.ts`:** rewritten with a mocked `tx` and repositories:
  - `null` gives ok with no repository call
  - a usable type calls `lockTemplateType(tx, id, "share")` **before** `findActive`, and returns ok with `typeName`
  - Standard (`isDefault`), unknown, retired and no-ACTIVE each give `TEMPLATE_NOT_BINDABLE`
- **`tests/services/set-billing-account-template.test.ts`:**
  - `typeId` replaces `billTemplateVersionId` throughout
  - the audit payload is `{ refBillTemplateFamilyId, typeName }`, with "Standard (default)" for `null`
  - unchanged gives `changed: false`, with no write and no audit
  - a gate refusal makes no repository call
- **`tests/actions/set-billing-account-template.action.test.ts`:** the `typeId` schema (`BTF…` or `null`; a `BTV…` id gives `VALIDATION_ERROR`). The guards and revalidation are unchanged.
- **`tests/accounts/set-billing-account-template.integration.test.ts`** (DB-gated; CM guardrail 12): fixtures create a usable type through SQL (family plus an ACTIVE generated row) and a retired one. Then:
  - binding `null`, then the usable type, then back to `null`: each is one update, one audit row with type names and a bumped `last_modified`, with `party_role.last_modified_datetime` untouched
  - Standard's id, an unknown id, the retired type and a not-yet-usable type each give `TEMPLATE_NOT_BINDABLE`, with no write and no audit
  - a stale replay gives `CONFLICT`
- **`tests/services/resolve-ban-template-label.test.ts`:**
  - the three D4 `kind`s, with exact `text`, `name` and `versionNo`
  - Standard on its ACTIVE v2 reads "Standard (default) · v2"
  - one read per distinct type
  - it never calls the resolvers
- **`tests/services/get-customer-accounts-summary.test.ts`** and **`tests/accounts/get-customer-accounts-summary.integration.test.ts`:** a structured label on every BAN, and no warn.
- **`tests/components/billing-account-panel.test.tsx`** (CM guardrail 13):
  - **The select:** Standard first, then usable types by name, with retired and not-yet-usable types absent.
  - **Save:** disabled when unchanged, and for an EDIT-less viewer (with the tooltip). It sends `typeId` and `lastModified`.
  - **Failures:** `TEMPLATE_NOT_BINDABLE` shows the retired-type message and calls `router.refresh`.
  - **Other cases:** the closed caption, one save in flight, and the next-run caption.
- **`tests/components/customer-accounts-tab.test.tsx`:** the label renders the name, mono `v{N}`, and "· not usable" with the warning icon.
- **`tests/app/customers-manage-page.test.tsx`:** the `Promise.all` wiring, with `templateTypes` passed through. The row fixture uses `refBillTemplateFamilyId: null`.
- **Onboarding:**
  - **`tests/components/onboard-accounts-wizard.test.tsx`:** the exact label, value and help text; it submits `templateTypeId: null`.
  - **`tests/services/onboard-customer-accounts.service.test.ts`** L402–449: the insert carries `refBillTemplateFamilyId: null`, and the audit key is renamed.
  - **`tests/validation/onboard-customer-accounts.schema.test.ts`:** a `BTF…` id is now **rejected**, and `null` or absent is accepted.
  - **`tests/accounts/onboard-customer-accounts-template.integration.test.ts`:** the new column is NULL after onboarding.
  - **`tests/accounts/v07-onboarding-atomicity.integration.test.ts`:** unchanged and green.
- **`tests/e2e/customer-accounts-journey.integration.test.ts`** L170–240:
  1. the panel row starts with `refBillTemplateFamilyId: null`
  2. bind the usable type (`changed: true`, one audit row), and the label is "Wholesale · v1"
  3. raw SQL sets the type retired, and the label becomes "Wholesale · not usable"
  4. rebinding to it gives `TEMPLATE_NOT_BINDABLE`
- **`tests/db/billing-account-template-column.integration.test.ts`:** rewritten for `ref_bill_template_family_id`:
  - text, nullable, no default
  - FK `billing_account_ref_bill_template_family_id_fk`, NO ACTION
  - an unknown id raises 23503
  - `BTF00000001` is accepted at the DB level (the "NULL only" rule for Standard is the gate's)
  - `ref_bill_template_version_id` no longer exists
- **`tests/db/billing-schema.test.ts:91`:** the column assertion follows.
- **`tests/guardrails/customer-accounts-binding-boundaries.test.ts`** (CM guardrail 11, replacing item 10):
  - **Test 3:** `TEMPLATE_COLUMN` becomes `ref_bill_template_family_id` / `refBillTemplateFamilyId` paired with `billingAccount`. The exemptions are `listBanFamilies` (`RUN_START_CAPTURE`, which must read it) and `services/billing/invoice-template/template-types.ts` (the count, and bm83's retire switch). A new assertion: no file anywhere references `ref_bill_template_version_id` together with `billing_account` / `billingAccount`.
  - **Test 4:** unchanged (the two callers).
  - **Test 5:** the writers are unchanged (`setTemplateRef:update` and `onboardCustomerAccounts:insert`). bm83 adds the retire switch.
  - **New:** no file under `services/accounts/**`, `app/(app)/customers/**` or `components/customers/**` imports `services/billing/**` or `actions/billing/**`.
  - **New:** none of the four removed strings (Styling rule 5) appears under `components/`, `services/` or `app/`.

**New:**
- **`tests/db/billing-account-template-type-migration.integration.test.ts`** (DB-gated; trimmed-journal migrate, the bm74 harness):
  - on a database at `0053` with one BAN whose `ref_bill_template_version_id = 'BTV00000002'`, `0054` raises `MIGRATION_PRECONDITION` and leaves the old column in place
  - with all BANs `NULL`, it applies, and every BAN reads `ref_bill_template_family_id IS NULL`
- **`tests/services/list-bindable-template-types.test.ts`:** Standard first, then `listUsable`'s order.

### 3.13 Explicitly NOT in this unit

- Retire and its bulk switch: Billing bm83.
- The re-run warning: bm84.
- Any change to bill-run stamps, `customer_bill` or posting (General rule 6).
- A template choice in onboarding (it stays read-only).

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] `0054` applies on a database where every BAN is `NULL`, and aborts on a non-NULL version fixture, leaving the old column. The FK and comment are present, and `ref_bill_template_version_id` is gone.
- [ ] Binding BAN A to Wholesale writes one CAS update and one audit row (`{ refBillTemplateFamilyId, typeName }` before and after). The label reads "Wholesale · v1", and `party_role.last_modified_datetime` is unchanged.
- [ ] Choosing Standard (default) writes `NULL`. Standard's id, an unknown id, a retired type and a not-yet-usable type are refused `TEMPLATE_NOT_BINDABLE`, with nothing written (CM guardrail 12).
- [ ] The gate takes `FOR SHARE` on the type inside the bind transaction, before the usability read.
- [ ] The select lists Standard first, then usable types. Save is disabled when unchanged and for a `customers : EDIT`-only user. A retired-mid-edit save shows the message and reloads (CM guardrail 13).
- [ ] The View Customer Accounts tab and the panel show "Standard (default) · vN", "{type} · vN", or "· not usable" with the warning style and icon.
- [ ] Onboarding writes `NULL`, with "Invoice template type" / "Standard (default)" and the new help text. A `BTF…` value fails validation, and V7 stays green.
- [ ] CM guardrails 11–13 pass. No customer-tree file imports `services/billing/**` or `actions/billing/**`. None of the four removed strings remains.
- [ ] **Merged together with bm82.** `rg "ref_bill_template_version_id"` finds no `billing_account` reference in code or tests.
- [ ] `tsc --noEmit`, ESLint and Prettier pass.
- [ ] Docs, per `custmgmt-ai-workflow-rules.md` §10:
  - Inv. #19, #20 and #22 marked "built (cm23)", and #21 "built (cm23)", replacing #18 on ship (cm24 closes it out)
  - code-standards §10 file tree: `billing-account-messages.ts` was new as planned; `resolve-ban-template-label.ts` exports `resolveBanTemplateLabels`
  - `custmgmt-progress-tracker.md` records cm23
