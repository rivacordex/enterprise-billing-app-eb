import { asc, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { inventoryStatusHistory } from "@/db/schema/inventory";
import { appuser } from "@/db/schema/identity";
import type {
  InventoryStatusHistory,
  InventoryStatusHistoryInsert,
} from "@/types/inventory";

// Append-only, gap-free transition log (architecture Inv. #18): every status
// an instance ever held is a row; the `status` column is always derivable from
// the latest row. This repository permanently exports no update/delete —
// `insertTransition` + finders and nothing else, asserted structurally by
// tests/db/ordering-repository-exports.test.ts.
export const inventoryStatusHistoryRepository = {
  async insertTransition(
    tx: Database,
    data: InventoryStatusHistoryInsert,
  ): Promise<InventoryStatusHistory> {
    const [row] = await tx
      .insert(inventoryStatusHistory)
      .values(data)
      .returning();
    if (!row) {
      throw new Error("insertTransition: insert returned no row");
    }
    return row;
  },

  // Full transition history for one instance, oldest-to-newest — the creation
  // row (`from_status IS NULL`) first, then each transition in the order it
  // was applied. Consumers derive suspension windows from consecutive rows.
  //
  // Ordered by `inventoryStatusHistoryId` (the insert sequence), never
  // `created_at`: `created_at` defaults to Postgres `now()`, which is fixed
  // at the *transaction's* start, not the statement's. Two concurrent
  // lifecycle transactions on the same instance serialize on the parent row
  // lock (`findByIdForUpdate`), so the one that begins first but waits on the
  // lock can still *insert* its transition after a later-starting winner —
  // giving it an earlier `created_at` than a row that logically came after
  // it. `nextval()` (the id's source) is non-transactional and evaluated at
  // actual statement execution time, so it alone reflects true insert order.
  // Found via the pm32 concurrency test (suspend vs. terminate) — same class
  // of bug as the TOCTOU fixes in pm14/pm15/pm16/pm20 (code-standards §1
  // rule 13), caught here instead by the module's other standing discipline
  // of running real concurrency tests before shipping a lifecycle write path.
  async findByInventoryId(
    db: Database,
    productInventoryId: string,
  ): Promise<InventoryStatusHistory[]> {
    return db
      .select()
      .from(inventoryStatusHistory)
      .where(eq(inventoryStatusHistory.productInventoryId, productInventoryId))
      .orderBy(asc(inventoryStatusHistory.inventoryStatusHistoryId));
  },

  // The most recent transition for one instance (pm32-spec §1 — a new
  // transition's `effective_date` must be ≥ this row's). Called on the
  // caller's already-open, row-locked transaction: the parent instance lock
  // (`findByIdForUpdate`) serializes every lifecycle write path against this
  // instance, so a plain read here — no `FOR UPDATE` of its own — is
  // race-free. Ordered by id, not `created_at` — see `findByInventoryId`.
  async findLatestByInventoryId(
    tx: Database,
    productInventoryId: string,
  ): Promise<InventoryStatusHistory | null> {
    const [row] = await tx
      .select()
      .from(inventoryStatusHistory)
      .where(eq(inventoryStatusHistory.productInventoryId, productInventoryId))
      .orderBy(desc(inventoryStatusHistory.inventoryStatusHistoryId))
      .limit(1);
    return row ?? null;
  },

  // Full transition history with the actor's display name resolved (backs
  // `getSubscriptionDetail`'s `StatusHistoryEntry[]`) — same ordering as
  // `findByInventoryId`.
  async findByInventoryIdWithChangedByName(
    db: Database,
    productInventoryId: string,
  ): Promise<Array<InventoryStatusHistory & { changedByName: string }>> {
    return db
      .select({
        inventoryStatusHistoryId:
          inventoryStatusHistory.inventoryStatusHistoryId,
        productInventoryId: inventoryStatusHistory.productInventoryId,
        fromStatus: inventoryStatusHistory.fromStatus,
        toStatus: inventoryStatusHistory.toStatus,
        effectiveDate: inventoryStatusHistory.effectiveDate,
        reason: inventoryStatusHistory.reason,
        changedBy: inventoryStatusHistory.changedBy,
        changedByName: appuser.userName,
        createdAt: inventoryStatusHistory.createdAt,
      })
      .from(inventoryStatusHistory)
      .innerJoin(appuser, eq(appuser.id, inventoryStatusHistory.changedBy))
      .where(eq(inventoryStatusHistory.productInventoryId, productInventoryId))
      .orderBy(asc(inventoryStatusHistory.inventoryStatusHistoryId));
  },
};
