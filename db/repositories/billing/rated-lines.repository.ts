import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";
import type { ExceptionKind } from "@/types/billing";

// bm32 — the run WINDOW that scopes the per-record exception reads. Both the
// exception surface and the informational orphan count are scoped to the ≤2
// UTC-month partitions the run window spans (partition pruning) AND to
// `start_datetime` within `[periodStart, periodEnd]`. `udr_rated.partition_period`
// is `rating.period_of(start_datetime)` — the UTC month of the USAGE timestamp —
// so a `cycle_day != 1` run whose period straddles two calendar months lands its
// rows in two partitions; scoping by a single `firstOfMonth(periodStart)` would
// silently drop the second month's in-window rows and admit the first month's
// out-of-window rows (Inv #25 — never filter silently). The date comparison
// mirrors bm27 Validation's window check exactly.
export interface ExceptionWindow {
  partitions: string[];
  periodStart: string;
  periodEnd: string;
}

function windowConditions(window: ExceptionWindow) {
  return [
    inArray(udrRated.partitionPeriod, window.partitions),
    sql`(${udrRated.startDatetime} AT TIME ZONE 'UTC')::date BETWEEN ${window.periodStart}::date AND ${window.periodEnd}::date`,
  ];
}

// The ORPHAN predicate — an unclaimed live `RATED` `RAN_USAGE` row Collection
// left behind. Defined ONCE so `listExceptionsForWindow`'s orphan arm and
// `countOrphansForWindow` can never drift: the checklist count MUST equal the
// number of ORPHAN rows the exception surface lists.
function orphanConditions() {
  return [
    eq(udrRated.status, "RATED"),
    isNull(udrRated.billrunBanId),
    eq(udrRated.isLive, true),
    eq(udrRated.udrType, "RAN_USAGE"),
  ];
}

// bm18-spec §Implementation §2 step 1 — a READ-ONLY drill-down repository over
// the account's claimed `udr_rated` charge lines, for the `BILL_DRAFT`/
// `BILL_APPROVED` `BillLineTable` drill-down (`listClaimedForAccount`,
// `listClaimedForLine`). bm32 adds two more READ-ONLY reads over the SAME table
// for the per-record exception surface (`listExceptionsForPeriod`,
// `countOrphansForPeriod`) — BILL_NOTUSED rows and unclaimed orphans (Inv #25).
// `app_runtime` holds SELECT on `rating.*`
// (architecture §4); every read here is a plain `SELECT`, never the app's claim
// write (that single `UPDATE` stays isolated in
// `db/repositories/billing/udr-status.repository.ts`, architecture Inv. #2), so
// this file writes no `rating.*` and the `billing-rating-write-boundary`
// guardrail is unaffected. Scoped to `BILL_DRAFT`/`BILL_APPROVED` — the two
// claimed, still-live statuses a pre-posting or just-approved draft can show;
// `REJECTED`/`SUPERSEDED`/`BILL_NOTUSED` rows are never billed and must never
// appear as a line item.
//
// The posting `charge_checksum` NO LONGER lives here (bm31): it re-anchored
// onto `customer_bill_line` content (the bill's own charge record, Inv #3) and
// now lives in `customer-bill-line.repository.ts`'s `computeChargeChecksum`.
//
// bm71-spec §Design "The detail query" (D5/D8/D21/D37, Inv #56) — the home of
// the invoice's per-polygon capacity detail read (workflow rules §6.10: this
// file stays READ-ONLY; the read lands here as a read, replacing bm49's
// usage-annex read). It is built from `sql` fragments over the Drizzle schema
// objects (never a literal schema-qualified table reference), so the
// `billing-rating-write-boundary` guardrail's write-surface scan stays clean —
// every statement here is a plain `SELECT`. `app_runtime` holds SELECT on
// `inventory.product_inventory` and `billing.customer_bill_line`.

