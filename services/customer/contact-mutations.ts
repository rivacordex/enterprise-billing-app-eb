import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { PreferredContactMethod } from "@/types/customer";
import type { ContactFields } from "@/validation/customer/contact-medium.schema";
import type { AddContactInput } from "@/validation/customer/add-contact.schema";

export type AddContactResult =
  | { ok: true; value: { contactMediumId: string; lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" };

// Fixed priority PHONE > EMAIL > ADDRESS (cm11-spec §2.3) — a one-time
// decision at creation, resolved per-contact from that contact's own
// populated fields only (Module Inv. #5). `null` iff nothing is populated.
function resolvePreferredMethod(
  input: ContactFields,
): PreferredContactMethod | null {
  if (input.phoneNumber !== null) return "PHONE";
  if (input.emailAddress !== null) return "EMAIL";
  if (input.addressLine1 !== null) return "ADDRESS";
  return null;
}

// The one shared home for all contact-mutation logic (code-standards §7.3);
// cm12–cm15 each add one more exported function here.
//
// Transaction order is fixed (cm11-spec §2.4): (1) lock-check, (2) insert
// the contact row, (3) if first contact, point `party_role.contact_medium`
// at it — the composite deferrable FK (cm01) only needs to hold at COMMIT.
// Step 3 needs no second lock predicate (cm11-spec §2.5): once
// `compareAndBumpLock` succeeds, the `party_role` row is locked for the rest
// of this transaction, so a later, unconditional write to it is not a
// weaker guarantee than re-checking.
export async function addContact(
  input: AddContactInput,
  actorId: string,
): Promise<AddContactResult> {
  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId);
  if (partyRole === null) return { ok: false, code: "PARTY_ROLE_NOT_FOUND" };

  const existingContacts = await contactMediumRepository.findByPartyRoleId(
    db,
    input.partyRoleId,
  );
  const isFirstContact = existingContacts.length === 0;
  const preferredContactMethod = resolvePreferredMethod(input);

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    const contact = await contactMediumRepository.insert(tx, {
      refPartyRole: input.partyRoleId,
      contactName: input.contactName,
      contactRole: input.contactRole,
      phoneNumber: input.phoneNumber,
      emailAddress: input.emailAddress,
      gaAddressLine1: input.addressLine1,
      gaAddressLine2: input.addressLine2,
      gaCity: input.city,
      gaStateProvince: input.stateProvince,
      gaPostalCode: input.postalCode,
      gaCountry: input.country,
      preferredContactMethod,
      lastModifiedBy: actorId,
    });

    await insertAuditEvent(tx, {
      eventType: "CONTACT_CREATED",
      actorUserId: actorId,
      targetEntity: "CONTACT_MEDIUM",
      targetId: contact.contactMediumId,
      beforeData: null,
      afterData: contact,
    });

    if (isFirstContact) {
      await partyRoleRepository.setPreferredContact(
        tx,
        input.partyRoleId,
        contact.contactMediumId,
      );

      await insertAuditEvent(tx, {
        eventType: "PREFERRED_CONTACT_CHANGED",
        actorUserId: actorId,
        targetEntity: "PARTY_ROLE",
        targetId: input.partyRoleId,
        beforeData: { preferredContactId: null },
        afterData: { preferredContactId: contact.contactMediumId },
      });
    }

    return {
      ok: true,
      value: {
        contactMediumId: contact.contactMediumId,
        lastModifiedDatetime: bumped,
      },
    };
  });
}
