# Product Management — Update Overview (Normalize Spec Characteristics & Price Components)

**Module:** Product Management — the storage of `product.product_specifications.product_spec_characteristics` and `product.product_offering_price.price_component`. Replaces the two jsonb columns with six relational tables plus one runtime read view. No new screen: the Manage Products UI, server actions, Zod schemas and audit payload shapes keep their current form.
**Users:** Billing Operations (Manage Products — same experience, characteristics now keep their entry order); BSS IT Operations (migration, workflow worker redeploy); the bill-run processor and the rating engine as runtime readers of the new view.
**Status:** pm69 (decimal helper and scale caps) and pm70 (migration `0056`, schema and grants) are built. **Start with pm71**. The G-N5 window is open through pm73; see the [Part 6 build plan](specs/pm00-build-plan.md#part-6--normalize-spec-characteristics--price-components-pm69pm75-incl-pm74b) for remaining units and gates. The owner accepted Q1–Q4 on 2026-11-19.
**Supersedes:** the Rate Card Lookup update overview. That update's authoritative text remains `_updatemodule-ratecard-lookup-plan-v2.md` plus specs `pm57a` and `pm58`–`pm68`; its prior overview is recoverable at commit `0fc56cc`.
**Companion docs:** `_updatemodule-product-normalize-spec-price-tables-plan.md` (authoritative), `_updatemodule-product-pricing-components-plan.md` (the PC10 envelope and PC12 stage order this update decomposes), `prodmgmt-architecture.md`, `prodmgmt-code-standards.md`, `bm42-capacity-aggregation.md` (capacity consumer), `rm08` / `rm30` (usage-rate consumers).

---

## Overview

Today every product specification stores its characteristics as one flat jsonb object (`{"SST_ID":"01","SD_ID":"A0C4E2"}`), and every price component stores an eight-field jsonb envelope of which only two to three fields carry data — the rest (`specVersion`, `appliesAt`, `basis`, `plaSpecId`, `boundTo.unitOfMeasure`) are constant per `component_type` or duplicate a row column. The jsonb is policed by six CHECK constraints and the `product.pricing_steps_ok(jsonb)` function in `0006_product.sql`, and the price lane-key index in `0049_product_price_lane_key.sql` has to reach into the JSON with a `CASE WHEN component_type = 'flat_fee' THEN price_component->>'priceType' END` expression. This update moves characteristics into `product.product_spec_characteristic` (one row per name/value, with `display_order`), moves the constant envelope fields into two seeded reference tables (`price_component_type`, `price_component_price_type`), and moves the variable price data into four typed subtype tables (`pop_usage_rate`, `pop_flat_fee`, `pop_capacity_commitment`, `pop_motivation_step`) keyed to the `product_offering_price` header by a composite foreign key that pins each subtype row to a header of the matching type. A single view, `product.offering_price_v`, re-joins header, reference and subtype rows so the bill-run flow and `rp.py` read plain columns (`pop.amount`, `pop.price_type`, `pop.committed_quantity`, `pop.steps`) instead of JSON paths. The repository reassembles the existing `PricingComponent` envelope on read and decomposes it on write, so nothing above the repository changes shape.

---

## Goals

1. Store each specification characteristic as a row in `product.product_spec_characteristic` (`product_spec_id`, `char_name`, `char_value`, `display_order`) with primary key `(product_spec_id, char_name)` and `UNIQUE (product_spec_id, display_order)`, then drop `product_specifications.product_spec_characteristics`. Entry order survives (jsonb re-sorts object keys today).
2. Move the fields that are constant per component type — `applies_at`, `basis`, `pla_spec_id` and the PC12 stage order as `apply_order` — into `product.price_component_type`, seeded by migration with exactly four rows: `usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`.
3. Make the allowed `(component_type, price_type)` pairs data, not code: `product.price_component_price_type` seeded with `(usage_rate, usage)`, `(flat_fee, recurring)`, `(flat_fee, oneTime)`, `(capacity_commitment, commitment)`, `(capacity_motivation, discount)`, and a new `product_offering_price.price_type NOT NULL` column with a composite FK to it.
4. Store the variable price data in typed, NOT NULL columns: `pop_usage_rate.rate_per_unit` + `rate_card_lookup`, `pop_flat_fee.amount`, `pop_capacity_commitment.committed_quantity`, and one `pop_motivation_step` row per band (`above_quantity`, `rate_per_unit`). Drop `price_component jsonb`.
5. Make inconsistent states unrepresentable: a composite FK `(product_offering_price_id, component_type)` plus a pinned `component_type` column on every subtype table means a `pop_flat_fee` row cannot attach to a `usage_rate` header; `plaSpecId` for `usage_rate` is derived (`'PLA_USAGE_RATE'` when `rate_card_lookup IS NOT NULL`) rather than stored, removing the D4 cross-field refinement; duplicate step quantities are rejected by the `(product_offering_price_id, above_quantity)` primary key; "strictly ascending" becomes `ORDER BY above_quantity`.
6. Enforce completeness — every header has its subtype row, every `capacity_motivation` header has at least one step — with a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires at COMMIT, replacing `pricing_steps_ok()` and the six JSON CHECKs.
7. Express the price lane key as plain columns: `UNIQUE NULLS NOT DISTINCT (product_offering_id, component_type, unit_of_measure, price_type, start_date_time)`, equivalent to `0049` because `price_type` is constant for every non-`flat_fee` type.
8. Give the bill-run flow and `rp.py` one read projection, `product.offering_price_v`, granted `SELECT` to the billrun and rating DB roles, so the subtype join logic lives in one place and workflow SQL stays a single-row read.
9. Keep the API/UI contract unchanged: `toEnvelope(row)` / `fromEnvelope(component)` in the repository, Zod remains the single input contract, and `toEnvelope` normalizes `numeric(18,6)` output (`"100.000000"`) back to the canonical money string (`"100"`) so no audit diff or form value changes.
10. Extend the DRAFT-only guard `child_write_requires_draft` (`0040_product_family_guards.sql`) to the five new tables, and make `branchOfferingAsDraft` copy characteristics, subtype rows and steps with an old→new header-id map.
11. Ship as a forward migration with a verified backfill, deployed in the same release as the rewritten bill-run yml and `rp.py` (they read the dropped column).

---

## Core User Flow

1. A Billing Operations user opens **Products → Manage Products** and either opens a `DRAFT` offering version or branches an `ACTIVE` version to a new `DRAFT`.
2. They add a specification and enter its characteristics in the specification form in the order they want them shown, for example `SST_ID = 01` then `SD_ID = A0C4E2`. The server action validates with the existing `Record<string,string>` Zod schema in `validation/product/product-spec-characteristics.schema.ts` — unchanged. The repository writes one `product_spec_characteristic` row per entry with `display_order` 1, 2, …; `{}` writes no rows.
3. The detail page re-renders the characteristic chips in entry order. Today the same chips come back alphabetically because Postgres re-sorts jsonb keys.
4. They add a price component — picking `usage_rate`, `flat_fee` (recurring or oneTime), `capacity_commitment` or `capacity_motivation` — and fill the same fields as today. The UI posts the same `PricingComponent` envelope it posts today; Zod validates it exactly as today.
5. `fromEnvelope` decomposes the envelope: the header row gets `component_type` and `price_type`; the matching subtype row (or one `pop_motivation_step` row per step) is inserted after the header in the same transaction. At COMMIT the deferred trigger confirms the header is complete. A `flat_fee` with `priceType: usage` fails the reference FK; a motivation with zero steps fails at COMMIT; two steps with the same `aboveQuantity` fail the step primary key. Zod already rejects each of these states before the write, so a database refusal means Zod was bypassed: it is thrown as an unexpected failure, not translated into a validation error, and no new error mapping is added (`prodmgmt-code-standards.md` §1.51; the module's only DB-error translation today is `isUniqueViolation` on the lane index, which keeps its name).
6. The detail page reloads through one Drizzle query with `with` relations (no N+1). `toEnvelope` reassembles each envelope, deriving `plaSpecId`, `appliesAt` and `basis` from `price_component_type` and canonicalizing money from `numeric` values, so the form shows `100` and both audit snapshots use that same representation.
7. Editing a `DRAFT` price updates the header and replaces its subtype row (steps: delete then insert) in one transaction. Any write to any of the five new tables under a version that is not `DRAFT` is rejected by the extended guard with SQLSTATE `23514`; discarding a `DRAFT` still cascades through header → subtype → steps.
8. They activate the version. Its characteristics, headers, subtype rows and steps are now write-protected like every other child row.
9. Weeks later they change a price: branching the `ACTIVE` version inserts new headers with `RETURNING` ids, maps old → new, and copies every `pop_*` row, step and characteristic. Reassembling the copied envelopes yields exactly the source envelopes.
10. The month-end bill run and the rating engine read prices from `product.offering_price_v`: the recurring resolver reads `pop.amount` where `pop.price_type = 'recurring'`, the capacity CTEs read `pop.committed_quantity` and `pop.steps` (a JSON array ordered by `above_quantity`), and `rp.py` reads `rate_per_unit`, `rate_card_lookup` and the derived `pla_spec_id`. The rated and billed amounts equal what the jsonb-backed run produced.

---

## Features

### Specification characteristics

- `product.product_spec_characteristic` — `product_spec_id` (FK, `ON DELETE CASCADE`), `char_name` (non-empty), `char_value` (text — strings only, as today), `display_order` (integer). PK `(product_spec_id, char_name)`; `UNIQUE (product_spec_id, display_order)`. Natural composite key, no surrogate id.
- `product_specifications.product_spec_characteristics` dropped.
- No runtime reader changes: bill run and rating never read characteristics. The runtime-config spec rows (`udrType`, `productCardLookUp`, `singleSubInstPerCust`) are spec rows read by `name` + `default_value` and are untouched.

### Price reference tables (system data, seeded by migration)

- `product.price_component_type` — `component_type` PK, `applies_at` ∈ {`rating`, `billing`, `post_aggregation`}, `basis` ∈ {`quantity`, `flat`}, nullable `pla_spec_id` (`PLA_CAPACITY_*`; `NULL` for `flat_fee` and `usage_rate`), `apply_order`.
- `product.price_component_price_type` — PK `(component_type, price_type)`; five seeded rows. Not user-editable.

### Price header (`product_offering_price`, modified)

- Add `price_type text NOT NULL` with `FOREIGN KEY (component_type, price_type) REFERENCES price_component_price_type`; drop `component_type_check` and `envelope_type_check`.
- Drop `price_component jsonb`.
- Add `UNIQUE (product_offering_price_id, component_type)` as the target of the subtype composite FKs.
- Lane key replaced by `UNIQUE NULLS NOT DISTINCT (product_offering_id, component_type, unit_of_measure, price_type, start_date_time)` — plain columns, no expression. Drizzle expresses everything except `NULLS NOT DISTINCT`, which stays SQL-of-record as today.
- Per-type unit/period CHECKs kept, now JSON-free and keyed on `price_type`: `usage_rate` / `capacity_*` require `unit_of_measure` and forbid period columns; `flat_fee`+`recurring` forbids unit and requires period columns; `flat_fee`+`oneTime` forbids both.

### Price subtype tables

- `pop_usage_rate` — PK = header id; `rate_per_unit numeric(18,6) ≥ 0`; `rate_card_lookup` nullable, non-blank when present. `plaSpecId` is **not** stored; the view derives `'PLA_USAGE_RATE'` when `rate_card_lookup IS NOT NULL`.
- `pop_flat_fee` — `amount numeric(18,6) ≥ 0`.
- `pop_capacity_commitment` — `committed_quantity numeric(20,6) > 0`.
- `pop_motivation_step` — PK `(product_offering_price_id, above_quantity)`; `above_quantity numeric(20,6) > 0`; `rate_per_unit numeric(18,6) ≥ 0`. N bands with no schema change; no `step_no` column to keep in sync.
- Every subtype table carries `component_type NOT NULL DEFAULT '<its type>' CHECK (component_type = '<its type>')` and `FOREIGN KEY (product_offering_price_id, component_type) REFERENCES product_offering_price (product_offering_price_id, component_type) ON DELETE CASCADE`.
- `capacity_motivation` has no scalar parameters, so it has no 1:1 table — its data is its steps.

### Completeness and integrity

- `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED AFTER INSERT OR UPDATE ON product_offering_price`, plus `AFTER UPDATE OF product_offering_price_id OR DELETE` on each subtype table and `pop_motivation_step`: check the old header if it still exists. A missing header is allowed for the discard cascade. Fires at COMMIT; the repository inserts header then children in one transaction.
- `product.pricing_steps_ok(jsonb)` and the six JSON CHECKs are dropped.

### Runtime read projection

- `CREATE VIEW product.offering_price_v` — header columns, `applies_at`, `basis`, `COALESCE(ct.pla_spec_id, derived usage-rate id) AS pla_spec_id`, `rate_per_unit`, `rate_card_lookup`, `amount`, `committed_quantity`, and `steps` as `jsonb_agg(jsonb_build_object('aboveQuantity', …, 'ratePerUnit', …) ORDER BY above_quantity)`.
- `GRANT SELECT` to the billrun and rating DB roles in the bootstrap SQL.
- Reader rewrites are mechanical: `(pop.price_component #>> '{params,amount}')::numeric` → `pop.amount`; `price_component ->> 'priceType' = 'recurring'` → `pop.price_type = 'recurring'`. Files: `workflow-management/flows/bill-run-processor/bill_run_processing.template.yml` (recurring resolver and capacity CTEs, two copies each) and its local-dev copy `workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml`; `workflow-management/worker/workflow-engine/runtime/rp.py` (`ratePerUnit`, `plaSpecId`, `rateCardLookUp`).
- `steps[].ratePerUnit` becomes a JSON number (today a string); the capacity CTEs cast `::numeric` either way — verified by the parity tests.

### Application layer

- `db/repositories/product-offering-price.ts` — `toEnvelope` / `fromEnvelope`; money normalization (strip trailing zeros) with a unit test; `lead()` derived-end window re-partitioned on `(product_offering_id, component_type, unit_of_measure, price_type)`.
- `db/repositories/product-offering.ts` — detail load via Drizzle relations; `branchOfferingAsDraft` copies grandchildren with an old→new header-id map (same for specs → characteristics).
- `db/repositories/product-specification.ts` and `services/product/{add,update,delete}-specification.ts` — write rows instead of a jsonb object.
- `db/schema/product.ts` — six new tables and relations; the two jsonb columns removed.
- `child_write_requires_draft` extended to the five new tables; grandchildren resolve the offering via their parent; the "parent not found → pass" branch kept so the discard cascade works.

### Migration and backfill

- New forward migration `0056_product_normalize_spec_price.sql` (the plan's `0055` is taken by `0055_retire_invoice_csv_template.sql`). `0006`, `0040` and `0049` are not reopened.
- Steps in order: create reference and child tables and seed the reference rows → backfill characteristics with `jsonb_each_text(...) WITH ORDINALITY`, `price_type` and `pop_*` from `price_component`, steps from `jsonb_array_elements(price_component #> '{params,steps}')`, with `child_write_requires_draft` disabled for the backfill → verify every reassembled envelope equals its original JSON, failing the migration on any mismatch → swap the lane-key index, drop the six JSON CHECKs and `pricing_steps_ok`, drop the two jsonb columns.

### Seeds and tests

- `db/seeds/demo/product-demo.ts` and `db/seeds/sample/*.ts` write through the repositories (envelopes in, rows out).
- The 18 test files under `tests/` that reference `price_component` are updated; `tests/guardrails/price-lane-key-consistency.test.ts` asserts the new partition; the schema-diff guardrail covers all six tables and the view.

---

## In Scope

- `product.product_spec_characteristic`, `product.price_component_type`, `product.price_component_price_type`, `product.pop_usage_rate`, `product.pop_flat_fee`, `product.pop_capacity_commitment`, `product.pop_motivation_step`, and the view `product.offering_price_v`, in `0056_product_normalize_spec_price.sql` with the hand-written Drizzle mirror.
- `product_offering_price`: add `price_type`, add the `(id, component_type)` unique, replace the lane-key index, rewrite the per-type CHECKs, drop `price_component`.
- `product_specifications`: drop `product_spec_characteristics`.
- Deferred completeness constraint trigger; `child_write_requires_draft` extension; reference-row seeding.
- Repository `toEnvelope` / `fromEnvelope`, money normalization, transactional writes, `branchOfferingAsDraft` grandchild copy, Drizzle relations for the detail load.
- Rewrite of the bill-run recurring resolver and capacity CTEs (template yml and local-dev copy) and `rp.py` to read `product.offering_price_v`; `GRANT SELECT` in bootstrap SQL; same-release deployment of the worker image.
- Backfill with row-by-row round-trip verification.
- Seeds, the 18 affected test files, the lane-key guardrail, the new unit and integration tests in Success Criteria.

---

## Out of Scope

- **Other jsonb columns.** `ordering.product_order_item.ordered_characteristics`, `inventory.product_inventory.instance_characteristics`, `product.ratecard_version.reject_summary` and `billing.customer_bill_line.additional_info` are not touched. Whether `ordered_characteristics` / `instance_characteristics` should reference `product_spec_characteristic` is plan §7 Q5, a follow-on.
- **New UI, Server Actions, envelope fields or audit payload shapes.** The existing form gains a raw quantity check and shows canonical money text on reopen; characteristic chips appear in entry order.
- **New component types or new price parameters.** The rate-card-resolved price, the negotiated override (`ordering.order_item_price_override`) and additional motivation semantics are not added; the schema is built so they can be added as new tables later.
- **TMF620 `characteristicValueSpecification`** (value type, allowed values, unit) — a possible further child of `product_spec_characteristic`, not built.
- **Typing the runtime-config spec rows** (`udrType`, `productCardLookUp`, `singleSubInstPerCust`) as offering attributes — plan §7 Q5, follow-on.
- **The typed-header-columns alternative** (plan §6) — rejected unless Q1 is decided the other way.
- **Edit-in-place of `0006` / `0040` / `0049`** — plan §4 option A, not taken unless Q2 is decided the other way.
- **Rating-engine consumption of the rate card lookup** and any change to how `rp.py` resolves a UDR beyond reading the view's columns.
- **Bill-run business logic** — proration, rounding, the BAN aggregation grain and `customer_bill_line` mapping are unchanged; only the SQL that fetches price parameters is rewritten.

---

## Success Criteria

Each criterion is a test that fails before the change and passes after it.

- `npm run db:migrate` on an empty database creates the six tables and the view; `price_component_type` holds exactly four rows and `price_component_price_type` exactly five; `product_offering_price` has no `price_component` column and `product_specifications` has no `product_spec_characteristics` column.
- Inserting a header with `(flat_fee, usage)` or any other unseeded pair fails the composite FK.
- Inserting a `pop_flat_fee` row for a `usage_rate` header fails the composite FK.
- Committing a header with no subtype row, or a `capacity_motivation` header with zero steps, fails at COMMIT; deleting the only step of a `DRAFT` motivation and committing also fails.
- Two `pop_motivation_step` rows with the same `above_quantity` are rejected; `offering_price_v.steps` returns them in ascending `above_quantity` order as JSON numbers.
- Two identical recurring `flat_fee` rows at one `start_date_time` are rejected by the lane key; a recurring and a oneTime `flat_fee` at the same start are both accepted.
- A write to any of the five new tables under a non-`DRAFT` version fails with SQLSTATE `23514`; discarding a `DRAFT` version deletes its characteristics, subtype rows and steps with no orphans.
- `toEnvelope(fromEnvelope(x))` deep-equals `x` for every seed component, including `"100"` surviving a `numeric(18,6)` round trip as `"100"`, not `"100.000000"`.
- Branching an `ACTIVE` version copies every characteristic (same `display_order`), subtype row and step; reassembled envelopes on the branch deep-equal the source version's.
- A specification saved with characteristics `SST_ID`, `SD_ID` in that order reads back in that order.
- Backfill: on a database loaded with the current demo and sample seeds, every reassembled envelope equals its original `price_component` JSON and every characteristic set equals its original object; the migration aborts on any mismatch.
- Runtime parity: the existing bill-run recurring and capacity integration tests (`bm42` coverage) and the `rm08` / `rm30` rating tests pass unchanged against `offering_price_v`; no `price_component` reference remains in `bill_run_processing.template.yml`, its local-dev copy, or `rp.py`.
- The billrun and rating DB roles can `SELECT` from `product.offering_price_v` and have no grant on the subtype tables beyond what they had on `product_offering_price` before.
- `npm run typecheck`, `lint` and the full test suite pass; the schema-diff guardrail is green for all six tables and the view; the 18 test files that referenced `price_component` compile against the new shape.
