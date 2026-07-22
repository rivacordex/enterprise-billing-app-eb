import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { CreateSpecificationInput } from "@/validation/product/create-specification.schema";

export type AddSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" };

// pm14-spec §3.5. Branch-first when the target offering is ACTIVE (Design);
// a create never needs to "locate a counterpart" the way update/delete do,
// since it is adding new content rather than acting on existing content.
export async function addSpecification(
  offeringId: string,
  input: CreateSpecificationInput,
  actorId: string,
): Promise<AddSpecificationResult> {
  const offering = await productOfferingRepository.findDetailById(
    db,
    offeringId,
  );
  if (!offering) {
    return { ok: false, code: "OFFERING_NOT_FOUND" };
  }
  if (offering.lifecycleStatus === "RETIRED") {
    return { ok: false, code: "OFFERING_RETIRED" };
  }

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;
    }

    const { productSpecId } =
      await productSpecificationRepository.insertSpecification(tx, {
        refProductOfferingId: targetOfferingId,
        name: input.name,
        isMandatory: input.isMandatory,
        isDefault: input.isDefault,
        defaultValue: input.defaultValue,
        productSpecCharacteristics: input.productSpecCharacteristics,
      });

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_CREATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: productSpecId,
      beforeData: null,
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        name: input.name,
        isMandatory: input.isMandatory,
        isDefault: input.isDefault,
        defaultValue: input.defaultValue,
        productSpecCharacteristics: input.productSpecCharacteristics,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId,
      branched,
    };
  });
}
