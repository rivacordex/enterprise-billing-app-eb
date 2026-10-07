# bm45 — Invoice usage appendix: per-polygon detail by state/district

**Unit:** bm45 (Target Capacity Pricing update). **Boundary:** the appendix **snapshot** in the `aggregation` step of `bill_run_processing.yml` (as `billrun_runtime`), the invoice render (`services/billing/render-invoice-template.ts` + the final-invoice read in `services/billing/render-invoice.ts`), and the multi-polygon / multi-state-district `_SAMPLE_` fixture (extends the bm42 capacity seed). **No migration — the snapshot lives in the bm41 `additional_info` jsonb; no new table.** **Specs from:** `_updatemodule-billing-billrun-target-capacity-plan.md` §6.1 (the appendix, TC49/TC57), O-TC6 (sourcing, version, scope); `billmgmt-ui-context.md` §6d (appendix); `billmgmt-update-overview.md` (Unit 45); `bm00-build-plan.md` Part 3 Unit 45. **Depends on:** bm42 (the capacity line + the `aggregation` capacity CTEs to extend), bm41 (`additional_info` column + the `product.ratecard_ran_usage_lkp` / `ratecard_version` grants), bm44 (the read-model surfacing of `additionalInfo`). **Sequencing:** after the 42/43 pricing core is green, so an appendix wobble cannot hold up money-correctness (O-TC6).

> **Verified against `enterprise-billing-app` (2026-10-04).**
>
> - `product.ratecard_ran_usage_lkp` (`db/schema/product.ts:335-385`) carries `ratecard_version_id`, `mno_public_key`, `commercial_unit_public_key`, `polygon_id`, `polygon_start_date`/`polygon_end_date`, **nullable** `state`/`district`/`service_code`, `rate_per_unit` (NULL per OV-2); row key `(ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id)` (`:369-374`). `product.ratecard_version` (`:260-320`) carries `card_name`, a `version_num`, a status, and `one-active-per-card`/`one-draft-per-card` unique indexes. `state`/`district` are "descriptive labels — NOT part of the row key" (`:329-331`).
> - `rating.udr_rated` has **no** polygon/state/district/mno column (`db/schema/rating/udr-rated.ts`). The only per-record cell identity is `udr_key`: for RAN_USAGE the canonical cell `commercial_unit=<v>|mno_public_id=<v>|polygon_id=<v>` — sorted key names, values `strip().casefold()`, `k=v` joined by `|` (`prp.py:528` `canonical_udr_key`, `:_normalise_value`). The feed role-column names are fixed in the RAN_USAGE profile (`rating-engine-ran-usage.yaml:54` feed_profile: `mno_column='mno_public_id'`, `commercial_unit_column='commercial_unit'`, `polygon_column='polygon_id'`). Rating matches a record to its ratecard cell by building the **same** canonical key from the ratecard columns (`prp.py:426-431`).
> - `render-invoice-template.ts` is a **pure** function (no DB/Playwright import); it renders `lines: DraftInvoiceLine[]` into a charge table and a `tfoot`. `buildFinalInvoiceHtml` (`:79-84`) is the posted-invoice entry (real `INV…` number, no watermark). The orchestrator `render-invoice.ts` reads the lines via `ratedLinesRepository.listClaimedForAccount` and calls `buildFinalInvoiceHtml` (`:137-155`); the draft path (`:82-106`) calls `buildDraftInvoiceHtml`.
> - The bm42 capacity seed reuses `buildSampleUdrRatedRow`, whose `udr_key` is a JSON `{ban,priceRef,seq,startIso}` string — **not** a canonical cell — so capacity rows cannot currently join a ratecard; bm45's fixture changes the capacity branch to emit canonical cells (below).

## Goal

Render, below the capacity charge on the **posted** invoice, a per-polygon usage appendix sectioned by state then district — sourced from a snapshot the `aggregation` step computes by joining each claimed polygon to the `productCardLookUp` ratecard for its state/district — so the render does no cross-schema join, every contributing polygon appears (a card-missing polygon is surfaced, not dropped), and the whole thing is bounded and load-tested to ≤ 10,000 polygon rows per account.

