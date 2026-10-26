# bm83 — Retire a type with a bulk switch

**Unit:** bm83 (Invoice Template Types · Part 6, unit 10 of 12). **Boundary:** SETTINGS-UI: the retire service in `template-types.ts`, its action and schema, the type repository's `retireType`, a multi-row audit insert, the `RetireTemplateTypeDialog`, the retired-type read-only detail page, the `TEMPLATE_TYPE_RETIRED` checks on save and preview, and their tests. **Specs from:**
- `billmgmt-update-overview.md` › Core user flow step 12 and Features › Retire with bulk switch
- `billmgmt-architecture.md` Inv #65 (Standard is never retired), #66 and #67
- `billmgmt-code-standards.md` › Invoice Template Types, General rules 7–9, TS rule 2 (`TemplateTypeErrorCode`), Next.js rules 3–4, Styling rule 5, the Retire permission-map row, guardrail items 76, 77 and 79 (boundary half)
- `billmgmt-ui-context.md` §10e (Retire dialog; Retired type, detail page)
- CM `custmgmt-code-standards.md` §10 Data rule 4 and guardrail 11
- `bm00-build-plan.md` Part 6, unit 83

**Model file:** `services/accounts/set-billing-account-template.ts` (the BAN template write and its audit, which the switch does set-based).

