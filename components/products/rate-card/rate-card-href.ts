// pm65 — the one place a `/products/rate-card` URL is built, shared by the
// version table (row-selection links), the row preview (pagination + filter +
// clear) so the two can never drift on param names or defaults. Pure string
// building, no `next/*` — importable from any server component.
//
// Only non-default params are emitted, so the canonical URL of the default view
// is the bare path (`/products/rate-card`), and a link never carries a redundant
// `?page=1` or `?tab=rows`. Selecting a version deliberately omits `page` and
// `q` (a new version starts at page 1 with no filter carried over from the one
// before it).

export const RATE_CARD_PATH = "/products/rate-card";

export interface RateCardHrefParams {
  version?: string | null;
  page?: number;
  q?: string;
  tab?: string;
}

export function buildRateCardHref(params: RateCardHrefParams = {}): string {
  const search = new URLSearchParams();

  if (params.version) search.set("version", params.version);
  if (params.page !== undefined && params.page > 1) {
    search.set("page", String(params.page));
  }
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);
  if (params.tab !== undefined && params.tab !== "rows") {
    search.set("tab", params.tab);
  }

  const query = search.toString();
  return query ? `${RATE_CARD_PATH}?${query}` : RATE_CARD_PATH;
}
