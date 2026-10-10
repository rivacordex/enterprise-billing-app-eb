# pm46a — Flat-fee lane key: split recurring and one-time flat fees

**Unit:** pm46a (Part 4 follow-up; closes the "known gap, flagged for follow-up" that pm46 recorded against its own uniqueness rekey and pm49 carried forward). **Boundary:** one forward product migration plus its Drizzle mirror, the product repository's `lead()` window, the bill-run flow's recurring resolver (`_bm29_resolved`), the tests that pin the old lane, and the docs that state the lane key. Cross-domain (product schema + billing flow), so it is **gated**.
**Status:** **DELIVERED (2026-10-10).** Spec reviewed 2026-10-10 (Q1: retire; Q2: leave the seed). Full integration project 1165 passed / 0 failed (was 1151 / 4 failed, all `ordering-read`); full unit suite 4077 passed / 0 failed; `tsc`, ESLint, Prettier clean. Deviation: the offering-detail service check (D7) landed in `product-repositories.integration.test.ts` beside the existing `getOfferingDetail` effectivity test, as an `it.each` over three orderings (recurring first, one-time first, same start), instead of in `product-price-components`. Not run: `0049` against an already-populated pre-`0049` database (the suites migrate from empty; the key is strictly finer, so no existing row can violate it), and a live Kestra bill run (TC54 harness still missing).
**Specs from:** `pm46-price-table-reshape.md` ("Known gap, flagged for follow-up") · `pm49-component-write-path.md` (D3 and its "Known gap, carried from pm46") · `pm52-billrun-runtime-rekey.md` (D3/D4 — the resolver that works around the gap) · `billmgmt-known-issues.md` §21e (the four failing `ordering-read` tests) · `prodmgmt-code-standards.md` §6.4 · `prodmgmt-ui-context.md` §4 · `migrations/README.md` (forward-only).
**Gates (Khek, 2026-10-10):** full scope (option A, not the read-side-only variant); a **new forward migration** for the product table is approved (G-C is **not** reopened: `0006_product.sql` stays locked and is not edited); the bill-run flow change is approved in this unit.
**Depends on:** pm46–pm56b and bm42a, all on `dev1`.

---

## Goal

A recurring flat fee and a one-time flat fee on the same offering are **different price lines**. Adding an Activation Fee must not end the monthly fee. After pm46a:

- the order detail shows both the recurring line and the one-time line (the four `ordering-read` tests go green, unchanged);
- the offering detail shows the monthly fee as **Current**, not **Superseded**, once a later one-time fee exists;
- the bill run bills the monthly fee instead of failing the account HARD with `RECURRING_PRICE_UNSUPPORTED`;
- a recurring and a one-time flat fee **may** start on the same date (the database no longer rejects that);
- two recurring flat fees, or two one-time flat fees, on one offering at one start are still rejected.

## The problem in one paragraph

Succession ("this row's end is the next row's start") and uniqueness are both keyed on the **lane** `(product_offering_id, component_type, unit_of_measure)`. Every `flat_fee` has `unit_of_measure = NULL`, so recurring and one-time flat fees share one lane. A one-time fee dated after the monthly fee therefore *supersedes* it: the repository's `lead()` gives the monthly fee an end date, the order and offering reads drop or mute it, and the bill run's as-of window resolves the one-time row and (per pm52 D4) fails the account HARD. The same key on the unique constraint forbids the two fees from starting on one date, which is why the demo seed and the `ordering-read` fixture offset the Activation Fee by one day, which in turn triggers the supersession.

---

## Design

### D1. The lane key adds the envelope `priceType`

The lane becomes **`(product_offering_id, component_type, unit_of_measure, price_component ->> 'priceType')`**, exactly as pm46 prescribed.

The expression is applied **uniformly**, not only to `flat_fee`. For every other component type the envelope `priceType` is a fixed literal per branch (pm47: `usage_rate` → `usage`, `capacity_commitment` → `commitment`, `capacity_motivation` → `discount`), so it is constant within those lanes and **their lanes do not change**. Only `flat_fee` splits, into a `recurring` lane and a `oneTime` lane. A uniform expression keeps one key everywhere (constraint, repository, flow) instead of a `CASE` repeated in each place.

### D2. Uniqueness: a unique **index** with `NULLS NOT DISTINCT`, in a new forward migration

