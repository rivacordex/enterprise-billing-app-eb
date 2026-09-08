import { and, eq, inArray, sql } from "drizzle-orm";

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
