# pm72 — Specification repository: characteristics as rows, in entry order

**Unit:** pm72 (Part 6). **Boundary:** `db/repositories/product-specification.ts` (rewritten around `product_spec_characteristic`); `db/repositories/product-offering.ts` (`branchOfferingAsDraft`'s **specification half** only — the price half is pm71's and is not reopened); one **new** test file; `pm00-build-plan.md` (C19, recorded by this unit). **No service change** (D5), no action, no component, no page, no Zod change, no seed, no fixture. `submit-for-testing.ts` keeps calling `findByOfferingIdForUpdate` unchanged.
**Specs from:** `_updatemodule-product-normalize-spec-price-tables-plan.md` §2.2, §3 (branch copy; DRAFT guard), §5 item 5, **Q4** · `prodmgmt-update-overview.md` › Goal 1, flow steps 2–3, Users ("characteristics now keep their entry order"), Out of scope ("the only visible difference is characteristic chips in entry order") · `prodmgmt-architecture.md` §3.5, Inv. **#66, #69, #73**, amended **#2** · `prodmgmt-code-standards.md` **§1.54 (fixture arm), §1.55, §1.60, §1.63**, §2.27, §2.28, **§2.32**, §3.24, **§4.31**, §7.14, guardrails **49**, **45** (spec half), re-scoped **2**, **16** · `prodmgmt-ai-workflow-rules.md` §0.2 row 4, §0.1 **G-N1 (Q4)**, **G-N5**, §1.5, §2.2 item 2, §3.3–§3.4, §7.9, §8.3 · `pm00-build-plan.md` Part 6 › pm72 row, **C19** (new, this unit).
**Depends on:** **pm70** (`product_spec_characteristic`, `productSpecificationsRelations.characteristics`, the `product_spec_characteristic_draft_guard` trigger, `product_spec_characteristics` dropped); **pm71** (ordered before this unit only because both edit `branchOfferingAsDraft` — two writers never touch one file at once; nothing here calls anything pm71 wrote); **G-N1 Q4** ("keep `display_order`" — if decided the other way this unit's ordering rule, guardrail 49 and Inv. #66 are rewritten first, and the table loses its `display_order` column in pm70, not here); **G-N5** (inside the window: `tsc` stays red in seeds, fixtures and the 22 test files until pm73).

**Gate, in one paragraph.** **G-N5:** this is the third commit on the Part 6 branch. It makes `product-specification.ts` and the whole of `product-offering.ts` compile and makes its own test file green; it does not touch a seed, a fixture or any of the 22 files (C19 moved four of them into pm73's list — they are not pm72's to fix because they are in this unit's aggregate). The commit message says `tsc red by G-N5; closes at pm73`.

---

## Goal

Store each specification characteristic as one row with a `display_order`, write rows in the order the validated record's entries arrive, replace the row set on update, rebuild the `Record<string,string>` on read in `display_order`, copy rows exactly on branch — so that the **one user-visible change of the whole update** happens here with **no UI change**: chips render in entry order on Manage Products and View Product because the record's key order now *is* the display order, and the panels already render `Object.entries(spec.characteristics)` with no sort.

---

## Design

### D1. What the file is after pm72 — same five exports, rows underneath

`productSpecificationRepository` keeps **exactly** `findByOfferingId`, `findByOfferingIdForUpdate`, `insertSpecification`, `updateSpecification`, `deleteSpecification` (`tests/db/product-repository-exports.test.ts`'s allowed set is unchanged). The write methods keep their parameter shapes, including the field name `productSpecCharacteristics: ProductSpecCharacteristics` — that is the Zod/input name (`create-specification.schema.ts`, `update-specification.schema.ts`) and the services pass it through verbatim; only the column it used to map onto is gone. `SpecificationCard` is unchanged (§2.32: `characteristics: Record<string,string>`, no `displayOrder`, no array of pairs).

Internal to the file (§2.28): `type SpecRowWithCharacteristics = typeof productSpecifications.$inferSelect & { characteristics: Array<typeof productSpecCharacteristic.$inferSelect> }`, `toCard(row)`, `toCharacteristicRows(productSpecId, record)`.

### D2. Write side — `Object.entries`, `display_order = 1…n`, `{}` writes no rows

`toCharacteristicRows(productSpecId, record)` returns `Object.entries(record).map(([charName, charValue], i) => ({ productSpecId, charName, charValue, displayOrder: i + 1 }))`. `Object.entries` of the Zod-validated record is in **insertion order** for string keys — the order `specification-form.tsx`'s `listToRecord(values.characteristicsList)` built it, which is the order of the form's rows, which is the order the user entered (overview flow step 2). The one exception is an integer-like key (`"1"`, `"42"`), which JavaScript hoists to the front regardless of insertion order: pm69 D5's **optional** rejection of `^\d+$` names closes it at Zod; if D5 was declined, record in the progress tracker that integer-like names order first by language rule, that the database stores whatever order `Object.entries` yielded, and that the read returns the stored order faithfully — the defect, if any, is upstream of this unit and visible, not silent.

- **`insertSpecification(tx, data)`** — `INSERT` the specification `RETURNING product_spec_id` (as today) → if the entries are non-empty, **one** multi-row `INSERT` into `product_spec_characteristic`. `{}` inserts nothing (Inv. #66). Two statements (was one).
- **`updateSpecification(tx, productSpecId, refProductOfferingId, data)`** — `UPDATE` the specification's five scalar columns with today's `WHERE id AND ref_product_offering_id` backstop and today's "not found" throw → `DELETE FROM product_spec_characteristic WHERE product_spec_id = $1` → multi-row `INSERT` of the new rows (skipped for `{}`). **Replace, never merge** (§1.55): a key the user removed disappears, a key kept is renumbered to its new position, and `display_order` is `1…n` contiguous after every write — `product_spec_characteristic_order_unique` can never collide because the set is empty when the new rows arrive. Three statements (was one).
- **`deleteSpecification`** — unchanged: the FK is `ON DELETE CASCADE`, the rows go with the specification.

The PK `(product_spec_id, char_name)` cannot fire from this path (a `Record` has unique keys), and `char_length(char_name) > 0` mirrors the Zod `z.string().min(1)` key schema — both are the "independently of Zod" arm (I1.7), not something the repository handles (§1.51 applies to this aggregate too: no new result code, a `23505`/`23514` here is corruption or a bypass and throws). `product_spec_characteristic_draft_guard` refuses every one of these statements under a non-`DRAFT` parent with `23514` (Inv. #69); the services already target a `DRAFT` (original or branched), so the trigger is the backstop, exactly as `product_specifications_draft_guard` is today.

### D3. Read side — one relational query, `Object.fromEntries` in `display_order`

```ts
const rows = await db.query.productSpecifications.findMany({
  where: eq(productSpecifications.refProductOfferingId, productOfferingId),
  with: { characteristics: { orderBy: asc(productSpecCharacteristic.displayOrder) } },
  orderBy: [asc(productSpecifications.name), asc(productSpecifications.productSpecId)],
});
return rows.map(toCard);   // characteristics: Object.fromEntries(row.characteristics.map(c => [c.charName, c.charValue]))
```

One statement, the `many` relation emitted as a lateral `json_agg` by Drizzle's relational builder (§2.27, §3.24 — never one query per specification). The record's key order is the array order is `display_order` (Inv. #66). `displayOrder` is read from the row type and dropped by `toCard`; it never reaches `SpecificationCard` (§2.32). A specification with no rows yields `{}` — `Object.fromEntries([])`.

**`findByOfferingIdForUpdate(tx, …)`** — Drizzle's relational builder has no `FOR UPDATE`, and this method's whole reason to exist is the lock (pm16 §3.5 post-ship fix: `submit-for-testing.ts` re-checks mandatory specifications' `defaultValue` under the lock). It becomes **two fixed statements**: today's `.select(...).from(productSpecifications).where(...).orderBy(...).for("update")` with the characteristics column removed, then one `.select().from(productSpecCharacteristic).where(inArray(productSpecId, ids)).orderBy(asc(productSpecId), asc(displayOrder))` grouped in memory into the cards (skipped when there are no specifications). The lock still covers the specification rows, which carry the two columns the precondition reads; characteristic rows are not locked and do not need to be — nothing in the precondition reads them, and they are returned only because the method's return type is `SpecificationCard[]`. Two statements, never N.

### D4. `branchOfferingAsDraft` — the specification half copies rows under new ids

Today's block selects the source specifications and inserts clones in one multi-row `INSERT` with `productSpecCharacteristics` copied verbatim. After pm72:

1. **Read** the source specifications **with** their characteristics in one relational query (`findMany({ where: eq(refProductOfferingId, sourceOfferingId), with: { characteristics: { orderBy: asc(displayOrder) } } })`).
2. **Insert the clones one statement per specification**, each `RETURNING product_spec_id`, in source order, building `Map<oldSpecId, newSpecId>` as they return. A specification has **no natural key** within an offering (`name` is not unique — `update-specification.ts`'s `findClonedCounterpart` exists precisely because the clone can only be found by matching every field, and it throws on anything but exactly one match), so position is the only link between a source row and its clone, and Postgres does not **promise** that a multi-row `INSERT … RETURNING` returns rows in `VALUES` order (it does in practice; the price half did not need to rely on it because the lane key is unique, pm71 D10). The cost is N statements per branch where N is the specification count of one offering — a handful, on a write path, never a render path — and it is recorded here as the accepted price of an exact map. Every scalar column is copied as today.
3. **Copy the characteristic rows** in **one** multi-row `INSERT` under the mapped ids, `char_name`, `char_value` and `display_order` copied **verbatim** — no renumbering, no re-ordering, no `Object.entries` round-trip (§1.60; a renumber would still be `1…n` but the point is that nothing on this path interprets the data). Skipped when there are no rows.

The clone's `findByOfferingId` then returns the same records in the same order as the source's (Inv. #73), and `findClonedCounterpart`'s order-insensitive `recordsEqual` still finds exactly one match — it matched on content before and it matches on content now.

### D5. Services — unchanged, and why that satisfies §1.63

`add-specification.ts`, `update-specification.ts`, `delete-specification.ts` call the same five methods with the same arguments and build the same audit payloads. §1.63 says the specification events "carry the reassembled `Record<string,string>`":

- `_UPDATED.beforeData` and `_DELETED.beforeData` take `current.characteristics` from `findByOfferingId` — that **is** the reassembled record (D3).
- `_CREATED.afterData` and `_UPDATED.afterData` take `input.productSpecCharacteristics` — the validated input. For characteristics the input and the reassembled read are **identical in keys, values and order**: text goes in and the same text comes out (no `numeric`, no normalization — the money problem pm71 D8 had to solve does not exist here), and D2 writes `display_order` from the same `Object.entries` the read reproduces. So the payload equals a re-read byte for byte, and a re-read would only add a statement. **Decision: no service change.** If the owner prefers a literal re-read for symmetry with the price events, it is one line per service (`insertSpecification` / `updateSpecification` would return the record) — collected as an open question, not done here.

`findClonedCounterpart`'s `recordsEqual` compares keys by lookup, not by position — correct before, correct now; it is deliberately **not** tightened to order-sensitive equality, because an order difference between source and clone would be a defect to assert in the test (I1.5), not a reason to fail a user's edit.

### D6. Discard, cascade and the guard's parent-gone branch

`deleteOffering` (the DRAFT/TESTING discard) is unchanged: offering → specification (`product_specifications_ref_product_offering_id_fk … ON DELETE CASCADE`) → characteristic (`product_spec_characteristic`'s cascade FK, pm70 D2 step 2). The `product_spec_characteristic_draft_guard` resolves the offering through `product_specifications` and **passes when the specification is already gone** (pm70 D6, Inv. #69), so the cascade never trips the guard. Asserted by row count in I1.6.

### D7. The UI does not change — verified, not assumed

- `components/products/specifications-panel.tsx:80` and `components/products/manage/editable-specifications.tsx:362` both render `Object.entries(spec.characteristics)` with **no sort** (§4.31). Today those chips come back alphabetical because jsonb re-sorts keys; after pm72 they come back in `display_order`. Same component, different data — the update's one visible change (§1.48).
- `components/products/manage/specification-form.tsx:75` builds the record with `listToRecord(values.characteristicsList)` — list order in, record order out. Unchanged.
- `validation/product/product-spec-characteristics.schema.ts` is `z.record(z.string().min(1), z.string())` — unchanged here (pm69 D5 owns the optional `^\d+$` rejection).
- `validation/characteristics.schema.ts` (the ordering/inventory `CharacteristicsRecord` that "mirrors" this schema) and `product_inventory.instance_characteristics` jsonb are **out of scope** — Q5 follow-ons in the hand-off register; nothing here touches them.

### D8. C19 — four more test files, found by this unit

`pm00`'s pm73 checklist was taken from `git grep price_component` (18 files). Four files outside that list insert specifications **with** `productSpecCharacteristics` directly: `tests/db/{product-delete-offering, product-release-path, product-withdrawal-path, ship-gate-guardrails}.integration.test.ts`. They stop compiling at pm70 and are pm73's to rewrite through `insertSpecification` (§1.54 — "seeds and test fixtures write … characteristics through the repository"). `tests/db/helpers/billrun-flow-double-fixtures.ts` inserts specifications **without** characteristics — it compiles after `0056` and needs nothing. `tests/actions/{create,update}-specification.action.test.ts`, `tests/components/specification-form.test.tsx` and `tests/validation/product-spec-characteristics.schema.test.ts` use only the Zod field name and are unaffected. Recorded in `pm00-build-plan.md` as **C19** with the pm73 row amended to **22 files**. pm72 does **not** touch them (workflow §4 item 4: seeds and fixtures stay out of pm71/pm72).

---

## Implementation

### I1. `tests/db/product-spec-characteristic-order.integration.test.ts` — guardrail 49, 45 (spec half), Inv. #73 (spec half), §1.63, §3.24

Integration project; one offering per test created through `productOfferingRepository.insertOffering` as the existing suites do; specifications written **through the services** (`addSpecification`, `updateSpecification`, `deleteSpecification`) so the audit assertions are real, with raw SQL only where the assertion is about the database.

1. **Entry order (49):** add a specification with `{ SST_ID: "01", SD_ID: "A0C4E2", DNN: "internet" }`; `findByOfferingId` returns `Object.keys(characteristics)` as `["SST_ID", "SD_ID", "DNN"]`; a raw `SELECT char_name, display_order … ORDER BY display_order` returns `1, 2, 3`.
2. **Reverse order is a different order:** a second specification with the same keys reversed reads back reversed. (This is the assertion that fails on the `0055` tree, where both would read alphabetically.)
3. **`{}` writes no rows:** add with `{}`; zero rows for the id; the card's `characteristics` deep-equals `{}`.
4. **Replace on update:** update the first specification to `{ DNN: "ims", SST_ID: "02" }`; rows are exactly `DNN → 1`, `SST_ID → 2`; `SD_ID` is gone; the card's key order is `["DNN", "SST_ID"]`.
5. **Branch copies order (Inv. #73):** activate the offering (through the activation service, as the branch tests in `product-repositories.integration.test.ts` do), then `updateSpecification` to force a branch; on the clone, each specification's `(char_name, display_order)` pairs equal the source's; the source's characteristic rows are byte-identical to a `SELECT *` snapshot taken before (guardrail 9's idiom).
6. **Guard and cascade (45, spec half):** after activation, raw `INSERT`, `UPDATE` and `DELETE` on `product_spec_characteristic` under the ACTIVE version each fail with SQLSTATE `23514`; discard the branched DRAFT through `deleteOffering`; `SELECT count(*)` of characteristic rows for its specification ids is `0`.
7. **Independent of Zod:** raw duplicate `(product_spec_id, char_name)` → `23505` on `product_spec_characteristic_pk`; raw duplicate `(product_spec_id, display_order)` → `23505` on `product_spec_characteristic_order_unique`; raw empty `char_name` → `23514`.
8. **Audit (§1.63):** the `PRODUCT_SPECIFICATION_UPDATED` event's `beforeData.productSpecCharacteristics` deep-equals the card read before the update and `afterData.productSpecCharacteristics` the card read after — and `Object.keys` of each matches in **order**, not just as sets. The payload key list equals today's (`offeringId`, [`branchedFromOfferingId`], `name`, `isMandatory`, `isDefault`, `defaultValue`, `productSpecCharacteristics`) asserted as a literal list.
9. **Query budget (§3.24):** with a statement-counting `drizzle(client, { schema, logger })` local to the file (pm71 I1.7's idiom), `findByOfferingId` on an offering with three specifications issues **one** statement; `findByOfferingIdForUpdate` issues **two**.

### I2. The repository file, in order

1. Imports: add `productSpecCharacteristic` from `@/db/schema/product` and `inArray` from `drizzle-orm`; the `ProductSpecCharacteristics` import stays (it types the write parameters).
2. D1 types and `toCard` / `toCharacteristicRows` above the repository object.
3. `findByOfferingId` → D3 relational form; `findByOfferingIdForUpdate` → D3 two-statement form; `insertSpecification` and `updateSpecification` → D2; `deleteSpecification` untouched.
4. Header comment: replace the pm02 "`.$type<ProductSpecCharacteristics>()` — no cast, no re-parse on read" sentence with the pm72 shape (rows in `display_order`; replace on update; the lock variant's two statements and why). Keep the pm03/pm14/pm16 history lines.

### I3. `product-offering.ts`

Replace the `sourceSpecs` block with D4 steps 1–3. This is the last red spot in the file; after I3 `product-offering.ts` compiles end to end.

### I4. Verification at the end of the unit (workflow §8.3, inside the window)

```bash
npx vitest run tests/db/product-spec-characteristic-order.integration.test.ts tests/db/product-repository-exports.test.ts
```

Both green. `npx tsc --noEmit -p .` is **expected red** only in `db/seeds/**`, the three raw-SQL price fixtures, and the 22 files of pm73's amended list; list the red files in the progress tracker entry and confirm each is in that set — any other red file is pm72's. Do not run the full suite.

### I5. Docs touched by this unit

- `pm00-build-plan.md`: C19 row and the pm73 row amendment — **done in this unit's spec pass** (the plan is the one place the checklist lives; recording it at pm73 time would be too late for pm73's estimate).
- `prodmgmt-progress-tracker.md`: pm72 entry — the D5 decision (no service change, with the one-line alternative), the D2 integer-like-key note if pm69 D5 was declined, the red-file list.
- `prodmgmt-code-standards.md` Appendix A row **A16** (`product_spec_characteristics .$type<>()` gone — "the schema unit"): add "repository and branch copy rewritten in pm72". §7's placement line for the three services reads "call signature unchanged; repository call changes" — after D5 the accurate wording is "call signature and repository calls unchanged"; record in the tracker and fix in pm75's doc pass (workflow §7.9).

---

## Done when

- A specification saved with `SST_ID` then `SD_ID` renders its chips in that order on Manage Products and View Product with **no component change**; the reverse order renders reversed.
- `display_order` is `1…n` contiguous after every insert and update; `{}` writes no rows; an update replaces the set.
- A branched version's characteristic rows equal the source's `(char_name, char_value, display_order)` triples; the source rows are untouched.
- A raw write to `product_spec_characteristic` under an ACTIVE version fails `23514`; discarding a DRAFT leaves zero characteristic rows.
- `findByOfferingId` is one statement; `findByOfferingIdForUpdate` is two and still locks the specification rows.
- The three specification audit events carry today's key lists; before/after records equal the reads in key order.
- `product-repository-exports.test.ts` still allows exactly the five specification names; `product-offering.ts` compiles end to end; `tsc` is red only in pm73's files.
- C19 is in `pm00-build-plan.md` and pm73's list says 22.

## Out of scope (named so nobody pulls it in)

The four C19 test files and the four seed files (pm73); the optional integer-like-name rejection (pm69 D5); `instance_characteristics` / `ordered_characteristics` and `validation/characteristics.schema.ts` (Q5 follow-ons); a `displayOrder` field on `SpecificationCard` or a sort in any panel (§2.32, §4.31); a result code for `23505`/`23514` on this aggregate (§1.51); a repository for characteristics of their own (§7.14 — one repository per aggregate).
