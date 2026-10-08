import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billingAccount } from "@/db/schema/billing/accounts";
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
// bm49-spec §Implementation §1 — the R9 home of the invoice usage-annex read
// (workflow rules §6.1: this file stays READ-ONLY; the usage-row read lands
// here as a read). `listBilledUsageForInvoice` reads geo straight off the
// claimed `udr_rated` rows (`state`/`district`, bm48) with no ratecard query.
// It is built with the Drizzle query builder + schema-object `sql` fragments
// (never a literal schema-qualified table reference), so the
// `billing-rating-write-boundary` guardrail's write-surface scan stays clean —
// every statement here is a plain `SELECT`.

// bm49-spec §Design D5 — one billed usage row (all `::text`). `cell` is the RAN
// polygon (`polygon_id=` from `udr_key`) or the raw key; `startDate` is the
// row's calendar day in the app timezone. `state`/`district` drive grouping.
export interface BilledUsageRowRaw {
  startDate: string;
  cell: string;
  udrType: string;
  quantity: string;
  unit: string;
  amount: string;
  state: string | null;
  district: string | null;
}

// bm49-spec §Design D5 — one GROUPING SETS row: a district subtotal
// (`gState=0,gDistrict=0`), a state subtotal (`gState=0,gDistrict=1`) or the
// grand total (`gState=1`). `GROUPING()` disambiguates a real `state IS NULL`
// ("Unassigned region") row from a rolled-up grouping-set row. `quantity`/
// `unit` are set only when the group has a single unit (volume is never summed
// across units). `amount` is `null` only for the grand total over zero rows.
export interface BilledUsageGroupRaw {
  state: string | null;
  district: string | null;
  gState: number;
  gDistrict: number;
  rowCount: number;
  amount: string | null;
  quantity: string | null;
  unit: string | null;
}

export type BilledUsageResult =
  | { overLimit: true; rowCount: number }
  | {
      overLimit: false;
      rows: BilledUsageRowRaw[];
      groups: BilledUsageGroupRaw[];
    };

export const ratedLinesRepository = {
  // bm49-spec §Implementation §1 / §Design D2/D3/D5 — count, then rows, then the
  // GROUPING SETS aggregate, all under the bm47 repeatable-read read-only
  // transaction the binder opens (so rows and lines share one snapshot). D3:
  // `count(*)` first; over `limit` it returns `{ overLimit: true }` and selects
  // nothing (no truncation, no partial annex — the bind fails loud and the
  // account parks). D2 scope: every billed `udr_rated` row for the account on
  // the attempt the bill was built on (`billrun_attempt` makes a rerun's
  // released-and-reclaimed rows unambiguous, Inv #19), both `BILL_DRAFT`
  // (draft) and `BILL_APPROVED` (approved); `BILL_NOTUSED` is excluded (Inv #22,
  // not billed). Covers rows feeding capacity lines AND ordinary USAGE lines.
  async listBilledUsageForInvoice(
    db: Database,
    {
      runId,
      banId,
      attempt,
      timezone,
      limit,
    }: {
      runId: string;
      banId: string;
      attempt: number;
      timezone: string;
      limit: number;
    },
  ): Promise<BilledUsageResult> {
    const scope = and(
      eq(udrRated.billrunRefId, runId),
      eq(udrRated.billrunBanId, banId),
      eq(udrRated.billrunAttempt, attempt),
      inArray(udrRated.status, ["BILL_DRAFT", "BILL_APPROVED"]),
    );

    // D3 — bound first.
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(udrRated)
      .where(scope);
    const rowCount = countRow?.count ?? 0;
    if (rowCount > limit) {
      return { overLimit: true, rowCount };
    }

    // D5 — rows (deterministic order: state/district NULLS LAST, then the
    // record's start and `udr_id` PK tiebreak).
    const rows = await db
      .select({
        startDate: sql<string>`(${udrRated.startDatetime} AT TIME ZONE ${timezone})::date::text`,
        cell: sql<string>`COALESCE(substring(${udrRated.udrKey} FROM 'polygon_id=([^|]*)'), ${udrRated.udrKey})`,
        udrType: udrRated.udrType,
        quantity: sql<string>`${udrRated.udrUsageQuantity}::text`,
        unit: udrRated.udrUsageUnit,
        amount: sql<string>`${udrRated.udrRatedPrice}::text`,
        state: udrRated.state,
        district: udrRated.district,
      })
      .from(udrRated)
      .where(scope)
      .orderBy(
        sql`${udrRated.state} ASC NULLS LAST`,
        sql`${udrRated.district} ASC NULLS LAST`,
        udrRated.startDatetime,
        udrRated.udrId,
      );

    // D5 — subtotals computed IN SQL (never JS): per-district, per-state and
    // grand total in one GROUPING SETS statement. A quantity subtotal prints
    // only when the group has a single unit.
    const groups = await db
      .select({
        state: udrRated.state,
        district: udrRated.district,
        gState: sql<number>`grouping(${udrRated.state})::int`,
        gDistrict: sql<number>`grouping(${udrRated.district})::int`,
        rowCount: sql<number>`count(*)::int`,
        amount: sql<string | null>`sum(${udrRated.udrRatedPrice})::text`,
        quantity: sql<
          string | null
        >`CASE WHEN count(DISTINCT ${udrRated.udrUsageUnit}) = 1 THEN sum(${udrRated.udrUsageQuantity})::text END`,
        unit: sql<
          string | null
        >`CASE WHEN count(DISTINCT ${udrRated.udrUsageUnit}) = 1 THEN min(${udrRated.udrUsageUnit}) END`,
      })
      .from(udrRated)
      .where(scope)
      .groupBy(
        sql`GROUPING SETS ((${udrRated.state}, ${udrRated.district}), (${udrRated.state}), ())`,
      );

    return { overLimit: false, rows, groups };
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
