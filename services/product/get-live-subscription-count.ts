import { db } from "@/db/client";
import { productInventoryRepository } from "@/db/repositories/inventory/product-inventory.repository";

// pm43-spec I6/I7 (pm44 review). The blocked-state display read for Manage
// Products: how many subscriptions still bill from a version, so
// RetireOfferingDialog can state the number without a second query. Uses the
// NON-locking `countLiveForOffering` — a read-only page render must not take
// FOR UPDATE row locks on the inventory hot table. Both counts share one
// predicate (`liveSubscriptionWhere`), so §6.15's "predicate in one place" holds;
// the authoritative gate is still `retireOffering`'s own locked re-check (D4), so
// a stale display count only ever fails safe. The page runs this for an OBSOLETE
// selection only (I7).
export async function getLiveSubscriptionCount(
  offeringId: string,
): Promise<number> {
  return productInventoryRepository.countLiveForOffering(db, offeringId);
}
