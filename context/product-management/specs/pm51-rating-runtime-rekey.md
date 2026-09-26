# pm51 — Rating runtime: price-resolution window re-key (cross-module, G-G)

**Unit:** pm51 (Part 4). **Boundary:** the price-resolution SQL inside `workflow-management/worker/workflow-engine/runtime/rp.py`, and four rating test suites. **A re-key and nothing else** — the rate-extraction rework, `rateCardLookUp` resolution, the LookUp Rate Card table and any `PER_UNIT` / rate-card `udr_rate_detail` variant are later phases and out of bounds.
**Specs from:** `prodmgmt-architecture.md` §3.7 (reader inventory row 1), §7, Inv. #42, #43 · `prodmgmt-code-standards.md` §1.27, §6.21 · `prodmgmt-ai-workflow-rules.md` §3.1, §6.6, §6.13, §8.13 · `_updatemodule-product-pricing-components-plan.md` **PC10**, O1, H1, H3 · `pm00-build-plan.md` Part 4 › the cross-runtime decision (2026-09-21).
**Depends on:** **pm49** · **G-G authorization naming these files** · **rating-module owner sign-off**.

**Gate G-G — required before a line is written.** Workflow §6.6 makes `workflow-management/**` read-only from this module. The cross-runtime decision makes this crossing a unit; it is not the authorization. Obtain and record, in writing, an authorization naming exactly:

- `workflow-management/worker/workflow-engine/runtime/rp.py` (the `price_windows` CTE and the resolution SELECT only)
- `tests/rating/rm08-rp-price-resolution-snapshot.integration.test.ts`
- `tests/rating/rm09-rl-guarded-transactional-load.integration.test.ts`
- `tests/rating/rm10-supersession-reprocessing.integration.test.ts`
- `tests/rating/rm13-e2e-journey.integration.test.ts`

plus the **rating-module owner's sign-off** that the change is a re-key with no rating-behaviour change. A crossing wider than this list — the `udr_rate_detail` schema, the rating flow YAML, `udr-rated.ts`, a bootstrap role file — is a different authorization and, for the first three, a different phase.

---

## Goal

Re-key RP's price-resolution window from the dropped `price_type` / `pricing_model` / `amount` columns onto `component_type` + `price_component`, reading the rate from `usage_rate.params.ratePerUnit` and partitioning effectivity per `(component_type, unit_of_measure)` — so the rating flow runs end to end against the reshaped table and resolves exactly the rate it resolved before.

---

## Design

### D1. What the window does today, stated before it is changed

`price_windows` selects, from `product.product_offering_price`, the rows with `price_type = 'usage'`; carries `amount`, `currency`, `pricing_model` and `start_date_time`; derives `eff_to` with `lead(start_date_time) OVER (PARTITION BY product_offering_id, price_type ORDER BY start_date_time)`; and the outer SELECT joins the as-of window `[eff_from, eff_to)` for each record's `start_datetime`, taking `effective_amount = COALESCE(oipo.amount, pw.amount)` and the override ref from `ordering.order_item_price_override` where `price_type = 'usage'`.

`pricing_model` is selected but **deliberately not branched on**: v1 computes `FLAT` only, and a `tiered` row (whose `amount` is NULL under the XOR CHECK) falls out as `effective_amount NULL` → `LOOKUP_MISS`. The comment says it is where a future non-`FLAT` calc would read the model.

### D2. The re-key, line by line

| Today | After pm51 |
| --- | --- |
| `WHERE popp.price_type = 'usage'` | `WHERE popp.component_type = 'usage_rate'` |
| `popp.amount` | `(popp.price_component #>> '{params,ratePerUnit}')::numeric` |
| `popp.pricing_model` (carried, unused) | **removed entirely** — see D3 |
| `PARTITION BY popp.product_offering_id, popp.price_type` | `PARTITION BY popp.product_offering_id, popp.component_type, popp.unit_of_measure` |
| `oipo.price_type = 'usage'` (ordering table) | **unchanged** — that column is not dropped (PC13) |
| *(new)* the outer `[eff_from, eff_to)` join | also matches `pw.unit_of_measure = <record's usage unit>` |

