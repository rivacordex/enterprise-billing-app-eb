# pm56b — Ordering-wizard PriceCard re-key (New Order Wizard price overrides)

**Unit:** pm56b (Part 4 follow-up; the production-code half of the residue cleanup the pm56 ship gate named but could not fix). **Boundary:** `components/products/ordering/**` and its own tests only — the New Order Wizard's price-override rendering chain. **This is a cross-module reach into the ordering surface (§3.2/§6.5) and needs a fresh, written G-G grant before any file is opened** — exactly as pm50 (`order-preconditions.ts`) and pm51 (`rp.py`) did. It is **not** covered by any grant consumed to date.
**Specs from:** `pm00-build-plan.md` Part 4 hand-off register ("Unresolved — ordering-wizard chain, found at pm56, not owned by any pm46–pm55 unit") and gate table (G-G) · pm56 evidence table + "New finding #1" (`prodmgmt-progress-tracker.md`) · `prodmgmt-ai-workflow-rules.md` §0.6 (G-E), §3.2 (the G-G precedent), §5 (stop-and-ask on data shape), §6.5, §6.9 · `prodmgmt-architecture.md` Inv. #16/#38/#39 (the override is frozen; `priceType` ≠ `price_type`) · `pricing-component.schema.ts` (the envelope) · PC9/PC13 and open item **O2**.
**Depends on:** pm46–pm55 (the reshape) and **a fresh G-G grant** (granted 2026-09-25). The two D2 shape questions were resolved without a new product decision (see D2 Resolution). Independent of pm56a; guardrail 31 turns fully green only once **both** land (both landed 2026-09-25).

---

## Goal

Re-key the four New Order Wizard files that still read the deleted `PriceCard.pricingModel` / `.priceType` / `.amount` scalars and import the deleted `PriceType` type, so the wizard's price-override UI reads the pm47 envelope, `npm run typecheck` passes repo-wide, and guardrail 31's last four offenders (the only production residue) are gone.

---

## Design

### D1. The break is real, not documentation lag

`components/products/ordering/{new-order-wizard,override-price-fields,wizard-step-offer,wizard-form-types}.{ts,tsx}` are the four production files in pm56's `tsc`-error set (11 of its errors — the never-owned New Order Wizard chain). Concretely: `wizard-form-types.ts:1,14` imports `PriceType` and shapes overrides as `{ priceType: PriceType; amount: string }[]`; `override-price-fields.tsx` reads `price.pricingModel === "tiered"` (`:47`), keys the override by `price.priceType` (`:60`), and renders `price.amount` (`:77`). All four scalars were dropped at pm47; `PriceCard` now carries `componentType` + a `price_component` envelope. Flagged as deferred since pm47 ("eight out-of-boundary consumer files, left red by design under G-E"), restated at pm53/54/55, never assigned a unit — this is that unit.

### D2. Two shape questions — resolved 2026-09-25 (see D2 Resolution below)

