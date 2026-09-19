# pm35 — Catalog schema target state (lifecycle enum, price completeness, cascade)

**Unit:** pm35 (Part 3, first unit). **Boundary:** `db/**` only — `db/migrations/0006_product.sql`, `db/schema/product.ts`, `db/seeds/sample/seed-billrun-sample.ts`, plus the two test files that prove it. No repository, service, action, component or validation change.
**Specs from:** `prodmgmt-update-overview.md` (goals 3, 5; success criteria 9, 14) · `_updatemodule-product-manage-page-refactor-plan.md` D5, D7, D11, D12, O1 (now closed) · `prodmgmt-architecture.md` §3.1–§3.4, §3.9, Inv. #6, #23, #28 · `prodmgmt-code-standards.md` §6.5, §6.9, §6.14 · `pm00-build-plan.md` Part 3.
**Gates:** G1 (invariant amendments approved) and G2 (`'RETIRED'` literal audit complete) must be closed before this unit starts.

---

## Goal

Move the `product` schema to its target shape in one edit of the not-yet-applied-anywhere `0006_product.sql`: `lifecycle_status` becomes `DRAFT → TESTING → ACTIVE → OBSOLETE → RETIRED`, every price row must carry the fields its price type requires (charge period for `recurring`, unit of measure for `usage`, neither for `once`), and the two child tables cascade when an offering row is deleted. A fresh `db:setup` plus every seed must load against that shape, and a seed or direct insert that omits a required price field must fail at the database.

---

## Design

### D1. Why `0006` is edited in place rather than a forward migration

Adding an enum value and using it in the same run is impossible here. `db/migrate.ts` calls Drizzle's postgres-js migrator, which wraps **all pending migrations in one transaction** (`pg-core/dialect.js`, `session.transaction(...)`), and PostgreSQL rejects the use of an enum value added in the same transaction (`ERROR: unsafe use of new value "OBSOLETE" of enum type …`, verified on PG 16.13; PG 17 behaves the same). A forward migration would therefore need the create-new-type-and-swap form. Decision D11 removes the need: no installation exists, so `0006` is treated as unapplied and edited directly. This is the **one** authorised exception (`prodmgmt-ai-workflow-rules.md` §6.2); every other migration stays forward-only.

### D2. No snapshot work, and no `drizzle-kit` command — correcting the plan

The plan (§3.1) and code-standards (§6.14) say the `0006` snapshot is regenerated. **That is wrong for this repo and must not be attempted.** `db/migrations/README.md` and `drizzle.config.ts` both state that snapshots stop at `0026`, that every migration from `0027` on is hand-written SQL with a hand-appended `meta/_journal.json` entry, and that `drizzle-kit generate` is retired because it would emit one giant broken diff. The apply path never reads snapshots. So pm35:

