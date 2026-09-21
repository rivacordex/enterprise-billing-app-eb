# pm46 — Price table reshape (schema target state)

**Unit:** pm46 (Part 4, first unit). **Boundary:** `db/**` only — `db/migrations/0006_product.sql`, the one stale constraint in `0007`, `db/schema/product.ts`, and the two test files that prove it. No repository, service, action, component, validation or seed change (seeds are pm48; the write path is pm49).
**Specs from:** `prodmgmt-update-overview.md` (goal 8; success criterion 1) · `_updatemodule-product-pricing-components-plan.md` **PC13, PC14**, VI1, VI2, O3/O4 (resolved) · `prodmgmt-architecture.md` §3.2, §3.3, §3.4, §3.5, §3.7, Inv. #2, #4, #5, #28, #30, #32, #39 · `prodmgmt-code-standards.md` §1.21–§1.25, §1.30, §6.4, §6.5, §6.14, §6.19, §6.20, Appendix A rows A1, A3, A4, A6, A8 · `prodmgmt-ai-workflow-rules.md` §4.1, §6.2, §6.14, §8.1, §8.4, §8.5.
**Depends on:** **pm35** (the table this edits and the four `price_type`-keyed CHECKs it replaces), **pm36** (the DRAFT-guard trigger the reshaped columns must fit under, unmodified).

**Gate status at authoring time (2026-09-21):**

| Gate | State for this unit |
| --- | --- |
| **G-0** — Part 3 live in `main` | **OPEN — blocking.** pm35–pm45 must be built, merged and ship-gate-verified first. This unit edits the table pm35 creates and relies on the trigger pm36 installs. **Do not rebuild any part of Part 3 inside pm46.** |
| **G-A** — baseline correction | Owed. Not blocking pm46's code, but the correction has to land somewhere; this unit carries the code-standards §7/§9 half (I6.7). |
| **G-B** — invariant amendments | Must be recorded as approved before any DDL is written. pm46 **lands** the Inv. #2/#4/#5/#28 + §3.1 amendments (workflow §7.1); it does not approve them. |
| **G-C** — in-place edit of `0006_product.sql` | **GRANTED (Khek, 2026-09-21)** — a second in-place edit, under the fresh-install assumption (PC14, O3/O4 resolved). Recorded in code-standards §6.14 and Appendix A row A6 by this unit. |
| **G-F** — uniqueness NULL form | **RESOLVED (Khek, 2026-09-21): `NULLS NOT DISTINCT`.** The `COALESCE(unit_of_measure,'')` expression index proposed in architecture §3.4/§7 is **rejected**; a sentinel string was excluded either way. Architecture §3.4 and §7 are corrected by this unit. |
| **G-E** — the red-tree window | Resolved: squash. pm46 lands on the pm46–pm54 feature branch and **is not independently CI-green** — see §Sequencing. |

---

## Goal

Reshape `product.product_offering_price` in one edit of `0006_product.sql` so a price row is exactly one pricing component — a `component_type` discriminator plus a `price_component` JSONB envelope, complete for its type or refused by the database — with `price_type`, `pricing_model`, `amount` and `pricing_characteristics` and their four CHECKs gone and the uniqueness key rekeyed per `(component_type, unit_of_measure)` lane.

---

## Design

### D1. Why `0006` is edited in place, again

The D11 one-round exception closed at pm45 and forward-only was restored; PC14 needs a second round, and **gate G-C granted it on 2026-09-21**. The mechanics are pm35's, unchanged:

- the `.sql` file of record is edited and `db/schema/product.ts` is kept in sync **by hand** (`db/migrations/README.md` step 3);
- `meta/0006_snapshot.json` stays stale, like every snapshot after `0026`;
- `meta/_journal.json` is **untouched** — the file is edited, not added, so tag, `when` and ordering do not change;
- `npm run db:generate` (`drizzle-kit generate`) is never run;
- every environment rebuilds its database from empty.

