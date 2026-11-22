# pm69 — Decimal helper + Zod scale caps

**Status:** Built. The next unbuilt Part 6 unit is **pm71**.

**Unit:** pm69 (Part 6). **Boundary:** `lib/decimal-string.ts` (new — pure, dependency-free), `validation/product/pricing-component.schema.ts` (one regex and two refinements), `validation/product/product-spec-characteristics.schema.ts` (one refinement, if accepted — D5), and this unit's tests. **No table, no migration, no repository, no service, no action, no component except the existing price form quantity check (D4), no page, no dependency.** The first and only Part 6 unit that lands green on its own, **before** the G-N5 window opens.
**Specs from:** `_updatemodule-product-normalize-spec-price-tables-plan.md` §3 (numeric normalization), **Q3** · `prodmgmt-update-overview.md` › Goals 9, Application layer · `prodmgmt-architecture.md` §1 (Validation row), §3.4, Inv. **#68**, Inv. #32 (amended) · `prodmgmt-code-standards.md` §1.48, **§1.52**, **§1.53**, **§1.55**, §2.31, §4.32, §7.15, §7 tree, guardrail **42** (the test this unit makes pass for a reason) · `prodmgmt-ai-workflow-rules.md` §0.1 **G-N1**, **G-N6b**, §0.2 row 1, §1.6, §4.1, §6.6, §8.5 · `pm00-build-plan.md` Part 6 › pm69 row, C15.
**Depends on:** **G-N1** (Q3 decides `numeric(18,6)` / `numeric(20,6)`, which is what the caps fit); **G-N6b** (the cap is a recommendation beyond the plan). No code dependency.

**Gate G-N1 / G-N6b — the cap exists only because Q3 does.** The six-decimal ceiling is derived from the column types Q3 recommends. If Q3 lands on a different scale, the two regexes in D3 change with it and nothing else in this unit does. If G-N6b is **declined**, this unit shrinks to `lib/decimal-string.ts` alone, and Inv. #68 and guardrail 42 are rewritten first (workflow §0.1 item 6) — do not build the helper and skip the cap "for now"; a helper without the cap makes the round-trip guardrail pass by luck (§1.53).

---

## Goal

Put the two pure facts the rest of Part 6 depends on in place before any row exists: a money string read back from `numeric` is normalized to the canonical decimal string by **one** helper that never rounds and never parses to `number`; and no money or quantity with more than six decimals reaches Zod's output, so the database never has anything to round and `toEnvelope(fromEnvelope(x))` can equal `x` for a reason rather than by luck.

---

## Design

### D1. Why this lands first and alone

Postgres rounds to the declared scale on insert **without error** (`numeric(18,6)` turns `0.1234567` into `0.123457` silently). Three consequences fix the order:

- Deploy the input cap first. Before running `0056`, quiesce catalog writes and run the read-only preflight below on the target database. The cap cannot retroactively change stored JSON. Record the database, date, affected price IDs and fields, and the catalog owner's approved disposition for every result in the pm70 verification record. If a value cannot be migrated exactly to six decimals, wait for that decision and resolve it before running the backfill. No rounding or rejection policy is assumed. Re-run the preflight and do not proceed with any unresolved row. The migration's strict parity check still compares values against the pre-backfill JSON; it must pass with zero mismatches.