- edits the `.sql` file of record and keeps `db/schema/product.ts` in sync **by hand** (the README's step 3 idiom);
- leaves `meta/0006_snapshot.json` untouched and stale, like every snapshot after `0026`;
- leaves `meta/_journal.json` untouched — the tag, `when` and ordering are unchanged because the file is edited, not added;
- runs no `db:generate`, ever.

The two doc lines are corrected as part of this unit (§I6).

### D3. Enum member order is lifecycle order

`CREATE TYPE … AS ENUM('DRAFT','TESTING','ACTIVE','OBSOLETE','RETIRED')`. Postgres orders enum values by declaration, so `ORDER BY lifecycle_status` and any `<`/`>` comparison follow the lifecycle rather than the alphabet. The TypeScript union in pm37 declares the same order for the same reason.

### D4. Price completeness is four constraints, not one

Split so a violation names its own cause in the error message:

| Constraint | Rule |
|---|---|
| `product_offering_price_recurring_period_check` | `recurring` ⇒ both period columns NOT NULL; any other type ⇒ both NULL |
| `product_offering_price_period_value_check` | period type, when present, is `'months'` with length in (1, 3, 12) |
| `product_offering_price_usage_unit_check` | `usage` ⇒ `unit_of_measure` NOT NULL; any other type ⇒ NULL |
| `product_offering_price_unit_value_check` | `unit_of_measure`, when present, is one of `Mbps`, `GB`, `MB`, `EA` |

**The period value list is closed at (1, 3, 12) months.** `billing.bill_cycle.frequency` is constrained to `monthly`, `quarterly`, `annually` (`db/schema/billing/catalogs.ts`), and bm29's recurring resolver maps the price's charge period onto that frequency. Months-only gives exactly one encoding per cycle, so two prices can never express the same period in different words. `'years'` is deliberately not accepted (closes O1).

**Unit values are case-sensitive and never normalised.** `Mbps` keeps that casing because `MBPS` is ambiguous between megabit and megabyte per second. `'MBPS'` and `'gb'` are rejected, not coerced.

### D5. Cascade direction

`product_specifications.ref_product_offering_id` and `product_offering_price.product_offering_id` become `ON DELETE cascade`, so pm44's hard delete of a never-released version removes its children in one statement. `product_offering.family_offering_id` stays `ON DELETE restrict`: a branch only ever comes from an `ACTIVE` version and an `ACTIVE` version is never deletable, so the restrict can never block a legitimate discard. `last_edited_by → core.APPUSER` is untouched (`0007` already sets it to `ON DELETE set null`).

### D6. Two seed sites break without edits — both are in this unit

`db/seeds/sample/seed-billrun-sample.ts` does two things that the target schema (and pm36's trigger) will not allow:

1. `ensureSampleOffering()` inserts the offering with `lifecycleStatus: "ACTIVE"` and **then** inserts its price row. Legal today; rejected by pm36's DRAFT-guard trigger. Fixed here by inserting the offering as `DRAFT`, inserting the price, then `UPDATE`ing the row to `ACTIVE` in the same transaction — the trigger governs the child tables only.
2. The `_SAMPLE_` teardown deletes `product_offering_price` rows first and then the offering. Fixed here by deleting the **offering row only** and letting D5's cascade remove the children.

Both edits land in pm35 even though the trigger arrives in pm36, so pm36 finds a green tree. `db/seeds/demo/product-demo.ts` was checked line by line and is already compliant (recurring prices carry `1` / `'months'`; usage prices carry `'GB'`; the `once` price carries neither), so it is **not** edited. `db/seeds/product.ts` seeds only the ADMIN grant and holds no catalog rows.

### D7. Guardrail 13 keeps its column baseline and gains a constraint baseline

`tests/guardrails/product-module-boundaries.test.ts` freezes the three tables' **column** lists. pm35 adds no column, so `PHASE1_OFFERING_COLUMNS`, `SPECIFICATIONS_COLUMNS` and `PRICE_COLUMNS` stay byte-identical — do not touch them. What is added is a new assertion block freezing the things pm35 does change: the five enum members in order, the four new check names, and `onDelete: "cascade"` on both child FKs. The guardrail's purpose is unchanged — an unreviewed schema drift fails CI.

---

## Implementation

### I1. `db/migrations/0006_product.sql`

1. **Enum.** Replace the `CREATE TYPE` line with the five-member form in D3's order.
2. **Price table CHECKs.** Add the four constraints from D4 to the inline `CREATE TABLE "product"."product_offering_price"` constraint list, after the existing `product_offering_price_amount_xor_tiers_check`, in D4's table order. Keep the existing three CHECKs (`type_check`, `pricing_model_check`, `currency_check`) and the XOR CHECK unchanged. (`product_offering_price_amount_check` stays in `0007`, where it already lives — do not move it.)
3. **Cascade.** In the two `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` statements for `product_specifications.ref_product_offering_id` and `product_offering_price.product_offering_id`, change `ON DELETE restrict` to `ON DELETE cascade`. Leave both statements' names and ordering as they are.
4. Do not touch the `products` PERMISSIONS insert at the end of the file, the sequences, the indexes, or the `product_offering` table body.
5. Keep every `--> statement-breakpoint` marker exactly as-is; the migrator and the bootstrap runners split on them.

SQL for the four constraints, to be written inline in the table definition:

```sql
CONSTRAINT "product_offering_price_recurring_period_check" CHECK (
  (price_type = 'recurring'
     AND recurring_charge_period_length IS NOT NULL
     AND recurring_charge_period_type IS NOT NULL)
  OR
  (price_type <> 'recurring'
     AND recurring_charge_period_length IS NULL
     AND recurring_charge_period_type IS NULL)
),
CONSTRAINT "product_offering_price_period_value_check" CHECK (
  recurring_charge_period_type IS NULL
  OR (recurring_charge_period_type = 'months'
      AND recurring_charge_period_length IN (1, 3, 12))
),
CONSTRAINT "product_offering_price_usage_unit_check" CHECK (
  (price_type = 'usage' AND unit_of_measure IS NOT NULL)
  OR (price_type <> 'usage' AND unit_of_measure IS NULL)
),
CONSTRAINT "product_offering_price_unit_value_check" CHECK (
  unit_of_measure IS NULL
  OR unit_of_measure IN ('Mbps', 'GB', 'MB', 'EA')
)
```

### I2. `db/schema/product.ts`

1. `lifecycleStatus` enum literal array → `["DRAFT", "TESTING", "ACTIVE", "OBSOLETE", "RETIRED"]`.
2. Add four `check(...)` entries to `productOfferingPrice`'s callback array, with the same names and the same predicates as I1, in the same order. Mirror the SQL exactly — code-standards §6.5 makes the database the owner and Drizzle the mirror.
3. `references(() => productOffering.productOfferingId, { onDelete: "cascade" })` on `productSpecifications.refProductOfferingId` and `productOfferingPrice.productOfferingId`.
4. Add a one-line comment above the enum stating the declaration order is lifecycle order and is load-bearing for sorting.
5. Change nothing else: no column added, removed or renamed, no index touched, `policy` stays nullable and unused.

### I3. `db/seeds/sample/seed-billrun-sample.ts`

1. In `ensureSampleOffering()`: insert the offering with `lifecycleStatus: "DRAFT"`, insert the price row, then update that offering row to `"ACTIVE"` before returning — all inside the existing transaction. Add a comment naming pm36's trigger as the reason, so nobody "simplifies" it back. **Re-seed guard:** the `UPDATE … SET lifecycle_status = 'ACTIVE'` trips `product_offering_one_active_per_family` (pm36) if that family already holds an `ACTIVE` row — a re-seed without teardown, or a partial-failure rerun. `ensureSampleOffering()` must stay idempotent: if the `_SAMPLE_` offering already exists, return it rather than re-inserting/re-activating, and document that precondition. (The old insert-ACTIVE-directly seed was not order-dependent this way.)
2. In the `_SAMPLE_` teardown: delete the `productOffering` row and remove the preceding `productOfferingPrice` delete; the cascade removes the children. Keep the surrounding purge order otherwise unchanged.
3. Leave `SAMPLE_RECURRING_AMOUNT`, the GL code, the start date and the price's `1` / `'months'` values as they are — they already satisfy D4.

### I4. New test — `tests/db/product-price-constraints.integration.test.ts`

Live-DB integration test (the pm16 precedent), one case per constraint, each asserting the rejection comes from the **database** by issuing raw SQL rather than going through a repository:

| Case | Expectation |
|---|---|
| `recurring` price with both period columns NULL | rejected, `product_offering_price_recurring_period_check` |
| `recurring` price with length 6, type `months` | rejected, `product_offering_price_period_value_check` |
| `recurring` price with length 1, type `years` | rejected, `product_offering_price_period_value_check` |
| `usage` price with `unit_of_measure` NULL | rejected, `product_offering_price_usage_unit_check` |
| `usage` price with unit `'MBPS'` | rejected, `product_offering_price_unit_value_check` |
| `usage` price with unit `'gb'` | rejected, same constraint |
| `once` price carrying a charge period | rejected, `product_offering_price_recurring_period_check` |
| `once` price carrying a unit | rejected, `product_offering_price_usage_unit_check` |
| `recurring` 1/`months`, `usage` with `GB`, `once` with neither | all three insert |
| Delete a `DRAFT` offering that has 2 specs and 2 prices | offering and all four child rows gone; sibling versions untouched |
| Insert an offering row per enum value | all five accepted; `'ARCHIVED'` rejected by the enum |

### I5. Guardrail extension — `tests/guardrails/product-module-boundaries.test.ts`

Add one `it(...)` beside the existing schema-diff test (do not modify that test):

1. `db/schema/product.ts` declares the enum members exactly `["DRAFT","TESTING","ACTIVE","OBSOLETE","RETIRED"]`, in that order (string-level match on the array literal).
2. The `productOfferingPrice` table block contains all four new check names.
3. Both child-table FK declarations contain `onDelete: "cascade"`, and `familyOfferingId`'s contains `onDelete: "restrict"`.
4. `0006_product.sql` contains the same four constraint names and the five-member enum — the SQL of record and the Drizzle mirror agree.

### I6. Documentation corrections landed with this unit

1. `_updatemodule-product-manage-page-refactor-plan.md` §3.1 and §3.4 — replace "regenerates the `0006` drizzle snapshot" with the D2 statement (snapshots stop at `0026`, hand-written migrations, `generate` retired).
2. `prodmgmt-code-standards.md` §6.14 — same correction; the rule becomes "keep `db/schema/product.ts` in sync by hand; run no `drizzle-kit generate`".
3. `pm00-build-plan.md` pm35 row — drop "regenerates the `0006` drizzle snapshot"; add the sample-seed edits (D6).
4. `prodmgmt-architecture.md` §3.2 — replace the provisional period mapping with the closed O1 answer: `'months'` only, length in (1, 3, 12).
5. `prodmgmt-ui-context.md` §5 — no change needed; it already states `amount / period` rendering.

---

## Dependencies

**Packages to install: none.** No npm dependency, no PostgreSQL extension, no new dev tool. The unit uses what the repo already has: `drizzle-orm@0.45.2` (schema definitions), `postgres` (the migrator's driver), `vitest` + the existing live-DB integration harness, and a local Docker PostgreSQL 17.

**Commands used:** `npm run db:migrate`, `npm run db:setup`, `npm run db:seed-demo`, `npm run db:seed-sample`, `npm run test`, `npx tsc --noEmit`, `npm run lint`.
**Command explicitly not used:** `npm run db:generate` (`drizzle-kit generate`) — retired in this repo (D2).

**Prerequisite state:** a database that can be dropped and rebuilt. Every environment must re-run `db:setup` from empty after this unit; role passwords and the step-6 grant patch live in the Docker volume and do not survive the rebuild (README, Part 1).

---

## Sequencing — pm35 is schema-first and NOT independently CI-green (added post-review, 2026-09-19)

An xhigh code review confirmed a contradiction between this unit's **DB-only scope** (Boundary: `db/**` only; "No repository, service, action, component or validation change"; the `git diff --stat` item) and its **regression gate** below ("the full existing suite is green"). The four new price CHECKs invalidate the null-`recurring_charge_period_*` / null-`unit_of_measure` shape that the current writers still produce:

- **Production:** `db/repositories/product-offering-price.ts`'s `insertPrice` (and the `services/product/insert-price.ts` service) hardcode all three columns to `NULL`, so after these CHECKs land the real Manage-Products "Add price" flow fails at the DB for every `recurring` or `usage` price.
- **Tests:** ~11 existing integration fixtures insert `recurring` prices with no period and `usage` prices with no unit — `product-repositories`, `product-schema`, `create-order`, `ordering-read`, `review-order`, `subscription-lifecycle`, `ship-gate-guardrails` integration suites plus rating `rm08`/`rm09`/`rm10`/`rm13`. (Empirically confirmed failing: `review-order` and `product-schema` integration suites.)

Reworking `insertPrice` (the discriminated `price-input.schema.ts`, the new `update-price.schema.ts`, the per-`price_type` required fields) **and** updating those fixtures is owned by the **later price-management rebuild unit** (`prodmgmt-update-overview.md` Features › Price fields; `prodmgmt-architecture.md` §Validation), not by this DB-only unit.

**Resolution (option C):** pm35 changes no production or fixture code. It is therefore **schema-first and does not independently pass the "full existing suite green" gate** — it MUST co-land with, or land as one non-deployed bundle immediately before, the price-management unit that supplies the period/unit fields. A standalone pm35 commit leaves the integration suite red by design. Do **not** attempt to green it by editing fixtures piecemeal: two `product-repositories` cases write `usage`/`recurring` prices *through* the still-null `insertPrice` service and cannot pass until that service is reworked.

---

## Verification checklist

Structural

- [ ] `0006_product.sql` declares the enum as `('DRAFT','TESTING','ACTIVE','OBSOLETE','RETIRED')`, in that order.
- [ ] The four new CHECK constraints exist in `0006_product.sql` with the names in D4, and the pre-existing CHECKs are unchanged.
- [ ] Both child FKs are `ON DELETE cascade`; `family_offering_id` is still `ON DELETE restrict`; `last_edited_by` is untouched.
- [ ] `db/schema/product.ts` mirrors all of the above; no column added, removed or renamed.
- [ ] `meta/_journal.json` is byte-identical to before this unit; no snapshot file was written; no other migration file was edited.
- [ ] `git diff --stat` touches only: `0006_product.sql`, `db/schema/product.ts`, `db/seeds/sample/seed-billrun-sample.ts`, the two test files, and the five doc files in I6.

Behavioural (fresh database, built from empty)

- [ ] `npm run db:setup` completes on an empty database.
- [ ] `tests/db/migration.integration.test.ts` passes — the drop-all-schemas → `migrate()` from-empty → idempotent-second-run test is the actual proof that D11's edit-in-place `0006` applies cleanly from scratch (not just `db:setup`). Name it here and gate pm45's "green from empty" on it.
- [ ] `npm run db:seed-demo` loads the demo catalog unchanged; `npm run db:seed-sample` loads the `_SAMPLE_` graph.
- [ ] Running `db:seed-sample` twice in a row succeeds — the teardown's cascade delete removes the prior offering and its price.
- [ ] Every case in I4 passes, each rejection naming the expected constraint.
- [ ] All five enum values insert; a sixth value is rejected by the type.
- [ ] Deleting a `DRAFT` offering removes its specifications and prices and nothing else.

Regression

- [ ] Guardrail 13's column baselines are unchanged and still pass.
- [ ] The full existing suite is green: catalog guardrails 1–14, Ordering guardrails 15–22, the authz matrix, and every billing and rating integration suite that reads `product.*`. **(Holds only for the co-landed bundle — see "Sequencing" above. A standalone pm35 commit fails this by design: the new CHECKs break ~11 price-inserting integration fixtures and the still-null `insertPrice` path, both owned by the later price-management unit.)**
- [ ] `tsc --noEmit`, ESLint and Prettier clean.
- [ ] No service, repository, action, component or validation file changed in this unit.

Documentation

- [ ] The five I6 corrections are landed in the same change set.
- [ ] O1 is marked closed in the plan, with the accepted combinations recorded.

**Definition of done:** a developer clones the repo, runs `db:setup`, `db:seed-demo` and `db:seed-sample` against an empty PostgreSQL 17, and gets a catalog whose every price carries the fields its type requires — while a hand-written `INSERT` of an incomplete price is refused by the database, not by the application.
