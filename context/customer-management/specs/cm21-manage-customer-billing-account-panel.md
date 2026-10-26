# CM21 — Manage Customer: Billing Account Panel + Template Reset

- **Unit:** 21 of 22 (`cm00-build-plan.md` Phase 2 — Invoice Template Binding update). **Boundary:** APP (customer screen + the Accounts-side service and action it calls).
- **Dependencies:** `cm17` (column); `cm18` (`assertBindableTemplate`); `cm20` (`resolveCurrentTemplateLabel` / `banTemplateLabel`, `BanStateChip`); delivered `cm08` Manage Customer edit page; delivered BAN CAS precedent (`billingAccountRepository.close`, ac16).
- **Authorizing sections:** binding plan §6, D3, D12, D13, D15; the binding update overview (folded into `custmgmt-project-overview.md`) *Core user flow 3*, *Features → Template binding write path*, *Manage Customer panel*; `custmgmt-architecture.md` §7.2, §7.4, Inv. #16, #17, #18; `custmgmt-ui-context.md` §9.4–§9.5; `custmgmt-ai-workflow-rules.md` §1.3 (lock scope), §8.2–§8.3, §9.3 items 1, 7.
- **Decisions recorded 2026-10-10:** O4 → event type **`BILLING_ACCOUNT_TEMPLATE_CHANGED`** (category `Change`); reset button **enabled only when the BAN holds a non-`NULL` value**, otherwise disabled with "Already following the active template" (always disabled in v1); Inv. #17 decided (BAN lock, never the customer lock).
- **Codebase verified against:** `enterprise-billing-app` working tree, 2026-10-10.