## Design

### D1 — snapshot at aggregation, render reads one snapshot (O-TC6a resolution)

The `aggregation` step (already `billrun_runtime`, already reading `udr_rated`, and — via bm41 — granted `SELECT` on the ratecard tables) joins each capacity-volume polygon to the ratecard and **snapshots** the appendix rows onto the capacity line's `additional_info` under a new `appendix` key: `{ v, productInventoryId, pricing, calc[], summary[], appendix: [{ polygon, state, district, volume, amount }] }`. The render then reads **one snapshot** — rerun-stable (a rerun re-aggregates the same claimed rows + the same card), no render-time cross-schema read, parity with the pinned-version philosophy (TC46). **No migration:** the snapshot reuses the bm41 `additional_info jsonb`; a dedicated detail table would need a migration and is out of this unit's boundary (the ≤10K bound keeps the jsonb tractable — D5). Rejected: a live `udr_rated` + ratecard join at posting (needs the render path to cross schemas and re-pick a card version — the drift O-TC6 warns against).

### D2 — polygon → ratecard via canonical-key reconstruction (the decided mechanism)

`udr_rated` holds no polygon column, so the join reconstructs the canonical cell **from the ratecard columns** and matches it to `ur.udr_key` — exactly what rating does (`prp.py:426`):

```sql
'commercial_unit=' || lower(btrim(l.commercial_unit_public_key))
|| '|mno_public_id=' || lower(btrim(l.mno_public_key))
|| '|polygon_id='   || lower(btrim(l.polygon_id))   = ur.udr_key
```

This **couples** the bill run to three RAN_USAGE rating facts: the feed role-column **names** (`commercial_unit` / `mno_public_id` / `polygon_id`), the canonical **format** (sorted `k=v|…`), and the **normalisation** (`strip().casefold()` → `btrim` + `lower`). All three are config-only / forbidden-edit on the rating side and are treated as a **TC42-scoped constant** here (capacity is RAN_USAGE-only this phase); the coupling is documented in-code and asserted by the fixture. `lower()` tracks `casefold()` for the ASCII keys these feeds carry (a Unicode-only divergence is noted as a known edge, not expected for polygon ids). A durable decoupling — rating stamping the matched `ratecard_ran_usage_lkp_id` onto `udr_rated` — is recorded as a future cross-plan hardening, not built here.

### D3 — card-missing polygon is surfaced, never dropped (TC49)

The join is a **LEFT JOIN** from the capacity-volume polygons to the ratecard: a polygon with usage but no matching card row keeps its volume/amount and renders with `state`/`district` shown as an explicit **"(no ratecard entry)"** marker — mirroring rating's `LOOKUP_MISS` discipline (surface, don't silently drop). This is a render/appendix concern only — it does **not** fail the account (money-correctness already passed in 42/43; O-TC6 sequencing). Rows group/order by `state, district, polygon`, with card-missing polygons collected under a trailing "Unmapped" section so totals still reconcile to the capacity line.

### D4 — ratecard version: the ACTIVE version of the named card (O-TC6 version resolution)

The card is the one named by the offering's `productCardLookUp` `product_specifications` row (`default_value = card_name`); the version is that card's **ACTIVE** `ratecard_version` — the same version rating resolves against (rating uses the one ACTIVE card, `prp.py` rm21). `udr_rated` carries **no** ratecard-version stamp, so true per-record pinning is not possible without a rating change; ACTIVE-of-named-card matches rating's own behaviour and the `one-active-per-card` invariant. **Residual (documented):** if the card is re-versioned between rating and this bill run, the appendix could read a newer version's state/district than rating used; the durable fix is the D2 rating-side stamp. Accepted this phase (a mid-cycle card re-version is rare and the capacity run follows rating closely).

