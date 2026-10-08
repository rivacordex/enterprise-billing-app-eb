# bm48 — Rating persists `state`/`district` on `udr_rated` _(cross-module)_

**Unit:** bm48 (Invoice Template update, Part 4). **Boundary:** the **rating module only**, under `context/rating-management/ratemgmt-ai-workflow-rules.md`:

- one forward rating migration `db/migrations/0045_rating_udr_rated_geo.sql` (+ `meta/_journal.json` entry)
- the rating Drizzle mirror `db/schema/rating/udr-rated.ts`
- the RAN-usage rating runtime: `workflow-management/worker/workflow-engine/runtime/{prp,rp,rl}.py` (Python modules invoked by `workflow-management/flows/rating-engine/rating-engine-ran-usage.yaml`)
- rating tests under `tests/rating/**`
- the **Inv #36 amendment** in `billmgmt-architecture.md`, in the same change set (workflow rules §7.2)

**No billing code** (workflow rules §4.8): no file under `services/billing/**`, `db/repositories/billing/**`, `db/schema/billing/**`, or `workflow-management/flows/bill-run-*/**` changes.

**Specs from:** merged plan §15 R9; architecture _Invoice Template deltas_ (storage delta for `rating.udr_rated`, background-tasks delta); Inv #36 (to amend), #47; code-standards Part 2 data rule 6; `ratemgmt-code-standards.md` (hand-authored rating migrations).

**Gates:**

| Gate | State | What this spec builds on |
| --- | --- | --- |
| G1 / X1 / C1 geo source | **Decided 2026-10-07: R9** | Geo is captured at rating time onto `udr_rated`; Inv #36 is amended |
| G13 `udr_key` → ratecard cell mapping | **Decided 2026-10-08** (owner confirmation, recorded at build) | Reuse PRP's existing cell match (`canonical_udr_key`, `prp.py:576-588`) — the same match that today resolves `lkp_subscriber_ref_id` / `service_code`. No new mapping rule |

