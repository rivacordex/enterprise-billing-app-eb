# pm56a — Pricing-components fixture sweep + guardrail-31 scope correction

**Unit:** pm56a (Part 4 follow-up; the fixture-sweep half of the residue cleanup the pm56 ship gate named but could not fix). **Boundary:** `tests/**` only — the pre-pm46/pm47 test fixtures that still write the dropped price-row shape, plus a scope correction to `tests/guardrails/pricing-component-guardrails.test.ts` (guardrail 31). **No production code**, **no schema/migration/service/repository change** — if a fixture cannot be made green without a production change, that is a different unit's defect (report it, do not absorb it).
**Specs from:** `prodmgmt-issues-tracker.md` **PM-ISS-001** (the authoritative failing-file list and the pattern to copy) · `pm56-spec` D1/D8 (guardrail 31), the pm56 evidence table and D4 addendum (`prodmgmt-progress-tracker.md`) · `pm00-build-plan.md` Part 4 hand-off register (the five "Unresolved — …integration.test.ts" rows) · `prodmgmt-ai-workflow-rules.md` §0.6 (G-E), §3.7, §6.9, §7.10 · `prodmgmt-architecture.md` §6 (Inv. #30–#44).
**Depends on:** pm46–pm55 (the reshape whose shape the fixtures must adopt), all on `dev1`. **Independent of pm56b** — different files, no ordering constraint; either may land first. Guardrail 31 goes fully green only once **both** land.

---

## Goal

Make the product-module test surface tell the truth about the shipped schema: every product integration suite green on a database built from empty, and guardrail 31 reduced to flagging **only** real residue. After pm56a, the sole remaining guardrail-31 offenders are the four ordering-wizard production files — pm56b's job — and nothing else.

---

## Design

### D1. The fixtures are wrong, not the schema

PM-ISS-001 is settled and evidenced: pm46 dropped `price_type` / `amount` / `pricing_model` and pm47 replaced them with a NOT NULL `component_type` + a JSONB `price_component` envelope; eight product integration suites still insert the old column set (67 failing / 92 passing across 13 files). This is stale **test fixtures**, not a runtime defect — the app code and its DB-free suites are green. The reference for a correct write already exists in-tree and must be copied, not reinvented: `db/seeds/demo/product-demo.ts` (branch DRAFT → insert the discriminated `price_component` → flip ACTIVE) and `tests/db/helpers/billrun-aggregate.ts` (parse each envelope through `persistablePricingComponentSchema` before `JSON.stringify`). The five already-green suites (`product-price-components`, `product-price-component-constraints`, `product-seed-components`, `product-family-page`, `manage-products-query-budget`) are the working template.

### D2. Two axes per fixture (the "option-C co-land" debt)

Each red `product_offering_price` insert is repaired on both axes at once (PM-ISS-001 "Fix owed"):

1. **Shape.** Supply `component_type` + a schema-valid `price_component` envelope (pm47's discriminated union), not `price_type`/`amount`/`pricing_model`.
2. **DRAFT-then-activate.** Insert children while the parent is `DRAFT`, then flip status, wherever pm36's §3.5 DRAFT-guard trigger applies.

Plus the two assertion-only repairs: `product-schema*.test.ts` updates its unique-key assertion from `(product_offering_id, price_type, start_date_time)` to the shipped `(product_offering_id, component_type, unit_of_measure, start_date_time)`; `product-family-guards` drops its raw-SQL `price_type` references. `product-repositories.integration.test.ts` additionally stops importing the deleted `pricing-characteristics.schema` so it collects at all (it is the documented option-C co-land file).

### D3. Guardrail 31 must be able to go green — its scan over-reaches into the enforcement layer

Guardrail 31 flags `tests/guardrails/product-module-boundaries.test.ts` for naming `pricing_model` / `price_type` / `tiered` — but those live in its `DROPPED_COLUMNS` / `DROPPED_CHECKS` arrays, where the sibling guardrail names the tokens **precisely to assert their absence** (`product-module-boundaries.test.ts:527–547`). That is the enforcement layer doing its job, not residue; guardrail 31 currently self-excludes only its own file, so it can never reach `[]` while any sibling guardrail names a forbidden token. **Fix:** exclude `tests/guardrails/**` from guardrail 31's file walk. A guardrail's whole purpose is to name what it forbids; scanning the guardrails for the vocabulary they enforce is a category error. This is a deliberate, recorded **deviation** from pm56-spec D1's literal "…across `app/`, `components/`, `db/`, `services/`, `validation/`, `types/`, `tests/`" (§7.10) — narrowed to `tests/**` excluding `tests/guardrails/**`, with the reason in a code comment and in this spec. It is **not** "relaxing a gate to pass" (§6.9): it removes false positives so the gate flags only true drift; the real residue (ordering-wizard + the fixtures D1/D2 repair) is still caught.

### D4. What pm56a does NOT own

- The **ordering-wizard chain** (`components/products/ordering/**`) and its own test `tests/components/new-order-wizard.test.tsx` — production code, `components/**` boundary, needs a fresh **G-G** grant. That is **pm56b**.
- Any **non-product** integration suite with the identical drift (ordering / rating / billing fixtures) — a full G-E close-out needs those swept too (PM-ISS-001 closing note), but each belongs to its own module's sweep, not this product-module unit.

---

## Implementation

### I1. Repair the eight red product integration suites (PM-ISS-001 table)

`tests/db/product-price-writes` (10/10), `product-withdrawal-path` (13/13), `product-release-path` (14/16), `product-price-constraints` (10/11), `product-delete-offering` (6/7), `product-family-guards` (13/20), `product-schema.integration` (1/8), and `product-repositories.integration` (collection error). Reshape every `product_offering_price` insert per D2; fix the shared `createDraft` / `newActiveOffering` / `newObsoleteOffering` fixture helpers once each rather than per call site (§2.16 — one copy).

### I2. Repair the DB-free fixture files guardrail 31 / the pm56 D4 addendum name

`tests/validation/price-input.test.ts`, `tests/actions/insert-price.action.test.ts`, `tests/db/product-schema.test.ts`, and the pm40/41 `PriceCard` fixtures in `tests/components/offering-detail-region.test.tsx`, `tests/app/manage-products-editing.test.tsx`, `tests/app/manage-products-selection.test.tsx`, `tests/components/selection-region.test.tsx`, `tests/services/get-offering-detail.service.test.ts` — updated to the pm47 discriminated `price_component` shape. (`new-order-wizard.test.tsx` is pm56b's, per D4.)

### I3. Guardrail 31 scope correction

Exclude `tests/guardrails/**` from guardrail 31's `SCAN_ROOTS` walk (D3), with the deviation comment. Do **not** touch guardrail 31's assertion (`expect(offenders.sort()).toEqual([])`) or its pattern list — the gate still asserts zero residue; only the enforcement layer is removed from the scan.

---

## Verification checklist

- [ ] `docker compose -f docker-compose.test.yml up -d --wait` then `node --env-file=.env.test node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts product` → **all 13 product files green** (PM-ISS-001 "Verify when fixed").
- [ ] `npx tsc --noEmit` — the 11 test-fixture files in pm56's 35-error/15-file count are gone; the only remaining errors are the 4 ordering-wizard production files (pm56b).
- [ ] Guardrail 31's offender list contains **only** the four `components/products/ordering/**` files — no `tests/**` entries (run `pricing-component-guardrails.test.ts`; the failure message is the diff).
- [ ] `eslint` and `prettier --check` clean on every touched file.
- [ ] No production, schema, migration, service, repository or `components/**` file changed (`git status` — `tests/**` only).
- [ ] PM-ISS-001 marked `RESOLVED` for the eight product files, with the verify command output.

**Definition of done:** the product integration suite is green on a database built from empty, guardrail 31 flags only the ordering-wizard production residue, and PM-ISS-001's product-file half is closed — with no production code touched. Guardrail 31 turns fully green when **pm56b** lands.
