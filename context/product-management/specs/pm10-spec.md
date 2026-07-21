# PM10 — Schema: `family_offering_id` version-lineage column

- **Unit:** 10 of 24 (`pm99-build-plan-phase2.md`)
- **Dependencies:** None — first Phase 2 unit. Must land, migrated, and verified before any Phase 2 repository code (pm11+) touches `product_offering`.
- **Authorizing sections:** `prodmgmt-architecture-phase2.md` §3 (Storage Model — `family_offering_id` design, Inv. 8 supersession, Inv. 13); `prodmgmt-code-standards-phase2.md` §6 (rule 11: single-active-per-family enforced transactionally, not by this constraint) and §7 (file tree — one new migration only); `_change-product-crud-plan.md` "Version linkage — the new mechanism."
- **Codebase state assumed at start (re-verify before implementing):** Phase 1 (pm01–pm09) shipped. `db/schema/product.ts` has 3 tables, no `family_offering_id` column. Migrations run through `0009_customer.sql` (Customer module) — **this unit's migration is `0010`, not `0007`/`0008` as in early Phase 2 drafts**; re-check `db/migrations/meta/_journal.json`'s last entry before generating, in case another module's migration has landed since.

---

## 1. Goal

Add one nullable, self-referencing column to `product_offering` — `family_offering_id` — so two rows can be identified as different versions of the same product, with `NULL` marking a row as its family's root and a non-null value always resolving to that root in one hop.

## 2. Design

