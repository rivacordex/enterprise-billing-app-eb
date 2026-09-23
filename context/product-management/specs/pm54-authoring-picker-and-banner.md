# pm54 — Authoring: component picker, the two plain components, blocking banner (closes the atomic window)

**Unit:** pm54 (Part 4). **Boundary:** `components/products/manage/` — `component-type-picker.tsx` (new), `offering-component-error-banner.tsx` (new), `price-form.tsx`, `manage-prices-panel.tsx`, `editable-prices.tsx` — plus their tests. No schema, no repository, no service, no action file, no route, no search param.
**Specs from:** `prodmgmt-ui-context.md` §7 (component picker, cross-component errors, inline panel editing), §2, §4, §5 · `prodmgmt-code-standards.md` §1.19, §2.8, §2.14, §3.2, §3.6, §3.13, §3.14, §4.8, §4.11, §4.19, §4.20, §4.21 · `prodmgmt-architecture.md` §3.3, §4, Inv. #31, #33, #34, #35, #42 · `prodmgmt-ai-workflow-rules.md` §4.3, §8.8, §8.10, §8.12, §8.15.
**Depends on:** **pm50, pm51, pm52, pm53** (all four must be in the branch before the green claim) and **pm41** (the editable pricing panel this extends), through it **pm40**.

**This unit closes gate G-E.** `tsc --noEmit`, ESLint, Prettier and the **full test suite** must be green here, and the pm46–pm54 branch merges to `main` as **one commit**. The green claim is made once, at this unit — not before, and not again until pm56.

---

## Goal

Let a Billing Ops user author a `usage_rate` and a `flat_fee` inline on a `DRAFT` version through a component-type picker, see them render with pm53's badges, and be blocked from saving — by a panel-level banner driven by the server's typed refusal — when the offering's components contradict each other.

---

## Design

### D1. The form leads with the component type, and the branch owns the rest

