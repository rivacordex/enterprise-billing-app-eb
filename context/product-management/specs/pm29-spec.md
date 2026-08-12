# pm29 — New Order Wizard UI + Action

## Goal

Ship the three-step New Order wizard and its Server Action so a RevOps user can place a real order end-to-end: standard-price orders complete instantly; override orders park `PENDING` after an explicit approval-warning banner.

## Design

- The app's first multi-step wizard (architecture §1): a full-screen `Dialog` opened from pm27's "New order" CTA, step state client-held (`useState`), **UX only** — the submit payload is re-validated by Zod in the action and by pm28's service under locks. Back/forward between steps never refetches committed data.
- Step reads use other modules' **services** (architecture §2): Step 1 `searchCustomers` (customer module, existing), Step 2 `getFinancialAccountDetail`/`search-accounts` (accounts module, existing — BAN list with state/currency/cycle/terms), Step 3 `listOfferings` + `getOfferingDetail` (catalog, existing — picker filter applied server-side: `ACTIVE ∧ billing_only ∧ is_sellable`).
- Visuals per `mockup-product-ordering.html`: blocked rows disabled with reason, read-only context strip (customer · BAN · currency · cycle · terms), backdate warning banner (`--bg-warning`, catalog copy pattern), approval-required banner when any override amount entered.

## Implementation

### 1. Action — `actions/ordering/create-order.action.ts`

Standard shape: `requirePermission(PRODUCT_ORDERS, EDIT)` → `isRedirectError` catch → `createOrderSchema.safeParse` → `createOrder` (pm28) → on success `revalidatePath('/products/orders')` (+ `/products/subscriptions`) → typed `{ok, code}` result mapping every pm28 error code to a field- or form-level message. New folder `actions/ordering/` — a new boundary guardrail allow-list (`EXPECTED_ORDERING_ACTION_FILES`, pm19 precedent) is created in this unit.

### 2. Wizard components — `components/products/ordering/`

- `new-order-wizard.tsx` — `NewOrderWizard`: dialog + stepper (3 steps, done/current markers), holds selection state, composes the step components; Cancel resets.
- `wizard-step-customer.tsx` — `WizardStepCustomer`: search input (party-role/name toggle, customer-search pattern), result rows; non-`ACTIVE` parties render disabled with status pill and "Not orderable — customer not ACTIVE".
- `wizard-step-account.tsx` — `WizardStepAccount`: non-closed BANs of the selected customer's FA with state pill, currency, cycle (`BCY… · name`), resolved terms — all read-only; exactly one open BAN → auto-preselected; closed BANs rendered disabled.
- `wizard-step-offer.tsx` — `WizardStepOffer`: offer picker (search, name + version + flags), current effective prices table (read-only, from `getOfferingDetail` — reuses catalog effectivity, never reimplemented), quantity input (default 1), start-date input (default today; warning banner when backdated ≤ 3 days; > 3 days → field error), `CharacteristicsEditor`, `OverridePriceFields`.
- `characteristics-editor.tsx` — `CharacteristicsEditor`: `useFieldArray` key/value rows (pm21's `recordToList`/`listToRecord` boundary-translation pattern reused), prefilled from the version's spec-characteristic keys + defaults; rows addable/removable.
- `override-price-fields.tsx` — `OverridePriceFields`: one row per **flat** price type — list amount (struck when overridden) + optional negotiated input; tiered rows shown read-only with "not overridable"; any non-empty override renders the approval banner: *"A negotiated price requires manager approval — this order will be submitted for review."*
- Form stack: `react-hook-form` + local zodResolver on `createOrderSchema` (fast-fail), `Controller` for non-native inputs — all existing house patterns.

### 3. Wiring

Fills pm27's "New order" seam (one import + JSX wrap — nothing else in `orders-table.tsx` changes). Success: dialog closes, toast (`Order PRDORDxxxxxxxx completed` / `submitted for approval`), `router.refresh()` (pm19 pattern — no URL-state navigation).

## Dependencies

None (npm — `react-hook-form`, Radix dialog, lucide already installed). pm27 (seam host), pm28 (service) committed.

## Verification checklist

- [ ] End-to-end in the browser: standard order on the seeded ACTIVE customer completes; new row `COMPLETED` in the list; subscription row exists in the DB.
- [ ] Override entry shows the banner; submit lands `PENDING`, badged in the list, zero inventory rows.
- [ ] Step 1 blocks `VALIDATED`/`SUSPENDED`/`CLOSED` parties (disabled, reason shown); Step 2 lists only non-closed BANs and auto-preselects a sole open BAN; Step 3 picker never offers `DRAFT`/`RETIRED`/non-sellable/non-billing-only offerings.
- [ ] Backdate ≤ 3 days → warning, submits; > 3 days → field error client-side **and** `BACKDATED_START_TOO_FAR` server-side when forced.
- [ ] Action rejects a no-permission caller (`FORBIDDEN`) with the service never called (unit test, pm20 precedent).
- [ ] Component tests: characteristics record↔list translation, override → banner, stepper navigation preserving state.
- [ ] Boundary guardrail: `EXPECTED_ORDERING_ACTION_FILES = ['create-order.action.ts']`; `tsc`, lint, format, full suite, `next build` green.
