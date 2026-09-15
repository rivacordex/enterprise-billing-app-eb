# bm28 — Real Aggregation (`USAGE`) + `BillLineTable`

**Unit:** bm28 (Phase 3 · Phase L). **Boundary:** the processing flow's `aggregation` stage (run as `billrun_runtime`) + `db/bootstrap/billrun-db-roles.sql` (a product read grant) + the Customers & Bills read path (`components/billing/bill-line-table.tsx`, a `customer_bill_line` read + service, `types/billing.ts` unions). **Specs from:** `billmgmt-architecture.md` §6 **Inv #3** (the charge record; `subtotal = SUM(net_amount)`), **Inv #16** (whole-account replace), `billmgmt-code-standards.md` §4 (`BillLineTable`) / §9.4/§9.5/§9.9, `billmgmt-ui-context.md` §6, `bm00-build-plan.md` Unit 28.

> **Framing.** Collection (bm27) claimed the account's usage to `BILL_DRAFT`. Aggregation turns those claimed rows into the bill's **charge record** — one `customer_bill_line` per `(product_offering_id, udr_type)`, rolled up **across** subscriptions, so an account with 3 subscriptions of one offering and 500 of another shows **2 charge lines, not 503**. The account's `customer_bill.subtotal` becomes `SUM(net_amount)` over those lines, and Taxation (already SQL-recomputes from `subtotal`, no unit) follows. The re-derivation is a **whole-account replace** — never a per-line upsert. `BillLineTable` folds in because aggregation nobody can see has no standalone visible result, and switching the tab from the phase-2 stub to `customer_bill_line` is the same session's work.

## Goal

Implement the `aggregation` stage so it groups the account's claimed `BILL_DRAFT` usage into `customer_bill_line` at `(product_offering_id, udr_type)` grain (rolled up across subscriptions, with `udr_count` + grouping key and a deterministic `line_no`), sets `customer_bill.subtotal = SUM(net_amount)`, and re-derives via the whole-account replace; and add `BillLineTable` to the Customers & Bills tab reading `customer_bill_line`, with the `udr_rated` drill-down behind a lazily-fetched disclosure.

## Design

**Structural decisions**

