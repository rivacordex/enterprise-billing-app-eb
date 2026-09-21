# pm48 — Seeds emit envelopes

**Unit:** pm48 (Part 4). **Boundary:** `db/seeds/**` only — `db/seeds/demo/product-demo.ts`, `db/seeds/sample/seed-billrun-sample.ts`, and a confirmation pass over `db/seeds/product.ts`. Plus the seed-boundary tests. **No repository, service, action, validation, schema or component change** — seeds insert directly through Drizzle, as they do today.
**Specs from:** `prodmgmt-update-overview.md` (In Scope › Seeds; success criterion 1) · `_updatemodule-product-pricing-components-plan.md` PC3, PC14, Seeds & types · `prodmgmt-architecture.md` §2 (folder table), §3.3, Inv. #4, #30, #32, #44 · `prodmgmt-code-standards.md` §1.7, §1.24, §1.25, §6.5, §6.12 · `prodmgmt-ai-workflow-rules.md` §4.5, §8.6.
**Depends on:** **pm47** (the union every seed write parses through), and through it **pm46** (the CHECKs the rows must satisfy).

---

## Goal

Make all three seed sets emit pricing-component envelopes, each write parsed through pm47's union before it reaches the database — so `npm run db:migrate && npm run db:seed-demo` loads a catalog on the reshaped table for the first time since pm46, including one demo offering carrying the full four-component story every later unit needs to render.

---

## Design

### D1. Seeds are held to exactly the same rules as user input

Inv. #4 and §1.7 bind a seed row as tightly as a form submission: the same Zod union, the same CHECK constraints. A seed that bypasses Zod and reaches the database is not "a shortcut for test data", it is the one path that can plant a row the application could never have written. Every price insert in every seed set parses through `persistablePricingComponentSchema` first, and the parsed value — not the literal — is what is inserted, so the seed cannot drift from the schema without failing.

**A deliberately malformed seed must fail twice:** at Zod before the insert, and at the per-`component_type` CHECK if Zod is bypassed. Both halves are asserted (I4) — that pairing is guardrail 32's seed-side evidence.

### D2. `db/seeds/product.ts` is confirmed untouched, and the confirmation is the deliverable

It seeds only the ADMIN `products : DELETE` grant; it has held no catalog row since the demo split. The unit's job here is to **verify and state** that, not to edit it. Say so in the commit message and in the verification checklist, because "all three seed sets" appears in the update overview and a future reader will otherwise assume a third file changed.

### D3. `product-demo.ts` — the `PriceSeed` shape is replaced, not patched

The current fixture type carries `priceType: "recurring" | "usage" | "once"`, `pricingModel: "flat" | "tiered"`, `amount` and `pricingCharacteristics`. All four fields go. The replacement is a discriminated fixture shape mirroring pm47's `price-input` union — `componentType` plus that branch's `params`, with `unitOfMeasure` and the recurring pair present only on the branches that allow them (pm47 D7). The insert loop builds the envelope, parses it, and writes `componentType` + `priceComponent` + the retained row columns.

Mapping of the existing demo rows — a **re-key, with one deliberate change**:

| Existing demo price | Becomes |
| --- | --- |
| "Demo — Monthly Recurring Charge" `recurring` flat `5000.00` | `flat_fee`, envelope `priceType: recurring`, `params.amount "5000.00"`, unit NULL, period 1/`months` |
| "Demo — Monthly Recurring Charge (2027)" (the dated successor) | same, `start_date_time` 2027 — **kept**: it is pm03's derived-effectivity fixture and now also proves per-lane succession |
| "Demo — Activation Fee" `once` flat `1000.00` | `flat_fee`, envelope `priceType: oneTime`, `params.amount "1000.00"`, unit NULL, **no period** |
| "Demo — Data Overage" `usage` **tiered** (3 tiers) | **`usage_rate`**, unit `GB`, `params.ratePerUnit "0.05"` (the first tier's rate), `rateCardLookUp: null` — the graduated shape is gone with `tiered` (PC8) and is **not** reconstructed as a `capacity_motivation` here (that would silently invent a discount policy; the deliberate capacity story is D4's new offering) |
| "Demo — Data Usage" `usage` flat `0.02` | `usage_rate`, unit `GB`, `params.ratePerUnit "0.02"`, `rateCardLookUp: null` |

