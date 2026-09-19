# pm38 — Price completeness + DRAFT-only price mutation

**Unit:** pm38 (Part 3). **Boundary:** one vertical slice — `validation/product/**`, `db/repositories/product-offering-price.ts`, `services/product/**` (price writes only), `actions/product/**`, and `components/products/manage/price-form.tsx`. No page rebuild, no transition service.
**Specs from:** `prodmgmt-architecture.md` §3.2, §3.5, Inv. #1 (amended), #28 · `prodmgmt-code-standards.md` §1.2, §1.12, §2.8, §6.5 · plan D3, D7, D12, D13 · `prodmgmt-update-overview.md` goal 5, criteria 9.
**Depends on:** pm36 (the DRAFT-guard trigger is the backstop this unit's service guard mirrors), pm37 (`UnitOfMeasure`, `RecurringPeriodType`).

---

## Goal

Make a price row complete for its type — a charge period for `recurring`, a unit of measure for `usage`, neither for `once` — and let a user correct or remove a price on a `DRAFT` version, while every write against a released version is refused by the repository and by the trigger.

---

## Design

### D1. The impossible combination is untypeable, not merely rejected

`priceCharacteristicsSchema` already discriminates on `pricing_model`. The new `priceInputSchema` discriminates on `priceType` and nests it:

| Branch | Requires | Forbids |
|---|---|---|
| `recurring` | `recurringChargePeriodLength ∈ {1,3,12}`, `recurringChargePeriodType = 'months'` | `unitOfMeasure` |
| `usage` | `unitOfMeasure ∈ {Mbps, GB, MB, EA}` | period fields |
| `once` | — | both |

Optional-and-nullable fields with a `superRefine` would also reject bad input, but they let a caller *construct* a recurring price with a unit of measure and find out at runtime. The discriminated union makes that a compile error at every call site, which is the point (code-standards §2.8).

### D2. Two schemas, one shared core

`price-input.schema.ts` holds the union above plus name, currency, GL code and `priceCharacteristics`. `insert-price.schema.ts` composes it with `startDateTime` and the existing 3-day backdating fast-fail. `update-price.schema.ts` composes the same core with `startDateTime` — a DRAFT price's start date is editable, since the version has never been orderable. Neither schema re-declares the amount-XOR-tiers or tier-contiguity rules; those stay in `pricing-characteristics.schema.ts` alone.

### D3. The repository guard is a locked parent read, not a WHERE clause

`updatePrice` and `deletePrice` take `(tx, productOfferingPriceId, …)` and begin by resolving the parent and locking it:

```
SELECT o.lifecycle_status
  FROM product.product_offering_price p
  JOIN product.product_offering o ON o.product_offering_id = p.product_offering_id
 WHERE p.product_offering_price_id = $1
   FOR UPDATE OF o
```

Not found → `PRICE_NOT_FOUND`. Status other than `DRAFT` → `OFFERING_NOT_DRAFT`. Only then the `UPDATE`/`DELETE`. A `WHERE … AND status = 'DRAFT'` variant would report "0 rows affected" without telling the caller whether the price was missing or the version was released, and it would not hold the parent still for the duration of the statement.

### D4. Adding a price to an `ACTIVE` version still branches; updating and deleting never do

`insertPrice` keeps its branch-first behaviour: adding a price to an `ACTIVE` version clones it to a new `DRAFT` and inserts there. `updatePrice` and `deletePrice` do **not** branch — a request to change a specific existing price row on a released version is not a request to create a new version, and silently creating one would be a surprising mutation. They return `OFFERING_NOT_DRAFT` and the UI tells the user to edit the open draft instead.

### D5. Warnings are not errors

A tiered `recurring` price (bm29 fails the account `RECURRING_PRICE_UNSUPPORTED`) and a tiered `usage` price (rating v1 is `FLAT`-only) both **save**, with the `--bg-warning` banner from `prodmgmt-ui-context.md` §4. A missing period, a missing unit, a value outside either list, or an out-of-tolerance backdate is a `FieldError` that refuses the save (code-standards §1.19, plan D13).

### D6. The two guardrails this unit rewrites

`tests/guardrails/product-module-boundaries.test.ts` currently asserts the price repository exports **no** `update*`/`delete*` and that `actions/product/` holds exactly eight files. Both fail the moment this unit lands, by design. They are rewritten here, in the same commit, to the amended rules — never deleted, never skipped.

---

## Implementation

### I1. `validation/product/price-input.schema.ts` (new)

The D1 discriminated union, built from `PRICE_TYPES`, `UNITS_OF_MEASURE`, `RECURRING_PERIOD_TYPES`, `RECURRING_PERIOD_LENGTHS` (pm37). Field-level messages name the rule: "A recurring price needs a charge period", "Choose a unit of measure for a usage price", "Charge period must be 1, 3 or 12 months". Export `PriceInput`.

### I2. `insert-price.schema.ts` / `update-price.schema.ts`

Recompose `insertPriceSchema` from I1 plus `startDateTime` and the existing `THREE_DAYS_MS` fast-fail, preserving its current comment about the authoritative service-side check. Add `updatePriceSchema` with the same shape. Do not duplicate the tolerance constant a third time — import it from a single module-local source or keep the two existing copies exactly as the current comment describes, and state which you chose.

### I3. `db/repositories/product-offering-price.ts`

Add `updatePrice` and `deletePrice` per D3, both returning a typed result rather than throwing for the expected cases. Replace the file-header comment that says `insertPrice` is the only write this repository will ever gain with the amended rule (Inv. #1) and a pointer to `prodmgmt-code-standards.md` Appendix A. Keep `findByOfferingIdWithDerivedEnd` and `insertPrice` unchanged.

### I4. Services

- `services/product/update-price.ts` — `updatePrice(priceId, input, actorId, now = new Date())`: backdating check against `now`, transaction, repository call, one `PRODUCT_PRICE_UPDATED` audit event carrying before and after values. Result codes: `PRICE_NOT_FOUND`, `OFFERING_NOT_DRAFT`, `BACKDATED_START_TOO_FAR`, plus a `DUPLICATE_START` translation of the unique-index violation on (offering, price_type, start_date_time).
- `services/product/delete-price.ts` — same shape, `PRODUCT_PRICE_DELETED` audit event carrying the deleted row in `beforeData`, `afterData: null`.
- `services/product/insert-price.ts` — extend `priceData` with the period and unit fields from the parsed input; the branch-first logic, the TOCTOU-safe locked status read and the audit event stay exactly as they are.

### I5. Actions

`actions/product/update-price.action.ts` and `delete-price.action.ts`, following `insert-price.action.ts` line for line: `requirePermission(PRODUCTS, EDIT)` → `isRedirectError` catch → `safeParse` → service → `revalidatePath` on both product pages → typed result. The price id travels as its own parameter, never inside `rawInput` (the pm22 convention). `delete-price.action.ts` takes only the id.

### I6. `components/products/manage/price-form.tsx`

- Render the period fields when `priceType === 'recurring'` (length as a select of 1 / 3 / 12 with the cycle it maps to shown as helper text — "1 month — bills on a monthly cycle"; type fixed to `months` and rendered read-only until a second value exists).
- Render the unit select when `priceType === 'usage'`, options from `UNITS_OF_MEASURE`, no free text, casing preserved.
- Clear and hide both groups when the type changes, so a switched type cannot submit stale fields.
- Add the D5 warning banner beneath the pricing-model control for the two unbillable shapes.
- Keep the existing backdating banner and the "this creates a new draft" banner exactly as they are.
- Wire an Edit and a Delete affordance per price row in the existing dialog for `DRAFT` versions only; on any other status render neither. (The inline panel versions of these arrive in pm41; this unit proves the path end to end in the surface that exists today.)

### I7. Tests

- `tests/validation/price-input.test.ts`: each branch's required and forbidden fields; `'MBPS'`, `'gb'`, length 6, `'years'` all rejected; a valid instance per price type accepted.
- `tests/db/product-price-writes.integration.test.ts`: update and delete succeed on a `DRAFT`; both return `OFFERING_NOT_DRAFT` on `TESTING`, `ACTIVE`, `OBSOLETE`, `RETIRED`; the trigger rejects the same operations issued as raw SQL; an update colliding with a sibling's start date returns `DUPLICATE_START`; every success writes exactly one audit row of the right type inside the same transaction.
- `tests/guardrails/product-module-boundaries.test.ts`: rewrite the price-repository assertion to "exports exactly `findByOfferingIdWithDerivedEnd`, `insertPrice`, `updatePrice`, `deletePrice`, and the two mutators each contain a `DRAFT` status check"; extend `PRODUCT_ACTION_FILES` with `update-price.action.ts → updatePriceAction` and `delete-price.action.ts → deletePriceAction`.

---

## Dependencies

**Packages to install: none.** Zod, Drizzle and the existing form primitives cover it. No new UI library, no date library — the backdating check stays plain `Date` arithmetic as it is today.

---

## Verification checklist

- [ ] A recurring price without a period, a usage price without a unit, and a `once` price carrying either are rejected by Zod **and** by the database.
- [ ] `1`, `3`, `12` months are accepted; `6` months and `1 year` are rejected with the field-level message.
- [ ] `Mbps`, `GB`, `MB`, `EA` are accepted; `MBPS` and `gb` are rejected, not normalised.
- [ ] A DRAFT price can be edited and deleted through the action; the audit log gains exactly one event per operation with before and after values.
- [ ] The same operations against `TESTING`, `ACTIVE`, `OBSOLETE` and `RETIRED` return `OFFERING_NOT_DRAFT`, and the raw-SQL equivalents are refused by pm36's trigger.
- [ ] Adding a price to an `ACTIVE` version still branches to a new `DRAFT` and leaves the live version byte-identical (guardrail 9 unchanged and green).
- [ ] An update that collides on (offering, price type, start) returns `DUPLICATE_START` rather than a raw database error.
- [ ] A tiered recurring price and a tiered usage price save, each showing its warning banner; neither blocks.
- [ ] The rewritten guardrails pass and assert the amended rules; `PRODUCT_ACTION_FILES` lists ten files.
- [ ] `tsc --noEmit`, ESLint, Prettier clean; no page rebuild and no transition service in this diff.

**Definition of done:** in the existing Manage Products dialogs a user creates a monthly recurring price and a per-GB usage price, corrects a typo in the recurring amount on the draft, deletes the spare price row — and the same actions against the live version are refused with a message that says why.
