# pm36 — Family uniqueness indexes + DRAFT-guard trigger

**Unit:** pm36 (Part 3). **Boundary:** `db/**` — one new forward migration, `db/schema/product.ts` (index declarations only), the guardrail and integration tests. No repository, service, action or UI change.
**Specs from:** `prodmgmt-architecture.md` §3.3, §3.5, Inv. #13 (corrected), #24, #27 · `prodmgmt-code-standards.md` §6.7, §6.8, §6.18 · plan D3, D9 · `pm00-build-plan.md` Part 3.
**Depends on:** pm35 (five-value enum and cascade FKs must exist).

---

## Goal

Make the database refuse what the services already refuse: a second open version or a second `ACTIVE` version in one family, and any write to a specification or price row whose parent offering is not `DRAFT`. Both rules are proven by direct SQL, not by going through the application.

---

## Design

### D1. Expression indexes, not partial indexes on the raw column

A family root carries `family_offering_id IS NULL`, and NULLs do not collide in a unique index — which is why the original Inv. #13 called this impossible. Indexing `COALESCE(family_offering_id, product_offering_id)` removes the NULL: a root indexes its own id, a branch indexes its root's id, and both live in the same key space. Verified on PostgreSQL 16.13 — a second open row and a second `ACTIVE` row were rejected for a root and for a branch alike.

### D2. The indexes back the lock, they do not replace it

`activateOffering` keeps its `pg_advisory_xact_lock` on the family and its in-transaction re-check. The index changes the failure mode from "two live versions" to "the second writer's `INSERT`/`UPDATE` is rejected", which is a safety net for a bug or a direct SQL write, not an error path the application is expected to hit. A service that starts *relying* on a unique-violation error instead of the lock is a defect.

### D3. One trigger function, two tables

A single `PL/pgSQL` function attached to both child tables, rather than two near-identical functions. It reads the parent's `lifecycle_status` and raises unless it is `DRAFT`.

### D4. The cascade must pass through the trigger

pm35 made both child FKs `ON DELETE cascade`, and pm44 will hard-delete `DRAFT`/`TESTING` versions. During a cascade the parent row is deleted first, so a `SELECT` for it inside the child's `DELETE` trigger finds nothing. **The rule is therefore: parent not found ⇒ allow.** That single clause makes the cascade work without exempting `TG_OP = 'DELETE'` wholesale, which would have opened a hole (deleting a live version's prices directly).

### D5. Error shape

`RAISE EXCEPTION … USING ERRCODE = '23514'` (check_violation) with a message naming the parent id and its status, so a failure in a test or a psql session says which version blocked the write and why. The constraint-style name `product_child_write_requires_draft` is carried in the message text for grep-ability.

---

## Implementation

### I1. New migration `db/migrations/0040_product_family_guards.sql`

