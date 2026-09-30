import { db } from "@/db/client";
import { ratecardRepository } from "@/db/repositories/ratecard";
import type { VersionRowsPage } from "@/db/repositories/ratecard";

// pm65-spec I1 — the row-preview read model. Framework-agnostic (§7.2),
// read-only, and NOT cached (Inv. #59, §1.44, guardrail 40) for the same reason
// as list-versions.ts: an activation or a re-upload changes what a version's
// rows are (a superseded version keeps its rows; a re-uploaded draft replaces
// them), so a cached page would report a version that no longer exists.
//
// Paged and filterable so 5,400 rows never render at once (§10.7): the
// repository's `getVersionRows` issues exactly a COUNT + a paged SELECT — "one
// paged rows query plus its count" (§3.23). The filter is a free-text preview
// convenience matched across the key columns and the subscriber reference; a
// whitespace-only filter is treated as no filter (the repository trims).

// A fixed preview page size — big enough to be useful on a ~5,400-row version,
// small enough that a single page is never the whole file. Declared once here
// (not runtime-configurable): unlike the offering list's tunable size, the row
// preview has no configuration surface and needs none.
export const RATE_CARD_ROW_PREVIEW_PAGE_SIZE = 50;

export interface RateCardVersionRowsPage extends VersionRowsPage {
  page: number;
  pageSize: number;
}

export async function getRateCardVersionRows(
  versionId: string,
  options: { page: number; filter?: string },
): Promise<RateCardVersionRowsPage> {
  const pageSize = RATE_CARD_ROW_PREVIEW_PAGE_SIZE;
  const { rows, total } = await ratecardRepository.getVersionRows(
    db,
    versionId,
    {
      limit: pageSize,
      offset: (options.page - 1) * pageSize,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    },
  );
  return { rows, total, page: options.page, pageSize };
}
