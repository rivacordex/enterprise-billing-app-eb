import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type { PreferredContactMethod } from "@/types/customer";
import type { ContactFields } from "@/validation/customer/contact-medium.schema";
import type { AddContactInput } from "@/validation/customer/add-contact.schema";
import type { UpdateContactInput } from "@/validation/customer/update-contact.schema";
import type { DeleteContactInput } from "@/validation/customer/delete-contact.schema";
import type { SetPreferredContactInput } from "@/validation/customer/set-preferred-contact.schema";
import type { SetPreferredContactMethodInput } from "@/validation/customer/set-preferred-contact-method.schema";
import type { ContactMedium } from "@/db/schema/customer";

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

export type UpdateContactResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CONTACT_NOT_FOUND" }
  | { ok: false; code: "PREFERRED_METHOD_STILL_POPULATED" };

// Update's three-way preferred-method resolution (cm12-spec §2.1) — a
// genuinely different case set from `resolvePreferredMethod` above, which
// only ever runs against a brand-new contact with nothing to preserve.
export function resolveUpdatedPreferredMethod(
  current: PreferredContactMethod | null,
  updated: ContactFields,
): { ok: true; value: PreferredContactMethod | null } | { ok: false } {
  const populated = {
    PHONE: updated.phoneNumber !== null,
    EMAIL: updated.emailAddress !== null,
    ADDRESS: updated.addressLine1 !== null,
  } as const;

  if (current === null) {
    if (populated.PHONE) return { ok: true, value: "PHONE" };
    if (populated.EMAIL) return { ok: true, value: "EMAIL" };
    if (populated.ADDRESS) return { ok: true, value: "ADDRESS" };
    return { ok: true, value: null };
  }

  if (populated[current]) return { ok: true, value: current };

  const anyOtherPopulated = (
    Object.keys(populated) as PreferredContactMethod[]
  ).some((method) => method !== current && populated[method]);
  if (anyOtherPopulated) return { ok: false }; // Module Inv. #5 — blocked, not auto-reassigned

  return { ok: true, value: null }; // clearing down to zero populated methods
}

// A MANAGER edits an existing contact's fields (cm12-spec §3.3). The
// preferred-method pointer is preserved unless the edit clears that method's
// field while another remains populated, in which case the whole edit is
// rejected before the transaction opens — reassignment happens only through
// the explicit `set-preferred-contact-method` action (cm15), never as a side
// effect of a field edit.
export async function updateContact(
  input: UpdateContactInput,
  actorId: string,
): Promise<UpdateContactResult> {
  const before = await contactMediumRepository.findById(
    db,
    input.contactMediumId,
  );
  if (before === null || before.refPartyRole !== input.partyRoleId) {
    return { ok: false, code: "CONTACT_NOT_FOUND" };
  }

  const resolved = resolveUpdatedPreferredMethod(
    before.preferredContactMethod as PreferredContactMethod | null,
    input,
  );
  if (!resolved.ok) {
    return { ok: false, code: "PREFERRED_METHOD_STILL_POPULATED" };
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    const after = await contactMediumRepository.update(
      tx,
      input.contactMediumId,
      {
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
        preferredContactMethod: resolved.value,
        lastModifiedBy: actorId,
      },
    );

    await insertAuditEvent(tx, {
      eventType: "CONTACT_UPDATED",
      actorUserId: actorId,
      targetEntity: "CONTACT_MEDIUM",
      targetId: input.contactMediumId,
      beforeData: before,
      afterData: after,
    });

    return { ok: true, value: { lastModifiedDatetime: bumped } };
  });
}

export type DeleteContactResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CONTACT_NOT_FOUND" }
  | { ok: false; code: "CANNOT_DELETE_PREFERRED_CONTACT" };

// The module's one sanctioned physical delete (cm13-spec §2.1). Module
// Invariant #4 exists precisely to prevent a customer with contacts from
// ever dropping to "has contacts but no preferred one" — this is the only
// enforcement point, checking before any write whether the target contact is
// the one `party_role.contact_medium` currently points to. `deleteById`
// (`contactMediumRepository`) has no built-in guard of its own; this
// function is the only place in the codebase allowed to call it
// (code-standards §6.7, enforced by convention plus the structural test at
// `tests/structure/contact-medium-delete-callers.test.ts`).
export async function deleteContact(
  input: DeleteContactInput,
  actorId: string,
): Promise<DeleteContactResult> {
  const contact = await contactMediumRepository.findById(
    db,
    input.contactMediumId,
  );
  if (contact === null || contact.refPartyRole !== input.partyRoleId) {
    return { ok: false, code: "CONTACT_NOT_FOUND" };
  }

  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId);
  if (partyRole?.contactMedium === input.contactMediumId) {
    return { ok: false, code: "CANNOT_DELETE_PREFERRED_CONTACT" };
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    await contactMediumRepository.deleteById(tx, input.contactMediumId);

    await insertAuditEvent(tx, {
      eventType: "CONTACT_DELETED",
      actorUserId: actorId,
      targetEntity: "CONTACT_MEDIUM",
      targetId: input.contactMediumId,
      beforeData: contact,
      afterData: null,
    });

    return { ok: true, value: { lastModifiedDatetime: bumped } };
  });
}

