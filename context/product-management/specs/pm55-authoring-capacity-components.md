# pm55 — Authoring: the two capacity components and the `steps[]` editor

**Unit:** pm55 (Part 4). **Boundary:** `components/products/manage/capacity-motivation-steps-editor.tsx` (new), the two capacity branches in `price-form.tsx`, the not-yet-billable warnings in `manage-prices-panel.tsx` / `editable-prices.tsx`, and their tests. No schema, no repository, no service, no action file, no route.
**Specs from:** `prodmgmt-ui-context.md` §7 (component picker, steps editor), §4 (not-yet-billable warnings), §5 · `prodmgmt-code-standards.md` §1.19, §2.2, §2.8, §4.8, §4.14, §4.15, §4.20, §4.21, §3.6 · `prodmgmt-architecture.md` §3.3, §7, Inv. #33, #42, #43 · `_updatemodule-product-pricing-components-plan.md` VI1, VI2, **O10**, H2 · `prodmgmt-ai-workflow-rules.md` §4.3, §8.8.
**Depends on:** **pm54** (the picker, the branch structure and the blocking banner this plugs into).

**pm55 merges independently.** The G-E window closed at pm54, so this unit lands on `main` on its own, green.

---

## Goal

Complete the authoring surface: the `capacity_commitment` branch, the `capacity_motivation` branch with a proper add/remove `steps[]` editor kept in ascending order by the form, and the three non-blocking not-yet-billable warnings — so a user can author the plan's worked scenario end to end on a DRAFT and be told plainly that the bill run cannot charge for it yet.

---

## Design

### D1. `capacity_commitment` is one number, and the form says what it means

One field: `committedQuantity`, a finite number `> 0` (VI2), `tabular-nums`, with the row-level `unit_of_measure` above the branch supplying its unit (ui-context §7). The help text states the effect in the domain's words — *the customer is billed for at least this quantity, even when they use less* — because "committed quantity" alone does not say that a floor is being set.

No currency field appears **inside** the branch: the component carries no money (ui-context §2/§4). `currency` is still collected at row level, as every component shares it (PC3/VI5).

### D2. The `steps[]` editor is a row list, never a JSON field

`CapacityMotivationStepsEditor` (the name is binding, §4.8) — an add/remove row list, each row a threshold (`aboveQuantity`, number, `tabular-nums`) and a rate (`ratePerUnit`, decimal string). **Never a free-text JSON field** (§4.20, ui-context §7). At least one row; removing the last row is refused with a field-level message, not by disabling the control silently.

Two behaviours the spec fixes because they are where this component will otherwise drift:

- **The form keeps the rows in ascending order.** A threshold entered out of order is reordered by the form on commit of that row — not rejected, not left for the server. This is a convenience over VI1, not a substitute for it.
- **A duplicate threshold is refused before the server sees it**, as a field-level error on the offending row naming the duplicated value. VI1 still refuses it at Zod and pm46's CHECK still refuses it at the database; the client check exists so a user is not made to round-trip for a typo. **This is the one client-side pre-check this update allows**, and it is allowed because VI1 is a *within-component* rule — it reads nothing but this component's own rows. The cross-component rules (VI3–VI5) remain server-only (§3.13), and nothing here may be extended to evaluate them.

### D3. The rendered preview is the read-only text, not a second design

While editing, the row's summary reads in pm53's format — `base 100; above 1000: 50; above 2000: 25` — with the base rate drawn from the offering's same-unit `usage_rate` when one exists. No table, no chart, no per-band cards (ui-context §2/§4). If no base rate exists yet, show the steps alone; pm54's banner is what explains the problem, and it will already be on screen.

### D4. The four not-yet-billable warnings — warning only, never blocking (O10)

Warning treatment (`--bg-warning` / `--text-warning`), inline **under the component row**, visually distinct from pm54's danger banner, and **none of them blocks the save** (§1.19, §4.14):

| Trigger | Copy |
| --- | --- |
| a `capacity_commitment` on the version | *"Bill run does not apply a capacity commitment yet — this component is stored but not billed."* |
| a `capacity_motivation` on the version | *"Bill run does not apply a capacity motivation yet — usage bills at the base rate until then."* |
| a `usage_rate` carrying a `rateCardLookUp` | *"No rate card exists yet — `<name>` falls back to the rate per unit."* |
| a `capacity_commitment` or `capacity_motivation` whose `unit_of_measure` is `Mbps` (D5) | *"A capacity component in Mbps has no agreed basis yet; confirm what the committed quantity means before this version goes live."* |

