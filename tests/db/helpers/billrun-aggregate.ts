import type postgresjs from "postgres";

// The shared bill_run_processing "flow-double": the SAME `billrun_runtime`
// aggregation SQL the real flow's `aggregation` stage runs
// (workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml),
// executed inside ONE `sql.begin` transaction (matching the flow's BEGIN;…COMMIT;).
// bm28 (USAGE rollup) and bm29 (RECURRING resolver + D33 + snapshot rerun) both
// drive this ONE copy so the doubles never drift from each other or the flow (the
// bm21 pattern). A D33 RAISE rejects the returned promise and rolls the whole
// account back (no bill) — the caller asserts on the thrown message.
//
// Kept faithful to the flow: prior RECURRING lines captured BEFORE the replace
// (Inv #20); as-of recurring resolution ONLY for offerings that INTEND a recurring
// charge (a recurring product_offering_price OR an override) — a usage-only
// offering yields no recurring line and never trips D33; the window scan pruned to
// the account's offerings; D33 HARD-fail; USAGE + RECURRING assembled with one
// deterministic line_no over (grouping_key, source); subtotal = SUM(net_amount).
export interface AggregateParams {
  runId: string;
  ban: string;
  attempt: number;
  periodStart: string;
  periodEnd: string;
  glEventAt: string;
}