export type SetPreferredContactResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "PARTY_ROLE_NOT_FOUND" }
  | { ok: false; code: "CONTACT_NOT_FOUND" };

// The explicit, user-initiated reassignment path (cm14-spec §2.1) — distinct
// from `addContact`'s auto-assign-on-first-contact side effect, this is the
// escape hatch that unblocks `deleteContact`'s "cannot delete the preferred
// contact" case: reassign preference away from a contact, then delete it.
// Reuses `partyRoleRepository.setPreferredContact` (cm11) unchanged; only the
// caller and audit framing differ.
export async function setPreferredContact(
  input: SetPreferredContactInput,
  actorId: string,
): Promise<SetPreferredContactResult> {
  const partyRole = await partyRoleRepository.findById(db, input.partyRoleId);
  if (partyRole === null) return { ok: false, code: "PARTY_ROLE_NOT_FOUND" };

  const target = await contactMediumRepository.findById(
    db,
    input.contactMediumId,
  );
  if (target === null || target.refPartyRole !== input.partyRoleId) {
    // Belongs to a different customer, or doesn't exist — checked here so a
    // cross-customer pointer gets a clean result instead of relying on the
    // composite deferrable FK (cm01) to reject it at commit time.
    return { ok: false, code: "CONTACT_NOT_FOUND" };
  }

  const previousContactId = partyRole.contactMedium;

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    await partyRoleRepository.setPreferredContact(
      tx,
      input.partyRoleId,
      input.contactMediumId,
    );

    await insertAuditEvent(tx, {
      eventType: "PREFERRED_CONTACT_CHANGED",
      actorUserId: actorId,
      targetEntity: "PARTY_ROLE",
      targetId: input.partyRoleId,
      beforeData: { preferredContactId: previousContactId },
      afterData: { preferredContactId: input.contactMediumId },
    });

    return { ok: true, value: { lastModifiedDatetime: bumped } };
  });
}

export type SetPreferredContactMethodResult =
  | { ok: true; value: { lastModifiedDatetime: Date } }
  | { ok: false; code: "CONFLICT" }
  | { ok: false; code: "CONTACT_NOT_FOUND" }
  | { ok: false; code: "METHOD_NOT_POPULATED" };

// A narrower, sibling concern to `resolveUpdatedPreferredMethod` (cm15-spec
// §2.1) — that function answers "what happens to the preferred method when a
// field edit touches it"; this one only answers "is the MANAGER's explicitly
// requested method currently populated on this contact at all."
function isMethodPopulated(
  contact: ContactMedium,
  method: PreferredContactMethod,
): boolean {
  if (method === "PHONE") return contact.phoneNumber !== null;
  if (method === "EMAIL") return contact.emailAddress !== null;
  return contact.gaAddressLine1 !== null; // ADDRESS
}

// The last of the module's nine mutation actions (cm15-spec §2.1) — a
// MANAGER explicitly repoints a contact's preferred method among its
// currently-populated methods only. No clearing verb: `targetMethod` is
// never `null`, and a preferred method only ever becomes `null` as a side
// effect of `updateContact`'s preserve-unless-blocked logic clearing the
// last populated field. Independent of that field-edit code path and of
// `addContact`'s creation-time auto-assignment — a third code path
// triggered only by this explicit user action.
export async function setPreferredContactMethod(
  input: SetPreferredContactMethodInput,
  actorId: string,
): Promise<SetPreferredContactMethodResult> {
  const contact = await contactMediumRepository.findById(
    db,
    input.contactMediumId,
  );
  if (contact === null || contact.refPartyRole !== input.partyRoleId) {
    return { ok: false, code: "CONTACT_NOT_FOUND" };
  }
  if (!isMethodPopulated(contact, input.targetMethod)) {
    return { ok: false, code: "METHOD_NOT_POPULATED" }; // Module Inv. #5 — must name a currently-populated method
  }

  return db.transaction(async (tx) => {
    const bumped = await partyRoleRepository.compareAndBumpLock(
      tx,
      input.partyRoleId,
      input.lastModifiedDatetime,
    );
    if (bumped === null) return { ok: false, code: "CONFLICT" };

    await contactMediumRepository.updatePreferredMethod(
      tx,
      input.contactMediumId,
      input.targetMethod,
      actorId,
    );

    await insertAuditEvent(tx, {
      eventType: "PREFERRED_METHOD_CHANGED",
      actorUserId: actorId,
      targetEntity: "CONTACT_MEDIUM",
      targetId: input.contactMediumId,
      beforeData: { preferredContactMethod: contact.preferredContactMethod },
      afterData: { preferredContactMethod: input.targetMethod },
    });

    return { ok: true, value: { lastModifiedDatetime: bumped } };
  });
}
