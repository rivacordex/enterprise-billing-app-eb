# pm70 — Migration `0056` + Drizzle mirror + grants

**Status:** Built. The next unbuilt Part 6 unit is **pm71**.

**Unit:** pm70 (Part 6). **Boundary:** `db/migrations/0056_product_normalize_spec_price.sql` (new) + its `meta/_journal.json` entry; `db/schema/product.ts` (six tables, `relations()`, `price_type`, two columns removed); `db/bootstrap/billrun-db-roles.sql`, `rating-db-roles.sql`, `bootstrap-db-roles.sql` (one enumerated statement each); guardrail **13** re-baselined and guardrail **50** landed, with one committed pre-state fixture. **No repository, no service, no seed, no action, no component, no reader.** `0006`, `0040`, `0049` and `reporting-db-roles.sql` are not opened.
**Specs from:** `_updatemodule-product-normalize-spec-price-tables-plan.md` §2.2–§2.7, §3 (DRAFT guard), §4 option B, §5 items 1–6, 9, **Q1–Q4** · `prodmgmt-update-overview.md` › Goals 1–8, 10–11, Features, Migration and backfill · `prodmgmt-architecture.md` §1, §2, §3.1–§3.6, §5, Inv. **#62, #63, #64, #66, #67, #69, #70, #71**, amended **#2, #28, #30, #31, #37, #38** · `prodmgmt-code-standards.md` §1.57, §2.27–§2.29, **§6.35–§6.44**, §7.13, §7.16, guardrails **13**, **50** (and the DB arms of 43, 44, 45, 48 that pm71/pm75 assert) · `prodmgmt-ai-workflow-rules.md` §0 (every row), §0.1 **G-N1, G-N2, G-N5, G-N6a**, §0.2 row 2, §1.5, §2.3, §3.2–§3.5, §3.7, §4.2, §4.7, §5.4–§5.6, §6.2–§6.4, §6.8, §7.6–§7.7, §8.3–§8.4, §8.9, Appendix A **W1, W10** · `pm00-build-plan.md` Part 6 › pm70 row, **C12, C13, C14**.
**Depends on:** **pm69** (the cap must be in force before any row is backfilled — pm69 D1); **G-N1** (Q1–Q4); **G-N2** (the Inv. #38 reversal, recorded before this file is written); **G-N5** (this unit opens the window and commits with `tsc` red); **G-N6a** (the `REVOKE`).

**Gates, in one paragraph each — none may be assumed.** **G-N2:** `product_offering_price.price_type` returns against a rule that said "never under any name". Until the design review is recorded (date + authorizer in architecture §6 Inv. #38 row and code-standards Appendix A row A18), write no `price_type` column, no pair-table FK and no `0056`; when it is, rewrite the `PriceCard` comment in `types/product.ts` (A18) in this unit — rewrite, never delete the reasoning. **G-N5:** dropping `price_component` breaks `tsc` in the repositories, services, seeds and 18 test files at once and a dual-read shim is forbidden; this unit is the first commit on the Part 6 feature branch and says `tsc red by G-N5; closes at pm73` in its message. Do not open the window on the G-E precedent alone. **G-N6a:** without the `REVOKE`, `app_runtime` holds DML on system data by schema default; if declined, Inv. #64 and guardrail 48's "read-only to the app" clause are rewritten first and the statement is omitted — the rest of this unit is unchanged.

---

## Goal

Land the whole storage shape of the Normalize update in one forward migration that creates the six tables and the view, seeds the reference rows, backfills every envelope and characteristic set into rows, **proves the backfill lossless before dropping anything**, extends the DRAFT guard to the new tables, and swaps the lane key to plain columns — mirrored by hand in Drizzle with the codebase's first `relations()`, granted by one enumerated statement per role, and verified alone against an empty database and against the seeded pre-state before one line of repository code changes.

---

## Design

### D1. One file, one journal entry, one transaction

`0056_product_normalize_spec_price.sql` is **one** migration file with **one** `meta/_journal.json` entry (`idx: 56`, `tag: "0056_product_normalize_spec_price"`, `breakpoints: true`, `when` **strictly greater than** `1791626400000` — the migrator applies a journal entry only when its `when` exceeds the last applied entry's; an earlier value is silently skipped, `db/migrations/README.md` item 4). Drizzle's postgres-js migrator runs every pending file inside **one transaction**, which is what makes the shape below safe: the deferred completeness triggers created in step 6 cannot fire against the backfilled rows (they are created after the rows and the whole file commits once), and `DISABLE TRIGGER` / `ENABLE TRIGGER` bracket the backfill without a window in which another writer could slip a header through.

**Re-check the number before writing the file** (C12, workflow §5.5). If `0056` is taken by then, take the next free number and fix every citation in one change set; never two files, never a second migration for the drops (workflow §4.7).

### D2. The order of operations — fixed, because each step is a precondition of the next

Numbered as code-standards §6.40 numbers them; the file's comments name the step.

1. **Reference tables, created and seeded.** `product.price_component_type` (`component_type` PK; `applies_at` CHECK `IN ('rating','billing','post_aggregation')`; `basis` CHECK `IN ('quantity','flat')`; `pla_spec_id` nullable; `apply_order integer NOT NULL`) and `product.price_component_price_type` (PK `(component_type, price_type)`, FK to the type table). Seed exactly four and exactly five rows — plan §2.3 values; `pla_spec_id` is `'PLA_CAPACITY_COMMITMENT'`, `'PLA_CAPACITY_MOTIVATION'` for the two capacity types and **`NULL` for both `flat_fee` and `usage_rate`** (Inv. #65 — usage-rate's is derived); `apply_order` with `capacity_commitment` strictly before `capacity_motivation` (PC12; guardrail 48 asserts the order, not the absolute values — use `10, 20, 30, 40` in PC12 stage order `usage_rate`, `flat_fee`, `capacity_commitment`, `capacity_motivation`).
2. **The five child tables, with constraints but not yet triggers.** Exactly the DDL of plan §2.2 and §2.5 with every constraint named per §6.39 (D4 below). `product_spec_characteristic` with its cascade FK to the spec; the four `pop_*` tables with the type-pinning pattern of §6.36. Their composite FK targets the header unique added in step 3, so **step 3's `UNIQUE` is added before step 2's FKs** — order the statements accordingly inside the file (the numbering is logical; the SQL adds the header unique first).
3. **Header: `price_type` nullable, and the pinning target.** `ALTER TABLE product.product_offering_price ADD COLUMN price_type text`, then `ADD CONSTRAINT product_offering_price_id_type_unique UNIQUE (product_offering_price_id, component_type)`. Nullable now because the backfill has not run; `NOT NULL` and the FK come in step 6.
4. **Backfill, with the header's DRAFT guard disabled.** `ALTER TABLE product.product_offering_price DISABLE TRIGGER product_offering_price_draft_guard` — the backfill `UPDATE`s released headers' `price_type`, which the guard refuses with `23514`; `app_migrate` owns the table so plain `DISABLE TRIGGER` works and `session_replication_role` is not used (§6.40). `product_specifications_draft_guard` is **not** disabled: nothing writes that table, and `product_spec_characteristic` has no trigger yet. Then, set-based, no loops:
   - `UPDATE … SET price_type = CASE component_type WHEN 'flat_fee' THEN price_component ->> 'priceType' WHEN 'usage_rate' THEN 'usage' WHEN 'capacity_commitment' THEN 'commitment' WHEN 'capacity_motivation' THEN 'discount' END`.
   - `INSERT INTO pop_usage_rate (product_offering_price_id, rate_per_unit, rate_card_lookup) SELECT …, (price_component #>> '{params,ratePerUnit}')::numeric, price_component #>> '{params,rateCardLookUp}' … WHERE component_type = 'usage_rate'` — `component_type` takes its default. Likewise `pop_flat_fee` from `{params,amount}`, `pop_capacity_commitment` from `{params,committedQuantity}`.
   - `INSERT INTO pop_motivation_step … SELECT p.product_offering_price_id, (s ->> 'aboveQuantity')::numeric, (s ->> 'ratePerUnit')::numeric FROM product_offering_price p, jsonb_array_elements(p.price_component #> '{params,steps}') AS s WHERE p.component_type = 'capacity_motivation'`.
   - `INSERT INTO product_spec_characteristic (product_spec_id, char_name, char_value, display_order) SELECT ps.product_spec_id, e.key, e.value, e.ordinality FROM product_specifications ps, jsonb_each_text(ps.product_spec_characteristics) WITH ORDINALITY AS e(key, value, ordinality)`. **This is the one place today's alphabetical (jsonb key) order is frozen into `display_order`** (architecture §3.5) — recorded, not hidden: backfilled specifications read back in the order they rendered in yesterday, which is the only order anyone has ever seen.
5. **Verify in SQL, abort on the first mismatch.** One `DO $$ … $$` block (precedent: `0040`, `0053`) that, for every header, rebuilds the envelope from the new rows and compares it **as jsonb** to `price_component`, and for every spec compares `jsonb_object_agg(char_name, char_value)` (or `'{}'::jsonb` when no rows) to `product_spec_characteristics`; on the first inequality `RAISE EXCEPTION 'product_normalize_backfill_mismatch: % …' USING ERRCODE = 'P0001'` with the row id, which aborts the whole migration — nothing after this step has run, and nothing before it is committed. Rules for the rebuild, so the comparison is exact rather than lucky:
   - jsonb equality is key-order-independent; build the object with `jsonb_build_object` in any order.
   - Money is compared **normalized on both sides**: `trim_scale(ur.rate_per_unit)::text` against `trim_scale((price_component #>> '{params,ratePerUnit}')::numeric)::text`, and the same for `amount` and every step's `ratePerUnit` — because the original may carry trailing zeros (`"5500.00"` in the demo seeds, pm69 C18) that `numeric` cannot keep. The comparison therefore proves **numeric** equality of money, which is the property that matters; textual equality is pm71's round-trip concern.
   - Quantities are JSON numbers on both sides; jsonb compares numerics by value, so `1000` equals `1000.000000`.
   - The constant fields (`specVersion`, `appliesAt`, `basis`, `plaSpecId`, `boundTo`, `priceType`) are rebuilt from `price_component_type`, the header's `unit_of_measure` and `price_type`, and `rate_card_lookup IS NOT NULL` — so a stored envelope whose `appliesAt` disagrees with its type, or whose `params` carries a key the schema does not know, **mismatches and aborts**. That is the correct outcome: such a row is corruption the JSON CHECKs never caught, and §5.4 of the workflow says stop and ask, never loosen the comparison.
   - Steps are rebuilt `ORDER BY above_quantity`; the original is strictly ascending by `pricing_steps_ok`, so order agrees.
6. **Constraints, triggers and the guard extension.** `ALTER COLUMN price_type SET NOT NULL`; `ADD CONSTRAINT product_offering_price_price_type_fk FOREIGN KEY (component_type, price_type) REFERENCES product.price_component_price_type`; `ENABLE TRIGGER product_offering_price_draft_guard`. Create `product.price_header_is_complete()` and the five `_complete_ct` constraint triggers (D5). `CREATE OR REPLACE FUNCTION product.child_write_requires_draft()` with the five new `TG_TABLE_NAME` branches (D6) and the five `<table>_draft_guard` triggers.
7. **Swap the lane key, drop the old objects, create the view.** `DROP INDEX product.product_offering_price_lane_start_unique` (the `0049` expression index) then `CREATE UNIQUE INDEX product_offering_price_lane_start_unique ON product.product_offering_price (product_offering_id, component_type, unit_of_measure, price_type, start_date_time) NULLS NOT DISTINCT` — **same name, same object kind** (C14, D7). Drop the six JSON CHECKs by name, drop `product.pricing_steps_ok(jsonb)`, re-add the four per-type unit/period CHECKs under their existing names with JSON-free bodies (D8), `DROP COLUMN price_component`, `DROP COLUMN product_spec_characteristics`. Then `CREATE VIEW product.offering_price_v` (D9) — last, so it never references a column that is about to go.

### D3. Why the drops are in this file and not a later one

Two migrations for one change puts the backfill and the drops in different transactions; a header written between them (the app is not down during a gated migration step) would exist in JSON only and be lost. One file, one transaction, drops after verification (workflow §4.7, Inv. #71). The release that carries this file carries the readers (pm74, pm74b) — recorded as a deployment rule in pm75, and as a **bootstrap note here**: the three role bootstraps grant on the view, so every environment that already ran them must **re-run `db:bootstrap-roles`, `db:bootstrap-billrun-roles` and `db:bootstrap-rating-roles` after `0056`** (the scripts are idempotent); a fresh `db:setup` needs nothing extra. Put that sentence in the migration's header comment and in the progress tracker.

### D4. Names — hand-written, ≤ 63 bytes, identical in SQL, Drizzle and the guardrail

Every new constraint, index and trigger is named exactly as code-standards §6.39 lists them; Drizzle's derived FK name for the subtype FKs is 67 bytes and would be truncated by Postgres into something the schema-diff guardrail cannot predict. The function and trigger names of §6.37/§6.38 (`price_header_is_complete`, `<table>_complete_ct`, `<table>_draft_guard`) and the view's name and column set of §6.43 are binding for two other modules' SQL (pm74, pm74b); none is a tidy-up candidate. Guardrail 13 adds `Buffer.byteLength(name) <= 63` over every name this unit introduces.

### D5. Completeness — one function, five constraint triggers, all deferred

`product.price_header_is_complete()` is `RETURNS trigger LANGUAGE plpgsql`, resolves the header id from `NEW` (header `AFTER INSERT OR UPDATE`) or `OLD.product_offering_price_id` (each child table `AFTER UPDATE OF product_offering_price_id OR DELETE`), **passes if the header no longer exists** (the discard cascade: offering → header → subtype → steps, the header is gone by the time the child's `AFTER DELETE` fires), locks the header with `FOR NO KEY UPDATE` while reading its `component_type`, then checks: `usage_rate` → one `pop_usage_rate` row; `flat_fee` → one `pop_flat_fee`; `capacity_commitment` → one `pop_capacity_commitment`; `capacity_motivation` → `EXISTS` at least one `pop_motivation_step`. On failure `RAISE EXCEPTION 'product_price_header_incomplete: header % (%) has no …' USING ERRCODE = '23514'` — the same code the DRAFT guard uses, so a bypassed-Zod write surfaces as the same class of refusal (§1.51 throws it; no mapping).

Each of the five is `CREATE CONSTRAINT TRIGGER … AFTER … ON … DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION product.price_header_is_complete()`. The platform's one prior `DEFERRABLE` is a customer FK (`0009`); this is its first deferred **trigger** — say so in the comment, and say why a CHECK cannot do it (a CHECK sees one row; completeness is a fact about two tables).

**A consequence to write down:** a `DRAFT` header whose `component_type` is edited in place now needs the §1.50 order (delete subtype → update header → insert subtype) because the composite FK is `NO ACTION` on update; the deferred trigger makes the intermediate state legal, the FK is what forbids a bare header `UPDATE` (Inv. #70). This unit proves it with direct SQL (I6); pm71 implements it.

### D6. The DRAFT guard — extended by `CREATE OR REPLACE`, never by editing `0040`

The `0040` function branches on `TG_TABLE_NAME` because PL/pgSQL plans each expression on first execution of its **own** statement — a single `CASE` across tables fails to plan (the `0040` comment). The replacement keeps both existing branches **byte-for-byte** and adds five, each reading only columns the firing table has:

| `TG_TABLE_NAME`                                                                         | Parent id resolution                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `product_spec_characteristic`                                                           | `SELECT ref_product_offering_id FROM product.product_specifications WHERE product_spec_id = OLD/NEW.product_spec_id`                             |
| `pop_usage_rate`, `pop_flat_fee`, `pop_capacity_commitment`, `pop_motivation_step`      | `SELECT product_offering_id FROM product.product_offering_price WHERE product_offering_price_id = OLD/NEW.product_offering_price_id`             |

A grandchild whose **parent** is gone resolves `NULL` and passes — that, plus the existing "offering not found → pass", is what lets a discarded `DRAFT` cascade through three levels with no orphans (Inv. #69). The re-parenting guard (OLD-side and NEW-side, pm36 D2) applies unchanged: a grandchild cannot be moved from a released parent's child to a `DRAFT` one by direct SQL. Five `BEFORE INSERT OR UPDATE OR DELETE` triggers named `<table>_draft_guard`. `0040_product_family_guards.sql` is **byte-identical** after this unit (W1; guardrail 13 asserts the file hash as it does for `0006`).

### D7. The lane key — plain columns, same name, same kind (C14 settled here)

The lane becomes `(product_offering_id, component_type, unit_of_measure, price_type, start_date_time)` `NULLS NOT DISTINCT`. It is **equivalent** to `0049`'s key: `price_type` is a constant per type for every non-`flat_fee` type (so the term adds nothing to their key, exactly as the `CASE` evaluated to `NULL` for them), and for `flat_fee` it equals the envelope's `priceType` by the backfill in step 4. Existing rows therefore cannot violate it, and the swap needs no data step.

**C14 decision: it stays a unique index**, created in SQL with `NULLS NOT DISTINCT`, under the unchanged name `product_offering_price_lane_start_unique` — `services/product/insert-price.ts` translates a `23505` on that name to `DUPLICATE_START` (§1.51, §6.34), and keeping the object kind keeps the error's `constraint` field identical. In Drizzle it is `uniqueIndex("product_offering_price_lane_start_unique").on(productOfferingId, componentType, unitOfMeasure, priceType, startDateTime)`; `uniqueIndex()` has no `nullsNotDistinct()` in drizzle-orm 0.45 (only the `unique()` constraint builder does — Part 4 G-F), so the clause is SQL-only, as today, and guardrail 13 asserts it in `pg_indexes`. A `unique()` constraint with `.nullsNotDistinct()` was considered and rejected because it would change the object kind under a name the service keys off. Record the decision in code-standards §6.34.

### D8. The four per-type CHECKs — same names, JSON-free bodies, keyed on `price_type`

`product_offering_price_usage_rate_check`, `_flat_fee_check`, `_capacity_commitment_check`, `_capacity_motivation_check` are dropped and re-added under the same names (the schema-diff guardrail keys on names). New bodies: `usage_rate` and the two capacity types → `unit_of_measure IS NOT NULL AND recurring_charge_period_length IS NULL AND recurring_charge_period_type IS NULL`; `flat_fee` → `unit_of_measure IS NULL AND ((price_type = 'recurring' AND both period columns NOT NULL) OR (price_type = 'oneTime' AND both NULL))`. `component_type_check` and `envelope_type_check` are **dropped, not re-added**: the pair FK replaces both (§6.41). `currency_check`, `period_value_check`, `unit_value_check` are untouched.

### D9. The view — one projection, owner-privileged, not declared in Drizzle

`CREATE VIEW product.offering_price_v AS SELECT p.*, ct.applies_at, ct.basis, COALESCE(ct.pla_spec_id, CASE WHEN ur.rate_card_lookup IS NOT NULL THEN 'PLA_USAGE_RATE' END) AS pla_spec_id, ur.rate_per_unit, ur.rate_card_lookup, ff.amount, cc.committed_quantity, (SELECT jsonb_agg(jsonb_build_object('aboveQuantity', s.above_quantity, 'ratePerUnit', s.rate_per_unit) ORDER BY s.above_quantity) FROM product.pop_motivation_step s WHERE s.product_offering_price_id = p.product_offering_price_id) AS steps FROM product.product_offering_price p JOIN product.price_component_type ct USING (component_type) LEFT JOIN product.pop_usage_rate ur USING (product_offering_price_id) LEFT JOIN product.pop_flat_fee ff USING (product_offering_price_id) LEFT JOIN product.pop_capacity_commitment cc USING (product_offering_price_id)` — plan §2.7 verbatim; column names and the `steps` keys are a cross-module contract (§6.43). Created **without** `security_invoker` (default), so a `GRANT SELECT` on the view is a reader's entire surface and the subtype and reference tables need no grant (architecture §1, §3.6). Three facts to put in its comment: `p.*` is expanded at creation, so a future header column is **not** automatically exposed (a view change is a hand-off, not a tidy-up); `steps[].ratePerUnit` and `aboveQuantity` are JSON **numbers** (N-R4); the view is for `billrun_runtime` / `rating_runtime` (and `reporting_runtime` if G-N7 grants it) — **no application reader, and no Drizzle declaration** (§1.62, §7.16).

### D10. Grants — three statements, three files, one per role, enumerated

- `billrun-db-roles.sql`: `GRANT SELECT ON TABLE "product"."offering_price_v" TO billrun_runtime;` in the bm41/bm68 style (a comment naming pm70 and Inv. #67), after the existing `product` grants.
- `rating-db-roles.sql`: the same for `rating_runtime`, in the Step 7 / 7a style.
- `bootstrap-db-roles.sql`: after the `product` schema's `ALTER DEFAULT PRIVILEGES` block, `GRANT SELECT ON TABLE "product"."price_component_type", "product"."price_component_price_type" TO app_runtime;` then `REVOKE INSERT, UPDATE, DELETE ON TABLE "product"."price_component_type", "product"."price_component_price_type" FROM app_runtime;` — the bm64 / bm50 `customer_bill_line` pattern (GRANT SELECT first, idempotent, then REVOKE only the writes), so the statement is correct whether or not the default privilege fired on a from-scratch database. **G-N6a.**
- **Nothing** on `pop_*` for any non-app role; **nothing** in `reporting-db-roles.sql` (its drift guard enumerates the reporting surface and would fail provisioning); never `ON ALL TABLES`, never `ALTER DEFAULT PRIVILEGES` for a non-app role (platform §4).

### D11. The Drizzle mirror — hand-synced, with the codebase's first `relations()`

In `db/schema/product.ts`, in this order after `productOfferingPrice`: `priceComponentType`, `priceComponentPriceType`, `popUsageRate`, `popFlatFee`, `popCapacityCommitment`, `popMotivationStep`, `productSpecCharacteristic` — every column, CHECK, FK, PK and unique exactly as the SQL names them (D4), `numeric(…, { precision, scale, mode: "string" })` in the house style of the rate-card table, `.$type<ComponentType>()` / `<AppliesAt>()` / `<Basis>()` / `<EnvelopePriceType>()` on the typed text columns (§2.29; **no** type named `PriceType` is created). On the header: `priceType: text("price_type").notNull().$type<EnvelopePriceType>()`, the `(id, component_type)` `unique()`, the lane `uniqueIndex` of D7, the four re-bodied CHECKs, the six JSON CHECKs gone, `priceComponent` gone with its `import type { PricingComponent }`. On `productSpecifications`: `productSpecCharacteristics` gone with its `import type`. The view is **not** declared.

`relations()` (§2.27): `productOfferingPriceRelations` with `offering: one(productOffering)`, `usageRate: one(popUsageRate)`, `flatFee: one(popFlatFee)`, `capacityCommitment: one(popCapacityCommitment)`, `motivationSteps: many(popMotivationStep)`, **and a sixth, `type: one(priceComponentType, { fields: [productOfferingPrice.componentType], references: [priceComponentType.componentType] })`** — not in §2.27's list of five, added here so pm71's `toEnvelope` can take `appliesAt` / `basis` / `pla_spec_id` **from the reference table** (§1.59) inside the **one** detail query (§3.24, §7.14) instead of a TypeScript constant; record the sixth name in §2.27 (workflow §7.9); `productSpecificationsRelations` with `characteristics: many(productSpecCharacteristic)`. Drizzle resolves a `many` through the child's `one`, so each child table also declares its inverse `one(productOfferingPrice | productSpecifications, { fields, references })` — six small relation objects beside their tables, all exported through `db/schema/index.ts`'s existing `export *`. `db/client.ts` already passes `{ schema }` and needs no change; nothing in this unit calls `db.query.*` (pm71 is the first caller). `drizzle-kit generate` is never run (README); no snapshot is written.

**Before applying `0056` to any target:** run the [pm69 D1 precision preflight](pm69-decimal-helper-and-zod-scale-caps.md#d1-why-this-lands-first-and-alone) and record the resolved outcome. Do not relax the parity check.

### D12. Guardrail 50 — the pre-state is a committed fixture, because the seeds will stop producing it

After pm73 the seeds write through the repository and can no longer produce a `0055`-shaped database, so the backfill-parity test cannot seed its pre-state from them. It uses **one committed fixture**, `tests/fixtures/product/pre-0056-catalog.json`, captured **in this unit** from the `0055` tree: every demo and sample offering with its lifecycle status, specifications with their jsonb object, prices with their envelope — i.e. the rows `db:seed-demo` + the sample seeds produce today (take it from a freshly seeded database with `SELECT … FROM product.*`, not by hand). The test (`tests/db/product-normalize-backfill.integration.test.ts`):

1. Drops the schemas like every other suite, then runs Drizzle's `migrate()` against a **temporary migrations folder** holding copies of `0000`–`0055` and a journal truncated at `idx: 55` (built in `beforeAll` from `db/migrations/`; the migrator reads only the journal and the `.sql` files).
2. Loads the fixture with raw SQL in guard-legal order: offering as `DRAFT` → specs and prices with the jsonb → `UPDATE lifecycle_status` to the recorded value.
3. Runs `migrate()` against the real folder — which applies exactly `0056` (its `when` is the only one newer) — and asserts: zero rows left in the pre-state (the columns are gone), row counts per new table equal the fixture's component and characteristic counts, and for every header the view's columns plus `price_component_type` reconstruct the fixture's envelope with money compared after `trim_scale` (the same comparison the migration ran — asserted independently in TypeScript so the SQL verify is not grading its own homework).
4. **The abort case**, in a second `describe` with its own fresh database: after step 2, corrupt one `usage_rate` row with `UPDATE … SET price_component = price_component || '{"appliesAt":"billing"}'` (every JSON CHECK still passes; the rebuilt envelope's `appliesAt` comes from the reference table and will not match), run `migrate()`, assert it **throws** with `product_normalize_backfill_mismatch` in the message, and assert `price_component` and `product_spec_characteristics` **still exist**, no `pop_*` table exists, and `drizzle.__drizzle_migrations` has no `0056` row — nothing dropped, nothing recorded.

This is also the only test in the tree that applies a migration to a populated database; say so in its header so nobody "simplifies" it to a from-empty run.

### D13. What this unit does not do

- No repository, service, seed or fixture edit beyond D12's fixture (pm71–pm73). `tsc` is red at the end of this unit, by G-N5, and the commit says so.
- No reader edit (pm74, pm74b); no `reporting-db-roles.sql` edit (G-N7).
- No `step_no`, `sequence`, `currency` or `unit_of_measure` on a subtype table; no stored `pla_spec_id` on `pop_usage_rate`; no fifth reference row (workflow §3.2, §3.3).
- No second migration, no standalone backfill script, no compatibility view or column reproducing `price_component` (§6.41).
- No edit to `0006`, `0040`, `0049`; no `drizzle-kit generate`; no snapshot.

---

## Implementation

### I1. `db/migrations/0056_product_normalize_spec_price.sql` (new)

Header comment: the unit, the plan sections, Q1–Q4 as decided, the seven steps, the single-transaction fact, the bootstrap re-run note (D3), and the same-release rule (Inv. #72). Then the statements of D2 in order, each separated by `--> statement-breakpoint`, each step prefixed by a `-- step N` comment. Seed `INSERT`s carry the literal rows of plan §2.3. The verify block is one `DO $$` per aggregate (prices, then specifications) so a failure names which.

### I2. `db/migrations/meta/_journal.json`

Append `{ "idx": 56, "version": "7", "when": <next value, > 1791626400000, in the file's step>, "tag": "0056_product_normalize_spec_price", "breakpoints": true }`. No snapshot file.

### I3. `db/schema/product.ts`

Per D11. Remove the two `import type` lines that become unused. Keep the comment on the lane index, rewritten for the plain-column key and the C14 decision; keep `0049`'s reasoning as history in that comment (why `NULLS NOT DISTINCT`, why index not constraint).

### I4. `types/product.ts` (G-N2 only)

Rewrite the `PriceCard` comment that cites Inv. #38's "never reintroduce `price_type`" to record the reversal (date, authorizer, the FK that now constrains it, §1.58's two-columns rule). No type change; `EnvelopePriceType` is reused as-is.

### I5. Bootstrap SQL

Per D10 — three files, four statements, each with a comment naming pm70 and the invariant.

### I6. Tests

Guardrail **13**, re-baselined (`tests/db/product-schema.test.ts`, `tests/db/product-schema.integration.test.ts`):

1. Unit half: exact snake_case column sets for all nine `product` tables this update leaves (`product_offering_price` **with** `price_type` and **without** `price_component`; `product_specifications` without `product_spec_characteristics`; the six new tables).
2. Integration half, on a database migrated from empty: the six tables and the view exist; `price_component_type` has 4 rows and `price_component_price_type` 5 with the exact plan §2.3 values and `apply_order` ordering; every §6.39 constraint and index name exists and `Buffer.byteLength(name) <= 63`; `pg_indexes` shows the lane index with `NULLS NOT DISTINCT` and the five plain columns; five `_complete_ct` triggers are `DEFERRABLE INITIALLY DEFERRED`; five `_draft_guard` triggers exist; `pricing_steps_ok`, `component_type_check`, `envelope_type_check`, `price_component`, `product_spec_characteristics` are **absent**; `0006_product.sql`, `0040_product_family_guards.sql` and `0049_product_price_lane_key.sql` hash-identical to the committed baseline.
3. The existing "component_type disagrees with its envelope @type" test is **replaced** by the type-pinning assertions of guardrail 44 (direct SQL): `pop_flat_fee` for a `usage_rate` header → FK violation; header with `(flat_fee, usage)` → FK violation; `UPDATE component_type` on a header with a subtype row → FK violation.
4. Completeness (guardrail 43's DB arm, direct SQL): header committed alone → `23514` at COMMIT; motivation with zero steps → `23514`; delete a `DRAFT` motivation's only step and commit → `23514`; header + child in one transaction → accepted; two steps at one `above_quantity` → PK violation.
5. Lane (Inv. #2): two recurring `flat_fee` at one start → `23505` naming `product_offering_price_lane_start_unique`; recurring + oneTime at one start → accepted; `usage_rate` with NULL unit → `usage_rate_check` refuses (the JSON-free body still enforces unit/period).
6. DRAFT guard (guardrail 45's DB arm, extending `tests/db/product-family-guards.integration.test.ts`): a write to each of the five new tables under an `ACTIVE` version → `23514` naming `product_child_write_requires_draft`; discarding a `DRAFT` with a spec (two characteristics), a usage rate, a flat fee, a commitment and a motivation (two steps) → zero rows in every child table; re-parenting a `pop_flat_fee` row's header by direct SQL is refused by the FK before the guard matters.
7. Grants (the pm70 half of guardrail 47; `tests/rating/grants.integration.test.ts` and a new `tests/db/product-normalized-grants.integration.test.ts` in the `reporting-db-roles` style): after the three bootstraps, `has_table_privilege('billrun_runtime', 'product.offering_price_v', 'SELECT')` and the same for `rating_runtime` are true; both are false for every `pop_*` and reference table; `app_runtime` has `SELECT` and not `INSERT`/`UPDATE`/`DELETE` on the two reference tables; `reporting_runtime` has no privilege on the view or any new table; the reporting drift guard's bootstrap still completes.
8. Guardrail **50** per D12, including the abort case.

### I7. Documentation (lands with the unit)

1. **Architecture §6** — the amendments to #2, #28, #30, #31, #32, #37, #44 and the new #61–#73 marked **approved** with the date (workflow §7.1); Inv. #38's row carries the G-N2 record.
2. **Code-standards** — §6.34 records the C14 decision; §6.40 records the number actually claimed; §7 tree marks `0056`, `db/schema/product.ts`, the three bootstrap files and the four test files landed under pm70; **Appendix A rows A15, A16, A17, A18, A19, A20, A21, A24 cleared by grep** (the schema unit and the grants unit are this one — C13).
3. **`pm00-build-plan.md`** — C12, C13, C14 resolved with dates; G-N5 recorded as opened at pm70; the bootstrap re-run note added to N-R5.
4. **`prodmgmt-progress-tracker.md`** — pm70 landed (red by G-N5), and the backfill verification result recorded per environment it ran in: row counts per table and "0 mismatches", with the date (workflow §7.7).
5. **`_updatemodule-product-normalize-spec-price-tables-plan.md`** — not edited; the `0055` → `0056` correction is proposed to the owner under G-N1 (C12).

---

## Dependencies

**Packages to install: none.** `relations` comes from `drizzle-orm` as installed; `trim_scale` is Postgres 13+ and the platform pins 17.

**Commands used:** `npm run db:migrate` (empty database); the D12 suite; `npx vitest run --config vitest.integration.config.ts tests/db/product-schema.integration.test.ts tests/db/product-family-guards.integration.test.ts tests/db/product-normalize-backfill.integration.test.ts tests/db/product-normalized-grants.integration.test.ts`; `npm run db:bootstrap-roles && npm run db:bootstrap-rating-roles && npm run db:bootstrap-billrun-roles && npm run db:bootstrap-reporting-roles`. `npm run typecheck` is **expected red** (G-N5) and the failing files are listed in the commit message.

**Prerequisites:** pm69 merged on the branch; G-N1, G-N2, G-N5, G-N6a recorded.

---

## Verification checklist

Gates

- [ ] G-N1 (Q1–Q4), G-N2 (date + authorizer in architecture §6 and A18), G-N5 (window granted), G-N6a recorded before the file is written.
- [ ] The migration number re-checked at write time; one file, one journal entry, `when` greater than `0055`'s.

Migration from empty (workflow §8.3)

- [ ] Six tables, the view, five `_complete_ct` (deferred) and five `_draft_guard` triggers, `price_header_is_complete`, the extended `child_write_requires_draft`; 4 + 5 reference rows with plan §2.3 values and `capacity_commitment < capacity_motivation` in `apply_order`.
- [ ] No `price_component`, `product_spec_characteristics`, `pricing_steps_ok`, `component_type_check`, `envelope_type_check`; the four per-type CHECKs present under their old names with JSON-free bodies.
- [ ] Lane index: same name, same kind, five plain columns, `NULLS NOT DISTINCT` in `pg_indexes`.
- [ ] Every new name ≤ 63 bytes and identical in SQL, Drizzle and the guardrail.

Migration from the seeded pre-state (guardrail 50)

- [ ] 0 mismatches on the fixture; counts per table match; the TypeScript re-check agrees with the SQL verify.
- [ ] The corrupted-row case aborts with nothing dropped and no `0056` journal row.
- [ ] The result recorded in the progress tracker for every environment it ran in.

The database enforces (workflow §8.4)

- [ ] Type pinning, pair FK, completeness at COMMIT (incl. deleting the only step), step PK, lane collision and the recurring+oneTime acceptance, `23514` on all five tables under `ACTIVE`, zero orphans on discard.
- [ ] A bare header `UPDATE component_type` with a subtype row attached fails the FK.

Grants (workflow §8.9)

- [ ] `billrun_runtime` and `rating_runtime`: `SELECT` on the view, nothing on `pop_*` or the reference tables. `app_runtime`: `SELECT` only on the reference tables. `reporting_runtime`: nothing new; its drift guard passes. Every statement enumerated.

Boundaries

- [ ] `0006`, `0040`, `0049` byte-identical; `reporting-db-roles.sql` untouched; no `drizzle-kit generate`, no snapshot; the view not in any Drizzle file; no `db/views/`, no second migration, no `scripts/` backfill.
- [ ] No file under `db/repositories/**`, `services/**`, `db/seeds/**`, `app/**`, `components/**`, `actions/**` changed; the only `tests/**` changes are the four files of I6 and the fixture.
- [ ] Commit message states `tsc red by G-N5; closes at pm73` and lists the red files.

Docs

- [ ] Architecture §6 approvals; code-standards §6.34, §6.40, §7, Appendix A rows cleared by grep; `pm00` C12–C14 and N-R5; tracker entries incl. the verification result.

**Definition of done:** a database built from empty and a database migrated from the seeded pre-state both arrive at the same schema, with every envelope and characteristic set provably reconstructible from rows before any column was dropped — and the database, not the code, now refuses an incomplete header, a mistyped subtype row, an unseeded pair, a duplicate band, a colliding lane and a write under a released version.