`0049_product_price_lane_key.sql`:

```sql
ALTER TABLE "product"."product_offering_price"
  DROP CONSTRAINT "product_offering_price_component_start_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "product_offering_price_lane_start_unique"
  ON "product"."product_offering_price"
  ("product_offering_id", "component_type", "unit_of_measure",
   ("price_component" ->> 'priceType'), "start_date_time")
  NULLS NOT DISTINCT;
```

- **Why an index, not a constraint.** A UNIQUE *constraint* takes columns only; the key now contains an expression. Postgres 15+ allows `NULLS NOT DISTINCT` on a unique index (the stack runs Postgres 17).
- **`NULLS NOT DISTINCT` is still required** for the same reason as G-F: `unit_of_measure` is NULL on every `flat_fee`, and without it two identical recurring flat fees at one start would both insert. G-F's ban on a `COALESCE` expression or a sentinel unit is respected: the unit stays a plain column; the only expression is the envelope field.
- **Existing data cannot violate it.** The new key is strictly finer than the old one, so every row set that satisfied the old constraint satisfies the new index. No backfill, no data change.
- **Forward-only.** `0006_product.sql` is not edited (it stays locked after pm46; the migrations README explains why an in-place edit silently never reaches migrated databases). The journal gains entry 49.
- **No grant change.** Same table, same schema.
- **Locking.** `CREATE UNIQUE INDEX` (non-concurrent, inside the migrator's transaction) takes a SHARE lock on `product_offering_price` for the build, blocking price writes, not reads. The table is small (catalog rows); acceptable.
- **Name** `product_offering_price_lane_start_unique` (40 bytes, under the 63-byte cap).

**Rejected alternative:** a stored generated column (`price_type_lane`) with a five-column UNIQUE constraint. It would let Drizzle mirror `NULLS NOT DISTINCT` exactly, but it adds a physical column that duplicates envelope data (against Inv. #30's single source) and re-introduces a `price_type`-like column that guardrails 13 and 31 are written to keep out.

### D3. The Drizzle mirror

`db/schema/product.ts` replaces `unique("product_offering_price_component_start_unique")…nullsNotDistinct()` with

```ts
uniqueIndex("product_offering_price_lane_start_unique").on(
  t.productOfferingId,
  t.componentType,
  t.unitOfMeasure,
  sql`(${t.priceComponent} ->> 'priceType')`,
  t.startDateTime,
),
```

with a comment that `NULLS NOT DISTINCT` lives in the SQL of record only: drizzle-orm 0.45.2 exposes `nullsNotDistinct()` on the unique-constraint builder, not on `uniqueIndex()` (the fact pm46 recorded). `drizzle-kit generate` is retired here, so the mirror is documentation plus typed-query source of truth; guardrail 13 (D7) asserts the `NULLS NOT DISTINCT` text in the migration, so the gap in the mirror cannot drift silently. If the installed Drizzle rejects an `SQL` member in `uniqueIndex().on(...)`, the fallback is to keep the index in SQL only and record that in the comment; the implementation reports which one landed.

### D4. Services: the violation name

`services/product/insert-price.ts` and `update-price.ts` translate the unique violation to `DUPLICATE_START`. They match on the constraint name; a unique-index violation reports the **index** name in the same field. Both switch to `product_offering_price_lane_start_unique`. The user-facing behaviour is unchanged apart from the wider set of rows now allowed (a recurring and a one-time fee on one date).

### D5. Repository: the `lead()` window

`productOfferingPriceRepository.findByOfferingIdWithDerivedEnd` partitions by the D1 key. Its `ORDER BY` gains the same expression after `unit_of_measure`, so rows still come back grouped by lane. This one change fixes all three readers: `getOrderDetail`, `getOfferingDetail` (effectivity status) and `order-preconditions` (unaffected in behaviour; it only tests existence).

### D6. Bill-run flow: the recurring resolver

In `bill_run_processing.yml` (`aggregation` step, `_bm29_resolved`):

1. The as-of window filters `component_type = 'flat_fee' AND price_component ->> 'priceType' = 'recurring'` and partitions by the D1 key. The masking hazard pm52 D3 described (a priceType filter resolving a recurring price that a later one-time row had superseded) no longer exists: under the new lane, a one-time row never supersedes a recurring one, so resolving the recurring lane's current row **is** the correct answer.
2. **The `RECURRING_PRICE_UNSUPPORTED` arm is retired** (decided, Q1). With the window restricted to the recurring lane the resolved row is always `recurring`, so the arm cannot fire. Its only purpose was this hazard. `envelope_price_type` is dropped from the temp table, the `DO $$` block keeps `RECURRING_PRICE_NOT_FOUND` and `RECURRING_CURRENCY_MISMATCH`, and the header and step comments are rewritten to say why (pm46a closed the shared lane).
3. Unchanged: the "offering intends a recurring charge" EXISTS filter, the override COALESCE, the price snapshot (Inv #20: a prior RECURRING line is reused, never re-resolved), the capacity windows (usage and capacity components are not flat fees, so their lanes are unchanged), and rating's `rp.py` (`usage_rate` only).
4. **One-time fees stay unbilled.** The flow bills recurring and usage lines only; billing a one-time charge is a separate feature and out of scope. pm46a only stops the one-time row from interfering.

`bill_run_processing.template.yml` (the non-deployable skeleton) is left alone, as in bm42a; its comments describe the old resolver and it is not run.

### D7. Tests

| File | Change |
| ---- | ------ |
| `tests/db/ordering-read.integration.test.ts` | **No change to assertions.** The four failing tests go green. The fixture's one-day offset of the Activation Fee is kept (it remains valid data) and its comment is corrected: the offset is no longer forced. |
| `tests/db/product-price-component-constraints.integration.test.ts` | Expected name → `product_offering_price_lane_start_unique`. The "second NULL-unit flat_fee at one start" case stays a rejection (both recurring). **New:** a recurring + a one-time flat fee at one start are **accepted**; two one-time flat fees at one start are **rejected**. |
| `tests/db/product-schema.integration.test.ts` | Unique-key assertion and its comment rekeyed to the index and the D1 key. |
| `tests/guardrails/product-module-boundaries.test.ts` (guardrail 13) | Asserts `0049` drops the old constraint and creates `product_offering_price_lane_start_unique` with `NULLS NOT DISTINCT` and the `priceType` expression; asserts the schema mirror names the index. The `0006` assertions stay (that file is history and still creates the original constraint). |
| `tests/db/product-repositories.integration.test.ts` ("derived effectivity from real SQL") | **New:** (a) recurring, then a later one-time: the recurring row keeps `endDateTime = null`; (b) the reverse order (one-time first, recurring later): the one-time row keeps `endDateTime = null`; (c) a later **recurring** row still ends the earlier recurring row (succession inside a lane still works). |
| `tests/db/product-price-components.integration.test.ts` | **New, through the services:** (a) `getOfferingDetail` after the one-time fee starts: the monthly fee is `CURRENT`, not `SUPERSEDED`, and both fees are listed; (b) `insertPrice` of a one-time fee at the recurring fee's exact start returns `ok`; (c) `insertPrice` of a second recurring fee at the same start returns `DUPLICATE_START` (the insert path's renamed mapping has no DB-level test today). The existing `updatePrice … DUPLICATE_START` test (two recurring fees) is kept unchanged and covers the update path's rename. |
| `tests/db/billrun-recurring-aggregation.integration.test.ts` | The `[CRITICAL]` BM29-05 case flips: a one-time fee dated after the recurring one is **ignored**, and the account bills the recurring 20.00 (one RECURRING line, no one-time line). The NOT_FOUND half of that test is unchanged. **New:** a one-time fee on the **same start** as the recurring one also bills the recurring amount; an offering with **only** a one-time fee yields no RECURRING line and does not fail the account. |
| `tests/db/billrun-phase3-journey.integration.test.ts` | Its HARD-failed account used the one-time-supersedes shape to raise `RECURRING_PRICE_UNSUPPORTED`. It switches to a **future-dated recurring price** (`RECURRING_PRICE_NOT_FOUND`), so the journey still exercises a HARD failure, `PROCESSING_FAILED` and a run that still reaches `PROCESSED`. |
| `tests/guardrails/billrun-flow-sql-window-in-aggregate.test.ts` and the extracted-SQL suites | No change; rerun. |

Inv #38 applies: the flow SQL is tested from the extracted YAML; a live Kestra run is not part of this unit (same residual as bm42a).

### D8. Seeds

`db/seeds/demo/product-demo.ts` keeps the Activation Fee on 2026-01-02 (changing demo dates is not needed for correctness and would move data on existing demo databases). Its comment, which says the offset is "empirically forced" by the shared key, is corrected. Same for any fixture comment that repeats that claim.

### D9. Docs

- **Product:** `prodmgmt-code-standards.md` §6.4 (key, index not constraint, why) and §1 rule 6 (per-lane end), `prodmgmt-architecture.md` (Inv. #2 / §3.4 / §7 wherever the key is stated), `prodmgmt-ui-context.md` §4 (succession per lane, flat fee split by `priceType`), `types/product.ts` (`endDateTime` comment), pm00 build plan (pm46a row), `prodmgmt-completed-tracker.md` (ledger row on delivery), `prodmgmt-issues-tracker.md` (**PM-ISS-003**, the lane gap, resolved by pm46a). pm46/pm49/pm52 specs are records and are not rewritten; each gets a one-line "closed by pm46a" pointer under its known-gap note.
- **Billing:** `billmgmt-architecture.md` Inv #28 and `billmgmt-code-standards.md` 14b drop `RECURRING_PRICE_UNSUPPORTED` (retired by pm46a, with the reason), `billmgmt-known-issues.md` §21e → FIXED by pm46a, `billmgmt-progress-tracker.md` (21e pointer).

### D10. What pm46a does NOT do

- Bill one-time charges (D6.4).
- Edit `0006_product.sql` or any other applied migration.
- Change rating (`rp.py`) or the capacity windows.
- Add a DB CHECK that pins non-flat-fee envelopes' `priceType` (Zod owns that at the read and write boundaries, pm47).
- Run a live Kestra bill run (TC54 harness still missing).

---

## Implementation

1. Mark pm46a IN PROGRESS (completed tracker Outstanding, issues tracker).
2. `db/migrations/0049_product_price_lane_key.sql` + `_journal.json` entry 49 (D2).
3. `db/schema/product.ts` mirror (D3).
4. `insert-price.ts`, `update-price.ts` (D4).
5. `db/repositories/product-offering-price.ts` window + order (D5).
6. `bill_run_processing.yml` resolver, D33 block, comments (D6).
7. Tests (D7), seed and fixture comments (D8).
8. Docs (D9).

## Verification checklist

- [ ] `npm run db:migrate` on an **empty** database applies `0049`; `\d product.product_offering_price` shows the index with `NULLS NOT DISTINCT` and no old constraint.
- [ ] `0049` also applies cleanly on a database migrated to `0048` with the demo seed loaded (finer key, no violation).
- [ ] Direct SQL: recurring + one-time flat fee at one start → accepted; two recurring → rejected; two one-time → rejected; a usage_rate and a capacity_motivation on one unit at one start → still accepted.
- [ ] `ordering-read` green with no assertion change (4 tests).
- [ ] Full integration project against the throwaway DB: 0 failures (from 4).
- [ ] Full unit suite: 0 failures; guardrails 13, 31 and the window-in-aggregate guard green.
- [ ] `tsc`, ESLint, Prettier clean on every touched file.
- [ ] Grep: no live code or current-state doc names `product_offering_price_component_start_unique` (migration `0006` and historical specs excepted) or `RECURRING_PRICE_UNSUPPORTED` (historical specs excepted).

## Review decisions (Khek, 2026-10-10)

- **Q1. Retire `RECURRING_PRICE_UNSUPPORTED`: yes.**
- **Q2. Demo seed date: leave it** (Activation Fee stays on 2026-01-02; only the comment is corrected).

## Open questions as written for review

- **Q1. Retire `RECURRING_PRICE_UNSUPPORTED`?** Recommended: yes. After D6 it is unreachable and untestable. Keeping it as a defensive arm would mean an error code no test can trigger. If you prefer to keep it, D6.2 becomes "kept, documented as unreachable" and the two billing tests are still changed as in D7.
- **Q2. Demo seed date.** Recommended: keep the Activation Fee on 2026-01-02 and only fix the comment (D8). Alternative: move it to 2026-01-01 now that it is allowed, to demonstrate the fix; that changes demo data on reseed.