### D5 — per-polygon, bounded ≤ 10,000 rows/account, final invoice only (TC57, O-TC6 scope)

The appendix lists **every** contributing polygon — no summarise-by-district, no collapsing (per-polygon is the requirement). This phase **assumes and load-tests up to 10,000 polygon rows per account**; beyond 10K is undefined/out of scope (a future paging decision). The snapshot-at-aggregation sourcing keeps the join off the render path, so the PDF is a pure read of pre-computed rows even at 10K. **Scope:** the **final posted** invoice only (`buildFinalInvoiceHtml`); the PRO-FORMA draft preview does **not** render the appendix this phase (O-TC6) — reversing TC26 for the usage appendix only; the capacity calc trace stays DB-only.

## Implementation

### 1. Appendix snapshot — extend the bm42 `capacity_lines` CTE (`aggregation`)

In the bm42 capacity build, add an appendix aggregation per capacity line, written into `additional_info.appendix`:

- resolve the capacity offering's `productCardLookUp` card name (`product_specifications.default_value WHERE name = 'productCardLookUp'`) and its ACTIVE `ratecard_version_id` (D4);
- from the capacity volume (`BILL_DRAFT` rows, `udr_usage_unit = unit AND udr_type = udrType`), group by `ur.udr_key` → `SUM(udr_usage_quantity) AS volume`, `SUM(udr_rated_price) AS amount`, `COUNT(*)`;
- LEFT JOIN each `udr_key` to `ratecard_ran_usage_lkp` (scoped to the ACTIVE version) via the D2 canonical-key reconstruction, selecting `state`, `district`, `polygon_id`;
- build `jsonb_agg(jsonb_build_object('polygon', …, 'state', …, 'district', …, 'volume', …, 'amount', …) ORDER BY state NULLS LAST, district NULLS LAST, polygon)` and set it as `additional_info->'appendix'`;
- a **count guard:** if the distinct-`udr_key` count for an account exceeds **10,000**, `RAISE EXCEPTION 'CAPACITY_APPENDIX_OVER_LIMIT (HARD): account % has % polygon rows (> 10000, the load-tested bound this phase)'` — a loud, documented cap, never a silent truncation (TC57).