```sql
WITH stored_values AS (
  SELECT p.product_offering_price_id, v.field, v.value
  FROM product.product_offering_price AS p
  CROSS JOIN LATERAL (VALUES
    ('ratePerUnit', p.price_component #>> '{params,ratePerUnit}'),
    ('amount', p.price_component #>> '{params,amount}'),
    ('committedQuantity', p.price_component #>> '{params,committedQuantity}')
  ) AS v(field, value)
  UNION ALL
  SELECT p.product_offering_price_id, format('steps[%s].%s', s.pos - 1, v.field), v.value
  FROM product.product_offering_price AS p
  CROSS JOIN LATERAL jsonb_array_elements(p.price_component #> '{params,steps}')
    WITH ORDINALITY AS s(step, pos)
  CROSS JOIN LATERAL (VALUES
    ('aboveQuantity', s.step ->> 'aboveQuantity'),
    ('ratePerUnit', s.step ->> 'ratePerUnit')
  ) AS v(field, value)
)
SELECT product_offering_price_id, field, value
FROM stored_values
WHERE scale(value::numeric) > 6
ORDER BY product_offering_price_id, field;
```
- The helper must precede pm71. `toEnvelope` is written against it; writing the helper inside the repository unit puts a pure function in a diff that should be about the translation point (workflow §4.1).
- Both are pure, so this unit is green on its own and **commits green outside the window** — the only Part 6 unit that does so before pm73.

### D2. `canonicalDecimalString` — one helper, one job

`lib/decimal-string.ts` exports exactly one function, `canonicalDecimalString(value: string): string`, typed string → string (§2.31). Its contract, every case asserted in `tests/lib/decimal-string.test.ts`:

| Input           | Output    | Why                                                                        |
| --------------- | --------- | -------------------------------------------------------------------------- |
| `"100.000000"`  | `"100"`   | node-postgres returns the column's full scale; the envelope never carried it |
| `"0.050000"`    | `"0.05"`  | strip trailing fractional zeros                                       |
| `"0.000000"`    | `"0"`     | a trailing `.` left behind is removed too                                  |
| `"1234567.123456"` | unchanged | six significant decimals survive                                         |
| `"100"`         | `"100"`   | an already-canonical string is a fixed point                               |
| `"5500.00"`     | `"5500"`  | trailing zeros are not significant — see C18 below                         |
| `"100100"`      | `"100100"` | significant integer digits are preserved    |

Redundant leading integer zeros are removed, with one zero retained when the integer part is zero: `"000100.00"` → `"100"`, `"000.050000"` → `"0.05"`. This matches the representation PostgreSQL can return after storing money as `numeric`.