> **Framing.** Manage Customer is where RevOps changes a customer. This unit gives it a **Billing account** panel that lists the customer's BANs with their invoice-template label and a reset control, plus the audited write path behind it. In v1 every BAN is already `NULL`, so the reset is always a no-op and the button is always disabled; the service, action, lock and audit are still built and tested so Phase 3 only has to relax `assertBindableTemplate` and add a picker. The lock is the **BAN's** `last_modified` (CAS, the `close` precedent), never `party_role.last_modified_datetime` (Inv. #17).

---

## 1. Goal

Add a read-only-by-default **Billing account** panel to `/customers/manage/[id]` listing the customer's BANs with state and template label, and a `set-billing-account-template` action that resets a BAN's reference to `NULL` in one audited, CAS-guarded transaction, gated on `customers : EDIT` **and** `accounts_transactions : EDIT`.

## 2. Design

**Structural decisions**

- **Service result union:** `{ ok: true; value: { billingAccountId; changed: boolean; lastModified: Date } } | { ok: false; code: "BAN_NOT_FOUND" | "BAN_CLOSED" | "CONFLICT" | "TEMPLATE_NOT_BINDABLE" }`.
- **Order inside one `db.transaction` (D15):**
  1. `assertBindableTemplate(tx, input.billTemplateVersionId)` → `TEMPLATE_NOT_BINDABLE` (v1: any non-`NULL`).
  2. `before = billingAccountRepository.findById(tx, id)`; missing **or** `before.refPartyRoleId !== input.partyRoleId` → `BAN_NOT_FOUND` (a BAN can only be reset from its own customer's page; no cross-customer tampering).
  3. `before.state === "closed"` → `BAN_CLOSED`.
  4. `before.lastModified.getTime() !== input.lastModified.getTime()` → `CONFLICT`.
  5. `before.refBillTemplateVersionId === input.billTemplateVersionId` → `{ ok: true, changed: false }`; **no write, no audit**.
  6. CAS write `billingAccountRepository.setTemplateRef(tx, id, input.lastModified, value, actorId)` (`WHERE id AND last_modified = ? AND state <> 'closed'`, sets `ref_bill_template_version_id`, `last_edited_by`, `last_modified = now()`); a lost race returns `conflict` → `CONFLICT`.
  7. `insertAuditEvent(tx, { eventType: "BILLING_ACCOUNT_TEMPLATE_CHANGED", targetEntity: "BILLING_ACCOUNT", targetId: id, beforeData: { refBillTemplateVersionId: before… }, afterData: { refBillTemplateVersionId: value } })`.
- **Lock = CAS on `billing_account.last_modified`.** Follows `billingAccountRepository.close` (ac16), which is the BAN write precedent; it satisfies Inv. #17's "BAN's own lock" without a separate `FOR UPDATE` read. `party_role.last_modified_datetime` is never read or bumped; the existing guardrail ("compare-and-bump lock predicate only on `party_role`") is unaffected because it scans `last_modified_datetime`, a different column.
- **Action guard (Inv. #16):** `requirePermission(CUSTOMERS, EDIT)` then `meetsLevel(permissionMap[ACCOUNTS_TRANSACTIONS], EDIT)`, else `FORBIDDEN`; Zod parse; service; on `ok`, `revalidatePath` for `/customers/manage/${partyRoleId}` and `/customers/view/${partyRoleId}`.
- **Panel data:** a light read, not the cm20 summary (no balances or documents needed): `listCustomerBillingAccounts(partyRoleId)` returns, per BAN, `billingAccountId`, `name`, `state`, `lastModified`, `refBillTemplateVersionId`, `templateLabel` (one `resolveCurrentTemplateLabel` call per request). Introduced here, its first caller.
- **Panel behaviour:**

| Viewer / BAN | Control |
|---|---|
| Holds `accounts_transactions : EDIT`, BAN value non-`NULL`, BAN not closed | **Reset to follow active template** enabled (secondary button) |
| Holds it, BAN value `NULL` (every v1 BAN) | Disabled, caption "Already following the active template" |
| Holds it, BAN `closed` | Disabled, caption "Billing account is closed" |
| Lacks `accounts_transactions : EDIT` | Disabled with `EDIT_DISABLED_TITLE` tooltip (UX only) |
| Customer not onboarded | Panel shows "Accounts are created when the customer is validated." and no BAN rows |

- **Messages on result:** `CONFLICT` → "This billing account was changed by someone else. Reload and try again." `BAN_CLOSED` → "This billing account is closed." `TEMPLATE_NOT_BINDABLE` → "This invoice template cannot be assigned." `BAN_NOT_FOUND` → "Billing account not found. Reload the page." `FORBIDDEN` → "You do not have permission to change billing accounts." Rendered with the danger alert (`custmgmt-ui-context.md` §9.5).
- **Placement:** after `ContactManagerPanel` on the Manage Customer page (last section).

## 3. Implementation

### 3.1 Audit catalog — `types/audit.ts`, `types/audit-log.ts` (extend)

Append `"BILLING_ACCOUNT_TEMPLATE_CHANGED"` to `AUDIT_EVENT_TYPES` after `"ACCOUNT_CLOSED"`; add `BILLING_ACCOUNT_TEMPLATE_CHANGED: "Change"` to `AUDIT_EVENT_CATEGORY_MAP` with a `// cm21 — a BAN's invoice template reference changed (binding plan D15).` comment.

### 3.2 Repository — `db/repositories/accounts/billing-account.repository.ts` (extend, one method)

```ts
  // cm21 (binding plan D15, custmgmt Inv. #17) — CAS write of the BAN's
  // invoice template reference, same four-outcome shape as `close`. Locks on
  // the BAN's own last_modified; never touches party_role.
  async setTemplateRef(
    tx: Database,
    billingAccountId: string,
    lastModified: Date,
    refBillTemplateVersionId: string | null,
    actorId: string,
  ): Promise<"updated" | "conflict" | "closed" | "not_found"> { … }
```

Implementation mirrors `close`: conditional `UPDATE … SET ref_bill_template_version_id, last_edited_by, last_modified = now() WHERE billing_account_id = ? AND last_modified = ? AND state <> 'closed' RETURNING`; on no row, re-read to classify `not_found` / `closed` / `conflict`.

### 3.3 Validation — `validation/accounts/set-billing-account-template.schema.ts` (new)

```ts
export const setBillingAccountTemplateSchema = z.object({
  partyRoleId: z.string().regex(/^PTRL\d{8}$/),
  billingAccountId: z.string().regex(/^BAN\d+$/),
  billTemplateVersionId: z.string().regex(/^BTV\d{8}$/).nullable(),
  lastModified: z.coerce.date(),
});
```

### 3.4 Service — `services/accounts/set-billing-account-template.ts` (new)

`setBillingAccountTemplate(input, actorId)` implementing §2 steps 1–7 in one `db.transaction`. Doc comment states the contract and every failure code (`context/ai-workflow-rules.md` §6.7).

### 3.5 Read — `services/accounts/list-customer-billing-accounts.ts` (new)

`listCustomerBillingAccounts(partyRoleId)`: FAs via `financialAccountRepository.findByPartyRoleIds`; BANs via `billingAccountRepository.findByFinancialAccountId` (full rows); `currentLabel = resolveCurrentTemplateLabel(db)` once; map with `banTemplateLabel`. Returns `{ onboarded: false } | { onboarded: true; bans: CustomerBillingAccountRow[] }` (type in `types/accounts.ts`).

### 3.6 Action — `actions/accounts/set-billing-account-template.ts` (new)

`"use server"`; result union = service union + `FORBIDDEN` + `VALIDATION_ERROR` (with `fieldErrors`); guard and revalidation per §2.

### 3.7 Panel — `components/customers/billing-account-panel.tsx` (new, client)

Props: `{ partyRoleId, accounts, canEditAccounts }`. One row per BAN: BAN id (mono), name, `BanStateChip` (cm20), template label (cm20 §9.4 styling), and the reset button per the §2 table (`custmgmt-ui-context.md` §9.5: secondary style; disabled via `--action-disabled-bg` / `--text-disabled`; tooltip `EDIT_DISABLED_TITLE` from `components/accounts/edit-access.ts`). On click: call the action with `billTemplateVersionId: null` and the row's `lastModified`; show the result message; on success `router.refresh()`.

### 3.8 Page — `app/(app)/customers/manage/[id]/page.tsx` (extend)

Read `permissionMap` from the existing `requirePermission(CUSTOMERS, EDIT)` call; `canEditAccounts = meetsLevel(permissionMap[ACCOUNTS_TRANSACTIONS], EDIT)`. Load `listCustomerBillingAccounts(partyRoleId)` in the existing `Promise.all` with locale/timezone. Render `<BillingAccountPanel …/>` after `<ContactManagerPanel …/>`. Guard unchanged.

### 3.9 Tests

| File | Cases |
|---|---|
| `tests/services/set-billing-account-template.test.ts` (new, mocked) | non-`NULL` → `TEMPLATE_NOT_BINDABLE`, no repo call; missing BAN → `BAN_NOT_FOUND`; BAN of another party role → `BAN_NOT_FOUND`; closed → `BAN_CLOSED`; stale `lastModified` → `CONFLICT`; unchanged `NULL` → `changed: false`, no `setTemplateRef`, no audit; non-`NULL` → `NULL` (row seeded by raw fixture) → update + audit with before/after; CAS `conflict` → `CONFLICT` |
| `tests/accounts/set-billing-account-template.integration.test.ts` (new, DB-gated) | real transaction: a BAN set to `BTV00000002` by raw SQL resets to `NULL`, `last_edited_by` = actor, `last_modified` advanced, one `BILLING_ACCOUNT_TEMPLATE_CHANGED` row; second call with the stale timestamp → `CONFLICT`; `party_role.last_modified_datetime` unchanged; closed BAN → `BAN_CLOSED` |
| `tests/actions/set-billing-account-template.action.test.ts` (new) | `FORBIDDEN` without `customers : EDIT`; `FORBIDDEN` with `customers : EDIT` but no `accounts_transactions : EDIT`; `VALIDATION_ERROR` on bad ids; revalidates both paths on success |
| `tests/components/billing-account-panel.test.tsx` (new) | `NULL` BAN → button disabled with "Already following the active template"; non-`NULL` + permission → enabled; no permission → disabled with tooltip; closed → disabled; each failure code shows its message |
| `tests/app/customers-manage-page.test.tsx` (extend) | panel renders after the contact manager; `canEditAccounts` derived from `permissionMap`; not-onboarded copy for an `INITIALIZED` customer |
| `tests/types/audit-log.test.ts` (extend) | `BILLING_ACCOUNT_TEMPLATE_CHANGED` maps to `"Change"` |
| `tests/accounts/route-level-matrix.test.ts` or the customer authz sweep (extend) | the new action appears with its dual-permission rule |

DB-gated tests run only on a throwaway Postgres marked disposable.

### 3.10 Explicitly NOT in this unit

- A template picker or any non-`NULL` value (Phase 3).
- Bumping or reading `party_role.last_modified_datetime`.
- Any change to the View Customer Accounts tab (cm20) or posting.

## 4. Dependencies (packages to install)

None.

## 5. Verification checklist

- [ ] Manage Customer shows the Billing account panel after contacts, one row per BAN with state chip and template label.
- [ ] In v1 every reset button is disabled with "Already following the active template"; a viewer without `accounts_transactions : EDIT` sees it disabled with the tooltip.
- [ ] Action rejects a caller missing either permission (`FORBIDDEN`), even when called directly.
- [ ] Service: `NULL`→`NULL` writes nothing and no audit; non-`NULL`→`NULL` writes the column, `last_edited_by`, `last_modified`, and one `BILLING_ACCOUNT_TEMPLATE_CHANGED` event in one transaction.
- [ ] `CONFLICT`, `BAN_CLOSED`, `BAN_NOT_FOUND` (incl. cross-customer), `TEMPLATE_NOT_BINDABLE` returned in their cases, each with its message.
- [ ] `party_role.last_modified_datetime` unchanged by a reset; existing customer guardrails green.
- [ ] Audit catalog and category map updated; `tests/types/audit-log.test.ts` green.
- [ ] All §3.9 tests green; DB-gated on a disposable Postgres; `npm run typecheck`, `npm run lint`, Prettier clean.
- [ ] Docs: `custmgmt-code-standards.md` §7 file tree and §8 permission map (new action, dual permission); binding plan open items O1/O3/O4 marked closed; `custmgmt-progress-tracker.md` updated; Accounts-side doc rows drafted for approval.