- **Grain `(product_offering_id, udr_type)`, rolled across subscriptions (Inv #3).** `product_offering_id` is read from `inventory.product_inventory` (a **denormalized column** on the subscription — `udr_rated.udr_subscriber_ref_id → product_inventory.product_offering_id`), so multiple subscriptions of the same offering collapse into one line. `udr_type` comes from the claimed rows. Each line stores `udr_count` (how many `udr_rated` rows rolled in) and the `grouping_key` used to order and reconcile it.
- **`subtotal = SUM(net_amount)` (Inv #3).** After the lines are written, `customer_bill.subtotal` is set to `SUM(customer_bill_line.net_amount)` in SQL; `discount_amount` is `0.00` this phase (no discount computed — §3), so `net_amount = gross_amount`. Taxation then recomputes `tax_total`/`total_amount` from `subtotal` as it already does — no taxation unit needed.
- **Whole-account replace, never per-line (Inv #16, D22).** Re-derivation calls `billing.billrun_delete_trial_bill(run, ban)` (the scoped `SECURITY DEFINER` delete of the non-finalized `customer_bill`; its lines vanish by `ON DELETE CASCADE`, bm23) and then re-inserts the `customer_bill` header + its lines. **No `ON CONFLICT DO UPDATE`, no bare `DELETE`** against `customer_bill_line` — the guardrail asserts it.
- **Deterministic `line_no` (reproducible on rerun).** `line_no` is assigned by ordering on the `grouping_key`, never insertion order — so re-running aggregation reproduces identical `line_no` values (the checksum's ordering anchor, bm31, and the reconciliation replay, bm30, both depend on this).
- **Offering id is denormalized; the offering name needs `product`.** The grain id needs no `product` read (it is on `product_inventory`); the human-readable line `description` reads `product.product_offering.name`, so `billrun_runtime` gains `USAGE` on `product` + `SELECT` on `product.product_offering`.
- **`BillLineTable` reads `customer_bill_line`; the `udr_rated` drill-down is lazy.** The table renders one row per line (tabular-nums money, square radius, ui-context §6). Each `USAGE` row has a native `<details>` disclosure that **fetches its `udr_rated` rows only on expand** (via the existing read-only `ratedLinesRepository.listClaimedForAccount`, the bm18 fetch-on-open pattern) — volume accounts have thousands of records, so nothing loads until asked. `discount_amount` column is **hidden while every value is `0.00`** (D-delta).
- **`ChargeSource` badge is bm29, not here.** Every line this unit produces is `USAGE`; the `ChargeSourceBadge` (cyan `USAGE` / primary `RECURRING`) first distinguishes something in bm29. bm28 introduces the `types/billing.ts` `ChargeSource`/`LineType` unions (the typed mirror of the schema CHECKs) as the first consumer of `customer_bill_line`; the badge component lands with recurring.

## Implementation

### 1. `aggregation` stage — the real USAGE aggregation (`billrun_runtime`)

Whole-account, set-based, run inside the flow. Following the template's rerun-safe contract:

```sql
-- 1. Whole-account replace (Inv #16): drop the non-finalized bill; lines cascade.
SELECT billing.billrun_delete_trial_bill(%(bill_run_id)s, %(ban)s);
-- 2. Re-insert the header (category='trial', period from inputs), subtotal set in step 4.
INSERT INTO billing.customer_bill (...) VALUES (...);
-- 3. One line per (product_offering_id, udr_type), rolled across subscriptions.
INSERT INTO billing.customer_bill_line
  (ref_customer_bill_id, period_partition, line_no, source, line_type,
   ref_product_offering_id, udr_type, description, quantity, unit,
   gross_amount, discount_amount, net_amount, udr_count, grouping_key, currency)
SELECT %(customer_bill_id)s, %(period_partition)s,
       row_number() OVER (ORDER BY grp.grouping_key)      AS line_no,
       'USAGE', 'charge',
       grp.product_offering_id, grp.udr_type, po.name,
       grp.qty, grp.unit,
       grp.gross, '0.00', grp.gross                        AS net_amount,
       grp.udr_count, grp.grouping_key, grp.currency
FROM (
  SELECT pi.product_offering_id,
         ur.udr_type,
         (pi.product_offering_id || ':' || ur.udr_type)    AS grouping_key,
         SUM(ur.udr_rated_price)                           AS gross,
         SUM(ur.udr_usage_quantity)                        AS qty,
         min(ur.udr_usage_unit)                            AS unit,
         count(*)                                          AS udr_count,
         min(ur.udr_currency)                              AS currency
  FROM   rating.udr_rated ur
  JOIN   inventory.product_inventory pi
         ON pi.product_inventory_id = ur.udr_subscriber_ref_id
  WHERE  ur.billrun_ref_id = %(bill_run_id)s
    AND  ur.billrun_ban_id = %(ban)s
    AND  ur.billrun_attempt = %(attempt)s
    AND  ur.status = 'BILL_DRAFT'
  GROUP BY pi.product_offering_id, ur.udr_type
) grp
JOIN product.product_offering po ON po.product_offering_id = grp.product_offering_id;
-- 4. subtotal = SUM(net_amount) over the lines just written.
UPDATE billing.customer_bill SET subtotal = (
  SELECT COALESCE(SUM(net_amount),'0.00') FROM billing.customer_bill_line
  WHERE ref_customer_bill_id = %(customer_bill_id)s AND period_partition = %(period_partition)s
) WHERE customer_bill_id = %(customer_bill_id)s AND period_partition = %(period_partition)s;
```

Money is summed in SQL (`numeric`), never JS float. The `aggregation` stage then signals `DONE` via the record-only M2M handler.

### 2. Flow files

- **`bill_run_processing.template.yml`** — replace the `aggregation` `# STUB:` with the real contract: group claimed `BILL_DRAFT` into `customer_bill_line` at `(product_offering_id, udr_type)`; `subtotal = SUM(net_amount)`; whole-account replace via `billrun_delete_trial_bill`; deterministic `line_no`.
- **`local-dev/bill_run_processing.yml`** — replace the `aggregation` no-op `Log` with the real SQL (or the flow-double for the app-repo E2E), so the local E2E produces real lines on the `ci` seed.

### 3. `db/bootstrap/billrun-db-roles.sql` — the product read grant

- **Step 3:** add `GRANT USAGE ON SCHEMA "product" TO billrun_runtime;`.
- **Step 8:** extend the enumerated read grant with `"product"."product_offering"` (for the line `description`). No write on `product`.

### 4. Read path — `customer_bill_line` for the Customers & Bills tab

- **`db/repositories/billing/customer-bill-line.repository.ts`** — a read `listForRun`/`listForAccount(billRunId, ...)` returning the line rows (`source`, `line_type`, `ref_product_offering_id`, `udr_type`, `description`, `quantity`, `unit`, `gross/discount/net`, `udr_count`, `line_no`, `currency`), ordered by `line_no`. (bm31 adds the SQL checksum method to this same repository.)
- **`services/billing/read/`** — extend the Customers & Bills read to compose lines per account (one repeatable-read snapshot, matching `list-account-bills.ts`).
- **`types/billing.ts`** — add `ChargeSource = 'USAGE' | 'RECURRING' | 'OCC'` and `LineType = 'charge' | 'discount' | 'adjustment'` (typed mirrors of the CHECKs) + the `BillLineRow` read model.

### 5. UI — `BillLineTable`

- **`components/billing/bill-line-table.tsx`** (new) — renders one row per `customer_bill_line` (mono ids, tabular-nums money, `--radius-none` grid). Columns: line no, offering/description, `udr_type`, quantity/unit, gross, (discount — hidden while all `0.00`), net. Wire it into the Customers & Bills tab **replacing** the phase-2 stub/`udr_rated` view.
- **Drill-down:** each `USAGE` row carries a native `<details>` disclosure that, **on expand only**, fetches its `udr_rated` rows via a session-guarded read backed by `ratedLinesRepository.listClaimedForAccount` (the bm18 fetch-on-open pattern) — never eager.

### 6. Guardrails (land with the unit — code-standards §9)

- **Grain (§9.4):** an account with 3 subscriptions of one offering and 500 of another → exactly **2** `customer_bill_line` rows.
- **`SUM(net_amount) = subtotal` (§9.5)** on every bill.
- **No upsert / bare delete (§9.9):** no `ON CONFLICT DO UPDATE` and no bare `DELETE` against `customer_bill_line`; re-derivation only via `billrun_delete_trial_bill` + INSERT.
- **Deterministic `line_no`:** re-running aggregation reproduces identical `line_no` values (ordered on `grouping_key`).
- DB-gated on the `ci` seed.

## Dependencies

- **No new npm packages.**
- **Prerequisites:** bm27 (claimed `BILL_DRAFT` rows with resolved `billrun_ban_id`); bm23 (`customer_bill_line` + its cascade FK and grants); bm14 (`billrun_delete_trial_bill`). `product.product_offering` populated (delivered).

## Verification checklist

- [ ] Aggregation writes one `customer_bill_line` per `(product_offering_id, udr_type)`, rolled across subscriptions (3 + 500 → 2 lines), with `udr_count`, `grouping_key`, and a deterministic `line_no`.
- [ ] `customer_bill.subtotal = SUM(customer_bill_line.net_amount)`; Taxation's SQL recompute of `tax_total`/`total_amount` follows from it.
- [ ] Re-derivation is the whole-account replace (`billrun_delete_trial_bill` + INSERT); no `ON CONFLICT`/bare `DELETE`; re-run reproduces identical `line_no`.
- [ ] `billrun_runtime` has `USAGE` on `product` + `SELECT` on `product.product_offering` (description); no write on `product`.
- [ ] `BillLineTable` renders `customer_bill_line` rows on the Customers & Bills tab; the `udr_rated` drill-down fetches only on `<details>` expand; `discount_amount` column hidden while all `0.00`.
- [ ] `tsc`/lint/tests green; guardrails §9.4/§9.5/§9.9 pass on the `ci` seed; `billmgmt-progress-tracker.md` records bm28 delivered.
