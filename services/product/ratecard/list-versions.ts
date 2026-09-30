import { db } from "@/db/client";
import { ratecardRepository } from "@/db/repositories/ratecard";
import type { RatecardVersion } from "@/db/schema/product";

// pm65-spec I1 — the version-list read model. Framework-agnostic (no `next/*`,
// §7.2): a page calls it, an action never does. Read-only, and NOT cached
// anywhere — no `unstable_cache`, no `revalidate`, no React `cache()`, no
// module-level store (Inv. #59, §1.44, guardrail 40). The ACTIVE version can
// change at any activation or rollback, so a cached version list would show a
// stale "which version is live" the moment an upload or activation lands.
//
// Lists EVERY version the system has, newest first (DoD: "read every version
// the system has") — `ratecardRepository.listVersions(db, null)` is the whole
// query, ONE unpaged SELECT (the version list is not paged; the row PREVIEW is,
// via getRateCardVersionRows). This is the page's first-render query and it
// fans out to nothing per row (§1.16, §3.23): the uploader/activator columns
// are the stored appuser ids, rendered as-is — resolving them to names would
// need a join this read does not do (pm60 owns the repository surface) or a
// per-row lookup the budget forbids.
export async function listRateCardVersions(): Promise<RatecardVersion[]> {
  return ratecardRepository.listVersions(db, null);
}
