import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
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
};
