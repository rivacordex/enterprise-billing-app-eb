# pm50 — Ordering: override-target re-key (cross-module, G-G)

**Unit:** pm50 (Part 4). **Boundary:** `services/ordering/order-preconditions.ts`, the contract comments in `validation/ordering/create-order.schema.ts`, and four ordering test fixtures. **A re-key and nothing else** — no ordering behaviour is renegotiated, no ordering schema is touched, and `ordering.order_item_price_override` is not reshaped.
**Specs from:** `prodmgmt-architecture.md` §3.7 (reader inventory row 3), Inv. #16, #38, #39 · `prodmgmt-code-standards.md` §1.29, §1.34, §6.21, Appendix A row **A9** · `prodmgmt-ai-workflow-rules.md` §3.2, §6.5, §8.13, Appendix A row **W4** · `_updatemodule-product-pricing-components-plan.md` **PC9**, PC13, O2 · `pm00-build-plan.md` Part 4 › the cross-runtime decision (2026-09-21).
**Depends on:** **pm49** (the component write path and read model this resolves against) · **G-G authorization naming these files**.

**Gate G-G — required before a line is written.** Workflow §3.2 and §6.5 forbid this update to touch `ordering/**`; the cross-runtime decision authorizes the crossing *in principle* and makes it this unit. **That is not the authorization.** Before starting, obtain and record a written authorization naming exactly:

- `services/ordering/order-preconditions.ts`
- `validation/ordering/create-order.schema.ts` (comments only)
- `tests/db/create-order.integration.test.ts`, `tests/db/review-order.integration.test.ts`, `tests/db/ordering-read.integration.test.ts`, `tests/db/subscription-lifecycle.integration.test.ts`

and stating that the crossing is a re-key with no behaviour change. Record it in code-standards Appendix A row A9 and workflow Appendix A row W4 in the same change set. A crossing wider than this list is a new authorization, not an extension of this one.

---

## Goal

Re-key the one line in Ordering that resolves a negotiated override's target price — today `price.priceType === override.priceType && price.pricingModel === "flat"` — onto `component_type`, preserving its semantics exactly, so placing an order against a component-priced offering validates as it did before and the ordering suites are green under the reshaped table.

---

## Design

### D1. What the old line means, stated before it is replaced

`order-preconditions.ts` accepts a negotiated override only when the pinned offering version actually carries a price the override can displace: a price row of the **same legacy `price_type`** as the override (`recurring` / `usage` / `once`) that is a **scalar** (`pricing_model = 'flat'`), because a `tiered` price has no single amount an override could replace. Both properties vanish at pm46, and the re-key must reproduce that meaning — not a tidier version of it.

### D2. The mapping is one-to-one, and `tiered` disappears from the question

| Override `price_type` (ordering column, unchanged) | Old catalog target | New catalog target |
| --- | --- | --- |
| `usage` | `price_type = 'usage'` **and** `pricing_model = 'flat'` | `component_type = 'usage_rate'` |
| `recurring` | `price_type = 'recurring'` **and** `pricing_model = 'flat'` | `component_type = 'flat_fee'` **and** envelope `priceType = 'recurring'` |
| `once` | `price_type = 'once'` **and** `pricing_model = 'flat'` | `component_type = 'flat_fee'` **and** envelope `priceType = 'oneTime'` |

Two facts make this exact rather than approximate:

- **The `flat` half is now structural.** Every persistable component is scalar-priced or is a modifier; `tiered` no longer exists (PC8). `usage_rate` and `flat_fee` are precisely the components an override can displace, and the two capacity modifiers are precisely the ones it cannot — so the `pricing_model = 'flat'` clause is replaced by *which component types are in the mapping at all*, not by a second predicate.
- **The capacity modifiers must not become override targets.** A `capacity_commitment` or `capacity_motivation` is never a valid target: an override replaces a rate, not a floor or a schedule. Whether an override displaces the base rate the modifiers compute against is **O6, a bill-run open item** — and this unit must not answer it (workflow §5.2).

### D3. This is where the two `price_type` axes touch, and they still do not merge

