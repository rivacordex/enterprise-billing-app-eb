import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { OrganizationStatus } from "@/types/customer";
import { ORGANIZATION_TRANSITIONS } from "@/validation/customer/transitions";
import type { TransitionOrganizationStatusInput } from "@/validation/customer/transition-organization-status.schema";

export type TransitionOrganizationStatusResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" };

// cm09-spec §3.3. The transition-edge check is a pure in-memory check
// against the already-loaded `before.status`, run before the transaction
// opens — an invalid edge never needs a DB round trip, let alone a lock
// check. `compareAndBumpLock` (cm08) runs first inside the transaction,
// exactly as `updateOrganization` does; a `null` short-circuits to
// `CONFLICT` before the status write or audit ever run.
export async function transitionOrganizationStatus(
  input: TransitionOrganizationStatusInput,
  actorId: string,
): Promise<TransitionOrganizationStatusResult> {
  const before = await organizationRepository.findById(
    db,
    input.organizationId,
  );
  if (before === null) return { ok: false, code: "ORGANIZATION_NOT_FOUND" };

  const allowed = ORGANIZATION_TRANSITIONS[before.status as OrganizationStatus];
  if (!allowed.includes(input.targetStatus)) {
    return { ok: false, code: "INVALID_TRANSITION" };
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    const after = await organizationRepository.updateStatus(
      tx,
      input.organizationId,
      {
        status: input.targetStatus,
        statusReason: input.statusReason,
        lastModifiedBy: actorId,
      },
    );

    await insertAuditEvent(tx, {
      eventType: "ORGANIZATION_STATUS_CHANGED",
      actorUserId: actorId,
      targetEntity: "ORGANIZATION",
      targetId: input.organizationId,
      beforeData: { status: before.status, statusReason: before.statusReason },
      afterData: { status: after.status, statusReason: after.statusReason },
    });

    return { ok: true, value: { lastModifiedDatetime: bumped } };
  });
}