> **Framing.** After cm23 and bm82, BANs are bound to types, and a type can't be taken out of service: nothing sets `bill_template_family.retired_datetime`. bm83 adds **Retire type…** to a non-Standard type's detail page. In **one transaction**, it moves every BAN bound to that type to one usable target (Standard writes `NULL`), audits each move, proves that no BAN is left, and only then retires the type, one-way. The type's version rows are untouched, so posted bills, reprints and in-flight run stamps keep resolving (Inv #67).
>
> The ascending-id lock order shared with the bind gate (cm23's `FOR SHARE`) makes bind-vs-retire and retire-vs-retire race-safe (Inv #66). Upload (bm78), activate and discard (bm79) already refuse a retired type. bm83 adds the same refusal to **save** and **preview**, and makes the retired detail page read-only, with export kept.

## Goal

A MANAGER/ADMIN retires Wholesale after typing its name and choosing Standard. Then:
- BAN A moves to `NULL`, with one `BILLING_ACCOUNT_TEMPLATE_CHANGED` row carrying `reason: 'TEMPLATE_TYPE_RETIRED'`
- Wholesale shows **Retired** with its history and exports intact
- one `INVOICE_TEMPLATE_TYPE_RETIRED` row is written

Standard can't be retired. Bind racing retire, in both orders, and retire A→B racing retire B→A, finish correctly with no deadlock.

## Design

**Structural decisions**

- **D1: Inputs.** `{ typeId, targetTypeId: string | null, confirmName }`:
  - `targetTypeId: null` means Standard, and an explicit Standard id is refused (`RETIRE_TARGET_NOT_USABLE`), as at bind (General rule 8)
  - `confirmName` must equal the type's `name` exactly after trimming, re-checked on the server (`RETIRE_NAME_MISMATCH`), not only in the dialog
- **D2: Lock order (Inv #66, General rule 7).**
  - **Which rows:** the retired type is locked `FOR UPDATE` and a non-NULL target `FOR SHARE`, both through `lockTemplateType`, in **ascending `bill_template_family_id`** order. A NULL target (Standard) takes no lock, because Standard can't be retired and binding NULL takes none.
  - **Retire A→B racing B→A:** both lock the lower id first, so one waits and neither deadlocks. The loser then finds its target retired (`RETIRE_TARGET_NOT_USABLE`) or its own type retired (`TEMPLATE_TYPE_RETIRED`).
  - **Bind racing retire:** the bind's `FOR SHARE` conflicts with the retire's `FOR UPDATE`. A bind that commits first is moved by the switch. A bind that waits re-reads the type, finds it retired, and returns `TEMPLATE_NOT_BINDABLE` (cm23).
  - **DRAFT writers racing retire:** save, upload, activate and discard each lock the type row `FOR UPDATE` first, then the generated kind advisory lock (the bm77–bm79 review fix moved save-draft to this order). The retire never takes the kind lock. A writer and a retire on the same type therefore serialize on the type row: the one that waits re-reads it and refuses with `TEMPLATE_TYPE_RETIRED`, or finishes before the retire. A writer holding the **target** `FOR UPDATE` makes the retire's `FOR SHARE` wait. That writer never needs the retired type's row, so no cycle forms.
- **D3: Order inside the transaction.**
  1. lock (D2)
  2. re-check under the locks:
     - the type exists → `VALIDATION_ERROR`
     - it isn't the default → `DEFAULT_TYPE_NOT_RETIRABLE`
     - it isn't retired → `TEMPLATE_TYPE_RETIRED`
     - the name matches → `RETIRE_NAME_MISMATCH`
     - the target isn't the type itself, isn't Standard's id, and is usable (not retired, has an ACTIVE settings version) → `RETIRE_TARGET_NOT_USABLE`
  3. **one** set-based `UPDATE billing.billing_account … WHERE ref_bill_template_family_id = $type RETURNING billing_account_id`, setting the target (`NULL` for Standard), `last_modified = now()` and `last_edited_by`
  4. one `BILLING_ACCOUNT_TEMPLATE_CHANGED` per returned BAN, inserted in chunks of **500** through a multi-row `insertAuditEvents`
  5. re-count `WHERE ref_bill_template_family_id = $type`. If it isn't 0, throw (an invariant breach, rolled back, `SERVER_ERROR`)
  6. `retireType`, which sets `retired_datetime = now()`; the guard trigger allows only this update
  7. one `INVOICE_TEMPLATE_TYPE_RETIRED`

  Closed BANs move too: "zero BANs remain" means every state, and it matches cm23's Bound BANs count.
- **D4: Each BAN's audit row matches a bind's, plus a reason.**
  - **The target:** `targetEntity: "BILLING_ACCOUNT"`.
  - **`beforeData`:** `{ refBillTemplateFamilyId: typeId, typeName }`.
  - **`afterData`:** `{ refBillTemplateFamilyId: targetTypeId, typeName: target?.name ?? STANDARD_TYPE_NAME, reason: "TEMPLATE_TYPE_RETIRED" }`.

  This is the payload of CM Data rule 4; only this switch sets `reason`. `STANDARD_TYPE_NAME` is imported from `types/accounts.ts` (cm23), not from `services/accounts/**`.
- **D5: The BAN's `last_modified` bumps.** A Manage Customer panel opened before the retire then gets `CONFLICT` on save, the existing message, instead of silently re-binding over the switch. `party_role` is never touched (CM Inv. #17).
- **D6: Version rows are never touched (Inv #67).**
  - **The rows:** no statement in the retire transaction names `bill_template_version`. An open DRAFT pair stays as it was, and is unreachable from the read-only page.
  - **In-flight runs:** runs already captured keep their stamps. A rerun re-captures the BAN's new type, and bm84 adds the warning for that.
- **D7: A retired type refuses every write and the live preview.**
  - **Upload, activate and discard:** already refuse it, under the type lock (bm78, bm79). The page already hides Upload and Discard on a retired type (`canUpload = canEdit && data.typeStatus !== "RETIRED"`). The structure form already maps activation's `TEMPLATE_TYPE_RETIRED` to `TEMPLATE_TYPE_MESSAGES.typeRetired` and refreshes.
  - **Save:** `saveTemplateDraft` returns `TEMPLATE_TYPE_RETIRED`.
  - **Preview:** `previewInvoiceTemplate` throws `TemplateTypeRetiredError`, which the action maps to `TEMPLATE_TYPE_RETIRED`. This covers both values of the `draft` flag (bm79 review fix) and both sources.
    - **Without the check:** a non-draft preview of a retired type already fails, but only as `PREVIEW_FAILED`, the generic message: `resolveGeneratedForFamily` yields `null` for a retired type, and `resolveTemplate`'s `preview-family` throws `familyNotActive`.
    - **The draft path:** a `draft: true` preview (EDIT) would still render the type's open DRAFT pair, which D6 leaves in place.
  - **The detail page:** it shows the Info status line, no Upload, Save, Activate, Discard or Retire control, and the Version history with **Export** (ui-context §10e). The settings tab renders read-only, exactly as for a READ user.
    - **How:** the page loads its data with `canEdit` false for a retired type, so the open DRAFT pair and any discarded rows are neither opened nor listed.
    - **Why it matters:** without that, an EDIT user would land on the working DRAFT (bm57 D4), and the DRAFT would stay reachable through the history (`isShowable`, `version-visibility.ts`).
- **D8: The BAN list in the dialog is paginated server-side.** The page passes the count, from cm23's `countBoundBansByType`, and the first page. "Show more" calls a read action. Both read the column inside `template-types.ts`, the one Billing file CM guardrail 11 allows for this.

## Implementation

### 1. Types: `types/billing.ts` (changed)

`TemplateTypeErrorCode` gains the codes from code-standards TS rule 2 that bm77 left for later units: `"TEMPLATE_TYPE_RETIRED" | "DEFAULT_TYPE_NOT_RETIRABLE" | "RETIRE_TARGET_NOT_USABLE" | "RETIRE_NAME_MISMATCH"`. Then:

```ts
export const RETIRE_BAN_PAGE_SIZE = 20;
export const RETIRE_AUDIT_CHUNK_SIZE = 500;
export interface BoundBanRow { billingAccountId: string; name: string | null; state: string }
export type RetireTemplateTypeResult =
  | { ok: true; movedBanCount: number }
  | { ok: false; code: "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR" | Exclude<TemplateTypeErrorCode, "TEMPLATE_TYPE_NAME_TAKEN" | "TEMPLATE_TYPE_NAME_INVALID" | "TEMPLATE_NOT_BINDABLE"> };
```

### 2. Repositories

**`db/repositories/billing/bill-template-family.ts`:**

```ts
// bm83 (Inv #65, #67) — the ONE update the type guard allows: retirement. null when the
// row is already retired or is the default (callers re-check first; this is the backstop).
async retireType(tx: Database, typeId: string): Promise<BillTemplateFamily | null>
// UPDATE billing.bill_template_family SET retired_datetime = now()
// WHERE bill_template_family_id = $1 AND retired_datetime IS NULL AND NOT is_default RETURNING *
```

**`db/repositories/audit.repository.ts`:** add `insertAuditEvents(db, events[])`, one multi-row `INSERT … VALUES` with the same column mapping as `insertAuditEvent`. A call with no events does nothing.

### 3. Service: `services/billing/invoice-template/template-types.ts` (changed)

```ts
// bm83 (Inv #66, #67) — retire a type and move every BAN bound to it to one usable target,
// in ONE transaction. The only Billing writer of billing_account.ref_bill_template_family_id
// (CM guardrail 11; billing guardrail 79). Never touches bill_template_version.
export async function retireTemplateType(
  input: { typeId: string; targetTypeId: string | null; confirmName: string },
  actorId: string,
): Promise<RetireTemplateTypeResult>
```

Inside `db.transaction`, with a `RetireRollback(code)` class (the `ActivationRollback` pattern):
1. `ids = [typeId, targetTypeId].filter(notNull).sort(byCodePoint)`. For each id in that order: `lockTemplateType(tx, id, id === typeId ? "update" : "share")`. Keep the rows.
2. The re-checks of D3 step 2, in that order. `isUsable(tx, target)` = `!target.isDefault && target.retiredDatetime === null && findActive(tx, { kind: "generated", familyId: target.id }) !== null`. `targetTypeId === typeId` → `RETIRE_TARGET_NOT_USABLE`.
3. The switch:
   ```ts
   const moved = await tx.update(billingAccount)
     .set({ refBillTemplateFamilyId: targetTypeId, lastModified: sql`now()`, lastEditedBy: actorId })
     .where(eq(billingAccount.refBillTemplateFamilyId, typeId))
     .returning({ billingAccountId: billingAccount.billingAccountId });
   ```
4. For each chunk of `RETIRE_AUDIT_CHUNK_SIZE`: `insertAuditEvents(tx, chunk.map(ban => ({ eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED", actorUserId: actorId, targetEntity: "BILLING_ACCOUNT", targetId: ban.billingAccountId, beforeData: { refBillTemplateFamilyId: typeId, typeName: type.name }, afterData: { refBillTemplateFamilyId: targetTypeId, typeName: target?.name ?? STANDARD_TYPE_NAME, reason: "TEMPLATE_TYPE_RETIRED" } })))`.
5. `remaining = count(*) WHERE ref_bill_template_family_id = typeId`. If it is greater than 0, throw `Error("RETIRE_BANS_REMAIN")`, which rolls back, and the action gives `SERVER_ERROR` and logs it.
6. `retireType(tx, typeId)`. A `null` result → `RetireRollback("TEMPLATE_TYPE_RETIRED")`.
7. `insertAuditEvent(tx, { eventType: "INVOICE_TEMPLATE_TYPE_RETIRED", actorUserId: actorId, targetEntity: "BILL_TEMPLATE_FAMILY", targetId: typeId, beforeData: { name, code, retiredDatetime: null }, afterData: { retiredDatetime, targetTypeId, targetTypeName, movedBanCount: moved.length } })`.

The result is `{ ok: true, movedBanCount: moved.length }`.

Add the paginated read:

```ts
// bm83 (D8) — the BANs bound to a type, by billing_account_id, for the retire dialog.
export async function listBoundBans(db: Database, typeId: string, page: number): Promise<BoundBanRow[]>
// SELECT billing_account_id, name, state FROM billing.billing_account
// WHERE ref_bill_template_family_id = $1 ORDER BY billing_account_id
// LIMIT RETIRE_BAN_PAGE_SIZE OFFSET page * RETIRE_BAN_PAGE_SIZE
```

### 4. The `TEMPLATE_TYPE_RETIRED` checks (D7)

- **`services/billing/invoice-template/save-template-draft.ts`:** the check goes right after `lockTemplateType(tx, familyId, "update")` and before `lockKind`: `family.retiredDatetime !== null` gives `TEMPLATE_TYPE_RETIRED`. The bm77–bm79 review fix made this lock the transaction's first statement.
  - **The result type:** the code joins `SaveTemplateDraftResult`'s general failure arm. The `DRAFT_LAYOUT_REPLACED` arm (bm80) stays separate.
  - **The action:** it maps the code unchanged.
- **`services/billing/invoice-template/preview.ts`:**
  - **The check:** `previewInvoiceTemplate` first reads `billTemplateFamilyRepository.findById(db, familyId)`, before `previewSample` or the bill path calls `resolveTemplate`. If the type is retired, it throws `TemplateTypeRetiredError` (a new class beside `PreviewBillNotFoundError`), whatever the source and the `draft` flag.
  - **The action:** `preview-invoice-template.action.ts` maps it to `{ ok: false, code: "TEMPLATE_TYPE_RETIRED" }`, and the result union gains the code.
- **The messages.** `TEMPLATE_TYPE_MESSAGES.typeRetired` is worded for activate and discard ("…its drafts can no longer be activated or discarded"). Add `typeRetiredEdit`: "This invoice template type has been retired, so it can no longer be edited or previewed."
  - **`components/billing/invoice-settings/invoice-structure-form.tsx`:** `saveDraft` gains a `TEMPLATE_TYPE_RETIRED` branch that toasts `typeRetiredEdit` and calls `router.refresh()`. Today it falls through to the generic "could not be saved".
  - **`components/billing/invoice-settings/invoice-preview-frame.tsx`:** `ERROR_MESSAGES` gains `TEMPLATE_TYPE_RETIRED: typeRetiredEdit`. Preview errors show in this frame, not in the form.

### 5. Actions

**`actions/billing/invoice-settings/retire-template-type.action.ts` (new):** `"use server"`.
1. `requirePermission(INVOICE_SETTINGS, EDIT)`; a redirect → `FORBIDDEN`.
2. `retireTemplateTypeSchema.safeParse` → `VALIDATION_ERROR`.
3. `retireTemplateType`. A thrown error → `logger.error` → `SERVER_ERROR`.
4. `revalidatePath("/administration/invoice-settings", "layout")`, `revalidatePath("/customers", "layout")` (the BAN labels changed).

**`actions/billing/invoice-settings/list-bound-bans.action.ts` (new):** `requirePermission(INVOICE_SETTINGS, EDIT)` (only the dialog uses it), then the schema `{ typeId, page: z.number().int().min(0) }`, then `listBoundBans`.

**`validation/billing/retire-template-type.schema.ts` (new):** `{ typeId: templateFamilyIdSchema, targetTypeId: templateFamilyIdSchema.nullable(), confirmName: z.string().trim().min(1).max(60) }`.

### 6. UI

- **`components/billing/invoice-settings/retire-template-type-dialog.tsx` (new, client):**
  - **Trigger:** the outline **Retire type…** button in the detail header, for EDIT holders, on a non-Standard, non-retired type.
  - **The `AlertDialog`** holds, per ui-context §10e:
    - the bound-BAN count (`--text-h3`, tabular numerals)
    - the paginated BAN list (mono ids, name, state), with "Show more" calling `listBoundBansAction`
    - the target `Select`: Standard first and preselected (`null`), then `listUsable` minus this type
    - an `Input` for the typed name
    - the confirm **Retire type** in the danger role, disabled until `input.trim() === type.name`
  - **On a refusal:** the code's message from `template-type-messages.ts`, then `router.refresh()`.
  - **On success:** `toast.success("{name} retired. {n} billing accounts moved to {target}.")` ("1 billing account" when one moved; review fix, owner 2026-10-26), then a refresh.
- **`[typeId]/page.tsx`:** the page data gains `retiredDatetime`, `boundBanCount`, `firstBoundBans` and `retireTargets` (loaded only for EDIT on a non-Standard, non-retired type). The page data already carries `typeStatus`. When retired:
  - the Info line "Retired {date}. History and exports remain available."
  - `getInvoiceTemplatePageData(typeId, version, { canEdit: canEdit && !retired })`, so no DRAFT or discarded row is opened or listed (D7)
  - no Upload, Save, Activate, Discard or Retire control. Upload and Discard are already behind `canUpload`. The form's `editable`, the "Edit draft" banner and `VersionHistoryTable`'s `canViewDrafts` follow the same flag.
  - the settings tab read-only
  - Export kept
- **`template-type-messages.ts`:** the dialog texts, the four refusal messages, `typeRetiredEdit` (§4), and the retired status line.

### 7. Audit catalogue

- **`types/audit.ts`:** `"INVOICE_TEMPLATE_TYPE_RETIRED"`.
- **`types/audit-log.ts`:** `INVOICE_TEMPLATE_TYPE_RETIRED: "Removal"`.
- **`tests/components/audit-log-filters.test.tsx`:** 92 → 93 (92 after bm81's `INVOICE_TEMPLATE_EXPORTED`).
- `BILLING_ACCOUNT_TEMPLATE_CHANGED` exists already (cm21).

### 8. Tests

**New, in `tests/db/retire-template-type.integration.test.ts`** (DB-gated). Types are created and activated through `tests/db/helpers/template-type-db-harness.ts`, the shared handle from the bm77–bm79 review: `h.createTypeWithLayout`, `h.upload`, `h.settingsDraft` and `h.auditRows`, plus the activate service. Don't write a new fixture lifecycle. BANs are bound through cm23's `setBillingAccountTemplate`.

Guardrail 77:
- **Retire to Standard:** BANs A (open) and C (closed) on Wholesale are retired to Standard. Then:
  - both read `NULL`, with a bumped `last_modified`
  - two `BILLING_ACCOUNT_TEMPLATE_CHANGED` rows with `reason: "TEMPLATE_TYPE_RETIRED"` and the D4 payload
  - one `INVOICE_TEMPLATE_TYPE_RETIRED` row
  - `retired_datetime` set
  - every `bill_template_version` row of Wholesale equal to a snapshot taken before (row-by-row compare)
  - `party_role.last_modified_datetime` unchanged
- **Retire to another type:** Wholesale's BANs to "Retail" (usable) read Retail's id.
- **Refusals**, each writing nothing:
  - Standard → `DEFAULT_TYPE_NOT_RETIRABLE`
  - already retired → `TEMPLATE_TYPE_RETIRED`
  - wrong `confirmName` → `RETIRE_NAME_MISMATCH`
  - the target is itself, Standard's id, retired, or not-yet-usable → `RETIRE_TARGET_NOT_USABLE`
- **The audit chunking:** 1,201 bound BANs (bulk SQL fixture) give exactly 1,201 audit rows. A spy shows three `insertAuditEvents` calls (500/500/201).
- **The remaining-BANs check:** a spy that inserts a BAN on the type between steps 4 and 5 makes the retire roll back, so no BAN moves and the type is not retired.
- **Refusals after retire:** save, upload, preview (with `draft` true and false) and activate on the retired type each return `TEMPLATE_TYPE_RETIRED`. Discard, too, on a type retired with an open DRAFT pair, and that pair's rows stay unchanged (D6).

Guardrail 76, on two concurrent `db.transaction` calls on the pooled client, coordinated by a barrier promise. This is the `Promise.all` pattern of `activate-template.integration.test.ts`, and the deterministic two-connection lock-order regression in `save-template-draft.integration.test.ts` (the bm77–bm79 review's deadlock fix):
- **Bind first:** connection 1 binds BAN B to Wholesale and holds the transaction open; connection 2 retires Wholesale. Connection 2 waits, and after connection 1 commits it moves BAN B too.
- **Retire first:** connection 2 holds the retire open, and connection 1's bind waits, then returns `TEMPLATE_NOT_BINDABLE`.
- **Opposite retires:** retire Wholesale→Retail and retire Retail→Wholesale run concurrently. Both finish within a timeout, with no `40P01`. Exactly one succeeds, and the other returns `RETIRE_TARGET_NOT_USABLE` or `TEMPLATE_TYPE_RETIRED`.
- **Save racing retire:** a save-draft holding Wholesale's type row, then a retire of Wholesale. The retire waits, then succeeds. In the opposite order, the save waits and returns `TEMPLATE_TYPE_RETIRED`. Neither gives `40P01`.
- **After every case:** zero BANs reference a retired type.

**New:**
- **`tests/actions/billing/invoice-settings/retire-template-type.action.test.ts`:** guard first (a READ user gives `FORBIDDEN`, and the service isn't called), Zod, the mapping, and both revalidations.
- **`tests/components/billing/invoice-settings/retire-template-type-dialog.test.tsx`:**
  - the count and the list, with "Show more" calling the action
  - Standard preselected and listed first
  - confirm disabled until the exact name, then enabled
  - the danger role, inside the dialog only
  - each refusal message shown, then a refresh

**Changed:**
- **`tests/guardrails/customer-accounts-binding-boundaries.test.ts`:** test 5's allowed writers gain `services/billing/invoice-template/template-types.ts#retireTemplateType:update` (billing guardrail 79, boundary half). The column-reference allowance for this file is already in place since cm23.
- **`tests/guardrails/invoice-settings-authz-matrix.test.ts`:** rows for `retire-template-type.action.ts` and `list-bound-bans.action.ts` (EDIT).
- **`tests/db/save-template-draft.integration.test.ts`** and the preview action test: the `TEMPLATE_TYPE_RETIRED` cases.
- **`tests/components/billing/invoice-settings/invoice-structure-form.test.tsx`** and the preview-frame test: a save, and a preview, returning `TEMPLATE_TYPE_RETIRED` show `typeRetiredEdit`. The save also refreshes.
- **`tests/app/invoice-template-type-detail-page.test.tsx`:** for a retired type and an EDIT user:
  - the Info line, no Upload, Save, Activate, Discard or Retire control, and a form that can't be edited
  - no DRAFT or discarded row in the history, even with an open DRAFT pair
  - the page data loaded with `canEdit: false`
- **Grants:** no new grant is needed. bm77 granted `app_runtime` UPDATE on `bill_template_family`, and its `billing_account` UPDATE already exists for cm21. bm77's grant case covers the retire update.

## Dependencies

- **cm23 + bm82:** the type column, `countBoundBansByType`, `listUsable`, the bind gate's `FOR SHARE`, and `STANDARD_TYPE_NAME`.
- **bm77:** the type repository, its grant and the detail page.
- **bm78 and bm79:** `lockTemplateType`, the refusals already in place, the `canUpload` gate, and the shared test harness.
- **bm81:** the Export link the retired page keeps, and `version-visibility.ts` (`isShowable`, moved there from the read service).
- **Environment:** a disposable Postgres; the race cases need a pool of at least two connections.

## Verification checklist

- [ ] Retiring Wholesale to Standard moves BAN A (and any closed BAN) to `NULL`, audits each move with `reason: "TEMPLATE_TYPE_RETIRED"`, retires the type, and leaves every version row unchanged (guardrail 77).
- [ ] Wholesale shows Retired in the list. Its detail page is read-only with Export, and its history is intact.
- [ ] Standard can't be retired. An explicit Standard target id is refused, and the switch to Standard writes `NULL` (guardrail 76).
- [ ] Bind racing retire, in both orders, and retire A→B racing B→A, pass with no deadlock. Zero BANs reference a retired type (guardrail 76).
- [ ] Save, upload, preview (draft or not), activate and discard on a retired type return `TEMPLATE_TYPE_RETIRED`. The retired page opens no DRAFT, even for EDIT.
- [ ] The typed-name check is enforced on the server. The confirm is disabled until the name matches.
- [ ] Only `template-types.ts` in Billing writes `billing_account.ref_bill_template_family_id`, and only in `retireTemplateType` (CM guardrail 11; billing guardrail 79).
- [ ] `INVOICE_TEMPLATE_TYPE_RETIRED` is in the audit catalogue (93 filter options). The authz matrix includes both new actions.
- [ ] `tsc --noEmit`, ESLint and Prettier pass. The cm23, bm78–bm82 suites are green.
- [ ] Docs: Inv #66 and #67 marked "built (bm83)" with test files; the Retire permission-map row marked built; `billmgmt-progress-tracker.md` records bm83.