This is not a mechanical rename; the catalog moved to the envelope while the override table stayed scalar (Inv. #16/#39 — `order_item_price_override` is frozen: one row per `(order_item, price_type)`, scalar `amount` + `currency`, and O2 defers `once` → `oneTime`, so `price_type` vocabulary survives there). Two decisions the plan does not settle and pm56b must not invent:

1. **Which component types are overridable at order time**, and what replaces the old `pricingModel === "tiered"` skip. The wizard previously skipped tiered prices; the envelope has five branches (`usage_rate` / `flat_fee` / `capacity_commitment` / `capacity_motivation` / `negotiated_override`). Which are user-overridable on a standard order — and how a `flat_fee`'s `recurring`/`oneTime` split maps onto the override's single `price_type` — is a product question (relates to O6: whether an order-item override becomes the base rate the capacity modifiers compute against, owned by the bill-run phase).
2. **How the display amount and the override `price_type` derive from the envelope** — `usage_rate.params.ratePerUnit`, `flat_fee.params.amount`, capacity quantities are different scalars; the override captures one negotiated `amount`. The mapping from `component.priceType` (envelope) to the override row's `price_type` (frozen column) must be explicit and must not conflate the two axes (Inv. #38).

Both are §5 "never guess on data shape / price effectivity" items — one precise question each, options attached, answered and recorded here before code.

### D2 Resolution (2026-09-25)

Both questions were resolved **without a new product decision**: pm50 (`services/ordering/order-preconditions.ts`, under its own G-G) already ships the authoritative, total, Inv.-#38-respecting translation `OVERRIDE_TARGET_BY_PRICE_TYPE` (`usage`→`usage_rate`; `recurring`→`flat_fee`/`recurring`; `once`→`flat_fee`/`oneTime`), so the wizard mirrors its inverse rather than inventing a mapping (§5.4).

- **D2.1 — overridable set.** Only `usage_rate` and `flat_fee` are overridable (the three lanes in pm50's map); `capacity_commitment`/`capacity_motivation` are **not** (a quantity/step shape has no scalar to negotiate, Inv. #16) — this replaces the old `pricingModel === "tiered"` skip. **Additionally, a lane carrying more than one _current_ price is ambiguous and is offered read-only:** two `usage_rate` rows in different units both map to the `usage` lane, but a negotiated override targets a single scalar row and `create-order.schema` allows at most one override per `price_type`, so **only a lane with exactly one current price seeds/renders a slot**. Implemented as `overridableLanes()` in `components/products/ordering/price-override.ts` (added by the 2026-09-25 pm56b review-fix).
- **D2.2 — envelope → override mapping.** `overrideLaneOf(price)` derives the lane on the ordering module's own `OverridePriceType` axis, never the deleted catalog `PriceType` (Inv. #38): `usage_rate`→`usage`, `flat_fee`→`recurring`/`once` per its envelope `priceType`. The struck list amount comes from `overrideListAmount(price)` (`usage_rate.params.ratePerUnit` / `flat_fee.params.amount`); the offer-step price list reuses the shared `renderPriceAmount` (§2.16, no second copy).

**G-G grant:** granted **2026-09-25 (Khek)**, naming `components/products/ordering/{new-order-wizard,override-price-fields,wizard-step-offer,wizard-form-types}.{ts,tsx}` + `tests/components/new-order-wizard.test.tsx` — recorded in `pm00-build-plan.md`'s Part 4 gate table (G-G row).

### D3. The override table is not reshaped

Whatever the D2 answers, Inv. #16/#39 hold: this unit changes no schema, adds no `update*`/`delete*` to the override repository, adds no `%cycle%`/`%frequency%` column, and does not reshape `order_item_price_override`. It re-keys the **reader** (the wizard) onto the envelope, not the **stored shape**.

### D4. Boundary discipline

`components/products/ordering/**` + `tests/components/new-order-wizard.test.tsx` (and any other ordering-wizard test carrying the old `PriceCard` fixture). No `services/ordering/**`, no `validation/ordering/**`, no schema — if the re-key appears to need one, stop: it means a shape question (D2) is unanswered or a different unit's defect is in the way. The product-module fixtures are **pm56a**; the non-ordering fixtures are theirs.

---

## Implementation (after G-G + D2 answers)

1. `wizard-form-types.ts` — drop the `PriceType` import; reshape `overrides` to the decided key (D2.2).
2. `override-price-fields.tsx` — replace the `pricingModel === "tiered"` skip with the decided overridable-type rule (D2.1); read the display amount and override key from the envelope (D2.2) via the shared read-only amount helper (`components/products/price-amount.tsx`, pm53/pm54) rather than a second copy.
3. `wizard-step-offer.tsx` / `new-order-wizard.tsx` — re-key the effect that seeds the per-price override list and any other dropped-scalar read.
4. Update `tests/components/new-order-wizard.test.tsx` (and siblings) to the envelope `PriceCard` fixture.

---

## Verification checklist

- [x] Fresh **G-G** grant recorded (gate table G-G row + D2 Resolution above), naming these exact files, granted 2026-09-25 (Khek).
- [x] The two D2 questions resolved and recorded (D2 Resolution above) before code.
- [x] `npx tsc --noEmit` — the four ordering-wizard files are gone from the error set; combined with pm56a, the repo-wide count is **0** (the G-E close-out's typecheck half).
- [x] Guardrail 31 (`pricing-component-guardrails.test.ts`) is **green** — no offenders, production or test.
- [x] `tests/components/new-order-wizard.test.tsx` and the adjacent wizard component suites green; the override submit shape (`{priceType: OverridePriceType, amount}`) and the create-order contract are unchanged, so pm29's order-placement flow is preserved.
- [x] `eslint` / `prettier --check` clean; no schema/migration/service/repository/override-table change (`components/products/ordering/**` + its test only).
- [x] Inv. #16/#38/#39 re-confirmed: override table unchanged, no `update*`/`delete*` added, `priceType`/`price_type` not conflated.

**Definition of done:** the New Order Wizard reads the envelope, `npm run typecheck` passes repo-wide, and guardrail 31 is green — with the override table frozen and the two shape decisions recorded, not guessed. Landing pm56b is what turns "guardrail 31 fails as literally specified" (pm56 Definition-of-Done item 5) into true.
