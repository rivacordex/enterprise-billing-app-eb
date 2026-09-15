import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";

// bm18-spec §Implementation §2 step 1 — the draft-invoice renderer's read of
// the account's claimed charge lines. `app_runtime` holds SELECT on
// `rating.*` (architecture §4); this is a plain read, not the app's claim
// write (that single `UPDATE` stays isolated in
// `db/repositories/billing/udr-status.repository.ts`, architecture Inv. #2).
// Scoped to `BILL_DRAFT`/`BILL_APPROVED` — the two claimed, still-live
// statuses a pre-posting or just-approved draft can show; `REJECTED`/
// `SUPERSEDED`/`BILL_NOTUSED` rows are never billed and must never appear as
// a line item.
export const ratedLinesRepository = {
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
  // udr_subscriber_ref_id -> inventory.product_inventory.product_offering_id.
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
        eq(productInventory.productInventoryId, udrRated.udrSubscriberRefId),
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

  // bm19-spec §Design "Posting reads real udr_rated (Inv #3)" — the real
  // charge_checksum anchor: `md5(string_agg(udr_rated_id || ':' || amount
  // ORDER BY udr_rated_id))` over the account's claimed rows for this exact
  // `(run, ban, posted_attempt)` — computed ENTIRELY in SQL (code-standards
  // §2.4 — never reformatted in TS, or the tamper-evidence breaks). No
  // claimed rows ⇒ an empty `string_agg` (COALESCE), not NULL-poisoning the
  // whole hash. Deliberately kept in THIS file rather than
  // `customer-bill.repository.ts` (which writes other tables elsewhere) —
  // the billing-rating-write-boundary guardrail treats any file that both
  // touches the rating schema and writes anywhere as suspect, independent
  // of which table the write targets; this file stays entirely read-only,
  // the same sanctioned-read shape as the claimed-lines lookup above.
  async computeChargeChecksum(
    tx: Database,
    billRunId: string,
    billingAccountId: string,
    postedAttempt: number,
  ): Promise<string> {
    const [row] = await tx
      .select({
        checksum: sql<string>`md5(COALESCE(string_agg(${udrRated.udrId}::text || ':' || ${udrRated.udrRatedPrice}::text, ',' ORDER BY ${udrRated.udrId}), ''))`,
      })
      .from(udrRated)
      .where(
        and(
          eq(udrRated.billrunRefId, billRunId),
          eq(udrRated.billrunBanId, billingAccountId),
          eq(udrRated.billrunAttempt, postedAttempt),
        ),
      );
    if (!row) {
      throw new Error(
        `computeChargeChecksum: no result for run ${billRunId} / account ${billingAccountId} / attempt ${postedAttempt}`,
      );
    }
    return row.checksum;
  },
};
