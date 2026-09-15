import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productInventory } from "@/db/schema/inventory";
import { udrRated } from "@/db/schema/rating/udr-rated";

// bm18-spec §Implementation §2 step 1 — a READ-ONLY drill-down repository over
// the account's claimed `udr_rated` charge lines, for the `BILL_DRAFT`/
// `BILL_APPROVED` `BillLineTable` drill-down (`listClaimedForAccount`,
// `listClaimedForLine`). `app_runtime` holds SELECT on `rating.*`
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
};
