# pm47 — The component envelope: Zod union, domain types, `plaSpec` catalog

**Unit:** pm47 (Part 4). **Boundary:** `validation/product/**`, `types/product.ts`, and two test files. Pure TypeScript — **no SQL, no repository, no service, no action, no component, no seed.** The only DB-adjacent fact it produces is the `PricingComponent` type that pm46's `$type<>()` consumes.
**Specs from:** `_updatemodule-product-pricing-components-plan.md` **PC1, PC2, PC3, PC6, PC7, PC8, PC10, PC11, PC12, PC13**, **VI1**, **VI2** · `prodmgmt-architecture.md` §3.3, §3.5, §3.6, Inv. #31, #32, #37, #38, #40, #41, #42, #43, #44 · `prodmgmt-code-standards.md` §1.21–§1.33, §2.1, §2.4, §2.5, §2.8, §2.12, §2.13, §2.17, §2.18, §7.5, Appendix A rows A2, A5 · `prodmgmt-ai-workflow-rules.md` §4.2, §4.4, §5.4, §7.3.
**Depends on:** **pm46** — the CHECK constraints this mirrors. Zod is the primary guard; the database is the backstop (Inv. #31).

> **⚠ This file lands first inside the branch, despite the unit number.** `pricing-component.schema.ts` is pure Zod with **no DB dependency**, while pm46's `db/schema/product.ts` needs `PricingComponent` for `$type<>()`. So the working order inside the G-E branch is: pm46's SQL → **this file** → pm46's Drizzle mirror → the rest of pm47. The unit numbering reflects authoring and review order (schema unit first, workflow §4.1), not commit order — and the branch is squashed, so nothing is lost. The dependency stated above is **conceptual**: this union mirrors pm46's CHECKs and must be written against them, which is why it is not numbered first.

---

## Goal

Create `validation/product/pricing-component.schema.ts` as the module's single source of truth for a price: a Zod discriminated union on `@type` with five `strictObject` branches, the shared money rule, the `plaSpec` catalog and the TMF620 mapping table — and delete every trace of the flat/tiered shape it replaces, so `PricingModel`, `PriceType` and `TieredPricingCharacteristics` have no referent left in the codebase.

---

## Design

### D1. One file, one union, eight fields, five types — and the file is closed

The envelope is exactly eight fields (`@type`, `specVersion`, `plaSpecId`, `priceType`, `appliesAt`, `basis`, `boundTo`, `params`) over exactly five `@type` values (`usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`, `negotiated_override`). A ninth field or a sixth type is a new phase, not a unit (§1.32). **No `sequence` field** — apply order is canonical by stage then class (PC12, Inv. #37), and that omission is considered, not a gap.

Every branch is a `z.strictObject`, so an unknown key is **rejected, never stripped** (PC2, Inv. #31). This is the difference between a typo becoming a silent data loss and a typo becoming a refusal, and it is the reason guardrail 32 tests both halves — Zod's refusal and the DB CHECK's independent refusal of the same object.

### D2. The four persistable branches, field by field

Each branch fixes its own `priceType`, `appliesAt`, `basis` and `plaSpecId` as **literals** — a caller cannot choose them, and a seed cannot drift from them.

| Branch | `priceType` | `appliesAt` | `basis` | `plaSpecId` | `boundTo` | `params` |
| --- | --- | --- | --- | --- | --- | --- |
| `usage_rate` | `usage` | `rating` | `quantity` | `PLA_USAGE_RATE` **iff** `rateCardLookUp` non-null, else `null` (§2.12) | `{ unitOfMeasure }` | `ratePerUnit` money string; `rateCardLookUp` string \| null |
| `flat_fee` | `recurring` \| `oneTime` | `billing` | `flat` | `null` | `null` | `amount` money string |
| `capacity_commitment` | `commitment` | `post_aggregation` | `quantity` | `PLA_CAPACITY_COMMITMENT` | `{ unitOfMeasure }` | `committedQuantity` finite number `> 0` (VI2) |
| `capacity_motivation` | `discount` | `post_aggregation` | `quantity` | `PLA_CAPACITY_MOTIVATION` | `{ unitOfMeasure }` | `steps[]` (VI1) |

`specVersion` is `z.literal(1)` on every branch — required, never optional (Inv. #44). It is the forward-migration hook; a shape change without incrementing it is a breaking change disguised as a patch.

### D3. The fifth branch exists and is not persistable

`negotiated_override` (`priceType: discount`, `appliesAt: rating`, `basis: quantity`, `plaSpecId: null`, `boundTo: { priceType: 'usage', unitOfMeasure }`, `params: { ratePerUnit }`) is a **branch of the union and not a member of `ComponentType`** (§1.29, §2.1, Inv. #39). It exists so the TMF projection and the `plaSpec` catalog are complete; its physical row stays in `ordering.order_item_price_override`, insert-only, scalar. `boundTo` on this branch is the one place `priceType` appears inside `boundTo` (§2.13).

This asymmetry is the file's single most confusable fact, so it is stated **in the doc-block**, in the `ComponentType` declaration's comment, and asserted by a test: `COMPONENT_TYPES` has four members, `pricingComponentSchema` parses five `@type` values, and `'negotiated_override'` is not assignable to `ComponentType`.

### D4. `plaSpecId` is a cross-field refinement inside the branch, never a caller's choice

`usage_rate` is the only conditional: `PLA_USAGE_RATE` when `rateCardLookUp` is a non-null name (card-driven rating is algorithmic, so it is a PLA), `null` when it is not (a plain scalar POP). The refinement lives **inside the `usage_rate` branch**, so no caller can construct the wrong pairing and no service has to remember the rule (§2.12).

`rateCardLookUp` stays a **name, not a reference** (PC10, Inv. #42) — no FK, no join, no table, no resolution, no fallback logic in code. PC10's precedence (card → its entry, or its "default" entry → `ratePerUnit`; null → `ratePerUnit`) is **recorded in the doc-block and nowhere else**; building any of it here would be the rate-card phase leaking into this one.

### D5. Money is a decimal string, declared once; quantities are numbers

One `moneyStringSchema` (`^\d+(\.\d+)?$`) declared once in this file and reused by `ratePerUnit`, `amount` and `steps[].ratePerUnit` (§2.5). No float ever represents money, and this module performs **no** money arithmetic. `committedQuantity` and every `steps[].aboveQuantity` are finite JS numbers — never strings (§1.24). `currency` and `unit_of_measure` are row columns and never envelope data; the single echo is `boundTo.unitOfMeasure`, which exists solely to resolve a modifier's binding (PC3, PC4, §1.25).

### D6. VI1 and VI2 live here; VI3–VI5 do not

VI1 (`steps` non-empty, `aboveQuantity` strictly ascending, non-duplicate, `> 0`, each `ratePerUnit` a money string) and VI2 (`committedQuantity` finite, `> 0`) validate **one component** and belong in this file. VI3, VI4 and VI5 read the offering's *other* rows and belong to pm49's `validateOfferingComponents`, inside the transaction, after the DRAFT lock. **That split is what preserves which layer refused a write and must not be collapsed** (workflow §4.2, §2.16).

VI1's ascent is a `superRefine` over `steps`, replacing `tierSchema`'s contiguity refinement — same idea, new home (Appendix A row A2). Note the deliberate difference: tiers required *contiguity* (`to === next.from`); steps require only *strict ascent*, because a step is a threshold, not a bounded band.

### D7. `price-input.schema.ts` is rebuilt so impossible combinations are untypeable

Discriminated on **`componentType`**, not `priceType` (§2.8). Per branch:

| Branch | `unitOfMeasure` | recurring period pair | branch `params` |
| --- | --- | --- | --- |
| `usage_rate` | required | **absent from the type** | `ratePerUnit`, `rateCardLookUp` |
| `flat_fee` (`recurring`) | **absent from the type** | required | `amount` |
| `flat_fee` (`oneTime`) | **absent from the type** | **absent from the type** | `amount` |
| `capacity_commitment` | required | **absent from the type** | `committedQuantity` |
| `capacity_motivation` | required | **absent from the type** | `steps[]` |

"Absent from the type" is literal: optional-and-nullable fields are **not** an acceptable substitute — the impossible combination must fail at `tsc`, not only at runtime (§2.8). `currency` and `startDateTime` are shared fields on every branch. The 3-day backdating rule stays exactly where it is — a service check with a Zod fast-fail copy (§1.12), unchanged by this unit.

### D8. Domain types: three added, two deleted with no forwarding address

`types/product.ts` gains `ComponentType` (the four persistable, and the exact list pm46's CHECK admits), `EnvelopePriceType` (`usage | recurring | oneTime | discount | commitment`), `AppliesAt`, `Basis`, and re-exports `PricingComponent` plus its branch types from the schema file (§2.1). It **deletes** `PricingModel` and `PRICING_MODELS`, `PriceType` and `PRICE_TYPES` — no rename, no alias, no deprecated re-export. `tsc` finding no referent is the test (§2.1).

`EnvelopePriceType` and the dropped `PriceType` must never be equated, mapped onto each other or derived from each other (PC13, Inv. #38). Put that sentence in the type's own comment, because the two names are one word apart and the ordering table still stores the old axis.

### D9. The composition contract is a test, not a product

`tests/product/pricing-composition-contract.test.ts` holds a **test-local pure function** taking the envelope types and reproducing the worked figures. It exports nothing to production and is wired to nothing (§2.17, Inv. #43): Product defines and stores components, Bill Run prices them. The test's own comment must say so plainly, so a later reader does not "promote" it to `services/product/`.

Figures asserted: `800 EA → 100,000`; `2000 EA → 150,000`; `3000 EA → 175,000` with the second `@25` band; and the **commitment-exceeds-first-step** case — `committedQuantity` above the first threshold still prices the topped-up units through the same schedule, which is the property that makes the transform-pipeline ordering (commitment before motivation, PC12) correct rather than coincidental.

It lands here, not at pm56: tests land with the behaviour they cover, and deferring coverage to the gate is the pm24 finding this module already paid for (workflow §4 / build-plan sequencing notes).

### D10. The tiered sweep lands here — unless it is big, in which case it splits

Deleted outright: `pricing-characteristics.schema.ts` (with `tierSchema`, `tieredPricingCharacteristicsSchema`, `priceCharacteristicsSchema`), `tests/validation/pricing-characteristics.schema.test.ts`, and `TieredPricingCharacteristics` (Inv. #41, §1.31). Do **not** re-express tiers as a generic "tier" helper, a `steps` alias or a deprecated export.

Once pm46 has landed, grep for `tiered|tierSchema|TieredPricing|pricingModel|pricing_model|PriceType|priceType` across the repo. Sites in this module's own files are fixed here. If the sweep turns up **more than a handful** of surviving sites outside them, workflow §4.4 applies: split the sweep out and land it **before** this union. Guardrail 31 asserts the end state either way. Sites in `ordering/**`, `rating/**` and the bill-run flow are **not** this unit's — they are pm50, pm51 and pm52, each with its own G-G authorization.

### D11. The `plaSpec` catalog and the TMF620 table are shipped deliverables

PC11: one `plaSpec` doc-block per `@type` — what it means, what it consumes, what it produces, which stage applies it, and its `plaSpecId` — plus the TMF620 mapping table, both **inside `pricing-component.schema.ts`**, cross-linked from the module `AGENTS.md` and `README.md` (§7.5). A unit that lands the union without them is incomplete. This catalog **is** the compliance artifact: there is no adapter, no SDK, no mapper, no serializer, no DTO, no `toTmf620()` and no `app/api/product*`, in this phase or any other (Inv. #40, §1.28).

---

## Implementation

### I1. `validation/product/pricing-component.schema.ts` (new)

File order, top to bottom:

1. **The doc-block (D11)** — the envelope's eight fields with meanings; one `plaSpec` section per `@type`; the TMF620 mapping table (component → POP; `@type` → `@type`; algorithmic `params` → `pricingLogicAlgorithm[]` + `plaSpecId`; plain component → POP `price` `Money{value,unit}`; `priceType` → `priceType` with `commitment` flagged as a documented extension; `boundTo` → `popRelationship[]`; money string + `currency` column → `Money`; `unit_of_measure` column → `Quantity`; `capacity_motivation.steps` → PLA params; `negotiated_override` → `ProductPrice.priceAlteration`); PC10's precedence; and the compliance verdict sentence ("structurally aligned, not literally TMF620-conformant").
2. `moneyStringSchema` (D5), declared once.
3. `stepSchema` — `strictObject({ aboveQuantity: z.number().finite().positive(), ratePerUnit: moneyStringSchema })`.
4. `stepsSchema` — `z.array(stepSchema).min(1).superRefine(...)` asserting strict ascent (VI1). One issue per offending index, message naming the threshold, `path: ['steps', i, 'aboveQuantity']`.
5. The five branch schemas, each a `strictObject` with literals per D2/D3, `specVersion: z.literal(1)`, and `boundTo` as `strictObject({ unitOfMeasure: unitOfMeasureSchema })` or `z.null()` (plus `priceType` on `negotiated_override` only).
6. `usageRateComponentSchema` carries the `plaSpecId` ⟷ `rateCardLookUp` refinement **inside the branch** (D4), with a message naming both fields.
7. `pricingComponentSchema = z.discriminatedUnion('@type', [...five...])`, and `export type PricingComponent = z.infer<typeof pricingComponentSchema>` — the type is **inferred, never declared alongside** (§2.4).
8. `persistablePricingComponentSchema` — the same union minus `negotiated_override`, for callers that write to `product_offering_price`. This is what pm48's seeds and pm49's repository parse against, and it is what makes Inv. #39 a type error rather than a runtime check.
9. Branch types exported individually (`UsageRateComponent`, `FlatFeeComponent`, `CapacityCommitmentComponent`, `CapacityMotivationComponent`, `NegotiatedOverrideComponent`) for the form branches and the badge map.

### I2. `validation/product/price-input.schema.ts` (rebuilt)

Rewrite as the D7 discriminated union on `componentType`, sharing `currency` and `startDateTime`, importing `moneyStringSchema` and `stepsSchema` rather than restating them (§2.16 — no second copy of a rule). Keep the existing insert/update split (`insert-price.schema.ts`, `update-price.schema.ts`) intact in shape: both consume this union, as pm38 established. Remove every `priceType` / `pricingModel` field and every conditional that keyed off them.

### I3. `types/product.ts`

Add `COMPONENT_TYPES` / `ComponentType` (four members, in the order the picker shows them: `usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`), `ENVELOPE_PRICE_TYPES` / `EnvelopePriceType`, `APPLIES_AT` / `AppliesAt`, `BASIS` / `Basis`; re-export `PricingComponent` and the branch types. Delete `PRICE_TYPES`/`PriceType` and `PRICING_MODELS`/`PricingModel`. Add D8's comment on the two axes.

`PriceCard` is **not** reshaped here — it is pm49's, together with the repository that populates it. This unit leaves `PriceCard` compiling against whatever pm46 left; if it cannot, the minimal change is to remove the dropped fields, not to add the new ones early.

### I4. Deletions

- `validation/product/pricing-characteristics.schema.ts`
- `tests/validation/pricing-characteristics.schema.test.ts`
- every import of either, and every `TieredPricingCharacteristics` annotation (the `db/schema/product.ts` one is pm46's).

### I5. `tests/validation/pricing-component.schema.test.ts` (new)

Pure-function tests, no database:

- Every worked envelope in the plan parses: the `usage_rate` `"100"` EA, the `recurring` and `oneTime` `flat_fee`, the `capacity_commitment` `1000`, the one-band and two-band `capacity_motivation`, and the `negotiated_override` `"85"`.
- Refusals, each with a typed error and the expected path: `steps: []`; descending steps; duplicate thresholds; `aboveQuantity: 0`; `ratePerUnit` as a number; `amount` as a number; `committedQuantity: 0`, `-1`, `"1000"`, `Infinity`; a `usage_rate` with a `rateCardLookUp` but `plaSpecId: null`; a `usage_rate` with no card but `plaSpecId: 'PLA_USAGE_RATE'`; a missing `specVersion`; `specVersion: 2`; an **unknown key** in every one of the five branches; a `@type` outside the five.
- `persistablePricingComponentSchema` rejects `negotiated_override` while `pricingComponentSchema` accepts it (D3).
- `COMPONENT_TYPES` has exactly four members and `'negotiated_override'` is not among them.

### I6. `tests/product/pricing-composition-contract.test.ts` (new)

D9's test-local pure function plus its four assertions, and a comment stating it is a reference implementation of a **later phase's** arithmetic, exported to nothing.

### I7. `AGENTS.md` and `README.md` cross-links

One line in each pointing at `validation/product/pricing-component.schema.ts` as the source of truth for the envelope, the `plaSpec` catalog and the TMF620 mapping (PC11, §7.5). Cross-module docs (`ratemgmt-*`, `billmgmt-*`) are **not** edited — that needs its own approval (workflow §7.9).

### I8. Documentation landed with this unit

1. `prodmgmt-code-standards.md` §7 file tree — add `pricing-component.schema.ts` and `tests/product/pricing-composition-contract.test.ts`; remove `pricing-characteristics.schema.ts` and its test (§7.6).
2. `prodmgmt-code-standards.md` Appendix A — clear **A2** and **A5** by grep.
3. Record the tiered-sweep outcome (D10) in the unit's commit message: how many sites, and whether §4.4's split was needed.

---

## Dependencies

**Packages to install: none.** `zod` is already the module's validation library and the union uses only `strictObject`, `discriminatedUnion`, `literal`, `array`, `superRefine` and `infer` — no plugin, no codec, no JSON-schema generator. **No TMF620 SDK, adapter or type package is installed, now or ever** (Inv. #40) — a `tmf`-prefixed dependency appearing in `package.json` is a scope breach, not a convenience.

**Commands used:** `npm run test`, `npx tsc --noEmit`, `npm run lint`.

---

## Verification checklist

Schema

- [ ] `pricingComponentSchema` is a discriminated union on `@type` with five branches, each a `strictObject`.
- [ ] An unknown key in **every** branch is rejected, not stripped.
- [ ] `specVersion` is required and literal on every branch.
- [ ] `plaSpecId` is fixed per branch, and `usage_rate`'s is `PLA_USAGE_RATE` **iff** `rateCardLookUp` is non-null — both directions tested.
- [ ] `boundTo` is `{ unitOfMeasure }` or `null`, with `priceType` present on `negotiated_override` only.
- [ ] `moneyStringSchema` is declared once and used by all three money fields.
- [ ] VI1 and VI2 are enforced with typed errors and correct paths; VI3–VI5 appear nowhere in this file.
- [ ] `persistablePricingComponentSchema` excludes `negotiated_override`; `ComponentType` has four members.

Types

- [ ] `PricingComponent` is `z.infer<typeof pricingComponentSchema>`, not a hand-declared type.
- [ ] `ComponentType`, `EnvelopePriceType`, `AppliesAt`, `Basis` are exported from `types/product.ts`.
- [ ] `PricingModel`, `PRICING_MODELS`, `PriceType`, `PRICE_TYPES` and `TieredPricingCharacteristics` are gone — no alias, no re-export — and `tsc` proves no referent remains.
- [ ] `price-input.schema.ts` is discriminated by `componentType` and the impossible field combinations are **untypeable**, not merely rejected.

Deliverables

- [ ] The `plaSpec` doc-block exists for all five `@type` values and the TMF620 mapping table is in the same file.
- [ ] `AGENTS.md` and `README.md` both link to it.
- [ ] `pricing-characteristics.schema.ts` and its test file are deleted; no import survives.
- [ ] The composition contract reproduces `800 → 100,000`, `2000 → 150,000`, `3000 → 175,000`, and the commitment-exceeds-first-step case — and exports nothing to production.

Boundaries

- [ ] No SQL, repository, service, action, component or seed file changed in this unit.
- [ ] No TMF620 adapter, mapper, serializer, DTO or dependency was added.
- [ ] No rate-card lookup, fallback or resolution logic exists — `rateCardLookUp` is parsed as a plain nullable string.
- [ ] `tsc --noEmit`, ESLint and Prettier clean for this unit's files; the repo-wide suite stays red until pm54 by design (G-E).

Documentation

- [ ] Code-standards §7 file tree updated; Appendix A rows A2 and A5 cleared by grep.

**Definition of done:** there is exactly one way to express a price in this module — a parsed `PricingComponent` — and the file that defines it also explains each component to a TMF620 reader, refuses a typo'd key, refuses a descending step schedule, and proves on paper that `800 EA` bills `100,000` long before anything in production can compute it.
