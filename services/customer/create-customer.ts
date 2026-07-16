import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { isUniqueViolation } from "@/lib/db-errors";
import { parseSpecificationInput } from "@/validation/customer/specification.schema";
import type { CreateCustomerInput } from "@/validation/customer/create-customer.schema";

export type CreateCustomerResult =
  | { ok: true; value: { organizationId: string; partyRoleId: string } }
  | { ok: false; code: "INVALID_SPECIFICATION" }
  | { ok: false; code: "DUPLICATE_REGISTRATION_NUMBER" }
  | { ok: false; code: "SIMILAR_NAMES_FOUND"; similarNames: string[] };

// cm07-spec §2.1–§2.3, §3.4. First mutation in the module, establishing the
// action → service → repository shape for cm07–cm15.
//
// The similar-name check (§2.2) is a two-step confirm: `confirmed: false`
// checks for matches before inserting anything — a match returns
// `SIMILAR_NAMES_FOUND` with nothing written; `confirmed: true` (either no
// matches existed, or the user proceeded past the warning) skips the check
// entirely. The `registration_number` uniqueness check is never skippable —
// it's a real DB constraint, caught via `isUniqueViolation` on every
// submission regardless of `confirmed`.
export async function createCustomer(
  input: CreateCustomerInput,
  actorId: string,
): Promise<CreateCustomerResult> {
  const specResult = parseSpecificationInput(input.specificationRaw);
  if (!specResult.ok) {
    return { ok: false, code: "INVALID_SPECIFICATION" };
  }

  if (!input.confirmed) {
    const similarNames = await organizationRepository.findSimilarNames(
      db,
      input.name,
      null,
    );
    if (similarNames.length > 0) {
      return { ok: false, code: "SIMILAR_NAMES_FOUND", similarNames };
    }
  }

  try {
    return await db.transaction(async (tx) => {
      const org = await organizationRepository.insert(tx, {
        name: input.name,
        tradingName: input.tradingName,
        organizationType: input.organizationType,
        registrationNumber: input.registrationNumber,
        taxId: input.taxId,
        industry: input.industry,
        lastModifiedBy: actorId,
        // status defaults 'REGISTERED' at the DB (cm01) — not set here either
      });

      await insertAuditEvent(tx, {
        eventType: "ORGANIZATION_CREATED",
        actorUserId: actorId,
        targetEntity: "ORGANIZATION",
        targetId: org.organizationId,
        beforeData: null,
        afterData: org,
      });

      const role = await partyRoleRepository.insert(tx, {
        engagedParty: org.organizationId,
        partyRoleSpecification: specResult.value,
        lastModifiedBy: actorId,
      });

      await insertAuditEvent(tx, {
        eventType: "CUSTOMER_CREATED",
        actorUserId: actorId,
        targetEntity: "PARTY_ROLE",
        targetId: role.partyRoleId,
        beforeData: null,
        afterData: role,
      });

      return {
        ok: true,
        value: {
          organizationId: org.organizationId,
          partyRoleId: role.partyRoleId,
        },
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, "organization_registration_number_unique")) {
      return { ok: false, code: "DUPLICATE_REGISTRATION_NUMBER" };
    }
    throw err; // anything else is a genuine, unexpected failure — fail loud
  }
}
