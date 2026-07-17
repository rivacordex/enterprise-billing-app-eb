import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { isUniqueViolation } from "@/lib/db-errors";
import type { UpdateOrganizationInput } from "@/validation/customer/update-organization.schema";

export type UpdateOrganizationResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "ORGANIZATION_NOT_FOUND" }
  | { ok: false; code: "DUPLICATE_REGISTRATION_NUMBER" };

// cm08-spec §2.2/§3.4 — the module's first optimistic-lock mutation.
// `compareAndBumpLock` is called first, inside the transaction, before the
// entity-specific write: a `null` return (stale lock or unknown
// `partyRoleId`) short-circuits to `CONFLICT` without touching
// `organization` — the transaction still commits as a harmless no-op.
export async function updateOrganization(
  input: UpdateOrganizationInput,
  actorId: string,
): Promise<UpdateOrganizationResult> {
  const before = await organizationRepository.findById(
    db,
    input.organizationId,
  );
  if (before === null) return { ok: false, code: "ORGANIZATION_NOT_FOUND" };

  try {
    return await db.transaction(async (tx) => {
      const bumped = await partyRoleRepository.compareAndBumpLock(
        tx,
        input.partyRoleId,
        input.lastModifiedDatetime,
        input.organizationId,
      );
      if (bumped === null) return { ok: false, code: "CONFLICT" };

      const after = await organizationRepository.update(
        tx,
        input.organizationId,
        {
          name: input.name,
          tradingName: input.tradingName,
          organizationType: input.organizationType,
          registrationNumber: input.registrationNumber,
          taxId: input.taxId,
          industry: input.industry,
          lastModifiedBy: actorId,
        },
      );

      await insertAuditEvent(tx, {
        eventType: "ORGANIZATION_UPDATED",
        actorUserId: actorId,
        targetEntity: "ORGANIZATION",
        targetId: input.organizationId,
        beforeData: before,
        afterData: after,
      });

      return { ok: true, value: { lastModifiedDatetime: bumped } };
    });
  } catch (err) {
    if (isUniqueViolation(err, "organization_registration_number_unique")) {
      return { ok: false, code: "DUPLICATE_REGISTRATION_NUMBER" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