// One detail row (all `::text`). `polygonId` is the raw `polygon_id=` value of
// `udr_key` (rm26: `name=value` joined by `|`, the value untouched), `null`
// when the segment is absent or empty; `resourceOk` is false when
// `udr_resource` is NULL or not the rm25 `state|district|YYYY-MM-DD` shape. The
// binder fails `INVOICE_POLYGON_DATA_MISSING` on either (D29), so no other
// field of such a row is ever printed. `label` is the capacity line's
// description (the type of service); `regionLabel` the D21 State-District
// label.
export interface CapacityDetailRowRaw {
  udrId: string;
  offeringId: string;
  label: string;
  regionLabel: string;
  polygonStartDate: string;
  polygonId: string | null;
  resourceOk: boolean;
  capacityMbps: string;
  ratePerMbps: string;
  amount: string;
}

// One GROUPING SETS row: a State-District Sub Total (`gRegion = 0`) or a
// type's detail total (`gRegion = 1`, `regionLabel` null), each the SQL Σ of
// the group's `numeric(18,2)` row amounts.
export interface CapacityDetailGroupRaw {
  offeringId: string;
  regionLabel: string | null;
  gRegion: number;
  amount: string;
}

export type CapacityDetailResult =
  | { overLimit: true; rowCount: number }
  | {
      overLimit: false;
      rows: CapacityDetailRowRaw[];
      groups: CapacityDetailGroupRaw[];
    };

export interface CapacityDetailScope {
  runId: string;
  banId: string;
  attempt: number;
  customerBillId: string;
  periodPartition: string;
}

// The bm49 scope — the attempt the bill was built on (Inv #19), `BILL_DRAFT`
// and `BILL_APPROVED` only (`BILL_NOTUSED` is never billed, Inv #22) — plus
// the type attachment (D5, OI-10): the row's subscription → its product
// offering → the bill's capacity line with that offering, unit and `udr_type`.
// A claimed row with no matching capacity line belongs to an ordinary USAGE
// line (an "Other charges" item, bm70) and is not itemised.
function capacityDetailSource(p: CapacityDetailScope): SQL {
  return sql`
    FROM ${udrRated}
    JOIN ${productInventory}
      ON ${productInventory.productInventoryId} = ${udrRated.udrSubscriptionRefId}
    JOIN ${customerBillLine}
      ON  ${customerBillLine.refCustomerBillId} = ${p.customerBillId}
      AND ${customerBillLine.periodPartition} = ${p.periodPartition}
      AND ${customerBillLine.lineType} = 'charge'
      AND ${customerBillLine.groupingKey} LIKE '%:CAPACITY:%'
      AND ${customerBillLine.refProductOfferingId} = ${productInventory.productOfferingId}
      AND ${customerBillLine.unit} = ${udrRated.udrUsageUnit}
      AND ${customerBillLine.udrType} = ${udrRated.udrType}
    WHERE ${udrRated.billrunRefId} = ${p.runId}
      AND ${udrRated.billrunBanId} = ${p.banId}
      AND ${udrRated.billrunAttempt} = ${p.attempt}
      AND ${udrRated.status} IN ('BILL_DRAFT', 'BILL_APPROVED')`;
}