The migrator compares `folderMillis` and writes but never compares the `hash` column, so an edited `0006` reaches only databases built from scratch — which is exactly the fresh-install assumption this rests on. The standing rule that a migration must **never** add an enum value and then use it still holds; it does not bite here because this unit adds no enum value, and it is the reason a forward migration would have needed the create-new-type-and-swap shape.

### D2. Two columns in, four columns out — and the drops are drops

| Change | Column | Notes |
| --- | --- | --- |
| **add** | `component_type text NOT NULL` | CHECK-constrained to the four **persistable** types, and indexed. Always equals `price_component ->> '@type'` (Inv. #30). |
| **add** | `price_component jsonb NOT NULL` | `$type<PricingComponent>()` in Drizzle. Zod is the primary guard (pm47); the CHECKs here are the backstop. |
| **drop** | `price_type` | Superseded by `component_type`. Survives only on `ordering.order_item_price_override` (PC13), which narrows O2 to that one table. **Never reintroduced on this table under any name** (§1.23). |
| **drop** | `pricing_model` | PC8 — `tiered` ceases to exist. |
| **drop** | `amount` | Money moves inside the envelope, as a decimal string. |
| **drop** | `pricing_characteristics` | Replaced by `price_component`. |

Dropped with them, by name: `product_offering_price_type_check`, `product_offering_price_pricing_model_check`, `product_offering_price_amount_xor_tiers_check` (all three in `0006`) and `product_offering_price_amount_check` (in `0007` — that file is opened only to remove this one constraint, I3). **No view, alias, generated column, default or shim reproduces any of them** (§6.19, §1.30).

Retained unchanged: `currency` + its 3-char CHECK, `unit_of_measure` + `product_offering_price_unit_value_check`, `recurring_charge_period_length`/`_type` + `product_offering_price_period_value_check`, `gl_code`, `policy` (still NULL, still out of the form), `start_date_time`, `created_at`, the offering FK with its `ON DELETE cascade`, and `product_offering_price_offering_idx`.

### D3. Completeness is six constraints, not one

Per-`component_type` completeness (architecture §3.3, code-standards §6.5) is the DB mirror of VI1–VI2 and replaces the flat/tiered XOR. Split so a violation names its own cause:

| Constraint | Rule |
| --- | --- |
| `product_offering_price_component_type_check` | `component_type IN ('usage_rate','flat_fee','capacity_commitment','capacity_motivation')` — four values; `negotiated_override` **excluded** (D5) |
| `product_offering_price_envelope_type_check` | `component_type = price_component ->> '@type'` (Inv. #30) |
| `product_offering_price_usage_rate_check` | `usage_rate` ⇒ unit NOT NULL, period pair NULL, `params.ratePerUnit` a money string |
| `product_offering_price_flat_fee_check` | `flat_fee` ⇒ unit NULL, `params.amount` a money string, period pair present **iff** envelope `priceType = 'recurring'` |
| `product_offering_price_capacity_commitment_check` | `capacity_commitment` ⇒ unit NOT NULL, period pair NULL, `params.committedQuantity` a JSON number `> 0` (VI2) |
| `product_offering_price_capacity_motivation_check` | `capacity_motivation` ⇒ unit NOT NULL, period pair NULL, `params.steps` a non-empty array, strictly ascending and non-duplicate on `aboveQuantity > 0`, each `ratePerUnit` a money string (VI1) |

Money in SQL is `^[0-9]+(\.[0-9]+)?$` — the same rule as `moneyStringSchema` (pm47), written with a POSIX class so no escaping subtlety differs between the two homes. Quantities are asserted to be JSON **numbers** (`jsonb_typeof(...) = 'number'`), not strings that happen to parse: a quantity arriving as `"1000"` is a defect, not a variant (§1.24).

### D4. `steps` ascent needs one IMMUTABLE helper function

A CHECK cannot contain a subquery, and strict ascent over an array of unknown length cannot be expressed without one. pm46 therefore adds a single `IMMUTABLE` SQL function, `product.pricing_steps_ok(jsonb) → boolean`, called from the `capacity_motivation` CHECK.

Considered and rejected: a second `BEFORE INSERT OR UPDATE` validation trigger on this table (it would sit beside pm36's DRAFT guard and blur which one refused a write — and §6.8 forbids modifying that trigger); and leaving ascent to Zod alone (guardrail 32 requires the database to refuse the same malformed object **independently of Zod**).

The function is schema-local, takes the array, returns a boolean, and touches no table — which is what makes `IMMUTABLE` truthful and the CHECK legal. It is **not** a pricing computation (Inv. #43): it validates shape, it never evaluates a schedule.

### D5. The Zod union has five branches; the CHECK admits four

`negotiated_override` is a logical/TMF projection whose physical row lives in `ordering.order_item_price_override` — insert-only, one per `(order_item, price_type)`, scalar `amount` + `currency` (PC9, Inv. #16, #39). Admitting it to the `component_type` enum would create a second, contradictory home for a negotiated price. An attempted insert is refused by `product_offering_price_component_type_check`, and that is tested explicitly (I4), because "it is excluded" is a claim a test must own.

### D6. The uniqueness rekey — `NULLS NOT DISTINCT`, once (G-F)

```
-- delivered (pm35 baseline)
CREATE UNIQUE INDEX product_offering_price_type_start_unique
  ON product.product_offering_price (product_offering_id, price_type, start_date_time);

-- after pm46
ALTER TABLE product.product_offering_price
  ADD CONSTRAINT product_offering_price_component_start_unique
  UNIQUE NULLS NOT DISTINCT (product_offering_id, component_type, unit_of_measure, start_date_time);
```

`unit_of_measure` is NULL on every `flat_fee` row and a plain UNIQUE treats two NULLs as distinct, so without `NULLS NOT DISTINCT` two identical `flat_fee` rows sharing a `start_date_time` would both insert and VI4 would silently not hold. This follows the repo's own `0013_gl_mapping_nulls_not_distinct.sql` precedent. **A sentinel `unit_of_measure` string and a `COALESCE` expression index are both excluded** (§6.4); architecture §3.4/§7, which proposed the expression form, are corrected by this unit.

**It becomes a UNIQUE constraint, not a unique index — verified, not stylistic.** drizzle-orm 0.45.2 exposes `nullsNotDistinct()` on the **unique-constraint** builder only (`node_modules/drizzle-orm/pg-core/unique-constraint.d.ts`), not on `uniqueIndex()`. A UNIQUE constraint creates its own implicit unique index, so nothing is lost; what changes is that the frozen object name is a constraint name, and guardrail 13 records it as such (D8).

**The `lead()` window must partition on the same key.** Once uniqueness is per `(component_type, unit_of_measure)`, the derived-end window in the repository (pm49) and in both runtime readers (pm51, pm52) partitions by `(product_offering_id, component_type, unit_of_measure)`. That is what makes §2.6's per-lane effectivity correct and stops a `capacity_motivation` from superseding the `usage_rate` beside it. pm46 does not touch those files; it records the requirement so the units that do cannot get it wrong.

### D7. pm36's trigger is not modified — the new columns fit under it as-is

The DRAFT-guard trigger fires `BEFORE INSERT OR UPDATE OR DELETE` on `product_offering_price` and reads the **parent's** `lifecycle_status`; it reads no price column. The reshape is therefore transparent to it — and that must be demonstrated rather than assumed: I4 asserts a direct SQL component insert against a `TESTING` parent is still refused by the trigger, and that deleting a `DRAFT` parent still cascades its components away.

### D8. Guardrail 13 is re-baselined, and its baseline changes shape

`tests/guardrails/product-module-boundaries.test.ts` freezes `PRICE_COLUMNS`. pm46 changes that list for the first time since pm02: four names leave, two arrive. The re-baseline also asserts the **absence** of the four dropped columns and the four dropped CHECKs, the presence of the six new CHECK names, the `product.pricing_steps_ok` function, the UNIQUE constraint **with its `NULLS NOT DISTINCT` modifier**, and the `component_type` index — in the SQL of record and the Drizzle mirror alike. Still an exact diff, never a removal (§9). Re-baselining also repairs the `ship-gate-guardrails` fixture, which carries the old column set.

### D9. No backfill — and its absence is asserted

PC14 runs under fresh install: the old shape is deleted, not migrated. No `db/migrations/*backfill*`, no data-fix script, no relabelling migration, no dual-read shim, and no compatibility read of `amount` "just in case" (§1.30, §7.7). pm46's guardrail **asserts the absence** — a glob over `db/migrations/**` and `scripts/**` matching nothing — because workflow §8.5 requires the absence be proved, not merely observed.

### D10. What pm46 deliberately does not do

No Zod schema (pm47), no seed edit (pm48), no repository, service, action or read-model change (pm49), no rendering (pm53), no authoring UI (pm54/pm55), no reader re-key (pm50/pm51/pm52), and **no `specVersion` CHECK** — envelope-field presence beyond the discriminator is Zod's job (Inv. #31, #44) and is swept as a data assertion over every stored row at pm56.

---

## Sequencing — pm46 is schema-first and NOT independently CI-green

Dropping four columns breaks the repository, the two price services, the read models, the seeds, `order-preconditions.ts`, both price panels, `rp.py`, the bill-run flow SQL and every price-shaped fixture, all at once. O3 resolved against a phased retirement and §1.30 forbids a dual-read shim, so no green intermediate cut exists. Per **gate G-E**, pm46 lands on the **pm46–pm54 feature branch**, merges to `main` only inside that branch's single squashed commit, and the full-suite-green claim is made once, at pm54. A standalone pm46 commit leaves the tree red **by design** — do not green it by editing consumers here; each consumer has its own unit.

**Doc correction owed with this unit:** code-standards §6.22 still says the window is "pm46–pm49" with the green claim "at pm49". G-E (2026-09-21) widened it to **pm46–pm54, claimed at pm54**. Fix it in I6 rather than leaving two numbers in circulation.

---

## Implementation

### I1. `db/migrations/0006_product.sql` — the table body

In `CREATE TABLE "product"."product_offering_price"`:

1. **Remove** the column lines `"price_type" text NOT NULL`, `"amount" numeric`, `"pricing_model" text NOT NULL`, `"pricing_characteristics" jsonb`.
2. **Add**, immediately after `"name"`, the two new columns:

```sql
	"component_type" text NOT NULL,
	"price_component" jsonb NOT NULL,
```

3. **Remove** the constraint lines `product_offering_price_type_check`, `product_offering_price_pricing_model_check` and `product_offering_price_amount_xor_tiers_check`. Keep `product_offering_price_currency_check`, `product_offering_price_period_value_check` and `product_offering_price_unit_value_check` byte-identical.
4. **Add** the six constraints of D3, in this order, in the table's constraint list:

```sql
	CONSTRAINT "product_offering_price_component_type_check" CHECK (
	  component_type IN ('usage_rate','flat_fee','capacity_commitment','capacity_motivation')
	),
	CONSTRAINT "product_offering_price_envelope_type_check" CHECK (
	  component_type = price_component ->> '@type'
	),
	CONSTRAINT "product_offering_price_usage_rate_check" CHECK (
	  component_type <> 'usage_rate' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND price_component #>> '{params,ratePerUnit}' ~ '^[0-9]+(\.[0-9]+)?$'
	  )
	),
	CONSTRAINT "product_offering_price_flat_fee_check" CHECK (
	  component_type <> 'flat_fee' OR (
	    unit_of_measure IS NULL
	    AND price_component #>> '{params,amount}' ~ '^[0-9]+(\.[0-9]+)?$'
	    AND (
	      (price_component ->> 'priceType' = 'recurring'
	         AND recurring_charge_period_length IS NOT NULL
	         AND recurring_charge_period_type IS NOT NULL)
	      OR
	      (price_component ->> 'priceType' <> 'recurring'
	         AND recurring_charge_period_length IS NULL
	         AND recurring_charge_period_type IS NULL)
	    )
	  )
	),
	CONSTRAINT "product_offering_price_capacity_commitment_check" CHECK (
	  component_type <> 'capacity_commitment' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND jsonb_typeof(price_component #> '{params,committedQuantity}') = 'number'
	    AND (price_component #>> '{params,committedQuantity}')::numeric > 0
	  )
	),
	CONSTRAINT "product_offering_price_capacity_motivation_check" CHECK (
	  component_type <> 'capacity_motivation' OR (
	    unit_of_measure IS NOT NULL
	    AND recurring_charge_period_length IS NULL
	    AND recurring_charge_period_type IS NULL
	    AND product.pricing_steps_ok(price_component #> '{params,steps}')
	  )
	)
```

5. The helper function must be created **before** the table (a CHECK resolves its function at DDL time). Place it after the schema/sequence preamble, in its own statement followed by a `--> statement-breakpoint` marker:

```sql
CREATE FUNCTION product.pricing_steps_ok(steps jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT steps IS NOT NULL
     AND jsonb_typeof(steps) = 'array'
     AND jsonb_array_length(steps) > 0
     AND NOT EXISTS (
           SELECT 1
           FROM   jsonb_array_elements(steps) AS s(v)
           WHERE  jsonb_typeof(s.v -> 'aboveQuantity') <> 'number'
              OR  (s.v ->> 'aboveQuantity')::numeric <= 0
              OR  COALESCE(s.v ->> 'ratePerUnit', '') !~ '^[0-9]+(\.[0-9]+)?$'
         )
     AND (
           SELECT COALESCE(bool_and(prev IS NULL OR cur > prev), true)
           FROM (
             SELECT (s.v ->> 'aboveQuantity')::numeric AS cur,
                    lag((s.v ->> 'aboveQuantity')::numeric) OVER (ORDER BY s.ord) AS prev
             FROM   jsonb_array_elements(steps) WITH ORDINALITY AS s(v, ord)
           ) t
         );
$fn$;
```

`cur > prev` is strict, so a duplicate threshold fails the same test as a descending one — one rule, one failure mode. Ordinality is array order, which is the order the UI keeps and the order a reader walks.

6. **Replace** the `CREATE UNIQUE INDEX "product_offering_price_type_start_unique" …` statement with D6's `ALTER TABLE … ADD CONSTRAINT "product_offering_price_component_start_unique" UNIQUE NULLS NOT DISTINCT (…)`, at the same position in the file.
7. **Add** the discriminator index beside the existing offering index:

```sql
CREATE INDEX "product_offering_price_component_type_idx" ON "product"."product_offering_price" USING btree ("component_type");--> statement-breakpoint
```

8. Touch nothing else: not the `products` PERMISSIONS insert, not the sequences, not `product_offering`, not `product_specifications`, not the FK statements, and not one `--> statement-breakpoint` marker (the migrator and the bootstrap runners split on them).

### I2. `db/schema/product.ts`

1. Delete the `priceType`, `pricingModel`, `amount` and `pricingCharacteristics` column definitions and the `TieredPricingCharacteristics` import that typed the last one.
2. Add `componentType: text("component_type").notNull()` and `priceComponent: jsonb("price_component").$type<PricingComponent>().notNull()`, importing the type **type-only** from `validation/product/pricing-component.schema.ts`.
3. Delete the three `check(...)` entries for the dropped CHECKs; add the six of I1 with identical names and identical predicates — the database owns the rule, Drizzle mirrors it (§6.5).
4. Replace the `uniqueIndex("product_offering_price_type_start_unique")` entry with `unique("product_offering_price_component_start_unique").on(t.productOfferingId, t.componentType, t.unitOfMeasure, t.startDateTime).nullsNotDistinct()`, and add `index("product_offering_price_component_type_idx").on(t.componentType)`.
5. Add a comment above the unique constraint stating **why** `nullsNotDistinct()` is there (`flat_fee`'s NULL unit) and that the `lead()` window partitions on the same key — the two facts a later reader will otherwise separate.
6. Change nothing else on this table, and nothing at all on the other two.

**Import sequencing.** `$type<PricingComponent>()` needs pm47's type. Two legal orders exist inside the same feature branch: land pm47's `pricing-component.schema.ts` first and import it here, or land pm46 with `$type<unknown>()` and tighten it at pm47. **Take the first.** pm47 is a pure validation file with no DB dependency, the branch is squashed anyway, and a temporary `unknown` is exactly the kind of shim §1.21 exists to prevent. Record the choice in the commit message.

### I3. `db/migrations/0007_*.sql` — one constraint removed

`product_offering_price_amount_check` lives in `0007`, not `0006` (pm35 §I1.2 recorded this deliberately). The `amount` column is gone, so the constraint cannot survive. **Opening `0007` is a second in-place migration edit and is covered by the same G-C grant** — but say so in the commit message and in code-standards §6.14, because the grant's text names `0006`. Remove only that one statement; change nothing else in the file and leave its journal entry untouched.

### I4. New test — `tests/db/product-price-component-constraints.integration.test.ts`

Live-DB integration test issuing **raw SQL** (never the repository), one case per rule, each asserting the rejection names the expected constraint:

| Case | Expectation |
| --- | --- |
| Valid `usage_rate` (unit `EA`, `ratePerUnit "100"`, `rateCardLookUp null`) | inserts |
| Valid `flat_fee` `recurring` (`amount "5000"`, unit NULL, period 1/`months`) | inserts |
| Valid `flat_fee` `oneTime` (`amount "250"`, unit NULL, no period) | inserts |
| Valid `capacity_commitment` (`committedQuantity 1000`, unit `EA`) | inserts |
| Valid `capacity_motivation` (`steps [{1000,"50"},{2000,"25"}]`, unit `EA`) | inserts |
| `component_type = 'negotiated_override'` | rejected, `…_component_type_check` (D5) |
| `component_type = 'usage_rate'` with envelope `@type: 'flat_fee'` | rejected, `…_envelope_type_check` (Inv. #30) |
| `usage_rate` with NULL `unit_of_measure` | rejected, `…_usage_rate_check` |
| `usage_rate` carrying a charge period | rejected, `…_usage_rate_check` |
| `usage_rate` with `ratePerUnit: 100` (number, not string) | rejected, `…_usage_rate_check` |
| `flat_fee` with no `params.amount` | rejected, `…_flat_fee_check` |
| `flat_fee` carrying a `unit_of_measure` | rejected, `…_flat_fee_check` |
| `flat_fee` `recurring` with no period pair | rejected, `…_flat_fee_check` |
| `flat_fee` `oneTime` carrying a period pair | rejected, `…_flat_fee_check` |
| `capacity_commitment` with `committedQuantity` `0` / `-5` | rejected, `…_capacity_commitment_check` (VI2) |
| `capacity_commitment` with `committedQuantity: "1000"` (string) | rejected, same |
| `capacity_motivation` with `steps: []` | rejected, `…_capacity_motivation_check` (VI1) |
| `capacity_motivation` with descending steps `[{2000},{1000}]` | rejected, same |
| `capacity_motivation` with duplicate thresholds `[{1000},{1000}]` | rejected, same |
| `capacity_motivation` with `aboveQuantity: 0` | rejected, same |
| `capacity_motivation` with a step `ratePerUnit: 50` (number) | rejected, same |
| Two `flat_fee` rows, unit NULL, one offering, one `start_date_time` | second rejected, `…_component_start_unique` (G-F) |
| Two `usage_rate` rows, same unit, same `start_date_time` | second rejected, same |
| `usage_rate` `EA` + `capacity_motivation` `EA` at the same `start_date_time` | **both insert** — different lanes |
| Two `usage_rate` `EA` rows at different `start_date_time` (dated successor) | both insert |
| Direct SQL component insert against a `TESTING` parent | rejected by the pm36 trigger (D7) |
| Delete a `DRAFT` parent holding components | parent and children gone via cascade (D7) |

### I5. Guardrail 13 re-baseline — `tests/guardrails/product-module-boundaries.test.ts`

1. `PRICE_COLUMNS` becomes the reshaped list: `product_offering_price_id`, `product_offering_id`, `name`, `component_type`, `price_component`, `recurring_charge_period_length`, `recurring_charge_period_type`, `unit_of_measure`, `currency`, `gl_code`, `policy`, `start_date_time`, `created_at`. The offering and specification lists are **not** touched.
2. Add an absence assertion: `price_type`, `pricing_model`, `amount` and `pricing_characteristics` appear in neither `0006_product.sql`'s price-table body nor `db/schema/product.ts`'s `productOfferingPrice` block, and the four dropped CHECK names appear nowhere under `db/migrations/**`.
3. Assert the six new CHECK names, the `product.pricing_steps_ok` function, the unique constraint **with `NULLS NOT DISTINCT`**, and the `component_type` index exist in both the SQL of record and the Drizzle mirror.
4. Assert **no backfill artifact exists** (D9): nothing under `db/migrations/**` or `scripts/**` whose name matches `/backfill|data-?fix|migrate-price/i`.
5. Repair the `ship-gate-guardrails` fixture's price-column expectations in the same change set.

### I6. Documentation landed with this unit

1. `prodmgmt-architecture.md` §3.4 — **replace** the "Design note — NULL collision, unresolved" block with the G-F resolution: `NULLS NOT DISTINCT`, granted 2026-09-21, expressed as a UNIQUE constraint for the drizzle reason (D6); record the `COALESCE` proposal as **rejected**, do not silently delete it.
2. `prodmgmt-architecture.md` §7 — remove the "`unit_of_measure` NULL collision needs confirming" gap; it is closed.
3. `prodmgmt-architecture.md` §6 — mark Inv. **#2**, **#4**, **#28** amended, **#5** retired, **#30–#44** in force (the G-B amendments this unit lands, workflow §7.1).
4. `prodmgmt-code-standards.md` §6.14 — record the **G-C grant** (decider, date, and that it covers I3's `0007` constraint removal), leaving the forward-only rule intact for everything else.
5. `prodmgmt-code-standards.md` §6.22 — correct the window to **pm46–pm54, green claimed at pm54** (G-E, 2026-09-21).
6. `prodmgmt-code-standards.md` Appendix A — clear **A1**, **A3**, **A4**, **A8** by grep; annotate **A6** with the G-C grant and its date.
7. `prodmgmt-code-standards.md` §7/§9 markers and `prodmgmt-architecture.md`'s "Baseline (delivered…)" paragraph — the **G-A** correction, recorded where found (workflow §7.10). If G-0 has been closed by then, the correction is that the claim is now true and verified on date X; if not, that it is unverified.
8. `pm00-build-plan.md` — Part 4 gate table: G-C **GRANTED**, G-F **RESOLVED (`NULLS NOT DISTINCT`)**.
9. `context/architecture.md` §3 — the platform JSONB example still names `pricing_model`. The follow-up is **owned by whoever lands pm46** (§6.12): do it here and note it in pm56's checklist so it is not done twice.

---

## Dependencies

**Packages to install: none.** No npm dependency, no PostgreSQL extension, no dev tool. Uses `drizzle-orm@0.45.2` (whose `nullsNotDistinct()` lives on the unique-constraint builder — verified in `node_modules`), `postgres` (the migrator's driver), `vitest` with the live-DB integration harness, and local Docker PostgreSQL 17 (`NULLS NOT DISTINCT` needs PG ≥ 15; `jsonb_array_elements … WITH ORDINALITY` is long-standing).

**Commands used:** `npm run db:migrate`, `npm run db:setup`, `npm run test`, `npx tsc --noEmit`, `npm run lint`.
**Command explicitly not used:** `npm run db:generate` (`drizzle-kit generate`) — retired in this repo.

**Prerequisite state:** a database that can be dropped and rebuilt; every environment re-runs `db:setup` from empty after this unit.

---

## Verification checklist

Structural

- [ ] `0006_product.sql` declares `component_type` and `price_component`, both `NOT NULL`, and declares none of `price_type`, `pricing_model`, `amount`, `pricing_characteristics`.
- [ ] The three dropped CHECKs are gone from `0006`; `product_offering_price_amount_check` is gone from `0007`; no other statement in either file changed.
- [ ] The six new CHECKs exist with D3's names; `product.pricing_steps_ok` is declared `IMMUTABLE` **before** the table.
- [ ] `product_offering_price_component_start_unique` is a UNIQUE constraint carrying **`NULLS NOT DISTINCT`**; `product_offering_price_type_start_unique` no longer exists.
- [ ] `product_offering_price_component_type_idx` exists; `product_offering_price_offering_idx` is unchanged.
- [ ] `db/schema/product.ts` mirrors all of the above; `price_component` is `$type<PricingComponent>()` and the type is a type-only import.
- [ ] `meta/_journal.json` and `meta/0006_snapshot.json` are byte-identical to before this unit; no snapshot written; `db:generate` not run.
- [ ] `git diff --stat` touches only `0006_product.sql`, one constraint in `0007`, `db/schema/product.ts`, the two test files and the I6 doc files.

Behavioural (fresh database, built from empty)

- [ ] `npm run db:migrate` completes on an **empty** database and produces the reshaped table.
- [ ] `tests/db/migration.integration.test.ts` passes — drop-all-schemas → `migrate()` from empty → idempotent second run.
- [ ] Every case in I4 passes, each rejection naming the expected constraint.
- [ ] Two NULL-unit `flat_fee` rows at one `start_date_time` are rejected; a `usage_rate` and a `capacity_motivation` in the same unit at the same instant both insert; dated successors insert.
- [ ] `component_type = 'negotiated_override'` is refused.
- [ ] A row whose `component_type` disagrees with its envelope `@type` is refused.
- [ ] A direct SQL component write against a non-`DRAFT` parent is refused by the pm36 trigger, unmodified; a `DRAFT` parent's delete still cascades.
- [ ] **No backfill, data-fix or relabelling script exists** — asserted by I5.4, not merely absent.

Regression

- [ ] Guardrail 13 is green on the new baseline; the `ship-gate-guardrails` fixture is repaired.
- [ ] The offering and specification column baselines are unchanged.
- [ ] `tsc --noEmit`, ESLint and Prettier are clean **for this unit's files**. The repository-wide suite is red by design until pm54 (§Sequencing) — do not green it here.
- [ ] No repository, service, action, component, validation or seed file changed in this unit.

Documentation

- [ ] All nine I6 corrections land in the same change set.
- [ ] G-C and G-F are recorded as resolved, with decider and date, in every doc that carried them open.

**Definition of done:** a developer rebuilds the database from empty and gets a price table in which every row is one self-describing pricing component — where a `capacity_motivation` with descending steps, a `flat_fee` carrying a unit, a quantity sent as a string and a second NULL-unit `flat_fee` on the same day are each refused by PostgreSQL, with the constraint name saying which rule was broken.
