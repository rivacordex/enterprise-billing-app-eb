import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { CustomerStatus } from "@/types/customer";
import { CUSTOMER_TRANSITIONS } from "@/validation/customer/transitions";
import type { TransitionCustomerStatusInput } from "@/validation/customer/transition-customer-status.schema";

export type TransitionCustomerStatusResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "INVALID_TRANSITION" };

// cm10-spec §3.3, mirroring `transitionOrganizationStatus` (cm09). The
// transition-edge check runs in-memory against the already-loaded
// `before.status` before the transaction opens. Unlike cm09, the lock
// column and the data being written live on the same row (`party_role`),
// so `compareAndUpdateStatus` (cm10-spec §2.2) collapses the compare-check
// and the status write into one atomic `UPDATE` — no separate
// `compareAndBumpLock` call followed by a second write against the row
// that was just touched.
export async function transitionCustomerStatus(
  input: TransitionCustomerStatusInput,
  actorId: string,
): Promise<TransitionCustomerStatusResult> {
  const before = await partyRoleRepository.findById(db, input.partyRoleId);
  if (before === null) return { ok: false, code: "PARTY_ROLE_NOT_FOUND" };

  const allowed = CUSTOMER_TRANSITIONS[before.status as CustomerStatus];
  if (!allowed.includes(input.targetStatus)) {
    return { ok: false, code: "INVALID_TRANSITION" };
  }

  return db.transaction(async (tx) => {
    const after = await partyRoleRepository.compareAndUpdateStatus(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
      {
        status: input.targetStatus,
        statusReason: input.statusReason,
        lastModifiedBy: actorId,
      },
    );
    if (after === null) return { ok: false, code: "CONFLICT" };

    await insertAuditEvent(tx, {
      eventType: "CUSTOMER_STATUS_CHANGED",
      actorUserId: actorId,
      targetEntity: "PARTY_ROLE",
      targetId: input.partyRoleId,
      beforeData: { status: before.status, statusReason: before.statusReason },
      afterData: { status: after.status, statusReason: after.statusReason },
    });

    return {
      ok: true,
      value: { lastModifiedDatetime: after.lastModifiedDatetime },
    };
  });
}
