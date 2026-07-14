import { db } from "@/db/client";
import { findUserById } from "@/db/repositories/appuser.repository";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import type {
  ContactAddress,
  ContactRow,
  CustomerDetail,
  CustomerStatus,
  OrganizationStatus,
  OrganizationType,
  PreferredContactMethod,
} from "@/types/customer";

// `address` is `null` exactly when `ga_address_line1 IS NULL` — the
// "address populated" definition fixed in cm01-spec §2.1.10 (cm02-spec
// Design #2.2.9).
function buildAddress(contact: {
  gaAddressLine1: string | null;
  gaAddressLine2: string | null;
  gaCity: string | null;
  gaStateProvince: string | null;
  gaPostalCode: string | null;
  gaCountry: string | null;
}): ContactAddress | null {
  if (contact.gaAddressLine1 === null) return null;
  return {
    line1: contact.gaAddressLine1,
    line2: contact.gaAddressLine2,
    city: contact.gaCity,
    stateProvince: contact.gaStateProvince,
    postalCode: contact.gaPostalCode,
    country: contact.gaCountry,
  };
}

// Backs the three-section customer detail assembly (cm02-spec §3.11).
// Returns `null` for an unknown `partyRoleId` without querying anything
// further (Design #2.2.7), and fails closed (also `null`) in the
// FK-should-make-this-impossible case where the party role's organization
// row is missing, rather than assembling a partial detail.
// Imports the `db` singleton internally rather than taking it as a
// parameter (cm04 deviation from cm02's original signature — see
// custmgmt-progress-tracker.md's cm04 entry): matches `searchCustomers`'s
// same fix, for the same reason.
export async function getCustomerDetail(
  partyRoleId: string,
): Promise<CustomerDetail | null> {
  const partyRole = await partyRoleRepository.findById(db, partyRoleId);
  if (!partyRole) return null;

  const organization = await organizationRepository.findById(
    db,
    partyRole.engagedParty,
  );
  if (!organization) return null;

  const [contacts, organizationEditor, roleEditor] = await Promise.all([
    contactMediumRepository.findByPartyRoleId(db, partyRoleId),
    findUserById(db, organization.lastModifiedBy),
    findUserById(db, partyRole.lastModifiedBy),
  ]);

  // `appuser` FKs are ON DELETE RESTRICT (cm01-spec §2.1.9), so a
  // tombstoned/removed editor is not a real scenario here — no
  // "(deleted)" fallback needed (Design #2.2.8).
  const contactRows: ContactRow[] = contacts.map((contact) => ({
    contactMediumId: contact.contactMediumId,
    contactName: contact.contactName,
    contactRole: contact.contactRole,
    phoneNumber: contact.phoneNumber,
    emailAddress: contact.emailAddress,
    address: buildAddress(contact),
    preferredMethod:
      contact.preferredContactMethod as PreferredContactMethod | null,
    isPreferredContact: contact.contactMediumId === partyRole.contactMedium,
  }));

  return {
    organization: {
      organizationId: organization.organizationId,
      name: organization.name,
      tradingName: organization.tradingName,
      organizationType: organization.organizationType as OrganizationType,
      registrationNumber: organization.registrationNumber,
      taxId: organization.taxId,
      industry: organization.industry,
      status: organization.status as OrganizationStatus,
      statusReason: organization.statusReason,
      lastModifiedByName: organizationEditor!.userName,
      lastModifiedDatetime: organization.lastModifiedDatetime,
    },
    customerRole: {
      partyRoleId: partyRole.partyRoleId,
      status: partyRole.status as CustomerStatus,
      statusReason: partyRole.statusReason,
      specification: partyRole.partyRoleSpecification,
      account: partyRole.account,
      preferredContactId: partyRole.contactMedium,
      lastModifiedByName: roleEditor!.userName,
      lastModifiedDatetime: partyRole.lastModifiedDatetime,
    },
    contacts: contactRows,
  };
}
