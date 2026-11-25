# pm71 — Price repository: `toEnvelope` / `fromEnvelope`, three writes, one relational read, branch copy

**Unit:** pm71 (Part 6). **Boundary:** `db/repositories/product-offering-price.ts` (rewritten around the six tables; the envelope is now a projection); `db/repositories/product-offering.ts` (`branchOfferingAsDraft`'s **price half** only); `services/product/insert-price.ts` (one expression in the audit payload — D8); `tests/guardrails/price-lane-key-consistency.test.ts` (the repository site's lane term); two **new** test files. **No action, no component, no page, no seed, no fixture, no flow, no Zod branch, no `types/product.ts` change.** `db/schema/product.ts` is pm70's and is not reopened; the specification half of `branchOfferingAsDraft` and `product-specification.ts` are pm72's.
**Specs from:** `_updatemodule-product-normalize-spec-price-tables-plan.md` §2.4–§2.7, §3, §5 items 1–4 · `prodmgmt-update-overview.md` › Goals 1–5, 9, Features (prices) · `prodmgmt-architecture.md` §3.2–§3.4, §3.6, Inv. **#61, #62, #63, #65, #68, #70, #73**, amended **#30, #31** · `prodmgmt-code-standards.md` **§1.49–§1.52, §1.58–§1.61, §1.63**, §2.27–§2.31, §3.24, guardrails **42, 43, 44, 45** (price half), re-scoped **2, 16, 27, 32, 41** · `prodmgmt-ai-workflow-rules.md` §0.2 row 3, §0.1 **G-N5**, §1.5, §3.4, §4.2, §5.4, §7.9, §8.3 · `pm00-build-plan.md` Part 6 › pm71 row, **C14, C18**.
**Depends on:** **pm70** (the six tables, `relations()`, `price_type` on the header, the view — all at HEAD before this unit starts); **pm69** (`canonicalDecimalString` and the Zod caps, which are what make D2's round-trip exact rather than lucky); **G-N5** (this unit commits inside the window: `tsc` is red in seeds, fixtures and the 18 test files until pm73, and that is expected — the commit message says `tsc red by G-N5; closes at pm73`).

**Gate, in one paragraph.** **G-N5:** this unit is the second commit on the Part 6 branch. It makes the repository compile against pm70's schema and makes its **own** two test files green; it does not try to make the tree green, and it adds no shim, no dual-read and no `priceComponent` compatibility field to get there (workflow §4.2). A unit that touches a seed, a fixture under `tests/`, or any of the 18 files to "unbreak" them has taken pm73's work and left scope.

---

## Goal

Make the repository the **only** place an envelope exists: every read reassembles a `PricingComponent` from a header and its subtype rows through `toEnvelope`, every write decomposes one through `fromEnvelope` into a header plus children in one transaction and the §1.50 order, the detail page's prices still arrive in **one** query, a branch copies grandchildren by row under an id map, and the audit payloads of the three price events are **byte-identical** to today's on the same input — so nothing above the repository (`PriceCard`, `OfferingDetail`, the three services' result types, the UI) notices the storage changed.

---

## Design

### D1. What this file is after pm71 — one translation point, three writes, one read

`db/repositories/product-offering-price.ts` keeps its public surface: the `productOfferingPriceRepository` object exports **exactly** `findByOfferingIdWithDerivedEnd`, `insertPrice`, `updatePrice`, `deletePrice` (the guardrail in `tests/db/product-repository-exports.test.ts` still lists three mutations and no `pop*` name); `toPriceWriteData`, `PriceWriteData`, `PriceWriteSnapshot`, `UpdatePriceRepoResult`, `DeletePriceRepoResult` keep their names and shapes. Two **module-level named exports** are added — `toEnvelope` and `fromEnvelope` — exported so the round-trip guardrail (I1) can call them directly, and **not** placed on the repository object (they are not queries; general §7.6). §1.49's "nowhere else" is enforced by I3: outside this file, only `tests/**` may reference either name.

What disappears from the file: `priceComponent` in every column map, `PRICE_SNAPSHOT_COLUMNS.priceComponent`, the `flatFeePriceType` `CASE` term, and `toSnapshot`'s `priceComponent` destructure. What is added: `PriceRowWithChildren` (D2), `toEnvelope`, `fromEnvelope`, `toSnapshot(header, children)`, the relational read, and the header/children write sequences (D4–D6).

### D2. Row types stay inside the file; the children shape mirrors the `relations()` names

```ts
type PriceHeaderRow = typeof productOfferingPrice.$inferSelect;          // now has priceType, no priceComponent
type PriceChildren = {
  type: typeof priceComponentType.$inferSelect;                           // D3 — the reference row
  usageRate: typeof popUsageRate.$inferSelect | null;
  flatFee: typeof popFlatFee.$inferSelect | null;
  capacityCommitment: typeof popCapacityCommitment.$inferSelect | null;
  motivationSteps: Array<typeof popMotivationStep.$inferSelect>;          // ORDER BY above_quantity
};
type PriceRowWithChildren = PriceHeaderRow & PriceChildren;
```

Declared in this file, never in `types/product.ts` (§2.28). The property names are **exactly** the relation names pm70 declared in `productOfferingPriceRelations` (§2.27) so a `db.query.productOfferingPrice.findMany({ with: … })` result is a `PriceRowWithChildren[]` without a mapping step. Drizzle's `$inferSelect` types the `numeric` columns as `string` — that is the padded `"100.000000"` node-postgres returns, and it is the input `canonicalDecimalString` was written for (§1.52).

### D3. The reference row rides on the same query — a sixth relation, recorded as a doc disagreement

§1.59 says `appliesAt`, `basis` and the capacity `plaSpecId` come **from `price_component_type`**; §7.14 says the reference tables "are read inside `toEnvelope`'s query and have no repository of their own"; §3.24 says the price query count holds at one. The only way all three hold is for the reference row to arrive through the same relational query: pm71 reads it through the **`type` relation pm70 D11 declares** (`one(priceComponentType, { fields: [productOfferingPrice.componentType], references: [priceComponentType.componentType] })`) in `with: { type: true, … }`. §2.27 lists five relation names (`usageRate`, `flatFee`, `capacityCommitment`, `motivationSteps`, `offering`) and no `type` — a doc disagreement pm70 records and pm75's doc pass fixes in §2.27 (workflow §7.9). If pm70 somehow landed without the relation, adding the one line to `productOfferingPriceRelations` is the single exception to "pm70's file is not reopened" (a relation, not a table). A constant map in TypeScript would satisfy the Zod literals just as well but would make `appliesAt`/`basis` a code fact rather than a data fact, which is the opposite of what the reference tables are for (Inv. #64, #65).

### D4. `toEnvelope(header, children): PersistablePricingComponent`

Pure. Builds the object with **today's key order** (the `buildComponentEnvelope` order: `@type`, `specVersion`, `plaSpecId`, `priceType`, `appliesAt`, `basis`, `boundTo`, `params`), then `return persistablePricingComponentSchema.parse(obj)` — a row set that does not parse **throws**, exactly as today's read path throws on a corrupt column (§1.49). Switch on `header.componentType` with a `never` default (§2.30):

| `componentType`        | child required (throw `toEnvelope: header <id> (<type>) has no <table> row` if absent) | `plaSpecId`                                                      | `priceType`                | `boundTo`                                | `params`                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `usage_rate`           | `usageRate`                                                                              | `usageRate.rateCardLookup !== null ? "PLA_USAGE_RATE" : null`     | `header.priceType`         | `{ unitOfMeasure: header.unitOfMeasure }` | `{ ratePerUnit: canon(usageRate.ratePerUnit), rateCardLookUp: usageRate.rateCardLookup }`                                             |
| `flat_fee`             | `flatFee`                                                                                | `null`                                                           | `header.priceType`         | `null`                                   | `{ amount: canon(flatFee.amount) }`                                                                                                   |
| `capacity_commitment`  | `capacityCommitment`                                                                     | `children.type.plaSpecId`                                        | `header.priceType`         | `{ unitOfMeasure: header.unitOfMeasure }` | `{ committedQuantity: Number(canon(capacityCommitment.committedQuantity)) }`                                                          |
| `capacity_motivation`  | `motivationSteps.length >= 1`                                                            | `children.type.plaSpecId`                                        | `header.priceType`         | `{ unitOfMeasure: header.unitOfMeasure }` | `{ steps: motivationSteps.map(s => ({ aboveQuantity: Number(canon(s.aboveQuantity)), ratePerUnit: canon(s.ratePerUnit) })) }`          |

Common to all four: `"@type": header.componentType`, `specVersion: 1`, `appliesAt: children.type.appliesAt`, `basis: children.type.basis`. `canon` is `canonicalDecimalString` from `lib/decimal-string.ts` and is the **only** function in the file that touches a money string's text (§2.31); quantities are `Number(...)` **after** the strip, never `parseFloat`. `header.unitOfMeasure` is `null` for `flat_fee` and non-null for the other three by the per-type CHECKs pm70 re-added — the `strictObject` for `boundTo` is what turns a violated CHECK into a thrown parse error here. Note `plaSpecId` for the two capacity types is read from the reference row (`'PLA_CAPACITY_COMMITMENT'`, `'PLA_CAPACITY_MOTIVATION'`), while `usage_rate`'s is derived from `rate_card_lookup` because its reference row carries `NULL` (Inv. #65); the view computes the same expression for SQL readers and the two derivations are compared by the parity suites, not by shared code (§1.59).

`"@type"` comes from the **header**. A child of the wrong type cannot be attached (the composite FK, Inv. #62), so the switch never has to reconcile a header/child disagreement; it only has to notice an absent child.

### D5. `fromEnvelope(component): { priceType, child }` — the write-side decomposition

```ts
type ChildWrite =
  | { table: "pop_usage_rate";           row: { ratePerUnit: string; rateCardLookup: string | null } }
  | { table: "pop_flat_fee";             row: { amount: string } }
  | { table: "pop_capacity_commitment";  row: { committedQuantity: string } }
  | { table: "pop_motivation_step";      rows: Array<{ aboveQuantity: string; ratePerUnit: string }> };
export function fromEnvelope(component: PersistablePricingComponent): { priceType: EnvelopePriceType; child: ChildWrite }
```

Switch on `component["@type"]` with a `never` default. `priceType` is `component.priceType` for all four (the pair FK and pm70's seed make `(usage_rate, usage)`, `(flat_fee, recurring|oneTime)`, `(capacity_commitment, commitment)`, `(capacity_motivation, discount)` the only pairs that commit). Money strings are written **as the strings Zod validated** — `numeric` accepts the text and pm69's cap guarantees it fits; quantities are written as `String(n)` (pm69's refinement already proved `String(n)` matches `^\d{1,14}(\.\d{1,6})?$`, so no exponent form can reach the column). Nothing in `fromEnvelope` normalizes: `"5500.00"` is written as `"5500.00"`, stored as `5500.000000`, and read back as `"5500"` — that is C18, and it is why guardrail 42 compares to `canonical(x)` (I1), not to `x`'s text. The function never writes `component_type` on the child: each `pop_*` table's `component_type` takes its **default** and is pinned by its CHECK (§6.36); the composite FK does the matching.

### D6. The three writes — header then children, one transaction, one order

The write data shape is unchanged: `PriceWriteData.component` is still the parsed `PersistablePricingComponent` built by `toPriceWriteData` (its `buildComponentEnvelope` is untouched — it builds from **input**, which is the one place in the app an envelope is assembled from a form, and §1.49 names the repository as that place). The header column set is `{ …today's columns minus priceComponent, priceType }`.

**`insertPrice(tx, { productOfferingId, …data })`** — `fromEnvelope(data.component)` → `INSERT` header (`componentType: data.component["@type"]`, `priceType`, no `priceComponent`) `RETURNING` the full header row → `INSERT` the child row or step rows `RETURNING *` → return `{ productOfferingPriceId, component: toEnvelope(headerRow, childrenFromReturning) }`. The second return field is new (D8). Two statements for the three 1:1 types, two for a motivation (steps are one multi-row `INSERT`). The deferred completeness trigger (pm70 D5) sees the header complete at COMMIT; the lane unique index fires on the header `INSERT` with its **unchanged name**, so `isUniqueViolation(err, "product_offering_price_lane_start_unique")` in the three services still maps to `DUPLICATE_START` (§1.51).

**`updatePrice(tx, id, data, validate)`** — `lockParent` unchanged (its `FOR UPDATE OF o` alias idiom is kept verbatim). Then, in this order and no other:

1. **Before snapshot:** one relational read of the row — `db.query.productOfferingPrice.findFirst({ where: eq(id), with: { type: true, usageRate: true, flatFee: true, capacityCommitment: true, motivationSteps: { orderBy: asc(aboveQuantity) } } })` → `toSnapshot(row)`. Missing → `PRICE_NOT_FOUND` (the parent lock is held, so this cannot happen in practice; the branch stays, as today).
2. `validate(locked.offeringId)` — a refusal returns through with **nothing written**, as today.
3. **Delete the existing children** (`DELETE FROM pop_<old type> WHERE product_offering_price_id = id`, or all steps for a motivation).
4. **Update the header** — every column today's `.set()` writes, with `priceComponent` replaced by `priceType` and `componentType: data.component["@type"]` — `RETURNING` the full header row, `WHERE id AND productOfferingId = locked.offeringId` (the backstop stays).
5. **Insert the new children** `RETURNING *`.
6. `after = toSnapshot(headerRow, childrenFromReturning)`; return `{ ok: true, offeringId, before, after }`.

Steps 3→4→5 is the §1.50 "type changed" order, and it is **also** a correct "type unchanged" order (replace = `DELETE` then `INSERT`): one sequence serves both branches, so the repository does not branch on whether the type changed and cannot get the two cases out of step. The composite FK is `NO ACTION`, so a header `UPDATE` of `component_type` while a child references it fails (Inv. #70, guardrail 44) — step 3 before step 4 is what makes it legal; the deferred trigger makes the state after step 3 legal until COMMIT (Inv. #63). A `price_type` change within the same type (`recurring` → `oneTime`) goes through the same six steps.

**`deletePrice(tx, id, validate)`** — `lockParent` → relational read (as step 1) → `validate` → `DELETE` the header `RETURNING product_offering_price_id, product_offering_id`; the children go by `ON DELETE CASCADE` (§6.36) and the completeness trigger's parent-gone branch passes (pm70 D5). `before` is the snapshot from the read, not from `RETURNING` (a header row alone can no longer produce a snapshot). Return shape unchanged.

**Query count per write, for §3.24:** insert 2 (was 1); update 1 + 1 + 3 (was 2); delete 1 + 1 (was 1). Each is a fixed count per write, never per row, and none is on a render path.

**Every write runs inside a transaction — a hard rule, not a convention.** The completeness trigger is `INITIALLY DEFERRED`, which means it fires at COMMIT; on a bare connection each statement is its own COMMIT, so `insertPrice` called with `db` instead of a `tx` fails on the header `INSERT` with `23514` before the child row is ever written. The three services already pass `tx`; pm73's seeds and fixtures must too (pm73 D2). That failure is Inv. #63 doing its job, and the fix is always the transaction, never a change to the trigger.

### D7. `toSnapshot(header, children): PriceWriteSnapshot` and the snapshot's key set

`PriceWriteSnapshot` keeps **exactly** today's ten fields — `productOfferingId, name, componentType, component, currency, glCode, recurringChargePeriodLength, recurringChargePeriodType, unitOfMeasure, startDateTime` — with `component = toEnvelope(header, children)`. **`priceType` is not added to the snapshot**: the services spread the snapshot into `beforeData` / `afterData`, so a new key would change every audit payload (§1.63); the value is already inside `component.priceType`. `PRICE_SNAPSHOT_COLUMNS` is deleted (the snapshot is now built from a relational row, not a column map).

### D8. Audit byte-identity — and the one service line that changes

`update-price.ts` and `delete-price.ts` build their payloads from `result.before` / `result.after` and need **no change**: the snapshot keys are unchanged (D7) and `component` is the reassembled envelope. `insert-price.ts` today spreads `...priceData` into `afterData`, so its `component` is the **parsed input** envelope, not a re-read — which §1.63 ("built by `toEnvelope` on rows read inside the same transaction") does not allow, and which would disagree with the first read by exactly C18's trailing zeros (`"12.50"` in the event, `"12.5"` on the card). pm71 changes **one expression** in `insert-price.ts`:

```ts
afterData: {
  offeringId: targetOfferingId,
  ...(branched ? { branchedFromOfferingId: offeringId } : {}),
  ...priceData,
  component: inserted.component,   // reassembled from the RETURNING rows — §1.63
  backdated,
},
```

JavaScript keeps a key's **first** insertion position on reassignment, so `component` stays where `...priceData` put it and the payload's key order is unchanged; on any input without trailing zeros the bytes are identical to today's. The service's result type, its error mapping and its `OfferingComponentViolationError` path do not change; `EXPECTED_PRODUCT_ACTION_FILES` stays at 17 (§1.48 — a service is not an action).

### D9. `findByOfferingIdWithDerivedEnd` — one relational query, the window re-partitioned on columns

```ts
const rows = await db.query.productOfferingPrice.findMany({
  where: eq(productOfferingPrice.productOfferingId, productOfferingId),
  with: { type: true, usageRate: true, flatFee: true, capacityCommitment: true,
          motivationSteps: { orderBy: asc(popMotivationStep.aboveQuantity) } },
  extras: {
    endDateTime: sql<Date | string | null>`lead(${productOfferingPrice.startDateTime}) over (
      partition by ${productOfferingPrice.productOfferingId}, ${productOfferingPrice.componentType}, ${productOfferingPrice.unitOfMeasure}, ${productOfferingPrice.priceType}
      order by ${productOfferingPrice.startDateTime}
    )`.as("end_date_time"),
  },
  orderBy: [asc(componentType), asc(unitOfMeasure), asc(priceType), asc(startDateTime), asc(productOfferingPriceId)],
});
return rows.map(row => ({ …today's card fields, componentType: row.componentType, component: toEnvelope(row, row), endDateTime: toDateOrNull(row.endDateTime) }));
```

The partition is the plain-column lane `(product_offering_id, component_type, unit_of_measure, price_type)` — the same five-less-one columns as pm70's unique index, so a flat fee's `oneTime` and `recurring` lanes still never truncate each other (pm46a) and the `CASE … price_component` term is gone (guardrail 41). The `where` applies before the window, as today. The result is one statement: Drizzle's relational builder emits the 1:1 relations and the reference row as lateral joins and the steps as one `json_agg` lateral — **never one query per row, never a `Promise.all` over headers** (§1.61). `PriceCard`'s shape is unchanged: `componentType: row.componentType`, `component`, no `priceType` field.

**Implementation risk, decided in advance:** if drizzle-orm `^0.45.2`'s relational builder rejects a window function in `extras` (it accepts `sql`…`.as()` over the table's own columns, which this is, but the window has not been used there in this codebase), the fallback is a hand-written `db.select(…).from(productOfferingPrice).leftJoin(priceComponentType).leftJoin(popUsageRate).leftJoin(popFlatFee).leftJoin(popCapacityCommitment)` plus a `json_agg(... order by above_quantity)` lateral subquery for the steps, with the same window — **still one statement**. §1.61's first `relations()` consumer then becomes the two single-row reads in D6, which carry no window. Record which form shipped in the file's header comment and in the progress tracker.

### D10. `branchOfferingAsDraft` — the price half copies rows, not envelopes

Today's price half (`db/repositories/product-offering.ts`, the `sourcePrices` block) selects the source headers and inserts them with `priceComponent` copied verbatim. After pm71:

1. **Read** the source prices with their children in one relational query (`findMany({ where: eq(productOfferingId, sourceOfferingId), with: { usageRate, flatFee, capacityCommitment, motivationSteps } })` — `type` is not needed here).
2. **Insert the new headers** in one multi-row `INSERT`, every column copied as today (`priceType` added, `priceComponent` gone, `createdAt` still copied — "byte-identical in content"), `RETURNING product_offering_price_id, component_type, unit_of_measure, price_type, start_date_time`.
3. **Build the id map by lane key, not by row position.** For each returned row the key is `[component_type, unit_of_measure ?? "", price_type, start_date_time.toISOString()].join("\u0000")`; the lane unique index (`NULLS NOT DISTINCT`, pm70 C14) guarantees the key is unique within one offering, so `Map<laneKey, newId>` is total and the copy does not depend on Postgres returning `VALUES` rows in input order (which it does in practice and does not promise).
4. **Copy the children column-for-column** under the mapped ids: up to four multi-row `INSERT`s (`pop_usage_rate`, `pop_flat_fee`, `pop_capacity_commitment`, `pop_motivation_step`), each skipped when it has no rows; the stored numeric text is passed through **unchanged** — no `canonicalDecimalString`, no `toEnvelope`, no `fromEnvelope` on this path (§1.60: a round-trip would re-normalize, and the **test** is where envelopes are compared, Inv. #73).

The specification half of the same function (characteristics) is **pm72's**; pm71 leaves it compiling as it is (it still references `productSpecCharacteristics`, which pm70 removed — so this file is one of the places `tsc` is red inside the window until pm72 lands; the price half compiles).

### D11. What does not change, and why each is worth saying

- `services/product/validate-offering-components.ts` reads header columns only (`componentType`, `unitOfMeasure`, `currency`, `startDateTime`) and never read `price_component` — **untouched**; its lane for a flat fee is still per `unit_of_measure = NULL`, which is why pm46a's two flat-fee lanes are a *uniqueness* concern (the index), not a *validation* one.
- `lockParent` — unchanged, including the alias comment.
- `toPriceWriteData` / `buildComponentEnvelope` / `toComponentRowColumns` — unchanged; the input→envelope build is what `fromEnvelope` consumes.
- `types/product.ts` — unchanged: `PriceCard`, `OfferingDetail`, `ENVELOPE_PRICE_TYPES`, the `PriceType` comment (pm70 rewrote it under G-N2, A18).
- `lib/db-errors.ts` `isUniqueViolation(err, constraintName)` — unchanged and still the function the services import. _Doc disagreement to record (workflow §7.9): code-standards §1.51 and workflow §0 cite `db/errors.ts` for this helper; `db/errors.ts` exports a two-argument-less `isUniqueViolation(e)` (23505 only) that the price services do not import. The services import from `lib/db-errors.ts`. Correct the two citations in pm75's doc pass; nothing in code moves. **Done 2026-11-18** in the plan docs (code-standards §1.51, workflow §0, pm00's tree-state row) during the plan-vs-tree review, ahead of pm75._
- `components/products/pricing-component-badge.tsx` keeps reading `component.priceType` from the envelope (§4.30); its line-72 comment still says `price_component ->> '@type'` — guardrail 46 strips comments, and §1.48 forbids touching the file in this update; pm75 may list it as a comment-only tidy for a later unit.

---

## Implementation

### I1. `tests/db/product-envelope-roundtrip.integration.test.ts` — guardrail 42 + Inv. #73 (price half) + §1.63

Integration project (DATABASE_URL, per-suite `DROP SCHEMA` + `migrate()` — the migration set now ends at `0056`). One DRAFT offering per test; all writes through `productOfferingPriceRepository.insertPrice` / `updatePrice` / `deletePrice`; all reads through `findByOfferingIdWithDerivedEnd` and, where the test needs raw rows, `db.query.productOfferingPrice.findFirst({ with })`.

1. **Pure round-trip, no database:** for each fixture envelope `x`, `toEnvelope(headerOf(x), childrenOf(fromEnvelope(x)))` deep-equals `canonical(x)` where `headerOf` builds a header row with the type's unit/period columns and `childrenOf` pads the written strings to six decimals (`"100"` → `"100.000000"`) to imitate node-postgres. Fixture set: `usage_rate` with and without `rateCardLookUp`; `flat_fee` `recurring` and `oneTime`; `capacity_commitment`; `capacity_motivation` with **five** bands. Money values across the set: `"100"`, `"0.05"`, `"1234567.123456"`, `"0"`, and `"5500.00"` — the last expected back as `"5500"` (C18: `canonical(x)` rewrites it; every other fixture value is already canonical, so for them `canonical(x)` **is** `x`).
2. **Database round-trip:** insert each fixture through `insertPrice`, read it back through `findByOfferingIdWithDerivedEnd`; `component` deep-equals `canonical(x)`; `"100"` is `"100"`, not `"100.000000"`; `1234567.123456` survives `numeric(20,6)` as a quantity; the five bands come back ascending and `Number`-typed.
3. **Edit, same type:** `updatePrice` a `usage_rate`'s `ratePerUnit`; the result's `before.component` deep-equals the pre-read card's `component` and `after.component` deep-equals the post-read card's; exactly one `pop_usage_rate` row exists for the id after the write.
4. **Edit, type change:** `updatePrice` a `usage_rate` into a `flat_fee` (`oneTime`) in one transaction — succeeds; `pop_usage_rate` has no row for the id, `pop_flat_fee` has one; the header's `component_type` and `price_type` read `flat_fee`, `oneTime`.
5. **Steps replaced, not merged:** `updatePrice` a motivation from five bands to three; exactly three `pop_motivation_step` rows remain and they are the new thresholds.
6. **Delete:** `deletePrice` a motivation; `before.component` deep-equals the card; zero step rows and zero headers remain for the id.
7. **One query (§1.61):** no query-counting helper exists in the test tree today (`product-repositories.integration.test.ts` asserts the §3.14 budget by shape, not by count), so this test builds its own: a second `drizzle(client, { schema, logger })` over the suite's existing connection whose `logger.logQuery` pushes each statement into an array; `findByOfferingIdWithDerivedEnd` on an offering with four prices of four types leaves **exactly one** entry. Keep the counting instance local to this file — it is not a shared helper until a second test needs it.
8. **Derived end (lane on columns):** a dated `usage_rate` successor ends only the `usage_rate` lane; a `oneTime` flat fee at a `recurring` fee's exact start ends neither (pm46a, now on `price_type`).
9. **Branch (Inv. #73, price half):** activate an offering carrying the four fixture types (through the activation service, as the existing branch tests do), insert a price to force a branch; the branch's `findByOfferingIdWithDerivedEnd` envelopes deep-equal the source's, row counts per `pop_*` table under the branch equal the source's, and the source's rows are byte-identical to before (`SELECT *` snapshot compare, as guardrail 9's tests do).
10. **Audit (§1.63):** `insertPrice` through `insertPriceService` with `"12.50"` → the `PRODUCT_PRICE_ADDED` event's `afterData.component.params.amount` is `"12.5"` and equals the card's; the key list of `afterData` equals the list captured from HEAD today (`offeringId`, [`branchedFromOfferingId`], `name`, `componentType`, `component`, `currency`, `glCode`, `recurringChargePeriodLength`, `recurringChargePeriodType`, `unitOfMeasure`, `startDateTime`, `backdated`) in that order — assert `Object.keys(afterData)` against the literal list, not against a snapshot file.

### I2. `tests/db/product-price-normalized-constraints.integration.test.ts` — guardrails 43, 44, 45 (price half), 2 and 27/32 DB arms

Direct SQL (`tx.execute(sql\`…\`)`), one DRAFT offering with a header inserted **through the repository** as the fixture, then raw statements against it; every refusal asserted by SQLSTATE, never by message text.

- **43 — completeness at COMMIT:** a raw header `INSERT` alone commits with `23514` (`product_price_header_incomplete`); a raw motivation header with zero steps, `23514`; `DELETE` the only step of a DRAFT motivation without replacement, `23514` **at COMMIT** (the `DELETE` itself succeeds); header then child in one transaction commits.
- **44 — type pinning:** `INSERT INTO pop_flat_fee` for a `usage_rate` header → `23503`; raw header with `(flat_fee, 'usage')` → `23503` (`product_offering_price_price_type_fk`); `UPDATE product_offering_price SET component_type = 'flat_fee'` while `pop_usage_rate` references it → `23503`; the same `UPDATE` after deleting the child, then inserting `pop_flat_fee`, commits (Inv. #70 — the D6 order, proven in SQL).
- **45 — guard on four price tables, no orphans:** after activation, `INSERT`/`UPDATE`/`DELETE` on each of `pop_usage_rate`, `pop_flat_fee`, `pop_capacity_commitment`, `pop_motivation_step` → `23514` (`child_write_requires_draft`); discard a DRAFT version → zero rows in all four tables for its header ids. (`product_spec_characteristic`'s arm is pm72's.)
- **2 — immutability, DB arm:** the pm70-era assertion that a released header is refused is kept; the four new tables are added to it.
- **32 — envelope strictness, DB arm:** a step `INSERT` duplicating `above_quantity` → `23505` on the step PK; `rate_per_unit = -1` → `23514` on the column CHECK — "independently of Zod", so these go through raw SQL, never through `fromEnvelope`.

### I3. `tests/guardrails/price-lane-key-consistency.test.ts` — the repository site's term, and a `toEnvelope` placement check

- Change the expected lane term so the repository's `lead()` partition is `product_offering_id, component_type, unit_of_measure, price_type` and assert the `CASE … price_component` term appears **nowhere** under the scanned roots. Concretely in the test: `LANE_TERM` becomes the plain column `price_type`; `judgeWindow`'s "full lane key" is `base + "price_type"`, its `RAW_PRICE_TYPE` branch (the `price_component ->> 'priceType'` form that was "proven equal on a flat_fee-only scan") is **deleted** — there is no raw form any more; the "three definition sites" list replaces `db/migrations/0049_product_price_lane_key.sql` with `0056_product_normalize_spec_price.sql` (the index is re-created there under the same name; `0049` is history and no longer defines anything). The yml sites and `rp.py` still carry the old term until pm74 — **this test is red from pm71 to pm74, by design, inside the window**; say so in the test's header comment with the unit numbers so no one "fixes" it by widening the exception list. pm74 I3 makes the `FROM`-detection regex accept the view.
- Add one structural `it`: `toEnvelope` and `fromEnvelope` are referenced (as identifiers, comments stripped) in no file under `app/**`, `actions/**`, `services/**`, `components/**`, `db/seeds/**`, `db/repositories/**` other than `product-offering-price.ts`, or `workflow-management/**` (§1.49, Inv. #61). `tests/**` is allowed.

### I4. The repository file, in the order to write it

1. Imports: drop nothing yet; add `priceComponentType`, `popUsageRate`, `popFlatFee`, `popCapacityCommitment`, `popMotivationStep` from `@/db/schema/product`, `canonicalDecimalString` from `@/lib/decimal-string`, `EnvelopePriceType` from `@/types/product`. The file still imports `persistablePricingComponentSchema` — it is now used by `toEnvelope` instead of the old read map.
2. D2 types, `toEnvelope` (D4), `fromEnvelope` (D5), `toSnapshot` (D7) — above the repository object, next to `toPriceWriteData`, so the four assembly/disassembly functions sit together.
3. Rewrite the four methods per D6 and D9. Delete `PRICE_SNAPSHOT_COLUMNS` and the old `toSnapshot`.
4. Header comment: replace the pm49 "`component_type` + `price_component`" paragraph with the pm71 shape (one translation point; three writes; one relational read; which D9 form shipped). Keep the pm38/pm49 history lines — rewrite, never delete reasoning.

### I5. `product-offering.ts` and `insert-price.ts`

- `branchOfferingAsDraft`: replace the `sourcePrices` block with D10 steps 1–4. Leave the `sourceSpecs` block for pm72 (it will not compile; that is the window).
- `insert-price.ts`: the single `component:` line of D8; `insertPrice`'s return is destructured as `const inserted = await …insertPrice(…)` and `inserted.productOfferingPriceId` replaces the old destructure. Nothing else in the file moves.

### I6. Verification at the end of the unit (workflow §8.3, inside the window)

```bash
npx vitest run tests/db/product-envelope-roundtrip.integration.test.ts tests/db/product-price-normalized-constraints.integration.test.ts tests/db/product-repository-exports.test.ts
```

All green. `npx tsc --noEmit -p .` is **expected red** — list the red files in the progress tracker entry and confirm every one is in pm72's or pm73's boundary (seeds, fixtures, the specification half of `product-offering.ts`, `product-specification.ts`, the 18 files); a red file outside those boundaries is pm71's to fix. `tests/guardrails/price-lane-key-consistency.test.ts` is red on the yml/`rp.py` sites only. Do not run the full suite.

### I7. Docs touched by this unit

- `prodmgmt-progress-tracker.md`: pm71 entry — which D9 form shipped, the red-file list, the guardrail 41 interim state.
- `prodmgmt-code-standards.md` §2.27: add the `type` relation name (D3); §1.51 and `prodmgmt-ai-workflow-rules.md` §0: `db/errors.ts` → `lib/db-errors.ts` (D11) — or defer both to pm75's doc pass, but record them here either way.
- `prodmgmt-code-standards.md` Appendix A row **A19** (lane key, "the schema unit"): add "repository `lead()` re-partitioned in pm71". Any other row of A15–A25 that names `toEnvelope`, the relational read or the branch copy: mark "built in pm71".

---

## Done when

- `toEnvelope(fromEnvelope(x))` deep-equals `canonical(x)` for the fixture set, in memory and through the database; `"100"` reads back as `"100"`.
- Add / edit (same type, type change, steps replaced) / delete of each of the four component types works through the **unchanged** services and Manage Products UI on a DRAFT, each as one transaction.
- Branching an ACTIVE version copies every `pop_*` row and step under new ids; the branch's envelopes deep-equal the source's; the source rows are untouched.
- The detail page's price read is one statement with its subtypes.
- `PRODUCT_PRICE_ADDED` / `_UPDATED` / `_DELETED` payloads have today's key set and order, and their `component` is the reassembled envelope.
- `tests/db/product-repository-exports.test.ts` still shows exactly three price writes; `toEnvelope` / `fromEnvelope` are referenced outside the repository only by tests.
- Guardrails 42, 43, 44, 45 (price half), 2, 27, 32 DB arms green; 41 red only on the sites pm74 owns; `tsc` red only in pm72's and pm73's files.

## Out of scope (named so nobody pulls it in)

Characteristics and the specification repository (pm72); seeds, fixtures and the 18 test files (pm73); the yml/`rp.py` readers (pm74); reporting readers (pm74b); any UI or action file (§1.48); a `priceType` field on `PriceCard` or `PriceWriteSnapshot`; a result code for `23503`/`23514` (§1.51); a repository for the reference tables (§7.14).