// The polygon fields, computed once per row in a CTE (Performance note), then
// the D21 region label. `udr_usage_rate` is never NULL on a billed capacity
// row: the flow's `CAPACITY_RATE_MISMATCH` guard counts a NULL rate as a
// mismatch and fails the account before it is processed (bm42 G2, Inv #30).
// The rate is read at 2 decimals: the layout prints it with `money`, which
// keeps a string's own scale, and D21 prints MYR with 2 decimals (spec Open
// question 2; `price` prints 4 below RM1).
function capacityDetailCte(p: CapacityDetailScope): SQL {
  return sql`
    WITH d AS (
      SELECT ${udrRated.udrId} AS udr_id,
             ${customerBillLine.refProductOfferingId} AS offering_id,
             COALESCE(${customerBillLine.description}, ${customerBillLine.refProductOfferingId}) AS label,
             nullif(substring(${udrRated.udrKey} FROM 'polygon_id=([^|]*)'), '') AS polygon_id,
             COALESCE(${udrRated.udrResource} ~ '^[^|]*\\|[^|]*\\|\\d{4}-\\d{2}-\\d{2}$', false) AS resource_ok,
             nullif(btrim(split_part(${udrRated.udrResource}, '|', 1)), '') AS state,
             nullif(btrim(split_part(${udrRated.udrResource}, '|', 2)), '') AS district,
             split_part(${udrRated.udrResource}, '|', 3) AS polygon_start_date,
             ${udrRated.udrUsageQuantity}::text AS capacity_mbps,
             ${udrRated.udrUsageRate}::numeric(18,2)::text AS rate_per_mbps,
             ${udrRated.udrRatedPrice}::numeric(18,2) AS amount
      ${capacityDetailSource(p)}
    ),
    r AS (
      SELECT d.*,
             CASE WHEN state IS NOT NULL AND district IS NOT NULL THEN state || ' - ' || district
                  WHEN state IS NOT NULL THEN state
                  WHEN district IS NOT NULL THEN district
                  ELSE 'Unassigned region'
             END AS region_label,
             (state IS NULL AND district IS NULL) AS unassigned
      FROM d
    )`;
}