These are the **only four** surviving warning copies; the two tiered ones retire with `pricing_model`. The copy is exact — it is the module's declared statement of a known gap (architecture §7), and paraphrasing it would understate what the user is committing to.

**The third warning attaches to a `usage_rate`, not to a capacity component**, so it is live for offerings that carry no capacity component at all. It belongs to this unit because this is where the warning mechanism lands, but it renders wherever a non-null `rateCardLookUp` is authored — including on a `usage_rate` created at pm54.

### D5. The `Mbps` basis warning ships — DECIDED (Khek, 2026-09-21)

ui-context §4 raises a fourth case: the capacity components are **quantity**-based, but `Mbps` is a rate, so a commitment or motivation in `Mbps` has no stated basis (per month? per peak sample?). No unit owned it until now.

**Decision: ship it** (option A of the two considered; omitting it was rejected). The warning renders whenever a capacity component's `unit_of_measure` is `Mbps`, in the same non-blocking warning treatment as the other three — the unit list is closed, no rule forbids the combination, and blocking a legal combination over an unmodelled question would be a validation rule masquerading as a warning (§1.19). It costs one conditional and makes a known modelling gap visible at the moment someone creates it.

It is a **placeholder for H2**, not an answer to it: the real fix is a stated basis, owned by the rating phase that introduces rate-based billing. Record that in the hand-off register against H2 (I5.3), so the warning is replaced rather than accumulated when the basis is modelled. ui-context §4 already describes this case and needs no change — confirm it matches what ships.

### D6. Adding a modifier with no base rate is pm54's banner, not a new mechanism

`MODIFIER_WITHOUT_BASE_RATE` already exists, is already returned by pm49's validator and is already rendered by pm54's banner with the unit named. This unit adds **no** new refusal path: it makes the case reachable through the UI for the first time, and tests it end to end. The picker may disable a capacity branch when the offering has no `usage_rate` at all, as a convenience — the authoritative refusal stays the action's code (§3.13).

### D7. The client-leaf budget is now spent

Three client leaves across pm54 + pm55: the picker, the component sub-form, and this unit's steps editor (§3.6). That is the whole allowance. `ManagePricesPanel` stays a server component; the steps editor is a leaf inside the existing client sub-form, not a fourth `'use client'` boundary.

### D8. pm41's editing contract is unchanged, and a steps row is not a panel row

The component row is multi-field, so `Cmd`/`Ctrl+Enter` saves it and `Esc` cancels and restores the whole component — **including all step rows**, which is the case most likely to be got wrong: cancelling after adding three steps must restore the component as it was, not leave the added rows behind. Adding or removing a step row is an edit *within* the open component row, not a separate save; there is no per-step Save button. One panel row stays editable at a time.

---

## Implementation

### I1. `components/products/manage/capacity-motivation-steps-editor.tsx` (new, client leaf)

The D2 row list: add / remove, threshold + rate per row, ascending-on-commit ordering, duplicate-threshold field error, minimum one row. `tabular-nums` on both numeric columns; rate collected as a decimal string and never parsed to a number in the client (§4.5, §1.24). Row-level remove is an icon button with an `aria-label`; the list has an accessible name; keyboard reachable in order.

### I2. `price-form.tsx` — the two capacity branches

`capacity_commitment`: one numeric field plus D1's help text. `capacity_motivation`: the steps editor. Both require `unit_of_measure` at row level and hide the recurring-period pair (pm54 D1's table). Both validate against pm47's `price-input.schema.ts` branches, so an impossible combination is untypeable (§2.8).

### I3. The warnings

Render D4's four copies inline under the component row, in the warning treatment, non-blocking, keyed to what the version actually carries. Put the copy strings in one place beside the component's other copy — not inlined at four call sites — so a future wording change is one edit and the "exactly four copies" rule stays checkable.

### I4. Tests