Record the tiered → `usage_rate` collapse in a comment at the fixture: it drops two rates, and a reader comparing old and new demo output must find the reason in the file rather than in a spec.

### D4. One demo offering carries the whole capacity story

Add a demo offering — **"Demo — Enterprise Capacity Plan"** — with four component rows on one version, all currency `MYR`, all unit `EA` where a unit applies:

| Component | Row columns | Envelope |
| --- | --- | --- |
| `usage_rate` | unit `EA`, no period | `ratePerUnit "100"`, `rateCardLookUp "ENTERPRISE_EA_CARD"` → `plaSpecId: PLA_USAGE_RATE` |
| `capacity_commitment` | unit `EA`, no period | `committedQuantity 1000` |
| `capacity_motivation` | unit `EA`, no period | `steps [{1000,"50"},{2000,"25"}]` |
| `flat_fee` | unit NULL, period 1/`months` | `priceType recurring`, `amount "2000.00"` |

This is the worked scenario of the plan, seeded: it is what pm53 renders, what pm54/pm55 edit, and what pm56 sweeps. The non-null `rateCardLookUp` is deliberate — it exercises the conditional `plaSpecId` (pm47 D4) and gives pm55's absent-rate-card warning something to attach to, while resolving to nothing, because the table it names does not exist (Inv. #42).

**The offering is seeded `ACTIVE`, the pm35 D6 way**: insert the offering as `DRAFT`, insert its components, then `UPDATE` it to `ACTIVE` in the same transaction — pm36's trigger governs the child tables, not the parent. Keep the existing demo offerings' ordering so `product_offering` ids do not shift under fixtures that pin them.

### D5. `seed-billrun-sample.ts` is repaired here, not in pm52

It appears on the §6.21 blast-radius list, but it is a seed set this module owns under the architecture §2 folder table, and it must emit envelopes for pm48's own verification to mean anything. Splitting it across two units would leave `db:seed` red for four more units for no attribution gain.

Its `_SAMPLE_` price is a `recurring` flat `SAMPLE_RECURRING_AMOUNT` and becomes a **`flat_fee`** with envelope `priceType: recurring`, `params.amount: SAMPLE_RECURRING_AMOUNT`, unit NULL, period 1/`months` unchanged. `SAMPLE_RECURRING_AMOUNT`, the GL code, the start date and the name constant keep their values — the bill-run suites assert on the amount, and this unit must not move it. pm35's `DRAFT` → insert → `ACTIVE` ordering and its idempotency guard stay exactly as pm35 left them.

**pm52 then re-keys the bill-run flow's SQL to read `flat_fee.params.amount`, and the number it resolves is the number this seed writes** — byte-identical recurring charges are pm52's success criterion, so the two units must agree on this constant. State it in both specs.

### D6. Seeds do not use the repository, and do not gain one

