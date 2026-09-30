import { db } from "@/db/client";
import { diffAgainstActive } from "@/services/product/ratecard/diff-versions";
import type { RateCardVersionDiff } from "@/types/product";

// pm66 — a thin read wrapper over pm62's `diffAgainstActive`, added so the PAGE
// can request a diff without importing the `db` client: the `boundaries` rule
// forbids `app → db`, so the page cannot inject the client itself (the same
// reason pm65's list-versions / get-version-rows exist). This adds NO new
// backend logic — it injects `db` into the existing pm62 service and returns
// its result unchanged — and is NOT a mutation (pm66 builds no new mutation;
// the three exist). Uncached (Inv. #59, guardrail 40): the ACTIVE version the
// diff is taken against can change at any activation/rollback.
export async function getRateCardVersionDiff(
  cardName: string,
  versionId: string,
): Promise<RateCardVersionDiff> {
  return diffAgainstActive(db, cardName, versionId);
}
