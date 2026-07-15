import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { parseSpecificationInput } from "@/validation/customer/specification.schema";
import type { UpdatePartyRoleSpecificationInput } from "@/validation/customer/update-party-role-specification.schema";

export type UpdatePartyRoleSpecificationResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_SPECIFICATION" };

// cm10-spec §3.3 — mirrors `transitionCustomerStatus` exactly, substituting
// `parseSpecificationInput` for the transition-map check and
// `PARTY_ROLE_SPECIFICATION_UPDATED` for the audit event type. Writes no
// `status_reason`-style field and needs no reason at all — a specification
// edit isn't a lifecycle transition (Module Inv. #2 is scoped to "every
// transition"). `compareAndUpdateSpecification` is the same same-row
// compare-and-write shortcut as `compareAndUpdateStatus`.
export async function updatePartyRoleSpecification(
  input: UpdatePartyRoleSpecificationInput,
  actorId: string,
): Promise<UpdatePartyRoleSpecificationResult> {
  const before = await partyRoleRepository.findById(db, input.partyRoleId);
  if (before === null) return { ok: false, code: "PARTY_ROLE_NOT_FOUND" };

  const specResult = parseSpecificationInput(input.specificationRaw);
  if (!specResult.ok) return { ok: false, code: "INVALID_SPECIFICATION" };

  return db.transaction(async (tx) => {
    const after = await partyRoleRepository.compareAndUpdateSpecification(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
      {
        partyRoleSpecification: specResult.value,
        lastModifiedBy: actorId,
      },
    );
    if (after === null) return { ok: false, code: "CONFLICT" };

    await insertAuditEvent(tx, {
      eventType: "PARTY_ROLE_SPECIFICATION_UPDATED",
      actorUserId: actorId,
      targetEntity: "PARTY_ROLE",
      targetId: input.partyRoleId,
      beforeData: { partyRoleSpecification: before.partyRoleSpecification },
      afterData: { partyRoleSpecification: after.partyRoleSpecification },
    });

    return {
      ok: true,
      value: { lastModifiedDatetime: after.lastModifiedDatetime },
    };
  });
}
