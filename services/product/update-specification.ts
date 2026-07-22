import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { SpecificationCard } from "@/types/product";
import type { UpdateSpecificationInput } from "@/validation/product/update-specification.schema";

export type UpdateSpecificationResult =
  | { ok: true; offeringId: string; productSpecId: string; branched: boolean }
  | { ok: false; code: "OFFERING_NOT_FOUND" }
  | { ok: false; code: "OFFERING_RETIRED" }
  | { ok: false; code: "SPECIFICATION_NOT_FOUND" };

// Shallow equality over a flat string record — productSpecCharacteristics
// is always Record<string, string> (product-spec-characteristics.schema.ts),
// so this is exact, not approximate.
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

// pm14-spec §2 ("locate the cloned counterpart"). branchOfferingAsDraft
// clones every specification field byte-identical with a fresh id
// (pm12-spec §5) — matching on full content against candidates from the
// SAME branch call is exact unless the source offering has two
// specifications with genuinely identical content (disclosed gap, Design).
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

export async function updateSpecification(
  specId: string,
  offeringId: string,
  input: UpdateSpecificationInput,
  actorId: string,
): Promise<UpdateSpecificationResult> {
  return db.transaction(async (tx) => {
    const offering = await productOfferingRepository.findDetailById(
      tx,
      offeringId,
    );
    if (!offering) {
      return { ok: false, code: "OFFERING_NOT_FOUND" };
    }
    if (offering.lifecycleStatus === "RETIRED") {
      return { ok: false, code: "OFFERING_RETIRED" };
    }

    const specs = await productSpecificationRepository.findByOfferingId(
      tx,
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
    const after = {
      name: input.name,
      isMandatory: input.isMandatory,
      isDefault: input.isDefault,
      defaultValue: input.defaultValue,
      productSpecCharacteristics: input.productSpecCharacteristics,
    };

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

    await productSpecificationRepository.updateSpecification(
      tx,
      targetSpecId,
      targetOfferingId,
      {
        name: input.name,
        isMandatory: input.isMandatory,
        isDefault: input.isDefault,
        defaultValue: input.defaultValue,
        productSpecCharacteristics: input.productSpecCharacteristics,
      },
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_SPECIFICATION_UPDATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_SPECIFICATION",
      targetId: targetSpecId,
      beforeData: { offeringId: targetOfferingId, ...before },
      afterData: {
        offeringId: targetOfferingId,
        ...(branched ? { branchedFromOfferingId: offeringId } : {}),
        ...after,
      },
    });

    return {
      ok: true,
      offeringId: targetOfferingId,
      productSpecId: targetSpecId,
      branched,
    };
  });
}