**Column semantics (the load-bearing decision, cited everywhere downstream):**
- `family_offering_id IS NULL` ⇒ this row **is** the root of its own version family.
- `family_offering_id = X` ⇒ this row is a version in the family rooted at offering `X`. Always one hop — a branch-of-a-branch still points at the original root, never at an intermediate row (pm11's `insertOffering` and pm12's `branchOfferingAsDraft` are what enforce "always resolve to the true root," but the column's job in this unit is just to hold that value correctly).
- "All versions of one family" is therefore always a single indexed lookup: `WHERE product_offering_id = :rootId OR family_offering_id = :rootId`.

**Why nullable-root instead of self-pointing-root:** the alternative design (every row, including roots, has a non-null `family_offering_id` — a root points at itself) was rejected because it requires inserting the row first and then `UPDATE`-ing it to point at its own freshly generated id (two statements, since the id is sequence-generated at insert time and can't be known beforehand in one `INSERT`). Nullable-root avoids that entirely: a root is just `INSERT ... family_offering_id DEFAULT NULL`, one statement, matching how every other Phase 1 insert already works. The cost is that `activateOffering` (pm16) can't express "at most one ACTIVE per family" as a single partial-unique-index, since a root's `NULL` never collides with anything (Inv. 13, out of scope for this unit — enforced transactionally in pm16, not here).

**Recommended addition beyond the literal architecture text — a self-reference guard:** add `CHECK (family_offering_id IS NULL OR family_offering_id <> product_offering_id)`. Nothing in `prodmgmt-architecture-phase2.md` explicitly calls for this, but it matches this file's existing style (every other invariant in `product_offering_price` is a CHECK constraint, not just app-layer discipline) and costs nothing: it makes "a row can never claim to be its own family's non-root version" a DB-enforced fact instead of a convention a future bug could silently violate. Flagging it here explicitly rather than folding it in silently, since it's this spec's one addition to what was already agreed.

**No visual/UI design in this unit** — schema only, per the build plan's boundary.

## 3. Implementation

### 3.1 Schema — `db/schema/product.ts` (edit)

Add to the `productOffering` table definition, alongside the existing columns (after `lastEditedBy`, before the closing brace):

```ts
familyOfferingId: text("family_offering_id").references(
  (): AnyPgColumn => productOffering.productOfferingId,
  { onDelete: "restrict" },
),
```

This is a genuine self-reference — `productOffering` referencing its own `productOfferingId` column from within its own table-definition callback. No other table in this codebase does this yet (existing FKs, e.g. `productSpecifications.refProductOfferingId`, all point at a *different* table's export). It works because the `references()` callback is evaluated lazily — by the time Drizzle actually calls it, the `productOffering` const has finished being assigned at module scope. **Verify this at implementation time** by generating the migration and reading the emitted SQL (§3.2) before assuming it's correct; this is new ground for this codebase, not a copy-paste of an established pattern.

Convert the table's constraint array (currently just `index("product_specifications_offering_idx")`-style single entries elsewhere; `productOffering` itself currently has no constraint-array argument at all) to add:

```ts
export const productOffering = product.table(
  "product_offering",
  {
    // ...existing columns...
    familyOfferingId: text("family_offering_id").references(
      (): AnyPgColumn => productOffering.productOfferingId,
      { onDelete: "restrict" },
    ),
  },
  (t) => [
    index("product_offering_family_idx").on(t.familyOfferingId),
    check(
      "product_offering_family_not_self_check",
      sql`family_offering_id IS NULL OR family_offering_id <> product_offering_id`,
    ),
  ],
);
```

No change to `productSpecifications` or `productOfferingPrice` — confirm the diff touches only the `productOffering` block.

### 3.2 Migration — `db/migrations/0010_product_offering_family.sql` (new, auto-generated)

Generate with `npx drizzle-kit generate` (schema-diff mode, **not** `--custom` — this is a real DDL change, unlike pm03's data-only `0008`). Expect emitted SQL along the lines of:

```sql
ALTER TABLE "product"."product_offering" ADD COLUMN "family_offering_id" text;
ALTER TABLE "product"."product_offering" ADD CONSTRAINT "product_offering_family_offering_id_product_offering_product_offering_id_fk"
  FOREIGN KEY ("family_offering_id") REFERENCES "product"."product_offering"("product_offering_id") ON DELETE RESTRICT;
CREATE INDEX "product_offering_family_idx" ON "product"."product_offering" USING btree ("family_offering_id");
ALTER TABLE "product"."product_offering" ADD CONSTRAINT "product_offering_family_not_self_check"
  CHECK (family_offering_id IS NULL OR family_offering_id <> product_offering_id);
```

Read the actual generated file and confirm: (a) it's a plain `ALTER TABLE ADD COLUMN` + separate `ADD CONSTRAINT` for the FK — not an inline `REFERENCES` clause that Drizzle might mis-order for a self-referencing table; (b) the FK constraint name isn't silently truncated/collided by Postgres's 63-character identifier limit (the auto-generated name above is long — if Postgres truncates it, that's fine functionally but note the actual name for later reference); (c) no unrelated diff appears against `product_specifications` or `product_offering_price` (would indicate an accidental schema drift being picked up). Regenerate the Drizzle meta snapshot/journal in the same commit.

### 3.3 Types — no manual edit needed

`ProductOffering` and `ProductOfferingInsert` in `db/schema/product.ts` are `typeof productOffering.$inferSelect` / `$inferInsert` — they pick up `familyOfferingId: string | null` automatically once §3.1 lands. Do not hand-add the field to `types/product.ts`; if a read model there needs to expose it, that's pm11+'s concern, not this unit's.

### 3.4 Seeds — no change

`db/seeds/product.ts`'s two existing `TOREMOVE-Template-*` offerings need no edit. `family_offering_id` is nullable and defaults to `NULL`, which is exactly correct for two pre-existing, standalone offerings that have no other version — they're each trivially the root of a one-row family. Confirm this after migrating (§5) rather than adding an explicit `family_offering_id: null` to the seed data (redundant with the column default).

## 4. Dependencies

**No new npm packages.** Drizzle Kit and the Postgres driver are already installed and used for every prior migration. **No DB extensions** — a self-referencing FK and a CHECK constraint are both plain Postgres, no `btree_gist` or similar needed (unlike the removed v1 overlap-constraint attempt).

## 5. Verify when done

**Diff hygiene**
- [ ] `git status` shows only: `db/schema/product.ts` (one new field + updated constraint array on `productOffering` only), `db/migrations/0010_product_offering_family.sql` (new), `db/migrations/meta/_journal.json` + snapshot (updated). Nothing else — no repository, service, or type-file edits (those are pm11+).
- [ ] The migration's SQL touches only `product_offering`; no line references `product_specifications` or `product_offering_price`.

**Schema correctness**
- [ ] Fresh DB: `npm run db:setup` (or the project's migrate command) applies `0000`–`0010` cleanly, in order, with no manual intervention.
- [ ] `\d product.product_offering` in `psql` shows `family_offering_id` as nullable `text`, the FK constraint referencing `product.product_offering(product_offering_id)` with `ON DELETE RESTRICT`, the CHECK constraint, and the index.
- [ ] Self-reference guard works: `UPDATE product.product_offering SET family_offering_id = product_offering_id WHERE product_offering_id = 'PRDOFR000001'` fails the CHECK constraint.
- [ ] FK integrity works: inserting a row with `family_offering_id` set to a non-existent offering id fails the FK constraint; setting it to a real existing offering id succeeds.

**The unit's stated visible result**
- [ ] Hand-insert one root row (`family_offering_id` omitted/`NULL`) and one row with `family_offering_id` pointing at the root's id. Run `SELECT product_offering_id FROM product.product_offering WHERE product_offering_id = :rootId OR family_offering_id = :rootId` — confirm both rows return.
- [ ] Both Phase 1 seeded offerings (`TOREMOVE-Template-*`) still have `family_offering_id IS NULL` after migrating — each remains a valid, if trivial, one-row family.

**Build gates**
- [ ] `npm run typecheck` green — `ProductOfferingInsert`/`ProductOffering` include `familyOfferingId: string | null` with no manual type edit.
- [ ] `npm run lint` and `npm run format:check` green.
- [ ] `tests/db/product-schema*.test.ts` passes after intentionally updating `tests/db/product-schema.test.ts`'s exact-column assertion to include `family_offering_id`; existing repository/service tests still pass unmodified — this unit changes no behavior any of them exercises, only adds a column nothing yet reads or writes.

**Docs in sync**
- [ ] `prodmgmt-progress-tracker.md` (real repo copy, not the plan-folder mirror) gets a pm10 entry with the commit reference, once this actually ships.

Any failing item means the unit is not done. pm11 (Create offering) must not start until this migration is applied and verified.
