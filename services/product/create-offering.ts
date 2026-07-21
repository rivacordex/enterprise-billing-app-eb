import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { CreateOfferingInput } from "@/validation/product/create-offering.schema";

export interface CreateOfferingResult {
  ok: true;
  offeringId: string;
}

// pm11-spec §3.4. No pre-transaction uniqueness check (Design) — offering
// names are not required to be unique, unlike role names. The insert and its
// `PRODUCT_OFFERING_CREATED` audit row run atomically inside one transaction,
// exactly mirroring createRole's insert+audit pairing.
export async function createOffering(
  input: CreateOfferingInput,
  actorId: string,
): Promise<CreateOfferingResult> {
  const offeringId = await db.transaction(async (tx) => {
    const { offeringId } = await productOfferingRepository.insertOffering(
      tx,
      input,
    );

    await insertAuditEvent(tx, {
      eventType: "PRODUCT_OFFERING_CREATED",
      actorUserId: actorId,
      targetEntity: "PRODUCT_OFFERING",
      targetId: offeringId,
      beforeData: null,
      afterData: {
        name: input.name,
        isSellable: input.isSellable,
        billingOnly: input.billingOnly,
      },
    });

    return offeringId;
  });

  return { ok: true, offeringId };
}
