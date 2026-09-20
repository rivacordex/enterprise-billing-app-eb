import { db } from "@/db/client";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";

// pm43-spec I6/I7. The blocked-state display read for Manage Products: how many
// subscriptions still bill from a version, so RetireOfferingDialog can state the
// number without a second query. It reuses the single home of the gate predicate
// (`countLiveForOfferingForUpdate`, code-standards §6.15) rather than restating
// it — the only way to keep the predicate in exactly one place while still
// giving the page a count. Called with the base `db` (not a transaction), so the
// FOR UPDATE lock is held only for the duration of this one autocommit
// statement; the authoritative gate is still `retireOffering`'s own locked
// re-check (D4). The page runs this for an OBSOLETE selection only (I7).
export async function getLiveSubscriptionCount(
  offeringId: string,
): Promise<number> {
  return productInventoryRepository.countLiveForOfferingForUpdate(
    db,
    offeringId,
  );
}