What it never does: round, truncate significant digits, call `Number()` / `parseFloat`, accept a sign, an exponent or a thousands separator, or pad. On any input that does not match `^\d+(\.\d+)?$` it **throws** a `TypeError` — the only caller (pm71's `toEnvelope`) treats a row set that does not reassemble as corruption and throws (§1.49), and a helper that silently returned the garbage would hide exactly that. It has **no imports** and imports nothing from `validation/`, `db/` or `next/*` (§7.15).

The helper is the **only** function in the codebase that edits a money string's text (§2.31). Nothing in this unit calls it yet; pm71 is its first caller. That is deliberate (D1), not an omission.

### D3. The caps — fitted to Q3's columns, declared once, propagated by import

`moneyStringSchema` in `pricing-component.schema.ts` becomes

```
/^\d{1,12}(\.\d{1,6})?$/
```

— twelve integer digits plus six decimals fits `numeric(18,6)` exactly. The regex has a precedent in the tree: `validation/product/ratecard.schema.ts` already guards `rate_per_unit` with the identical pattern (`RATE_PER_UNIT_RE`, pm58 D2) for the identical column type, with the test cases `"123456789012.123456"` accepted and `"0.1234567"` rejected. Reuse the shape; do **not** import across the two files — the rate card's schema is its own contract and §2.16's "no second copy" rule is about a rule's _home_, which for envelope money is this file.

`committedQuantity` (in `capacityCommitmentComponentSchema`) and `aboveQuantity` (in `stepSchema`) keep `z.number().finite().positive()` and gain one refinement each:

```
.refine((n) => /^\d{1,14}(\.\d{1,6})?$/.test(String(n)), { message: … })
```

— fourteen integer digits plus six decimals fits `numeric(20,6)`. Testing `String(n)` rather than `n` is what makes the rule honest: `String(1e21)` is `"1e+21"` and `String(0.1 + 0.2)` is `"0.30000000000000004"`, both refused; a user-typed `0.123456` survives `Number()` → `String()` as `"0.123456"` and passes. **Nothing else in `validation/product/**` changes** (§1.48): eight fields, five types, every branch a `strictObject`, `persistablePricingComponentSchema` keeps its name, D4's `plaSpecId` refinement stays.

**Propagation is by import, not by edit.** `validation/product/price-input.schema.ts` already imports `moneyStringSchema` and `stepsSchema` (pm47 D7, §2.16), so the Manage Products input path and the envelope path tighten together with no second declaration. `negotiatedOverrideComponentSchema` also uses `moneyStringSchema`; that branch is a read-side projection of `ordering.order_item_price_override.amount` (`numeric(12,2)`), which always fits — the ordering wizard validates its own input through `validation/ordering/create-order.schema.ts`, which is **not touched** (workflow §6.9).

### D4. Validate quantity text before conversion

The existing price form checks both `committedQuantity` and every `aboveQuantity` as plain positive decimal text with at most six fractional digits before calling `Number()`. This rejects `1e3` and `1000.0000001` while allowing `1000` and `0.123456`. Zod still validates the converted number on the server; its refinement cannot recover the text. Money remains text through validation, so an over-scale money input is still rejected by the Server Action and displayed on the field.

### D5. Integer-like characteristic names — the optional tightening (§1.55)

JavaScript orders an object's **integer-like** keys (canonical array indices such as `"2"` or `"10"`, not `"02"` or `"1.5"`) ahead of every other key regardless of insertion order: `Object.entries({ b: "1", "2": "x", a: "3" })` yields `"2"` first. pm72 derives `display_order` from `Object.entries(parsed)`, so a characteristic named `"2"` would be silently hoisted to the front of a specification — the one case where "entry order" (Inv. #66) cannot be honoured by the `Record<string,string>` contract.

**Recommendation: build it.** `productSpecCharacteristicsSchema`'s key schema gains `.refine((k) => !/^\d+$/.test(k), { message: "Characteristic name must not be all digits" })`. The `^\d+$` test is a deliberate superset of the hazard (it also refuses `"02"`, which JavaScript would not hoist) because the simpler rule is easier to state in a form error and costs nothing — no seed, fixture or sample file in the tree uses an all-digit characteristic name (grep-verified at `d7ebc02`), so no existing specification becomes unsaveable. The specification form posts the record and renders an unmatched server error key in its residual error list (specification-form.tsx, pm41 review #7), so the refusal is visible without a component change.

What this does **not** touch: `validation/characteristics.schema.ts` (`characteristicsRecordSchema`, the ordering/inventory copy) — out of scope by the update's first line (workflow §3.1), and those columns stay jsonb with no `display_order` to protect. The two schemas are allowed to differ here; that difference is the point.

If the owner declines D5 under G-N6: pm72's spec records that integer-like names are hoisted and that this is a known limit of Inv. #66, and guardrail 49 adds no case for it.

### D6. What this unit does not do

- It does **not** canonicalize on input. `moneyStringSchema` stays a regex, not a `.transform()`: the input contract's output type and the audit `afterData` shape are untouched (§1.53 "nothing else"). The place money is canonicalized is `toEnvelope` on read (pm71). See C18 for what that means for inputs with trailing zeros.
- It does **not** change the database. The six JSON CHECKs still allow unlimited decimals until pm70 drops them; Zod is the primary guard and that is enough for this unit (Inv. #31).
- It does **not** add a `types/` export, a `lib/money*` module, a formatter change (`formatCurrency` already widens to the string's own scale and never narrows below the currency's — a canonical `"5500"` and a `"5500.00"` render identically), or a second copy of either regex.

### C18 — a finding recorded by this unit, owned by later units

**Money at rest cannot preserve redundant leading or trailing zeros.** `numeric(18,6)` stores `"5500.00"` and `"5500"` identically; `canonicalDecimalString` returns `"5500"` for both. `db/seeds/demo/product-demo.ts` seeds five `flat_fee` amounts as `"5000.00"`, `"5500.00"`, `"1000.00"`, `"1200.00"`, `"2000.00"`. The input schema still accepts and returns the original text. The persisted contract is:

1. **Guardrail 42:** `toEnvelope(fromEnvelope(x))` deep-equals `canonical(x)`, where `canonical` applies `canonicalDecimalString` to every money field. For example, both `"100.00"` and `"000100.00"` parse unchanged and read back as `"100"`. The round-trip preserves canonical inputs and repeated reads are stable.
2. When reopened, the form shows the canonical spelling. Rendered currency is unchanged. Audit `beforeData` and `afterData` both use reassembled envelopes (§1.63), so a formatting-only difference is not reported as a money change.
3. **Raw-SQL fixtures and the `rm08` / `rm30` snapshots** that assert a money string textually must assert the canonical form after pm71. **pm73** owns that sweep.

Recorded here because this is the unit that defines "canonical"; it is not a defect of this unit.

---

## Implementation

### I1. `lib/decimal-string.ts` (new)

One exported function per D2, with a header comment in the house style of `lib/csv.ts` naming its single caller-to-be (`db/repositories/product-offering-price.ts`, pm71) and the rule it serves (§1.52, Inv. #68). No imports. No default export. Not re-exported from anywhere.

### I2. `validation/product/pricing-component.schema.ts`

1. `moneyStringSchema`: replace `/^\d+(\.\d+)?$/` with `/^\d{1,12}(\.\d{1,6})?$/`. Message: `Must be a plain decimal amount with at most six decimal places (e.g. "100" or "12.50")` — the existing message with the cap named. _Wording to confirm with the owner before landing; it renders on the field._
2. `stepSchema.aboveQuantity` and `capacityCommitmentComponentSchema.params.committedQuantity`: append the D3 refinement. Message: `Quantity must have at most six decimal places`.
3. Update the file's header doc-block where it says money is "a decimal string" to add "capped at six decimals (pm69, Inv. #68)"; leave every other line of that block alone — it is the PC11 compliance artifact.
4. Nothing else: no new export, no branch, no field.

### I3. `validation/product/product-spec-characteristics.schema.ts` (D5, if accepted)

Key schema `z.string().min(1)` → `z.string().min(1).refine(…)` per D5. The exported type is unchanged (`Record<string, string>`).

### I4. Tests

`tests/lib/decimal-string.test.ts` (new):

1. Every row of the D2 table, as one `it` per row.
2. Integer digits are never touched: `"100100"`, `"1000000.000000"` → `"1000000"`.
3. Idempotence: `canonicalDecimalString(canonicalDecimalString(x)) === canonicalDecimalString(x)` over the D2 inputs.
4. Throws `TypeError` for `"-1"`, `"1e3"`, `"1,000"`, `""`, `" 100"`, `"100."`, `".5"`.
5. The module has no imports (read the file; assert no `import` line) — the §7.15 purity rule, asserted once.

`tests/validation/pricing-component.schema.test.ts` (existing — add to the refusals and acceptances):

6. `amount: "0.1234567"`, `ratePerUnit: "0.1234567"` and `steps[0].ratePerUnit: "0.1234567"` are refused, each naming its path.
7. `amount: "1234567890123"` (thirteen integer digits) is refused; `"123456789012.123456"` is accepted.
8. `committedQuantity: 0.1234567` and `aboveQuantity: 0.1234567` are refused; `1000`, `0.123456` and `12345678901234.5` are accepted; `1e15` and `1e21` are refused (`String()` form).
9. The worked envelopes of the existing "worked envelopes parse" block still parse unchanged (the cap admits every existing fixture).
10. `price-input.schema.ts`'s `usage_rate`, `flat_fee` and `capacity_*` input shapes refuse the same seven-decimal inputs — proving propagation by import, with no regex of their own (grep the file for `\d{1,12}`: zero hits).

`tests/validation/product-spec-characteristics.schema.test.ts` (existing — D5):

11. `{ "2": "x" }` and `{ "02": "x" }` are refused; `{ SST_ID: "01", A1: "x", "2A": "y" }` is accepted; the existing four cases still pass.

### I5. Documentation (lands with the unit)

1. **Code-standards §7 tree** — `lib/decimal-string.ts`, `tests/lib/decimal-string.test.ts` and the two schema files marked landed under **pm69**; the `(normalize, new)` marker on `decimal-string.ts` removed (workflow §7.1).
2. **Code-standards §1.53 / §1.55** — the D5 decision recorded (built or declined, with date).
3. **`pm00-build-plan.md`** — G-N6b closed with its date; **C18** added to the Part 6 conflicts table with its three owners; **N-R6** added to the hand-off register.
4. **`prodmgmt-progress-tracker.md`** — pm69 landed, green, outside the window.

---

## Dependencies

**Packages to install: none.** The helper is dependency-free by rule (§7.15); the caps are Zod regexes.

**Commands used:** `npm run typecheck`, `npm run lint`, `npx vitest run tests/lib/decimal-string.test.ts tests/validation/pricing-component.schema.test.ts tests/validation/product-spec-characteristics.schema.test.ts`, then `npm run test` in full — this unit commits green.

**Prerequisites:** **G-N1** (Q3) and **G-N6b** recorded. **D5** accepted or declined. The field-error wording (I2.1) confirmed.

---

## Verification checklist

Gates

- [ ] G-N1's Q3 recorded as `numeric(18,6)` / `numeric(20,6)`; G-N6b recorded as accepted (or this unit re-scoped per the gate paragraph).
- [ ] D5 recorded one way or the other in code-standards §1.55.
- [ ] Before each target applies `0056`, run D1’s preflight and record the outcome and owner-approved disposition for any results. Resolve all findings before backfill and require zero parity mismatches.

The helper (§1.52, Inv. #68)

- [ ] Every D2 row passes; significant integer digits are preserved; the function is idempotent.
- [ ] Non-matching input throws `TypeError`; nothing is ever rounded; `Number` / `parseFloat` appear nowhere in the file.
- [ ] `lib/decimal-string.ts` has no imports and is imported by nothing yet (pm71 is the first caller).

The caps (§1.53)

- [ ] `moneyStringSchema` is `^\d{1,12}(\.\d{1,6})?$`, declared once; `grep` finds the pattern in no other file under `validation/product/**` except `ratecard.schema.ts`'s own `RATE_PER_UNIT_RE`.
- [ ] The form rejects a seventh fractional digit and exponent notation before conversion for both quantity fields; Zod separately rejects numbers whose rendered decimal form exceeds the column limits.
- [ ] `price-input.schema.ts` is unchanged and refuses the same inputs by import.
- [ ] Every existing worked envelope, seed and fixture still parses (no seed carries more than six decimals — grep-verified at `d7ebc02`).

Boundaries (§1.48)

- [ ] No file under `app/**`, `actions/**`, `services/**`, `db/**` or `types/**` changes in pm69. The only component change is the quantity check in D4.
- [ ] `validation/characteristics.schema.ts` and `validation/ordering/**` untouched.
- [ ] `EXPECTED_PRODUCT_ACTION_FILES` = 17; no new export from `types/`; no `lib/money*`, no `.transform()` on a money field.
- [ ] `tsc --noEmit`, ESLint, Prettier and the **full** suite green; the commit is green (this unit is outside the window).

Docs

- [ ] §7 tree and the trackers updated; C18 and N-R6 recorded in `pm00-build-plan.md`.

**Definition of done:** a seven-decimal price is refused at Zod before any row exists, a `"100.000000"` from the database has one function that turns it back into `"100"` without rounding, and both are proven by tests that fail on the current tree — so that when pm71 asserts `toEnvelope(fromEnvelope(x)) = canonical(x)`, it passes because the database was never given anything to round.