Seeds insert directly through Drizzle today and continue to (architecture §2; the price write path is pm49's). This is what makes pm48 landable **before** the write path and what makes a seed failure attributable to the seed (workflow §4.5). Do not import `services/product/**` or `db/repositories/**` into a seed to "reuse validation" — the validation being reused is the Zod union, which is a validation-layer import and is the correct one.

---

## Implementation

### I1. `db/seeds/demo/product-demo.ts`

1. Replace the `PriceSeed` interface with the discriminated fixture shape (D3): a `componentType` field plus per-branch params and the row columns that branch allows.
2. Rewrite the five existing price fixtures per D3's table, with the tiered-collapse comment.
3. Add the "Demo — Enterprise Capacity Plan" offering of D4, with one specification so it renders like its siblings, and the `DRAFT` → components → `ACTIVE` insert ordering.
4. Rewrite the price insert loop: build the envelope from the fixture, `persistablePricingComponentSchema.parse(...)` it, then `tx.insert(productOfferingPrice).values({ componentType, priceComponent: parsed, currency: CURRENCY, unitOfMeasure, recurringChargePeriodLength, recurringChargePeriodType, glCode, policy: null, startDateTime, name })`. Delete the `priceCharacteristicsSchema` import and its call.
5. `CURRENCY` stays one constant for the whole demo catalog — VI5 is an offering-level rule and a demo set that mixed currencies would fail pm49's validator the moment anyone edited it.

### I2. `db/seeds/sample/seed-billrun-sample.ts`

Rewrite the `_SAMPLE_` price insert per D5, parsing through the union. Touch nothing else in the file: not the teardown, not the offering insert ordering, not the constants, not the rating/billing fixtures it also seeds.

### I3. `db/seeds/product.ts`

Confirm untouched. If it has acquired a catalog row since pm02, stop and report — that is a finding, not something to fix inside this unit.

### I4. Tests

1. **`tests/db/product-seed-components.integration.test.ts` (new).** After `db:seed-demo` on a freshly migrated database: every `product_offering_price` row has a non-null `component_type` in the four persistable values; `component_type = price_component ->> '@type'` on every row (Inv. #30); `specVersion` present on every row (Inv. #44); the capacity-plan offering has exactly its four components with the D4 values; no row has a `flat_fee` with a unit or a `usage_rate` without one.
2. **Double-failure assertions (D1).** A deliberately malformed fixture — descending `steps` — is rejected by `persistablePricingComponentSchema.parse` in a unit test; the same object inserted with raw SQL (bypassing Zod) is rejected by `product_offering_price_capacity_motivation_check`. Two assertions, two layers, named as such.
3. **Existing seed-boundary guardrails** (`demo-seed-boundary`, `billing-sample-seed-boundary`, `billing-sample-seed-marker`) updated for the new column names only — their rules do not change.
4. `db:seed-sample` run twice in a row still succeeds (pm35's idempotency guard still holds under the reshape).

### I5. Documentation

No companion-doc amendment is owed by this unit. Record in the commit message that `db/seeds/product.ts` was confirmed unchanged (D2), and note in `prodmgmt-progress-tracker.md` that `db:seed` is green again for the first time since pm46.

---

## Dependencies

**Packages to install: none.** Uses the existing seed harness, `drizzle-orm`, `zod` and the live-DB integration setup.

**Commands used:** `npm run db:migrate`, `npm run db:seed-demo`, `npm run db:seed-sample`, `npm run db:setup`, `npm run test`, `npx tsc --noEmit`, `npm run lint`.

---

## Verification checklist

- [ ] `npm run db:migrate && npm run db:seed-demo` on an **empty** database loads the demo catalog with every price as an envelope.
- [ ] The "Demo — Enterprise Capacity Plan" offering exists with its `usage_rate` + `capacity_commitment` + `capacity_motivation` + `flat_fee` rows, at the D4 values, on one `ACTIVE` version.
- [ ] `npm run db:seed-sample` loads the `_SAMPLE_` graph; its price is a `flat_fee` with the unchanged `SAMPLE_RECURRING_AMOUNT`; running it twice in a row still succeeds.
- [ ] `npm run db:setup` completes end to end.
- [ ] Every seeded row satisfies `component_type = price_component ->> '@type'` and carries `specVersion`.
- [ ] A malformed fixture fails **twice** — at Zod before the insert, and at the CHECK when Zod is bypassed — with both assertions present in the suite.
- [ ] No seed writes a `flat_fee` with a `unit_of_measure`, a `usage_rate` without one, or any `negotiated_override` row.
- [ ] `db/seeds/product.ts` is byte-identical; no seed imports a repository or a service.
- [ ] The three seed-boundary guardrails pass with the new column names and unchanged rules.
- [ ] The dated 2027 successor still seeds and still reads as a future-dated successor in its own `(component_type, unit)` lane.
- [ ] `tsc --noEmit`, ESLint and Prettier clean for this unit's files; the repo-wide suite stays red until pm54 by design (G-E).

**Definition of done:** a developer runs `db:setup` and `db:seed-demo` against an empty PostgreSQL 17 and gets a catalog whose every price is a parsed envelope — including one demo product that commits a customer to 1,000 EA at 100, discounts to 50 above it and to 25 above 2,000, and bills 2,000.00 a month besides — while a seed with a descending step schedule is refused before it reaches the database and again if it goes around Zod.