export async function runAggregation(
  sql: postgresjs.Sql,
  { runId, ban, attempt, periodStart, periodEnd, glEventAt }: AggregateParams,
): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      CREATE TEMP TABLE _bm29_prior ON COMMIT DROP AS
        SELECT l.ref_product_offering_id, l.description, l.quantity, l.unit,
               l.gross_amount, l.discount_amount, l.net_amount, l.currency,
               l.grouping_key,
               l.snapshot_price_ref, l.snapshot_unit_price,
               l.snapshot_quantity, l.snapshot_effective_date
        FROM   billing.customer_bill_line l
        JOIN   billing.customer_bill b
               ON b.customer_bill_id = l.ref_customer_bill_id
              AND b.period_partition = l.period_partition
        WHERE  b.ref_bill_run_id = ${runId}
          AND  b.ref_billing_account_id = ${ban}
          AND  l.source = 'RECURRING'
    `;
    await tx`
      CREATE TEMP TABLE _bm29_resolved ON COMMIT DROP AS
        WITH asof AS (
          SELECT offering_id, unit_price, price_ref, pricing_model,
                 effective_date, currency, rc_len, rc_type
          FROM (
            SELECT pop.product_offering_id                       AS offering_id,
                   pop.amount                                    AS unit_price,
                   pop.product_offering_price_id                 AS price_ref,
                   pop.pricing_model                             AS pricing_model,
                   (pop.start_date_time AT TIME ZONE 'UTC')::date AS effective_date,
                   pop.currency                                  AS currency,
                   pop.recurring_charge_period_length            AS rc_len,
                   pop.recurring_charge_period_type              AS rc_type,
                   lead((pop.start_date_time AT TIME ZONE 'UTC')::date) OVER (
                     PARTITION BY pop.product_offering_id
                     ORDER BY pop.start_date_time
                   )                                            AS next_effective
            FROM   product.product_offering_price pop
            WHERE  pop.price_type = 'recurring'
              AND  pop.product_offering_id IN (
                     SELECT product_offering_id
                     FROM   inventory.product_inventory
                     WHERE  billing_account_id = ${ban} AND status = 'ACTIVE')
          ) w
          WHERE  w.effective_date <= ${periodStart}::date
            AND  (w.next_effective > ${periodStart}::date OR w.next_effective IS NULL)
        )
        SELECT pi.product_offering_id                                   AS product_offering_id,
               COALESCE(oipo.amount, a.unit_price)::numeric(18,6)       AS unit_price,
               COALESCE(oipo.order_item_price_override_id, a.price_ref) AS price_ref,
               a.pricing_model                                          AS pricing_model,
               a.effective_date                                         AS effective_date,
               COALESCE(oipo.currency, a.currency)                      AS currency,
               ba.currency                                             AS account_currency,
               pi.quantity::numeric(20,6)                              AS quantity,
               COALESCE(
                 (CASE bc.frequency
                    WHEN 'monthly'   THEN 1
                    WHEN 'quarterly' THEN 3
                    WHEN 'annually'  THEN 12
                  END)::numeric
                 / NULLIF(a.rc_len * CASE lower(COALESCE(a.rc_type, ''))
                                       WHEN 'month'     THEN 1
                                       WHEN 'months'    THEN 1
                                       WHEN 'quarter'   THEN 3
                                       WHEN 'quarters'  THEN 3
                                       WHEN 'year'      THEN 12
                                       WHEN 'years'     THEN 12
                                       WHEN 'annual'    THEN 12
                                       WHEN 'annually'  THEN 12
                                       ELSE NULL
                                     END, 0),
                 1)::numeric                                            AS period_factor
        FROM   inventory.product_inventory pi
        JOIN   billing.billing_account ba ON ba.billing_account_id = pi.billing_account_id
        JOIN   billing.bill_cycle bc       ON bc.bill_cycle_id = ba.ref_bill_cycle_id
        LEFT   JOIN asof a ON a.offering_id = pi.product_offering_id
        LEFT   JOIN ordering.order_item_price_override oipo
               ON oipo.product_order_item_id = pi.product_order_item_id
              AND oipo.price_type = 'recurring'
        WHERE  pi.billing_account_id = ${ban}
          AND  pi.status = 'ACTIVE'
          AND  pi.product_offering_id NOT IN (
                 SELECT ref_product_offering_id FROM _bm29_prior)
          AND  (
                 oipo.order_item_price_override_id IS NOT NULL
              OR EXISTS (
                   SELECT 1 FROM product.product_offering_price pop2
                   WHERE  pop2.product_offering_id = pi.product_offering_id
                     AND  pop2.price_type = 'recurring')
               )
    `;
    await tx.unsafe(`
      DO $$
      DECLARE
        v_unsupported       int;
        v_not_found         int;
        v_currency_mismatch int;
      BEGIN
        SELECT count(*) FILTER (WHERE unit_price IS NULL AND pricing_model = 'tiered'),
               count(*) FILTER (WHERE unit_price IS NULL AND pricing_model IS DISTINCT FROM 'tiered'),
               count(*) FILTER (WHERE unit_price IS NOT NULL AND currency IS DISTINCT FROM account_currency)
          INTO v_unsupported, v_not_found, v_currency_mismatch
        FROM   _bm29_resolved;
        IF v_unsupported > 0 THEN
          RAISE EXCEPTION 'RECURRING_PRICE_UNSUPPORTED (HARD): % subscription(s) priced tiered (D33/Inv #28)', v_unsupported;
        END IF;
        IF v_not_found > 0 THEN
          RAISE EXCEPTION 'RECURRING_PRICE_NOT_FOUND (HARD): % subscription(s) have no as-of recurring price (D33/Inv #28)', v_not_found;
        END IF;
        IF v_currency_mismatch > 0 THEN
          RAISE EXCEPTION 'RECURRING_CURRENCY_MISMATCH (HARD): % subscription(s) priced in a currency other than the account currency (D33/Inv #28)', v_currency_mismatch;
        END IF;
      END $$;
    `);
    await tx`SELECT billing.billrun_delete_trial_bill(${runId}, ${ban})`;
    await tx`
      WITH usage_lines AS (
        SELECT (pi.product_offering_id || ':' || ur.udr_type) AS grouping_key,
               'USAGE'::text                       AS source,
               pi.product_offering_id              AS offering_id,
               ur.udr_type                         AS udr_type,
               po.name                             AS description,
               SUM(ur.udr_usage_quantity)::numeric(20,6) AS quantity,
               min(ur.udr_usage_unit)              AS unit,
               SUM(ur.udr_rated_price)::numeric(18,2)    AS gross,
               '0.00'::numeric(18,2)               AS discount,
               SUM(ur.udr_rated_price)::numeric(18,2)    AS net,
               count(*)::int                       AS udr_count,
               min(ur.udr_currency)::text          AS currency,
               NULL::text                          AS snapshot_price_ref,
               NULL::numeric(18,6)                 AS snapshot_unit_price,
               NULL::numeric(20,6)                 AS snapshot_quantity,
               NULL::date                          AS snapshot_effective_date
        FROM   rating.udr_rated ur
        JOIN   inventory.product_inventory pi
               ON pi.product_inventory_id = ur.udr_subscriber_ref_id
        JOIN   product.product_offering po
               ON po.product_offering_id = pi.product_offering_id
        WHERE  ur.billrun_ref_id  = ${runId}
          AND  ur.billrun_ban_id  = ${ban}
          AND  ur.billrun_attempt = ${attempt}
          AND  ur.status = 'BILL_DRAFT'
        GROUP BY pi.product_offering_id, ur.udr_type, po.name
      ),
      recurring_prior AS (
        SELECT p.grouping_key,
               'RECURRING'::text                   AS source,
               p.ref_product_offering_id           AS offering_id,
               NULL::text                          AS udr_type,
               p.description,
               p.quantity::numeric(20,6)           AS quantity,
               p.unit,
               p.gross_amount::numeric(18,2)       AS gross,
               p.discount_amount::numeric(18,2)    AS discount,
               p.net_amount::numeric(18,2)         AS net,
               NULL::int                           AS udr_count,
               p.currency::text                    AS currency,
               p.snapshot_price_ref,
               p.snapshot_unit_price::numeric(18,6)   AS snapshot_unit_price,
               p.snapshot_quantity::numeric(20,6)     AS snapshot_quantity,
               p.snapshot_effective_date
        FROM   _bm29_prior p
      ),
      recurring_fresh AS (
        SELECT (r.product_offering_id || ':RECURRING')     AS grouping_key,
               'RECURRING'::text                   AS source,
               r.product_offering_id               AS offering_id,
               NULL::text                          AS udr_type,
               po.name                             AS description,
               SUM(r.quantity)::numeric(20,6)      AS quantity,
               NULL::text                          AS unit,
               SUM(r.unit_price * r.period_factor * r.quantity)::numeric(18,2) AS gross,
               '0.00'::numeric(18,2)               AS discount,
               SUM(r.unit_price * r.period_factor * r.quantity)::numeric(18,2) AS net,
               NULL::int                           AS udr_count,
               min(r.currency)::text               AS currency,
               min(r.price_ref)                    AS snapshot_price_ref,
               min(r.unit_price)::numeric(18,6)    AS snapshot_unit_price,
               SUM(r.quantity)::numeric(20,6)      AS snapshot_quantity,
               min(r.effective_date)               AS snapshot_effective_date
        FROM   _bm29_resolved r
        JOIN   product.product_offering po
               ON po.product_offering_id = r.product_offering_id
        GROUP BY r.product_offering_id, po.name
      ),
      all_lines AS (
        SELECT * FROM usage_lines
        UNION ALL SELECT * FROM recurring_prior
        UNION ALL SELECT * FROM recurring_fresh
      ),
      ins_header AS (
        INSERT INTO billing.customer_bill
          (ref_bill_run_id, ref_billing_account_id, period_partition,
           category, state, billing_period_start, billing_period_end,
           subtotal, tax_total, total_amount, payment_due_date)
        SELECT ${runId}, ${ban}, date_trunc('month', ${periodStart}::date)::date,
               'trial', 'new', ${periodStart}::date, ${periodEnd}::date,
               '0.00', '0.00', '0.00',
               ${glEventAt}::date
                 + COALESCE(ba.payment_due_days_override, bc.payment_due_days)
        FROM   billing.billing_account ba
        JOIN   billing.bill_cycle bc ON bc.bill_cycle_id = ba.ref_bill_cycle_id
        WHERE  ba.billing_account_id = ${ban}
        RETURNING customer_bill_id, period_partition
      )
      INSERT INTO billing.customer_bill_line
        (ref_customer_bill_id, period_partition, line_no, source, line_type,
         ref_product_offering_id, udr_type, description, quantity, unit,
         gross_amount, discount_amount, net_amount, udr_count, grouping_key,
         currency, snapshot_price_ref, snapshot_unit_price, snapshot_quantity,
         snapshot_effective_date)
      SELECT h.customer_bill_id, h.period_partition,
             row_number() OVER (ORDER BY al.grouping_key, al.source) AS line_no,
             al.source, 'charge',
             al.offering_id, al.udr_type, al.description,
             al.quantity, al.unit,
             al.gross, al.discount, al.net,
             al.udr_count, al.grouping_key, al.currency,
             al.snapshot_price_ref, al.snapshot_unit_price,
             al.snapshot_quantity, al.snapshot_effective_date
      FROM   all_lines al
      CROSS JOIN ins_header h
    `;
    await tx`
      WITH s AS (
        SELECT cb.customer_bill_id, cb.period_partition, cb.tax_total,
               COALESCE(SUM(l.net_amount), '0.00')::numeric(18,2) AS net
        FROM   billing.customer_bill cb
        LEFT   JOIN billing.customer_bill_line l
               ON l.ref_customer_bill_id = cb.customer_bill_id
              AND l.period_partition = cb.period_partition
        WHERE  cb.ref_bill_run_id = ${runId}
          AND  cb.ref_billing_account_id = ${ban}
          AND  cb.period_partition = date_trunc('month', ${periodStart}::date)::date
        GROUP BY cb.customer_bill_id, cb.period_partition, cb.tax_total
      )
      UPDATE billing.customer_bill cb
      SET    subtotal = s.net,
             total_amount = s.net + s.tax_total
      FROM   s
      WHERE  cb.customer_bill_id = s.customer_bill_id
        AND  cb.period_partition = s.period_partition
    `;
  });
}