export const ratedLinesRepository = {
  // bm71-spec §Implementation §1 — count, then rows, then the GROUPING SETS
  // aggregate, all under the repeatable-read read-only transaction the binder
  // opens (so rows and lines share one snapshot). D37 (the bm49 pattern):
  // `count(*)` first over the same scope and joins; over `limit` it returns
  // `{ overLimit: true }` and selects nothing (no truncation, no partial
  // detail — the bind fails loud and the account parks). Rows are ordered by
  // type label, then region label with "Unassigned region" last, then polygon
  // id, with `udr_id` as the tiebreak (D21). Sub Totals and per-type totals are
  // summed in SQL, never in JS (General rule 6).
  async listCapacityDetailForInvoice(
    db: Database,
    { limit, ...scope }: CapacityDetailScope & { limit: number },
  ): Promise<CapacityDetailResult> {
    const [countRow] = await db.execute<{ row_count: number }>(sql`
      SELECT count(*)::int AS row_count ${capacityDetailSource(scope)}`);
    const rowCount = countRow?.row_count ?? 0;
    if (rowCount > limit) {
      return { overLimit: true, rowCount };
    }

    const rows = await db.execute<{
      udr_id: string;
      offering_id: string;
      label: string;
      region_label: string;
      polygon_start_date: string;
      polygon_id: string | null;
      resource_ok: boolean;
      capacity_mbps: string;
      rate_per_mbps: string;
      amount: string;
    }>(sql`
      ${capacityDetailCte(scope)}
      SELECT udr_id, offering_id, label, region_label, polygon_start_date,
             polygon_id, resource_ok, capacity_mbps, rate_per_mbps,
             amount::text AS amount
      FROM r
      ORDER BY label, offering_id, unassigned, region_label, polygon_id, udr_id`);

    const groups = await db.execute<{
      offering_id: string;
      region_label: string | null;
      g_region: number;
      amount: string;
    }>(sql`
      ${capacityDetailCte(scope)}
      SELECT offering_id, region_label,
             grouping(region_label)::int AS g_region,
             sum(amount)::numeric(18,2)::text AS amount
      FROM r
      GROUP BY GROUPING SETS ((offering_id, region_label), (offering_id))`);

    return {
      overLimit: false,
      rows: rows.map((r) => ({
        udrId: r.udr_id,
        offeringId: r.offering_id,
        label: r.label,
        regionLabel: r.region_label,
        polygonStartDate: r.polygon_start_date,
        polygonId: r.polygon_id,
        resourceOk: r.resource_ok,
        capacityMbps: r.capacity_mbps,
        ratePerMbps: r.rate_per_mbps,
        amount: r.amount,
      })),
      groups: groups.map((g) => ({
        offeringId: g.offering_id,
        regionLabel: g.region_label,
        gRegion: g.g_region,
        amount: g.amount,
      })),
    };
  },

  async listClaimedForAccount(
    db: Database,
    billRunId: string,
    billingAccountId: string,
  ): Promise<
    {
      udrId: string;
      udrType: string;
      startDatetime: Date;
      endDatetime: Date;
      udrUsageQuantity: string;
      udrUsageUnit: string;
      udrRatedPrice: string;
      udrCurrency: string;
    }[]
  > {
    return db
      .select({
        udrId: udrRated.udrId,
        udrType: udrRated.udrType,
        startDatetime: udrRated.startDatetime,
        endDatetime: udrRated.endDatetime,
        udrUsageQuantity: udrRated.udrUsageQuantity,
        udrUsageUnit: udrRated.udrUsageUnit,
        udrRatedPrice: udrRated.udrRatedPrice,
        udrCurrency: udrRated.udrCurrency,
      })
      .from(udrRated)
      .where(
        and(
          eq(udrRated.billrunRefId, billRunId),
          eq(udrRated.billrunBanId, billingAccountId),
          inArray(udrRated.status, ["BILL_DRAFT", "BILL_APPROVED"]),
        ),
      )
      .orderBy(udrRated.startDatetime);
  },

  // bm28 code-review fix (#2/#3/#5) — the udr_rated drill-down scoped to ONE
  // customer_bill_line's grain: (product_offering_id, udr_type). The line grain
  // is (product_offering_id, udr_type) rolled across subscriptions, but a
  // udr_rated row carries no offering column — offering is only reachable via
  // udr_subscription_ref_id -> inventory.product_inventory.product_offering_id.
  // So this joins that hop and filters on the resolved offering (plus udr_type),
  // returning exactly the records that rolled into THAT line — never the whole
  // account's rows (which, since all bm28 usage is RAN_USAGE, would merge every
  // offering's records under every line and never reconcile to a line's
  // udr_count/net_amount). `app_runtime` holds SELECT on
  // `inventory.product_inventory` (bootstrap-db-roles.sql), and this file stays
  // read-only, so the billing-rating-write-boundary guardrail is unaffected.
  // Scoped to the two live claimed statuses (BILL_DRAFT pre-approval,
  // BILL_APPROVED after) — a prior attempt's rows, released to RATED on rerun
  // (bm24), never match, so no explicit attempt filter is needed.
  async listClaimedForLine(
    db: Database,
    billRunId: string,
    billingAccountId: string,
    productOfferingId: string,
    udrType: string,
  ): Promise<
    {
      udrId: string;
      udrType: string;
      startDatetime: Date;
      endDatetime: Date;
      udrUsageQuantity: string;
      udrUsageUnit: string;
      udrRatedPrice: string;
      udrCurrency: string;
    }[]
  > {
    return db
      .select({
        udrId: udrRated.udrId,
        udrType: udrRated.udrType,
        startDatetime: udrRated.startDatetime,
        endDatetime: udrRated.endDatetime,
        udrUsageQuantity: udrRated.udrUsageQuantity,
        udrUsageUnit: udrRated.udrUsageUnit,
        udrRatedPrice: udrRated.udrRatedPrice,
        udrCurrency: udrRated.udrCurrency,
      })
      .from(udrRated)
      .innerJoin(
        productInventory,
        eq(productInventory.productInventoryId, udrRated.udrSubscriptionRefId),
      )
      .where(
        and(
          eq(udrRated.billrunRefId, billRunId),
          eq(udrRated.billrunBanId, billingAccountId),
          eq(productInventory.productOfferingId, productOfferingId),
          eq(udrRated.udrType, udrType),
          inArray(udrRated.status, ["BILL_DRAFT", "BILL_APPROVED"]),
        ),
      )
      .orderBy(udrRated.startDatetime);
  },

  // bm32-spec §Implementation §2 — the per-record exception surface read
  // (READ-ONLY, Info family). One query over the run's window (see
  // `windowConditions`) returning two "things not on the bill":
  //   • BILL_NOTUSED — a rated usage row Rating marked not-to-bill
  //     (`status = 'BILL_NOTUSED'`). NOTE the deliberate absence of an
  //     `is_live` filter on this arm: `udr_rated.is_live` is a GENERATED column
  //     that is TRUE only for `RATED`/`BILL_DRAFT`/`BILL_APPROVED` and NULL for
  //     every other status (see the schema), so `BILL_NOTUSED` rows carry
  //     `is_live = NULL` — filtering on it would drop every one of them,
  //     contradicting the spec's intent and Inv #25/guardrail #29.
  //   • ORPHAN — an unclaimed live `RATED` `RAN_USAGE` row Collection left
  //     behind (`orphanConditions()`; both resolvable and unresolvable orphans
  //     are returned — the surface never filters silently, Inv #25).
  // `kind` is derived in SQL so a single scan of the windowed partitions serves
  // both. The `LEFT JOIN` `udr_subscription_ref_id → inventory.product_inventory →
  // billing.billing_account` resolves the account name — NULL when the subscriber
  // resolves to no inventory row (an unresolvable orphan, shown by
  // `subscriberRef`). Ordered by `(subscriberRef, startDatetime, udrId)` — the
  // `udrId` PK tiebreak keeps batch-rated rows sharing a timestamp deterministic.
  // `app_runtime` holds SELECT on `rating.*`, `inventory.product_inventory` and
  // `billing.*` (architecture §4), and this file stays read-only (no `rating.*`
  // write), so the `billing-rating-write-boundary` guardrail is unaffected.
  async listExceptionsForWindow(
    db: Database,
    window: ExceptionWindow,
  ): Promise<
    {
      kind: ExceptionKind;
      subscriberRef: string;
      accountName: string | null;
      udrType: string;
      quantity: string;
      unit: string;
      ratedPrice: string;
      currency: string;
    }[]
  > {
    return db
      .select({
        kind: sql<ExceptionKind>`CASE WHEN ${udrRated.status} = 'BILL_NOTUSED' THEN 'BILL_NOTUSED' ELSE 'ORPHAN' END`,
        subscriberRef: udrRated.udrSubscriptionRefId,
        accountName: billingAccount.name,
        udrType: udrRated.udrType,
        quantity: udrRated.udrUsageQuantity,
        unit: udrRated.udrUsageUnit,
        ratedPrice: udrRated.udrRatedPrice,
        currency: udrRated.udrCurrency,
      })
      .from(udrRated)
      .leftJoin(
        productInventory,
        eq(productInventory.productInventoryId, udrRated.udrSubscriptionRefId),
      )
      .leftJoin(
        billingAccount,
        eq(billingAccount.billingAccountId, productInventory.billingAccountId),
      )
      .where(
        and(
          ...windowConditions(window),
          or(eq(udrRated.status, "BILL_NOTUSED"), and(...orphanConditions())),
        ),
      )
      .orderBy(
        udrRated.udrSubscriptionRefId,
        udrRated.startDatetime,
        udrRated.udrId,
      );
  },

  // bm32-spec §Implementation §3 — the informational orphan count for the
  // pre-approval checklist. Counts exactly the ORPHAN set `listExceptionsForWindow`
  // surfaces (same `orphanConditions()` + `windowConditions()`), so the checklist
  // count equals what the operator sees there. Never blocks approval (the check
  // is informational). NOTE (bm32 review #6): no index covers this predicate
  // (`udr_rated_orphan_idx` is `WHERE is_live IS NULL`, the opposite), so this is
  // a scan — but window-scoping prunes it to the ≤2 relevant partitions and the
  // value is purely informational; a covering partial index is a future migration
  // if this ever becomes hot (bm32 is read-only, no schema change).
  async countOrphansForWindow(
    db: Database,
    window: ExceptionWindow,
  ): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(udrRated)
      .where(and(...windowConditions(window), ...orphanConditions()));
    return row?.count ?? 0;
  },
};