> ~~**Build may not start until G13 is recorded as decided by rating**~~ — **G13 recorded as decided 2026-10-08** (owner confirmed the interim; also recorded in `billmgmt-ai-workflow-rules.md` §5 DECIDED item 5 and `ratemgmt-architecture.md` Inv #26). The evidence below shows the interim is what rating already does.
>
> **PR shape (owner decision, 2026-10-08):** one PR with ordered commits, under a recorded bm48-only waiver of `ratemgmt-ai-workflow-rules.md` §4.1/§4.3 (see that file's §4).

> **Verified against `enterprise-billing-app` `dev1` (2026-10-07) — two corrections to the plan's premise.**
>
> 1. **Rating does not read `rate_per_unit` from the ratecard.** The plan (R9) and `bm00` Unit 48 say "rating already reads the matched `ratecard_ran_usage_lkp` row to get `rate_per_unit`". It doesn't: the rate comes from `product.product_offering_price.price_component #>> '{params,ratePerUnit}'` in RP (`rp.py:305-385`), and seeds set the card's `rate_per_unit` to `null`. Rating **does** read the ratecard — in **PRP**, for subscriber identity and `service_code` (`prp.py:430-437`):
>    ```sql
>    SELECT l.mno_public_key, l.commercial_unit_public_key, l.polygon_id, l.lkp_subscriber_ref_id, l.service_code
>    FROM product.ratecard_version v JOIN product.ratecard_ran_usage_lkp l ON l.ratecard_version_id = v.ratecard_version_id
>    WHERE v.card_name = %(card_name)s AND v.status = 'ACTIVE'
>    ```
>    `extract_ratecard` (`:440-480`) indexes the rows in memory by canonical cell into `RatecardCell{lkp_subscriber_ref_id, service_code}` (`:422-427`) and fails closed on a duplicate cell. **That is the matched row** — R9 still costs near zero, but the capture point is PRP, not "where rating reads `rate_per_unit`".
> 2. **The flow is Python, and RL inserts by COPY.** `rl.py` `COPY_COLUMNS` (`:120-145`) is the insert column list; `build_chunk_rows` (`:219-271`) raises `KeyError` when a COPY column is absent from RP's Parquet, so the new columns must be produced in PRP, carried through RP's Parquet, and listed in `COPY_COLUMNS`.
>
> Other facts: `rating.udr_rated` DDL of record is `0034_rating.sql:37-103` (partitioned on `partition_period`); no later migration alters it. rm15 edited `0034` in place under a fresh-install regime — **not allowed now** (data exists), so this is a forward migration. `0042` is unused; **the next free number is `0045`**. `db/checks/rating-migration-boundary.ts:20` classes any `.sql` whose name matches `/rating/i` as a rating migration and forbids `billing.*` writes in it. `rating_runtime` holds table-level `INSERT` on `udr_rated` (`rating-db-roles.sql:91`) and `UPDATE ("status")` only (`:93`); `app_runtime` and `billrun_runtime` update exactly six claim columns. `product.ratecard_ran_usage_lkp.state` / `.district` are nullable text (`0041_ratecard_ran_usage_lkp.sql:68-70`). The RAN feed header carries a `district_name` column that **no runtime reads** — it is **not** the source (the card is).

## Goal

When RAN-usage rating matches a usage record to its ratecard cell, write that cell's `state` and `district` onto the new `rating.udr_rated.state` / `.district` columns at insert, so every newly rated `RAN_USAGE` row carries frozen geo that the invoice binder (bm49) can group by without any render-time ratecard lookup; rows rated before this change stay `NULL`.

## Design

### D1 — Two nullable columns, frozen by construction

```sql
ALTER TABLE "rating"."udr_rated" ADD COLUMN "state" text;
ALTER TABLE "rating"."udr_rated" ADD COLUMN "district" text;
```

- On the partitioned parent; the `ALTER` propagates to every partition including `udr_rated_default`. `ADD COLUMN … text` with no default is a metadata-only change on PG 17 (no rewrite).
- **No grant change.** `rating_runtime`'s table-level `INSERT` already covers new columns; no role holds `UPDATE` on them (`rating_runtime` has `UPDATE ("status")`, `app_runtime`/`billrun_runtime` the six claim columns), so they are write-once at INSERT. The existing `tests/rating/grants.integration.test.ts:256,288` column-privilege checks keep passing and are extended to assert the two new columns appear in **no** role's `UPDATE` column list.
- No CHECK on values (the card's labels are free text, `0041` D-A10); `NULL` means "rated before bm48" **or** "card row had no state/district".
- No index: bm49 reads by `(billrun_ref_id, billrun_ban_id)` through the existing partial `billrun_idx`.

### D2 — Capture in PRP, carry through RP, insert in RL

| Stage | Change |
| --- | --- |
| PRP `extract_ratecard` | Extend the SELECT with `l.state, l.district`; extend `RatecardCell` to `{lkp_subscriber_ref_id, service_code, state, district}`. The duplicate-cell fail-closed is unchanged. |
| PRP record enrichment | Where PRP attaches `lkp_subscriber_ref_id`/`service_code` from the matched cell to the record, also attach `state`/`district`. A record that misses the card already fails PRP's coverage check (`LOOKUP_MISS`) and is never rated, so every rated RAN row went through a match. |
| PRP → RP Parquet | Add `state` and `district` (nullable string) to the PRP output schema. |
| RP | Pass both through unchanged into its output Parquet. RP does no geo logic. |
| RL | Add `"state", "district"` to `COPY_COLUMNS` (`rl.py:120-145`) — append at the end of the tuple so the existing column order is untouched. `build_chunk_rows` then requires them, which is the guard that RP carried them. |

Values are written exactly as stored on the card (no trim/case change): the binder groups on the stored label, and the card is the label's owner.

### D3 — Which card version (unchanged behavior, now frozen)

PRP already reads the **ACTIVE** version of the card named by the offering's `productCardLookUp` spec (`v.status = 'ACTIVE'`). Geo is now frozen at the moment of rating, so a later card re-version can no longer change what an invoice shows. This **closes bm45's D4 residual** ("the appendix could read a newer version's state/district than rating used") for every row rated after this unit.

### D4 — Non-RAN usage types

Only the RAN_USAGE profile reads a ratecard. Any other usage profile writes `NULL` for both columns (RL's chunk builder fills absent optional columns with `None` **only** for these two names — a named allowlist, not a general default, so the KeyError guard still protects every other column).

### D5 — Forward-only; no backfill (out of scope)

Existing rows stay `NULL`. bm49 shows them, not drops them (under an "Unassigned region" group). No backfill script, no `UPDATE`, no new grant to allow one.

### D6 — Inv #36 amendment (billing architecture, same change set)

Replace Inv #36's sentence "whose **state/district come from the `productCardLookUp` ratecard, never from `udr_rated`**" with:

> "…whose state/district come from the `productCardLookUp` ratecard **as matched at rating time and persisted onto `rating.udr_rated.state/district` (bm48, R9)**. The bill run and the render never join the ratecard for geo; rows rated before bm48 carry `NULL` geo and are shown, not dropped."

And close X1 in the architecture's _Open cross-update conflicts_ table, the overview's _Open items / Overlap with Part 1_, and code-standards C1 — all three in this change set (workflow rules §7.2). The bm45 flow snapshot (`additional_info.appendix`) **keeps being written** — Part 2 makes no `workflow-management/flows/bill-run-*` change; bm49 just stops reading it.

## Implementation

### 1. Migration `db/migrations/0045_rating_udr_rated_geo.sql`

```sql
-- bm48 (Invoice Template, R9): persist ratecard geo onto rated usage at INSERT.
-- Rating-owned migration. Forward-only; no backfill. No grant change:
-- rating_runtime's table-level INSERT covers the columns; no role may UPDATE them.
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "state" text;
--> statement-breakpoint
ALTER TABLE "rating"."udr_rated" ADD COLUMN IF NOT EXISTS "district" text;
--> statement-breakpoint
COMMENT ON COLUMN "rating"."udr_rated"."state" IS 'Ratecard state label of the matched RAN cell, frozen at rating (bm48). NULL = rated before bm48 or card label blank.';
--> statement-breakpoint
COMMENT ON COLUMN "rating"."udr_rated"."district" IS 'Ratecard district label of the matched RAN cell, frozen at rating (bm48).';
```

Append the `_journal.json` entry (`idx` after the last, `tag: "0045_rating_udr_rated_geo"`, `when` greater than the last applied entry). The filename matches `/rating/i`, so `rating-migration-boundary.ts` classifies it and proves it touches no `billing.*`.

### 2. Drizzle mirror (`db/schema/rating/udr-rated.ts`)

Add `state: text("state")` and `district: text("district")` after `upsertDatetime` (the file is query-typing only; `drizzle.config.ts` excludes `rating` from generate).

### 3. Python runtime

- `prp.py`: SELECT + `RatecardCell` + record enrichment + output schema (D2). Keep the canonical-key logic (`canonical_udr_key`) byte-identical.
- `rp.py`: pass-through columns in the output schema.
- `rl.py`: `COPY_COLUMNS` append; the named-optional allowlist for non-RAN profiles (D4).
- Bump the flow's revision/`rating_engine_version` per rating's versioning rule so `udr_rated.rating_flow_revision` distinguishes geo-carrying rows.

### 4. Flow YAML

`rating-engine-ran-usage.yaml`: no task change expected (the Python modules carry the logic). If the worker image needs a rebuild, follow rating's image rule. Deploy through the pipeline only — never edit in the Kestra UI (billing workflow rules §6.2).

### 5. Seeds

- `db/seeds/sample/udr-rated-sample.ts` (rating `_SAMPLE_` rows): populate `state`/`district` for RAN rows from the same sample card values (`sample-5g-fixture.ts:41,53-55`; `capacity-usage-card.ts:31-68`), so the `ci` seed exercises bm49. Leave **one** sample RAN row with `NULL` geo to exercise the "Unassigned region" path.
- No change to the ratecard seeds (they already carry state/district).

### 6. Tests (`tests/rating/**`)

| Test | Assertion |
| --- | --- |
| `rm01-schema.integration.test.ts` (extend) | `udr_rated` has nullable `state`, `district` (`text`) on the parent and on a partition |
| `grants.integration.test.ts` (extend) | neither column appears in any role's column `UPDATE` privilege; `rating_runtime` can INSERT them |
| `rm07-prp.*` (extend) | PRP output carries the matched cell's `state`/`district`; a card row with blank labels yields `NULL`; a duplicate cell still fails closed |
| `rm09-rl.*` (extend) | RL COPY writes both columns; a Parquet missing them raises (KeyError guard) for RAN; non-RAN writes `NULL` |
| `rm13-e2e-journey.integration.test.ts:400-425` (extend) | the end-to-end rated row carries the card's state/district |
| new `rm23-udr-geo-frozen.integration.test.ts` | after rating, re-version the card with different labels: the already-rated row's geo is unchanged; an `UPDATE` of `state` as `rating_runtime`, `app_runtime` and `billrun_runtime` is refused (`permission denied`) |

Billing test premise to correct **in bm49, not here** (no billing code in this unit): `tests/db/billrun-capacity-appendix.integration.test.ts:30-35` documents "`udr_rated` carries no state/district column at all".

## Dependencies

- **npm:** none. **Python:** none (pyarrow already used for the Parquet hand-off).
- **Prerequisite:** G13 confirmed by rating. Independent of bm47 — may run in parallel with it. **Must land before bm49.**
- **Downstream:** bm49 reads these columns.

## Verification checklist

- [ ] `0045_rating_udr_rated_geo.sql` applies on a fresh DB and on a DB with existing `udr_rated` rows (no rewrite; existing rows `NULL`).
- [ ] `rating-migration-boundary` check passes (rating migration, no `billing.*`).
- [ ] A newly rated `RAN_USAGE` row on the sample feed carries the matched card row's `state`/`district`; a pre-existing row stays `NULL`.
- [ ] Re-versioning the card after rating does not change a rated row's geo.
- [ ] No role can `UPDATE` `state`/`district` (asserted over `information_schema.column_privileges` / `pg_attribute`).
- [ ] PRP's canonical-key function and duplicate-cell fail-closed are unchanged (diff + existing tests).
- [ ] The rating live-Kestra RAN journey (rm13) passes with the new columns populated.
- [ ] No billing file changed (diff check against the billing paths listed in the boundary).
- [ ] `npm run typecheck`, `npm run lint`, `npm test` and the rating integration suite green.
- [ ] Docs, same change set: Inv #36 amended (D6); X1 closed in the architecture conflict table, C1 closed in code-standards, the _Overlap_ item removed from the overview's open items; `ratemgmt` architecture + progress tracker record the two columns and the PRP capture point; `bm00` Unit 48 text corrected ("PRP's ratecard cell match", not "where rating reads `rate_per_unit`"); `billmgmt-known-issues.md` bm45 D4 residual marked closed for post-bm48 rows.
