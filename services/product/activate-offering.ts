import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { ActivateOfferingInput } from "@/validation/product/activate-offering.schema";

export type ActivateOfferingResult =
  | { ok: true; offeringId: string; supersededOfferingId: string | null }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_TESTING" };

// pm42-spec I4. TESTING → ACTIVE, superseding the family's previous ACTIVE
// version to OBSOLETE in the same transaction (pm42 D3, Inv. #6). The release
// preconditions (≥ 1 price, specifications resolved) moved one step earlier to
// `submitForTesting` (pm42 D2): a TESTING version's content has been immutable
// since it left DRAFT (pm36 trigger), so it cannot have gone stale and is not
// re-checked here. This re-checks only the version's own status (locked, on
// `tx`, immediately before the write — code-standards §1.13) and the family's
// active slot (via `findActiveInFamily`'s family-wide FOR UPDATE inside the
// repository). Writes exactly one audit event per row changed.
export async function activateOffering(
  offeringId: string,
  input: ActivateOfferingInput,
  actorId: string,
): Promise<ActivateOfferingResult> {
  const transitionReason = input.reason || null;

  return db.transaction(async (tx) => {
    const locked = await productOfferingRepository.findLifecycleStatusForUpdate(
      tx,
      offeringId,
    );
    if (!locked) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "TESTING") {
      return { ok: false, code: "OFFERING_NOT_TESTING" };
    }

    const { offeringId: activatedId, supersededOfferingId } =
      await productOfferingRepository.activateOffering(tx, offeringId, actorId);

    if (supersededOfferingId) {
      await insertAuditEvent(tx, {
        eventType: "PRODUCT_OFFERING_SUPERSEDED",
        actorUserId: actorId,
        targetEntity: "PRODUCT_OFFERING",
        targetId: supersededOfferingId,
        beforeData: { lifecycleStatus: "ACTIVE" },
        afterData: {
          lifecycleStatus: "OBSOLETE",
          supersededByOfferingId: activatedId,
        },
      });
    }

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_ACTIVATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: activatedId,
      beforeData: { lifecycleStatus: "TESTING" },
      afterData: {
        lifecycleStatus: "ACTIVE",
        transitionReason,
      },
    });

    return {
      ok: true,
      offeringId: activatedId,
      supersededOfferingId,
    };
  });
}