`ComponentTypePicker` offers exactly the **four persistable** types, each as its ui-context §2 badge label plus one line of help. `negotiated_override` never appears — it cannot be written to this table (Inv. #39), and a disabled option would imply it someday could.

After the pick, the rest of the form is **that branch's `params` only** (§4.20). Two row-level fields sit above the branch, but they are not uniformly present, because the completeness rules differ per type (architecture §3.3, ui-context §7):

| Branch | `currency` | `unit_of_measure` | Recurring period pair |
| --- | --- | --- | --- |
| `usage_rate` | required | required | **hidden** |
| `flat_fee` — `priceType: recurring` | required | **hidden** | required |
| `flat_fee` — `priceType: oneTime` | required | **hidden** | **hidden** |
| `capacity_commitment` / `capacity_motivation` | required | required | **hidden** |

**A field that is NULL for a branch is hidden, not disabled** — the same rule the read-only panels follow, so "not applicable here" never reads as "broken" (§4.11, ui-context §7). `currency` is the one field every branch shares (PC3/VI5) and sits above the picker.

`flat_fee`'s `recurring` vs `oneTime` is a choice **inside** the branch, and it is what reveals the period pair — not the other way round. The badge and the form agree on the direction of that dependency (§4.18): the envelope's `priceType` decides; the columns follow.

### D2. This unit ships two branches; pm55 ships the other two

pm54 delivers the `usage_rate` branch (`ratePerUnit`, optional `rateCardLookUp`) and the `flat_fee` branch (`amount`, `recurring` vs `oneTime`). `capacity_commitment` and `capacity_motivation` — and the `steps[]` editor, the largest single piece — are pm55 (§4.3). The picker therefore renders four options from day one, with the two capacity branches leading to pm55's sub-forms; until pm55 lands **inside the same branch**, selecting them must not render a half-built form. Land pm55 immediately after, or have the picker's two capacity entries no-op until it does — **do not** ship a partial capacity sub-form to make the picker look complete.

### D3. `rateCardLookUp` is a free-text name, and the form must not pretend otherwise

A plain text input, `--font-mono`, with help text saying the rate card is not built yet and that an absent card means the rate per unit applies. **No autocomplete, no validation against a list, no lookup, no query** (§1.27, Inv. #42). The field is optional; empty means null.

### D4. The blocking banner renders from the server result — never as a client pre-check

`OfferingComponentErrorBanner` sits at the top of the pricing panel, danger role with `alert-triangle`, naming the offending components by their §2 badge label and stating the **missing counterpart, not the rule name** — *"Target Capacity Commitment needs a base usage rate in EA. Add one before saving."* Save is **disabled while it is present** (§4.19).

It renders from pm49's typed action result — `MODIFIER_WITHOUT_BASE_RATE` (carrying the unit), `AMBIGUOUS_BASE_RATE`, `CURRENCY_MISMATCH` (carrying both currencies) — and never from client-side state that mirrors VI3–VI5 (§3.13). The picker may disable an impossible branch as a convenience; **the authoritative refusal is the action's code**. One copy per code, keyed off the code names, which are binding (§7.8):

| Code | Copy |
| --- | --- |
| `MODIFIER_WITHOUT_BASE_RATE` | *"`<Badge label>` needs a base usage rate in `<unit>`. Add one before saving."* |
| `AMBIGUOUS_BASE_RATE` | *"This offering already has a usage rate in `<unit>` effective on that date. Change the start date or edit the existing rate."* |
| `CURRENCY_MISMATCH` | *"This offering's components are priced in `<existing>`. `<candidate>` cannot be mixed in."* |

It is deliberately **not** the warning tint — that would understate a rule that blocks the save — and deliberately not a `FieldError`, because there is no field to attach it to. This is the one place in the module where a pricing error is not row-local.

**Why the banner ships with pm54 and not pm55:** `CURRENCY_MISMATCH` can fire between two *plain* components. Shipping the plain-component authoring without the banner would surface a blocking refusal as a raw action error.

### D5. Exactly three new client leaves, and the panel stays a server component

The client leaves this update adds are the **picker**, the **`steps[]` editor** (pm55) and the **component sub-form** — three, and no more (§3.6). `ManagePricesPanel` does **not** become a client component because a branch inside it is editable; it hosts the banner and renders server-side. `editable-prices.tsx` remains the client leaf pm41 created and gains the branch switching, it does not become a second panel.

### D6. Inline editing keeps pm41's contract exactly

Explicit **Save** and **Cancel** (secondary/ghost, never accent); no auto-save on blur; no optimistic row mutation — the server action's typed result is what updates the view (§4.11). A component row is **multi-field**, so `Cmd`/`Ctrl+Enter` is its save key; `Esc` cancels and restores; focus returns to the edited row on save and to the opening control on cancel; one row editable at a time.

On any status other than `DRAFT` the panel renders pm53's read-only variant — **plain text, no disabled inputs, no greyed controls** — so "not editable now" never looks like "broken".

### D7. Warnings never block; this banner always does

The not-yet-billable warnings are pm55's (O10) and are warning-tinted, inline under the component row, non-blocking. The **backdating** warning (within 3 days) keeps pm38's treatment and copy; beyond tolerance it stays a `FieldError`. The "This creates a new draft" warning still appears when the target version is `ACTIVE`. None of these share the banner's danger treatment, and the banner never borrows theirs (§1.19).

### D8. No search param, no route, no permission, no action file

Component type is never a URL filter (§3.2). The update adds no page, segment, route or permission (§3.12, architecture §4); authoring a component is ordinary `products : EDIT` DRAFT price editing. No action file is added and `EXPECTED_PRODUCT_ACTION_FILES` is unchanged (§3.7). If this unit finds itself creating any of these, it has left scope.

### D9. Derived envelope fields never reach the form either

The form collects `params` and the row columns. It never asks for, displays or echoes `specVersion`, `plaSpecId`, `appliesAt`, `basis`, `boundTo` or the raw `@type` (§4.21) — those are fixed per branch by pm47's schema and are the schema's business. A "component type" label in the UI is always the badge label, never the literal.

### D10. The query budget holds after a write

Manage Products' first render still issues one families query plus its count and no per-row detail query; selecting a family still issues four; a component write adds none (§3.14). `revalidatePath` on both product paths remains the success path — not `router.refresh()` (§3.8).

---

## Implementation

### I1. `components/products/manage/component-type-picker.tsx` (new, client leaf)

Four options, badge label + one line of help each, from a **total** `Record<ComponentType, { label; help }>` so a new type is a compile error. No accent-filled treatment (§4.9). Selecting a type resets the branch fields; changing type after entering values prompts before discarding (the panel's one-row-at-a-time rule already covers the dirty case).

### I2. `components/products/manage/price-form.tsx`

Restructure as: `currency` → picker → branch sub-form → `start_date_time`. Implement the two branches of D2 against pm47's `price-input.schema.ts` union (§2.8), so an impossible field combination is untypeable rather than merely rejected. Wire field-level errors from the schema; wire the backdating warning and the "creates a new draft" warning unchanged.

### I3. `components/products/manage/offering-component-error-banner.tsx` (new)

D4's banner: one total map from `OfferingComponentViolation` to copy, danger role, `alert-triangle`, badge labels for the named components, and the Save-disabled contract expressed as a prop the panel honours. It takes the **action result** as input; it has no validation logic of its own.

### I4. `components/products/manage/manage-prices-panel.tsx`

Host the banner at the top of the panel (server component, D5). Render pm53's read-only component rendering for every non-`DRAFT` status. Pass the action result down; keep the panel's layout, empty state ("at least one price is required to submit for testing") and grid position unchanged.

### I5. `components/products/manage/editable-prices.tsx`

Branch switching, Save/Cancel wiring to pm49's three actions, pm41's keyboard contract with `Cmd`/`Ctrl+Enter` for the multi-field row. No optimistic mutation.

### I6. Tests

1. **Authoring happy paths.** A user adds a `usage_rate` (`EA`, `"100"`, optional card name) and a `recurring` `flat_fee` (`"2000.00"`, 1/`months`) on a DRAFT; both appear with pm53's badges after the action resolves.
2. **Field visibility (D1).** `usage_rate` shows unit and hides the period pair; `flat_fee` hides unit, shows the period pair only when `recurring`; nothing is rendered disabled instead of hidden.
3. **Banner (D4).** A second currency on the offering raises `CURRENCY_MISMATCH`, the banner names both currencies, and **Save is disabled** while it shows. Same for the other two codes (the `MODIFIER_WITHOUT_BASE_RATE` case is exercised via a `capacity_commitment` payload even though its sub-form lands at pm55 — the action and the banner are both live here).
4. **Server-driven (D4/§3.13).** The banner does not appear until the action returns; a client-side state change alone never raises or clears it. Assert there is no client-side VI3–VI5 evaluation at all.
5. **Read-only on non-DRAFT (D6).** The same version at `TESTING` renders read-only with **no disabled controls** and no Save.
6. **Keyboard contract (D6).** `Esc` restores, `Cmd`/`Ctrl+Enter` saves the multi-field row, focus returns correctly, one row at a time.
7. **`rateCardLookUp` (D3).** Free text, optional, mono, no autocomplete, no network call — assert no fetch is issued when it is filled.
8. **Boundaries.** No new search param appears in the URL after authoring; no new action file; the three client leaves are the only `'use client'` additions; `ManagePricesPanel` is still a server component.
9. **Authz.** `products : READ` sees no authoring affordance; `EDIT` does; page guards unchanged.
10. **Query budget (D10).** First render and post-write render both hold their budgets.

### I7. The G-E close-out — this unit's largest deliverable after the UI

1. `tsc --noEmit`, ESLint, Prettier and the **full test suite** green on a database built from scratch.
2. Orders, Subscriptions, View Product and every Administration route green and unchanged.
3. The rating and bill-run flows green (pm51, pm52's runs re-verified on the assembled branch, not just in their own units).
4. The pm46–pm54 branch merges to `main` as **one commit**. No unit inside the window merged alone.
5. Record in the merge commit which units it contains and that the green claim is made here.

### I8. Documentation

1. `prodmgmt-code-standards.md` §7 file tree — mark `component-type-picker.tsx` and `offering-component-error-banner.tsx` as landed under **pm54** (correcting the stale pm51 markers if pm53 did not already).
2. `prodmgmt-ui-context.md` §7 — confirm the shipped picker, field-visibility table and banner copy match; correct any divergence in the same change set.
3. Record the G-E close-out: the window was pm46–pm54, the claim was made here, and code-standards §6.22 (corrected at pm46) agrees.

---

## Dependencies

**Packages to install: none.** Existing form primitives, `components/ui/` vendor layer (composed, never edited), pm53's badge, pm47's schemas, `vitest` + Testing Library.

**Commands used:** `npm run test`, `npx tsc --noEmit`, `npm run lint`, `npm run db:migrate`, `npm run db:seed-demo`, plus the rating and bill-run flow runs for I7.3.

---

## Verification checklist

Authoring

- [ ] A user authors a `usage_rate` and a `flat_fee` inline on a DRAFT through the picker; both appear with pm53's badges.
- [ ] The picker offers exactly four types; `negotiated_override` never appears, disabled or otherwise.
- [ ] Per-branch field visibility matches D1 exactly; inapplicable fields are **hidden, not disabled**.
- [ ] `flat_fee`'s period pair is revealed by the envelope `priceType`, not the other way round.
- [ ] `rateCardLookUp` is free text, optional, mono, with no autocomplete and no network call.
- [ ] Derived envelope fields are never collected, shown or echoed.

The banner

- [ ] All three violation codes render their D4 copy, naming components by badge label and stating the missing counterpart.
- [ ] Save is disabled while the banner is present.
- [ ] The banner renders **only** from the server result; no client-side VI3–VI5 evaluation exists anywhere.
- [ ] It uses the danger role, not the warning tint, and is not a `FieldError`.

Panel behaviour

- [ ] A non-`DRAFT` version renders read-only with no disabled controls and no Save.
- [ ] pm41's keyboard contract holds, with `Cmd`/`Ctrl+Enter` as the multi-field save.
- [ ] Warnings (backdating, "creates a new draft") still render in their own treatment and never block.
- [ ] `ManagePricesPanel` is still a server component; exactly three client leaves exist across pm54 + pm55.

Boundaries

- [ ] No search param, route, page, segment, permission or action file added; `EXPECTED_PRODUCT_ACTION_FILES` unchanged.
- [ ] Query budget holds on first render and after a component write.
- [ ] `components/ui/` untouched; no View Product file edited (Inv. #29, guardrail 11 green).

**G-E close-out**

- [ ] `tsc --noEmit`, ESLint, Prettier and the **full test suite** green on a database built from scratch.
- [ ] Orders, Subscriptions, View Product and every Administration route green and unchanged.
- [ ] The rating and bill-run flows green on the assembled branch.
- [ ] pm46–pm54 merged to `main` as **one commit**, with the contained units named in the message.
- [ ] Code-standards §6.22 and the build plan both record the window as pm46–pm54, claimed here.

**Definition of done:** a Billing Ops user adds a usage rate and a monthly fee to a draft without ever seeing a JSON field — and when they try to price that offering in a second currency, the panel tells them which currency the offering already uses and refuses to save, because the server said so.