Hand-written, `--> statement-breakpoint` between statements, per `db/migrations/README.md`. Append the matching entry to `meta/_journal.json` (`tag: "0040_product_family_guards"`, `when` greater than `0039`'s `1788196029615`, `version: "7"`, `breakpoints: true`).

```sql
CREATE UNIQUE INDEX "product_offering_one_active_per_family"
  ON "product"."product_offering" ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status = 'ACTIVE';
--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_one_open_per_family"
  ON "product"."product_offering" ((COALESCE(family_offering_id, product_offering_id)))
  WHERE lifecycle_status IN ('DRAFT','TESTING');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "product"."child_write_requires_draft"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_parent_id text;
  new_parent_id text;
  parent_status "product"."lifecycle_status";
BEGIN
  -- Resolve the affected parent id(s) per table, guarded by TG_TABLE_NAME so
  -- each field only appears in the branch for the table that has it (PL/pgSQL
  -- plans each statement lazily, so the untaken branch never resolves a
  -- non-existent column — a single CASE spanning both column names fails with
  -- "record ... has no field ..."). A re-parenting UPDATE touches TWO parents
  -- (OLD loses the row, NEW gains it) and both must be DRAFT.
  IF TG_TABLE_NAME = 'product_specifications' THEN
    IF TG_OP <> 'INSERT' THEN old_parent_id := OLD.ref_product_offering_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_parent_id := NEW.ref_product_offering_id; END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN old_parent_id := OLD.product_offering_id; END IF;
    IF TG_OP <> 'DELETE' THEN new_parent_id := NEW.product_offering_id; END IF;
  END IF;

  -- Parent gaining/holding the row (INSERT/UPDATE) must be DRAFT.
  IF new_parent_id IS NOT NULL THEN
    SELECT lifecycle_status INTO parent_status
      FROM "product"."product_offering" WHERE product_offering_id = new_parent_id;
    IF FOUND AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'product_child_write_requires_draft: % on %.% rejected — offering % is %',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, new_parent_id, parent_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Parent losing the row (DELETE, or a re-parenting UPDATE) must be DRAFT too.
  -- Skipped when equal to the parent already checked; a parent that is gone is
  -- the ON DELETE cascade of a discarded DRAFT/TESTING version (pm44) — NOT
  -- FOUND passes it through.
  IF old_parent_id IS NOT NULL AND old_parent_id IS DISTINCT FROM new_parent_id THEN
    SELECT lifecycle_status INTO parent_status
      FROM "product"."product_offering" WHERE product_offering_id = old_parent_id;
    IF FOUND AND parent_status <> 'DRAFT' THEN
      RAISE EXCEPTION
        'product_child_write_requires_draft: % on %.% rejected — offering % is %',
        TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, old_parent_id, parent_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "product_specifications_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_specifications"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
--> statement-breakpoint
CREATE TRIGGER "product_offering_price_draft_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "product"."product_offering_price"
  FOR EACH ROW EXECUTE FUNCTION "product"."child_write_requires_draft"();
```

Note the `UPDATE` path validates **both** the `OLD` and `NEW` parent when they differ: no application code re-parents a child (the branch primitive inserts new rows), but the trigger is a backstop against a direct-SQL write, and a re-parent that moved a spec/price off a released version is exactly such a write — so both the offering losing the row and the offering gaining it must be `DRAFT`. When the parent is unchanged, only that one parent is checked.

### I2. `db/schema/product.ts`

Add the two indexes to `productOffering`'s callback array using Drizzle's `uniqueIndex(...).on(sql\`coalesce(...)\`).where(...)` form, mirroring the SQL names exactly. The trigger and function have **no** Drizzle representation — carry a comment above the table block naming `0040` as the SQL of record for them, following the `db/schema/billing/documents.ts` "kept in sync with it" precedent.

### I3. Integration test `tests/db/product-family-guards.integration.test.ts`

| Case | Expectation |
|---|---|
| Root `ACTIVE` + branch insert `ACTIVE` | second rejected, `product_offering_one_active_per_family` |
| Root `DRAFT` + branch insert `DRAFT` | rejected, `product_offering_one_open_per_family` |
| Root `DRAFT` + branch insert `TESTING` | rejected (same index — both statuses share the predicate) |
| Root `OBSOLETE` + branch `ACTIVE` + third `DRAFT` | all accepted — one open, one active, obsolete unconstrained |
| Two families, each with its own open version | accepted — the predicate is per family key |
| `UPDATE` a second version from `DRAFT` to `ACTIVE` while a sibling is `ACTIVE` | rejected by the index |
| Insert a price whose parent is `TESTING` / `ACTIVE` / `OBSOLETE` / `RETIRED` | rejected, message contains `product_child_write_requires_draft` and the parent status |
| Update a spec row whose parent is `ACTIVE` | rejected |
| Delete a price row whose parent is `ACTIVE` | rejected |
| Insert, update and delete a price and a spec whose parent is `DRAFT` | all accepted |
| `DELETE` a `DRAFT` offering carrying 2 specs and 2 prices | succeeds; all four child rows gone (cascade passes the trigger via D4) |
| `DELETE` a `TESTING` offering carrying children | succeeds (same path; the parent-status check never runs because the parent is already gone) |

### I4. Concurrency test (extends `tests/db/product-repositories.integration.test.ts`)

Two concurrent `branchOfferingAsDraft` calls on one family: exactly one succeeds, the other fails on the advisory lock path or the open-version index; the family ends with exactly one open version. The existing two-concurrent-activations test stays as written and must still pass unchanged.

### I5. Guardrail extension (`tests/guardrails/product-module-boundaries.test.ts`)

Extend pm35's assertion block: `0040_product_family_guards.sql` exists, contains both index names, the function name and both trigger names; `db/schema/product.ts` declares both unique indexes; `meta/_journal.json` has an entry whose `tag` is `0040_product_family_guards` and whose `when` is greater than `0039`'s.

### I6. Seed verification (no edits expected)

`db:seed-demo` and `db:seed-sample` must pass unchanged — pm35 already reshaped the sample seed (insert as `DRAFT`, activate after pricing; delete the parent and let the cascade run). If either seed fails here, the fix belongs in pm35's pattern, not in an exemption to the trigger.

---

## Dependencies

**Packages to install: none.** PL/pgSQL is built into PostgreSQL; no extension, no npm package, no new script. Commands used: `npm run db:migrate`, `npm run db:setup`, `npm run db:seed-demo`, `npm run db:seed-sample`, `npm run test`, `tsc --noEmit`, `npm run lint`. `drizzle-kit generate` is not used (pm35 D2).

**Grants:** the function runs as invoker and only reads `product.product_offering`, on which `app_runtime` already holds `SELECT`. `rating_runtime` and `billrun_runtime` never write the child tables, so `db/bootstrap/*-db-roles.sql` needs no change. This is proven, not assumed (a missing `SELECT` would surface as an opaque trigger failure under those roles):

- **Role-context test (I3 addition):** an integration case that a spec/price insert under `app_runtime` fires the trigger and succeeds/rejects correctly (the trigger's internal `SELECT` resolves under that role).
- **Guardrail (I5 addition):** a static assertion that `db/bootstrap/rating-db-roles.sql` and `db/bootstrap/billrun-db-roles.sql` grant no `INSERT`/`UPDATE`/`DELETE` on `product.product_specifications` or `product.product_offering_price` — so the trigger's `SELECT` can never run under a role that lacks `SELECT` on the parent. A future grant that lets one of them write a product child table fails CI here.

---

## Verification checklist

- [ ] `0040_product_family_guards.sql` exists with both indexes, the function and both triggers; `meta/_journal.json` has its entry and no other entry changed.
- [ ] `npm run db:setup` on an empty database applies `0006` (pm35) and `0040` in one run with no error.
- [ ] `tests/db/migration.integration.test.ts` passes — `0040`'s trigger/function/index DDL applies on a from-empty `migrate()` run and survives the idempotent second run.
- [ ] The trigger fires correctly under `app_runtime` (role-context case), and the guardrail confirms `rating_runtime`/`billrun_runtime` hold no write grant on either product child table.
- [ ] Every case in I3 passes, each rejection naming the expected index or the trigger message.
- [ ] The cascade cases pass — a `DRAFT` and a `TESTING` version delete with their children.
- [ ] I4's concurrency case leaves exactly one open version; the existing activation-race test is unchanged and green.
- [ ] `db:seed-demo` and `db:seed-sample` load, and `db:seed-sample` run twice in a row still succeeds.
- [ ] `db/schema/product.ts` declares both unique indexes and carries the trigger comment; no column, check or FK from pm35 was altered.
- [ ] Guardrail suite, full test suite, `tsc --noEmit`, ESLint, Prettier all clean.
- [ ] No repository, service, action, validation or component file changed in this unit.

**Definition of done:** in `psql`, a second `ACTIVE` row, a second open row, and a price write against a non-`DRAFT` parent are all refused — while discarding a `DRAFT` version still removes its children in one statement.