**The join needs the unit match too, not only the partition.** Partitioning the `lead()` window by `unit_of_measure` (above) stops a dated successor in one unit lane from truncating another lane's `eff_to` — but on its own it does not stop the outer join from matching a record to *every* lane that is otherwise in-window. An offering carrying two concurrent `usage_rate` components at different units (e.g. `GB` and `Mbps`, same `start_date_time`, neither superseding the other) would join one `_chunk` record to both rows, fanning it out — a design invariant this file states up front ("the join never fans out per record", Inv #10) and a `LOOKUP_MISS`/double-charge hazard if broken. `_chunk` therefore also carries each record's own usage unit (already available as `RatedRecord.udr_usage_unit`/the chunk frame's `udr_usage_unit` column) end to end, and the outer join adds `AND pw.unit_of_measure = r.usage_unit` alongside `pw.product_offering_id = poi.product_offering_id`.

Everything else holds: the `[eff_from, eff_to)` as-of join, `COALESCE(oipo.amount, …)`, the pinned-version join through `poi.product_offering_id`, the currency column, the chunking, the `LOOKUP_MISS` path and every `process_log` line.

### D3. `pricing_model` is removed, not re-expressed

It was carried for a future non-`FLAT` calc and never read. Its successor concept is `component_type`, which the window now filters on, so carrying a second discriminator would be dead weight with a misleading name. **Replace its comment**, do not delete the reasoning: the new comment states that v1 still computes `FLAT` only, that the component's `@type` is now the discriminator a later calc would branch on, and that `rateCardLookUp` — present in the envelope, non-null on some rows — is **deliberately not read here** (Inv. #42, PC10, H3).

### D4. The `LOOKUP_MISS` path changes shape, and that must be re-derived rather than assumed

Today an unratable price produces `effective_amount NULL` because a `tiered` row's `amount` column is NULL. After the reshape there is no `tiered` row, and a `usage_rate`'s `ratePerUnit` is NOT NULL by CHECK — so the old "unratable price" case **cannot arise from the catalog shape any more**. `LOOKUP_MISS` must still fire for its real causes: no `usage_rate` for that offering at all, or none whose window contains the record's `start_datetime`. Both are handled by the join finding no row, which is the existing path.

State this explicitly in the code comment and prove it in the fixtures (I3): a record whose offering has only a `flat_fee` and capacity modifiers still yields `LOOKUP_MISS`, at `MAJOR`, one summarised `process_log` line — unchanged severity, unchanged line count.

### D5. The capacity components are visible to this query and must stay invisible to it

A component-priced offering now carries `capacity_commitment` and `capacity_motivation` rows in the same unit as its `usage_rate`. The `component_type = 'usage_rate'` filter excludes them, and the per-lane partition means they cannot truncate the `usage_rate` chain's `eff_to` — which is the concrete reason the partition key changes and not merely a tidiness. A fixture asserts it: adding a `capacity_motivation` dated **after** a live `usage_rate` must not change a single rated amount.

**Nothing in this unit applies a commitment or a motivation.** That is the bill-run capacity resolver, a later phase (Inv. #43, workflow §3.1).

### D6. The rate is a decimal string in JSON and must not become a float

`ratePerUnit` is a decimal string in the envelope. Extract with `#>>` (text) and cast to `numeric` in SQL, never to `double precision`, and let the existing Python `Decimal` path carry it from there (`effective_amount: Decimal | None` on the `Resolution` dataclass is unchanged). A `::float` anywhere in this diff is a defect (§1.24, Inv. #32).

### D7. Grants are table-level `SELECT` — no bootstrap role file is edited

`rating_runtime`'s grant is table-level, so the two new columns are readable with no bootstrap change; the reshape is grant-transparent (workflow §6.13, architecture §3.7). **A unit that finds itself editing `db/bootstrap/rating-db-roles.sql` has misdiagnosed a reader break as a permission problem.** If the flow fails with a permission error after this change, the cause is elsewhere — investigate, do not grant.

### D8. What this unit explicitly does not do

No `PER_UNIT` computation, no rate-card join, no `udr_rate_detail` variant beyond the existing `FLAT` one, no change to `udr-rated.ts`, no change to `rating-engine-ran-usage.yaml`, no change to the `# STUB:` markers' scope, and no answer to **O1** (base-rate semantics when a rate card varies the rate) or **H1** (the `'MBPS'` vs `Mbps` unit-vocabulary divergence — now consequential, still not this unit's). Each is recorded in the hand-off register and stays there.

---

## Implementation

### I1. `rp.py` — the `price_windows` CTE

Apply D2's five changes inside the existing SQL string. Keep the statement's formatting conventions, its parameter style and its chunk-join structure identical, so the diff reads as a re-key. Rewrite the `pricing_model` comment block per D3 and add D4's `LOOKUP_MISS` note and D5's one-line reason for the new partition key.

### I2. `rp.py` — nothing else

The `Resolution` dataclass, the `FLAT` `udr_rate_detail` builder and its validator, the Parquet manifest, the logging and the chunking are untouched. `effective_amount` keeps its `Decimal | None` type and its `COALESCE(override, catalog)` precedence.

### I3. Rating fixtures

Repair the four suites to seed components instead of flat/tiered price rows, at **identical amounts, units, currencies and dates**:

- **rm08 — price-resolution snapshot.** The seeded usage price becomes a `usage_rate` with `ratePerUnit` equal to the old `amount`. The snapshot's resolved values must be byte-identical; if the snapshot file changes at all beyond the seed's shape, stop — that is a behaviour change.
- **rm09 — guarded transactional load.** Same re-key; assertions unchanged.
- **rm10 — supersession/reprocessing.** The dated-successor case is now per-lane: seed the successor `usage_rate` in the same unit and assert the same supersession result, **plus** D5's new case — a `capacity_motivation` dated between two `usage_rate` rows changes nothing.
- **rm13 — e2e journey.** Re-key its catalog seed; assert the end-to-end rated output is unchanged.

Add to rm08 (or wherever `LOOKUP_MISS` is covered): D4's case — an offering with a `flat_fee` and capacity modifiers but **no** `usage_rate` yields `LOOKUP_MISS` at `MAJOR` with one summarised log line.

### I4. Verification run

Run the rating flow end to end against a database built from empty and seeded by pm48, and diff the rated output against a pre-reshape baseline captured before the branch. "Resolves the same rate" is an assertion about numbers, not about the suite going green.

### I5. Documentation

1. `prodmgmt-architecture.md` §3.7 — mark the `rp.py` row re-keyed by pm51, with the date and the owner who signed off.
2. `prodmgmt-code-standards.md` §6.21 — same, in the reader-inventory paragraph.
3. Record the authorization and sign-off in the same change set.
4. **No `ratemgmt-*` doc is edited** — cross-module doc edits need their own approval (workflow §7.9). O1, H1 and H3 stay in this module's hand-off register.

---

## Dependencies

**Packages to install: none.** No Python package, no npm package, no PostgreSQL extension. The worker's existing `psycopg` path and `Decimal` handling are unchanged; `#>>` and `jsonb` casts are core PostgreSQL.

**Commands used:** the rating flow's existing local run, `npm run test` (the four rating suites), `npm run db:migrate`, `npm run db:seed-demo`/`db:seed-sample`, plus the Python worker's own lint/format as the rating module configures them.

**Prerequisite:** the recorded **G-G authorization** and the **rating-module owner's sign-off**.

---

## Verification checklist

Authorization

- [ ] G-G authorization and rating-owner sign-off are recorded, naming exactly the five files.
- [ ] `git diff --stat` touches no other rating, workflow or bootstrap file.

Behaviour (unchanged, proved by numbers)

- [ ] The rating flow runs end to end against the reshaped table.
- [ ] Rated amounts are **identical** to the pre-reshape baseline — asserted by diff, not by a green suite alone.
- [ ] The rate comes from `usage_rate.params.ratePerUnit`, cast via `numeric`, never via a float.
- [ ] An order-item override still wins over the catalog rate (`COALESCE` precedence unchanged), and `oipo.price_type = 'usage'` still reads the ordering column.
- [ ] A dated successor `usage_rate` supersedes as before; a `capacity_motivation` dated between two `usage_rate` rows changes nothing.
- [ ] `LOOKUP_MISS` still fires for a missing or out-of-window `usage_rate`, at `MAJOR`, with one summarised `process_log` line.

Boundaries

- [ ] `rp.py` contains no reference to `pricing_model`, `amount` or `price_type` on the catalog table.
- [ ] No `rateCardLookUp` read, join, resolution or fallback exists anywhere in the diff.
- [ ] No `PER_UNIT` or rate-card `udr_rate_detail` variant was added; the `# STUB:` markers keep their scope.
- [ ] No capacity commitment or motivation is applied anywhere in rating.
- [ ] `db/bootstrap/rating-db-roles.sql` is byte-identical.
- [ ] The four rating suites are green with unchanged assertions; any assertion that had to change is raised, not absorbed.

**Definition of done:** the rating engine reads its per-unit rate out of a JSON envelope instead of a dropped column, resolves the same number for the same UDR on the same date, and remains as unaware of capacity commitments and rate cards as it was the day before the reshape.
