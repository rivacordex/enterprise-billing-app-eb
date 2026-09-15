import { db } from "@/db/client";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import type { RatedLineRow } from "@/types/billing";

// bm28-spec §Design/§Implementation §5 (+ code-review fix #2/#3/#5) — the
// `udr_rated` drill-down read behind a USAGE line's lazily-fetched `<details>`
// disclosure. Scoped to the LINE's grain (`product_offering_id`, `udr_type`) via
// `ratedLinesRepository.listClaimedForLine` (which joins `product_inventory` to
// resolve the offering), so a line's disclosure shows exactly the records that
// rolled into THAT line — not the whole account's claimed rows (which, since all
// bm28 usage is `RAN_USAGE`, would merge every offering's records under every
// line). Fetched only on expand (the caller is a server action driven by the
// disclosure's `onToggle`), never eager. Maps the repository's `Date` timeline
// fields to ISO strings so the shape is a plain, server-action-serialisable
// object.
export async function listRatedLines(
  billRunId: string,
  billingAccountId: string,
  productOfferingId: string,
  udrType: string,
): Promise<RatedLineRow[]> {
  const rows = await ratedLinesRepository.listClaimedForLine(
    db,
    billRunId,
    billingAccountId,
    productOfferingId,
    udrType,
  );
  return rows.map((r) => ({
    udrId: r.udrId,
    udrType: r.udrType,
    startDatetime: r.startDatetime.toISOString(),
    endDatetime: r.endDatetime.toISOString(),
    udrUsageQuantity: r.udrUsageQuantity,
    udrUsageUnit: r.udrUsageUnit,
    udrRatedPrice: r.udrRatedPrice,
    udrCurrency: r.udrCurrency,
  }));
}