(The `appendix` key is additive to the bm42 trace; bm41's `CapacityCalcTrace` type gains an optional `appendix` field.)

### 2. Render orchestrator — read the snapshot, pass it to the template (`render-invoice.ts`)

In the **final** invoice path (`:137-155`), read the capacity line's `additional_info.appendix` for the account (via the bm44-surfaced `customerBillLineRepository.listForRun` / `additionalInfo`, or a scoped read of the capacity line), shape it into the template param, and pass it to `buildFinalInvoiceHtml`. The draft path (`:82-106`) is unchanged (D5 — final only). No new cross-schema read: the orchestrator reads only `customer_bill_line` content that `aggregation` already snapshotted.

### 3. Template — render the appendix section (`render-invoice-template.ts`)

- Add an optional `appendix?: InvoiceUsageAppendix` to `BuildFinalInvoiceHtmlParams` (a grouped structure, or flat rows the template groups by `state → district`). Keep the function **pure** (no DB) and money/date formatting through the existing `formatCurrency`/`formatCalendarDate`; escape every DB-sourced string with the existing `escapeHtml` (state/district/polygon are external data).
- Render the appendix **below** the charge table, only when `invoiceNumber !== null` (final) **and** an appendix is present: a section per state (with a state subtotal), a sub-section per district (district subtotal), and a per-polygon row (`polygon`, `volume + unit`, `amount`). Card-missing polygons render under a trailing **"Unmapped (no ratecard entry)"** group; the grand total reconciles to the capacity line's rated amount.
- Large-table print: reuse the existing table CSS; the section is plain rows (Chromium paginates). No new watermark/footer logic.

### 4. `_SAMPLE_` multi-polygon fixture — extend the bm42 capacity seed (`db/seeds/sample/**`)

- **Canonical udr_keys.** Change the capacity profile's udr rows (bm42) to emit `udr_key` as the canonical cell `commercial_unit=<cu>|mno_public_id=<mno>|polygon_id=<poly>` (`lower`+`trim` values, sorted keys) — the shape the D2 join requires — instead of the generic JSON key. Spread one capacity account's usage across **≥ 4 polygons over ≥ 2 states and ≥ 2 districts**, plus **one card-missing polygon** (usage with no matching ratecard row) to exercise D3.
- **Ratecard version.** Seed (idempotently) a `ratecard_version` named by the capacity offering's `productCardLookUp` spec, ACTIVE, with `ratecard_ran_usage_lkp` rows for the mapped polygons carrying `state`/`district`/`service_code` (and `rate_per_unit` NULL per OV-2); omit the card-missing polygon's row. (The `sample-5g-rating.ts:490-522` ratecard-seed shape is the precedent.)
- Keep the four bm42 anchor accounts intact (the appendix fixture is one additional multi-polygon account, so the 800/1000/2000/0 anchors and this appendix account are all in the `capacity` profile).

## Dependencies

- **npm packages:** none (inline SQL snapshot; the template is a pure TS function).
- **Prerequisite artifacts:** bm42 (the capacity line + the `aggregation` CTEs this extends; its seed this refines), bm41 (`additional_info` + `billrun_runtime` `SELECT` on `product.ratecard_ran_usage_lkp` / `ratecard_version`), bm44 (the `additionalInfo` read-model surface the orchestrator reads). PER_UNIT rating (TC45) so the capacity rows carry canonical cell `udr_key`s.
- **Downstream:** bm46 (ship gate drives a posted capacity invoice and asserts the appendix renders).

## Verification checklist

- [ ] A posted capacity invoice for the multi-polygon fixture renders a usage appendix **below** the capacity charge, sectioned by state → district → polygon, with district and state subtotals rolling up to the capacity line's rated amount.
- [ ] State/district come from the ratecard (not `udr_rated`): the join reconstructs the canonical cell from the ratecard columns and matches `ur.udr_key` — a fixture whose ratecard `state`/`district` differ from any feed value proves the values are card-sourced.
- [ ] A card-missing polygon (usage, no ratecard row) **appears** in the appendix under "Unmapped (no ratecard entry)" with its volume/amount — not silently dropped — and the account still bills (no HARD fail from the appendix).
- [ ] The snapshot is at aggregation: the render path performs **no** `udr_rated`/ratecard join (it reads only `customer_bill_line.additional_info.appendix`); a rerun reproduces the same appendix.
- [ ] The appendix uses the ACTIVE version of the `productCardLookUp`-named card; a test that re-versions the card after aggregation does **not** change an already-snapshotted invoice (rerun-stability), documenting the D4 residual.
- [ ] The ≤10,000 bound is load-tested: a fixture at ~10K polygons snapshots and renders a valid PDF; an account over 10K HARD-fails `CAPACITY_APPENDIX_OVER_LIMIT` loudly (no silent truncation).
- [ ] The **draft** PRO-FORMA invoice does **not** render the appendix (final-only, O-TC6); the capacity calc trace is still not rendered anywhere (TC26).
- [ ] `render-invoice-template.ts` stays pure (no DB/Playwright import); all external strings (state/district/polygon) are `escapeHtml`-escaped; money/dates via the shared formatters.
- [ ] `tsc`/eslint/the DB-free unit suite (incl. the template test) green; the DB-gated appendix snapshot + render suites green on a disposable Postgres; the capacity `_SAMPLE_` profile seeds the ratecard + canonical-cell udr rows idempotently.
- [ ] Docs: `bm00-build-plan.md` Part 3 Unit 45 unchanged; `billmgmt-ui-context.md` §6d names bm45; the D2 rating coupling + the D4 version residual are recorded in `billmgmt-known-issues.md` (or the architecture capacity deltas) as documented assumptions.
