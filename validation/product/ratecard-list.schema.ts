import { z } from "zod";

// pm65-spec §3.17 / D1 / D4 — the `/products/rate-card` selection state, parsed
// and NEVER trusted (code-standards §3.3/§3.17): a tampered or stale URL renders
// defaults, never a 500. Lenient by design, exactly like `family-list.schema.ts`
// (every field `.catch()`-defaults).
//
// The admitted params are `version`, `page`, `q` and `tab`:
//   - `version` — an `RCV########` id, parsed against its format schema (the
//     same one every mutation action reuses, ratecard.schema.ts). A value that
//     is malformed degrades to `null`; a well-formed value that matches no row
//     renders the empty-selection state at the page, not a 404 (§3.17, test 4).
//   - `page` — the row-preview page (1-based), coerced, min 1, default 1.
//   - `q` — the row-preview free-text filter (D9/D10, §10.7). It is the param
//     behind the "paged and FILTERABLE" preview and the "No rows match \"<q>\""
//     empty state; the preview is a server component (§3.6) with no client
//     store (§3.17), so the filter can only live in the URL. §3.11 enumerates
//     "version and page" as the SELECTION params — this filter `q` (analogous
//     to the list `q` the other product pages already carry) is the preview's
//     own filter, mandated by pm65 §10.7/D10; the enumeration predates that
//     requirement and is read to include it (flagged in the tracker rather than
//     silently widened).
//   - `tab` — the third selection param admitted by C3 (pm65 D4). The whole
//     argument for it is the QUERY BUDGET (§3.23): the diff costs two full row
//     reads, so the diff view must be requestable via the URL rather than
//     computed on every load. The closed union falls back to `rows`; an unknown
//     value is ignored, never a 404 (§3.17, test 5). pm65 renders only the
//     `rows` view — the diff and validation views (and the diff read) are
//     pm66's, which inherits this parsed param.
export const RATE_CARD_TABS = ["rows", "diff", "validation"] as const;
export type RateCardTab = (typeof RATE_CARD_TABS)[number];

// A nullable `RCV########` version-id searchParam (selection state) — the
// rate-card analogue of `offeringIdParam`. Same shape as ratecard.schema.ts's
// `ratecardVersionIdSchema`, restated here `.nullable().catch(null)` so a bad
// value degrades to null rather than throwing (the action-side schema stays
// strict, because an action must refuse a malformed id, not default it).
export const ratecardVersionIdParam = z
  .string()
  .regex(/^RCV\d{8}$/)
  .nullable()
  .catch(null);

export const rateCardListSearchParamsSchema = z.object({
  version: ratecardVersionIdParam,
  page: z.coerce.number().int().min(1).catch(1),
  q: z.string().trim().max(100).catch(""),
  tab: z.enum(RATE_CARD_TABS).catch("rows"),
});
export type RateCardListSearchParams = z.infer<
  typeof rateCardListSearchParamsSchema
>;
