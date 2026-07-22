import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { SpecificationCard } from "@/types/product";

export type DeleteSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };

// Duplicated from update-specification.ts rather than shared (Design,
// §2) — two call sites, same judgment call pm12-spec made for
// resolveFamilyRootId.
function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
  );
}

function findClonedCounterpart(
  target: SpecificationCard,
  candidates: SpecificationCard[],
): SpecificationCard {
  const matches = candidates.filter(
    (candidate) =>
      candidate.name === target.name &&
      candidate.isMandatory === target.isMandatory &&
      candidate.isDefault === target.isDefault &&
      candidate.defaultValue === target.defaultValue &&
      recordsEqual(candidate.characteristics, target.characteristics),
  );
  if (matches.length !== 1) {
    throw new Error(
      `findClonedCounterpart: expected exactly one cloned match for specification ${target.productSpecId}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

// pm14-spec §2/§3.7. By the time `productSpecificationRepository
// .deleteSpecification` is actually called, its target always belongs to a
// DRAFT offering — either the original (direct path) or the freshly
// branched clone (ACTIVE path) — never the ACTIVE row itself. This is what
// makes guardrail 10 ("Spec-delete unreachable on ACTIVE") true by
// construction (Design).
export async function deleteSpecification(
  specId: string,
  offeringId: string,
  actorId: string,
): Promise<DeleteSpecificationResult> {
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

  const specs = await productSpecificationRepository.findByOfferingId(
    db,
    offeringId,
  );
  const current = specs.find((spec) => spec.productSpecId === specId);
  if (!current) {
    return { ok: false, code: "SPECIFICATION_NOT_FOUND" };
  }

  const before = {
    name: current.name,
    isMandatory: current.isMandatory,
    isDefault: current.isDefault,
    defaultValue: current.defaultValue,
    productSpecCharacteristics: current.characteristics,
  };

  return db.transaction(async (tx) => {
    let targetOfferingId = offeringId;
    let targetSpecId = specId;
    let branched = false;

    if (offering.lifecycleStatus === "ACTIVE") {
      const { offeringId: branchedId } =
        await productOfferingRepository.branchOfferingAsDraft(tx, offeringId);
      targetOfferingId = branchedId;
      branched = true;

      const clonedSpecs = await productSpecificationRepository.findByOfferingId(
        tx,
        branchedId,
      );
      targetSpecId = findClonedCounterpart(current, clonedSpecs).productSpecId;
    }

    await productSpecificationRepository.deleteSpecification(tx, targetSpecId);

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_DELETED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: targetSpecId,
      beforeData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...before,
      },
      afterData: null,
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId: targetSpecId,
      branched,
    };
  });
}