1. **The worked scenario end to end.** On a DRAFT: author a `usage_rate` `"100"` `EA`, a `capacity_commitment` `1000`, a `capacity_motivation` `[{1000,"50"}]`, then add a second band `{2000,"25"}`; save; all four rows persist and render with pm53's badges and step text.
2. **Warnings show and do not block.** Both capacity warnings appear; Save remains enabled; the save succeeds with the warnings on screen.
3. **The rate-card warning** appears for a `usage_rate` with a `rateCardLookUp` and not for one without.
4. **The `Mbps` basis warning (D5)** appears for a capacity component whose unit is `Mbps`, blocks nothing, and does not appear for `EA`, `GB` or `MB`.
5. **Steps ordering and duplicates.** Steps entered out of order are reordered by the form; a duplicate threshold is refused client-side with a field error **and**, when forced past the client, by Zod and by the DB CHECK — assert all three layers so the client check is never mistaken for the guard.
6. **`committedQuantity`** of `0`, `-1` and a non-numeric entry are refused; a decimal-string entry is refused (it is a number, §1.24).
7. **Blocking banner reachable through the UI (D6).** Adding a `capacity_commitment` in `EA` to an offering with no `EA` `usage_rate` raises pm54's banner naming `EA`, and Save is disabled — the refusal coming from the action, not from client state.
8. **Cancel restores everything (D8).** Adding three step rows then pressing `Esc` restores the component exactly as it was.
9. **Read-only on non-DRAFT.** A `TESTING` version renders the capacity components read-only with no disabled controls and no steps editor.
10. **Client-leaf count.** Exactly three `'use client'` leaves across pm54 + pm55; `ManagePricesPanel` is still a server component.
11. **No derived envelope field** is collected or shown (§4.21); no `plaSpecId` input exists even though `capacity_motivation` has a non-null one.

### I5. Documentation

1. `prodmgmt-code-standards.md` §7 file tree — mark `capacity-motivation-steps-editor.tsx` landed under **pm55** (correcting the stale pm52 marker if it survived pm53).
2. `prodmgmt-ui-context.md` §4 — confirm all four warning copies match exactly what ships, including the `Mbps` case.
3. `pm00-build-plan.md` hand-off register — record against **H2** that the `Mbps` basis warning shipped as a placeholder (decided 2026-09-21), to be replaced when a basis is modelled; record that O10 is delivered here.

---

## Dependencies

**Packages to install: none.** Existing form primitives and the `components/ui/` vendor layer (composed, never edited); no drag-and-drop library, no table library, no JSON editor — the steps list is a plain row list and reordering is by value, not by drag (a drag handle would be a new interaction pattern this module does not have).

**Commands used:** `npm run test`, `npx tsc --noEmit`, `npm run lint`, `npm run db:migrate`, `npm run db:seed-demo`.

---

## Verification checklist

Authoring

- [ ] A user authors the worked scenario on a DRAFT — `usage_rate` `"100"` `EA`, `capacity_commitment` `1000`, `capacity_motivation` `[{1000,"50"}]` plus `{2000,"25"}` — saves it, and sees all four components render correctly.
- [ ] `capacity_commitment` collects one number with `tabular-nums` and no currency field inside the branch.
- [ ] The steps editor is an add/remove row list — never a free-text JSON field — with at least one row enforced.
- [ ] Steps entered out of order are reordered by the form; a duplicate threshold is refused client-side, at Zod, and at the database.
- [ ] `committedQuantity` `0`, negative, non-numeric and string-typed entries are refused.

Warnings

- [ ] Both capacity not-yet-billable warnings render inline, in the warning treatment, and **do not block the save**.
- [ ] The absent-rate-card warning renders for a `usage_rate` carrying a `rateCardLookUp`, naming it.
- [ ] The `Mbps` basis warning renders for a capacity component in `Mbps`, blocks nothing, and is recorded against H2 as a placeholder.
- [ ] The copies match the doc exactly; the two tiered warning copies are gone.
- [ ] No warning shares the danger treatment of pm54's banner.

Blocking still comes from the server

- [ ] Adding a capacity component with no same-unit `usage_rate` raises pm54's banner from the action's `MODIFIER_WITHOUT_BASE_RATE`, naming the unit, with Save disabled.
- [ ] The only client-side pre-check anywhere in this unit is the within-component duplicate-threshold check; VI3–VI5 are never evaluated client-side.

Panel behaviour

- [ ] `Esc` restores the whole component including added step rows; `Cmd`/`Ctrl+Enter` saves; one row editable at a time.
- [ ] A `TESTING` version renders read-only with no disabled controls and no steps editor.
- [ ] Exactly three client leaves exist across pm54 + pm55; `ManagePricesPanel` is still a server component.
- [ ] No derived envelope field is collected, displayed or echoed.

Boundaries

- [ ] No schema, repository, service, action file, route, search param or permission added.
- [ ] No rate-card lookup, autocomplete or query exists.
- [ ] No pricing computation runs anywhere in the UI — the step schedule is displayed, never evaluated (Inv. #43).
- [ ] `tsc --noEmit`, ESLint, Prettier and the full suite green; this unit merges to `main` on its own.

**Definition of done:** Billing Ops authors a plan that commits a customer to 1,000 EA at 100 each, drops to 50 above 1,000 and 25 above 2,000 — entering the bands as rows, in any order, without touching JSON — saves it, and is told in plain words that the bill run will not apply those two components yet, without being stopped from saving them.
