# rm21 — PRP: resolution, identity locks, checks + flow config — Spec

- **Unit:** rm21 of Phase G (`rm00-build-plan.md`)
- **Repo:** `workflow-management` · **Boundary:** `worker/workflow-engine/runtime/prp.py` + `flows/rating-engine/rating-engine-ran-usage.yaml`
- **Authorizes from:** `_change-rating-configuration-plan.md` (A1, A4, A5, A9); `ratemgmt-architecture.md` Inv 20–25; decision **A** (resolution is PRP's).
- **Depends on:** rm16 (customer/product read grants), rm18 (seed).

## Goal

In PRP: **resolve factor 1** (`mno → party_role_id → RAN_USAGE subscription → product_inventory_id`) and write it into the chunk for RP; enforce the **three-factor identity lock**, `service_code` verify, ratecard↔input completeness (both directions), and `udrType` confirmation — all hard-stops; widen dedup to the billing-month identity key; and wire the flow config (7-column `.udr` feed, `file_key_rule`, `ratecard_coverage_enforcement`, `reject_threshold: "0"`, the product pin).

## Design

- **PRP already claims → parses → dedups → rejects (rm07).** rm21 adds, before/around that: two per-batch **extracts** (the ACTIVE ratecard, and the subscription/customer summary), the resolution, and the new checks. PRP holds a DB connection for claiming; reuse it for the reads (`rating_runtime` grants, rm16).
- **Resolution is set-based per batch, not per record.** Resolve the *distinct* MNOs once → `(party_role_id, product_inventory_id)`; stamp both onto each record's chunk row. `product_inventory_id` is what RP prices on (rm20); `party_role_id` is what factors 2 and 3 compare.
- **Two failure classes, kept distinct.** Structural per-record faults (missing column/data, in-file duplicate) go through the existing reject path against `reject_threshold` (`0` ⇒ any reject refuses the whole file). The **identity / mapping / completeness** faults are **whole-batch hard-stops** (`status = REFUSED`, zero rows) — a mismatch means the file's assumptions are wrong, not one bad row.
- **`partition_period` for dedup is the billing month** — `period_of(start_datetime)` in the config TZ (X1). Dedup key becomes `(partition_period, mno|cu|polygon)` (one record per cell per billing month), replacing rm07's `udr_key`-only seen-set.
- **The pin resolves to the family id once.** The flow var `subscription_product_name` (display, e.g. `"Sample 5G Services"`) is resolved to `COALESCE(family_offering_id, product_offering_id)` at batch start; each record's resolved subscription must share it.

## Implementation

### 1. Per-batch extracts (once, via the claim connection)
- **Active ratecard:** the ACTIVE `ratecard_version` for the card named by the offering's `productCardLookUp` spec, plus its `ratecard_ran_usage_lkp` rows, indexed in memory by `mno|cu|polygon` → `{ lkp_subscriber_ref_id, service_code, … }`.
- **Subscription/customer summary:** for the batch's distinct MNOs, the resolution join (step 2).

### 2. Factor-1 resolution + `product_inventory_id` in the chunk
For each distinct `mno_public_id`:
```sql
SELECT pr.party_role_id, pi.product_inventory_id,
       COALESCE(po.family_offering_id, po.product_offering_id) AS family_id
FROM   customer.party_role pr
JOIN   inventory.product_inventory pi
       ON pi.customer_party_role_id = pr.party_role_id
      AND pi.status = 'ACTIVE'
      AND pi.start_date <= (%(start_dt)s AT TIME ZONE 'Asia/Kuala_Lumpur')::date
      AND (pi.end_date IS NULL OR pi.end_date >= (%(start_dt)s AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
JOIN   product.product_offering po ON po.product_offering_id = pi.product_offering_id
JOIN   product.product_specifications ps
       ON ps.ref_product_offering_id = po.product_offering_id
      AND ps.name = 'udrType' AND ps.default_value = 'RAN_USAGE'
WHERE  pr.party_role_specification->>'mnoPublicKey1' = %(mno)s
```
- **0 rows / empty `{}` spec** → `UNKNOWN_SUBSCRIBER` (batch hard-stop — detected per record, refuses the whole batch with zero rows, consistent with §Design and the other identity faults).
- **>1 party_role for one MNO** → `MNO_KEY_NOT_UNIQUE` (batch hard-stop) — the one-MNO→one-customer invariant.
- Stamp `product_inventory_id`, `party_role_id`, `family_id` onto the chunk row.

### 3. `udrType` confirmation (batch)
Assert the flow var `udr_type` (`RAN_USAGE`) equals the resolved offering's `udrType` spec value → else `UDRTYPE_MISMATCH`, refuse the batch.

### 4. Per-record checks (in the parse pass)
For each record, after resolution + the ratecard match on `mno|cu|polygon`:
- **Dedup:** on `(partition_period, mno|cu|polygon)` — a same-cell/same-billing-month repeat is a duplicate (`0` threshold ⇒ batch refusal); a same-cell/different-month pair is kept.
- **Factor 2:** matched ratecard row's `lkp_subscriber_ref_id` == the resolved `party_role_id` → else `SUBSCRIBER_REF_MISMATCH` (hard-stop).
- **Factor 3:** the record's `family_id` == the pinned family id → else `PRODUCT_PIN_MISMATCH` (hard-stop).
- **`service_code`:** input `service_code` == the matched ratecard row's → else `SERVICE_CODE_MISMATCH` (hard-stop).
- **input→ratecard:** no ratecard entry for `mno|cu|polygon` → `INPUT_UNMAPPED` (hard-stop — replaces rm07/rm08's per-record `LOOKUP_MISS` for the unmapped case).

### 5. Completeness ratecard→input (after the pass)
Every active ratecard `mno|cu|polygon` must have appeared in the input. A missing polygon → `RATECARD_COVERAGE_GAP` — **hard-stop** under `ratecard_coverage_enforcement = HARD_STOP` (default), or a `RATECARD_COVERAGE_GAP_WARN` log line under `WARN` (rate the file, flag the gap).

### 6. Flow config (`rating-engine-ran-usage.yaml`)
- `feed_profile` → the **7-column** shape (`mno_public_id, commercial_unit, polygon_id, datetime_YYYYMMDDHHMI, usage_volume, district_name, service_code`), `udr_key_columns = [mno_public_id, commercial_unit, polygon_id]`, **no `usage_unit`** (product-sourced).
- `file_key_rule: '^(?P<file_key>rating-input-file-\d{12})(?:_v\d+)?\.udr$'`.
- `ratecard_coverage_enforcement: HARD_STOP`; `reject_threshold: "0"`; `subscription_product_name: "Sample 5G Services"`.
- Remove the `subscriber_ref_column: PUBLIC_KEY` placeholder var and its `--subscriber-ref-column` CLI arg.

### 7. Reconciliation & events
The identity `parsed = rated + rejected + discarded` still holds: a batch-level refusal sets `discarded = parsed − rejected`, `status = REFUSED`. Every new event code is emitted through the existing one-summarised-line path (Inv #11); none is a per-record log row.

### 8. Tests (`tests/rating/rm07-*` refresh)
- A clean 7-column `.udr` file passes; `product_inventory_id` reaches RP.
- Each forced failure hard-stops the whole batch with the correct event code (bad MNO key → `UNKNOWN_SUBSCRIBER`; wrong `lkp` → `SUBSCRIBER_REF_MISMATCH`; wrong pin → `PRODUCT_PIN_MISMATCH`; wrong `service_code` → `SERVICE_CODE_MISMATCH`; missing polygon under HARD_STOP → `RATECARD_COVERAGE_GAP`; unmapped row → `INPUT_UNMAPPED`; two customers one MNO → `MNO_KEY_NOT_UNIQUE`).
- Missing polygon under `WARN` rates + logs (**not** a stop).
- Dedup: same-cell/same-month rejected, different-month kept (**R2**).
- `input→ratecard` unmapped row is a whole-batch stop, not a per-record `LOOKUP_MISS` (**R3**).

## Dependencies

**None.** Python + SQL over the existing `psycopg` connection; the ratecard/customer reads use the rm16 grants.

## Verification checklist

- [ ] Resolution is **set-based per batch** (one query per distinct MNO set), never per record; `product_inventory_id` + `party_role_id` are stamped on the chunk.
- [ ] All three identity factors, `service_code`, `input→ratecard`, `udrType`, and `MNO_KEY_NOT_UNIQUE` **hard-stop the whole batch** (`status = REFUSED`, zero rows) with the correct event codes.
- [ ] Dedup keys on `(partition_period, mno|cu|polygon)` with `partition_period = period_of(start_datetime)` in the config TZ; R2 holds.
- [ ] `input→ratecard` unmapped → whole-batch stop (R3), not a per-record `LOOKUP_MISS`.
- [ ] `ratecard→input` completeness: HARD_STOP refuses on a missing polygon; WARN rates + logs it.
- [ ] Flow YAML: 7-column no-unit `feed_profile`; `file_key_rule` for `.udr`; `reject_threshold:"0"`; `subscription_product_name` pin; no `subscriber_ref_column`.
- [ ] `parsed = rated + rejected + discarded` holds on a refused batch; every new event code resolves in `event_catalog` (rm18); no per-record log rows.
- [ ] rm07's suite is green with the new checks; diff is `prp.py` + the flow YAML only.
