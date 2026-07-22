import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { UpdateOfferingInput } from "@/validation/product/update-offering.schema";

export type UpdateOfferingResult =
  | { ok: true; offeringId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

type OfferingEdit = {
  name: string;
  isSellable: boolean;
  billingOnly: boolean;
};

// pm13-spec §3.4. Clones into a new sibling DRAFT and writes
// PRODUCT_OFFERING_BRANCHED — shared by the ACTIVE-target path and the
// saveAsNew-on-DRAFT path (Design), which differ only in *why* they got
// here, not in what they do once they have.
async function branchAndAudit(
  offeringId: string,
  current: { name: string; isSellable: boolean; billingOnly: boolean },
  edit: OfferingEdit,
  actorId: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const { offeringId: branchedId } =
      await productOfferingRepository.branchOfferingAsDraft(
        tx,
        offeringId,
        edit,
      );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_BRANCHED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: branchedId,
      beforeData: { sourceOfferingId: offeringId, ...current },
      afterData: { sourceOfferingId: offeringId, ...edit },
    });

    return branchedId;
  });
}

export async function updateOffering(
  offeringId: string,
  input: UpdateOfferingInput,
  actorId: string,
): Promise<UpdateOfferingResult> {
  const current = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!current) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (current.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  const edit: OfferingEdit = {
    name: input.name,
    isSellable: input.isSellable,
    billingOnly: input.billingOnly,
  };
  const before: OfferingEdit = {
    name: current.name,
    isSellable: current.isSellable,
    billingOnly: current.billingOnly,
  };

  if (current.lifecycleStatus === "ACTIVE") {
    const branchedId = await branchAndAudit(offeringId, before, edit, actorId);
    return { ok: true, offeringId: branchedId, branched: true };
  }

  // current.lifecycleStatus === "DRAFT" from here on.
  if (input.saveAsNew) {
    const branchedId = await branchAndAudit(offeringId, before, edit, actorId);
    return { ok: true, offeringId: branchedId, branched: true };
  }

  const unchanged =
    before.name === edit.name &&
    before.isSellable === edit.isSellable &&
    before.billingOnly === edit.billingOnly;
  if (unchanged) {
    return { ok: true, offeringId, branched: false };
  }

  await db.transaction(async (tx) => {
    await productOfferingRepository.updateOfferingDraftInPlace(tx, offeringId, {
      ...edit,
      lastEditedBy: actorId,
    });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_UPDATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: before,
      afterData: edit,
    });
  });

  return { ok: true, offeringId, branched: false };
}
