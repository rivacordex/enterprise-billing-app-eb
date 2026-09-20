import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { LifecycleStatus } from "@/types/product";
import type { TransitionInput } from "@/validation/product/transition.schema";

export type DeleteOfferingResult =
  | {
      ok: true;
      offeringId: string;
      familyId: string;
      familyRemains: boolean;
      specificationsRemoved: number;
      pricesRemoved: number;
    }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | {
      ok: false;
      code: "OFFERING_NOT_DELETABLE";
      lifecycleStatus: LifecycleStatus;
    };

// pm44-spec I2. Discard — hard-delete a never-released version with its specs and
// prices in one transaction, leaving one PRODUCT_OFFERING_DELETED audit row as
// the only survivor (D4).
//
// The guard is the row's CURRENT status being DRAFT or TESTING, and that is
// provably sufficient (D1): a version reaches OBSOLETE or RETIRED only from
// ACTIVE, and nothing returns an ACTIVE version to DRAFT (Inv. #23) — so a row
// that is DRAFT/TESTING today has never been ACTIVE, and no history/audit lookup
// is needed. Nothing can reference a deletable row: ordering/inventory FK an
// offering with ON DELETE restrict and are only ever created against an ACTIVE
// version (D3), and the self-referencing family_offering_id never points at a
// DRAFT/TESTING version (a root with branches has been ACTIVE), so no restrict
// FK can fire — if one ever does it is a genuine invariant breach and the
// transaction fails loudly rather than being worked around.
//
// Deletion is parent-first cascade, NOT explicit child-delete: pm36's trigger
// rejects an explicit child DELETE while a TESTING parent is still present and
// only exempts the cascade path (parent row already gone), so deleting the
// parent and letting pm35's ON DELETE cascade remove the children is the one
// path that works for both DRAFT and TESTING (architecture §3.5, code-standards
// §6.8). The audit counts are therefore captured by counting the children just
// before the parent delete, under the parent's FOR UPDATE lock.
export async function deleteOffering(
  offeringId: string,
  input: TransitionInput,
  actorId: string,
): Promise<DeleteOfferingResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (
      locked.lifecycleStatus !== "DRAFT" &&
      locked.lifecycleStatus !== "TESTING"
    ) {
      return {
        ok: false,
        code: "OFFERING_NOT_DELETABLE",
        lifecycleStatus: locked.lifecycleStatus,
      };
    }

    const specificationsRemoved =
      await productOfferingRepository.countSpecificationsForOffering(
        tx,
        offeringId,
      );
    const pricesRemoved =
      await productOfferingRepository.countPricesForOffering(tx, offeringId);

    const deleted = await productOfferingRepository.deleteOffering(
      tx,
      offeringId,
    );
    if (!deleted) {
      // Unreachable: the row was just read under FOR UPDATE in this transaction.
      throw new Error(
        `deleteOffering: offering ${offeringId} vanished mid-delete`,
      );
    }

    const familyId = deleted.familyOfferingId ?? deleted.productOfferingId;

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_DELETED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      // The only record left after a hard delete (D4): id, name, version, the
      // status it was in, its family, and the child counts removed.
      beforeData: {
        offeringId: deleted.productOfferingId,
        name: deleted.name,
        version: deleted.version,
        lifecycleStatus: deleted.lifecycleStatus,
        familyOfferingId: deleted.familyOfferingId,
        specificationsRemoved,
        pricesRemoved,
        transitionReason,
      },
      afterData: null,
    });

    const familyRemains =
      (await productOfferingRepository.countFamilyVersions(tx, familyId)) > 0;

    return {
      ok: true,
      offeringId,
      familyId,
      familyRemains,
      specificationsRemoved,
      pricesRemoved,
    };
  });
}