The override's `price_type` column keeps the **legacy** vocabulary (`recurring` / `usage` / `once`); the envelope's `priceType` uses the **TMF** vocabulary (`recurring` / `oneTime` / `usage` / `discount` / `commitment`). `once` vs `oneTime` is the visible seam, and **O2 (the rename) is deferred** — two vocabularies coexist, which is exactly why Inv. #38 exists.

So the mapping in D2 is written as one explicit, total lookup — a `Record<OverridePriceType, { componentType; envelopePriceType? }>` — with a comment stating that it is a **translation between two axes, not an equivalence**, and that nothing may derive one from the other anywhere else (§1.23, Inv. #38). A `toLowerCase()`-style coincidence match (`'once'.startsWith('one')`) is a defect even if it passes today.

### D4. `ordering.order_item_price_override` is not reshaped — and that is asserted

One row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`, its repository exporting `insertOverride` + finders and **no `update*`/`delete*`** (PC9, Inv. #16, #39). No column changes, no CHECK changes, no `once` → `oneTime` rename, no envelope stored there. The existing exported-surface guardrail (`tests/db/ordering-repository-exports.test.ts`) and guardrail 34 both assert it; this unit runs them and reports, it does not edit them.

### D5. The DB CHECK the schema comments mirror is on the *ordering* table and is unchanged

`create-order.schema.ts`'s comments describe the override contract, including "the pinned offering as `pricing_model = flat`". Only the **comment text** changes, to describe the component-type targets. `order_item_price_override_price_type_check` is on the ordering table, still enforces `recurring/usage/once`, and is untouched — say so in the comment, so the next reader does not go looking for a CHECK that moved.

### D6. Fixtures are repaired, not rewritten

Four ordering suites seed catalog prices in the old shape. They are updated to seed components — a `usage_rate` where they seeded a flat usage price, a `recurring` `flat_fee` where they seeded a flat recurring one — with **the same amounts, units, currencies and start dates**, so the assertions they make about orders and subscriptions are unchanged. If an assertion has to change to stay green, that is a behaviour change and it needs raising, not absorbing (§1.34: this is a re-key, not a renegotiation).

`tests/db/ordering-inventory.integration.test.ts` and `ordering-repository-exports.test.ts` are on the sweep list too: check them, and if they carry no price shape, record that they needed no edit.

### D7. Nothing else in Ordering is touched

Not `db/schema/ordering.ts`, not the order/subscription services, not the repositories, not the components, not the Orders or Subscriptions pages, not the `create-order` validation rules themselves (only their comments). A precondition code list stays byte-identical: `OVERRIDE_PRICE_TYPE_INVALID` still fires for the same situations and keeps its name — renaming it would ripple into UI copy for no gain.

---

## Implementation

### I1. `services/ordering/order-preconditions.ts`

1. Add D3's explicit total mapping from the override's legacy `price_type` to `{ componentType, envelopePriceType? }`, with the two-axes comment.
2. Replace the target-existence predicate with: a price on the pinned version whose `componentType` equals the mapped component type **and**, for the two `flat_fee` cases, whose envelope `priceType` equals the mapped envelope value.
3. Read the envelope `priceType` from the already-parsed `component` on the read model (pm49 D2) — do not re-parse JSON here, and do not read the row's charge-period columns to infer `recurring` vs `oneTime` (§4.18: a `flat_fee` with no period is `oneTime`, not a broken recurring price).
4. `OVERRIDE_PRICE_TYPE_INVALID` and `OVERRIDE_CURRENCY_MISMATCH` keep their names, their order and their conditions. The currency check is untouched — it compares the override's currency to the BAN's, and VI5 is a catalog rule that does not reach here.
5. The capacity modifiers are absent from the mapping, so an override naming one can never resolve — add a one-line comment saying that is deliberate and that O6 is the open question, so nobody "completes" the mapping later.

### I2. `validation/ordering/create-order.schema.ts`

Comment-only edit: the override contract now reads "the pinned offering carries a matching `usage_rate` / `flat_fee` component", with D5's note that the `price_type` CHECK on the ordering table is unchanged and that `once` ≠ `oneTime` is a deliberate two-axis seam (O2 deferred). No schema rule, field, refinement or message changes.

### I3. Fixtures

Repair the four suites per D6. Keep each fixture's amounts and dates; change only the shape of the seeded price rows. Where a suite seeded a `tiered` price to exercise the "not a valid override target" path, seed a `capacity_motivation` instead — it is the new shape that is legitimately not an override target, and it keeps that test's intent alive rather than deleting the case.

### I4. Tests to add (small, and inside the ordering suites)

- An order against a component-priced offering with a `usage` override resolves its target and validates.
- The same with a `recurring` override against a `recurring` `flat_fee`, and a `once` override against a `oneTime` `flat_fee`.
- An override naming a `price_type` whose component is absent → `OVERRIDE_PRICE_TYPE_INVALID`.
- An offering carrying **only** capacity modifiers plus a `usage_rate`: a `recurring` override is refused (no `flat_fee`), a `usage` override is accepted.
- A second override for the same `(order_item, price_type)` is still refused, and the override row is still insert-only.

### I5. Documentation

1. `prodmgmt-code-standards.md` §1.34 — rewrite from "stop and get the re-key authorized" to the recorded outcome: authorized on `<date>`, delivered by pm50, no compatibility shim.
2. `prodmgmt-code-standards.md` Appendix A row **A9** — clear by grep, recording the authorization and its date.
3. `prodmgmt-ai-workflow-rules.md` Appendix A row **W4** — same.
4. `prodmgmt-architecture.md` §3.7 — mark the `order-preconditions.ts` row as re-keyed by pm50; leave the two runtime rows open until pm51/pm52.
5. **No `ordering`-module doc is edited** — cross-module doc edits need their own approval (workflow §7.9). The re-key is recorded in this module's docs and in the hand-off register.

---

## Dependencies

**Packages to install: none.**

**Commands used:** `npm run test`, `npm run db:migrate`, `npm run db:seed-demo`, `npx tsc --noEmit`, `npm run lint`.

**Prerequisite:** the recorded **G-G authorization** naming the six files above.

---

## Verification checklist

Authorization

- [ ] The G-G authorization exists in writing, names exactly the files touched, and is recorded in Appendix A rows A9 and W4.
- [ ] `git diff --stat` touches no ordering file outside that list.

Behaviour (unchanged, proved)

- [ ] A negotiated `usage` override resolves against a `usage_rate`; `recurring` against a `recurring` `flat_fee`; `once` against a `oneTime` `flat_fee`.
- [ ] An override with no matching component is refused with the unchanged `OVERRIDE_PRICE_TYPE_INVALID`; the currency check is unchanged.
- [ ] A capacity modifier is never a valid override target, and no code path attempts O6's question.
- [ ] `once` is never derived from, mapped onto, or compared textually with `oneTime` — the translation is one explicit total lookup.
- [ ] The four ordering suites are green with unchanged assertions; any assertion that had to change is raised, not absorbed.

The override table

- [ ] `ordering.order_item_price_override` is byte-identical: one row per `(order_item, price_type)`, insert-only, scalar `amount` + `currency`.
- [ ] Its repository still exports `insertOverride` + finders only — asserted by the exported-surface guardrail (guardrail 34).
- [ ] No `once` → `oneTime` rename was performed anywhere (O2 still deferred).

Boundaries

- [ ] No ordering schema, migration, repository, service (other than the one precondition), component or page changed.
- [ ] No compatibility shim, no dual read of `amount`, no re-parse of the envelope in ordering code.
- [ ] `tsc --noEmit`, ESLint and Prettier clean for this unit's files; repo-wide green remains pm54's claim (G-E).

**Definition of done:** RevOps places an order with a negotiated price against an offering that is now priced in components, and the system validates the override exactly as it did before the reshape — while the ordering table that stores that negotiated price is provably untouched, and the two `price_type` vocabularies are translated in one place that says out loud that they are not the same thing.
